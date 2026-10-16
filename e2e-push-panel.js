#!/usr/bin/env node
/* 一次性验证：配置弹窗里「售后提醒」开关是否正确渲染与回显 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PORT = 9353, HOST = 'http://127.0.0.1:' + (process.env.PORT || 3000), W = 1440, H = 1000;
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-e2e2-'));
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
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: HOST + '/index.html#hub' });
    for (let i = 0; i < 40; i++) { await sleep(300); const t = await evaluate('document.title||""'); if (t) break; }
    for (let i = 0; i < 40; i++) { const g = await evaluate("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(300); }
    await sleep(1200);
    const opened = await evaluate("(function(){var b=document.getElementById('mlCfgBtn');if(!b)return 'no-btn';b.click();return 'clicked'})()");
    console.log('打开配置弹窗:', opened);
    await sleep(1800);
    await evaluate("(function(){var s=document.getElementById('pushSection');if(s){s.open=true;s.scrollIntoView({block:'center'});}var m=document.getElementById('mlModal');return 1})()");
    await sleep(900);
    const r = await evaluate(`(function(){
      var box=document.getElementById('mlModal');
      var cl=document.getElementById('pushClaims');
      var sec=document.getElementById('pushSection');
      return JSON.stringify({
        modalVisible: box?getComputedStyle(box).display:'none',
        hasCheckbox: !!cl,
        checkboxChecked: cl?cl.checked:null,
        sectionTitle: sec?(sec.querySelector('summary')||{}).textContent:'',
        stateText: (document.getElementById('pushState')||{}).textContent||''
      });
    })()`);
    console.log('检查结果:', r);
    const m = await send('Page.getLayoutMetrics'); const cs = m.cssContentSize || { height: H };
    const r2 = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: Math.min(H, Math.ceil(cs.height)), scale: 1.3 } });
    const out = path.join(__dirname, 'shots', 'e2e-push-panel.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(r2.data, 'base64'));
    console.log('截图:', out);
    child.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e.message); try { child.kill(); } catch (x) { } process.exit(1); }
})();
