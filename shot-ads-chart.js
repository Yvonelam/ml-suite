#!/usr/bin/env node
/* 只干一件事：把「广告分时」图表放大截清楚，并悬停某一小时让 tooltip 露出来（看广告单/自然单明细） */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const PORT = 9358, HOST = 'http://127.0.0.1:' + (process.env.PORT || 3000), W = 1440, H = 1000;
const API_PORT = Number(process.env.PORT || 3000);

function readDevLogin() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8')); } catch { return null; } }
async function resolveSession() {
  const dev = readDevLogin() || {};
  const user = process.env.ML_ADMIN_USER || dev.username, pass = process.env.ML_ADMIN_PASSWORD || dev.password;
  if (user && pass) {
    const data = Buffer.from(JSON.stringify({ username: user, password: pass }));
    const r = await new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: API_PORT, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res({ status: s.statusCode, headers: s.headers, body: d })); }); q.on('error', rej); q.write(data); q.end(); });
    const sc = [].concat(r.headers['set-cookie'] || []).find(v => v.startsWith('ml_session='));
    if (!sc) throw new Error('登录失败：' + r.body);
    return decodeURIComponent(sc.split(';')[0].slice('ml_session='.length));
  }
  const users = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'users.json'), 'utf8'));
  const u = users.find(x => x.role === 'admin' && x.status === 'approved');
  const payload = Buffer.from(JSON.stringify({ id: u.id, exp: Date.now() + 2592000000, v: Number(u.sessionVersion || 0) })).toString('base64url');
  const sig = crypto.createHmac('sha256', fs.readFileSync(path.join(__dirname, 'auth-data', 'session-secret'))).update(payload).digest('base64url');
  return payload + '.' + sig;
}
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-shot-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=' + W + ',' + H, '--user-data-dir=' + userDir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, msgId = 0; const pending = new Map();
  const send = (m, p = {}) => { const id = ++msgId; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(m + ' timeout')); } }, 30000); }); };
  const evaluate = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  try {
    let target = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); target = l.find(t => t.type === 'page'); if (target) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const cookie = await resolveSession();
    await send('Network.setCookie', { name: 'ml_session', value: cookie, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#ads' });
    for (let i = 0; i < 40; i++) { await sleep(300); const t = await evaluate('document.title||""'); if (t) break; }
    for (let i = 0; i < 40; i++) { const g = await evaluate("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(300); }
    await sleep(3200);

    // 切「近 7 天」——广告单量非 0，双色才看得出来
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsRange button')).filter(function(x){return x.dataset.r==='7'})[0];if(b)b.click();})()");
    await sleep(16000);
    // 确保是柱状图 + 出单数量口径
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsHourView button')).filter(function(x){return x.dataset.v==='hour'})[0];if(b)b.click();var c=[].slice.call(document.querySelectorAll('#adsHourMetric button')).filter(function(x){return x.dataset.m==='orders'})[0];if(c)c.click();})()");
    await sleep(1200);
    await evaluate("(function(){var e=document.getElementById('adsHourBody');if(e&&e.scrollIntoView)e.scrollIntoView({block:'center'});})()");
    await sleep(800);

    // 找一根「广告单占比高」的柱子悬停，让 tooltip 有看头
    const pick = await evaluate(`(function(){
      var svg=document.querySelector('#adsHourBody svg'); if(!svg) return null;
      var r=svg.getBoundingClientRect();
      var vb=svg.getAttribute('viewBox').split(' ').map(Number), W=vb[2], H=vb[3], L=58, R=60, T=18, B=42;
      var pw=W-L-R, bw=pw/24, ph=H-T-B;
      var hb=svg.querySelectorAll('rect.hb'), best=null;
      hb.forEach(function(x){var v=Number(x.getAttribute('height'))||0; if(!best||v>best.v) best={v:v,i:Number(x.getAttribute('data-i'))};});
      if(!best) return null;
      var cx1000=L+best.i*bw+bw/2;
      return JSON.stringify({i:best.i, x:r.left+(cx1000/W)*r.width, y:r.top+((T+ph*0.62)/H)*r.height});
    })()`);
    if (pick) {
      const p = JSON.parse(pick);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p.x), y: Math.round(p.y), buttons: 0 });
      await sleep(600);
      console.log('悬停小时:', p.i + ':00');
    }

    const clip = JSON.parse(await evaluate(`(function(){
      var el=document.getElementById('adsHourBody'); var r=el.getBoundingClientRect();
      var pad=10;
      return JSON.stringify({x:Math.max(0,r.left+window.scrollX-pad), y:Math.max(0,r.top+window.scrollY-120), width:r.width+pad*2, height:r.height+120+pad});
    })()`));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2.2 } });
    const out = path.join(__dirname, 'shots', 'ads-chart-zoom.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('截图:', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
    child.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e.message); try { child.kill(); } catch (x) { } process.exit(1); }
})();
