/* HTML → PDF（用本机 Chrome/Edge 的 CDP 打印，不引任何 npm 依赖）
 *
 * 为什么不用 pdfkit / puppeteer：
 *  - pdfkit 要自己排版表格分页，中文换行、列宽全靠手算，改一次口径就得重排一遍；
 *    直接让浏览器打印，报告长什么样 PDF 就长什么样，样式永远只有一份。
 *  - puppeteer 要额外下一个 Chromium（几百 MB）。本机已经有 Chrome，用 --remote-debugging-port=0
 *    拿 DevToolsActivePort 连上去，调 Page.printToPDF 即可。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function findBrowser() {
  for (const p of BROWSERS) { try { if (fs.existsSync(p)) return p; } catch { } }
  return '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} html  完整 HTML 文档
 * @param {object} opt   { landscape=true, paperWidth, paperHeight, marginMm, timeoutMs }
 * @returns {Promise<Buffer>} PDF 字节
 */
async function htmlToPdf(html, opt = {}) {
  const browser = findBrowser();
  if (!browser) throw new Error('本机没找到 Chrome / Edge，无法生成 PDF');
  const landscape = opt.landscape !== false;
  const marginMm = Number(opt.marginMm || 8);
  const timeoutMs = Number(opt.timeoutMs || 60000);
  const dir = require('../cdp-tmp').profileDir('ml-pdf-');
  const file = path.join(dir, 'report.html');
  fs.writeFileSync(file, html, 'utf8');
  const fileUrl = 'file:///' + file.replace(/\\/g, '/');

  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    '--remote-debugging-port=0', '--user-data-dir=' + dir, fileUrl,
  ];
  let child = null, ws = null, wid = 0;
  const pending = new Map();
  const cleanup = () => { try { ws && ws.close(); } catch { } try { child && child.kill(); } catch { } };
  const timer = setTimeout(() => { cleanup(); }, timeoutMs);
  try {
    child = spawn(browser, args, { stdio: 'ignore' });
    // 端口是 0 → 浏览器把实际端口写进 DevToolsActivePort（第 1 行端口，第 2 行 ws 路径）
    const portFile = path.join(dir, 'DevToolsActivePort');
    let port = 0, wsPath = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const txt = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        if (txt[0]) { port = Number(txt[0]); wsPath = txt[1] || ''; break; }
      } catch { }
      await sleep(120);
    }
    if (!port) throw new Error('Chrome 没能在 20 秒内就绪');
    /* DevToolsActivePort 第二行是 **浏览器级** 的 ws 路径，连上去没有 Page 域
       （报 "Page.enable wasn't found"）。要打印必须拿 page target 的 ws 地址，
       所以再走一次 /json/list —— 和探针脚本用的是同一套。 */
    let target = null;
    const th0 = Date.now();
    while (Date.now() - th0 < 20000) {
      try {
        const list = await new Promise((res, rej) => {
          const req = require('http').get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
          });
          req.on('error', rej); req.on('timeout', () => req.destroy(new Error('timeout')));
        });
        target = (list || []).find(x => x.type === 'page' && x.webSocketDebuggerUrl);
        if (target) break;
      } catch { }
      await sleep(150);
    }
    if (!target) throw new Error('Chrome 没有可用的页面目标');
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
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, timeoutMs);
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

    // 文档可能在我们连上之前就 load 完了，所以轮询 readyState 而不是等事件
    for (let i = 0; i < 60; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r && r.result && r.result.value === 'complete') break;
      await sleep(150);
    }
    await sleep(600); // 留一点时间给字体与布局

    const pdf = await send('Page.printToPDF', {
      printBackground: true,          // 不加这个，KPI 卡片底色、条形图颜色全变白
      preferCSSPageSize: false,
      landscape,
      paperWidth: Number(opt.paperWidth || 11.69),   // A4 横向（英寸）
      paperHeight: Number(opt.paperHeight || 8.27),
      marginTop: marginMm / 25.4, marginBottom: marginMm / 25.4,
      marginLeft: marginMm / 25.4, marginRight: marginMm / 25.4,
      displayHeaderFooter: false,
      scale: Number(opt.scale || 1),
    });
    if (!pdf || !pdf.data) throw new Error('Chrome 没有返回 PDF 数据');
    return Buffer.from(pdf.data, 'base64');
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

module.exports = { htmlToPdf, findBrowser };
