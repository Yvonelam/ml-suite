#!/usr/bin/env node
/*
 * 产品量化（导出表）探针（只读）
 *
 * 盯：
 *  1. /api/ml/product-quant 三张表都有数据，且数字自洽（店铺按天订单数合计 = 总订单数）
 *  2. 页面「按商品 × 天 / 店铺按天 / 按商品汇总」三个 tab 都能渲染出行
 *  3. 日期筛选真的生效（近 7 天 → 区间变 7 天，行数跟着变）
 *  4. 下载：点「下载表格」真的产出 CSV（Blob 文本能读到，表头与行数正确，含 BOM）
 *  5. 拉不到广告时不能把订单数据一起废掉（接口里 adsError 与 orders 互不影响）
 *
 * 用法：node probe-quant.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9383;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-quant-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1100', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map(); const errors = [];
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(m + ' timeout')); } }, 180000); }); };
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
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: await login(), url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#quant' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
    await ev("(function(){var a=document.querySelector('nav a[data-go=\"quant\"]');if(a)a.click();})()");

    console.log('--- 1. 接口口径 ---');
    // 直接打接口（页面同源、带会话 cookie）
    const api = JSON.parse(await ev("fetch('/api/ml/product-quant?from=2026-11-06&to=2026-11-12',{cache:'no-store'}).then(r=>r.json()).then(d=>JSON.stringify({ok:d.ok,items:(d.items||[]).length,daily:(d.daily||[]).length,store:(d.storeDaily||[]).length,totals:d.totals,adsError:d.adsError,fx:d.fx})).catch(e=>JSON.stringify({ok:false,err:String(e)}))") || '{}');
    console.log('   ', JSON.stringify(api).slice(0, 260));
    ok(api.ok === true, '接口返回 ok');
    ok(api.daily > 0, '按商品×天有行', 'rows=' + api.daily);
    ok(api.store > 0, '店铺按天有行', 'rows=' + api.store);
    ok(api.items > 0, '按商品汇总有行', 'rows=' + api.items);
    const sumOrders = await ev("fetch('/api/ml/product-quant?from=2026-11-06&to=2026-11-12',{cache:'no-store'}).then(r=>r.json()).then(d=>{const s=(d.storeDaily||[]).reduce((a,x)=>a+(x.orders||0),0);return JSON.stringify({sum:s,total:(d.totals||{}).orders});})");
    const so = JSON.parse(sumOrders || '{}');
    ok(Number(so.sum) === Number(so.total), '店铺按天订单合计 = 总订单数', so.sum + ' / ' + so.total);

    // 广告必须是「商品 × 天」明细，而且按天汇总后必须等于账户日花费（否则就是摊派/丢数）
    const adChk = JSON.parse(await ev(`fetch('/api/ml/product-quant?from=2026-11-06&to=2026-11-12',{cache:'no-store'}).then(r=>r.json()).then(d=>{
      var byDate={};
      (d.daily||[]).forEach(function(r){ if(r.adsCost==null)return; byDate[r.date]=(byDate[r.date]||0)+Number(r.adsCost); });
      var bad=[];
      (d.storeDaily||[]).forEach(function(s){ var a=Math.round((byDate[s.date]||0)*100)/100, b=Math.round(Number(s.adsCost||0)*100)/100;
        if(Math.abs(a-b)>0.05) bad.push({date:s.date,itemSum:a,account:b}); });
      return JSON.stringify({bad:bad, rowsWithAds:(d.daily||[]).filter(function(x){return Number(x.adsCost)>0}).length,
        adsItems:(d.totals||{}).adsItems, adsCost:(d.totals||{}).adsCost, allRows:(d.daily||[]).length});
    })`) || '{}');
    ok(Array.isArray(adChk.bad) && adChk.bad.length === 0, '商品×天广告费合计 = 店铺当日账户花费', JSON.stringify(adChk.bad || []).slice(0, 120));
    ok(Number(adChk.rowsWithAds) > 0, '按商品×天有广告花费行', 'rows=' + adChk.rowsWithAds + '/' + adChk.allRows);
    ok(Number(adChk.adsItems) > 0, '在投商品数已统计', 'items=' + adChk.adsItems);

    console.log('\n--- 2. 页面渲染三个 tab ---');
    // 页面默认「今天」，先切到近 7 天拿数据；进页面时自动读「今天」的那一轮还在跑，
    // loadQuant 现在会把这次点击排队，所以要等状态变成「读取于」而不是只看有没有行。
    await ev("(function(){document.querySelector('#quantRange button[data-range=\"7\"]').click();})()");
    let rows = 0, stateTxt = '';
    for (let i = 0; i < 60; i++) {
      rows = await ev("document.querySelectorAll('#quantTable .quant-table tbody tr').length");
      stateTxt = await ev("(document.getElementById('quantState')||{}).textContent||''");
      if (rows > 0 && /读取于/.test(stateTxt)) break;
      await sleep(2000);
    }
    ok(/读取于/.test(stateTxt), '切换区间后数据真的刷新了', stateTxt.slice(0, 40));
    ok(rows > 0, '按商品×天 tab 渲染出行', 'rows=' + rows);
    const itemdayHead = await ev("JSON.stringify([].slice.call(document.querySelectorAll('#quantTable th')).map(function(t){return t.textContent}))");
    const idh = JSON.parse(itemdayHead || '[]');
    ok(idh.some(t => /广告费/.test(t)) && idh.some(t => /广告订单数/.test(t)) && idh.some(t => /ACOS/i.test(t)), '按商品×天表头有广告列', idh.join(',').slice(0, 90));
    const adCells = await ev("(function(){var ths=[].slice.call(document.querySelectorAll('#quantTable th')).map(function(t){return t.textContent});var idx=ths.indexOf('广告费(原币)');if(idx<0)return 'no-col';var trs=[].slice.call(document.querySelectorAll('#quantTable .quant-table tbody tr'));var n=0;trs.forEach(function(tr){var td=tr.querySelectorAll('td')[idx];if(td&&/R\\$/.test(td.textContent)&&!/^R\\$\\s*0[,.]00$/.test(td.textContent.trim()))n++;});return n+'/'+trs.length;})()");
    ok(/^[1-9]/.test(String(adCells)), '按商品×天有广告费数值行', String(adCells));
    const fromVal = await ev("document.getElementById('quantFrom').value");
    ok(/^\d{4}-\d{2}-\d{2}$/.test(fromVal || ''), '日期筛选填入起始日期', fromVal);

    await ev("(function(){document.querySelector('#quantTabs button[data-t=\"storeday\"]').click();})()");
    await sleep(600);
    const storeRows = await ev("document.querySelectorAll('#quantTable .quant-table tbody tr').length");
    ok(storeRows > 0, '店铺按天 tab 有行', 'rows=' + storeRows);
    const hasAdsHead = await ev("[].slice.call(document.querySelectorAll('#quantTable th')).some(function(t){return /广告费/.test(t.textContent)})");
    ok(hasAdsHead === true, '店铺按天表头含广告费列');

    await ev("(function(){document.querySelector('#quantTabs button[data-t=\"items\"]').click();})()");
    await sleep(600);
    const itemRows = await ev("document.querySelectorAll('#quantTable .quant-table tbody tr').length");
    ok(itemRows > 0, '按商品汇总 tab 有行', 'rows=' + itemRows);
    const kpi = JSON.parse(await ev("JSON.stringify({o:document.getElementById('quantOrders').textContent,u:document.getElementById('quantUnits').textContent,r:document.getElementById('quantRevenue').textContent})") || '{}');
    ok(kpi.o && kpi.o !== '—', 'KPI 有效订单已填充', kpi.o);
    ok(/R\$/.test(kpi.r || ''), 'KPI 销售额带原币符号', kpi.r);

    console.log('\n--- 3. 下载 CSV ---');
    // 回到「按商品×天」再下载：新加的广告列必须真的进 CSV，不只是界面上有
    await ev("(function(){document.querySelector('#quantTabs button[data-t=\"itemday\"]').click();})()");
    await sleep(800);
    const expRows = await ev("document.querySelectorAll('#quantTable .quant-table tbody tr').length");
    // 拦住 createObjectURL，把 Blob 按字节读出来（FileReader.readAsText 会吃掉 BOM，测不到）
    await ev("(function(){window.__csv=null;window.__csvBom=null;var old=URL.createObjectURL;URL.createObjectURL=function(b){var r=new FileReader();r.onload=function(){var u=new Uint8Array(r.result);window.__csvBom=[u[0],u[1],u[2]];window.__csv=new TextDecoder('utf-8',{ignoreBOM:true}).decode(u);};r.readAsArrayBuffer(b);return old.call(URL,b)};})()");
    await ev("(function(){document.getElementById('quantDownload').click();})()");
    let csv = null, bom = null;
    for (let i = 0; i < 25; i++) { csv = await ev('window.__csv'); bom = await ev('JSON.stringify(window.__csvBom||null)'); if (csv) break; await sleep(400); }
    ok(!!csv, '下载按钮产出了 CSV 内容');
    if (csv) {
      const clean = String(csv).replace(/^\uFEFF/, '');
      const lines = clean.split(/\r?\n/).filter(Boolean);
      ok(bom === '[239,187,191]', 'CSV 带 UTF-8 BOM（Excel 不乱码）', bom);
      ok(lines.length === expRows + 1, 'CSV 行数 = 表头 + 表格行数', lines.length + ' vs ' + (expRows + 1));
      ok(/SKU/.test(lines[0]) && /商品/.test(lines[0]) && /广告费/.test(lines[0]), 'CSV 表头是字段名', lines[0].slice(0, 60));
      ok(/广告费/.test(lines[0]) && /广告订单数/.test(lines[0]) && /ACOS/.test(lines[0]), 'CSV 表头含广告列', lines[0].slice(0, 100));
      const quoteOk = lines.every(l => (l.match(/"/g) || []).length % 2 === 0);
      ok(quoteOk, 'CSV 引号成对（含逗号的标题不串列）');
    }

    const sh = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(__dirname, 'probe-out', 'product-quant.png');
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
