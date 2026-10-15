'use strict';
/* 回归测试：忽略一条纠纷 → 刷新整页 → 刷新后仍在「已忽略」栏、待我处理角标保持正确 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const BASE = 'http://127.0.0.1:3000/';
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-ign-'));
const OUT = path.join(__dirname, 'shots');
const W = 1440;
fs.mkdirSync(OUT, { recursive: true });

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
  '--window-size=1440,1600', '--user-data-dir=' + userDir, 'about:blank',
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

// 读取当前售后 counts（从页面 tabs 上的 badge 文本）
async function readCounts() {
  return evaluate(`(()=>{
    const el=document.querySelector('#claimTabs'); if(!el) return null;
    const o={};
    el.querySelectorAll('button[data-k]').forEach(b=>{const i=b.querySelector('.cnt');o[b.dataset.k]= (i&&!i.hidden)? i.textContent : '0';});
    return o;
  })()`);
}
async function readCards() {
  return evaluate(`(()=>Array.from(document.querySelectorAll('.ccard')).map(c=>{
    const m=(c.querySelector('.qhead span:nth-child(2)')||{}).textContent||'';
    const idm=m.match(/#(\\d+)/); return idm?idm[1]:'';
  }).filter(Boolean))()`);
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
  console.log('  [shot] ' + file);
  return file;
}
async function gotoClaims() {
  await evaluate(`(()=>{document.querySelector('nav a[data-go="claims"]').click();return 1})()`);
  await sleep(1200);
  await waitFor(`!!document.querySelector('#claimTabs') && !!document.querySelector('#claimBody')`, 15000);
}
async function clickTab(k) {
  await evaluate(`(()=>{const b=document.querySelector('#claimTabs button[data-k="${k}"]');if(b)b.click();return 1})()`);
  await sleep(1400);
  await waitFor(`!!document.querySelector('.ccard') || !!document.querySelector('.empty')`, 15000);
}

(async () => {
  try {
    await waitChrome();
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

    console.log('== 第 1 次加载页面 ==');
    await send('Page.navigate', { url: BASE });
    await sleep(2000);
    await evaluate(`(()=>{const s=document.querySelector('#skip');if(s)s.click();return 1})()`);
    await sleep(600);
    await gotoClaims();
    await clickTab('todo');
    const counts1 = await readCounts();
    const badge1 = await evaluate(`(document.querySelector('#nb-c')||{}).textContent||''`);
    console.log('  待我处理 counts.todo =', counts1.todo, ' 角标 nb-c =', badge1);

    const todo1 = await readCards();
    console.log('  待我处理卡片:', JSON.stringify(todo1));
    await shot('ig-01-待我处理-忽略前');
    if (!todo1.length) throw new Error('待我处理栏为空，无法测试（请确认有待处理纠纷）');
    const targetId = todo1[0];
    console.log('  将忽略纠纷 #' + targetId);

    // ---- 点击忽略 ----
    console.log('== 点击「忽略」 ==');
    await evaluate(`(()=>{const b=document.querySelector('.ccard button[data-ignore]');if(b)b.click();return 1})()`);
    await waitFor(`(()=>{const b=document.querySelector('#claimTabs button[data-k="todo"] .cnt');return !b || b.hidden || b.textContent==='0';})()`, 25000);
    await sleep(1200);
    const counts2 = await readCounts();
    const badge2 = await evaluate(`(document.querySelector('#nb-c')||{}).textContent||''`);
    console.log('  忽略后 待我处理 counts.todo =', counts2.todo, ' 已忽略 counts.ignored =', counts2.ignored, ' 角标 nb-c =', badge2);
    await clickTab('todo');
    await shot('ig-02-待我处理-忽略后(空)');

    // ---- 关键：刷新整页 ----
    console.log('== 🔄 刷新整个页面（模拟 F5） ==');
    await send('Page.navigate', { url: BASE });
    await sleep(2200);
    await evaluate(`(()=>{const s=document.querySelector('#skip');if(s)s.click();return 1})()`);
    await sleep(600);
    await gotoClaims();
    await clickTab('todo');
    const counts3 = await readCounts();
    const badge3 = await evaluate(`(document.querySelector('#nb-c')||{}).textContent||''`);
    const todo3 = await readCards();
    console.log('  刷新后 待我处理 counts.todo =', counts3.todo, ' 已忽略 counts.ignored =', counts3.ignored, ' 角标 nb-c =', badge3);
    console.log('  刷新后 待我处理卡片:', JSON.stringify(todo3));

    // 切到已忽略栏，确认目标纠纷在列
    await clickTab('ignored');
    const ignoredIds = await readCards();
    console.log('  刷新后 已忽略栏卡片:', JSON.stringify(ignoredIds));
    await shot('ig-03-已忽略-刷新后仍在');

    const stillInTodo = todo3.includes(targetId);
    const inIgnored = ignoredIds.includes(targetId);
    console.log('');
    if (!stillInTodo && inIgnored) {
      console.log('✅✅✅ 通过：刷新后 #' + targetId + ' 仍在「已忽略」栏，未回到「待我处理」');
    } else {
      console.log('❌ 未通过：#' + targetId + ' stillInTodo=' + stillInTodo + ' inIgnored=' + inIgnored);
    }

    // ---- 还原（取消忽略），避免污染用户状态 ----
    console.log('== 还原：取消忽略 #' + targetId + ' ==');
    await evaluate(`(()=>{const b=document.querySelector('.ccard button[data-unignore]');if(b)b.click();return 1})()`);
    await sleep(2000);
    await clickTab('todo');
    const counts4 = await readCounts();
    console.log('  还原后 counts.todo =', counts4.todo, ' counts.ignored =', counts4.ignored);

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
