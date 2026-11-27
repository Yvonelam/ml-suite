/* HTML → PDF：主进程侧封装（真正干活的是 lib/pdf-worker.js，单独进程直连 CDP）
 *
 * 为什么不在这里直接连：server.js 用 undici ProxyAgent 走 Clash 代理，
 * Node 内置 WebSocket 会继承那个全局 dispatcher，连 127.0.0.1 的调试端口也会被丢给代理 →
 * 一律超时（实测三种写法全挂）。开一个不引 undici 的子进程最省事，也顺手把 Chrome 的临时 profile 隔离掉。
 *
 * 为什么不用 pdfkit：表格分页、中文换行、列宽全要手算，改一次口径就得重排；
 * 让浏览器打印的话，报告长什么样 PDF 就长什么样，样式永远只有一份。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKER = path.join(__dirname, 'pdf-worker.js');

function htmlToPdf(html, opt = {}) {
  /* 超时按内容体量估，不再固定 90 秒：
     近 30 天的报告（1567 行订单）是 620KB HTML / 约 60 页，Chrome 打印要 1~2 分钟，
     90 秒在机器忙的时候正好卡死（日志里连续几次「PDF 生成失败：Page.printToPDF 超时」）。
     底 90 秒，每 1KB 加 0.3 秒，封顶 6 分钟。 */
  const kb = Math.round(String(html || '').length / 1024);
  const timeoutMs = Number(opt.timeoutMs || Math.min(360000, 90000 + Math.min(240000, Math.round(kb * 300))));
  return new Promise((resolve, reject) => {
    const dir = require('../cdp-tmp').profileDir('ml-pdfjob-');
    const htmlFile = path.join(dir, 'report.html');
    const outFile = path.join(dir, 'report.pdf');
    fs.writeFileSync(htmlFile, html, 'utf8');

    // 环境变量里的代理全部剔掉：子进程到 127.0.0.1 必须直连
    const env = { ...process.env };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[k];
    // worker 自己的整轮上限跟着走，免得外层还在等、里层已经自己放弃了
    env.PDF_TIMEOUT_MS = String(timeoutMs);

    const child = spawn(process.execPath, [WORKER, htmlFile, outFile, opt.landscape === false ? '0' : '1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('PDF 生成超时（' + Math.round(timeoutMs / 1000) + ' 秒）')); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(String(err || out || 'PDF worker 退出码 ' + code).trim().slice(0, 300)));
      try {
        const buf = fs.readFileSync(outFile);
        if (!buf.length) return reject(new Error('生成的 PDF 是空文件'));
        resolve(buf);
      } catch (e) { reject(new Error('读不到生成的 PDF：' + e.message)); }
    });
  });
}

module.exports = { htmlToPdf };
