#!/usr/bin/env node
/**
 * 日期显示时区回归：fmtDate / brParts 在「本机=中国(+08)、目标=巴西(-03)」下的行为。
 * 这类错最隐蔽 —— 只有跨时区的日期才差一天，肉眼看板很难发现。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DBG = 9395;
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

(async () => {
  if (!BROWSERS.length) throw new Error('找不到 Chrome');
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-tz-'));
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
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 60; i++) { if (await ev('typeof fmtDate === "function"')) break; await sleep(200); }

    const tz = await ev('Intl.DateTimeFormat().resolvedOptions().timeZone');
    console.log('浏览器本机时区: ' + tz + '（目标时区固定 America/Sao_Paulo）\n');

    console.log('=== 1. 纯日期不能被 new Date() 拉去 UTC ===');
    for (const s of ['2026-10-27', '2026-01-01', '2026-12-31']) {
      const got = await ev(`fmtDate(${JSON.stringify(s)})`);
      ok(got === s, 'fmtDate("' + s + '") = "' + s + '"（不是前一天）', got);
    }

    console.log('\n=== 2. 带偏移的时间按偏移换算 ===');
    const cases2 = [
      ['2026-10-27T12:00:00.000-03:00', '2026-10-27 12:00'],
      ['2026-10-27T15:00:00.000Z', '2026-10-27 12:00'],
      ['2026-10-27T00:30:00.000-03:00', '2026-10-27 00:30'],
      ['2026-10-27T23:50:00.000-03:00', '2026-10-27 23:50'],
    ];
    for (const [inp, want] of cases2) {
      const got = await ev(`fmtDate(${JSON.stringify(inp)})`);
      ok(got === want, JSON.stringify(inp) + ' → ' + want, got);
    }

    console.log('\n=== 3. 无时区标记的，按巴西时间理解（不按本机 +08 再减 11 小时）===');
    for (const [inp, want] of [
      ['2026-10-27T12:00:00', '2026-10-27 12:00'],
      ['2026-10-27 09:15:00', '2026-10-27 09:15'],
    ]) {
      const got = await ev(`fmtDate(${JSON.stringify(inp)})`);
      ok(got === want, JSON.stringify(inp) + ' → ' + want, got);
    }

    console.log('\n=== 4. 脏输入不炸 ===');
    for (const [inp, want] of [['', '-'], [null, '-'], [undefined, '-'], ['不是日期', '不是日期']]) {
      const got = await ev(`fmtDate(${JSON.stringify(inp === undefined ? null : inp)})`);
      const expect = inp === undefined ? '-' : want;
      ok(got === expect, 'fmtDate(' + JSON.stringify(inp) + ') = ' + JSON.stringify(expect), got);
    }

    console.log('\n=== 5. 真实视图切一圈，确认没把页面搞崩 ===');
    let thrown = 0;
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.method === 'Runtime.exceptionThrown') thrown++;
    });
    await send('Runtime.enable');
    for (const v of ['questions', 'claims', 'hub', 'orders']) {
      await ev(`go('${v}'); true`);
      await sleep(800);
    }
    ok(thrown === 0, '切 4 个视图无未捕获异常', thrown);

    console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
