#!/usr/bin/env node
/* 临时诊断：问答页 tab 点击后到底发生了什么（不进自检，跑完即删） */
'use strict';
const { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const DBG = 9411, HOST = 'http://127.0.0.1:3000';
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data/dev-login.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
const login = () => new Promise((res, rej) => {
  const b = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  const r = http.request({ host: '127.0.0.1', port: 3000, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': b.length } },
    s => { s.resume(); s.on('end', () => { const c = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); c ? res(decodeURIComponent(c.split(';')[0].slice(11))) : rej(new Error('登录失败')); }); });
  r.on('error', rej); r.write(b); r.end();
});
(async () => {
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-qd-'));
  const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1280,1200', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#questions' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 80; i++) { if (await ev('typeof go === "function" && typeof questionView === "object"')) break; await sleep(200); }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');return true})()");
    await ev("go('questions'); true"); await sleep(4000);
    console.log('初始 state=', await ev('questionView.state'), '| 状态文案=', await ev("document.querySelector('#questionState').innerText"));
    console.log('tab 按钮数=', await ev("document.querySelectorAll('#questionTabs button').length"));
    console.log('tab onclick 挂了=', await ev("!!document.querySelector('#questionTabs button[data-k=\\'ANSWERED\\']').onclick"));
    const ret = await ev("(function(){var b=document.querySelector('#questionTabs button[data-k=\\'ANSWERED\\']'); b.click(); return {state: questionView.state, on: b.classList.contains('on')};})()");
    console.log('点击后立即=', JSON.stringify(ret));
    for (const w of [1000, 3000, 6000, 10000]) {
      await sleep(w === 1000 ? 1000 : w - 0);
      console.log('  +' + w + 'ms  state=', await ev('questionView.state'), '| 文案=', await ev("document.querySelector('#questionState').innerText"), '| 卡片=', await ev("document.querySelectorAll('#questionBody .qcard').length"), '| body头=', (await ev("document.querySelector('#questionBody').innerHTML.slice(0,90)")).replace(/\s+/g, ' '));
    }
  } finally { try { ws && ws.close(); } catch (e) { } try { child.kill(); } catch (e) { } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } }
  process.exit(0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
