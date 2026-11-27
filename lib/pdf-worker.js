/* PDF worker：单独进程里跑 CDP 打印
 *
 * 为什么要独立进程：主进程（server.js）用 undici 的 ProxyAgent 走 Clash 代理访问美客多，
 * 而 Node 内置的 WebSocket 也吃那个全局 dispatcher —— 连本机 127.0.0.1 的调试端口会被代理吞掉，
 * 报「CDP 连接失败」。这个 worker 不引 undici，环境变量里也剔掉代理，连接就是直连。
 *
 * 用法：node lib/pdf-worker.js <htmlFile> <outPdfFile> [landscape]
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const [, , HTML_FILE, OUT_FILE, LAND] = process.argv;

function fail(msg) { console.error(msg); process.exit(1); }

(async () => {
  if (!HTML_FILE || !OUT_FILE) fail('用法：node lib/pdf-worker.js <html> <out.pdf> [landscape]');
  const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!browser) fail('本机没找到 Chrome / Edge');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-pdfw-'));
  const fileUrl = 'file:///' + path.resolve(HTML_FILE).replace(/\\/g, '/');
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--proxy-server=direct://', '--proxy-bypass-list=*', '--hide-scrollbars',
    '--mute-audio', '--disable-extensions', '--remote-debugging-port=0',
    '--user-data-dir=' + dir, fileUrl,
  ], { stdio: 'ignore' });

  let ws = null, wid = 0;
  const pending = new Map();
  const cleanup = () => { try { ws && ws.close(); } catch { } try { child.kill(); } catch { } try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch { } };
  const killer = setTimeout(() => { cleanup(); fail('PDF 生成超时（60 秒）'); }, 60000);

  try {
    // 端口 0 → Chrome 把实际端口写进 DevToolsActivePort（第 1 行端口号）
    let port = 0;
    const portFile = path.join(dir, 'DevToolsActivePort');
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const first = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
        if (first) { port = Number(first); break; }
      } catch { }
      await sleep(120);
    }
    if (!port) fail('Chrome 没能在 20 秒内就绪');

    // 必须拿 page target：浏览器级 ws 没有 Page 域
    let target = null;
    const th0 = Date.now();
    while (Date.now() - th0 < 20000 && !target) {
      target = await new Promise(res => {
        const req = require('http').get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, r => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => { try { res((JSON.parse(d) || []).find(x => x.type === 'page' && x.webSocketDebuggerUrl) || null); } catch { res(null); } });
        });
        req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); });
      });
      if (!target) await sleep(150);
    }
    if (!target) fail('Chrome 没有可用的页面目标');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
      setTimeout(() => rej(new Error('CDP 连接超时')), 15000);
    });
    const send = (method, params = {}) => {
      const id = ++wid;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, 45000);
      });
    };
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
    await send('Page.enable'); await send('Runtime.enable');

    for (let i = 0; i < 60; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r && r.result && r.result.value === 'complete') break;
      await sleep(150);
    }
    await sleep(600); // 字体 / 布局落定

    const landscape = LAND !== '0';
    const pdf = await send('Page.printToPDF', {
      printBackground: true,      // 少了它 KPI 底色、条形图颜色全变白
      landscape,
      paperWidth: 11.69, paperHeight: 8.27,   // A4 横向（英寸）
      marginTop: 8 / 25.4, marginBottom: 8 / 25.4, marginLeft: 8 / 25.4, marginRight: 8 / 25.4,
      displayHeaderFooter: false,
      preferCSSPageSize: false,
      scale: 1,
    });
    if (!pdf || !pdf.data) fail('Chrome 没有返回 PDF 数据');
    fs.writeFileSync(OUT_FILE, Buffer.from(pdf.data, 'base64'));
    clearTimeout(killer);
    cleanup();
    console.log('OK ' + fs.statSync(OUT_FILE).size);
    process.exit(0);
  } catch (e) {
    clearTimeout(killer);
    cleanup();
    fail('PDF 生成失败：' + ((e && e.message) || e));
  }
})();
