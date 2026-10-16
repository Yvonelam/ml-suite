#!/usr/bin/env node
/* 诊断：分时图在 orders / cost 两种口径下的图例、柱子数、以及 hourly 的真实数据 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PORT = 9360, HOST = 'http://127.0.0.1:' + (process.env.PORT || 3000);
const API_PORT = Number(process.env.PORT || 3000);

function readDevLogin() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8')); } catch { return null; } }
async function login() {
  const dev = readDevLogin() || {};
  const data = Buffer.from(JSON.stringify({ username: process.env.ML_ADMIN_USER || dev.username, password: process.env.ML_ADMIN_PASSWORD || dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API_PORT, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(data); r.end();
  });
}
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

const PROBE = `(function(){
  var D = (typeof adsHour!=='undefined') ? adsHour : null;
  var leg=document.querySelector('#adsHourBody .leg-h');
  var note=document.querySelector('#adsHourBody .leg-note');
  return JSON.stringify({
    metric: D ? D.metric : '(取不到)',
    view: D ? D.view : '',
    days: D && D.data ? D.data.days : null,
    adsAvailable: D && D.data ? D.data.adsAvailable : null,
    hourlyOrders: D && D.data ? D.data.hourly.map(function(h){return h.orders;}) : null,
    hourlyCost: D && D.data ? D.data.hourly.map(function(h){return h.cost;}) : null,
    measuredSlots: D && D.data ? D.data.measuredSlots : null,
    leg: leg?leg.textContent.replace(/\\s+/g,' ').trim():'',
    legNote: note?note.textContent.replace(/\\s+/g,' ').trim().slice(0,40):'',
    hb: document.querySelectorAll('#adsHourBody .hb').length,
    nat: document.querySelectorAll('#adsHourBody .hb-nat').length,
    rects: document.querySelectorAll('#adsHourBody svg rect').length,
    metricBtnOn: [].slice.call(document.querySelectorAll('#adsHourMetric button')).map(function(b){return b.dataset.m+':'+(b.classList.contains('on')?'ON':'off');})
  });
})()`;

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-probe-hc-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1000', '--user-data-dir=' + userDir, 'about:blank'], { stdio: 'ignore' });
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
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const cookie = await login();
    await send('Network.setCookie', { name: 'ml_session', value: cookie, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#ads' });
    for (let i = 0; i < 40; i++) { await sleep(300); const t = await evaluate('document.title||""'); if (t) break; }
    for (let i = 0; i < 40; i++) { const g = await evaluate("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(300); }
    await sleep(3500);
    // 确保范围 = 今天（单天）
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsRange button')).filter(function(x){return x.dataset.r==='today'})[0];if(b)b.click();})()");
    await sleep(15000);

    console.log('--- 默认(应为 orders) ---');
    console.log(await evaluate(PROBE));
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsHourMetric button')).filter(function(x){return x.dataset.m==='cost'})[0];if(b)b.click();})()");
    await sleep(1500);
    console.log('--- 点了「花费」 ---');
    console.log(await evaluate(PROBE));
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsHourMetric button')).filter(function(x){return x.dataset.m==='orders'})[0];if(b)b.click();})()");
    await sleep(1500);
    console.log('--- 切回「出单数量」 ---');
    console.log(await evaluate(PROBE));
    child.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e.message); try { child.kill(); } catch (x) { } process.exit(1); }
})();
