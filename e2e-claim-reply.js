#!/usr/bin/env node
/* 售后回复面板 E2E：打开「退货与投诉」，点开平台调解那条，检查新的预警提示是否出现 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PORT = 9352;
const HOST = 'http://127.0.0.1:' + (process.env.PORT || 3000);
const W = 1440, H = 1000, SCALE = 1.4;

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const findBrowser = () => BROWSERS.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

async function main() {
  const browser = findBrowser();
  if (!browser) { console.log('没找到 Chrome/Edge'); return 1; }
  try { await getJson(HOST + '/api/config'); } catch (e) { console.log('服务没在跑'); return 1; }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-e2e-'));
  const child = spawn(browser, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    '--window-size=' + W + ',' + H, '--user-data-dir=' + userDir, 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null, msgId = 0;
  const pending = new Map();
  const send = (method, params = {}) => {
    const id = ++msgId; ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, 30000); });
  };
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      try { const list = await getJson('http://127.0.0.1:' + PORT + '/json/list'); target = list.find((t) => t.type === 'page'); if (target) break; } catch (e) {}
      await sleep(250);
    }
    if (!target) throw new Error('调试端口没起来');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('WS 失败'))); });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
    });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

    await send('Page.navigate', { url: HOST + '/index.html#claims' });
    for (let i = 0; i < 40; i++) { await sleep(300); try { const t = await evaluate('document.title||""'); if (t.indexOf('ML') >= 0) break; } catch (e) {} }
    // 关掉启动动画
    for (let i = 0; i < 40; i++) {
      const gone = await evaluate("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()");
      if (gone) break; await sleep(300);
    }
    // 等售后列表出来
    for (let i = 0; i < 60; i++) {
      const n = await evaluate("document.querySelectorAll('#claimBody [data-talk]').length");
      if (n > 0) break; await sleep(400);
    }
    const cardInfo = await evaluate(`(function(){
      var cards=Array.from(document.querySelectorAll('#claimBody [data-talk]'));
      return JSON.stringify(cards.map(function(c){return c.getAttribute('data-talk')}));
    })()`);
    console.log('可对话卡片:', cardInfo);
    // 点开平台调解那条
    const clicked = await evaluate(`(function(){
      var btns=Array.from(document.querySelectorAll('#claimBody [data-talk]'));
      if(!btns.length)return 'no-card';
      var target=btns.find(function(b){return /5594696922/.test(b.getAttribute('data-talk')||'')})||btns[0];
      target.click(); return target.getAttribute('data-talk');
    })()`);
    console.log('点开:', clicked);
    await sleep(2200);
    const info = await evaluate(`(function(){
      var txt=document.body.innerText||'';
      return JSON.stringify({
        hasWarn:/本轮没有下发可回复动作/.test(txt),
        hasBanner:/本轮已回复，等对方回应/.test(txt),
        hasCompose:!!document.querySelector('textarea[data-cta]'),
        panelVisible:(function(){var p=document.querySelector('.cpanel');return p?getComputedStyle(p).display:'none'})()
      });
    })()`);
    console.log('面板检查:', info);

    const m = await send('Page.getLayoutMetrics');
    const cs = m.cssContentSize || m.contentSize || { width: W, height: H };
    const height = Math.min(Math.max(H, Math.ceil(cs.height) + 24), 6000);
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height, scale: SCALE } });
    const out = path.join(ROOT, 'shots', 'e2e-claim-reply.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log('截图:', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
    child.kill();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e.message);
    try { child.kill(); } catch (x) {}
    process.exit(1);
  }
}
main();
