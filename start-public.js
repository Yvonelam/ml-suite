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
const { createWatcher } = require('./hot-reload');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const CF_BIN = path.join(ROOT, 'tools', 'cloudflared.exe');
const URL_FILE = path.join(ROOT, '公网地址.txt');
const TUNNEL_CFG = path.join(ROOT, 'tunnel-config.json');
// 「停止」标记：stop-public.js 会先写下这个文件再杀进程，
// 这样启动器就知道是「人为停止」，不会傻乎乎地又自动重启回来。
const STOP_FLAG = path.join(ROOT, '.stop-flag');
try { fs.unlinkSync(STOP_FLAG); } catch (e) { }
function stopRequested() { try { return fs.existsSync(STOP_FLAG); } catch (e) { return false; } }

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
  try { if (tunnel) tunnel.kill(); } catch (e) { }
  try { if (server) server.kill(); } catch (e) { }
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

function announce(url, modeLabel) {
  try { fs.writeFileSync(URL_FILE, url + '\n', 'utf8'); } catch (e) { }
  banner('公网地址已就绪 · ' + modeLabel);
  console.log('  ' + url);
  console.log('\n  已保存到: 公网地址.txt');
  console.log('  首次访问需要输入公网访问口令（见 daily-search-config.json 的 accessPassword）');
  console.log('  保持本窗口开启，关闭即断网。按 Ctrl+C 停止。\n');
  banner('');
}

function startTunnel() {
  const tc = loadTunnelCfg();
  const named = String(tc.mode || '').toLowerCase() === 'named' && tc.token;
  const hostname = String(tc.hostname || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (named) {
    // ---- 命名隧道：地址永久固定 ----
    console.log('[2/2] 正在连接固定域名隧道 ' + (hostname || '(hostname 未填)') + ' ...\n');
    tunnel = spawn(CF_BIN, ['tunnel', '--no-autoupdate', 'run', '--token', tc.token], {
      cwd: ROOT, env: process.env,
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
  tunnel = spawn(CF_BIN, ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], {
    cwd: ROOT, env: process.env,
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
  const busy = await isPortBusy(PORT);

  if (busy) {
    console.log('[1/2] 检测到本地服务已在运行，直接复用 http://127.0.0.1:' + PORT);
  } else {
    startServer();
  }

  startTunnel();
  startWatcher();

  console.log('\n  [守护] 已启用自动重启：服务或隧道意外退出会自动拉起（1 分钟最多 10 次）。');
  console.log('  [守护] 停止请用「停止公网服务.bat」，或按 Ctrl+C。\n');

  // 轮询「停止标记」：stop-public.js 写入后 3 秒内本启动器优雅退出
  setInterval(() => { if (stopRequested()) shutdown(); }, 3000).unref();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
