#!/usr/bin/env node
/**
 * ML Suite · 自启看门狗
 *
 * 干嘛的：开机（登录）后由「启动文件夹」里的 autostart.vbs 静默拉起，然后常驻。
 *         每分钟做一次「进程级 + 端口级」双重体检：
 *
 *           ┌ 启动器活着 + 端口通       → 一切正常，什么都不做
 *           ├ 启动器活着 + 端口不通     → 给它 2 个周期自我恢复；还不通就杀掉重来
 *           ├ 启动器不在 + 端口不通     → 拉起 start-public.js（本地服务 + 隧道）
 *           └ 启动器不在 + 端口通       → **孤儿服务**：服务还在但没人管隧道了，
 *                                        也拉起启动器（它会复用已在跑的服务，
 *                                        只把隧道接管回来，不中断访问）
 *
 *         为什么最后一条重要：以前只看端口，一旦启动器被误关窗口而 server.js 还活着，
 *         端口一直通 → 看门狗以为万事大吉 → 隧道再也没人重启，公网就 530 了。
 *
 * 日志统一追加到 运行日志.txt，前缀 [看门狗]。
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
const LAUNCHER_LOCK = path.join(ROOT, '.launcher.pid');
const AUTOSYNC_PID = path.join(ROOT, '.autosync.pid');
const SYNC_OFF = path.join(ROOT, '.sync-off');    // 「自动同步-关闭.bat」写的：人为关掉，别管
const SYNC_SCRIPT = path.join(ROOT, 'git-autosync.js');

const CHECK_MS = 60 * 1000;               // 每分钟探一次
const RETRY_COOLDOWN_MS = 3 * 60 * 1000;  // 拉起后给 3 分钟冷启动窗口，避免端口还没起来就连着拉
const PORT_DEAD_LIMIT = 2;                // 启动器在跑但端口连续 N 次不通 → 判定卡死

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  const line = '[' + stamp() + '] [看门狗] ' + msg + '\n';
  try { fs.appendFileSync(LOG, line); } catch (e) { }
  // 只有真有控制台时才回显到 stdout —— 开机自启时 stdout 就是 运行日志.txt 本身，
  // 再回显一次会让每条日志在文件里出现两遍（踩过）。
  if (process.stdout.isTTY) { try { process.stdout.write(line); } catch (e) { } }
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
let deadStreak = 0;      // 启动器在跑但端口不通的连续次数

function readPid(file) {
  try { return parseInt(fs.readFileSync(file, 'utf8'), 10) || 0; } catch (e) { return 0; }
}

function launch(reason) {
  lastLaunch = Date.now();
  log('正在拉起 start-public 启动器 · 原因：' + reason);

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

// ---- 自动同步体检 ----
// 自动同步进程一死，本地改动就再也推不上 GitHub，但表面完全看不出来（服务照跑、页面照开），
// 只有等你发现「远端还是旧代码」才暴露 —— 所以必须跟启动器一样被盯着。
function ensureAutosync() {
  if (fs.existsSync(SYNC_OFF)) return;                 // 人为关掉了，尊重它
  if (!fs.existsSync(SYNC_SCRIPT)) return;
  const pid = readPid(AUTOSYNC_PID);
  if (pid > 0 && pidAlive(pid)) return;
  try { fs.unlinkSync(AUTOSYNC_PID); } catch (e) { }   // 清掉陈旧 pid，否则新进程会以为自己重复启动
  try {
    const child = spawn(process.execPath, [SYNC_SCRIPT], {
      cwd: ROOT, env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    log('自动同步进程不在了（原 PID ' + (pid || '无') + '），已重新拉起（新 PID ' + child.pid + '）。');
  } catch (e) {
    log('拉起自动同步失败：' + e.message);
  }
}

async function check() {
  try {
    if (fs.existsSync(STOP_FLAG)) { deadStreak = 0; return; }   // 人为停止：不打扰

    ensureAutosync();   // 放在 .stop-flag 之后：你主动「停止公网服务」时，同步也跟着一起停

    const busy = await portBusy(PORT);
    const launcherPid = readPid(LAUNCHER_LOCK);
    const launcherAlive = launcherPid > 0 && pidAlive(launcherPid);

    // ---- 正常：启动器在，端口也通 ----
    if (launcherAlive && busy) { deadStreak = 0; return; }

    if (Date.now() - lastLaunch < RETRY_COOLDOWN_MS) return;     // 刚拉过，给它时间起来

    // ---- 启动器不在：不管端口通不通都要拉起 ----
    // 端口还通 = 孤儿服务（启动器被杀了，server.js 独自活着），新启动器会复用这个
    // 服务、只把隧道接管回来，访问不中断；端口不通 = 全没了，正常冷启动。
    if (!launcherAlive) {
      launch(busy
        ? '启动器已退出，但本地服务仍在（孤儿进程），重新接管隧道'
        : '启动器与本地服务都不在');
      return;
    }

    // ---- 启动器活着但端口一直不通：判定它卡死，杀掉重来 ----
    deadStreak += 1;
    log('启动器在跑（PID ' + launcherPid + '）但端口 ' + PORT + ' 不通（第 ' + deadStreak + '/' + PORT_DEAD_LIMIT + ' 次）');
    if (deadStreak < PORT_DEAD_LIMIT) return;
    deadStreak = 0;
    try {
      process.kill(launcherPid);
      log('已结束卡死的启动器 PID ' + launcherPid + '，3 秒后重新拉起。');
    } catch (e) {
      log('结束启动器失败（' + e.message + '），仍将尝试重新拉起。');
    }
    setTimeout(() => { if (!fs.existsSync(STOP_FLAG)) launch('启动器卡死，已强制重启'); }, 3000);
  } catch (e) {
    log('检查出错：' + e.message);
  }
}

log('看门狗已启动（PID ' + process.pid + '），每 ' + (CHECK_MS / 1000) + ' 秒做一次「启动器进程 + 端口 ' + PORT + ' + 自动同步」体检。');
check();
setInterval(check, CHECK_MS);
