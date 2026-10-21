#!/usr/bin/env node
/**
 * 浏览器实测：四套美术风格下侧边栏 Logo 是否各自换成对应版本
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
const THEMES = ['classic', 'mist', 'glass', 'gold'];
const NAME = { classic: '经典深色', mist: '柔雾玻璃', glass: '彩色毛玻璃', gold: '典藏金' };

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
  const errors = [], badReq = [];
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
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        if (r.status >= 400) badReq.push(r.status + ' ' + r.url);
      }
      if (m.method === 'Network.loadingFailed') badReq.push('FAILED ' + (m.params.errorText || '') + ' ' + (m.params.type || ''));
    });
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    await sleep(1500);

    console.log('\n— 结构 —');
    const imgs = await ev("JSON.stringify([].map.call(document.querySelectorAll('.brand-logo img'),function(i){return {t:i.getAttribute('data-t'),src:i.getAttribute('src')}}))");
    const list = JSON.parse(imgs || '[]');
    ok(list.length === 4, '侧边栏 Logo 挂了 4 张（每套主题一张）', list);
    ok(THEMES.every(t => list.some(x => x.t === t)), '四套主题 key 都在 DOM 里：classic / mist / glass / gold', list.map(x => x.t));
    ok(new Set(list.map(x => x.src)).size === 4, '四张指向四个不同文件', list.map(x => x.src));

    console.log('\n— 四张是否都真的加载成功（预载）—');
    const nat = JSON.parse(await ev("JSON.stringify([].map.call(document.querySelectorAll('.brand-logo img'),function(i){return {t:i.getAttribute('data-t'),w:i.naturalWidth,h:i.naturalHeight}}))") || '[]');
    nat.forEach(n => ok(n.w > 0, 'Logo 资源已解码：' + n.t + ' (' + n.w + '×' + n.h + ')', n));

    console.log('\n— 逐套切换（真实点击 Logo → 点菜单项）—');
    for (const th of THEMES) {
      await ev("document.getElementById('brandLogo').click()");
      await sleep(260);
      const opened = await ev("!document.getElementById('themeMenu').hidden");
      if (th === 'classic') ok(opened, '点侧边栏 Logo 能弹出风格菜单', opened);
      await ev("(function(){var b=document.querySelector('.theme-item[data-t=\"" + th + "\"]');if(b)b.click();})()");
      // 等过渡真正落定：必须「恰好一张 op≈1、其余 op≈0、可见那张 transform≈单位矩阵」。
      // 只睡固定毫秒不可靠（机器忙时差最后几毫秒），只判断「没有正在动的图」又会在
      // 交叉淡入过程中提前放行 —— 两头都会造成误判。
      const settledExpr = `(function(){
        var arr=[].map.call(document.querySelectorAll('.brand-logo img'),function(i){
          var cs=getComputedStyle(i);
          return {o:parseFloat(cs.opacity),t:cs.transform};
        });
        var hi=arr.filter(function(a){return a.o>=.995});
        var lo=arr.filter(function(a){return a.o<=.005});
        if(hi.length!==1||lo.length!==arr.length-1)return false;
        var t=hi[0].t;
        if(t==='none')return true;
        var m=t.match(/matrix\\(([^)]+)\\)/); if(!m)return false;
        var n=m[1].split(',').map(Number);
        return Math.abs(n[0]-1)<1e-3&&Math.abs(n[1])<1e-3&&Math.abs(n[2])<1e-3&&Math.abs(n[3]-1)<1e-3&&Math.abs(n[4])<.5&&Math.abs(n[5])<.5;
      })()`;
      for (let k = 0; k < 40; k++) { if (await ev(settledExpr)) break; await sleep(100); }
      await sleep(80);

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
    ok(svgBad.length === 0, '四个 Logo 文件请求无 404 / 无失败', svgBad);
    ok(badReq.length === 0, '整轮无失败请求', badReq);
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
