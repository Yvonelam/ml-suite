#!/usr/bin/env node
/**
 * 关键词自动回复弹窗的「抗刷新」回归。
 *
 * 用户反馈（2026-10-30）：在弹窗里编辑某条规则时，售前那 30 秒一次的自动刷新会把
 * 自动回复界面关掉，正在填的关键词/回复文本直接没了。
 *
 * 这个探针把「刷新」这件事拆成三层分别打一遍，定位到底哪一层动的：
 *   ① loadQuestions()      —— 30 秒定时器真正做的事
 *   ② loadQuestionAutoReply() —— 切回问答页时会做的事
 *   ③ 真实等待 35 秒，让 setInterval 自己触发一次
 * 每层之后都断言：弹窗还开着、编辑器还开着、已填的文字还在。
 *
 * ⚠ 只读探针：不点「保存并应用」，不派发任何会触发写库的事件。
 *   （编辑器里的输入框本身没有 input 监听，写 .value 不会把 dirty 置位，也不会有自动保存）
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
  return {
    modalOpen: !!m && !m.hidden,
    editorOpen: !!ed && !ed.hidden,
    text: tx ? tx.value : null,
    keywords: kw ? kw.value : null,
    editingId: (window.questionAutoReplyView && questionAutoReplyView.editingId) || null,
    focused: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    confirms: window.__probeConfirms || 0,
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
    // confirm 打桩：真有东西想关弹窗时，dirty 保护会弹 confirm，这里统计次数而不是让人卡住
    await ev(`(function(){ window.__probeConfirms = 0; window.confirm = function(){ window.__probeConfirms++; return false; }; return true; })()`);
    await ev("go('questions'); true"); await sleep(1500);

    /* ---------- 打开弹窗 + 进入编辑 ---------- */
    console.log('\n=== 打开自动回复弹窗，点「编辑」第一条规则 ===');
    const opened = await ev(`(() => { const b = document.getElementById('questionAutoReplyOpen'); if (!b) return 'no-open-btn'; b.click(); return 'ok'; })()`);
    ok(opened === 'ok', '打开按钮存在', opened);
    await sleep(1200);
    const editHit = await ev(`(() => { const b = document.querySelector('#questionAutoReplyRules button[data-qauto-edit]'); if (!b) return 'no-edit-btn'; b.click(); return 'ok'; })()`);
    ok(editHit === 'ok', '第一条规则有「编辑」按钮', editHit);
    await sleep(500);
    // 伪造一段正在填写的内容（只写 .value，不派发事件，避免任何自动保存）
    await ev(`(function(){ document.getElementById('questionAutoReplyKeywords').value = 'PROBE-KW-A, PROBE-KW-B'; document.getElementById('questionAutoReplyText').value = 'PROBE-DRAFT-请勿保存'; return true; })()`);
    await sleep(200);

    const base = await ev(SNAP);
    console.log('  基线：' + JSON.stringify(base));
    ok(base.modalOpen && base.editorOpen, '基线下弹窗和编辑器都是打开的', base);
    ok(base.text === 'PROBE-DRAFT-请勿保存', '基线下已填的回复文本在', base.text);

    const check = async (label) => {
      const s = await ev(SNAP);
      ok(s.modalOpen, label + '：弹窗仍然开着', s);
      ok(s.editorOpen, label + '：编辑器没有被收起', s);
      ok(s.text === 'PROBE-DRAFT-请勿保存', label + '：已填的回复文本没被清掉', s.text);
      ok(s.keywords === 'PROBE-KW-A, PROBE-KW-B', label + '：已填的关键词没被清掉', s.keywords);
      ok(s.confirms === 0, label + '：没有触发「未保存就关闭」的确认框', s.confirms);
      return s;
    };

    /* ---------- ① 定时器真正做的事 ---------- */
    console.log('\n=== ① 触发 loadQuestions()（30 秒定时器做的事）===');
    await ev('loadQuestions(); true'); await sleep(2500);
    await check('loadQuestions');

    /* ---------- ② 切回问答页时做的事 ---------- */
    console.log('\n=== ② 触发 loadQuestionAutoReply()（切回问答页做的事）===');
    await ev('loadQuestionAutoReply(); true'); await sleep(1500);
    const s2 = await check('loadQuestionAutoReply');
    ok(s2.editingId === base.editingId, '②：editingId 没被重置（重新拉规则不能把编辑上下文冲掉）', { before: base.editingId, after: s2.editingId });

    /* ---------- ③ 真实等待定时器 ---------- */
    console.log('\n=== ③ 真实等 35 秒，让 30 秒定时器自己触发一次 ===');
    const before = await ev(SNAP);
    await sleep(35000);
    const after = await ev(SNAP);
    ok(after.modalOpen, '③：真实定时器触发后弹窗仍开着', after);
    ok(after.editorOpen, '③：编辑器仍开着', after);
    ok(after.text === before.text && after.text === 'PROBE-DRAFT-请勿保存', '③：回复文本仍是刚才填的', { before: before.text, after: after.text });

    console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
