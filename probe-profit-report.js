#!/usr/bin/env node
/*
 * 产品利润报告探针（只读）
 *
 * 盯：
 *  1. 利润页能算出数据（近 7 天），产品卡片与逐单表都有行
 *  2. 点「下载报告」真的产出一个 HTML：含 3 张内嵌 SVG 图表、产品利润表、逐单明细、KPI
 *  3. 报告里的产品行数 = 页面 products 数；不含 undefined / NaN / 未替换的 ${ 模板
 *  4. 报告落到磁盘后能被浏览器打开并渲染（截图 probe-out/profit-report.png，人工看排版）
 *  5. 「导出产品利润 CSV」有 BOM、表头正确、行数 = 产品数 + 1
 *  6. 全程无 console 报错
 *
 * 用法：node probe-profit-report.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DBG = 9391;
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
  const dir = require('./cdp-tmp').profileDir('ml-profit-rpt-');
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
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: await login(), url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#profit' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
    // 页签可能还没绑上，重试到真的切过去
    for (let i = 0; i < 30; i++) {
      await ev("(function(){var a=document.querySelector('nav a[data-go=\"profit\"]');if(a)a.click();})()");
      await sleep(200);
      if (await ev("(function(){var v=document.getElementById('v-profit');return !!v && getComputedStyle(v).display!=='none';})()")) break;
    }

    console.log('--- 1. 页面有数据 ---');
    await ev("(function(){var b=document.querySelector('#profitOrderRange button[data-range=\"7\"]');if(b)b.click();})()");
    let rows = 0;
    for (let i = 0; i < 90; i++) {
      rows = await ev("document.querySelectorAll('#profitOrderRows tr').length") || 0;
      const hidden = await ev("(function(){var p=document.getElementById('profitProducts');return !p || p.hidden;})()");
      // 页面进来自动加载「今天」，紧接着我们切「近 7 天」——两轮请求抢同一个 lastProfitOrderData。
      // 只看「有行」会拿到今天那 3 个系列，系列数 / 合并断言全成假象，必须等到区间真的变成 7 天。
      const span = await ev("(function(){var d=(typeof lastProfitOrderData!=='undefined'?lastProfitOrderData:null);if(!d||!d.range)return 0;return Math.round((new Date(d.range.to)-new Date(d.range.from))/86400000)})()") || 0;
      if (rows > 0 && !hidden && span >= 6) break;
      await sleep(1000);
    }
    const pageCards = await ev("(function(){var b=document.getElementById('profitProducts');return b?b.querySelectorAll('.pp-card').length:0;})()") || 0;
    const inv = await ev("(function(){var d=(typeof lastProfitOrderData!=='undefined'?lastProfitOrderData:null);if(!d)return '{}';var S=d.series||[],P=d.products||[],O=d.orders||[];" +
      "var sum=function(a,f){return a.reduce(function(s,x){return s+(Number(f(x))||0)},0)};" +
      "return JSON.stringify({series:S.length,listings:P.length,orders:O.length," +
      "seriesUnits:sum(S,function(x){return x.units}),listingUnits:sum(P,function(x){return x.units})," +
      "seriesProfit:Math.round(sum(S,function(x){return x.profitCny})*100)/100,listingProfit:Math.round(sum(P,function(x){return x.profitCny})*100)/100," +
      "uniqSeries:new Set(S.map(function(x){return x.series})).size,noSeriesRows:O.filter(function(x){return !x.series}).length})})()");
    const D = JSON.parse(inv || '{}');
    const seriesCount = D.series || 0, listingCount = D.listings || 0;
    const firstCardName = await ev("(function(){var e=document.querySelector('#profitProducts .pp-series');return e?e.textContent.trim():''})()") || '';
    ok(rows > 0, '逐单表有行', 'rows=' + rows);
    ok(pageCards > 0, '系列出单卡片有行', 'cards=' + pageCards);
    ok(seriesCount > 0 && pageCards === seriesCount, '卡片数 = 系列数（不是 Listing 数）', pageCards + ' vs ' + seriesCount);
    ok(seriesCount <= listingCount, '系列数 ≤ Listing 数', seriesCount + ' 系列 / ' + listingCount + ' Listing');
    ok(D.uniqSeries === seriesCount, '每个 Listing 只归一个系列（系列名不重复）', D.uniqSeries + ' vs ' + seriesCount);
    // 合并绝不能丢钱：系列合计必须逐项等于 Listing 合计
    ok(D.seriesUnits === D.listingUnits, '系列件数合计 = Listing 件数合计', D.seriesUnits + ' vs ' + D.listingUnits);
    ok(Math.abs(D.seriesProfit - D.listingProfit) < 0.01, '系列利润合计 = Listing 利润合计（合并没丢数）', D.seriesProfit + ' vs ' + D.listingProfit);
    ok((D.orders || 0) > 0 && D.noSeriesRows === 0, '每条订单行都带系列（逐单明细才能分组）', D.noSeriesRows + ' 行缺系列 / 共 ' + D.orders);
    // 卡片标题必须是短型号，不能是整条长标题
    ok(!!firstCardName && firstCardName.length <= 16 && !/headset|fone|wireless|para /i.test(firstCardName), '卡片只显示系列名，不铺标题', JSON.stringify(firstCardName));

    console.log('--- 2. 生成报告 ---');
    // 拦住 createObjectURL：报告与 CSV 都是 Blob，直接读文本核对
    await ev("(function(){window.__blobs=[];var old=URL.createObjectURL;URL.createObjectURL=function(b){window.__blobs.push(b);return old.call(URL,b)};})()");
    await ev("(function(){document.getElementById('profitExportReport').click();})()");
    let rpt = null;
    for (let i = 0; i < 40; i++) {
      rpt = await ev("(async function(){if(!window.__blobs||!window.__blobs.length)return null;return await window.__blobs[0].text();})()");
      if (rpt) break;
      await sleep(300);
    }
    ok(!!rpt, '下载报告产出了 HTML 内容', rpt ? (rpt.length + ' 字符') : '空');
    if (rpt) {
      const svgs = (rpt.match(/<svg /g) || []).length;
      const productRows = (rpt.match(/<td class="num">\d+<\/td>\s*<td class="name">/g) || []).length;
      ok(svgs >= 3, '报告内嵌 ≥3 张 SVG 图表', 'svg=' + svgs);
      ok(/系列利润明细/.test(rpt) && /逐单明细/.test(rpt) && /净利润/.test(rpt), '报告含系列利润表 / 逐单明细 / 净利润 KPI');
      ok(/产品利润报告/.test(rpt) && /<!DOCTYPE html>/.test(rpt), '是完整 HTML 文档');
      ok(productRows === seriesCount, '报告系列行数 = 页面系列数', productRows + ' vs ' + seriesCount);
      ok(!/\$\{|undefined|NaN/.test(rpt.replace(/<script[\s\S]*?<\/script>/g, '')), '报告里没有模板漏值 / NaN');
      ok(!/https?:\/\/[^"]*\.(js|css)/i.test(rpt), '报告不引外部 js/css（离线可看）');
      const out = path.join(__dirname, 'probe-out', 'profit-report.html');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, rpt);
      console.log('  📄 ' + out);

      // 用同一个浏览器打开报告，确认能渲染并截图
      await send('Page.navigate', { url: 'file:///' + out.replace(/\\/g, '/') });
      for (let i = 0; i < 30; i++) { await sleep(300); if (await ev('document.title||""')) break; }
      const rendered = await ev("(function(){return {tables:document.querySelectorAll('table').length,svgs:document.querySelectorAll('svg').length,kpis:document.querySelectorAll('.kpi').length};})()");
      ok(rendered.tables >= 2 && rendered.svgs >= 3, '报告在浏览器里渲染出表格与图表', JSON.stringify(rendered));
      const sh = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const png = path.join(__dirname, 'probe-out', 'profit-report.png');
      fs.writeFileSync(png, Buffer.from(sh.data, 'base64'));
      console.log('  📷 ' + png);
    }

    console.log('--- 3. 导出 CSV ---');
    await send('Page.navigate', { url: HOST + '/index.html#profit' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
    for (let i = 0; i < 30; i++) {
      await ev("(function(){var a=document.querySelector('nav a[data-go=\"profit\"]');if(a)a.click();})()");
      await sleep(200);
      if (await ev("(function(){var v=document.getElementById('v-profit');return !!v && getComputedStyle(v).display!=='none';})()")) break;
    }
    await ev("(function(){var b=document.querySelector('#profitOrderRange button[data-range=\"7\"]');if(b)b.click();})()");
    // 页面进来自动加载「今天」，紧接着我们切「近 7 天」——两轮请求会抢同一个 lastProfitOrderData。
    // 必须等到数据真的落在 7 天区间，否则会拿今天的 3 个产品去比 DOM 里 16 个卡片。
    for (let i = 0; i < 90; i++) {
      const st = await ev("(function(){var d=(typeof lastProfitOrderData!=='undefined'?lastProfitOrderData:null);if(!d)return '';return (d.range?d.range.from+'|'+d.range.to:'')+'|'+((d.products||[]).length)})()") || '';
      const m = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})\|(\d+)$/.exec(st);
      if (m && m[3] > 0 && (new Date(m[2]) - new Date(m[1])) / 86400000 >= 6) break;
      await sleep(1000);
    }
    await ev("(function(){window.__csv=null;window.__csvBom=null;var old=URL.createObjectURL;URL.createObjectURL=function(b){var r=new FileReader();r.onload=function(){var u=new Uint8Array(r.result);window.__csvBom=[u[0],u[1],u[2]];window.__csv=new TextDecoder('utf-8',{ignoreBOM:true}).decode(u);};r.readAsArrayBuffer(b);return old.call(URL,b)};})()");
    // 读数与点击必须在同一次求值里完成：中间隔一次往返，页面自带的「今天」加载可能刚好覆盖数据
    // 注意：app.js 里是 `let lastProfitOrderData`（词法绑定），不是 window 属性。
    // 写成 window.lastProfitOrderData 恒为 undefined → 产品数永远是 0，断言就假失败。
    const pcAtClick = await ev("(function(){var d=(typeof lastProfitOrderData!=='undefined'?lastProfitOrderData:null);var n=((d&&d.series&&d.series.length)?d.series:d&&d.products||[]).length;document.getElementById('profitExportCsv').click();return n})()") || 0;
    let csv = null, bom = null;
    for (let i = 0; i < 30; i++) { csv = await ev('window.__csv'); bom = await ev('JSON.stringify(window.__csvBom||null)'); if (csv) break; await sleep(300); }
    ok(!!csv, 'CSV 有内容');
    if (csv) {
      const lines = String(csv).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
      const pc = pcAtClick;
      ok(bom === '[239,187,191]', 'CSV 带 UTF-8 BOM', bom);
      ok(lines.length === pc + 1, 'CSV 行数 = 表头 + 系列数', lines.length + ' vs ' + (pc + 1));
      ok(/系列/.test(lines[0]) && /利润\(¥\)/.test(lines[0]) && /利润率%/.test(lines[0]), 'CSV 表头是系列口径且含利润与利润率', lines[0].slice(0, 70));
    }

    console.log('--- 4. 导出 PDF（服务端 Chrome 打印）---');
    // 拦 createObjectURL 把 PDF 字节读出来：既要验文件头，也要落盘给人工看
    await ev("(function(){window.__pdf=null;var old=URL.createObjectURL;URL.createObjectURL=function(b){b.arrayBuffer().then(function(buf){var u=new Uint8Array(buf),bin='';for(var i=0;i<u.length;i++)bin+=String.fromCharCode(u[i]);window.__pdf={size:b.size,b64:btoa(bin)};});return old.call(URL,b)};})()");
    await ev("(function(){document.getElementById('profitExportPdf').click();})()");
    let pdf = null;
    for (let i = 0; i < 80; i++) { pdf = await ev("window.__pdf||null"); if (pdf) break; await sleep(500); }
    ok(!!pdf && pdf.size > 20000, 'PDF 下载产出了文件', pdf ? Math.round(pdf.size / 1024) + ' KB' : '空');
    let pdfBuf = null;
    if (pdf) {
      pdfBuf = Buffer.from(pdf.b64, 'base64');
      ok(pdfBuf.slice(0, 5).toString() === '%PDF-', 'PDF 文件头正确');
      const pages = (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      ok(pages >= 2, 'PDF 至少 2 页（KPI + 图表 + 两张表）', 'pages=' + pages);
      const outPdf = path.join(__dirname, 'probe-out', 'profit-report.pdf');
      fs.mkdirSync(path.dirname(outPdf), { recursive: true });
      fs.writeFileSync(outPdf, pdfBuf);
      console.log('  📄 ' + outPdf);

      const keptPdfB64 = pdf.b64;
      /* 用 pdf.js 画第 1 页截图，确认中文与图表没被裁掉。
         做法：回到 index.html（同源，带 cookie 才能取到 /vendor/pdf.min.js），
         在**顶层浮层**里画 canvas —— 绝不能 innerHTML 清空 body，
         那样 app.js 的定时器会往 null 上写 textContent / disabled，探针会被自己的 console 断言判死。 */
      await send('Page.navigate', { url: HOST + '/index.html' });
      for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
      await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
      const inject = ev("(function(){return new Promise(function(res){if(window.pdfjsLib)return res('cached');var s=document.createElement('script');s.src='/vendor/pdf.min.js';s.onload=function(){pdfjsLib.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.min.js';res('ok')};s.onerror=function(){res('load-fail')};document.head.appendChild(s);setTimeout(function(){res('timeout')},8000);});})()");
      const injected = await Promise.race([inject, sleep(12000).then(() => 'guarded-timeout')]);
      ok(injected === 'ok' || injected === 'cached', 'pdf.js 加载成功', String(injected));
      const rendered = await Promise.race([
        ev("(async function(){try{var b64=" + JSON.stringify(keptPdfB64) + ";var bin=atob(b64),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);var doc=await pdfjsLib.getDocument({data:u}).promise;var page=await doc.getPage(1);var vp=page.getViewport({scale:1.4});var c=document.createElement('canvas');c.width=vp.width;c.height=vp.height;c.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;background:#fff';document.body.appendChild(c);await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return {pages:doc.numPages,w:c.width,h:c.height};}catch(e){return {err:String(e&&e.message||e)}}})()"),
        sleep(25000).then(() => ({ err: 'render-timeout' })),
      ]);
      ok(rendered && rendered.pages >= 2, 'pdf.js 能解析并渲染第 1 页', JSON.stringify(rendered));
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const png = path.join(__dirname, 'probe-out', 'profit-report-pdf.png');
      fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
      console.log('  📷 ' + png);
    }

    console.log('--- 5. 导出 Excel（三张表）---');
    await send('Page.navigate', { url: HOST + '/index.html#profit' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
    for (let i = 0; i < 30; i++) {
      await ev("(function(){var a=document.querySelector('nav a[data-go=\"profit\"]');if(a)a.click();})()");
      await sleep(200);
      if (await ev("(function(){var v=document.getElementById('v-profit');return !!v && getComputedStyle(v).display!=='none';})()")) break;
    }
    await ev("(function(){var b=document.querySelector('#profitOrderRange button[data-range=\"7\"]');if(b)b.click();})()");
    // 光看表格行数不够：表格可能还是上一轮的空占位，必须等 lastProfitOrderData 真的落库
    for (let i = 0; i < 90; i++) {
      const n = await ev("(function(){return (typeof lastProfitOrderData!=='undefined'&&lastProfitOrderData&&lastProfitOrderData.products||[]).length})()") || 0;
      if (n > 0) break;
      await sleep(1000);
    }
    const prodCount = await ev("(function(){return (lastProfitOrderData&&lastProfitOrderData.series||[]).length})()") || 0;
    const ordCount = await ev("(function(){return (lastProfitOrderData&&lastProfitOrderData.orders||[]).length})()") || 0;
    await ev("(function(){window.__xls=null;var old=URL.createObjectURL;URL.createObjectURL=function(b){b.arrayBuffer().then(function(buf){var u=new Uint8Array(buf),bin='';for(var i=0;i<u.length;i++)bin+=String.fromCharCode(u[i]);window.__xls={size:b.size,b64:btoa(bin)};});return old.call(URL,b)};})()");
    await ev("(function(){document.getElementById('profitExportXlsx').click();})()");
    let xls = null;
    for (let i = 0; i < 80; i++) { xls = await ev("window.__xls||null"); if (xls) break; await sleep(500); }
    ok(!!xls && xls.size > 5000, 'Excel 下载产出了文件', xls ? Math.round(xls.size / 1024) + ' KB' : '空');
    if (xls) {
      const xbuf = Buffer.from(xls.b64, 'base64');
      ok(xbuf.slice(0, 2).toString('hex') === '504b', 'xlsx 是 zip 容器（504b）');
      const outXls = path.join(__dirname, 'probe-out', 'profit-report.xlsx');
      fs.writeFileSync(outXls, xbuf);
      console.log('  📊 ' + outXls);
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xbuf);
      const names = wb.worksheets.map(w => w.name);
      ok(names.includes('系列利润') && names.includes('订单明细') && names.includes('口径与汇率'), '三张表齐全', names.join(' / '));
      const s1 = wb.getWorksheet('系列利润'), s2 = wb.getWorksheet('订单明细');
      const s1Rows = s1.rowCount - 3 - 4;   // 标题2行 + 表头1行 + 合计1行 + 空行1行 + 广告/净利2行
      ok(prodCount > 0 && s1Rows === prodCount, '系列利润行数 = 页面系列数', s1Rows + ' vs ' + prodCount);
      ok(s2.rowCount - 1 === ordCount, '订单明细行数 = 页面订单数（能对上每一单）', (s2.rowCount - 1) + ' vs ' + ordCount);
      ok(/系列/.test(String(s1.getRow(3).getCell(2).value)) && String(s2.getRow(1).getCell(3).value) === '系列', '两张表都是系列口径', String(s1.getRow(3).getCell(2).value) + ' / ' + String(s2.getRow(1).getCell(3).value));
      ok(!!s2.autoFilter, '订单明细带筛选器（可按系列/状态筛）');
      const anyNum = s1.getRow(4).getCell(13).numFmt;
      ok(anyNum && String(anyNum).includes('#,##0'), '利润列有千分位数字格式', String(anyNum));
    }

    console.log('\n--- 4. 控制台 ---');
    const real = errors.filter(e => !/favicon|net::ERR_ABORTED/i.test(e));
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
