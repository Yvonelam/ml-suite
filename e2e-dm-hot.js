'use strict';
/* E2E：验证「实时热搜词」面板是否渲染了大麦真实数据 + 抓 console 报错 + 截图 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const BASE = 'http://127.0.0.1:3000/';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-dm-'));

const get = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
  '--window-size=1440,1200', '--user-data-dir=' + userDir, 'about:blank',
], { stdio: 'ignore' });

(async () => {
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/version')); if (ver) break; } catch (e) { }
    await sleep(250);
  }
  if (!ver) throw new Error('Chrome 未就绪');

  const targets = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json/list'));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let msgId = 0; const pending = new Map(); const errors = []; const reqs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('[exception] ' + (d.exception && d.exception.description || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('[console.error] ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Network.requestWillBeSent' && /\/api\/dm\//.test(m.params.request.url)) {
      reqs.push(m.params.request.url);
    }
  });
  const send = (method, params) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const evalx = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(9000);   // 等 SPA 初始化 + 拉热搜词

  const panel = await evalx(`(() => {
    const rows = [...document.querySelectorAll('#rl .rw')];
    return {
      sub: (document.querySelector('#v-hub .card .ch span')||{}).textContent || '',
      status: (document.querySelector('#lvs')||{}).textContent || '',
      btn: (document.querySelector('#lvb')||{}).textContent || '',
      src: (document.querySelector('#lvsrc')||{}).textContent || '',
      time: (document.querySelector('#lvt')||{}).textContent || '',
      rows: rows.map(r => ({
        rank: (r.querySelector('.rn')||{}).textContent,
        kw: (r.querySelector('.nm b')||{}).textContent,
        label: (r.querySelector('.nm small')||{}).textContent,
        heat: (r.querySelector('.vol span')||{}).textContent,
        delta: (r.querySelector('.dl')||{}).textContent
      }))
    };
  })()`);

  console.log('=== 面板副标题 ===\n' + panel.sub);
  console.log('=== 状态/按钮 ===\n' + panel.status + ' | ' + panel.btn);
  console.log('=== 数据来源行 ===\n' + panel.src);
  console.log('=== 更新时间 ===\n' + panel.time);
  console.log('=== 榜单 ===');
  panel.rows.forEach((r) => console.log(`  ${r.rank}. ${r.kw}  [${r.label}]  热度 ${r.heat}  ${r.delta}`));
  console.log('\n=== /api/dm/ 请求 ===\n' + (reqs.join('\n') || '(无)'));
  console.log('\n=== console 报错 (' + errors.length + ') ===\n' + (errors.join('\n') || '(无)'));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(OUT, 'dm-hot-keywords.png');
  fs.writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
  console.log('\n截图(整页): ' + f);

  // 再单独把「实时热搜词」那张卡片截出来（用页面绝对坐标 + captureBeyondViewport）
  const rect = await evalx(`(() => {
    const card = document.querySelector('#rl').closest('.card');
    const r = card.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
  })()`);
  const shot2 = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: Math.max(0, rect.x - 10), y: Math.max(0, rect.y - 10), width: rect.w + 20, height: rect.h + 20, scale: 2 },
  });
  const f2 = path.join(OUT, 'dm-hot-keywords-card.png');
  fs.writeFileSync(f2, Buffer.from(shot2.result.data, 'base64'));
  console.log('截图(卡片): ' + f2 + '  rect=' + JSON.stringify(rect));

  try { await send('Browser.close'); } catch (e) { }
  try { chrome.kill(); } catch (e) { }
  fs.rmSync(userDir, { recursive: true, force: true });
})().catch((e) => { console.error('FATAL', e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
