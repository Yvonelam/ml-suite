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
 * 四档，每档 4 秒，逐层把「拆掉的包袱」加回去：
 *   A 现状（mtPhase 已掐、::before 已关、视频无 filter）
 *   B + 加回 mtPhase（动画着 filter:brightness/hue-rotate，而视频就在它里面）
 *   C + 再加回 ::before（全屏 blur(46px) + screen 混合，被不透明视频压住，看不见）
 *   D + 再加回视频的 blur(5px)+scale(1.04)
 * 顺便每档截一张图，用来判断「删掉的东西到底看不看得出来」。
 * ORDER=rev 反着跑，用来排除「第一个测的总是慢」这种顺序偏差。
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

// 现在的口径是「逐层加回去」，看每层欠了多少债。
// （旧版是逐层拆掉，因为那时还没修；修完就得反过来问「加回去会怎样」，否则测不出东西。）
const ADD_PHASE = 'html[data-theme=motion] .liquid-bg{animation:mtPhase 18s ease-in-out infinite!important;filter:brightness(.83) saturate(.96)!important}';
const ADD_PSEUDO = 'html[data-theme=motion] .liquid-bg::before{display:block!important}';
const ADD_VIDEOFILTER = 'html[data-theme=motion] .bg-video{filter:blur(5px) saturate(.96) contrast(1.05)!important;transform:scale(1.04)!important}';
const VARIANTS = [
  { key: 'A', name: '现状（三层都已拆）', css: '' },
  { key: 'B', name: '+ 加回 mtPhase 滤镜动画', css: ADD_PHASE },
  { key: 'C', name: '+ 再加回 ::before 横扫柔光', css: ADD_PHASE + ADD_PSEUDO },
  { key: 'D', name: '+ 再加回视频 blur+scale', css: ADD_PHASE + ADD_PSEUDO + ADD_VIDEOFILTER }
];
// ORDER=rev 倒着跑。这个开关是必需的：第一版测量就是把「第一个测的」冤枉成了慢的那一档，
// 换个顺序结论就翻过来。任何「A 比 B 慢」的结论都得两向各跑一遍才算数。
if (process.env.ORDER === 'rev') VARIANTS.reverse();

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

    // ---- 起播爬坡：不先等这个，第一个测的档位一定被冤枉 ----
    // 视频刚起播时解码器初始化 + 合成层建立要好几秒，这期间呈现帧率只有个位数。
    // 已经被这个坑坑过两次（一次把 CSS blur 判成元凶，一次把 mtPhase 判成元凶）。
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

    console.log('\n— 结论（成本从 A 往上叠）—');
    const map = Object.fromEntries(rows.map(r => [r.key, r]));
    let bad = 0;
    const d1 = map.B.busy - map.A.busy, d2 = map.C.busy - map.B.busy, d3 = map.D.busy - map.C.busy;
    const fp = k => map[k].fps.toFixed(1) + ' fps';
    if (map.A.busy > 3 || map.A.fps < 26) {
      console.log('  ✗ 现状本身就不干净：主线程 ' + map.A.busy.toFixed(0) + '%，视频 ' + fp('A')); bad++;
    } else {
      console.log('  ✓ 现状干净：主线程 ' + map.A.busy.toFixed(0) + '%，视频 ' + fp('A'));
    }
    if (d1 > 2) console.log('  · mtPhase 滤镜动画（对整块背景含视频）+' + d1.toFixed(0) + '% 主线程，视频 ' + fp('A') + ' → ' + fp('B'));
    else console.log('  · mtPhase 这轮量化差异不明显（+' + d1.toFixed(0) + '%），但它是唯一一层会吃到视频上的 filter，不留');
    if (d2 > 2) console.log('  · ::before 横扫柔光（被不透明视频压住，看不见）+' + d2.toFixed(0) + '%');
    else console.log('  · ::before 这轮差异不明显（+' + d2.toFixed(0) + '%），仍是零收益的层，不留');
    if (d3 > 2) console.log('  · 视频 blur+scale +' + d3.toFixed(0) + '% 主线程，视频 ' + fp('C') + ' → ' + fp('D'));
    else console.log('  · 视频 blur+scale 这轮差异不明显（+' + d3.toFixed(0) + '%），但会把帧读回 CPU，一律不留');
    console.log('\n  截图（对比 A 与 B/C 判断「删掉的东西到底看不看得出来」）：probe-out/cost-A.png … cost-D.png');
    process.exitCode = bad ? 1 : 0;
  } catch (e) {
    console.error('✗ ' + e.message); process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
})();
