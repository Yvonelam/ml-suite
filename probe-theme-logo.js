#!/usr/bin/env node
/**
 * 浏览器实测：五套美术风格下侧边栏 Logo 是否各自换成对应版本
 * 检查点：data-theme 正确 / 只有当前主题那张 Logo 不透明 / 三张都真的加载成功 / 切换后菜单收起 / 无 404
 * 用法：node probe-theme-logo.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9388;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));
const THEMES = ['classic', 'mist', 'glass', 'gold', 'motion'];
const NAME = { classic: '经典深色', mist: '柔雾玻璃', glass: '彩色毛玻璃', gold: '典藏金', motion: '动态玻璃' };

function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(p => { try { return p && fs.existsSync(p); } catch (e) { return false; } });
const browser = BROWSERS[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : '')); } };

(async () => {
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-logo-'));
  const outDir = path.join(__dirname, 'probe-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { }
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1440,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const errors = [], badReq = [], reqs = [], reqById = new Map(), cancelReq = [];
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    if (!t) throw new Error('浏览器没起来');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160));
      if (m.method === 'Network.requestWillBeSent') reqById.set(m.params.requestId, m.params.request.url);
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        reqs.push(r.url);
        if (r.status >= 400) badReq.push(r.status + ' ' + r.url);
      }
      // 带上 URL，不然「FAILED ERR_ABORTED Media」这种报错根本看不出是谁挂了。
      // canceled=true 的是渲染进程主动取消的（<video> 缓冲够了就不让继续下 range 请求，
      // Chrome 走隧道时很常见），不算失败 —— 但单独列出来，别让它悄悄藏进「无失败」里。
      if (m.method === 'Network.loadingFailed') {
        const line = (m.params.errorText || '') + ' ' + (m.params.type || '') + ' ' + (reqById.get(m.params.requestId) || '?');
        (m.params.canceled ? cancelReq : badReq).push((m.params.canceled ? 'CANCELED ' : 'FAILED ') + line);
      }
    });
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    // 关掉所有过渡/动画：探针要验的是「最终哪一张 Logo 可见」，不是动画过程。
    // 无头环境里 .55s 的 transform 过渡会因调度抖动差最后几毫秒，一直按「差不多归位」误判。
    await ev("(function(){var st=document.createElement('style');st.id='probe-noanim';st.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.appendChild(st);return !!document.getElementById('probe-noanim')})()");
    await sleep(400);

    console.log('\n— 结构 —');
    const imgs = await ev("JSON.stringify([].map.call(document.querySelectorAll('.brand-logo img'),function(i){return {t:i.getAttribute('data-t'),src:i.getAttribute('src')}}))");
    const list = JSON.parse(imgs || '[]');
    ok(list.length === 5, '侧边栏 Logo 挂了 5 张（每套主题一张）', list);
    ok(THEMES.every(t => list.some(x => x.t === t)), '五套主题 key 都在 DOM 里：classic / mist / glass / gold / motion', list.map(x => x.t));
    ok(new Set(list.map(x => x.src)).size === 5, '五张指向五个不同文件', list.map(x => x.src));

    console.log('\n— 五张是否都真的加载成功（预载）—');
    const nat = JSON.parse(await ev("JSON.stringify([].map.call(document.querySelectorAll('.brand-logo img'),function(i){return {t:i.getAttribute('data-t'),w:i.naturalWidth,h:i.naturalHeight}}))") || '[]');
    nat.forEach(n => ok(n.w > 0, 'Logo 资源已解码：' + n.t + ' (' + n.w + '×' + n.h + ')', n));

    console.log('\n— 逐套切换（真实点击 Logo → 点菜单项）—');
    for (const th of THEMES) {
      await ev("document.getElementById('brandLogo').click()");
      await sleep(260);
      const opened = await ev("!document.getElementById('themeMenu').hidden");
      if (th === 'classic') ok(opened, '点侧边栏 Logo 能弹出风格菜单', opened);
      const reqBefore = reqs.filter(u => /bg-dynamic\.mp4/.test(u)).length;
      await ev("(function(){var b=document.querySelector('.theme-item[data-t=\"" + th + "\"]');if(b)b.click();})()");
      if (th === 'motion') {
        ok(reqBefore === 0, '[动态玻璃] 之前四套皮肤下从未请求过背景视频（data-src 懒加载生效）', reqBefore);
      }
      await sleep(320);   // 动画已禁用，样式切换即时生效，这里只留一点余量给事件派发
      const st = JSON.parse(await ev(`JSON.stringify((function(){
        var d=document.documentElement.dataset.theme;
        var arr=[].map.call(document.querySelectorAll('.brand-logo img'),function(i){
          var cs=getComputedStyle(i);
          return {t:i.getAttribute('data-t'),op:+cs.opacity,tr:cs.transform};
        });
        return {theme:d,items:arr,menuHidden:document.getElementById('themeMenu').hidden,
                stored:localStorage.getItem('mlsuiteTheme'),
                rect:(function(){var r=document.querySelector('.brand-logo').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()};
      })())`) || '{}');

      ok(st.theme === th, '[' + NAME[th] + '] html[data-theme] = ' + th, st.theme);
      ok(st.menuHidden === true, '[' + NAME[th] + '] 选完菜单自动收起', st.menuHidden);
      ok(st.stored === th, '[' + NAME[th] + '] 选择已记进 localStorage', st.stored);
      const shown = (st.items || []).filter(i => i.op > .95);
      ok(shown.length === 1, '[' + NAME[th] + '] 恰好一张 Logo 可见（其余透明）', (st.items || []).map(i => i.t + ':' + i.op));
      ok(shown.length === 1 && shown[0].t === th, '[' + NAME[th] + '] 可见的那张正是 ' + th + ' 版 Logo', shown.map(s => s.t));
      const trOk = (function (t) {
        if (!t || t === 'none') return true;
        const m = t.match(/matrix\(([^)]+)\)/); if (!m) return false;
        const n = m[1].split(',').map(Number);
        return Math.abs(n[0] - 1) < 1e-3 && Math.abs(n[1]) < 1e-3 && Math.abs(n[2]) < 1e-3 && Math.abs(n[3] - 1) < 1e-3 && Math.abs(n[4]) < 0.5 && Math.abs(n[5]) < 0.5;
      })(shown[0] && shown[0].tr);
      ok(shown.length === 1 && trOk, '[' + NAME[th] + '] 可见 Logo 无残留位移/旋转（已归位）', shown[0] && shown[0].tr);
      ok(st.rect && st.rect.w >= 28 && st.rect.w <= 32, '[' + NAME[th] + '] Logo 容器尺寸仍是 30px 级', st.rect);

      // 裁一张 Logo 区域的大图，方便肉眼比对
      const r = st.rect || { x: 20, y: 20, w: 30, h: 30 };
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: r.x - 10, y: r.y - 10, width: r.w + 20, height: r.h + 20, scale: 8 } });
      const f = path.join(outDir, 'logo-' + th + '.png');
      fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
      console.log('    截图 → ' + path.relative(__dirname, f));
    }

    console.log('\n— 动态玻璃：背景视频 —');
    // 等视频真的能播（readyState>=2 = 已有当前帧数据）
    let vinfo = {};
    for (let i = 0; i < 50; i++) {
      vinfo = JSON.parse(await ev(`JSON.stringify((function(){
        var v=document.getElementById('bgVideo');
        if(!v) return {missing:true};
        var cs=getComputedStyle(v);
        return {src:v.getAttribute('src')||'',ready:v.readyState,paused:v.paused,ct:v.currentTime,
                dur:isFinite(v.duration)?v.duration:null,vw:v.videoWidth,vh:v.videoHeight,
                disp:cs.display,loop:v.loop,muted:v.muted,poster:v.getAttribute('poster')||'',
                filter:cs.filter,transform:cs.transform};
      })())`) || '{}');
      if (vinfo.ready >= 2 && vinfo.dur) break;
      await sleep(200);
    }
    ok(!vinfo.missing, '页面里有 #bgVideo 元素', vinfo);
    ok(/bg-dynamic\.mp4$/.test(vinfo.src || ''), 'src 已挂上 bg-dynamic.mp4（切到这套皮肤才加载）', vinfo.src);
    ok(vinfo.disp !== 'none', '动态玻璃下视频层是显示的', vinfo.disp);
    ok(vinfo.ready >= 2, '视频已解出可播数据（readyState≥2）', vinfo.ready);
    ok(vinfo.vw === 960 && vinfo.vh === 504, '视频分辨率 960×504（解码像素量是 1280×672 的 56%）', vinfo.vw + '×' + vinfo.vh);
    ok(vinfo.dur && vinfo.dur > 8 && vinfo.dur < 30, '循环时长合理（当前 13.27 秒 = 6.63 秒正放 + 倒放）', vinfo.dur);
    // 这条是给未来的自己踩的刹车：给 <video> 挂 filter:blur() 会让 Chrome 把视频帧读回 CPU
    // 去做模糊，破坏零拷贝叠加路径，实测 30fps 的片子只呈现得出 7fps（详见 probe-video-perf.js）。
    // 模糊必须在 ffmpeg 里烘进视频（gblur），浏览器侧一律不许再挂 filter / transform。
    ok(vinfo.filter === 'none', '视频层没挂 CSS filter（挂了会把帧读回 CPU，实测掉到 7fps）', vinfo.filter);
    ok(vinfo.transform === 'none', '视频层没挂 transform（单独一个 scale 也要吃 5fps）', vinfo.transform);
    // 视频的父容器也不能有 filter / 动画：theme-color.css 的 mtPhase 就是动画着
    // filter:brightness()/hue-rotate() 的，而视频在它里面，等于每帧对视频也重算一遍滤镜。
    const bgLayer = JSON.parse(await ev(`JSON.stringify((function(){
      var b=document.querySelector('.liquid-bg'); if(!b) return {};
      var cs=getComputedStyle(b), pb=getComputedStyle(b,'::before');
      return {filter:cs.filter, anim:cs.animationName, pbDisplay:pb.display};
    })())`));
    ok(bgLayer.filter === 'none', '视频的父容器没有 filter（挂上就等于每帧对视频重算滤镜）', bgLayer.filter);
    ok(bgLayer.anim === 'none', '视频的父容器没有在跑的动画（mtPhase 已掐掉）', bgLayer.anim);
    ok(bgLayer.pbDisplay === 'none', '横扫柔光 ::before 已关（被不透明视频完全压住，纯白烧）', bgLayer.pbDisplay);
    ok(vinfo.loop === true, 'loop 打开（自动无缝循环）', vinfo.loop);
    ok(vinfo.muted === true, 'muted 打开（否则浏览器禁止自动播放）', vinfo.muted);
    // 起播是**有门坎**的：syncBgVideo 会等 readyState≥4（整段缓冲够）才开始播，
    // 免得在隧道上「播几帧→缓冲→再播」看起来像掉帧。所以这里要等一会儿再判，不能立刻断言。
    let started = false;
    for (let i = 0; i < 40; i++) {
      started = await ev("(function(){var v=document.getElementById('bgVideo');return !v.paused})()");
      if (started) break;
      await sleep(200);
    }
    ok(started === true, '缓冲够之后自动开始播放（最多等 8 秒）', started);

    const t0 = await ev("document.getElementById('bgVideo').currentTime");
    await sleep(1600);
    const t1 = await ev("document.getElementById('bgVideo').currentTime");
    ok(t1 > t0 + 0.4, '画面在真的走（1.6 秒内 currentTime 前进 ' + (t1 - t0).toFixed(2) + 's）', { t0, t1 });

    const vReqs1 = reqs.filter(u => /bg-dynamic\.mp4/.test(u)).length;
    ok(vReqs1 >= 1, '视频文件确实被请求了 ' + vReqs1 + ' 次', vReqs1);

    // 切走 → 必须暂停，不能在背后空转解码
    await ev("(function(){var b=document.querySelector('.theme-item[data-t=\"glass\"]');if(b)b.click();})()");
    await sleep(500);
    ok(await ev("document.getElementById('bgVideo').paused") === true, '切回彩色毛玻璃后视频已暂停（不在后台空转）', null);
    ok(await ev("getComputedStyle(document.getElementById('bgVideo')).display") === 'none', '非动态玻璃下视频层是 display:none', null);

    // 切回 → 立刻续播，且不应重复下载
    await ev("(function(){var b=document.querySelector('.theme-item[data-t=\"motion\"]');if(b)b.click();})()");
    await sleep(700);
    ok(await ev("document.getElementById('bgVideo').paused") === false, '再切回动态玻璃能立刻续播', null);
    const vReqs2 = reqs.filter(u => /bg-dynamic\.mp4/.test(u)).length;
    ok(vReqs2 === vReqs1, '切回来没有重复下载视频（复用已加载的 src）', { before: vReqs1, after: vReqs2 });

    console.log('\n— 整页观感 —');
    for (const th of THEMES) {
      await ev("(function(){var b=document.querySelector('.theme-item[data-t=\"" + th + "\"]');if(b)b.click();})()");
      await sleep(700);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, 'theme-' + th + '.png'), Buffer.from(shot.data, 'base64'));
    }
    console.log('    整页截图 → probe-out/theme-<主题>.png');

    console.log('\n— 刷新后是否还记得 —');
    await ev("(function(){var b=document.querySelector('.theme-item[data-t=\"mist\"]');if(b)b.click();})()");
    await sleep(400);
    await send('Page.reload');
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev("document.documentElement.dataset.theme||''")) break; }
    await sleep(900);
    const after = JSON.parse(await ev(`JSON.stringify((function(){
      var arr=[].map.call(document.querySelectorAll('.brand-logo img'),function(i){return {t:i.getAttribute('data-t'),op:+getComputedStyle(i).opacity}});
      return {theme:document.documentElement.dataset.theme,items:arr};
    })())`) || '{}');
    ok(after.theme === 'mist', '刷新后主题仍是上次选的 mist', after.theme);
    const vis = (after.items || []).filter(i => i.op > .95).map(i => i.t);
    ok(vis.length === 1 && vis[0] === 'mist', '刷新后首屏直接就是 mist 版 Logo（没有先闪 glass）', vis);

    console.log('\n— 资源与报错 —');
    const svgBad = badReq.filter(u => /\.svg|ml-suite-mark/i.test(u));
    ok(svgBad.length === 0, '五个 Logo 文件请求无 404 / 无失败', svgBad);
    ok(badReq.length === 0, '整轮无失败请求', badReq);
    if (cancelReq.length) console.log('    · 另有 ' + cancelReq.length + ' 个被渲染进程主动取消的请求（多为视频 range 请求，正常）：' + cancelReq.join(' | '));
    ok(errors.length === 0, '无 console 报错 / 未捕获异常', errors);
  } catch (e) {
    fail++; console.log('  ✗ 探针跑挂了：' + e.message);
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    setTimeout(() => process.exit(fail ? 1 : 0), 300);
  }
})();
