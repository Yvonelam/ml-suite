#!/usr/bin/env node
/**
 * 动态玻璃背景视频的呈现帧率测量。
 *
 * 为什么需要它：帧率读数在无头环境完全不可信（rAF 被节流，会读到 0fps），
 * 但 <video> 自带的 getVideoPlaybackQuality() 是浏览器自己数的呈现统计，
 * 里面的 totalVideoFrames 增量 / 秒数 = 观众真正看到的帧率，不受 rAF 影响。
 *
 * 用法：node probe-video-perf.js
 *
 * ⚠️ 这个脚本存在的原因之二，是它自己踩过的坑：
 * 第一版按「A 现状 / B 旧写法」顺序各测一次，结论是「加 blur 掉到 7fps」。
 * 把顺序一换，7fps 就跑到没加 blur 的那档去了 —— 慢的是**排在第一个**的变体，
 * 不是 CSS。视频刚起播时解码器/合成器有 3~8 秒的爬坡，第一个测的必背这口锅。
 * 所以现在：起播后先等帧率爬稳，再把每一档测两轮交错跑，只认第二轮。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9393;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const MEASURE_MS = Number(process.env.MS || 5000);
const ROUNDS = Number(process.env.ROUNDS || 2);
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

// 四个变体：现状必须满分；带 blur 的那档用来证明「这个坑还在」
const VARIANTS = [
  { key: 'A', name: '现状（无 CSS filter）', css: '' },
  { key: 'B', name: '旧写法 blur(5px)+scale', css: 'html[data-theme=motion] .bg-video{filter:blur(5px) saturate(.96) contrast(1.05)!important;transform:scale(1.04)!important}' },
  { key: 'C', name: '旧写法只留 scale(1.04)', css: 'html[data-theme=motion] .bg-video{filter:none!important;transform:scale(1.04)!important}' },
  { key: 'D', name: '现状 + 强制 960 宽渲染', css: 'html[data-theme=motion] .bg-video{width:960px!important;height:504px!important}' }
];

(async () => {
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-perf-'));
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
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
    await sleep(1400);

    const th = await ev("(function(){if(typeof applyTheme!=='function')return 'no-fn';applyTheme('motion');return document.documentElement.dataset.theme})()");
    if (th !== 'motion') throw new Error('切不到动态玻璃：' + th);
    for (let i = 0; i < 40; i++) { const r = await ev("(function(){var v=document.getElementById('bgVideo');return v&&v.readyState>=2&&v.currentTime>0.2})()"); if (r) break; await sleep(300); }

    // ---- 起播爬坡：什么都不改，先等稳定 ----
    // 这段是脚本的立身之本。刚起播时解码器初始化 + 合成层建立要好几秒，
    // 这期间呈现帧率只有 5~10fps，任何「排在第一」的变体都会被冤枉。
    const fpsWindow = async (ms) => {
      const a = await ev("document.getElementById('bgVideo').getVideoPlaybackQuality().totalVideoFrames");
      await sleep(ms);
      const b = await ev("document.getElementById('bgVideo').getVideoPlaybackQuality().totalVideoFrames");
      return (b - a) / (ms / 1000);
    };
    let warm = 0, warmMs = 0;
    process.stdout.write('  起播爬坡：');
    for (let i = 0; i < 20; i++) {
      warm = await fpsWindow(1000); warmMs += 1000;
      process.stdout.write(' ' + warm.toFixed(0));
      if (warm >= 25) break;
    }
    console.log('  → ' + warmMs / 1000 + ' 秒后稳定在 ' + warm.toFixed(1) + ' fps\n');
    if (warm < 25) console.log('  ⚠️ 等了 ' + warmMs / 1000 + ' 秒还是没跑到 25fps 以上，下面的数字要打折看\n');

    // ---- 交错两轮 ----
    await ev("(function(){var s=document.createElement('style');s.id='perfOverride';document.head.appendChild(s);return 1})()");
    const setVariant = css => ev("(function(){document.getElementById('perfOverride').textContent=" + JSON.stringify(css) + ";return 1})()");

    const results = {};
    for (let round = 1; round <= ROUNDS; round++) {
      console.log('— 第 ' + round + ' 轮（每档 ' + (MEASURE_MS / 1000) + ' 秒，片源 30fps）—');
      for (const v of VARIANTS) {
        await setVariant(v.css);
        await sleep(1200); // 让 CSS 变更 + 上一档的管线排空
        const fps = await fpsWindow(MEASURE_MS);
        (results[v.key] = results[v.key] || []).push(fps);
        const bar = '█'.repeat(Math.round(Math.min(fps, 30) / 30 * 24)).padEnd(24, '·');
        console.log('  ' + v.key + ' ' + v.name.padEnd(24) + ' ' + bar + ' ' + fps.toFixed(1).padStart(5) + ' fps');
      }
      console.log('');
    }

    // 只认最后一轮：第一轮仍可能夹着上一档的余温
    const last = k => results[k][results[k].length - 1];
    const A = last('A'), B = last('B'), C = last('C'), D = last('D');
    console.log('— 结论（取第 ' + ROUNDS + ' 轮）—');
    let bad = 0;
    if (A >= 26) console.log('  ✓ 现状跑满帧：' + A.toFixed(1) + ' fps（片源 30fps，≥26 算跟得上）');
    else { console.log('  ✗ 现状只有 ' + A.toFixed(1) + ' fps，仍在掉帧'); bad++; }
    if (B < A - 8) console.log('  ✓ 旧写法确实掉帧：加回 blur(5px) 就掉到 ' + B.toFixed(1) + ' fps（-' + (A - B).toFixed(1) + '）');
    else console.log('  · 这轮加 blur 没明显掉帧（' + B.toFixed(1) + ' fps）—— 说明这台机器的路径不同，但别赌，一律不挂 filter');
    if (C < A - 3) console.log('  · scale(1.04) 单独也要吃 ' + (A - C).toFixed(1) + ' fps，所以连同 filter 一起删了');
    if (Math.abs(D - A) < 3) console.log('  ✓ object-fit 缩放本身不贵（' + D.toFixed(1) + ' vs ' + A.toFixed(1) + ' fps），降源分辨率只为省解码');
    else console.log('  · 强制 960 宽渲染后 ' + D.toFixed(1) + ' fps（差 ' + (A - D).toFixed(1) + '）');
    process.exitCode = bad ? 1 : 0;
  } catch (e) {
    console.error('✗ ' + e.message); process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
})();
