#!/usr/bin/env node
/* 概览页「经营看板」合并后的结构与渲染校验 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const PORT = 9354, HOST = 'http://127.0.0.1:' + (process.env.PORT || 3000), W = 1440, H = 1000, SCALE = 1.4;

const API_PORT = Number(process.env.PORT || 3000);

// 账号隔离后全站都要登录（本机也一样）。优先用真实账号走 /api/auth/login，
// 凭据只从环境变量（或可选的、已被 gitignore 的 auth-data/dev-login.json）读，绝不写进代码/仓库。
// 两者都没有时退回「本地签发会话 cookie」——效果等价，但走不到登录接口。
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
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-e2e3-'));
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
    const errs = [], badUrls = [];
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
    ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.method === 'Runtime.exceptionThrown') errs.push('EXC:' + JSON.stringify(m.params.exceptionDetails.exception)); if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push('LOG:' + m.params.entry.text); if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) badUrls.push(m.params.response.status + ' ' + m.params.response.url); });
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const sess = await resolveSession();
    console.log('登录方式:', sess.how);
    await send('Network.enable');
    await send('Network.setCookie', { name: 'ml_session', value: sess.cookie, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#hub' });
    for (let i = 0; i < 40; i++) { await sleep(300); const t = await evaluate('document.title||""'); if (t) break; }
    for (let i = 0; i < 40; i++) { const g = await evaluate("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(300); }
    await sleep(3200); // 等三个接口回来
    // 会话没生效的话会被弹回 login.html —— 明确报出来，别让人对着一堆 null 猜
    const landed = await evaluate("JSON.stringify({path:location.pathname,hasApp:!!document.getElementById('ovRefresh')})");
    console.log('落地检查:', landed);
    if (!JSON.parse(landed).hasApp) throw new Error('没进到工作台（可能被登录页拦下）：' + landed);

    const r = await evaluate(`(function(){
      var band=document.querySelector('.biz-band');
      var secs=band?Array.from(band.querySelectorAll('.biz-sec h4')).map(function(h){return h.textContent.trim()}):[];
      var ids=['ovRefresh','salesRefresh','listingRefresh','mlState','salesState','listingState','listingBody','salesBody','salesGran','salesAuto','ml-today','sk-amount','mlUpdated'];
      var present={};
      ids.forEach(function(id){present[id]=(!!document.getElementById(id))?(document.getElementById(id).tagName||'yes'):null});
      // 概览页里「经营看板」是不是排在最前（在趋势图之前）
      var wrap=document.querySelector('#hub');
      var cards=wrap?Array.from(wrap.querySelectorAll(':scope > .card, :scope > .g2, :scope > .kpi-grid, :scope > .grid4')):[];
      var order=cards.map(function(c){return (c.querySelector('h3,h4')||{}).textContent||c.className}).slice(0,4);
      return JSON.stringify({sectionOrder:secs, present:present, ovRefreshCount:document.querySelectorAll('#ovRefresh').length, topCards:order});
    })()`);
    console.log('结构检查:', r);

    // 一个按钮刷全部：点 #ovRefresh，三个区块的「更新于」时间戳都应该刷新
    const before = await evaluate("JSON.stringify({ord:(document.getElementById('mlUpdated')||{}).textContent||'',sales:(document.getElementById('salesTzNote')||{}).textContent||'',listing:(document.getElementById('listingTzNote')||{}).textContent||''})");
    const spin = await evaluate("(function(){var b=document.getElementById('ovRefresh');if(!b)return 'no-btn';b.click();return b.classList.contains('spin')?'spin-on':'clicked'})()");
    await sleep(12000);
    const after = await evaluate("JSON.stringify({ord:(document.getElementById('mlUpdated')||{}).textContent||'',sales:(document.getElementById('salesTzNote')||{}).textContent||'',listing:(document.getElementById('listingTzNote')||{}).textContent||'',states:[document.getElementById('mlState'),document.getElementById('salesState'),document.getElementById('listingState')].map(function(e){return e?e.textContent.trim():''})})");
    console.log('点击刷新:', spin);
    console.log('刷新前:', before);
    console.log('刷新后:', after);
    console.log('控制台错误:', errs.length ? errs : '（无）');
    console.log('失败请求:', badUrls.length ? badUrls : '（无）');

    const m = await send('Page.getLayoutMetrics'); const cs = m.cssContentSize || { height: H };
    const height = Math.min(Math.max(H, Math.ceil(cs.height) + 24), 7000);
    const r2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height, scale: SCALE } });
    const out = path.join(__dirname, 'shots', 'e2e-hub-biz.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(r2.data, 'base64'));
    console.log('截图:', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
    child.kill(); process.exit(0);
  } catch (e) { console.error('FAIL', e.message); try { child.kill(); } catch (x) { } process.exit(1); }
})();
