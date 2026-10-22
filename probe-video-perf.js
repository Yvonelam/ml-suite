#!/usr/bin/env node
/**
 * 动态玻璃背景视频的掉帧测量。
 *
 * 为什么需要它：帧率读数在无头环境完全不可信（rAF 被节流，会读到 0fps），
 * 但 <video> 自带的 getVideoPlaybackQuality() 是浏览器自己数的解码/呈现统计，
 * 里面的 droppedVideoFrames / totalVideoFrames 是真的掉帧比例，不受 rAF 影响。
 *
 * 用法：node probe-video-perf.js
 * 输出四个变体的呈现帧率：
 *   A 现状（无 CSS filter，模糊已烘进视频）
 *   B 复现旧写法 filter:blur(5px)
 *   C 旧写法但去掉 blur（只留 scale(1.04)）
 *   D 现状 + 把渲染尺寸压到 960 宽（确认 object-fit 缩放本身不贵）
 *
 * 判据：B 的呈现帧率明显低于 A，就证明「CSS filter 挂在 <video> 上」是掉帧主因
 * —— 挂 filter 会让 Chrome 把视频帧读回 CPU 再做模糊，破坏视频零拷贝叠加路径。
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
    // 先让它把视频下载 + 起播
    for (let i = 0; i < 40; i++) { const r = await ev("(function(){var v=document.getElementById('bgVideo');return v&&v.readyState>=2&&v.currentTime>0.2})()"); if (r) break; await sleep(300); }

    // 注入一个独立的 style，专门盖掉 .bg-video 的 filter/transform/尺寸
    await ev("(function(){var s=document.createElement('style');s.id='perfOverride';document.head.appendChild(s);return 1})()");
    const setVariant = css => ev("(function(){document.getElementById('perfOverride').textContent=" + JSON.stringify(css) + ";return 1})()");

    // 每个变体：先跑满 1 秒热身（让上一变体的管线排空、新 CSS 生效），
    // 再记一次基线，跑 MEASURE_MS 后记终点。
    // 主指标用「呈现帧率」= totalVideoFrames 的增量 / 秒数 —— 这个数才是观众真正看到的。
    // droppedVideoFrames 在 Chrome 里语义不稳（有时比 total 还大），只作参考不打头条。
    const FPS = 30;
    async function run(name, css) {
      await setVariant(css);
      await sleep(1000);
      await ev("(function(){window.__p0=document.getElementById('bgVideo').getVideoPlaybackQuality();return 1})()");
      await sleep(MEASURE_MS);
      const r = await ev("(function(){var q=document.getElementById('bgVideo').getVideoPlaybackQuality();var p=window.__p0;return {df:q.droppedVideoFrames-p.droppedVideoFrames,tf:q.totalVideoFrames-p.totalVideoFrames}})()");
      const fps = r.tf / (MEASURE_MS / 1000);
      const bar = '█'.repeat(Math.round(fps / FPS * 24)).padEnd(24, '·');
      console.log('  ' + name.padEnd(28) + ' ' + bar + ' ' + fps.toFixed(1).padStart(5) + ' fps'
        + (r.df > 0 ? '   (另记丢帧 ' + r.df + ')' : ''));
      return { name, fps, ...r };
    }

    console.log('\n— 背景视频呈现帧率（每档 ' + (MEASURE_MS / 1000) + ' 秒，片源 30fps，满分 30）—');
    const A = await run('A 现状（无 CSS filter）', '');
    const B = await run('B 旧写法 blur(5px)', 'html[data-theme=motion] .bg-video{filter:blur(5px) saturate(.96) contrast(1.05)!important}');
    const C = await run('C 旧写法只留 scale(1.04)', 'html[data-theme=motion] .bg-video{filter:none!important;transform:scale(1.04)!important}');
    const D = await run('D 现状 + 缩到 960 宽渲染', 'html[data-theme=motion] .bg-video{width:960px!important;height:504px!important}');

    console.log('\n— 结论 —');
    let bad = 0;
    const r2 = n => n.toFixed(1);
    if (A.fps >= 26) console.log('  ✓ 现状跑满帧：' + r2(A.fps) + ' fps（片源 30fps，≥26 就算跟得上）');
    else { console.log('  ✗ 现状只有 ' + r2(A.fps) + ' fps，仍在掉帧'); bad++; }
    if (B.fps < A.fps - 8) console.log('  ✓ 复现了旧 bug：挂上 blur(5px) 立刻掉到 ' + r2(B.fps) + ' fps（-' + r2(A.fps - B.fps) + ' 帧/秒）');
    else console.log('  · 挂 blur 这次没明显掉帧（' + r2(B.fps) + ' fps），可能这台机器/这个版本走了别的路径');
    if (C.fps < A.fps - 3) console.log('  · scale(1.04) 单独也要吃 ' + r2(A.fps - C.fps) + ' fps，所以它也一起删了');
    if (Math.abs(D.fps - A.fps) < 3) console.log('  ✓ object-fit 缩放本身不贵（' + r2(D.fps) + ' vs ' + r2(A.fps) + ' fps），降源分辨率只为省解码，不为省合成');
    else console.log('  · 降到 960 宽渲染后 ' + r2(D.fps) + ' fps（差 ' + r2(A.fps - D.fps) + '），缩放有成本');
    process.exitCode = bad ? 1 : 0;
  } catch (e) {
    console.error('✗ ' + e.message); process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
})();
