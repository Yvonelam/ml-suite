#!/usr/bin/env node
/**
 * 浏览器实测：10 月全区间
 *   ① 订单数是否正确（平台 779 单 → 应显示实抓全部）
 *   ② 列币种搭配：收入/销售费/运费 = 巴币 R$；成本与头程/订单利润/利润合计 = 人民币 ¥
 *   ③ 每格 title 是否给出另一币种的折算值
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

    await ev("(function(){var a=document.querySelector('nav a[data-go=\"profit\"]');if(a)a.click();})()");
    await sleep(2000);

    // 页面异步初始化会把日期重置成「今天」，所以要校验生效后再点，必要时重试
    const PFROM = '2026-10-01', PTO = '2026-10-17';
    let rangeOk = false;
    for (let attempt = 0; attempt < 8 && !rangeOk; attempt++) {
      await ev(`(function(){
        var f=document.getElementById('profitOrderFrom'),t=document.getElementById('profitOrderTo');
        f.value='${PFROM}'; t.value='${PTO}';
        f.dispatchEvent(new Event('change',{bubbles:true}));
        t.dispatchEvent(new Event('change',{bubbles:true}));
        document.getElementById('profitOrderRange').querySelectorAll('button').forEach(function(b){b.classList.toggle('on',b.dataset.range==='custom');});
      })()`);
      await sleep(700);
      const cur = await ev("(function(){var f=document.getElementById('profitOrderFrom'),t=document.getElementById('profitOrderTo');return f.value+'|'+t.value})()");
      if (cur === PFROM + '|' + PTO) { rangeOk = true; break; }
    }
    if (!rangeOk) console.log('  ! 日期设置未生效，结果可能落在错误区间');
    await ev("document.getElementById('profitOrderApply').click()");
    console.log('已触发查询 ' + PFROM + ' ~ ' + PTO + '，等待接口返回…');
    for (let i = 0; i < 90; i++) {
      const st = await ev("document.getElementById('profitOrderStatus').textContent");
      if (/平台共/.test(st) || /失败/.test(st)) break;
      await sleep(1000);
    }
    await sleep(800);

    const A = JSON.parse(await ev(`(function(){
      var ths=[].map.call(document.querySelectorAll('.profit-order-table thead th'),function(t){return t.textContent.trim()});
      var tr=document.querySelector('#profitOrderRows tr');
      var tds=tr?[].map.call(tr.querySelectorAll('td'),function(t){return {text:t.textContent.trim(),title:t.getAttribute('title')||''}}):[];
      var st=document.getElementById('profitOrderStatus').textContent;
      var sum=[].map.call(document.querySelectorAll('#profitOrderSummary .profit-order-stat'),function(d){return {k:d.querySelector('small').textContent.trim(),v:d.querySelector('b').textContent.trim(),title:d.getAttribute('title')||''}});
      var rows=document.querySelectorAll('#profitOrderRows tr').length;
      return JSON.stringify({ths:ths,tds:tds,status:st,sum:sum,rows:rows,hasCurSwitch:!!document.getElementById('profitOrderCur')});
    })()`));

    console.log('\n[1] 订单抓取');
    console.log('    状态：' + A.status);
    // 单量每天都在长，不写死数字：只校验「平台总数 = 实抓数」和「有效单 = 总数 − 取消数」
    const mTotal = A.status.match(/平台共 ([\d,]+) 单/);
    const mPulled = A.status.match(/实抓 (?:全部 )?([\d,]+) 单( ✓)?/);
    const mCancel = A.status.match(/取消\/退款 ([\d,]+) 单/);
    const mValid = A.status.match(/有效 ([\d,]+) 单/);
    const num = (s) => Number(String(s || '0').replace(/,/g, ''));
    ok(!!mTotal, '状态行给出平台总单数', A.status);
    ok(!!mPulled && num(mPulled[1]) === num(mTotal && mTotal[1]), '状态行显示已全部抓取（实抓 = 平台总数）', A.status);
    ok(!/差 \d/.test(A.status), '状态行没有「差 N 单」的缺单提示', A.status);
    ok(!!mValid && num(mValid[1]) === num(mTotal && mTotal[1]) - num(mCancel && mCancel[1]), '有效单 = 平台总数 − 取消单', A.status);
    ok(/共售出 [\d,]+ 件/.test(A.status), '状态行给出共售出件数（含取消）', A.status);
    ok(A.rows >= 700, '表格渲染行数 >= 700', A.rows);

    console.log('\n[2] 列币种搭配');
    // 按表头文字定位，不写死列号：页面后来加过「税费（巴币）」这一列，硬编码会整体错位。
    const colOf = (kw) => A.ths.findIndex((t) => t.indexOf(kw) >= 0);
    const colText = (kw) => { const i = colOf(kw); return i < 0 ? '(找不到)' : A.ths[i]; };
    const colCell = (kw) => { const i = colOf(kw); return i < 0 ? '' : (A.tds[i] || {}).text || ''; };
    console.log('    表头（' + A.ths.length + ' 列）：' + A.ths.join(' | '));
    console.log('    样例行：' + A.tds.map(c => c.text).join(' | '));
    ok(/巴币/.test(colText('订单收入')), '订单收入 = 巴币', colText('订单收入'));
    ok(/巴币/.test(colText('佣金')), '平台佣金 = 巴币', colText('佣金'));
    ok(/巴币/.test(colText('尾程运费')), '尾程运费 = 巴币', colText('尾程运费'));
    ok(/巴币/.test(colText('税费')), '税费 = 巴币', colText('税费'));
    ok(/人民币/.test(colText('成本与头程')), '成本与头程 = 人民币', colText('成本与头程'));
    ok(/人民币/.test(colText('订单利润')), '订单利润 = 人民币', colText('订单利润'));
    ok(!A.hasCurSwitch, '币种切换按钮已移除（改为固定搭配）');

    ok(/R\$/.test(colCell('订单收入')), '收入显示 R$', colCell('订单收入'));
    ok(/R\$/.test(colCell('佣金')), '平台佣金显示 R$', colCell('佣金'));
    ok(/R\$/.test(colCell('尾程运费')), '尾程运费显示 R$', colCell('尾程运费'));
    ok(/R\$/.test(colCell('税费')), '税费显示 R$', colCell('税费'));
    ok(/¥/.test(colCell('成本与头程')), '成本与头程显示 ¥', colCell('成本与头程'));
    ok(/¥/.test(colCell('订单利润')), '订单利润显示 ¥', colCell('订单利润'));

    console.log('\n[3] 汇总');
    for (const s of A.sum) console.log('    ' + s.k + ' = ' + s.v + (s.title ? '   [' + s.title + ']' : ''));
    const profitCard = A.sum.find(s => /利润合计/.test(s.k));
    ok(!!profitCard && /人民币/.test(profitCard.k), '合计标题是「订单利润合计（人民币）」', profitCard && profitCard.k);
    ok(!!profitCard && /¥/.test(profitCard.v), '合计数值用 ¥', profitCard && profitCard.v);
    ok(!!profitCard && /R\$/.test(profitCard.title || ''), '合计的悬停提示给出巴币折算值', profitCard && profitCard.title);

    console.log('\n[4] 每格悬停提示（另一币种）');
    // 按**表头文字**定位，不写死列号 —— 页面后来加过「税费」等新列，硬编码 tds[6]/tds[7] 会错位。
    const col = (kw) => A.ths.findIndex((t) => t.indexOf(kw) >= 0);
    const iRev = col('订单收入'), iCost = col('成本与头程'), iProfit = col('订单利润');
    console.log('    列定位：收入 #' + iRev + ' / 成本 #' + iCost + ' / 利润 #' + iProfit + '（共 ' + A.ths.length + ' 列）');
    ok(iRev >= 0 && iCost >= 0 && iProfit >= 0, '三列表头都能定位到');
    const td = (i) => A.tds[i] || { text: '', title: '' };
    console.log('    收入 title：' + td(iRev).title);
    console.log('    成本 title：' + td(iCost).title);
    console.log('    利润 title：' + td(iProfit).title);
    ok(/¥/.test(td(iRev).title), '收入格提示人民币折算值', td(iRev).title);
    // 成本格可能带「平台未代扣，按收入 x% 估算」的前缀，只要求含某个折算值即可
    ok(/折合/.test(td(iCost).title) && /(R\$|¥)/.test(td(iCost).title), '成本格给出另一币种折算值', td(iCost).title);
    ok(/折合/.test(td(iProfit).title), '利润格给出另一币种折算值', td(iProfit).title);

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
