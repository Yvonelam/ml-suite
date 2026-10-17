#!/usr/bin/env node
/**
 * 浏览器实测：取消单是否列出来 + 产品出单统计（带主图）+ 单量/件数口径
 * 用法：node probe-profit-products.js [from] [to]
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
const FROM = process.argv[2] || '2026-10-01';
const TO = process.argv[3] || '2026-10-17';
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
function apiGet(p, cookie) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: API, path: p, headers: { Cookie: 'ml_session=' + encodeURIComponent(cookie) } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(d.slice(0, 200))); } });
    }).on('error', rej);
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
  const api = await apiGet(`/api/ml/profit/orders?from=${FROM}&to=${TO}`, ck);
  if (!api.ok) { console.error('接口异常：' + JSON.stringify(api).slice(0, 300)); process.exit(1); }
  const T = api.totals, P = api.products || [];
  console.log('接口口径：全部 ' + T.allOrders + ' 单 / ' + T.units + ' 件 · 有效 ' + T.orders + ' 单 / ' + T.validUnits + ' 件 · 取消 ' + T.cancelledOrders + ' 单 / ' + T.cancelledUnits + ' 件');
  console.log('产品维度：' + P.length + ' 个 Listing · 件数合计 ' + P.reduce((s, p) => s + p.units, 0));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-pp-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1400', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const errors = [];
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
    });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    await sleep(1200);
    await ev("(function(){var a=document.querySelector('nav a[data-go=\"profit\"]');if(a)a.click();})()");
    await sleep(1800);
    await ev(`(function(){
      var f=document.getElementById('profitOrderFrom'),t=document.getElementById('profitOrderTo');
      f.value='${FROM}'; t.value='${TO}';
      f.dispatchEvent(new Event('change',{bubbles:true}));
      t.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('profitOrderRange').querySelectorAll('button').forEach(function(b){b.classList.toggle('on',b.dataset.range==='custom');});
      document.getElementById('profitOrderApply').click();
    })()`);
    console.log('已触发查询 ' + FROM + ' ~ ' + TO + '，等待渲染…');
    for (let i = 0; i < 90; i++) {
      const st = await ev("document.getElementById('profitOrderStatus').textContent");
      if (/平台共/.test(st) || /失败/.test(st)) break;
      await sleep(1000);
    }
    await sleep(2500);
    console.log('状态行：' + await ev("document.getElementById('profitOrderStatus').textContent"));

    // [1] 汇总卡
    console.log('\n[1] 汇总卡（单量 / 件数口径）');
    const tiles = JSON.parse(await ev(`(function(){return JSON.stringify([].map.call(document.querySelectorAll('#profitOrderSummary .profit-order-stat'),function(d){
      var sm=d.querySelectorAll('small');return {k:sm[0].textContent.trim(),v:d.querySelector('b').textContent.trim(),sub:sm[1]?sm[1].textContent.trim():''};
    }))})()`));
    for (const x of tiles) console.log('    ' + x.k + ' = ' + x.v + (x.sub ? '   (' + x.sub + ')' : ''));
    const g = (k) => { const f = tiles.find(x => x.k.indexOf(k) >= 0); return f ? f : null; };
    const numOf = (s) => Number(String(s || '0').replace(/[^\d.]/g, '')) || 0;
    ok(g('全部订单') && numOf(g('全部订单').v) === T.allOrders, '「全部订单」= ' + T.allOrders + ' 单（含取消）', g('全部订单'));
    ok(g('售出件数') && numOf(g('售出件数').v) === T.units, '「售出件数」= ' + T.units + ' 件（含取消）', g('售出件数'));
    ok(g('售出件数') && g('售出件数').sub.indexOf(String(T.validUnits)) >= 0, '售出件数副标题给出有效 ' + T.validUnits + ' 件', g('售出件数') && g('售出件数').sub);
    ok(g('全部订单') && T.cancelledOrders > 0 && g('全部订单').sub.indexOf(String(T.cancelledOrders)) >= 0, '全部订单副标题给出取消 ' + T.cancelledOrders + ' 单', g('全部订单') && g('全部订单').sub);
    ok(T.units === T.validUnits + T.cancelledUnits, '件数自洽：' + T.validUnits + ' + ' + T.cancelledUnits + ' = ' + T.units);

    // [2] 取消单是否真的列在表里
    console.log('\n[2] 取消 / 退款单是否列在订单表内');
    const dead = JSON.parse(await ev(`(function(){
      var trs=[].slice.call(document.querySelectorAll('#profitOrderRows tr'));
      var dead=trs.filter(function(t){return t.classList.contains('dead')});
      return JSON.stringify({total:trs.length,dead:dead.length,
        badge:dead.filter(function(t){return /已取消/.test(t.textContent)}).length,
        strike:dead.filter(function(t){return !!t.querySelector('.profit-order-title')}).length,
        sample:dead[0]?dead[0].textContent.replace(/\\s+/g,' ').trim().slice(0,120):''});
    })()`));
    console.log('    表格行 ' + dead.total + ' · 置灰行 ' + dead.dead + ' · 带徽章 ' + dead.badge);
    console.log('    样例：' + dead.sample);
    ok(dead.total === api.orders.length, '表格行数 = 接口返回行数 ' + api.orders.length, dead.total);
    ok(dead.dead === T.cancelledOrders, '置灰的取消行数 = ' + T.cancelledOrders, dead.dead);
    ok(dead.badge === dead.dead && dead.dead > 0, '每个取消行都有「已取消」徽章');
    ok(/已取消/.test(dead.sample), '取消行利润格显示「已取消」而不是金额', dead.sample);

    // [3] 产品出单统计
    console.log('\n[3] 产品出单统计（带图片）');
    const pp = JSON.parse(await ev(`(function(){
      var box=document.getElementById('profitProducts');
      if(!box||box.hidden)return JSON.stringify({hidden:true});
      var cards=[].slice.call(box.querySelectorAll('.pp-card'));
      var imgs=cards.map(function(c){var i=c.querySelector('img.pp-img');return i?(i.getAttribute('src')||''):''});
      var loaded=cards.filter(function(c){var i=c.querySelector('img.pp-img');return i&&i.complete&&i.naturalWidth>0}).length;
      var units=cards.map(function(c){var u=c.querySelector('.pp-units b');return u?Number(u.textContent.replace(/[^\\d]/g,'')):0});
      var profits=cards.map(function(c){var p=c.querySelector('.pp-profit');return p?Number(p.textContent.replace(/[^\\d.\\-]/g,'')):0});
      return JSON.stringify({hidden:false,cards:cards.length,
        withImg:imgs.filter(function(s){return /^https:\\/\\//.test(s)}).length,loaded:loaded,
        unitsSum:units.reduce(function(a,b){return a+b},0),
        profitSum:Math.round(profits.reduce(function(a,b){return a+b},0)*100)/100,
        first:(cards[0]?cards[0].textContent.replace(/\\s+/g,' ').trim().slice(0,110):''),
        head:box.querySelector('.pp-head p')?box.querySelector('.pp-head p').textContent.replace(/\\s+/g,' ').trim():''});
    })()`));
    console.log('    卡片 ' + pp.cards + ' 个 · 有 https 图 ' + pp.withImg + ' · 实际加载成功 ' + pp.loaded);
    console.log('    首卡：' + pp.first);
    console.log('    说明：' + pp.head);
    ok(!pp.hidden, '产品出单统计区块可见');
    ok(pp.cards === P.length, '卡片数 = 接口产品数 ' + P.length, pp.cards);
    ok(pp.withImg === pp.cards, '每张卡片都有 https 主图', { withImg: pp.withImg, cards: pp.cards });
    ok(pp.loaded >= Math.ceil(pp.cards * 0.6), '至少 60% 主图真实加载成功（' + pp.loaded + '/' + pp.cards + '）');
    ok(pp.unitsSum === T.validUnits, '产品件数合计 = 有效件数 ' + T.validUnits, pp.unitsSum);
    ok(Math.abs(pp.profitSum - T.profitCny) < 1, '产品利润合计 ≈ 订单利润合计 ' + T.profitCny, pp.profitSum);
    ok(/有效/.test(pp.head) && pp.head.indexOf(String(T.validUnits)) >= 0, '区块说明给出有效件数');
    ok(/取消|退款/.test(pp.head) || T.cancelledUnits === 0, '区块说明标出取消 / 退款件数');

    // [4] console
    console.log('\n[4] 控制台');
    const real = errors.filter(e => !/favicon|net::ERR|Failed to load resource/i.test(e));
    console.log('    错误 ' + real.length + (real.length ? '：' + real.slice(0, 3).join(' | ') : ''));
    ok(real.length === 0, '无控制台错误', real.slice(0, 3));

    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    await ev("(function(){var b=document.getElementById('profitProducts');if(b)b.scrollIntoView({block:'start'});})()");
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'shots', 'profit-products.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n  📷 ' + path.join(__dirname, 'shots', 'profit-products.png'));
  } catch (e) {
    fail++;
    console.log('  ✗ 异常：' + e.message);
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
    console.log('\n================ 结果：' + pass + ' 通过 / ' + fail + ' 失败 ================');
    process.exit(fail ? 1 : 0);
  }
})();
