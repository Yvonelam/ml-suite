#!/usr/bin/env node
/*
 * 多关键词批量查询探针（只读）
 *
 * 盯：
 *  1. 「多关键词」页签能打开，输入 2 个关键词 + 2 个目标标题能真跑完（每词 1 页，省时间）
 *  2. 汇总表行数 = 关键词数（站点单一时），总结果数/已扫描/首位商品都填了
 *  3. 排名矩阵列数 = 2 目标 + 站点 + 关键词；命中显示数字排名，未命中必须显示「未进前 N 页」
 *  4. 「前 5 名」折叠表有行
 *  5. 两个导出按钮都真的产出 CSV（带 BOM、行数、表头），矩阵 CSV 表头带目标标题
 *  6. 全程无 console 报错
 *
 * 用法：node probe-multi-keyword.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9387;
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
  const dir = require('./cdp-tmp').profileDir('ml-multi-');
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1200', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map(); const errors = [];
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(m + ' timeout')); } }, 240000); }); };
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
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: await login(), url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#rank' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
    await ev("(function(){var a=document.querySelector('nav a[data-go=\"rank\"]');if(a)a.click();})()");
    await sleep(500);

    console.log('--- 1. 页签与输入 ---');
    // app.js 是同步加载的大文件，页签的 onclick 绑在最外层，初始化没走完时点一下会被吞掉
    // （表现为面板一直 display:none，后面所有断言却都能过，因为输入框在 DOM 里照样能拿到值）。
    // 所以这里重试到真的切过去为止，最多等 6 秒。
    let panelShown = false;
    for (let i = 0; i < 30 && !panelShown; i++) {
      await ev("(function(){var b=document.querySelector('#v-rank .tabs button[data-m=\"m\"]');if(b)b.click();})()");
      await sleep(200);
      panelShown = await ev("(function(){var p=document.getElementById('rank-multi');return !!p && getComputedStyle(p).display!=='none';})()");
    }
    ok(panelShown === true, '「多关键词」面板可见');
    ok((await ev("!!document.getElementById('mkw') && !!document.getElementById('mt') && !!document.getElementById('mgo')")), '关键词框 / 目标框 / 开始按钮都在');

    // 只选 MLM、1 页，输入 2 个关键词 + 2 个目标（一个必然命中、一个必然不命中）
    await ev("(function(){document.getElementById('mSiteMLM').checked=true;document.getElementById('mSiteMLB').checked=false;document.getElementById('mSiteMLA').checked=false;document.getElementById('mpg').value='1';" +
      "var k=document.getElementById('mkw');k.value='headset gamer\\nfone bluetooth';k.dispatchEvent(new Event('input',{bubbles:true}));" +
      "var t=document.getElementById('mt');t.value='gamer\\nzzzznotexistkeyword';t.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await sleep(300);
    const cnt = JSON.parse(await ev("JSON.stringify({k:document.getElementById('mkw-count').textContent,t:document.getElementById('mt-count').textContent,note:document.getElementById('mProgNote').textContent})") || '{}');
    ok(cnt.k === '2' && cnt.t === '2', '关键词/目标计数正确', cnt.k + ' / ' + cnt.t);
    ok(/将执行 2 次查询/.test(cnt.note || ''), '预估提示给出执行次数', String(cnt.note).slice(0, 40));

    console.log('\n--- 2. 真跑（每词 1 页，约 15-25 秒）---');
    await ev("document.getElementById('mgo').click()");
    let visible = false;
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      visible = await ev("(function(){var e=document.getElementById('multiRes');return !!e && getComputedStyle(e).display!=='none';})()");
      if (visible) break;
    }
    ok(visible === true, '查询跑完并渲染结果');
    const sum = JSON.parse(await ev("JSON.stringify({rows:document.querySelectorAll('#multiTable tbody tr').length,mrows:document.querySelectorAll('#multiMatrix tbody tr').length,mhead:document.querySelectorAll('#multiMatrix thead th').length,heads:[].slice.call(document.querySelectorAll('#multiTable thead th')).map(function(x){return x.textContent})})") || '{}');
    ok(sum.rows === 2, '汇总表 2 行（2 个关键词）', 'rows=' + sum.rows);
    ok(sum.mhead === 4 && sum.mrows === 2, '矩阵 = 2 行 × (站点+关键词+2 目标)', 'head=' + sum.mhead + ' rows=' + sum.mrows);

    const matrix = await ev("(function(){var tds=[].slice.call(document.querySelectorAll('#multiMatrix tbody td'));return tds.map(function(t){return t.textContent.trim()}).join('|')})()");
    ok(/未进前\s*1\s*页/.test(matrix || ''), '不存在的目标显示「未进前 N 页」');
    ok(/\d+\s*P\d+·\d+/.test((matrix || '').replace(/\s+/g, ' ')), '命中的目标显示「总排名 P页码·位次」');

    const topRows = await ev("document.querySelectorAll('#multiTopTable tbody tr').length");
    ok(topRows > 0, '「前 5 名」折叠表有行', 'rows=' + topRows);
    const cellFilled = await ev("(function(){var tr=document.querySelector('#multiTable tbody tr');if(!tr)return '';var tds=tr.querySelectorAll('td');return [tds[2].textContent,tds[3].textContent,tds[6].textContent].join(' / ');})()");
    ok(/\d/.test(String(cellFilled)), '总结果数/已扫描/首位商品已填', String(cellFilled).slice(0, 60));

    console.log('\n--- 3. 导出 ---');
    await ev("(function(){window.__csv=null;window.__csvBom=null;var old=URL.createObjectURL;URL.createObjectURL=function(b){var r=new FileReader();r.onload=function(){var u=new Uint8Array(r.result);window.__csvBom=[u[0],u[1],u[2]];window.__csv=new TextDecoder('utf-8',{ignoreBOM:true}).decode(u);};r.readAsArrayBuffer(b);return old.call(URL,b)};})()");
    await ev("document.getElementById('multiExport').click()");
    let csv = null;
    for (let i = 0; i < 20; i++) { csv = await ev('window.__csv'); if (csv) break; await sleep(300); }
    const clean = String(csv || '').replace(/^\uFEFF/, '');
    const lines = clean.split(/\r?\n/).filter(Boolean);
    ok(!!csv, '汇总 CSV 已产出');
    ok(lines.length === 3, '汇总 CSV = 表头 + 2 行', 'lines=' + lines.length);
    ok(/站点/.test(lines[0]) && /关键词/.test(lines[0]), '汇总 CSV 表头正确', (lines[0] || '').slice(0, 50));

    await ev("window.__csv=null");
    await ev("document.getElementById('multiExportMatrix').click()");
    let csv2 = null;
    for (let i = 0; i < 20; i++) { csv2 = await ev('window.__csv'); if (csv2) break; await sleep(300); }
    const l2 = String(csv2 || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    ok(!!csv2 && l2.length === 3, '矩阵 CSV = 表头 + 2 行', 'lines=' + l2.length);
    ok(/gamer/.test(l2[0] || '') && /zzzznotexistkeyword/.test(l2[0] || ''), '矩阵 CSV 表头含目标标题', (l2[0] || '').slice(0, 60));

    const sh = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const out = path.join(__dirname, 'probe-out', 'multi-keyword.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(sh.data, 'base64'));
    console.log('\n📷 ' + out);

    console.log('\n--- 4. 控制台 ---');
    const real = errors.filter(e => !/favicon/i.test(e));
    ok(real.length === 0, '无 console 报错', real.slice(0, 2).join(' | '));
  } catch (e) {
    fail++;
    console.log('  ❌ 探针异常：' + e.message);
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  }
})();
