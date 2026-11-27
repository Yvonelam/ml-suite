#!/usr/bin/env node
/*
 * 把 PDF 的某几页渲成 PNG，肉眼查排版（图表有没有被切、表格有没有串行、提示条在不在）。
 * 输出 PDF 页数不够时直接报错，不会静默给你一张空图。
 *
 * 用法：node audit-pdf-pages.js probe-out/report.pdf 1 5 12
 *      产物：probe-out/<pdf名>-p<页码>.png
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const DBG = 9421;
const PDF = process.argv[2];
const PAGES = process.argv.slice(3).map(Number).filter(n => n > 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } });
const dev = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8')); } catch { return {}; } })();
function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
(async () => {
  if (!PDF || !PAGES.length) { console.error('用法：node audit-pdf-pages.js <pdf> <页码...>'); process.exit(1); }
  if (!fs.existsSync(PDF)) { console.error('找不到 ' + PDF); process.exit(1); }
  const b64 = fs.readFileSync(PDF).toString('base64');
  const base = path.basename(PDF).replace(/\.pdf$/i, '');
  const dir = require('./cdp-tmp').profileDir('ml-pdfpage-');
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--window-size=1300,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(m + ' timeout')); } }, 120000); }); };
  const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { t = await new Promise((res) => { http.get('http://127.0.0.1:' + DBG + '/json/list', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res((JSON.parse(d) || []).find(x => x.type === 'page')); } catch { res(null); } }); }).on('error', () => res(null)); }); if (t) break; } catch (e) { } await sleep(250); }
    if (!t) throw new Error('浏览器没起来');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    const ck = await login();
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
    const inj = await ev("(function(){return new Promise(function(res){if(window.pdfjsLib)return res('cached');var s=document.createElement('script');s.src='/vendor/pdf.min.js';s.onload=function(){pdfjsLib.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.min.js';res('ok')};s.onerror=function(){res('fail')};document.head.appendChild(s);setTimeout(function(){res('timeout')},8000);});})()");
    if (inj !== 'ok' && inj !== 'cached') throw new Error('pdf.js 加载失败：' + inj);
    const total = await ev("(async function(){var b64=" + JSON.stringify(b64) + ";var bin=atob(b64),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);window.__doc=await pdfjsLib.getDocument({data:u}).promise;return window.__doc.numPages;})()");
    console.log('PDF 共 ' + total + ' 页');
    for (const n of PAGES) {
      if (n > total) { console.log('  ⚠ 第 ' + n + ' 页不存在（只有 ' + total + ' 页）'); continue; }
      const ok = await ev("(async function(){var doc=window.__doc;var page=await doc.getPage(" + n + ");var vp=page.getViewport({scale:1.5});var old=document.getElementById('__pdfcanvas');if(old)old.remove();var c=document.createElement('canvas');c.id='__pdfcanvas';c.width=vp.width;c.height=vp.height;c.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;background:#fff';document.body.appendChild(c);await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return c.width+'x'+c.height;})()");
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1300, height: 900, scale: 1 } });
      const out = path.join(__dirname, 'probe-out', base + '-p' + n + '.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('  📷 ' + out + '（' + ok + '）');
    }
  } catch (e) {
    console.error('❌ ' + e.message); process.exitCode = 1;
  } finally { try { ws && ws.close(); } catch (e) { } try { child.kill(); } catch (e) { } }
})();
