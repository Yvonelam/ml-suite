'use strict';
/* 无头浏览器 E2E + 截图：问答（示例模式）与售后（真实数据）的站内回复流程 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const BASE = 'http://127.0.0.1:3000/';
const OUT = path.join(__dirname, 'shots');
const W = 1440;
fs.mkdirSync(OUT, { recursive: true });
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-ml-'));

const get = (url) => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try { const v = await get('http://127.0.0.1:' + PORT + '/json/version'); if (v) return JSON.parse(v); } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 未就绪');
}

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
  '--window-size=' + W + ',1600', '--user-data-dir=' + userDir, 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
}
async function waitFor(expr, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true; } catch {}
    await sleep(200);
  }
  return false;
}

async function shot(name) {
  const rect = await evaluate(`(()=>{const v=document.querySelector('.view.on');if(!v)return 'null';const b=v.getBoundingClientRect();const doc=document.documentElement;return JSON.stringify({top:b.top+window.scrollY,bottom:b.bottom+window.scrollY,docH:doc.scrollHeight});})()`);
  const r = JSON.parse(rect);
  const height = Math.max(600, Math.min(r.bottom + 40, Math.max(r.docH, r.bottom + 40)));
  const res = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: W, height: Math.ceil(height), scale: 1.5 },
  });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  console.log('  [shot] ' + file + '  (' + W + 'x' + Math.ceil(height) + ')');
  return file;
}

function onEvent(msg) {
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push('[console.error] ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push('[log] ' + msg.params.entry.text);
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
  }
}

(async () => {
  try {
    const ver = await waitChrome();
    let t = null;
    for (let i = 0; i < 20 && !t; i++) {
      const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
      t = list.find(x => x.type === 'page') || null;
      if (!t) await sleep(250);
    }
    if (!t) throw new Error('找不到页面目标');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => onEvent(JSON.parse(e.data));
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

    console.log('== 打开首页 ==');
    await send('Page.navigate', { url: BASE });
    await sleep(1800);
    await evaluate(`(()=>{const s=document.querySelector('#skip');if(s)s.click();return 1})()`);
    await sleep(600);

    console.log('== 商品问答 · 进入示例模式 ==');
    await evaluate(`(()=>{document.querySelector('nav a[data-go="questions"]').click();return 1})()`);
    await sleep(1000);
    const demoReady = await waitFor(`!!document.querySelector('#qDemo') || !!document.querySelector('.qcard')`, 12000);
    if (demoReady && await evaluate(`!!document.querySelector('#qDemo')`)) {
      await evaluate(`document.querySelector('#qDemo').click()`);
      await sleep(1200);
    }
    await waitFor(`!!document.querySelector('.qcard')`, 8000);
    await shot('01-问答-示例列表');

    console.log('== 商品问答 · 填写回复 ==');
    await evaluate(`(()=>{const ta=document.querySelector('.qcard textarea[data-ta]');if(!ta)return 0;ta.value='Boa tarde! Sim, este modelo possui conexão P2 3,5mm e também USB, compatível com PS4. Qualquer dúvida estou à disposição!';ta.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
    await sleep(400);
    await shot('02-问答-填写回复');

    console.log('== 商品问答 · 发送（示例模式不真发） ==');
    await evaluate(`(()=>{const b=document.querySelector('.qcard button[data-send]');if(b)b.click();return 1})()`);
    await sleep(700);
    await shot('03-问答-发送结果');

    console.log('== 退货与投诉 · 待我处理（分类入口） ==');
    await evaluate(`(()=>{document.querySelector('nav a[data-go="claims"]').click();return 1})()`);
    await sleep(1800);
    await waitFor(`!!document.querySelector('.ccard')`, 15000);
    await shot('04-售后-待我处理');

    console.log('== 退货与投诉 · 平台调解（展开回复调解员） ==');
    await evaluate(`(()=>{const b=document.querySelector('#claimTabs button[data-k="mediation"]');if(b)b.click();return 1})()`);
    await sleep(1300);
    await waitFor(`!!document.querySelector('.ccard button[data-talk]')`, 8000);
    await evaluate(`(()=>{const b=document.querySelector('.ccard button[data-talk]');if(b)b.click();return 1})()`);
    await sleep(1500);
    await waitFor(`!!document.querySelector('.cthread')`, 8000);
    await shot('05-售后-平台调解对话');

    console.log('== 退货与投诉 · 填写回复调解员 ==');
    await evaluate(`(()=>{const ta=document.querySelector('.cpanel textarea[data-cta]');if(!ta)return 0;ta.value='Aceito o reembolso parcial de 30% sem devolução do produto. Podem prosseguir, por favor.';ta.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
    await sleep(400);
    await shot('06-售后-填写回复调解员');

    console.log('== 退货与投诉 · 无需操作（买家自行退货） ==');
    await evaluate(`(()=>{const b=document.querySelector('#claimTabs button[data-k="auto"]');if(b)b.click();return 1})()`);
    await sleep(1200);
    await waitFor(`!!document.querySelector('.ccard')`, 8000);
    await shot('07-售后-无需操作');

    console.log('== 退货与投诉 · 忽略一条调解（验证角标实时刷新） ==');
    await evaluate(`(()=>{const b=document.querySelector('#claimTabs button[data-k="todo"]');if(b)b.click();return 1})()`);
    await sleep(1000);
    const got08 = await waitFor(`!!document.querySelector('.ccard button[data-ignore]')`, 25000);
    console.log('  [debug] todo 卡片按钮出现=' + got08 + ' cards=' + await evaluate(`document.querySelectorAll('.ccard').length`) + ' bodyLen=' + await evaluate(`(document.querySelector('#claimBody')||{innerHTML:''}).innerHTML.length`));
    await shot('08-售后-忽略前');
    const badgeBefore = await evaluate(`(document.querySelector('#nb-c')||{}).textContent||''`);
    await evaluate(`(()=>{const b=document.querySelector('.ccard button[data-ignore]');if(b)b.click();return 1})()`);
    // 轮询等角标变化（summary 接口需要几秒）
    let badgeAfter = badgeBefore;
    for (let i = 0; i < 30; i++) {
      await sleep(600);
      badgeAfter = await evaluate(`(document.querySelector('#nb-c')||{}).textContent||''`);
      if (badgeAfter !== badgeBefore) break;
    }
    console.log('  [badge] 忽略前 nb-c=' + badgeBefore + ' → 忽略后 nb-c=' + badgeAfter + (badgeBefore !== badgeAfter ? '  ✅ 已实时刷新' : '  ⚠️ 未变化'));
    await shot('09-售后-忽略后待我处理');
    await evaluate(`(()=>{const b=document.querySelector('#claimTabs button[data-k="ignored"]');if(b)b.click();return 1})()`);
    await sleep(1300);
    await waitFor(`!!document.querySelector('.ccard button[data-unignore]')`, 15000);
    await shot('10-售后-已忽略');

    console.log('== 恢复被忽略的纠纷（并轮询角标还原） ==');
    await evaluate(`(()=>{const b=document.querySelector('.ccard button[data-unignore]');if(b)b.click();return 1})()`);
    for (let i = 0; i < 30; i++) {
      await sleep(600);
      badgeAfter = await evaluate(`(document.querySelector('#nb-c')||{}).textContent||''`);
      if (badgeAfter === badgeBefore) break;
    }
    console.log('  [badge] 恢复后 nb-c=' + badgeAfter + (badgeAfter === badgeBefore ? '  ✅ 已还原' : '  ⚠️ 未还原'));

    console.log('== 订单管理 · 待我发货（官方代发不提示） ==');
    await evaluate(`(()=>{document.querySelector('nav a[data-go="orders"]').click();return 1})()`);
    await sleep(1500);
    await waitFor(`!!document.querySelector('#orderBody .empty') || !!document.querySelector('.otable')`, 30000);
    await shot('13-订单-待我发货');
    await evaluate(`(()=>{const b=document.querySelector('#orderTabs button[data-k="all"]');if(b)b.click();return 1})()`);
    await sleep(2500);
    await waitFor(`!!document.querySelector('.otable')`, 20000);
    await shot('14-订单-全部带发货方式');

    console.log('== 售后 · 示例预览（含买家咨询） ==');
    await evaluate(`(()=>{const b=document.querySelector('#claimDemoBtn');if(b)b.click();return 1})()`);
    await sleep(1400);
    await waitFor(`!!document.querySelector('.ccard')`, 8000);
    await shot('11-售后-待我处理示例');
    await evaluate(`(()=>{const b=document.querySelector('#claimTabs button[data-k="buyer"]');if(b)b.click();return 1})()`);
    await sleep(900);
    await shot('12-售后-买家咨询示例');

    console.log('\n===== 控制台错误 =====');
    if (!consoleErrors.length) console.log('  0 错误 ✅');
    else consoleErrors.forEach(e => console.log('  ' + e));

    ws.close();
  } catch (e) {
    console.error('E2E 失败:', e.message);
    if (consoleErrors.length) consoleErrors.forEach(x => console.log('  ' + x));
  } finally {
    try { chrome.kill(); } catch {}
    setTimeout(() => process.exit(0), 300);
  }
})();
