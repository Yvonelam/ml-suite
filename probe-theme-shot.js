#!/usr/bin/env node
/**
 * 设计用截图：抓「背景露得多」的几种状态，用来判断皮肤本身的观感
 * 用法：node probe-theme-shot.js [主题key] [输出前缀]
 *   默认 gold / shot-gold
 * 抓三张：概览顶部 / 概览滚到底 / 箱唛裁切（内容少，背景大面积可见）
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const THEME = process.argv[2] || 'gold';
const PREFIX = process.argv[3] || ('shot-' + THEME);
const DBG = 9391;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(p => { try { return p && fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

(async () => {
  const ck = await login();
  const outDir = path.join(__dirname, 'probe-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-shot-'));
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1440,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    if (!t) throw new Error('浏览器没起来');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.6, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    await sleep(1600);
    // 直接调 app.js 的 applyTheme —— 比「先写 localStorage 再跳转」稳，那条路存在竞态，
    // 偶尔会在 about:blank（不透明源）上写失败，结果静默退回默认主题，截出来的图是错的。
    const switched = await ev("(function(){if(typeof applyTheme!=='function')return 'no-fn';applyTheme('" + THEME + "');return document.documentElement.dataset.theme})()");
    if (switched !== THEME) { console.log('  ✗ 切主题失败：' + switched); process.exitCode = 1; }
    await sleep(1000);
    const th = await ev("document.documentElement.dataset.theme");
    console.log('当前主题：' + th + (th === THEME ? ' ✓' : ' ✗ 与目标不符'));
    const layers = JSON.parse(await ev("JSON.stringify({mist:document.getElementById('themeMist').disabled,color:document.getElementById('themeColor').disabled,gold:document.getElementById('themeGold').disabled})"));
    console.log('主题层开关（true=关）：' + JSON.stringify(layers));

    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(outDir, PREFIX + '-' + name + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('  → ' + path.relative(__dirname, f));
    };

    await shot('hub-top');
    await ev("window.scrollTo(0,document.documentElement.scrollHeight)");
    await sleep(900);
    await shot('hub-bottom');
    await ev("(function(){var a=document.querySelector('nav a[data-go=\"box\"]');if(a)a.click();})()");
    await sleep(1400);
    await shot('box');

    // 主题菜单（四套都在时的高度与色块）
    await ev("document.getElementById('brandLogo').click()");
    await sleep(500);
    const mr = JSON.parse(await ev("(function(){var m=document.getElementById('themeMenu');if(!m||m.hidden)return '{}';var r=m.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()"));
    if (mr.w) {
      const ms = await send('Page.captureScreenshot', { format: 'png', clip: { x: mr.x - 4, y: mr.y - 4, width: mr.w + 8, height: mr.h + 8, scale: 3 } });
      fs.writeFileSync(path.join(outDir, PREFIX + '-menu.png'), Buffer.from(ms.data, 'base64'));
      console.log('  菜单 ' + mr.w + '×' + mr.h + ' → probe-out/' + PREFIX + '-menu.png');
    } else { console.log('  ! 菜单没弹出来'); }
    await ev("document.getElementById('brandLogo').click()");
    await sleep(400);

    // 放大裁拍页标题，用来看烫金渐变是否真的出效果
    await ev("(function(){var a=document.querySelector('nav a[data-go=\"hub\"]');if(a)a.click();window.scrollTo(0,0);})()");
    await sleep(1200);
    const tr = JSON.parse(await ev("(function(){var h=document.querySelector('.ph2 h1');if(!h)return '{}';var r=h.getBoundingClientRect();var cs=getComputedStyle(h);return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,fill:cs.webkitTextFillColor,clip:cs.webkitBackgroundClip,bg:cs.backgroundImage.slice(0,90)})})()"));
    console.log('  页标题计算样式：' + JSON.stringify(tr).slice(0, 300));
    if (tr.w) {
      const z = await send('Page.captureScreenshot', { format: 'png', clip: { x: tr.x - 6, y: tr.y - 8, width: tr.w + 12, height: tr.h + 16, scale: 4 } });
      fs.writeFileSync(path.join(outDir, PREFIX + '-title.png'), Buffer.from(z.data, 'base64'));
      console.log('  → probe-out/' + PREFIX + '-title.png');
    }

    // 动态玻璃：把视频定格在几个时刻，专门看「亮帧」下面板文字还读不读得清
    if (await ev("!!document.getElementById('bgVideo')") && process.env.VIDEO_T) {
      for (const tt of process.env.VIDEO_T.split(',')) {
        const sec = parseFloat(tt);
        await ev("(function(){var v=document.getElementById('bgVideo');v.pause();v.currentTime=" + sec + ";})()");
        await sleep(700);
        const sh = await send('Page.captureScreenshot', { format: 'png' });
        const fn = path.join(outDir, PREFIX + '-t' + sec + '.png');
        fs.writeFileSync(fn, Buffer.from(sh.data, 'base64'));
        console.log('  定格 t=' + sec + 's → ' + path.relative(__dirname, fn));
      }
      await ev("(function(){var v=document.getElementById('bgVideo');v.play().catch(function(){});})()");
    }

    // 性能采样：数 2 秒内 rAF 的帧数，并统计有多少元素挂了 backdrop-filter。
    // 注意无头 Chrome 是 --disable-gpu 的软件合成，绝对值没意义，只看同条件下不同主题的相对差。
    if (process.env.PERF) {
      const fps = await ev(`new Promise(function(res){
        var n=0, t0=performance.now();
        function tick(){ n++; if(performance.now()-t0<2000) requestAnimationFrame(tick); else res(Math.round(n/((performance.now()-t0)/1000))); }
        requestAnimationFrame(tick);
      })`);
      const blurCount = await ev("(function(){var n=0;document.querySelectorAll('*').forEach(function(e){var cs=getComputedStyle(e);if((cs.backdropFilter&&cs.backdropFilter!=='none')||(cs.webkitBackdropFilter&&cs.webkitBackdropFilter!=='none'))n++;});return n})()");
      console.log('  性能：约 ' + fps + ' fps · ' + blurCount + ' 个元素带 backdrop-filter');
    }

    // 任意选择器放大裁拍（看某块卡片有没有被背景渗色 / 有没有糊掉）
    const sel = process.env.CLIP_SEL;
    if (sel) {
      const cr = JSON.parse(await ev("(function(){var e=document.querySelector('" + sel + "');if(!e)return '{}';var r=e.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()"));
      if (cr.w) {
        const cs = await send('Page.captureScreenshot', { format: 'png', clip: { x: cr.x, y: cr.y, width: cr.w, height: Math.min(cr.h, 420), scale: 2.4 } });
        const f2 = path.join(outDir, PREFIX + '-clip.png');
        fs.writeFileSync(f2, Buffer.from(cs.data, 'base64'));
        console.log('  裁拍 ' + sel + ' (' + Math.round(cr.w) + '×' + Math.round(cr.h) + ') → ' + path.relative(__dirname, f2));
      } else { console.log('  ! 没找到 ' + sel); }
    }

    console.log('尺寸：' + await ev("JSON.stringify({h:innerHeight,sw:document.body.scrollWidth})"));
  } catch (e) {
    console.log('  ✗ ' + e.message);
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    setTimeout(() => process.exit(0), 300);
  }
})();
