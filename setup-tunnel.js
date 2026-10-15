#!/usr/bin/env node
/**
 * 下载 cloudflared 隧道程序到 tools/cloudflared.exe
 * 会自动尝试直连，以及常见的本地代理端口（Clash 7897 等）。
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'tools', 'cloudflared.exe');
const URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

const PROXIES = [
  null,
  process.env.HTTPS_PROXY || process.env.https_proxy,
  'http://127.0.0.1:7897',
  'http://127.0.0.1:7890',
].filter(Boolean);

fs.mkdirSync(path.dirname(OUT), { recursive: true });

if (fs.existsSync(OUT) && fs.statSync(OUT).size > 30 * 1024 * 1024) {
  console.log('cloudflared 已存在，跳过下载：' + OUT);
  process.exit(0);
}

function download(proxyUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('重定向次数过多'));
    const opts = {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    };
    let agentMod = https;
    if (proxyUrl) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        opts.agent = new HttpsProxyAgent(proxyUrl);
      } catch (e) { /* 未安装则忽略代理 */ }
    }
    https.get(URL, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(proxyUrl, redirectCount + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, lastPct = -1;
      const ws = fs.createWriteStream(OUT);
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor(got / total * 100);
          if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write('  ' + pct + '%\r'); }
        }
      });
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  for (const proxy of PROXIES) {
    try {
      console.log('尝试下载 cloudflared' + (proxy ? ' （经代理 ' + proxy + '）' : ' (直连)') + ' ...');
      await download(proxy);
      const size = fs.statSync(OUT).size;
      if (size < 30 * 1024 * 1024) throw new Error('文件不完整 (' + size + ' 字节)');
      console.log('\n下载完成: ' + OUT + ' (' + Math.round(size / 1048576) + ' MB)');
      process.exit(0);
    } catch (e) {
      console.log('  失败: ' + e.message);
      try { fs.unlinkSync(OUT); } catch (_) { }
    }
  }
  console.error('\n下载失败。请手动下载 cloudflared-windows-amd64.exe 并放到 tools/cloudflared.exe');
  console.error('下载地址: ' + URL);
  process.exit(1);
})();
