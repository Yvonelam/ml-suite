#!/usr/bin/env node
/**
 * ML Suite · 公网服务停止器
 * 结束本地 Express 服务（占用 3000 端口）与 Cloudflare 隧道进程。
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return '';
  }
}

function banner(msg) {
  const line = '='.repeat(60);
  console.log('\n' + line + '\n  ' + msg + '\n' + line);
}

banner('正在停止 ML Suite 公网服务');

// ---- 0. 先写下「停止」标记 ----
// start-public.js 现在带自动重启，必须靠这个标记告诉它「是人为停止，别拉回来」。
try {
  fs.writeFileSync(path.join(__dirname, '.stop-flag'), String(Date.now()), 'utf8');
  console.log('  [标记] 已写入 .stop-flag（启动器不会自动重启）');
} catch (e) { }

// ---- 1. 结束占用本地端口的服务 ----
let killedServer = false;
const netOut = run('netstat -ano -p tcp');
const pids = new Set();
for (const line of netOut.split(/\r?\n/)) {
  if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
}
for (const pid of pids) {
  run('taskkill /F /PID ' + pid);
  console.log('  [本地服务] 已结束进程 PID ' + pid);
  killedServer = true;
}
if (!killedServer) {
  console.log('  [本地服务] 未发现占用端口 ' + PORT + ' 的进程（可能已停止）');
}

// ---- 2. 结束 Cloudflare 隧道 ----
const cfOut = run('tasklist /FI "IMAGENAME eq cloudflared.exe"');
if (/cloudflared\.exe/i.test(cfOut)) {
  run('taskkill /F /IM cloudflared.exe');
  console.log('  [隧道] 已结束 cloudflared 进程');
} else {
  console.log('  [隧道] 未发现运行中的 cloudflared（可能已停止）');
}

console.log('\n  公网服务已下线。公网地址将不再可访问。\n');
