#!/usr/bin/env node
/**
 * 浏览器实测：10 月全区间
 *   ① 订单数是否正确（平台 779 单 → 应显示实抓全部）
 *   ② 默认币种是否为巴币（R$）、切换人民币后整行是否同步变
 *   ③ 一行里 收入 − 销售费 − 运费 − 成本 是否等于利润（同币种可直接相减）
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9373;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

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
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cur-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1100', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
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
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    const ck = await login();
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    await sleep(1500);

    // 进入产品利润
    await ev("(function(){var a=document.querySelector('nav a[data-go=\"profit\"]');if(a)a.click();})()");
    await sleep(2000);

    // 设区间 10/01 ~ 10/17 并查询
    await ev(`(function(){
      var f=document.getElementById('profitOrderFrom'),t=document.getElementById('profitOrderTo');
      f.value='2026-10-01'; t.value='2026-10-17';
      f.dispatchEvent(new Event('change',{bubbles:true}));
      t.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('profitOrderRange').querySelectorAll('button').forEach(function(b){b.classList.toggle('on',b.dataset.range==='custom');});
      document.getElementById('profitOrderApply').click();
    })()`);
    console.log('已触发查询 2026-10-01 ~ 2026-10-17，等待接口返回…');
    for (let i = 0; i < 90; i++) {
      const st = await ev("document.getElementById('profitOrderStatus').textContent");
      if (/平台共/.test(st) || /失败/.test(st)) break;
      await sleep(1000);
    }
    await sleep(800);

    const read = async () => JSON.parse(await ev(`(function(){
      var ths=[].map.call(document.querySelectorAll('.profit-order-table thead th'),function(t){return t.textContent.trim()});
      var tr=document.querySelector('#profitOrderRows tr');
      var tds=tr?[].map.call(tr.querySelectorAll('td'),function(t){return t.textContent.trim()}):[];
      var st=document.getElementById('profitOrderStatus').textContent;
      var sum=[].map.call(document.querySelectorAll('#profitOrderSummary .profit-order-stat'),function(d){return d.textContent.trim()});
      var rows=document.querySelectorAll('#profitOrderRows tr').length;
      var on=document.querySelector('#profitOrderCur button.on');
      return JSON.stringify({ths:ths,tds:tds,status:st,sum:sum,rows:rows,cur:on?on.dataset.cur:null,curText:on?on.textContent.trim():null});
    })()`));

    // ---- 巴币模式 ----
    console.log('\n[1] 默认币种（应为巴币）');
    const A = await read();
    console.log('    按钮选中：' + A.curText + '（data-cur=' + A.cur + '）');
    console.log('    表头：' + A.ths.slice(3).join(' | '));
    console.log('    状态：' + A.status);
    console.log('    样例行：' + A.tds.slice(3).join(' | '));
    ok(A.cur === 'local', '默认选中巴币', A.cur);
    ok(A.ths.slice(3).every(h => h.includes('巴币')), '表头都是（巴币）', A.ths.slice(3));
    ok(/R\$/.test(A.tds[3] || ''), '收入显示 R$（巴币符号）', A.tds[3]);
    ok(/R\$/.test(A.tds[5] || ''), '尾程运费显示 R$', A.tds[5]);
    ok(/平台共 779 单/.test(A.status), '状态行显示平台共 779 单', A.status);
    ok(/全部 779 单/.test(A.status), '状态行显示已全部抓取', A.status);
    ok(A.rows >= 700, '表格渲染行数 >= 700（约 730 有效单）', A.rows);

    // 同币种可相减校验
    const num = s => Number(String(s).replace(/[^\d.-]/g, '')) || 0;
    const rev = num(A.tds[3]), fee = num(A.tds[4]), ship = num(A.tds[5]), cost = num(A.tds[6]), profit = num(A.tds[7]);
    const calc = rev - fee - ship - cost;
    console.log('    对账：' + rev + ' − ' + fee + ' − ' + ship + ' − ' + cost + ' = ' + calc.toFixed(2) + '  页面利润 ' + profit);
    ok(Math.abs(calc - profit) < 0.05, '同一币种下各项相减等于利润', { calc, profit });

    // ---- 人民币模式 ----
    console.log('\n[2] 切到人民币');
    await ev("(function(){var b=document.querySelector('#profitOrderCur button[data-cur=\"cny\"]');b.click();})()");
    await sleep(600);
    const B = await read();
    console.log('    表头：' + B.ths.slice(3).join(' | '));
    console.log('    样例行：' + B.tds.slice(3).join(' | '));
    ok(B.cur === 'cny', '切到人民币生效', B.cur);
    ok(B.ths.slice(3).every(h => h.includes('人民币')), '表头都变成（人民币）', B.ths.slice(3));
    ok(/¥/.test(B.tds[3] || ''), '收入显示 ¥', B.tds[3]);
    ok(num(B.tds[3]) !== rev, '金额确实换成人民币（与巴币不同）', { brl: rev, cny: num(B.tds[3]) });
    const rev2 = num(B.tds[3]), fee2 = num(B.tds[4]), ship2 = num(B.tds[5]), cost2 = num(B.tds[6]), profit2 = num(B.tds[7]);
    ok(Math.abs((rev2 - fee2 - ship2 - cost2) - profit2) < 0.06, '人民币模式下相减也等于利润', { calc: rev2 - fee2 - ship2 - cost2, profit2 });

    // ---- 切回巴币并截图 ----
    await ev("(function(){var b=document.querySelector('#profitOrderCur button[data-cur=\"local\"]');b.click();})()");
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(__dirname, 'shots', 'profit-brl.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('\n  📷 ' + out);

    console.log('\n控制台错误: ' + (errors.length ? errors.slice(0, 5).join(' | ') : '（无）'));
    ok(errors.length === 0, '无控制台错误', errors.slice(0, 3));

    console.log('\n================ 结果：' + pass + ' 通过 / ' + fail + ' 失败 ================\n');
    try { child.kill(); } catch (e) { }
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('FAIL ' + e.message);
    try { child.kill(); } catch (x) { }
    process.exit(1);
  }
})();
