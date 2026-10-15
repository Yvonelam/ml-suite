'use strict';
/* 截图：售后 · 待我处理 / 已忽略（展示忽略记录持久化后的稳定状态） */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const BASE = 'http://127.0.0.1:3000/';
const OUT = path.join(__dirname, 'shots');
const W = 1440;
fs.mkdirSync(OUT, { recursive: true });
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-shot-'));

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
async function waitFor(expr, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await evaluate(expr)) return true; } catch {} await sleep(200); }
  return false;
}
async function shot(name) {
  const rect = await evaluate(`(()=>{const v=document.querySelector('.view.on');if(!v)return 'null';const b=v.getBoundingClientRect();const doc=document.documentElement;return JSON.stringify({bottom:b.bottom+window.scrollY,docH:doc.scrollHeight});})()`);
  const r = JSON.parse(rect);
  const height = Math.max(600, Math.min(r.bottom + 40, Math.max(r.docH, r.bottom + 40)));
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height: Math.ceil(height), scale: 1.5 } });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('  [shot] ' + name);
}
function onEvent(msg) {
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
    await send('Page.enable'); await send('Runtime.enable');

    await send('Page.navigate', { url: BASE });
    await sleep(2200);
    await evaluate(`(()=>{const s=document.querySelector('#skip');if(s)s.click();return 1})()`);
    await sleep(600);
    await evaluate(`(()=>{document.querySelector('nav a[data-go="claims"]').click();return 1})()`);
    await sleep(1500);
    await waitFor(`!!document.querySelector('#claimTabs')`, 15000);
    await sleep(6000); // 等概览角标(summary)加载完成
    await shot('final-01-售后-待我处理');
    await evaluate(`(()=>{const b=document.querySelector('#claimTabs button[data-k="ignored"]');if(b)b.click();return 1})()`);
    await sleep(1600);
    await waitFor(`!!document.querySelector('.ccard')`, 15000);
    await shot('final-02-售后-已忽略(持久化保留)');
    ws.close();
  } catch (e) { console.error('失败:', e.message); }
  finally { try { chrome.kill(); } catch {} setTimeout(() => process.exit(0), 300); }
})();
