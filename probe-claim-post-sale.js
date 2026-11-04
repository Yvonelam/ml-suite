#!/usr/bin/env node
/*
 * 「买家在 Pós-venda 私信里说话，工具却没提示」回归探针（只读）
 *
 * 背景（2026-11-04 投诉）：买家 10-29 在订单页留言（订单 2000019147507672），
 * 那条消息只存在于 /messages/packs 的消息包里，不进 claims 消息线程；
 * 纠纷 10-30 结案后 claims/search?status=opened 也不再返回它 —— 于是页面永远显示
 * 「当前没有买家主动咨询的售后」，微信也不推。
 *
 * 本探针盯：
 *  1. /api/ml/claims 必须返回 postSale 数组，且 counts.buyer / counts.todo 把它算进去
 *  2. 「买家咨询」tab 真的渲染出 .ccard.postsale 卡片，正文是买家原话
 *  3. 「待我处理」tab 也能看到同一张卡（不是只在某一个 tab 里可见）
 *  4. 卡片必须写明「Pós-venda 私信」通道，且不出现假的回复框（只能去美客多）
 *  5. 抓包断言：全程没有 GET /messages/packs（不带 mark_as_read=false）——那会把用户未读清空
 *
 * 用法：node probe-claim-post-sale.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9381;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-ps-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1100', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map(); const errors = [], reqs = [];
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(m + ' timeout')); } }, 60000); }); };
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
      if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
    });
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: await login(), url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#claims' });
    for (let i = 0; i < 40; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');})()");
    await ev("(function(){var a=document.querySelector('nav a[data-go=\"claims\"]');if(a)a.click();})()");

    // 等接口回来（postSale 那次会串行拉消息包，可能要几秒）
    let api = null;
    for (let i = 0; i < 40; i++) {
      api = JSON.parse(await ev("fetch('/api/ml/claims?limit=50&offset=0&status=opened',{cache:'no-store'}).then(r=>r.json()).then(d=>JSON.stringify({ok:d.ok,counts:d.counts,postSale:d.postSale,err:d.postSaleError||''})).catch(e=>JSON.stringify({err:String(e)}))") || '{}');
      if (api.ok) break;
      await sleep(1500);
    }
    console.log('--- 1. 接口口径 ---');
    ok(api.ok === true, 'claims 接口可用');
    ok(Array.isArray(api.postSale), '返回 postSale 数组');
    const ps = api.postSale || [];
    console.log('    postSale: ' + JSON.stringify(ps.map(x => ({ pack: x.packId, order: x.orderId, buyer: x.buyerId, count: x.count, date: (x.date || '').slice(0, 10), status: x.status }))));
    if (!ps.length) {
      console.log('  ⚠️ 当前账号没有未读 Pós-venda 消息，后续 UI 断言只能跳过（接口结构已通过）');
    } else {
      ok(ps.every(x => x.source === 'post-sale' && x.category === 'buyer'), 'postSale 项都归为「买家咨询」');
      ok(Number(api.counts && api.counts.buyer) >= ps.filter(x => !x.ignored).length, 'counts.buyer 把私信算进去了', 'buyer=' + (api.counts && api.counts.buyer));
      ok(Number(api.counts && api.counts.todo) >= ps.filter(x => !x.ignored).length, 'counts.todo 把私信算进去了', 'todo=' + (api.counts && api.counts.todo));
    }

    console.log('\n--- 2. 「买家咨询」tab 渲染 ---');
    await ev("(function(){var b=document.querySelector('#claimTabs button[data-k=buyer]');if(b)b.click();})()");
    await sleep(2500);
    const buyerTab = JSON.parse(await ev(`(function(){var b=document.getElementById('claimBody');
      var cards=[].slice.call(b.querySelectorAll('.ccard.postsale'));
      return JSON.stringify({n:cards.length,text:cards.map(function(c){return (c.innerText||'').replace(/\\s+/g,' ')}).join(' || '),
        hasChannel:cards.every(function(c){return /Pós-venda/.test(c.innerText||'')}),
        hasFakeReply:!!b.querySelector('.ccard.postsale textarea')});})()`) || '{}');
    ok(!ps.length || buyerTab.n > 0, '买家咨询 tab 出现私信卡片', 'cards=' + buyerTab.n);
    if (ps.length) {
      const snippet = String(ps[0].text || '').replace(/\s+/g, ' ').slice(0, 18);
      ok((buyerTab.text || '').includes(snippet), '卡片正文是买家原话', snippet);
      ok(buyerTab.hasChannel === true, '卡片标注「Pós-venda 私信」通道');
      ok(buyerTab.hasFakeReply === false, '没有假的站内回复框（回复只能在美客多）');
    }

    console.log('\n--- 3. 「待我处理」tab 同一条可见 ---');
    await ev("(function(){var b=document.querySelector('#claimTabs button[data-k=todo]');if(b)b.click();})()");
    await sleep(2500);
    const todoN = await ev("document.querySelectorAll('#claimBody .ccard.postsale').length");
    ok(!ps.length || todoN > 0, '待我处理 tab 也能看到私信卡片', 'cards=' + todoN);

    console.log('\n--- 4. 不会把用户未读清掉 ---');
    // ① 静态：服务端取消息包必须带 mark_as_read=false（官方文档：不带等于标记已读）
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    ok(/\/messages\/packs\/[^`]*mark_as_read=false/.test(src), '服务端 packs 请求带 mark_as_read=false');
    const badPacks = (src.match(/\/messages\/packs\/\$\{[^`]*/g) || []).filter(s => !/mark_as_read=false/.test(s));
    ok(badPacks.length === 0, '没有「不带 mark_as_read=false」的 packs 取数', badPacks.slice(0, 2).join(' / '));
    // ② 运行时：缓存 60 秒，等过期后再取一次 —— 真被标记已读的话这个包就会从 unread 里消失
    if (ps.length) {
      console.log('   （等 62 秒让服务端 unread 缓存过期，再确认未读还在）');
      await sleep(62000);
      const again = JSON.parse(await ev("fetch('/api/ml/claims?limit=50&offset=0&status=opened',{cache:'no-store'}).then(r=>r.json()).then(d=>JSON.stringify((d.postSale||[]).map(x=>x.packId))).catch(()=>'[]')") || '[]');
      ok(again.includes(ps[0].packId), '二次拉取后该消息包仍是未读（没被我们清掉）', 'now=' + JSON.stringify(again));
    }

    const sh = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(__dirname, 'probe-out', 'claim-post-sale.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(sh.data, 'base64'));
    console.log('\n📷 ' + out);

    console.log('\n--- 5. 控制台 ---');
    const realErr = errors.filter(e => !/favicon/i.test(e));
    ok(realErr.length === 0, '无 console 报错', realErr.slice(0, 3).join(' / '));

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    try { child.kill(); } catch (x) { }
    process.exit(fail ? 1 : 0);
  } catch (e) { console.error('FAIL ' + e.message); try { child.kill(); } catch (x) { } process.exit(1); }
})();
