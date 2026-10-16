#!/usr/bin/env node
/**
 * ML Suite · 自启看门狗
 *
 * 干嘛的：开机（登录）后由「启动文件夹」里的 autostart.vbs 静默拉起，然后常驻。
 *         每分钟探一次本地端口 3000：
 *           - 端口通  → 什么都不做
 *           - 端口不通 → 拉起 start-public.js（本地服务 + Cloudflare 隧道），日志追到 运行日志.txt
 *         这样即使启动器被误关窗口 / 被系统回收，一分钟内也会自己回来。
 *
 * 尊重「停止公网服务.bat」写下的 .stop-flag：
 *         你主动停了，看门狗就闭嘴，不会你刚停完它又给你拉起来。
 *
 * 关掉自启：双击「开机自启-关闭.bat」（会移除启动文件夹里的入口 + 结束看门狗进程）。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const STOP_FLAG = path.join(ROOT, '.stop-flag');
const LOG = path.join(ROOT, '运行日志.txt');
const LOCK = path.join(ROOT, '.watchdog.pid');

const CHECK_MS = 60 * 1000;          // 每分钟探一次
const RETRY_COOLDOWN_MS = 3 * 60 * 1000;  // 拉起后给 3 分钟冷启动窗口，避免端口还没起来就连着拉

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  const line = '[' + stamp() + '] [看门狗] ' + msg + '\n';
  try { fs.appendFileSync(LOG, line); } catch (e) { }
  try { process.stdout.write(line); } catch (e) { }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---- 单实例：别开两个看门狗互相打架 ----
try {
  const old = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
  if (old && old !== process.pid && pidAlive(old)) {
    log('已有看门狗在运行（PID ' + old + '），本次退出。');
    process.exit(0);
  }
} catch (e) { }
try { fs.writeFileSync(LOCK, String(process.pid)); } catch (e) { }
process.on('exit', () => {
  try {
    if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK);
  } catch (e) { }
});

// ---- 端口探测 ----
function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

let lastLaunch = 0;

function launch(reason) {
  lastLaunch = Date.now();
  log('本地服务未响应（' + reason + '），正在拉起 start-public…');

  let fd = null;
  try { fd = fs.openSync(LOG, 'a'); } catch (e) { }

  const child = spawn(process.execPath, [path.join(ROOT, 'start-public.js')], {
    cwd: ROOT,
    detached: true,          // 独立于看门狗存活
    windowsHide: true,       // 不弹黑框
    stdio: ['ignore', fd || 'ignore', fd || 'ignore'],
  });
  if (fd !== null) { try { fs.closeSync(fd); } catch (e) { } }
  child.unref();
  log('已拉起 start-public（PID ' + child.pid + '）。');
}

async function check() {
  try {
    if (fs.existsSync(STOP_FLAG)) return;                       // 人为停止：不打扰
    if (await portBusy(PORT)) return;                            // 正常在跑
    if (Date.now() - lastLaunch < RETRY_COOLDOWN_MS) return;     // 刚拉过，给它时间起来
    launch('端口 ' + PORT + ' 无响应');
  } catch (e) {
    log('检查出错：' + e.message);
  }
}

log('看门狗已启动（PID ' + process.pid + '），每 ' + (CHECK_MS / 1000) + ' 秒检查一次端口 ' + PORT + '。');
check();
setInterval(check, CHECK_MS);
