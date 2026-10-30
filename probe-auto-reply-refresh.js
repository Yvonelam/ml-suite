#!/usr/bin/env node
/**
 * 关键词自动回复弹窗的「抗刷新」回归。
 *
 * 用户反馈（2026-10-30）：在弹窗里编辑某条规则时，售前那 30 秒一次的自动刷新会把
 * 自动回复界面关掉，正在填的关键词/回复文本直接没了。
 *
 * 实测「刷新」本身并没有调用 closeQuestionAutoReply，但同一类问题是真的：
 *   ① loadQuestionAutoReply() 会把服务端 rules **整个替换**本地数组 ——
 *      用户在弹窗里刚加/改的规则，下一次切页或刷新就凭空消失；
 *   ② 编辑器里的草稿没有任何保护，弹窗被任何原因关掉就静默丢了。
 * 所以修法是三层：
 *   A. 弹窗开着时，售前 30 秒定时器直接让路（不刷新列表）
 *   B. 有未保存改动时，loadQuestionAutoReply() 不覆盖本地规则（force 才刷）
 *   C. 编辑器一动手就置 editorDirty：关闭要 confirm，状态栏也会提示
 *
 * ⚠ 只读探针：全程不点「保存并应用」，也不会派发任何写库事件。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DBG = 9398;
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

const SNAP = `(() => {
  const m = document.getElementById('questionAutoReplyModal');
  const ed = document.getElementById('questionAutoReplyEditor');
  const tx = document.getElementById('questionAutoReplyText');
  const kw = document.getElementById('questionAutoReplyKeywords');
  const st = document.getElementById('questionAutoReplyState');
  return {
    modalOpen: !!m && !m.hidden,
    editorOpen: !!ed && !ed.hidden,
    text: tx ? tx.value : null,
    keywords: kw ? kw.value : null,
    ruleCount: document.querySelectorAll('#questionAutoReplyRules .qauto-rule').length,
    editorDirty: (typeof questionAutoReplyView !== 'undefined' ? questionAutoReplyView.editorDirty : null),
    dirty: (typeof questionAutoReplyView !== 'undefined' ? questionAutoReplyView.dirty : null),
    statusText: st ? st.textContent : '',
    confirms: window.__probeConfirms || 0,
    loadQCalls: window.__probeLoadQ || 0,
  };
})()`;

(async () => {
  if (!BROWSERS.length) throw new Error('找不到 Chrome');
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-qref-'));
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1280,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };
  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#questions' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 60; i++) { if (await ev('typeof go === "function"')) break; await sleep(200); }
    await ev("(function(){var s=document.getElementById('splash');if(s)s.style.setProperty('display','none','important');return true})()");
    // 打桩：confirm 计数（默认拒绝，模拟用户点「取消」）；loadQuestions 计数
    await ev(`(function(){
      window.__probeConfirms = 0; window.__probeAllowClose = false;
      window.confirm = function(){ window.__probeConfirms++; return window.__probeAllowClose; };
      window.__probeLoadQ = 0;
      var orig = window.loadQuestions;
      window.loadQuestions = function(){ window.__probeLoadQ++; return orig.apply(this, arguments); };
      return true;
    })()`);
    await ev("go('questions'); true"); await sleep(1500);

    /* ---------- 打开弹窗 + 进入编辑 + 真的打字 ---------- */
    console.log('\n=== 打开弹窗，编辑第一条规则，模拟真实打字 ===');
    await ev(`(function(){ document.getElementById('questionAutoReplyOpen').click(); return true; })()`);
    await sleep(1200);
    const editHit = await ev(`(() => { const b = document.querySelector('#questionAutoReplyRules button[data-qauto-edit]'); if (!b) return 'no-edit-btn'; b.click(); return 'ok'; })()`);
    ok(editHit === 'ok', '存在「编辑」按钮且点击生效', editHit);
    await sleep(500);
    // 用 input 事件模拟真实按键：这正是新加的 editorDirty 触发器
    await ev(`(function(){
      const kw = document.getElementById('questionAutoReplyKeywords'), tx = document.getElementById('questionAutoReplyText');
      kw.value = 'PROBE-KW-A, PROBE-KW-B'; kw.dispatchEvent(new Event('input', { bubbles: true }));
      tx.value = 'PROBE-DRAFT-请勿保存'; tx.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);

    const base = await ev(SNAP);
    console.log('  基线：' + JSON.stringify(base));
    ok(base.modalOpen && base.editorOpen, '基线下弹窗和编辑器都是打开的', base);
    ok(base.editorDirty === true, '打字后 editorDirty = true（新加的保护生效）', base.editorDirty);
    ok(/保存规则/.test(base.statusText), '状态栏提示「正在编辑的规则还没保存」', base.statusText);

    /* ---------- A. 手动刷新列表 ---------- */
    console.log('\n=== A. 触发 loadQuestions()（30 秒定时器做的事）===');
    await ev('loadQuestions(); true'); await sleep(2500);
    let s = await ev(SNAP);
    ok(s.modalOpen && s.editorOpen, 'A：弹窗和编辑器都还开着', s);
    ok(s.text === 'PROBE-DRAFT-请勿保存' && s.keywords === 'PROBE-KW-A, PROBE-KW-B', 'A：已填的草稿一字没丢', s);

    /* ---------- B. 重新拉服务端规则 ---------- */
    console.log('\n=== B. 触发 loadQuestionAutoReply()（切回问答页做的事）===');
    // 先在本地加一条规则（只改内存，不落库），看看会不会被服务端数据冲掉
    await ev(`(function(){
      document.getElementById('questionAutoReplyAdd').click();
      const kw = document.getElementById('questionAutoReplyKeywords'), tx = document.getElementById('questionAutoReplyText');
      kw.value = 'PROBE-LOCAL-ONLY'; tx.value = 'probe local draft';
      document.getElementById('questionAutoReplySaveRule').click();
      return true;
    })()`);
    await sleep(400);
    const beforeB = await ev(SNAP);
    ok(beforeB.ruleCount > base.ruleCount, 'B：本地新增的规则已进列表（内存里）', { before: base.ruleCount, after: beforeB.ruleCount });
    // 保存规则会收起编辑器，这里重新打开并再打一遍草稿，好验证「草稿 + 本地新增」都能扛住刷新
    await ev(`(function(){
      document.querySelector('#questionAutoReplyRules button[data-qauto-edit]').click();
      const kw = document.getElementById('questionAutoReplyKeywords'), tx = document.getElementById('questionAutoReplyText');
      kw.value = 'PROBE-KW-A, PROBE-KW-B'; kw.dispatchEvent(new Event('input', { bubbles: true }));
      tx.value = 'PROBE-DRAFT-请勿保存'; tx.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    await ev('loadQuestionAutoReply(); true'); await sleep(1500);
    s = await ev(SNAP);
    ok(s.ruleCount === beforeB.ruleCount, 'B：本地新增的规则没有被服务端数据冲掉', { before: beforeB.ruleCount, after: s.ruleCount });
    ok(s.editorOpen && s.text === 'PROBE-DRAFT-请勿保存', 'B：编辑器与草稿仍在', s);
    ok(s.dirty === true, 'B：dirty 没有被重置成 false（未保存状态要留住）', s.dirty);

    /* ---------- C. 带草稿关闭要拦一下 ---------- */
    console.log('\n=== C. 有草稿时点关闭，应该被 confirm 拦住 ===');
    await ev(`(function(){ document.getElementById('questionAutoReplyClose').click(); return true; })()`);
    await sleep(400);
    s = await ev(SNAP);
    ok(s.confirms >= 1, 'C：弹出了「有未保存修改」的确认框', s.confirms);
    ok(s.modalOpen === true, 'C：用户在确认框上点取消后，弹窗不能关掉', s.modalOpen);

    /* ---------- D. 弹窗开着时，定时器必须让路 ---------- */
    console.log('\n=== D. 弹窗开着，等 35 秒看定时器会不会偷偷刷新 ===');
    await ev('window.__probeLoadQ = 0; true');
    await sleep(35000);
    s = await ev(SNAP);
    ok(s.loadQCalls === 0, 'D：35 秒内 loadQuestions 一次都没被定时器调用（让路生效）', s.loadQCalls);
    ok(s.modalOpen && s.text === 'PROBE-DRAFT-请勿保存', 'D：弹窗和草稿都完好', s);

    /* ---------- E. 关掉弹窗后，定时器要恢复工作 ---------- */
    console.log('\n=== E. 关掉弹窗，再等 35 秒，定时器必须恢复刷新 ===');
    await ev('window.__probeAllowClose = true; true');
    await ev(`(function(){ document.getElementById('questionAutoReplyClose').click(); return true; })()`);
    await sleep(600);
    s = await ev(SNAP);
    ok(s.modalOpen === false, 'E：允许关闭后弹窗确实关掉了', s.modalOpen);
    await ev('window.__probeLoadQ = 0; true');
    await sleep(35000);
    s = await ev(SNAP);
    ok(s.loadQCalls >= 1, 'E：关掉弹窗后定时器恢复刷新（没有把刷新永久掐死）', s.loadQCalls);

    console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
