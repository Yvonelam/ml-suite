'use strict';
/* 用无头 Chrome 把 favicon.svg 栅格化成各尺寸 PNG（矢量重渲染，边缘清晰） */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9344;
const PUB = path.join(__dirname, 'public');
const SVG = fs.readFileSync(path.join(PUB, 'favicon.svg'), 'utf8');
const SIZES = [{ s: 16, f: 'favicon-16.png' }, { s: 32, f: 'favicon-32.png' }, { s: 180, f: 'apple-touch-icon.png' }];

// 临时渲染页：把 SVG 内联铺满 64x64 视口
const wrapper = '<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:64px;height:64px;overflow:hidden}</style></head><body>'
  + SVG.replace('width="64" height="64"', 'width="64" height="64" style="display:block"') + '</body></html>';
const tmpHtml = path.join(os.tmpdir(), 'ml-icon-render.html');
fs.writeFileSync(tmpHtml, wrapper, 'utf8');

const get = (url) => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--disable-gpu',
  '--no-proxy-server',
  '--window-size=64,64', '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-ico-')), 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', d => { const s = d.toString(); if (/error|fail/i.test(s)) console.log('[chrome] ' + s.trim().slice(0, 200)); });
chrome.on('exit', c => { if (c) console.log('[chrome] 已退出 code=' + c); });

let ws, id = 0; const pend = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => pend.set(i, { res, rej })); };

(async () => {
  for (let i = 0; i < 80; i++) { try { await get('http://127.0.0.1:' + PORT + '/json/version'); break; } catch { await sleep(250); } }
  let t = null;
  for (let i = 0; i < 40 && !t; i++) {
    let list = [];
    try { list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list')); } catch {}
    t = list.find(x => x.type === 'page') || null;
    if (!t) { if (i === 5) console.log('[debug] targets=' + JSON.stringify(list.map(x => x.type))); await sleep(300); }
  }
  if (!t) throw new Error('找不到页面目标');
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await send('Page.enable');
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: 'file:///' + tmpHtml.replace(/\\/g, '/') });
  await sleep(1200);

  for (const { s, f } of SIZES) {
    const r = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 64, height: 64, scale: s / 64 },
    });
    fs.writeFileSync(path.join(PUB, f), Buffer.from(r.data, 'base64'));
    console.log('[icon] ' + f + '  ' + s + 'x' + s);
  }
  ws.close();
  console.log('done');
})().catch(e => { console.error('FAIL', e.message); }).finally(() => { try { chrome.kill(); } catch {} fs.unlinkSync(tmpHtml); setTimeout(() => process.exit(0), 300); });
