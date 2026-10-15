'use strict';
/* E2E + 截图：广告投放页「广告分时」图表（按小时柱线图 / 每天×小时热力图） */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const BASE = 'http://127.0.0.1:3000/';
const OUT = path.join(__dirname, 'shots');
const W = 1440;
fs.mkdirSync(OUT, { recursive: true });
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-adsh-'));

const get = (url) => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
  '--window-size=' + W + ',1600', '--user-data-dir=' + userDir, 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const consoleErrors = [];
function send(method, params = {}) { const id = ++msgId; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); }
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
}
async function waitFor(expr, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await evaluate(expr)) return true; } catch {} await sleep(300); }
  return false;
}
async function shot(name, sel) {
  const rect = await evaluate(`(()=>{const v=${sel ? `document.querySelector('${sel}')` : `document.querySelector('.view.on')`};if(!v)return 'null';const b=v.getBoundingClientRect();return JSON.stringify({top:b.top+window.scrollY,bottom:b.bottom+window.scrollY,h:b.height});})()`);
  if (rect === 'null') { console.log('  [shot] 跳过 ' + name); return; }
  const r = JSON.parse(rect);
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height: Math.ceil(r.bottom + 30), scale: 1.5 } });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('  [shot] ' + name + '  h=' + Math.ceil(r.h));
}
function onEvent(msg) {
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push('[console.error] ' + msg.params.args.map(a => a.value || a.description || '').join(' '));
  else if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') consoleErrors.push('[log] ' + msg.params.entry.text);
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); }
}

(async () => {
  try {
    for (let i = 0; i < 60; i++) { try { if (await get('http://127.0.0.1:' + PORT + '/json/version')) break; } catch {} await sleep(250); }
    let t = null;
    for (let i = 0; i < 20 && !t; i++) { const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list')); t = list.find(x => x.type === 'page') || null; if (!t) await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => onEvent(JSON.parse(e.data));
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

    console.log('== 打开首页 → 广告投放 ==');
    await send('Page.navigate', { url: BASE });
    await sleep(2200);
    await evaluate(`(()=>{const s=document.querySelector('#skip');if(s)s.click();return 1})()`);
    await sleep(600);
    await evaluate(`(()=>{document.querySelector('nav a[data-go="ads"]').click();return 1})()`);
    await sleep(1500);

    // 等分时图渲染（24 根柱子）
    const ok = await waitFor(`document.querySelectorAll('#adsHourBody .hb').length===24`, 45000);
    const bars = await evaluate(`document.querySelectorAll('#adsHourBody .hb').length`);
    const kpi = await evaluate(`(document.querySelector('#adsHourKpis')||{}).textContent||''`);
    console.log('  柱子数=' + bars + ' 等待成功=' + ok);
    console.log('  KPI文本=' + kpi.replace(/\s+/g, ' ').trim().slice(0, 160));

    // 校验：默认范围=今天；分时卡在总览卡上方
    const layout = await evaluate(`(()=>{
      const on=document.querySelector('#adsRange button[data-r="today"]');
      const cards=[...document.querySelectorAll('#v-ads > .card')];
      const titles=cards.map(c=>((c.querySelector('.ob-title h3')||{}).textContent||'[日期范围]').trim());
      const fr=document.querySelector('#adsFrom').value, to=document.querySelector('#adsTo').value;
      return JSON.stringify({todayOn:!!(on&&on.classList.contains('on')), cardOrder:titles, from:fr, to:to});
    })()`);
    console.log('  布局校验=' + layout);

    console.log('== 切到「近 7 天」让热力图有 7 行 ==');
    await evaluate(`(()=>{const b=document.querySelector('#adsRange button[data-r="7"]');if(b)b.click();return 1})()`);
    await waitFor(`document.querySelectorAll('#adsHourBody .hb').length===24`, 45000);
    await sleep(1200);
    await shot('ads-hour-01b-按小时-近7天');
    await shot('ads-hour-01-按小时');

    console.log('== 切到「每天 × 小时」热力图 ==');
    await evaluate(`(()=>{const b=document.querySelector('#adsHourView button[data-v="heat"]');if(b)b.click();return 1})()`);
    await sleep(900);
    const cells = await evaluate(`document.querySelectorAll('#adsHourBody .heat td.c').length`);
    const rowN = await evaluate(`document.querySelectorAll('#adsHourBody .heat tbody tr').length`);
    const hdr = await evaluate(`(document.querySelector('#adsHourBody .heat thead')||{}).textContent||''`);
    const srcCol = await evaluate(`(()=>{const tds=document.querySelectorAll('#adsHourBody .heat tbody tr td');return tds.length? tds[tds.length-1].textContent : ''})()`);
    const note = await evaluate(`(document.querySelector('#adsHourNote')||{}).textContent||''`);
    console.log('  热力图 行数=' + rowN + ' 单元格=' + cells);
    console.log('  表头=' + hdr.replace(/\s+/g, ' ').trim());
    console.log('  末列(来源)=' + srcCol + '  说明=' + note.replace(/\s+/g, ' ').trim());
    await shot('ads-hour-02-热力图');

    console.log('== 指标切「花费（估算）」==');
    await evaluate(`(()=>{const b=document.querySelector('#adsHourMetric button[data-m="cost"]');if(b)b.click();return 1})()`);
    await sleep(800);
    await shot('ads-hour-03-热力图-花费');

    console.log('== 回到「按小时」看花费 ==');
    await evaluate(`(()=>{const b=document.querySelector('#adsHourView button[data-v="hour"]');if(b)b.click();return 1})()`);
    await sleep(800);
    await shot('ads-hour-04-按小时-花费');

    console.log('\n===== 控制台错误 =====');
    if (!consoleErrors.length) console.log('  0 错误 ✅'); else consoleErrors.forEach(e => console.log('  ' + e));
    ws.close();
  } catch (e) { console.error('E2E 失败:', e.message); if (consoleErrors.length) consoleErrors.forEach(x => console.log('  ' + x)); }
  finally { try { chrome.kill(); } catch {} setTimeout(() => process.exit(0), 300); }
})();
