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
      if (rows > 0 && !hidden) break;
      await sleep(1000);
    }
    const pageProducts = await ev("(function(){var b=document.getElementById('profitProducts');return b?b.querySelectorAll('.pp-card').length:0;})()") || 0;
    ok(rows > 0, '逐单表有行', 'rows=' + rows);
    ok(pageProducts > 0, '产品出单卡片有行', 'products=' + pageProducts);

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
      ok(/产品利润明细/.test(rpt) && /逐单明细/.test(rpt) && /净利润/.test(rpt), '报告含利润表 / 逐单明细 / 净利润 KPI');
      ok(/产品利润报告/.test(rpt) && /<!DOCTYPE html>/.test(rpt), '是完整 HTML 文档');
      ok(productRows === pageProducts, '报告产品行数 = 页面产品数', productRows + ' vs ' + pageProducts);
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
    for (let i = 0; i < 90; i++) { rows = await ev("document.querySelectorAll('#profitOrderRows tr').length") || 0; if (rows > 0) break; await sleep(1000); }
    await ev("(function(){window.__csv=null;window.__csvBom=null;var old=URL.createObjectURL;URL.createObjectURL=function(b){var r=new FileReader();r.onload=function(){var u=new Uint8Array(r.result);window.__csvBom=[u[0],u[1],u[2]];window.__csv=new TextDecoder('utf-8',{ignoreBOM:true}).decode(u);};r.readAsArrayBuffer(b);return old.call(URL,b)};})()");
    await ev("(function(){document.getElementById('profitExportCsv').click();})()");
    let csv = null, bom = null;
    for (let i = 0; i < 30; i++) { csv = await ev('window.__csv'); bom = await ev('JSON.stringify(window.__csvBom||null)'); if (csv) break; await sleep(300); }
    ok(!!csv, 'CSV 有内容');
    if (csv) {
      const lines = String(csv).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
      const pc = await ev("(function(){var b=document.getElementById('profitProducts');return b?b.querySelectorAll('.pp-card').length:0;})()") || 0;
      ok(bom === '[239,187,191]', 'CSV 带 UTF-8 BOM', bom);
      ok(lines.length === pc + 1, 'CSV 行数 = 表头 + 产品数', lines.length + ' vs ' + (pc + 1));
      ok(/产品/.test(lines[0]) && /利润\(¥\)/.test(lines[0]) && /利润率%/.test(lines[0]), 'CSV 表头含利润与利润率', lines[0].slice(0, 70));
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
