const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const DBG = 9401, HOST = 'http://127.0.0.1:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dev = JSON.parse(fs.readFileSync('auth-data/dev-login.json', 'utf8'));

function login() {
  return new Promise((res, rej) => {
    const b = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
    const r = http.request({ host: '127.0.0.1', port: 3000, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': b.length } }, s => {
      let d = ''; s.on('data', c => d += c);
      s.on('end', () => {
        const ck = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session='));
        res(decodeURIComponent(ck.split(';')[0].slice(11)));
      });
    });
    r.on('error', rej); r.write(b); r.end();
  });
}
const getJson = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  const dir = require('./cdp-tmp').profileDir('ml-pg-');
  const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--disable-gpu', '--no-proxy-server', '--window-size=1400,1000', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(m + ' timeout')); } }, 120000); }); };
  const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  try {
    let t = null;
    for (let i = 0; i < 60; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Network.setCookie', { name: 'ml_session', value: await login(), url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    const b64 = fs.readFileSync('probe-out/profit-report.pdf').toString('base64');
    await ev("(function(){return new Promise(function(res){var s=document.createElement('script');s.src='/vendor/pdf.min.js';s.onload=function(){pdfjsLib.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.min.js';res(1)};document.head.appendChild(s);});})()");
    const r = await ev("(async function(){try{var b64=" + JSON.stringify(b64) + ";var bin=atob(b64),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);var doc=await pdfjsLib.getDocument({data:u}).promise;var page=await doc.getPage(4);var vp=page.getViewport({scale:1.35});var c=document.createElement('canvas');c.width=vp.width;c.height=vp.height;c.style.cssText='position:fixed;left:0;top:0;z-index:99999;background:#fff';document.body.appendChild(c);await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return {pages:doc.numPages};}catch(e){return {err:String(e&&e.message||e)}}})()");
    console.log('渲染', JSON.stringify(r));
    const sh = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('probe-out/pdf-page4.png', Buffer.from(sh.data, 'base64'));
    console.log('saved probe-out/pdf-page4.png');
  } catch (e) { console.log('err', e.message); }
  finally { try { ws && ws.close(); } catch (e) { } try { child.kill(); } catch (e) { } process.exit(0); }
})();
