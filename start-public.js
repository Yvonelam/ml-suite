#!/usr/bin/env node
/**
 * ML Suite · 公网服务启动器
 * 同时启动：本地 Express 服务 + Cloudflare 隧道。
 *
 * 两种模式（由 tunnel-config.json 的 mode 决定）：
 *   quick  —— 免账号临时隧道，地址随机（xxx.trycloudflare.com），每次重启都会变；
 *   named  —— 命名隧道，地址固定为你自己的域名（需 Cloudflare 账号 + 域名 + 隧道 Token）。
 *
 * 若本地端口已有服务在跑，则复用，不重复启动。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { createWatcher } = require('./hot-reload');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const CF_BIN = path.join(ROOT, 'tools', 'cloudflared.exe');
const URL_FILE = path.join(ROOT, '公网地址.txt');
const TUNNEL_CFG = path.join(ROOT, 'tunnel-config.json');

// 启动器自己有没有控制台？
//   开机自启走 autostart.vbs（隐藏）+ stdio 重定向到 运行日志.txt → stdout 不是 TTY。
//   这种「无控制台」模式下，子进程若不带 CREATE_NO_WINDOW，Windows 会**给每个子进程
//   弹一个新 CMD 窗口**（实测 server.js 与 cloudflared 各弹一个，就是用户看到的两个黑框）。
//   手动双击 .bat 时父进程本来就有控制台，子进程直接继承即可，不需要这个开关。
// 所以按 isTTY 判断：两种模式都不会多弹窗口。
const HIDE_CHILD_WINDOWS = !process.stdout.isTTY;
// 「停止」标记：stop-public.js 会先写下这个文件再杀进程，
// 这样启动器就知道是「人为停止」，不会傻乎乎地又自动重启回来。
const STOP_FLAG = path.join(ROOT, '.stop-flag');
try { fs.unlinkSync(STOP_FLAG); } catch (e) { }
function stopRequested() { try { return fs.existsSync(STOP_FLAG); } catch (e) { return false; } }

// ---- 单实例锁 ----
// 开机自启（启动文件夹）和手动双击「启动公网服务.bat」可能同时把启动器拉起来。
// 两个启动器 = 两条 cloudflared 连同一个隧道（能跑但噪音大、难排查），所以用 pid 文件锁住。
const LOCK_FILE = path.join(ROOT, '.launcher.pid');
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// 返回已在跑的启动器 PID；没有则抢占锁并返回 0
function acquireLock() {
  try {
    const old = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    if (old && old !== process.pid && pidAlive(old)) return old;
  } catch (e) { }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) { }
  return 0;
}
function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) { }
}

function banner(msg) {
  const line = '='.repeat(60);
  console.log('\n' + line + '\n  ' + msg + '\n' + line);
}

function loadTunnelCfg() {
  try { return JSON.parse(fs.readFileSync(TUNNEL_CFG, 'utf8')); }
  catch { return { mode: 'quick' }; }
}

// ---- 依赖检查 ----
if (!fs.existsSync(CF_BIN)) {
  console.error('\n[错误] 找不到隧道程序 tools/cloudflared.exe');
  console.error('请先运行一次：npm run setup-tunnel（或手动下载 cloudflared）\n');
  process.exit(1);
}

// ---- 探测本地端口是否已在服务 ----
function isPortBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

let server = null;
let tunnel = null;
let shuttingDown = false;
let deliberateRestart = false;  // true = 因代码热重载而主动杀掉服务（走快速重启，不计崩溃限流）
let restarting = false;         // true = 正在重启过程中（此时不重复排队重启）
let watcher = null;
let svcRestarts = [];   // 本地服务自动重启时间戳（用于限流）
let tunRestarts = [];   // 隧道自动重连时间戳（用于限流）

function shutdown() {
  console.log('\n正在停止服务...');
  shuttingDown = true;
  try { if (watcher) watcher.stop(); } catch (e) { }
  try { if (tunnelHealthTimer) clearInterval(tunnelHealthTimer); } catch (e) { }
  try { if (tunnel) tunnel.kill(); } catch (e) { }
  try { if (server) server.kill(); } catch (e) { }
  releaseLock();
  process.exit(0);
}

// 启动本地服务（可反复调用，用于崩溃后自动重启）
function startServer() {
  restarting = false;
  console.log('[1/2] 正在启动本地服务 http://127.0.0.1:' + PORT + ' ...');
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT },
    stdio: 'inherit',
    windowsHide: HIDE_CHILD_WINDOWS,   // 无控制台模式下别弹黑框（见顶部说明）
  });
  server.on('error', (e) => console.error('[服务] 启动失败:', e.message));
  server.on('exit', (c) => {
    if (shuttingDown) return;
    if (deliberateRestart) {
      // 热重载导致的重启：不计入崩溃限流，等端口释放后立刻拉起
      deliberateRestart = false;
      console.log('[热重载] 服务已停止，正在重新拉起…');
      restartAfterReload();
      return;
    }
    if (stopRequested()) { console.log('[服务] 收到停止指令，不再自动重启。'); return; }
    // 限流：1 分钟内最多重启 10 次，超过就停下等人工介入，避免疯狂重启刷屏
    const now = Date.now();
    svcRestarts = svcRestarts.filter((t) => now - t < 60000);
    svcRestarts.push(now);
    if (svcRestarts.length > 10) {
      console.error('[服务] 1 分钟内已重启 ' + svcRestarts.length + ' 次，已暂停自动重启。请查看上方报错后重新运行启动脚本。');
      try { if (tunnel) tunnel.kill(); } catch (e) { }
      process.exit(1);
    }
    console.warn('[服务] 已退出，代码 ' + c + '。3 秒后自动重启（隧道保持在线）…');
    setTimeout(startServer, 3000);
  });
}

// 热重载后拉起服务：先等端口真正释放，避免 Windows 上的 EADDRINUSE
async function restartAfterReload() {
  for (let i = 0; i < 40; i++) {
    if (shuttingDown || stopRequested()) return;
    if (!(await isPortBusy(PORT))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (shuttingDown || stopRequested()) return;
  startServer();
}

// ---- 代码热重载 ----
// 轮询项目根目录下所有 .js 的修改时间，变了就自动重启本地服务；Cloudflare 隧道全程保持在线。
// 这样用 AI 改完后端代码不用手动重启，刷新浏览器就是新版本。
// 想关掉：设置环境变量 WATCH=0
function startWatcher() {
  if (String(process.env.WATCH || '1') === '0') {
    console.log('  [热重载] 已关闭（WATCH=0）');
    return;
  }

  watcher = createWatcher({
    root: ROOT,
    interval: 1000,
    debounce: 800,
    shouldStop: () => shuttingDown || stopRequested(),
    onChange: (name) => {
      if (shuttingDown || stopRequested()) return;
      if (restarting) return;   // 正在重启：新进程会加载最新代码，不必再排队一次
      if (!server) {
        console.warn('[热重载] 检测到 ' + name + ' 变更，但本地服务不是由本启动器管理的（端口被别的进程占用），无法自动重启。');
        return;
      }
      console.log('\n[热重载] 检测到 ' + name + ' 变更，正在重启本地服务（隧道保持在线）…');
      restarting = true;
      deliberateRestart = true;
      try { server.kill(); } catch (e) { }
    },
  });

  console.log('  [热重载] 已开启：改动后端 .js 会自动重启服务；前端改完刷新浏览器即生效。');
}

// 隧道退出后自动重连（限流防止疯狂重连）
function onTunnelExit(c) {
  if (shuttingDown) return;
  if (stopRequested()) { console.log('[隧道] 收到停止指令，不再自动重连。'); return; }
  const now = Date.now();
  tunRestarts = tunRestarts.filter((t) => now - t < 60000);
  tunRestarts.push(now);
  if (tunRestarts.length > 10) {
    console.error('[隧道] 1 分钟内已重连 ' + tunRestarts.length + ' 次，已暂停自动重连。请检查网络 / Token 后重新运行启动脚本。');
    return;
  }
  console.warn('[隧道] 已退出，代码 ' + c + '。3 秒后自动重连…');
  setTimeout(startTunnel, 3000);
}

function announce(url, modeLabel) {  try { fs.writeFileSync(URL_FILE, url + '\n', 'utf8'); } catch (e) { }
  banner('公网地址已就绪 · ' + modeLabel);
  console.log('  ' + url);
  console.log('\n  已保存到: 公网地址.txt');
  console.log('  首次访问需要输入公网访问口令（见 daily-search-config.json 的 accessPassword）');
  console.log('  保持本窗口开启，关闭即断网。按 Ctrl+C 停止。\n');
  banner('');
}

// ---- 隧道健康看门狗 ----
// 痛点：cloudflared 进程**还活着**、但一条连接都建不起来时，启动器原来那条「进程退出才重启」
// 完全管不到它 —— 结果就是公网一直 530、进程安安静静跑了十几个小时没人发现（这次就踩到了）。
// 办法：读 cloudflared 自带的 metrics 端点 /ready（至少有一条健康连接才返回 200），
// 连续 N 分钟不健康就杀掉进程，交给 onTunnelExit 的自动重启去重新握手。
const CF_METRICS_PORT = process.env.CF_METRICS_PORT || 20241;
const CF_METRICS = 'http://127.0.0.1:' + CF_METRICS_PORT;
const TUNNEL_UNHEALTHY_LIMIT = 5;   // 每分钟探一次，连续 5 次不健康 ≈ 5 分钟
let tunnelBadChecks = 0;
let tunnelHealthTimer = null;

function tunnelReady() {
  return new Promise((resolve) => {
    const req = http.get(CF_METRICS + '/ready', { timeout: 4000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } resolve(false); });
  });
}

function startTunnelHealthWatch() {
  if (tunnelHealthTimer) return;
  tunnelHealthTimer = setInterval(async () => {
    if (shuttingDown || !tunnel) return;
    if (await tunnelReady()) { tunnelBadChecks = 0; return; }
    tunnelBadChecks += 1;
    console.warn('[隧道] 健康检查未通过 ' + tunnelBadChecks + '/' + TUNNEL_UNHEALTHY_LIMIT + '（/ready 非 200）');
    if (tunnelBadChecks >= TUNNEL_UNHEALTHY_LIMIT) {
      tunnelBadChecks = 0;
      console.warn('[隧道] 连续 ' + TUNNEL_UNHEALTHY_LIMIT + ' 分钟连不上，强制重启隧道进程…');
      try { tunnel.kill(); } catch (e) { }
    }
  }, 60 * 1000);
}

function startTunnel() {
  tunnelBadChecks = 0;   // 每次重开隧道都重新计数，别带着上次的失败数直接判死
  const tc = loadTunnelCfg();
  const named = String(tc.mode || '').toLowerCase() === 'named' && tc.token;
  const hostname = String(tc.hostname || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (named) {
    // ---- 命名隧道：地址永久固定 ----
    console.log('[2/2] 正在连接固定域名隧道 ' + (hostname || '(hostname 未填)') + ' ...\n');
    // 注意：--metrics 是 `tunnel` 子命令的 flag，必须放在 `run` **前面**；
    // 放到 run 后面 cloudflared 会直接打印 usage 然后退出（踩过）。
    tunnel = spawn(CF_BIN, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:' + CF_METRICS_PORT, 'run', '--token', tc.token], {
      cwd: ROOT, env: process.env,
      windowsHide: HIDE_CHILD_WINDOWS,   // 无控制台模式下别弹黑框（见顶部说明）
    });

    // 命名隧道的地址不会打印在日志里，直接按配置宣告
    if (hostname) announce('https://' + hostname + '/', '固定域名');
    else console.log('  [提示] tunnel-config.json 里没有填 hostname，请自行到 Cloudflare 后台查看访问地址。\n');

    tunnel.stdout.on('data', (d) => process.stdout.write(d.toString()));
    tunnel.stderr.on('data', (d) => process.stderr.write(d.toString()));
    tunnel.on('error', (e) => console.error('[隧道] 启动失败:', e.message));
    tunnel.on('exit', (c) => onTunnelExit(c));
    return;
  }

  // ---- 快速隧道：地址随机 ----
  console.log('[2/2] 正在建立 Cloudflare 临时隧道（地址每次重启都会变）...');
  console.log('      想要固定地址：双击「配置固定域名.bat」\n');
  tunnel = spawn(CF_BIN, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:' + CF_METRICS_PORT, '--url', 'http://127.0.0.1:' + PORT], {
    cwd: ROOT, env: process.env,
    windowsHide: HIDE_CHILD_WINDOWS,   // 无控制台模式下别弹黑框（见顶部说明）
  });

  let announced = false;
  function scan(text) {
    if (announced) return;
    const m = text.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/);
    if (m) { announced = true; announce(m[0], '临时地址'); }
  }

  tunnel.stdout.on('data', (d) => { const s = d.toString(); process.stdout.write(s); scan(s); });
  tunnel.stderr.on('data', (d) => { const s = d.toString(); process.stderr.write(s); scan(s); });
  tunnel.on('error', (e) => console.error('[隧道] 启动失败:', e.message));
  tunnel.on('exit', (c) => onTunnelExit(c));
}

(async () => {
  // 先抢单实例锁：开机自启 + 手动双击撞车时，后来者直接退出
  const otherPid = acquireLock();
  if (otherPid) {
    console.log('[启动器] 已有实例在运行（PID ' + otherPid + '），本次退出，不重复起隧道。');
    process.exit(0);
  }

  const busy = await isPortBusy(PORT);

  if (busy) {
    console.log('[1/2] 检测到本地服务已在运行，直接复用 http://127.0.0.1:' + PORT);
  } else {
    startServer();
  }

  startTunnel();
  startWatcher();
  startTunnelHealthWatch();

  console.log('\n  [守护] 已启用自动重启：服务或隧道意外退出会自动拉起（1 分钟最多 10 次）。');
  console.log('  [守护] 停止请用「停止公网服务.bat」，或按 Ctrl+C。\n');

  // 轮询「停止标记」：stop-public.js 写入后 3 秒内本启动器优雅退出
  setInterval(() => { if (stopRequested()) shutdown(); }, 3000).unref();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', releaseLock);   // 异常路径也别把锁留下（否则下次启动会被自己挡住）
})();
