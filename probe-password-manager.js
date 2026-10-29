#!/usr/bin/env node
/**
 * 密码管理器触发面的回归：Chrome 只该在 login.html 的登录表单里弹「保存密码」。
 *
 * 背景（2026-10-29）：SMTP 授权码 / Secret Key / Access&Refresh Token / PushPlus Token
 * 这些框填完，Chrome 会弹「保存密码？」。根因是它们都是 input[type=password]，
 * 而 Chrome 对 autocomplete="off" 是明确忽略的。做法是这些框改 type=text + CSS 掩码
 * （-webkit-text-security:disc），Chrome 就对它们完全无感。
 *
 * 断言分两头，缺一不可：
 *   ① 业务页里**一个** type=password 都不许剩（否则 Chrome 又认出来了）
 *   ② 登录页的登录框必须**还是** type=password（那是唯一该记密码的地方）
 *
 * ⚠ 只读探针：全程不点保存、不派发 input 事件。配置区每个输入框都挂了 scheduleAutoSave，
 *   派一次 input 就会在 1.5 秒后把值写进 auth-data 的真实配置里。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DBG = 9397;
const HOST = 'http://127.0.0.1:3000';
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data/dev-login.json'), 'utf8'));
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: 3000, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { s.resume(); s.on('end', () => { const c = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); c ? res(decodeURIComponent(c.split(';')[0].slice(11))) : rej(new Error('登录失败')); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + '   → ' + JSON.stringify(extra)); } };

const SECRET_IDS = ['cfgSmtpPass', 'mlSecret', 'mlToken', 'mlRefresh', 'pushToken'];

// 读一个页面的密码管理器触发面
const SCAN = `(() => {
  const pwd = [...document.querySelectorAll('input[type=password]')].map(el => el.id || el.name || '(无 id)');
  const secret = [...document.querySelectorAll('input[data-secret]')].map(el => ({
    id: el.id || '(无 id)',
    type: el.type,
    mask: getComputedStyle(el).webkitTextSecurity || getComputedStyle(el)['-webkit-text-security'] || '',
    ac: el.getAttribute('autocomplete'),
  }));
  return { pwd, secret, supports: !!(window.CSS && CSS.supports && CSS.supports('-webkit-text-security', 'disc')) };
})()`;

(async () => {
  if (!BROWSERS.length) throw new Error('找不到 Chrome');
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-pwd-'));
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1280,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };
  const goto = async (url, ready) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) { await sleep(250); if (await ev('document.readyState')) break; }
    for (let i = 0; i < 60; i++) { if (await ev(ready)) return true; await sleep(200); }
    return false;
  };
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    /* ---------- ① 登录页：必须保留真正的 type=password ---------- */
    // 这一步必须在写入会话 cookie 之前做：login.html 发现已登录会直接 location.href 跳走，
    // 跳走以后 #login-pass 根本不存在，看起来像「密码框被删了」，其实是探针自己的顺序问题。
    console.log('\n=== login.html（唯一该让 Chrome 记密码的页面）===');
    await goto(HOST + '/login.html', 'typeof document.getElementById("login-pass") === "object"');
    const lp = await ev(`(() => { const el = document.getElementById('login-pass'); return el ? { type: el.type, ac: el.getAttribute('autocomplete') } : null; })()`);
    ok(lp && lp.type === 'password', '登录密码框仍然是 type=password（Chrome 才会弹保存）', lp);
    ok(lp && lp.ac === 'current-password', '登录密码框 autocomplete=current-password', lp && lp.ac);
    const lu = await ev(`(() => { const el = document.getElementById('login-user'); return el ? { type: el.type, ac: el.getAttribute('autocomplete') } : null; })()`);
    ok(lu && lu.ac === 'username', '登录账号框 autocomplete=username（配对才能存）', lu);

    // 从这里开始用已登录身份看业务页
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });

    /* ---------- ② 工作台：一个 password 都不许剩 ---------- */
    console.log('\n=== index.html（工作台）===');
    ok(await goto(HOST + '/index.html', 'typeof go === "function"'), '页面就绪');
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');return true})()");
    await ev("go('rank'); true"); await sleep(600);

    const scan = await ev(SCAN);
    ok(scan.pwd.length === 0, '工作台里没有任何 input[type=password]（Chrome 认不出密码框就不会弹）', scan.pwd);
    ok(scan.supports === true, '当前浏览器支持 -webkit-text-security（说明没有走 Firefox 兜底）', scan.supports);
    const seen = scan.secret.map(s => s.id);
    for (const sid of SECRET_IDS) {
      const s = scan.secret.find(x => x.id === sid);
      ok(!!s, sid + ' 已标记 data-secret', seen);
      if (s) {
        ok(s.type === 'text', sid + ' 的 type 是 text（不是 password）', s.type);
        ok(s.mask === 'disc', sid + ' 的计算样式 -webkit-text-security = disc（仍显示成圆点）', s.mask);
        ok(s.ac === 'off', sid + ' 带 autocomplete=off', s.ac);
      }
    }
    // 值本身照常可读写 —— 改类型不能影响业务逻辑（它们全靠 .value）
    const rt = await ev(`(() => { const el = document.getElementById('cfgSmtpPass'); el.value = 'abcd1234'; const v = el.value; el.value = ''; return v; })()`);
    ok(rt === 'abcd1234', '改类型后 .value 照常可读写（业务逻辑不受影响）', rt);

    /* ---------- ③ 切换账户弹窗 ---------- */
    console.log('\n=== index.html 切换账户弹窗 ===');
    await ev("(function(){var d=document.getElementById('accountSwitchDialog');if(d)d.hidden=false;return true})()");
    await sleep(300);
    const dlg = await ev(SCAN);
    ok(dlg.pwd.length === 0, '切换账户弹窗里没有 input[type=password]', dlg.pwd);
    const sp = dlg.secret.find(s => s.id === 'accountSwitchPass');
    ok(!!sp && sp.mask === 'disc', '切换账户的密码框仍显示成圆点', sp);
    const su = await ev(`(() => { const el = document.getElementById('accountSwitchUser'); return el ? el.getAttribute('autocomplete') : null; })()`);
    ok(su === 'off', '切换账户的账号框改成 autocomplete=off（不再弹已存账号列表）', su);

    /* ---------- ④ 管理员页 ---------- */
    console.log('\n=== admin.html（管理员工作区）===');
    await goto(HOST + '/admin.html', '!!document.getElementById("switchPassword")');
    await ev("(function(){var d=document.getElementById('switchShade');if(d)d.hidden=false;return true})()");
    await sleep(300);
    const adm = await ev(SCAN);
    ok(adm.pwd.length === 0, '管理员页没有任何 input[type=password]', adm.pwd);
    const asp = adm.secret.find(s => s.id === 'switchPassword');
    ok(!!asp && asp.mask === 'disc', '管理员切换账户的密码框显示成圆点', asp);

    /* ---------- ⑤ 截图：填了值以后确实是圆点 ---------- */
    console.log('\n=== 截图 ===');
    await goto(HOST + '/index.html', 'typeof go === "function"');
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');return true})()");
    await ev("go('rank'); true"); await sleep(600);
    // 邮件配置在「定时报告」这个子 tab 里，不切过去元素是 display:none，截图会拍成一片背景
    await ev(`(() => { const b = document.querySelector('.tabs button[data-m="cfg"]'); if (b) b.click(); return true; })()`);
    await sleep(600);
    // 只写 .value，不派发 input —— 派了就会触发 scheduleAutoSave，把值写进真实配置
    await ev(`(() => { const el = document.getElementById('cfgSmtpPass'); el.value = 'abcdefghijklmnop'; el.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(400);
    // getBoundingClientRect 是视口坐标：不先滚进视口，clip 会裁到一片空白背景
    const rect = await ev(`(() => { const r = document.getElementById('cfgSmtpPass').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight, vis: getComputedStyle(document.getElementById('cfgSmtpPass')).visibility, disp: getComputedStyle(document.getElementById('cfgSmtpPass')).display }; })()`);
    console.log('  输入框位置：' + JSON.stringify(rect));
    // 整屏截图，再把元素位置打出来 —— 裁剪容易因为内层滚动容器算偏，
    // 整屏最直观：用户自己看那一行就知道是不是圆点
    const shot = await Promise.race([send('Page.captureScreenshot', { format: 'png', fromSurface: true }), sleep(20000).then(() => { throw new Error('截图超时'); })]);
    const f = path.join(__dirname, 'probe-out', 'password-masked.png');
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (e) { }
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log('  已保存：' + f + '（SMTP 授权码框填入 16 位字符串，应为圆点）');

    console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
