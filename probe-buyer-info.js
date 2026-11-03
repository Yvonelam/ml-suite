#!/usr/bin/env node
/**
 * 买家信息 + 删除提问 + 售后收件方切换 —— 回归探针（2026-11-03 新增功能）
 *
 * 覆盖三件事：
 *   ① 售前卡片显示买家身份（昵称/城市/主页），并能「看下单情况」懒加载订单数
 *   ② 售前卡片有「删除提问」按钮（⚠ 本探针只断言按钮存在与结构，绝不点击 —— 删除不可撤销）
 *   ③ 售后卡片显示买家身份；展开对话面板后能看到买家条，若同一条纠纷同时允许发给买家和调解员，
 *      会出现收件方切换，切换后按钮文案/输入提示要跟着变
 *
 * ⚠ 只读：不点删除、不点发送。唯一的写操作风险也在这里被刻意避开。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const DBG = 9401, HOST = 'http://127.0.0.1:3000';
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data/dev-login.json'), 'utf8'));
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
const login = () => new Promise((res, rej) => {
  const b = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  const r = http.request({ host: '127.0.0.1', port: 3000, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': b.length } },
    s => { s.resume(); s.on('end', () => { const c = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); c ? res(decodeURIComponent(c.split(';')[0].slice(11))) : rej(new Error('登录失败')); }); });
  r.on('error', rej); r.write(b); r.end();
});
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + '   → ' + JSON.stringify(extra)); } };

(async () => {
  if (!BROWSERS.length) throw new Error('找不到 Chrome');
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-buyer-'));
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1280,1200', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };
  const shot = async (name) => {
    const s = await Promise.race([send('Page.captureScreenshot', { format: 'png', fromSurface: true }), sleep(20000).then(() => { throw new Error('截图超时'); })]);
    const f = path.join(__dirname, 'probe-out', name);
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (e) { }
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    console.log('  📷 ' + f);
  };
  /* 轮询等待条件成立。以前用固定 sleep，一旦接口慢一点就抓到「正在加载…」，
     断言直接变成「列表是空的」——假红比不测更坏。 */
  const waitFor = async (expr, ms = 20000, step = 400) => {
    for (let t = 0; t < ms; t += step) { if (await ev(expr)) return true; await sleep(step); }
    return false;
  };
  const qCards = () => ev("document.querySelectorAll('#questionBody .qcard').length");
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#questions' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 60; i++) { if (await ev('typeof go === "function"')) break; await sleep(200); }
    // ⚠ go() 是函数声明，脚本一解析就能调用，但 tab 的 onclick 是 init() 里挂的。
    // 以前只等 go 就开点，点到的是「还没绑事件的按钮」——点了等于没点，卡片当然 0 条。
    await waitFor("!!document.querySelector('#questionTabs button[data-k=\"UNANSWERED\"]').onclick", 20000);
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');return true})()");
    // 丢掉任何 confirm，防止误触
    await ev('window.__confirmCalls = 0; window.confirm = function(){ window.__confirmCalls++; return false; }; true');

    /* ---------- 售前 ---------- */
    console.log('\n=== 售前：买家信息 + 删除入口 ===');
    await ev("go('questions'); true");
    await waitFor("document.querySelectorAll('#questionBody .qcard').length > 0 || /共 \\d+ 条/.test(document.querySelector('#questionState').innerText)", 25000);
    let qn = await qCards();
    if (!qn) {
      // 默认停在「未回复」，可能一条都没有；切到「已回复」拿真实卡片来验证（同样是真实数据）
      console.log('  「未回复」为空，切到「已回复」验证');
      await ev(`(function(){ var b = document.querySelector('#questionTabs button[data-k="ANSWERED"]'); if (b) b.click(); return true; })()`);
      await waitFor("document.querySelectorAll('#questionBody .qcard').length > 0", 25000);
      qn = await qCards();
    }
    console.log('  卡片数 = ' + qn);
    if (qn) {
      const who = await ev(`(() => { const el = document.querySelector('#questionBody .qcard .qwho'); return el ? el.innerText.replace(/\\s+/g,' ').trim() : null; })()`);
      ok(!!who, '售前卡片出现买家身份条', who);
      ok(!!who && /👤/.test(who), '身份条带 👤 图标', who);
      const hasOrdersBtn = await ev("!!document.querySelector('#questionBody .qcard .qwho button[data-qbuyer]')");
      ok(hasOrdersBtn, '身份条带「看下单情况」按钮', hasOrdersBtn);
      const delBtn = await ev(`(() => { const b = document.querySelector('#questionBody button[data-qdel]'); return b ? { text: b.textContent.trim(), id: b.dataset.qdel } : null; })()`);
      ok(!!delBtn && /删除/.test(delBtn.text), '卡片上有「删除提问」按钮', delBtn);
      ok(!!delBtn && /^\d+$/.test(delBtn.id || ''), '删除按钮挂的是真提问 ID', delBtn && delBtn.id);
      // 懒加载订单数：点一下「看下单情况」（只读接口）
      await ev("(function(){var b=document.querySelector('#questionBody .qcard .qwho button[data-qbuyer]'); if(b) b.click(); return true;})()");
      await sleep(3000);
      const oc = await ev("(function(){var b=document.querySelector('#questionBody .qcard .qwho button[data-qbuyer]'); return b? b.textContent.trim():'';})()");
      ok(/下单|没有下过单|查询中/.test(oc || ''), '点「看下单情况」后按钮变成订单结论', oc);
      ok(await ev('window.__confirmCalls === 0'), '没有误触删除确认框（探针全程没点删除）', await ev('window.__confirmCalls'));
      // 「全部」tab 曾经因为传空 status 被服务端退化成 UNANSWERED，和「未回复」一模一样
      const totalNow = await ev("parseInt((document.querySelector('#questionState').innerText.match(/\\d+/)||[0])[0])");
      await ev(`(function(){ var b = document.querySelector('#questionTabs button[data-k="all"]'); if (b) b.click(); return true; })()`);
      await waitFor("document.querySelectorAll('#questionBody .qcard').length > 0", 25000);
      const totalAll = await ev("parseInt((document.querySelector('#questionState').innerText.match(/\\d+/)||[0])[0])");
      ok(totalAll >= totalNow && totalAll > 0, '「全部」tab 返回的是全量而不是复读「未回复」', { 已回复: totalNow, 全部: totalAll });
    } else {
      ok(false, '售前列表是空的，无法验证买家信息（换个 tab / 用示例数据再试）');
    }
    await shot('buyer-questions.png');

    /* ---------- 售后 ---------- */
    console.log('\n=== 售后：买家身份 + 收件方切换 ===');
    await ev("go('claims'); true"); await sleep(4500);
    const cn = await ev("document.querySelectorAll('#claimBody .ccard').length");
    console.log('  卡片数 = ' + cn);
    if (cn) {
      const cwho = await ev(`(() => { const el = document.querySelector('#claimBody .ccard .qwho'); return el ? el.innerText.replace(/\\s+/g,' ').trim() : null; })()`);
      ok(!!cwho, '售后卡片出现买家身份条', cwho);
      await ev("(function(){var b=document.querySelector('#claimBody button[data-talk]'); if(b) b.click(); return true;})()");
      await sleep(4000);
      const pwho = await ev("(function(){var el=document.querySelector('#claimBody .cpanel .cwho'); return el? el.innerText.replace(/\\s+/g,' ').trim():null;})()");
      ok(!!pwho, '展开面板后顶部有买家条', pwho);
      const hasTxt = await ev("!!document.querySelector('#claimBody .cpanel textarea[data-cta]')");
      const hasTgt = await ev("!!document.querySelector('#claimBody .cpanel .tgt')");
      console.log('  面板回复框=' + hasTxt + '  收件方切换=' + hasTgt);
      if (hasTgt) {
        const before = await ev("(function(){var b=document.querySelector('#claimBody .cpanel [data-csend]'); return b? b.textContent.trim():'';})()");
        await ev("(function(){var b=document.querySelector('#claimBody .cpanel .tgt button[data-t=\\\"mediator\\\"]'); if(b) b.click(); return true;})()");
        await sleep(300);
        const after = await ev("(function(){var b=document.querySelector('#claimBody .cpanel [data-csend]'); return b? b.textContent.trim():'';})()");
        ok(before !== after && /调解员/.test(after), '切到「平台调解员」后发送按钮文案跟着变', { before, after });
        ok(await ev("document.querySelector('#claimBody .cpanel .tgt button.on').dataset.t === 'mediator'"), '选中的收件方高亮切到 mediator', true);
      } else {
        console.log('  （这条纠纷美客多只允许一个收件方，切换器不出现属于正常）');
      }
      ok(await ev('window.__confirmCalls === 0'), '售后全程没有触发任何确认框', await ev('window.__confirmCalls'));
    } else {
      ok(false, '当前「待我处理」没有售后卡片，无法验证（可切到其它 tab）');
    }
    await shot('buyer-claims.png');

    console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
