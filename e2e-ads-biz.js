#!/usr/bin/env node
/* 广告页「广告分时 + 广告总览」合并为同一张「广告投放」卡后的结构与单按钮全量刷新校验 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const PORT = 9356, HOST = 'http://127.0.0.1:' + (process.env.PORT || 3000), W = 1440, H = 1000, SCALE = 1.4;

const API_PORT = Number(process.env.PORT || 3000);

// 与 e2e-hub-biz.js 同源：账号隔离后全站都要登录（本机也一样）。优先真实登录，
// 凭据只从环境变量（或已被 gitignore 的 auth-data/dev-login.json）读，绝不写进代码/仓库。
function readDevLogin() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8')); } catch { return null; }
}
function signedSessionCookie() {
  const users = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'users.json'), 'utf8'));
  const u = users.find(x => x.role === 'admin' && x.status === 'approved');
  if (!u) throw new Error('没有已审批的管理员账号，先初始化');
  const payload = Buffer.from(JSON.stringify({ id: u.id, exp: Date.now() + 2592000000, v: Number(u.sessionVersion || 0) })).toString('base64url');
  const sig = crypto.createHmac('sha256', fs.readFileSync(path.join(__dirname, 'auth-data', 'session-secret'))).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function postJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: API_PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    req.on('error', reject); req.write(data); req.end();
  });
}
async function resolveSession() {
  const dev = readDevLogin() || {};
  const user = process.env.ML_ADMIN_USER || dev.username;
  const pass = process.env.ML_ADMIN_PASSWORD || dev.password;
  if (user && pass) {
    const r = await postJson('/api/auth/login', { username: user, password: pass });
    const sc = [].concat(r.headers['set-cookie'] || []).find(v => v.startsWith('ml_session='));
    if (!sc) throw new Error('登录失败（HTTP ' + r.status + '）：' + r.body);
    return { cookie: decodeURIComponent(sc.split(';')[0].slice('ml_session='.length)), how: '真实登录 ' + user };
  }
  return { cookie: signedSessionCookie(), how: '本地签发会话（未提供账号密码）' };
}
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-e2e-ads-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=' + W + ',' + H, '--user-data-dir=' + userDir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, msgId = 0; const pending = new Map();
  const send = (m, p = {}) => { const id = ++msgId; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(m + ' timeout')); } }, 30000); }); };
  const evaluate = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  try {
    let target = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + PORT + '/json/list'); target = l.find(t => t.type === 'page'); if (target) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    const errs = [], badUrls = [], reqs = [];
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
    ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.method === 'Runtime.exceptionThrown') errs.push('EXC:' + JSON.stringify(m.params.exceptionDetails.exception)); if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push('LOG:' + m.params.entry.text); if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url); if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) badUrls.push(m.params.response.status + ' ' + m.params.response.url); });
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const sess = await resolveSession();
    console.log('登录方式:', sess.how);
    await send('Network.enable');
    await send('Network.setCookie', { name: 'ml_session', value: sess.cookie, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#ads' });
    for (let i = 0; i < 40; i++) { await sleep(300); const t = await evaluate('document.title||""'); if (t) break; }
    for (let i = 0; i < 40; i++) { const g = await evaluate("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(300); }
    await sleep(4000); // 等 ads + ads/hourly 两个接口回来
    const landed = await evaluate("JSON.stringify({path:location.pathname,hash:location.hash,hasApp:!!document.getElementById('adsRefresh')})");
    console.log('落地检查:', landed);
    if (!JSON.parse(landed).hasApp) throw new Error('没进到广告页（可能被登录页拦下）：' + landed);

    const r = await evaluate(`(function(){
      var band=document.querySelector('#v-ads .biz-band');
      var secs=band?Array.from(band.querySelectorAll('.biz-sec h4')).map(function(h){return h.textContent.trim()}):[];
      var ids=['adsRefresh','adsHourRefresh','adsAuto','adsState','adsNote','adsHourNote','adsHourView','adsHourMetric','adsHourKpis','adsHourBody','adsHourTip','ak-cost','ak-amount','ak-acos','ak-roas','ak-clicks','ak-units','ak-cpc','ak-ctr','adsTab','adsBody','adsTip'];
      var present={};
      ids.forEach(function(id){var e=document.getElementById(id);present[id]=e?(e.tagName||'yes'):null});
      return JSON.stringify({sectionOrder:secs, present:present, adsRefreshCount:document.querySelectorAll('#adsRefresh').length, bizBandCount:document.querySelectorAll('#v-ads .biz-band').length});
    })()`);
    console.log('结构检查:', r);
    const parsed = JSON.parse(r);
    if (parsed.present.adsHourRefresh !== null) throw new Error('#adsHourRefresh 仍存在，应该已被移除');
    if (parsed.adsRefreshCount !== 1) throw new Error('#adsRefresh 应唯一，实际 ' + parsed.adsRefreshCount);
    if (parsed.bizBandCount !== 1) throw new Error('广告页 .biz-band 应唯一，实际 ' + parsed.bizBandCount);
    ['adsRefresh','adsAuto','adsState','adsNote','adsHourNote','adsHourView','adsHourMetric','adsHourKpis','adsHourBody','ak-cost','ak-amount','adsTab','adsBody'].forEach(function(id){
      if (!parsed.present[id]) throw new Error('合并后 id 丢失: ' + id);
    });

    // 一个按钮刷两块：点 #adsRefresh 后分时与总览都应重新发起请求（网络层断言，不靠正文长度猜）
    const reqBefore = reqs.length;
    const before = await evaluate("JSON.stringify({state:(document.getElementById('adsState')||{}).textContent||'',adsBody:(document.getElementById('adsBody')||{}).innerHTML.length||0,hourBody:(document.getElementById('adsHourBody')||{}).innerHTML.length||0})");
    const spin = await evaluate("(function(){var b=document.getElementById('adsRefresh');if(!b)return 'no-btn';b.click();return b.classList.contains('spin')?'spin-on':'clicked'})()");
    await sleep(14000);
    const hit = reqs.slice(reqBefore).filter(u => u.indexOf('/api/ml/ads') >= 0);
    const hitOverview = hit.some(u => /\/api\/ml\/ads(\?|$)/.test(u));
    const hitHourly = hit.some(u => u.indexOf('/api/ml/ads/hourly') >= 0);
    console.log('刷新触发的广告接口请求:', JSON.stringify(hit));
    console.log('总览接口命中:', hitOverview, '| 分时接口命中:', hitHourly);
    if (!hitOverview) throw new Error('点一次刷新没有请求广告总览接口 /api/ml/ads');
    if (!hitHourly) throw new Error('点一次刷新没有请求广告分时接口 /api/ml/ads/hourly');
    const after = await evaluate("JSON.stringify({state:(document.getElementById('adsState')||{}).textContent.trim(),adsBody:(document.getElementById('adsBody')||{}).innerHTML.length||0,hourBody:(document.getElementById('adsHourBody')||{}).innerHTML.length||0,hourKpis:(document.getElementById('adsHourKpis')||{}).innerHTML.length||0})");
    const spinAfter = await evaluate("(function(){var b=document.getElementById('adsRefresh');return b?b.classList.contains('spin'):null})()");
    console.log('点击刷新:', spin, '| 转圈已停:', spinAfter === false);
    console.log('刷新前:', before);
    console.log('刷新后:', after);
    const a = JSON.parse(after);
    if (!(a.adsBody > 30)) throw new Error('总览正文未渲染：' + after);
    if (!(a.hourBody > 30)) throw new Error('分时正文未渲染：' + after);
    console.log('控制台错误:', errs.length ? errs : '（无）');
    console.log('失败请求:', badUrls.length ? badUrls : '（无）');

    const m = await send('Page.getLayoutMetrics'); const cs = m.cssContentSize || { height: H };
    const height = Math.min(Math.max(H, Math.ceil(cs.height) + 24), 7000);
    const r2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height, scale: SCALE } });
    const out = path.join(__dirname, 'shots', 'e2e-ads-biz.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(r2.data, 'base64'));
    console.log('截图:', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
    child.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e.message); try { child.kill(); } catch (x) { } process.exit(1); }
})();
