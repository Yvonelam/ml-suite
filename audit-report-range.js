#!/usr/bin/env node
/*
 * 指定日期区间 → 真的把利润报表导出来（HTML / PDF / Excel / CSV 四份）
 *
 * 为什么不直接用 probe-profit-report.js 的产物：那个探针为了跑得快固定用「近 7 天」，
 * 拿它的产物去对后台「近 30 天 / 本月」的数字，一定对不上（7 天 400 多件 vs 30 天 1500 件）。
 * 需要一份「和后台同区间」的表时用这个。
 *
 * 用法：
 *   node audit-report-range.js 2026-10-28 2026-11-27
 *   node audit-report-range.js 2026-11-01 2026-11-27      # 本月
 *
 * 产物：probe-out/report-<from>_<to>.{html,pdf,xlsx,csv}
 * 同时打印页面上的件数/单数/利润，以及「有效件数 + 取消件数 = 后台件数」的对账行。
 * ⚠ 只读：只点「下载」，不写账号任何数据。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const DBG = 9411;
const FROM = process.argv[2] || '';
const TO = process.argv[3] || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } });
const dev = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8')); } catch { return {}; } })();

function login() {
  const body = Buffer.from(JSON.stringify({ username: process.env.ML_ADMIN_USER || dev.username, password: process.env.ML_ADMIN_PASSWORD || dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}

(async () => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
    console.error('用法：node audit-report-range.js 2026-10-28 2026-11-27'); process.exit(1);
  }
  if (!browser) { console.error('找不到 Chrome / Edge'); process.exit(1); }
  const outDir = path.join(__dirname, 'probe-out');
  fs.mkdirSync(outDir, { recursive: true });
  const base = 'report-' + FROM + '_' + TO;
  const dir = require('./cdp-tmp').profileDir('ml-rpt-');
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1200', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(m + ' timeout')); } }, 60000); }); };
  // 页面里抛异常时 Runtime.evaluate 只回一个没有 value 的 result，光看 undefined 完全查不出原因
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) {
      const desc = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '';
      console.log('  ⚠ 页面求值报错：' + String(desc).split('\n')[0].slice(0, 200));
      return undefined;
    }
    return r && r.result ? r.result.value : undefined;
  };
  const waitJson = async url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await waitJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    if (!t) throw new Error('浏览器没起来');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    const ck = await login();
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#profit' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
    for (let i = 0; i < 40; i++) {
      await ev("(function(){var a=document.querySelector('nav a[data-go=\"profit\"]');if(a)a.click();})()");
      await sleep(200);
      if (await ev("(function(){var v=document.getElementById('v-profit');return !!v && getComputedStyle(v).display!=='none';})()")) break;
    }
    console.log('区间 ' + FROM + ' ~ ' + TO + '：正在拉订单并算利润…');
    // 页面进来会自己先加载一次「当天」。那一次请求可能比我们的晚回来，把区间覆盖回今天，
    // 所以设完日期要**反复确认 lastProfitOrderData.range 真的变成目标区间**，不成就再点一次。
    let ready = false;
    for (let attempt = 0; attempt < 6 && !ready; attempt++) {
      await ev("(function(){var f=document.getElementById('profitOrderFrom'),t=document.getElementById('profitOrderTo'),b=document.getElementById('profitOrderApply');" +
        "f.value=" + JSON.stringify(FROM) + ";t.value=" + JSON.stringify(TO) + ";b.click();})()");
      for (let i = 0; i < 45; i++) {
        const st = await ev("(function(){var d=(typeof lastProfitOrderData!=='undefined'?lastProfitOrderData:null);if(!d||!d.range||!d.range.from)return '';return d.range.from+'|'+d.range.to+'|'+((d.series||[]).length)})()") || '';
        const parts = st.split('|');
        if (parts[0] === FROM && parts[1] === TO && Number(parts[2]) > 0) { ready = true; break; }
        await sleep(1000);
      }
    }
    if (!ready) {
      const st = await ev("(function(){var e=document.getElementById('profitOrderStatus');return e?e.textContent:''})()");
      throw new Error('等不到 ' + FROM + '~' + TO + ' 的数据：' + String(st || '').slice(0, 200));
    }
    // 取的每个数都要能对上：系列合计、卡片合计、Listing 合计、totals 三方互相咬死
    const READ_EXPR = [
      '(function(){',
      ' var d=(typeof lastProfitOrderData!=="undefined"?lastProfitOrderData:null);',
      ' if(!d) return "{}";',
      ' var S=d.series||[], P=d.products||[], T=d.totals||{};',
      ' var s=function(a,k){return a.reduce(function(x,y){return x+(Number(y[k])||0)},0)};',
      ' var cardEls=document.querySelectorAll("#profitProducts .pp-card");',
      ' var cardUnits=[].slice.call(document.querySelectorAll("#profitProducts .pp-units b")).reduce(function(a,b){return a+Number(String(b.textContent).replace(/[^0-9]/g,""))},0);',
      ' return JSON.stringify({',
      '  range:d.range, apiTotal:d.apiTotal, pulled:d.pulled,',
      '  series:S.length, listings:P.length, lines:(d.orders||[]).length,',
      '  noSeries:(d.orders||[]).filter(function(x){return !x.series}).length,',
      '  totals:T,',
      '  sumSeriesUnits:s(S,"units"), sumSeriesCancelled:s(S,"cancelledUnits"), sumSeriesOrders:s(S,"orders"),',
      '  sumSeriesProfit:Math.round(s(S,"profitCny")*100)/100,',
      '  sumProdUnits:s(P,"units"), sumProdCancelled:s(P,"cancelledUnits"), sumProdProfit:Math.round(s(P,"profitCny")*100)/100,',
      '  cards:cardEls.length, cardUnits:cardUnits',
      ' });',
      '})()',
    ].join('\n');
    try { new Function(READ_EXPR); } catch (e) { throw new Error('取数表达式有语法错误：' + e.message); }
    const d = JSON.parse(await ev(READ_EXPR) || '{}');
    const T = d.totals || {};
    console.log('\n--- 页面数字 ---');
    console.log('区间            ' + (d.range ? d.range.from + ' ~ ' + d.range.to : '?'));
    console.log('平台单 / 实抓    ' + d.apiTotal + ' / ' + d.pulled + (d.apiTotal === d.pulled ? ' ✓' : ' ✗ 少抓了'));
    console.log('订单行          ' + d.lines + '（缺系列的 ' + d.noSeries + ' 行）');
    console.log('系列 / Listing   ' + d.series + ' / ' + d.listings + '（卡片 ' + d.cards + ' 张）');
    console.log('全部订单        ' + T.allOrders + ' 单（取消 ' + T.cancelledOrders + '）');
    console.log('售出件数(含取消) ' + T.units + ' 件 = 有效 ' + T.validUnits + ' + 取消 ' + T.cancelledUnits);
    console.log('订单数(有效)     ' + T.orders);
    console.log('系列合计        有效件 ' + d.sumSeriesUnits + ' · 取消件 ' + d.sumSeriesCancelled + ' · 订单 ' + d.sumSeriesOrders + ' · 利润 ¥' + d.sumSeriesProfit);
    console.log('卡片合计件数    ' + d.cardUnits);
    console.log('订单利润        ¥' + T.profitCny + '（扣广告后 ¥' + T.profitAfterAdsCny + '）');
    const bad = [];
    if (d.sumSeriesUnits !== T.validUnits) bad.push('系列有效件 ' + d.sumSeriesUnits + ' ≠ totals.validUnits ' + T.validUnits);
    if (d.sumSeriesCancelled !== T.cancelledUnits) bad.push('系列取消件 ' + d.sumSeriesCancelled + ' ≠ totals.cancelledUnits ' + T.cancelledUnits);
    if (d.sumSeriesUnits + d.sumSeriesCancelled !== T.units) bad.push('系列合计 ' + (d.sumSeriesUnits + d.sumSeriesCancelled) + ' ≠ 售出件数 ' + T.units);
    if (d.sumSeriesOrders !== T.orders) bad.push('系列订单 ' + d.sumSeriesOrders + ' ≠ 有效订单 ' + T.orders);
    if (Math.abs(d.sumSeriesProfit - Number(T.profitCny)) > 0.05) bad.push('系列利润 ' + d.sumSeriesProfit + ' ≠ 合计 ' + T.profitCny);
    if (d.cardUnits !== d.sumSeriesUnits) bad.push('卡片件数 ' + d.cardUnits + ' ≠ 系列件数 ' + d.sumSeriesUnits);
    if (d.sumProdUnits !== d.sumSeriesUnits) bad.push('Listing 件数 ' + d.sumProdUnits + ' ≠ 系列件数 ' + d.sumSeriesUnits);
    console.log(bad.length ? '\n❌ 对账失败：\n  ' + bad.join('\n  ') : '\n✅ 对账通过：有效件+取消件 = 后台件数，系列 = Listing，卡片 = 系列');

    console.log('\n--- 导出四份文件 ---');
    await ev("(function(){window.__files=[];var old=URL.createObjectURL;URL.createObjectURL=function(b){window.__files.push(b);return old.call(URL,b)};})()");
    const grab = async (btnId, ext, label) => {
      const before = await ev('(window.__files||[]).length') || 0;
      await ev("(function(){document.getElementById('" + btnId + "').click();})()");
      let out = null;
      for (let i = 0; i < 300; i++) {
        const n = await ev('(window.__files||[]).length') || 0;
        if (n > before) { out = await ev("(async function(){var b=window.__files[window.__files.length-1];var ab=await b.arrayBuffer();var u=new Uint8Array(ab),bin='';for(var i=0;i<u.length;i++)bin+=String.fromCharCode(u[i]);return {size:b.size,b64:btoa(bin)}})()"); break; }
        await sleep(500);
      }
      if (!out) { console.log('  ❌ ' + label + ' 没产出'); return null; }
      const buf = Buffer.from(out.b64, 'base64');
      const f = path.join(outDir, base + '.' + ext);
      fs.writeFileSync(f, buf);
      console.log('  📄 ' + f + '（' + Math.round(out.size / 1024) + ' KB）');
      return f;
    };
    await grab('profitExportXlsx', 'xlsx', 'Excel');
    await grab('profitExportPdf', 'pdf', 'PDF');
    await grab('profitExportReport', 'html', 'HTML');
    await grab('profitExportCsv', 'csv', 'CSV');
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
  }
})();
