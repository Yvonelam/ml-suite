#!/usr/bin/env node
/**
 * 截一张「箱唛裁切识别结果」的图，用于人工确认最后几页有没有被切碎。
 * 用法：node probe-boxmark-shot.js [pdf路径]
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9392;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));
const PDF = process.argv[2] || 'E:/Works-WZ/Seller/BR/发货/2026.11.4 美客多上门取件 210南美森/外箱标 Envio-80335786-Etiquetas-do-volumes.pdf';
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : ''].filter(p => { try { return p && fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}

(async () => {
  const b64 = fs.readFileSync(PDF).toString('base64');
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-boxshot-'));
  const outDir = path.join(__dirname, 'probe-out'); try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { }
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1440,980', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 2, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    for (let i = 0; i < 60; i++) { if (await ev('typeof analyzePdf === "function"')) break; await sleep(200); }
    await ev("go('box'); true");
    await sleep(600);
    const info = await ev(`(async () => {
      const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      boxState.srcBytes = u8.buffer; boxState.fileName = 'shot.pdf';
      boxState.mode = 'auto'; boxState.gapAuto = true; boxState.params.gapMm = 3;
      await analyzePdf();
      const cards = document.querySelectorAll('#boxResults .page-card');
      const last = cards[cards.length - 1];
      if (last) last.scrollIntoView({ block: 'end' });
      return { pages: boxState.pages.length, counts: boxState.pages.map(p => p.boxes.length) };
    })()`);
    await sleep(900);
    const shot = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      sleep(20000).then(() => { throw new Error('截图超时'); })
    ]);
    const f = path.join(outDir, 'boxmark-fixed.png');
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log('页数 ' + info.pages + ' / 每页箱唛数 ' + info.counts.join(','));
    console.log('已存 ' + f);
  } finally { try { ws && ws.close(); } catch (e) { } try { child.kill(); } catch (e) { } }
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
