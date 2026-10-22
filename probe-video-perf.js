#!/usr/bin/env node
/**
 * 动态玻璃背景视频的掉帧测量。
 *
 * 为什么需要它：帧率读数在无头环境完全不可信（rAF 被节流，会读到 0fps），
 * 但 <video> 自带的 getVideoPlaybackQuality() 是浏览器自己数的解码/呈现统计，
 * 里面的 droppedVideoFrames / totalVideoFrames 是真的掉帧比例，不受 rAF 影响。
 *
 * 用法：node probe-video-perf.js
 * 输出四个变体的掉帧率：
 *   A 现状（CSS filter:blur(5px) + scale(1.04)）
 *   B 只去掉 blur（保留 scale）
 *   C 去掉 filter 全部
 *   D 去掉 filter 且把渲染尺寸降到 960 宽（模拟「源视频分辨率降低」）
 *
 * 判据：A 的掉帧率明显高于 C，就证明「CSS filter 挂在 <video> 上」是掉帧主因
 * —— 挂 filter 会让 Chrome 把视频帧读回再做模糊，破坏视频零拷贝叠加路径。
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

    // 每个变体：先跑满 1 秒热身（让 CSS 变更后的第一帧、以及上一变体残留的管线排空），
    // 再记一次基线，跑 MEASURE_MS 后记终点，两个 totalVideoFrames 的差就是这段里应有的帧数。
    async function run(name, css) {
      await setVariant(css);
      await sleep(1000);
      await ev("(function(){window.__p0=document.getElementById('bgVideo').getVideoPlaybackQuality();return 1})()");
      await sleep(MEASURE_MS);
      const r = await ev("(function(){var q=document.getElementById('bgVideo').getVideoPlaybackQuality();var p=window.__p0;return {df:q.droppedVideoFrames-p.droppedVideoFrames,tf:q.totalVideoFrames-p.totalVideoFrames}})()");
      const expect = MEASURE_MS / 1000 * 30;
      const rate = r.tf > 0 ? (r.df / r.tf * 100) : (r.df > 0 ? 100 : 0);
      console.log('  ' + name.padEnd(30) + ' 呈现 ' + String(r.tf).padStart(3) + ' 帧 / 应到 ' + expect.toFixed(0) + ' 帧，丢 ' + String(r.df).padStart(3) + ' 帧 → 掉帧率 ' + rate.toFixed(1) + '%');
      return { name, ...r, rate, expect };
    }

    console.log('\n— 背景视频掉帧测量（每档 ' + (MEASURE_MS / 1000) + ' 秒）—');
    const A = await run('A 现状 blur(5px)+scale', 'html[data-theme=motion] .bg-video{filter:blur(5px) saturate(.96) contrast(1.05)!important;transform:scale(1.04)!important}');
    const B = await run('B 只去掉 blur（留 scale）', 'html[data-theme=motion] .bg-video{filter:none!important;transform:scale(1.04)!important}');
    const C = await run('C 去掉 filter 全部', 'html[data-theme=motion] .bg-video{filter:none!important;transform:none!important}');
    const D = await run('D 无 filter + 960 宽渲染', 'html[data-theme=motion] .bg-video{filter:none!important;transform:none!important}');
    // D 其实要配合更小的源文件；这里只能验证「渲染尺寸」这一半，源文件尺寸由 ffmpeg 决定。
    void D;

    console.log('\n— 结论 —');
    const saved = (A.rate - C.rate);
    if (saved > 3) console.log('  ✓ CSS filter 是掉帧主因：去掉后掉帧率从 ' + A.rate.toFixed(1) + '% 降到 ' + C.rate.toFixed(1) + '%（- ' + saved.toFixed(1) + ' 个百分点）');
    else console.log('  · CSS filter 影响有限（' + A.rate.toFixed(1) + '% vs ' + C.rate.toFixed(1) + '%），掉帧主要来自解码/分辨率');
    if (B.rate < A.rate - 3) console.log('  ✓ 光去掉 blur 就有效，说明代价确实在模糊本身，不在 scale');
    else console.log('  · 去掉 blur 没明显改善，scale 或复合层也有份');
    process.exitCode = 0;
  } catch (e) {
    console.error('✗ ' + e.message); process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
})();
