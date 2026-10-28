#!/usr/bin/env node
/**
 * 自动回复规则弹窗：编辑 / 删除 / 上移 / 新增 四条操作路径的真实浏览器回归。
 * 全部改动只在内存里，不点「保存并应用」，不污染账号里的真实规则。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DBG = 9394;
const HOST = 'http://127.0.0.1:3000';
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data/dev-login.json'), 'utf8'));
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: 3000, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  if (!BROWSERS.length) throw new Error('找不到 Chrome');
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-qauto-'));
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1440,980', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };
  const wait = async (expr, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(200); } return false; };

  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 2, mobile: false });
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    await wait("typeof go === 'function'", 20000);
    await ev("(function(){var s=document.getElementById('splash');if(s){s.style.setProperty('display','none','important')}return true})()");

    // ── 自动回复弹窗从问答视图打开
    await ev("go('questions'); true");
    await ev('window.confirm = () => true; true');   // 覆盖 dirty 确认与删除确认
    await sleep(800);
    await ev("document.getElementById('questionAutoReplyOpen').click(); true");
    const opened = await wait("document.getElementById('questionAutoReplyModal').hidden === false && document.querySelectorAll('#questionAutoReplyRules .qauto-rule').length > 0", 15000);
    ok(opened, '弹窗打开并渲染出规则列表');
    if (!opened) throw new Error('没能加载规则列表，后面的断言不用做了');

    const n0 = await ev("document.querySelectorAll('#questionAutoReplyRules .qauto-rule').length");
    console.log('  （账号里现有 ' + n0 + ' 条规则）');

    // ── A. 每条规则的操作按钮完整性
    console.log('\n=== A. 按钮结构 ===');
    const btns = await ev(`(() => [...document.querySelectorAll('#questionAutoReplyRules .qauto-rule')].map(r => {
      const b = [...r.querySelectorAll('.qauto-actions button')];
      return {
        edit: b.filter(x => x.textContent.trim() === '编辑').map(x => !!x.dataset.id),
        del: b.filter(x => x.textContent.trim() === '删除').map(x => !!x.dataset.id),
        move: b.filter(x => /^[↑↓]$/.test(x.textContent.trim())).map(x => !!x.dataset.id),
      };
    }))()`);
    ok(btns.every(r => r.edit.length === 1 && r.edit[0]), '每条规则的「编辑」按钮都带 data-id（缺了会静默失效）', btns.map(r => r.edit));
    ok(btns.every(r => r.del.length === 1 && r.del[0]), '每条规则的「删除」按钮都带 data-id', btns.map(r => r.del));
    ok(btns.every(r => r.move.length === 2 && r.move.every(Boolean)), '每条规则的 ↑↓ 按钮都带 data-id', btns.map(r => r.move));

    // ── B. 点「编辑」→ 编辑器展开并预填
    console.log('\n=== B. 编辑 ===');
    const first = await ev(`(() => { const r = document.querySelector('#questionAutoReplyRules .qauto-rule');
      return { kw: [...r.querySelectorAll('.qauto-key')].map(x => x.textContent), reply: r.querySelector('.qauto-reply').textContent }; })()`);
    await ev(`(() => { const r = document.querySelector('#questionAutoReplyRules .qauto-rule');
      [...r.querySelectorAll('.qauto-actions button')].find(x => x.textContent.trim() === '编辑').click(); return true; })()`);
    await sleep(400);
    const ed = await ev(`(() => ({
      hidden: document.getElementById('questionAutoReplyEditor').hidden,
      title: document.getElementById('questionAutoReplyEditorTitle').textContent,
      kw: document.getElementById('questionAutoReplyKeywords').value,
      reply: document.getElementById('questionAutoReplyText').value,
      editingId: questionAutoReplyView.editingId,
      focused: document.activeElement === document.getElementById('questionAutoReplyKeywords'),
    }))()`);
    ok(ed.hidden === false, '点「编辑」后编辑器展开（之前这里完全没反应）', ed.hidden);
    ok(ed.title === '编辑回复规则', '编辑器标题 = 编辑回复规则', ed.title);
    ok(ed.kw === first.kw.join('，'), '关键词按「，」回填', { got: ed.kw, want: first.kw.join('，') });
    ok(ed.reply === first.reply, '回复文本回填（与列表显示一致）', { got: String(ed.reply).slice(0, 40), want: String(first.reply).slice(0, 40) });
    ok(!!ed.editingId, 'editingId 已记录（保存时走更新而不是新增）', ed.editingId);

    // 编辑态截图，人工确认一眼
    {
      const shot = await Promise.race([send('Page.captureScreenshot', { format: 'png', fromSurface: true }), sleep(20000).then(() => { throw new Error('截图超时'); })]);
      const f = path.join(__dirname, 'probe-out', 'auto-reply-edit.png');
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (e) { }
      fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
      console.log('  （截图：' + f + '）');
    }

    // ── C. 改了再保存草稿 → 列表就地更新
    console.log('\n=== C. 改完保存草稿 ===');
    await ev(`(function(){var t=document.getElementById('questionAutoReplyText');t.value='__PROBE_EDITED__';return true})()`);
    await ev("document.getElementById('questionAutoReplySaveRule').click(); true");
    await sleep(300);
    const after = await ev(`(() => ({
      replyShown: document.querySelector('#questionAutoReplyRules .qauto-rule .qauto-reply').textContent,
      editorHidden: document.getElementById('questionAutoReplyEditor').hidden,
      dirty: questionAutoReplyView.dirty,
      count: document.querySelectorAll('#questionAutoReplyRules .qauto-rule').length,
    }))()`);
    ok(after.replyShown === '__PROBE_EDITED__', '列表第一条的回复已更新为修改后的内容', after.replyShown);
    ok(after.editorHidden === true, '保存草稿后编辑器收起', after.editorHidden);
    ok(after.count === n0, '保存草稿不会多出一条新规则（走的是更新分支）', { got: after.count, want: n0 });
    ok(after.dirty === true, '标记为未保存（脏标记）', after.dirty);

    // ── D. 关掉重开 → 服务端原值回来（确认没落盘）
    console.log('\n=== D. 取消后重开（不污染真实数据）===');
    await ev("document.getElementById('questionAutoReplyClose').click(); true");
    await sleep(500);
    await ev("document.getElementById('questionAutoReplyOpen').click(); true");
    await wait("document.querySelectorAll('#questionAutoReplyRules .qauto-rule').length > 0", 12000);
    const restored = await ev(`(() => ({
      reply: document.querySelector('#questionAutoReplyRules .qauto-rule .qauto-reply').textContent,
      dirty: questionAutoReplyView.dirty,
    }))()`);
    ok(restored.reply === first.reply, '重开后恢复服务端原值（探针没有写入账号）', String(restored.reply).slice(0, 40));
    ok(restored.dirty === false, '重开后脏标记被清掉', restored.dirty);

    // ── E. 删除
    console.log('\n=== E. 删除 ===');
    const delId = await ev(`(() => { const r = document.querySelectorAll('#questionAutoReplyRules .qauto-rule')[1];
      [...r.querySelectorAll('.qauto-actions button')].find(x => x.textContent.trim() === '删除').click(); return true; })()`);
    await sleep(400);
    const afterDel = await ev("document.querySelectorAll('#questionAutoReplyRules .qauto-rule').length");
    ok(afterDel === n0 - 1, '点「删除」后规则少一条（之前同样因为缺 data-id 而失效）', { got: afterDel, want: n0 - 1 });

    // ── F. 上移
    console.log('\n=== F. 上移 ===');
    const order0 = await ev("[...document.querySelectorAll('#questionAutoReplyRules .qauto-rule')].map(r => r.querySelector('.qauto-key').textContent)");
    await ev(`(() => { const r = document.querySelectorAll('#questionAutoReplyRules .qauto-rule')[1];
      [...r.querySelectorAll('.qauto-actions button')].find(x => x.textContent.trim() === '↑').click(); return true; })()`);
    await sleep(400);
    const order1 = await ev("[...document.querySelectorAll('#questionAutoReplyRules .qauto-rule')].map(r => r.querySelector('.qauto-key').textContent)");
    ok(order1[0] === order0[1] && order1[1] === order0[0], '↑ 把第二条挪到第一位（规则顺序影响命中优先级）', { before: order0.slice(0, 2), after: order1.slice(0, 2) });

    // ── G. 新增
    console.log('\n=== G. 新增 ===');
    await ev("document.getElementById('questionAutoReplyAdd').click(); true");
    await sleep(400);
    const add = await ev(`(() => ({
      hidden: document.getElementById('questionAutoReplyEditor').hidden,
      title: document.getElementById('questionAutoReplyEditorTitle').textContent,
      kw: document.getElementById('questionAutoReplyKeywords').value,
      reply: document.getElementById('questionAutoReplyText').value,
      editingId: questionAutoReplyView.editingId,
    }))()`);
    ok(add.hidden === false, '点「＋ 添加规则」后编辑器展开', add.hidden);
    ok(add.title === '新增回复规则', '标题 = 新增回复规则', add.title);
    ok(add.kw === '' && add.reply === '', '新增时输入框是空的', { kw: add.kw, reply: add.reply });
    ok(!add.editingId, 'editingId 为空（走新增分支）', add.editingId);

    // 新增一条并计数
    await ev(`(function(){document.getElementById('questionAutoReplyKeywords').value='probe-kw';document.getElementById('questionAutoReplyText').value='probe-reply';return true})()`);
    await ev("document.getElementById('questionAutoReplySaveRule').click(); true");
    await sleep(400);
    const cnt2 = await ev("document.querySelectorAll('#questionAutoReplyRules .qauto-rule').length");
    ok(cnt2 === afterDel + 1, '新增后规则多一条', { got: cnt2, want: afterDel + 1 });

    // ── H. 取消编辑
    console.log('\n=== H. 取消 ===');
    await ev("document.getElementById('questionAutoReplyAdd').click(); true");
    await sleep(250);
    await ev("document.getElementById('questionAutoReplyCancelEdit').click(); true");
    await sleep(250);
    const cancel = await ev(`(() => ({
      hidden: document.getElementById('questionAutoReplyEditor').hidden,
      kw: document.getElementById('questionAutoReplyKeywords').value,
      editingId: questionAutoReplyView.editingId,
    }))()`);
    ok(cancel.hidden === true, '「取消」收起编辑器', cancel.hidden);
    ok(cancel.kw === '' && !cancel.editingId, '「取消」清空输入并复位 editingId', cancel);

    // ── 收尾：关闭弹窗，不留脏状态
    await ev("document.getElementById('questionAutoReplyClose').click(); true");
    await sleep(300);
    console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
