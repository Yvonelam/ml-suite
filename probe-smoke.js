#!/usr/bin/env node
/*
 * 冒烟：把每个主视图点一遍，抓 console 报错 / 页面异常 / 空白视图。
 * 用途：别的 AI 改完代码后，确认前端没被打挂（这次的 530 是隧道问题，不代表前端没问题）。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9371;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;

const dev = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8')); } catch { return {}; } })();
async function login() {
  const body = Buffer.from(JSON.stringify({ username: process.env.ML_ADMIN_USER || dev.username, password: process.env.ML_ADMIN_PASSWORD || dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-smoke-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1000', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const errors = [], failed = [];
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(m + ' timeout')); } }, 30000); }); };
  const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;

  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    if (!t) throw new Error('浏览器没起来');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160));
      if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) failed.push(m.params.response.status + ' ' + m.params.response.url.replace(HOST, ''));
    });
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const ck = await login();
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(300); }
    await sleep(3000);

    const views = JSON.parse(await ev("JSON.stringify([].slice.call(document.querySelectorAll('nav a[data-go]')).map(function(a){return {k:a.dataset.go,t:a.textContent.trim()}}))"));
    console.log('侧栏视图: ' + views.map(v => v.t + '(' + v.k + ')').join(' | '));

    console.log('\n--- 逐个点开 ---');
    for (const v of views) {
      await ev(`(function(){var a=document.querySelector('nav a[data-go="${v.k}"]');if(a)a.click();})()`);
      await sleep(v.k === 'profit' ? 9000 : 3500);
      const info = await ev(`(function(){var s=document.getElementById('v-${v.k}');if(!s)return JSON.stringify({missing:true});
        var vis=s.offsetParent!==null||getComputedStyle(s).display!=='none';
        return JSON.stringify({shown:vis, chars:(s.innerText||'').replace(/\\s+/g,'').length, buttons:s.querySelectorAll('button,input').length});})()`);
      const o = JSON.parse(info || '{}');
      const ok = !o.missing && o.chars > 60;
      console.log('  ' + (ok ? '✅' : '❌') + ' ' + v.t.padEnd(6) + ' 可见=' + o.shown + ' 文字量=' + o.chars + ' 控件=' + o.buttons);
    }

    console.log('\n--- 产品利润页截图 ---');
    await ev("(function(){var a=document.querySelector('nav a[data-go=\"profit\"]');if(a)a.click();})()");
    await sleep(2500);
    const sh = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(__dirname, 'shots', 'smoke-profit.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(sh.data, 'base64'));
    console.log('  📷 ' + out);

    console.log('\n--- 结果 ---');
    const realErr = errors.filter(e => !/favicon|net::ERR_ABORTED/i.test(e));
    console.log('控制台错误: ' + (realErr.length ? '\n  ' + realErr.slice(0, 10).join('\n  ') : '（无）'));
    console.log('失败请求(>=400): ' + (failed.length ? '\n  ' + [...new Set(failed)].slice(0, 10).join('\n  ') : '（无）'));
    process.exit(0);
  } catch (e) { console.error('FAIL ' + e.message); try { child.kill(); } catch (x) { } process.exit(1); }
})();
