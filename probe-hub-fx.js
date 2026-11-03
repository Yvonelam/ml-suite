#!/usr/bin/env node
/*
 * 概览页「利润核算汇率」探针（只读，不点任何写操作）
 *
 * 盯四件事：
 *  1. 区间条上真的渲染出汇率胶囊，格式是「100 BRL = ¥131.20」这种（每 100 当地币折合人民币）
 *  2. 渲染出来的数字与 /api/ml/profit/orders?summary=1 返回的 fx 逐币种完全一致
 *     （界面显示的和算利润时用的是同一个 rates 对象，不能各说各话）
 *  3. 只显示订单里真实出现的币种，不能把表里所有币种都摆上来
 *  4. 点「本月」后区间变成当月 1 号 → 今天，汇率跟着重算而不是留着上一档
 *
 * 用法：node probe-hub-fx.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9377;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const dev = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8')); } catch { return {}; } })();

function login() {
  const body = Buffer.from(JSON.stringify({ username: process.env.ML_ADMIN_USER || dev.username, password: process.env.ML_ADMIN_PASSWORD || dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

let pass = 0, fail = 0;
const ok = (cond, label, extra) => { cond ? pass++ : fail++; console.log('  ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? ' · ' + extra : '')); };

(async () => {
  if (!browser) { console.error('找不到 Chrome/Edge'); process.exit(1); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-hubfx-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1000', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map(); const errors = [];
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(m + ' timeout')); } }, 200000); }); };
  const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;

  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    if (!t) throw new Error('浏览器没起来');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160));
    });
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: await login(), url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");

    const readFx = () => ev(`(function(){var n=document.getElementById('hubFxNote');if(!n)return JSON.stringify({missing:true});
      var chips=[].slice.call(n.querySelectorAll('.hub-fx-chip')).map(function(c){return {text:c.textContent.replace(/\\s+/g,' ').trim(),title:c.getAttribute('title')||''};});
      return JSON.stringify({missing:false,text:n.textContent.replace(/\\s+/g,' ').trim(),src:(n.querySelector('.hub-fx-src')||{}).textContent||'',chips:chips,
        from:(document.getElementById('hubFrom')||{}).value,to:(document.getElementById('hubTo')||{}).value,
        monthOn:!!(document.querySelector('#hubRange button[data-range=month]')||{}).classList&&document.querySelector('#hubRange button[data-range=month]').classList.contains('on')});})()`);

    console.log('--- 1. 默认区间（今天）渲染汇率 ---');
    let s = null;
    for (let i = 0; i < 60; i++) { // 订单抓取 + 汇率读取可能要几十秒
      s = JSON.parse(await readFx() || '{}');
      if (s.chips && s.chips.length) break;
      await sleep(2000);
    }
    ok(!s.missing, '区间条上有 #hubFxNote 容器');
    ok((s.chips || []).length > 0, '渲染出汇率胶囊', (s.chips || []).map(c => c.text).join(' | ') || s.text);
    const parsed = (s.chips || []).map(c => {
      const m = /^100\s+([A-Z]{3})\s*=\s*¥\s*([\d.,]+)$/.exec(c.text);
      return m ? { code: m[1], cnyPer100: Number(m[2].replace(/,/g, '')) } : null;
    });
    ok(parsed.length === (s.chips || []).length && parsed.every(Boolean), '全部胶囊都是「100 币种 = ¥数值」格式');
    ok((s.chips || []).every(c => /中国银行/.test(c.title)), '胶囊 title 标注了「中国银行」牌价来源');
    ok(!parsed.some(x => x && x.code === 'CNY'), '没有把人民币自己列出来');

    console.log('\n--- 2. 与接口 fx 逐币种一致 ---');
    const api = JSON.parse(await ev(`fetch('/api/ml/profit/orders?summary=1&from=${s.from}&to=${s.to}',{cache:'no-store'}).then(r=>r.json()).then(d=>JSON.stringify(d.fx||{}))`) || '{}');
    const apiRows = Object.entries(api).map(([code, v]) => ({ code, cnyPer100: Math.round(Number(v.cnyPer100) * 100) / 100 }));
    ok(apiRows.length === parsed.length, '币种数量与接口一致', '界面 ' + parsed.length + ' / 接口 ' + apiRows.length);
    for (const row of apiRows) {
      const shown = parsed.find(x => x && x.code === row.code);
      ok(!!shown, '接口币种 ' + row.code + ' 在界面上有对应胶囊');
      if (shown) ok(Math.abs(shown.cnyPer100 - row.cnyPer100) < 0.011, row.code + ' 汇率数值一致', '界面 ' + shown.cnyPer100 + ' / 接口 ' + row.cnyPer100);
    }

    console.log('\n--- 3. 切「本月」后重算 ---');
    await ev("(function(){var b=document.querySelector('#hubRange button[data-range=month]');if(b)b.click();})()");
    await sleep(1500);
    s = JSON.parse(await readFx() || '{}');
    const today = await ev("brToday()");
    ok(s.from === today.slice(0, 8) + '01', '区间起点变成当月 1 号', s.from);
    ok(s.to === today, '区间终点是今天（巴西时间）', s.to);
    let monthChips = s.chips || [];
    for (let i = 0; i < 75 && !monthChips.length; i++) { await sleep(2000); s = JSON.parse(await readFx() || '{}'); monthChips = s.chips || []; }
    ok(monthChips.length > 0, '本月区间也渲染出汇率', monthChips.map(c => c.text).join(' | ') || s.text);
    ok(monthChips.every(c => !/上一档|—/.test(c.text)), '没有残留上一档的占位');

    const sh = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(__dirname, 'probe-out', 'hub-fx.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(sh.data, 'base64'));
    console.log('\n📷 ' + out);

    console.log('\n--- 4. 控制台 ---');
    const realErr = errors.filter(e => !/favicon/i.test(e));
    ok(realErr.length === 0, '无 console 报错', realErr.slice(0, 3).join(' / '));

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    try { child.kill(); } catch (x) { }
    process.exit(fail ? 1 : 0);
  } catch (e) { console.error('FAIL ' + e.message); try { child.kill(); } catch (x) { } process.exit(1); }
})();
