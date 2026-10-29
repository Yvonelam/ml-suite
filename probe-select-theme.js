#!/usr/bin/env node
/**
 * 原生控件的深色适配回归：<select> 弹层 / option、日期选择器。
 *
 * 为什么需要它：原生下拉弹层由操作系统绘制，CDP 的 Page.captureScreenshot 截不到，
 * 只能靠「计算样式」断言 —— 背景够不够暗、文字够不够亮、对比度够不够。
 * 2026-10-29 的「选页这里反白，什么都看不清」就是 option 没有背景色导致的。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DBG = 9396;
const HOST = 'http://127.0.0.1:3000';
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data/dev-login.json'), 'utf8'));
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: 3000, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { s.resume(); s.on('end', () => { const c = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); c ? res(decodeURIComponent(c.split(';')[0].slice(11))) : rej(new Error('登录失败')); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + '   → ' + JSON.stringify(extra)); } };

// 在页面里跑：读 option 的计算样式并算对比度
// 注意要扫「所有」option，不能只看第一个 —— 第一个通常就是当前选中项，:checked 的配色
// 和普通项不一样，只看它会漏掉普通项白底白字的老问题。
const READ = `(() => {
  const sels = [...document.querySelectorAll('select')];
  const out = [];
  for (const sel of sels) {
    const opts = [...sel.querySelectorAll('option')];
    if (!opts.length) continue;
    const worst = [];
    for (const opt of opts) {
      const so = getComputedStyle(opt);
      worst.push({ bg: so.backgroundColor, fg: so.color, contrast: __ct(so.backgroundColor, so.color), checked: opt.selected, text: (opt.textContent || '').trim().slice(0, 12) });
    }
    out.push({
      id: sel.id || '(无 id)',
      scheme: getComputedStyle(sel).colorScheme,
      opts: worst,
    });
  }
  return out;
})()`;
// 相对亮度 + 对比度（WCAG）
const CONTRAST = `(function(bg, fg){
  const p = s => { const m = s.match(/[\\d.]+/g); if (!m) return null;
    return m.slice(0,3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }); };
  const lum = a => a ? 0.2126*a[0] + 0.7152*a[1] + 0.0722*a[2] : null;
  const b = lum(p(bg)), f = lum(p(fg));
  if (b === null || f === null) return 0;
  const hi = Math.max(b,f), lo = Math.min(b,f);
  return Math.round(((hi+0.05)/(lo+0.05)) * 100) / 100;
})`;

(async () => {
  if (!BROWSERS.length) throw new Error('找不到 Chrome');
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-sel-'));
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1280,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 60; i++) { if (await ev('typeof go === "function"')) break; await sleep(200); }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');return true})()");
    // 对比度函数装进页面，避免每个 option 一次 CDP 往返（9 个 select × 8 个选项 × 5 主题）
    await ev('window.__ct = ' + CONTRAST + '; true');

    // 把带 select 的视图都渲染出来，确保 querySelectorAll('select') 能拿到全部
    for (const v of ['rank', 'hub', 'profit']) { await ev(`go('${v}'); true`); await sleep(600); }

    const themes = [
      ['classic', '经典深色（全关）'],
      ['mist', '柔雾玻璃'],
      ['glass', '彩色毛玻璃'],
      ['gold', '典藏金'],
      ['motion', '动态玻璃'],
    ];

    for (const [key, label] of themes) {
      // 函数名是 applyTheme（主题 = 四张可开关的样式表），不是 setTheme
      await ev(`applyTheme('${key}'); true`);
      await sleep(500);
      const rows = await ev(READ);
      console.log('\n=== 主题 ' + key + '（' + label + '）· ' + rows.length + ' 个 select ===');
      if (!rows.length) { ok(false, '页面上找不到 select'); continue; }
      // rgba 解构后的首通道：用来判定「底色够不够暗」，半透明会透白所以浅色一律不合格
      const isDark = bg => {
        const m = String(bg).match(/[\d.]+/g);
        if (!m) return false;
        const [r, g, b] = m.slice(0, 3).map(Number);
        return Math.max(r, g, b) <= 130;
      };
      let bad = 0, total = 0;
      for (const r of rows) {
        for (const o of r.opts) {
          total++;
          const good = o.contrast >= 4.5 && isDark(o.bg);
          if (!good) {
            bad++;
            console.log('    ✗ ' + r.id + (o.checked ? '(选中项)' : '') + '  ' + JSON.stringify(o.text) + '  bg=' + o.bg + '  fg=' + o.fg + '  对比度=' + o.contrast);
          }
        }
      }
      ok(bad === 0, label + '：' + total + ' 个 option 全是深底浅字（对比度 ≥ 4.5、底色够暗）', bad + ' 个不合格');
      // color-scheme 必须让原生弹层走深色
      const schemes = [...new Set(rows.map(r => r.scheme))];
      ok(schemes.length === 1 && /dark/.test(schemes[0]), label + '：select 的 color-scheme = dark', schemes);
    }

    // 日期选择器
    await ev("applyTheme('classic'); true"); await sleep(300);
    await ev("go('profit'); true"); await sleep(700);
    const dateScheme = await ev(`(() => { const d = document.querySelector('input[type=date]'); return d ? getComputedStyle(d).colorScheme : '(没有日期输入)'; })()`);
    ok(/dark/.test(dateScheme), '日期输入框的 color-scheme = dark（日历弹层不再白底）', dateScheme);

    // 截图：select 收起状态（弹层截不到，至少确认没坏）
    await ev("go('rank'); true"); await sleep(700);
    const shot = await Promise.race([send('Page.captureScreenshot', { format: 'png', fromSurface: true }), sleep(20000).then(() => { throw new Error('截图超时'); })]);
    const f = path.join(__dirname, 'probe-out', 'select-theme.png');
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (e) { }
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log('\n截图（select 收起态）：' + f);

    console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
