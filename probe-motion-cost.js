#!/usr/bin/env node
/**
 * 动态玻璃「背景层到底在烧多少」——按渲染主线程耗时量。
 *
 * 为什么不用帧率：视频呈现帧率有天花板（片源 30fps），只要不掉就都显示 30，
 * 看不出「已经在用 80% 的力气才勉强跑满」。真正区分成本的是 CDP 的
 * Performance.getMetrics → TaskDuration（渲染进程把时间花在干活上的秒数）。
 * 同一段时间里 TaskDuration 占比越高，就越接近「下一帧来不及」。
 * 这个数在无头软件光栅下会明显放大，但变体之间的相对关系是可比的。
 *
 * 用法：node probe-motion-cost.js
 * 四档，每档 4 秒：
 *   A 现状（视频 + mtPhase 滤镜动画 + ::before 扫光 + ::after 旋转 conic）
 *   B 停掉 .liquid-bg 的 mtPhase（那是对整层含视频做 brightness/hue-rotate）
 *   C 再停掉 ::before / ::after（两个全屏模糊 + 混合模式，还在视频上面）
 *   D 只留视频
 * 顺便每档截一张图，用来判断「删掉的东西到底看不看得出来」。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9395;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const MEASURE_MS = 4000;
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

const KILL_PHASE = 'html[data-theme=motion] .liquid-bg{animation:none!important;filter:none!important}';
const KILL_PSEUDO = 'html[data-theme=motion] .liquid-bg::before,html[data-theme=motion] .liquid-bg::after{display:none!important}';
const VARIANTS = [
  { key: 'A', name: '现状（三项全开）', css: '' },
  { key: 'B', name: '停掉 mtPhase 滤镜动画', css: KILL_PHASE },
  { key: 'C', name: '再停 ::before/::after', css: KILL_PHASE + KILL_PSEUDO },
  { key: 'D', name: '只留视频', css: KILL_PHASE + KILL_PSEUDO }
];

(async () => {
  const ck = await login();
  const outDir = path.join(__dirname, 'probe-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cost-'));
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
    await send('Runtime.enable'); await send('Page.enable'); await send('Performance.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.6, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    await sleep(1600);
    const th = await ev("(function(){if(typeof applyTheme!=='function')return 'no-fn';applyTheme('motion');return document.documentElement.dataset.theme})()");
    if (th !== 'motion') throw new Error('切不到动态玻璃：' + th);
    for (let i = 0; i < 40; i++) { const r = await ev("(function(){var v=document.getElementById('bgVideo');return v&&v.readyState>=2&&v.currentTime>0.3})()"); if (r) break; await sleep(300); }

    const metric = async (name) => {
      const m = await send('Performance.getMetrics');
      const f = m.metrics.find(x => x.name === name);
      return f ? f.value : null;
    };
    await ev("(function(){var s=document.createElement('style');s.id='costOverride';document.head.appendChild(s);return 1})()");
    const setVariant = css => ev("(function(){document.getElementById('costOverride').textContent=" + JSON.stringify(css) + ";return 1})()");

    console.log('\n— 背景层成本（每档 ' + (MEASURE_MS / 1000) + ' 秒，数值＝渲染进程干活时间占墙钟的比例）—');
    const rows = [];
    for (const v of VARIANTS) {
      await setVariant(v.css);
      await sleep(1500); // 让新 CSS 生效 + 上一档排空
      const d0 = await metric('TaskDuration'), w0 = Date.now();
      const f0 = await ev("document.getElementById('bgVideo').getVideoPlaybackQuality().totalVideoFrames");
      await sleep(MEASURE_MS);
      const d1 = await metric('TaskDuration'), w1 = Date.now();
      const f1 = await ev("document.getElementById('bgVideo').getVideoPlaybackQuality().totalVideoFrames");
      const busy = (d1 - d0) / ((w1 - w0) / 1000) * 100;
      const fps = (f1 - f0) / ((w1 - w0) / 1000);
      const bar = '█'.repeat(Math.min(30, Math.round(busy))).padEnd(30, '·');
      console.log('  ' + v.key + ' ' + v.name.padEnd(22) + ' ' + bar + ' 主线程占用 ' + busy.toFixed(0).padStart(3) + '%   视频 ' + fps.toFixed(1) + ' fps');
      rows.push({ ...v, busy, fps });
      // 截图留档，用来判断删掉的东西看不看得出来
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, 'cost-' + v.key + '.png'), Buffer.from(shot.data, 'base64'));
    }

    console.log('\n— 结论 —');
    const map = Object.fromEntries(rows.map(r => [r.key, r]));
    const drop1 = map.A.busy - map.B.busy, drop2 = map.B.busy - map.C.busy;
    if (drop1 > 3) console.log('  ✓ mtPhase（整层 brightness/hue-rotate 动画）占掉 ' + drop1.toFixed(0) + '% 的主线程：' + map.A.busy.toFixed(0) + '% → ' + map.B.busy.toFixed(0) + '%');
    else console.log('  · mtPhase 影响不大（' + map.A.busy.toFixed(0) + '% → ' + map.B.busy.toFixed(0) + '%），但仍应停掉：它对视频也在做滤镜');
    if (drop2 > 3) console.log('  ✓ ::before/::after（两个全屏模糊 + 混合模式）再省 ' + drop2.toFixed(0) + '%：' + map.B.busy.toFixed(0) + '% → ' + map.C.busy.toFixed(0) + '%');
    else console.log('  · ::before/::after 影响不大（' + map.B.busy.toFixed(0) + '% → ' + map.C.busy.toFixed(0) + '%）');
    console.log('\n  截图（对比 A 与 C 判断视觉差异）：probe-out/cost-A.png … cost-D.png');
  } catch (e) {
    console.error('✗ ' + e.message); process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
})();
