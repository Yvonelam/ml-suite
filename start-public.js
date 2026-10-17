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

// ---- 重启退避（指数退避 · 永不放弃）----
// 老逻辑是「1 分钟内重启超过 10 次就 return / process.exit」——网络抖动一分钟、
// 或者 Cloudflare 侧故障久一点，服务就**永久下线**，非得人工重新运行脚本。
// 这和「以后不再出现连接问题」正好相反。现在改成：
//   3s → 6s → 12s → 24s → 48s → 96s → 192s → 300s → 300s → …
// 只要某次起来后稳定存活满 60 秒，计数立刻归零，下次抖动又从 3 秒开始。
// 好处：偶发抖动秒级恢复；长期故障自动慢慢重试（不刷屏、不烧 CPU），而且**不会放弃**。
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;   // 5 分钟封顶
const STABLE_RESET_MS = 60 * 1000;      // 稳定跑满 60 秒 → 退避归零

function makeBackoff(label) {
  let tries = 0;
  let stableTimer = null;
  return {
    // 进程起来后调用：稳定存活 60 秒就把退避清零
    markStarted() {
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        if (tries > 0) console.log('[' + label + '] 已稳定运行 ' + (STABLE_RESET_MS / 1000) + ' 秒，重启退避计数归零。');
        tries = 0;
      }, STABLE_RESET_MS);
      if (stableTimer.unref) stableTimer.unref();
    },
    markDead() {
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    },
    // 取下一次重试延迟（毫秒），并把计数 +1
    nextDelay() {
      const ms = Math.min(BACKOFF_BASE_MS * Math.pow(2, tries), BACKOFF_MAX_MS);
      tries += 1;
      return ms;
    },
    reset() { tries = 0; this.markDead(); },
    get tries() { return tries; },
  };
}

const svcBackoff = makeBackoff('服务');
const tunBackoff = makeBackoff('隧道');

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
  svcBackoff.markStarted();   // 起来后盯 60 秒：稳定就清零退避
  server.on('exit', (c) => {
    if (shuttingDown) return;
    svcBackoff.markDead();
    if (deliberateRestart) {
      // 热重载导致的重启：不计入退避，等端口释放后立刻拉起
      deliberateRestart = false;
      console.log('[热重载] 服务已停止，正在重新拉起…');
      restartAfterReload();
      return;
    }
    if (stopRequested()) { console.log('[服务] 收到停止指令，不再自动重启。'); return; }
    const delay = svcBackoff.nextDelay();
    console.warn('[服务] 已退出，代码 ' + c + '。' + Math.round(delay / 1000) + ' 秒后第 ' + svcBackoff.tries + ' 次自动重启（隧道保持在线，不会放弃）…');
    setTimeout(startServer, delay);
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

// 隧道退出后自动重连（指数退避 · 永不放弃）
function onTunnelExit(c) {
  if (shuttingDown) return;
  tunBackoff.markDead();
  tunnel = null;
  if (stopRequested()) { console.log('[隧道] 收到停止指令，不再自动重连。'); return; }
  const delay = tunBackoff.nextDelay();
  console.warn('[隧道] 已退出，代码 ' + c + '。' + Math.round(delay / 1000) + ' 秒后第 ' + tunBackoff.tries + ' 次自动重连（永不放弃）…');
  setTimeout(startTunnel, delay);
}

// 每次杀掉隧道统一走这里：置空引用，避免看门狗重复 kill 同一个尸体
function killTunnel(reason) {
  const t = tunnel;
  tunnel = null;
  console.warn('[隧道] 强制重启：' + reason);
  try { if (t) t.kill(); } catch (e) { }
  // 万一进程卡死不响应 kill（Windows 上少见但存在），兜底 8 秒后自己排一次重连
  setTimeout(() => { if (!shuttingDown && !tunnel && !stopRequested()) startTunnel(); }, 8000).unref();
}

function announce(url, modeLabel) {
  publicUrl = url;   // 给端到端健康探测用
  try { fs.writeFileSync(URL_FILE, url + '\n', 'utf8'); } catch (e) { }
  banner('公网地址已就绪 · ' + modeLabel);
  console.log('  ' + url);
  console.log('\n  已保存到: 公网地址.txt');
  console.log('  首次访问需要输入公网访问口令（见 daily-search-config.json 的 accessPassword）');
  console.log('  保持本窗口开启，关闭即断网。按 Ctrl+C 停止。\n');
  banner('');
}

// ---- 隧道健康看门狗（三层探测）----
// 痛点：cloudflared 进程**还活着**、但到 Cloudflare 边缘的连接已经死了（半开连接）时，
// 原来那条「进程退出才重启」完全管不到 —— 公网一直 530，进程却安静地跑了十几个小时。
// 更坑的是：cloudflared 自带的 /ready 在这种半开状态下**仍然返回 200**（这次就踩到了），
// 所以只看 /ready 不够。改成三条腿一起判断：
//   ① /ready    —— 隧道有没有握上健康连接
//   ② /metrics  —— cloudflared_tunnel_ha_connections 实际活动连接数
//   ③ 公网端到端 —— 真去 GET https://<你的域名>/ ，这个骗不了人
// 任一信号连续不健康到阈值 → killTunnel()，交给退避重连重新握手。
const CF_METRICS_PORT = process.env.CF_METRICS_PORT || 20241;
const CF_METRICS = 'http://127.0.0.1:' + CF_METRICS_PORT;
const READY_BAD_LIMIT = 5;   // 每分钟探一次，连续 5 分钟 /ready 不健康
const E2E_BAD_LIMIT = 3;     // 连续 3 分钟公网打不通
let tunnelBadChecks = 0;
let e2eBadChecks = 0;
let tunnelHealthBaseline = false;
let tunnelHealthTimer = null;
let publicUrl = '';          // 由 announce() 写入，端到端探测用
let tunnelProtocol = 'quic'; // 连续失败后自动降级 http2（UDP 容易被代理/防火墙掐）
let quicFailures = 0;
let tunnelSpawnAt = 0;

// 极简 HTTP(S) GET：只关心「通不通 / 状态码」，不读 body
function probeUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, status) => { if (!done) { done = true; resolve({ ok, status }); } };
    let req;
    try {
      const mod = url.startsWith('https:') ? require('https') : http;
      req = mod.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        res.on('end', () => finish(true, res.statusCode));
        res.on('error', () => finish(true, res.statusCode));
      });
    } catch (e) { return finish(false, 0); }
    req.on('error', () => finish(false, 0));
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } finish(false, 0); });
  });
}

async function tunnelReady() {
  const r = await probeUrl(CF_METRICS + '/ready', 4000);
  return r.status === 200;
}

// 公网端到端：直连 + 代理 双路探测。
// 只测直连会有假阳性 —— 本机直连 Cloudflare 偶尔被干扰/污染，隧道其实好好的，
// 却被判成「半开连接」反复重启。所以直连不通再用 Clash 代理试一次（和浏览器同一条路），
// 两边都不通才认定隧道真的挂了。
async function probePublicEndToEnd(url, timeoutMs) {
  const direct = await probeUrl(url, timeoutMs);
  if (direct.ok && (direct.status || 0) < 500) return { ok: true, status: direct.status, via: '直连' };
  let viaProxy = { ok: false, status: 0 };
  try {
    const { ProxyAgent } = require('undici');
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';
    const agent = new ProxyAgent(proxy);
    try {
      const r = await fetch(url, { dispatcher: agent, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      try { await r.arrayBuffer(); } catch (e) { }
      viaProxy = { ok: true, status: r.status };
    } finally { try { await agent.close(); } catch (e) { } }
  } catch (e) { }
  if (viaProxy.ok && (viaProxy.status || 0) < 500) return { ok: true, status: viaProxy.status, via: '代理' };
  return { ok: false, status: direct.status || viaProxy.status || 0, via: '直连+代理都失败' };
}

// 读 cloudflared 的活动连接数；读不到返回 null（不参与判断）
function tunnelHaConnections() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(CF_METRICS + '/metrics', { timeout: 4000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 200000) buf += d; });
      res.on('end', () => {
        const m = buf.match(/^cloudflared_tunnel_ha_connections\s+([\d.]+)/m);
        finish(m ? Number(m[1]) : null);
      });
      res.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } finish(null); });
  });
}

async function healthTick() {
    if (shuttingDown || !tunnel) return;

    const readyOk = await tunnelReady();
    const ha = await tunnelHaConnections();
    // 端到端：只有本地服务本身活着，才把「公网不通」算到隧道头上
    let e2eOk = true, e2eStatus = 0, e2eVia = '';
    if (publicUrl && await isPortBusy(PORT)) {
      const r = await probePublicEndToEnd(publicUrl, 8000);
      e2eStatus = r.status || 0;
      e2eVia = r.via || '';
      // 5xx / 超时 / 连不上 = 隧道有问题；2xx~4xx 都算通（4xx 可能是访问口令拦截）
      e2eOk = r.ok;
    }

    if (readyOk && (ha === null || ha > 0) && e2eOk) {
      if (!tunnelHealthBaseline) {
        tunnelHealthBaseline = true;
        console.log('[隧道] 健康探测已接管 ✓ /ready=OK · 活动连接=' + (ha === null ? '?' : ha)
          + ' · 公网=' + (e2eVia ? e2eVia + '可达' : '未配置域名，已跳过') + '（之后每分钟复查）');
      } else if (tunnelBadChecks || e2eBadChecks) {
        console.log('[隧道] 健康检查恢复正常（连接数 ' + (ha === null ? '?' : ha) + '）。');
      }
      tunnelBadChecks = 0; e2eBadChecks = 0;
      return;
    }

    if (!readyOk) tunnelBadChecks += 1;
    if (!e2eOk) e2eBadChecks += 1;
    console.warn('[隧道] 健康异常 · /ready=' + (readyOk ? 'OK' : '失败')
      + ' · 活动连接=' + (ha === null ? '未知' : ha)
      + ' · 公网=' + (e2eOk ? '通' : ('失败' + (e2eStatus ? '(' + e2eStatus + ')' : '') + (e2eVia ? ' [' + e2eVia + ']' : '')))
      + ' · 未通过 ' + tunnelBadChecks + '/' + READY_BAD_LIMIT + ' · 公网失败 ' + e2eBadChecks + '/' + E2E_BAD_LIMIT);

    // QUIC 被掐 → 降级 TCP(http2)：UDP 走的 QUIC 在部分网络/代理下会被静默丢包
    if (tunnelProtocol === 'quic' && quicFailures >= 5) {
      tunnelProtocol = 'http2';
      quicFailures = 0;
      tunnelBadChecks = 0; e2eBadChecks = 0;
      console.warn('[隧道] QUIC 连续失败 ' + 5 + ' 次，自动降级为 http2（TCP）协议重连…');
      killTunnel('QUIC 不可用，降级 http2');
      return;
    }

    if (e2eBadChecks >= E2E_BAD_LIMIT || tunnelBadChecks >= READY_BAD_LIMIT) {
      const why = e2eBadChecks >= E2E_BAD_LIMIT
        ? '公网连续 ' + E2E_BAD_LIMIT + ' 分钟不可达（半开连接）'
        : '/ready 连续 ' + READY_BAD_LIMIT + ' 分钟不健康';
      tunnelBadChecks = 0; e2eBadChecks = 0;
      killTunnel(why);
    }
}

function startTunnelHealthWatch() {
  if (tunnelHealthTimer) return;
  tunnelHealthTimer = setInterval(healthTick, 60 * 1000);
  if (tunnelHealthTimer.unref) tunnelHealthTimer.unref();
  // 启动 20 秒后先跑一次，让日志里立刻能看到「三条信号」的基线，不用干等一分钟
  const first = setTimeout(healthTick, 20000);
  if (first.unref) first.unref();
}

function startTunnel() {
  tunnelBadChecks = 0;   // 每次重开隧道都重新计数，别带着上次的失败数直接判死
  e2eBadChecks = 0;
  tunnelSpawnAt = Date.now();
  const tc = loadTunnelCfg();
  const named = String(tc.mode || '').toLowerCase() === 'named' && tc.token;
  const hostname = String(tc.hostname || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // --protocol：为支持 http2 降级，只有确实是 http2 时才传；quic 是默认值不必显式写
  const protoArgs = tunnelProtocol === 'http2' ? ['--protocol', 'http2'] : [];

  if (named) {
    // ---- 命名隧道：地址永久固定 ----
    console.log('[2/2] 正在连接固定域名隧道 ' + (hostname || '(hostname 未填)') + ' · 协议 ' + tunnelProtocol + ' ...\n');
    // 注意：--metrics / --protocol 是 `tunnel` 子命令的 flag，必须放在 `run` **前面**；
    // 放到 run 后面 cloudflared 会直接打印 usage 然后退出（踩过）。
    tunnel = spawn(CF_BIN, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:' + CF_METRICS_PORT, ...protoArgs, 'run', '--token', tc.token], {
      cwd: ROOT, env: process.env,
      windowsHide: HIDE_CHILD_WINDOWS,   // 无控制台模式下别弹黑框（见顶部说明）
    });

    // 命名隧道的地址不会打印在日志里，直接按配置宣告
    if (hostname) announce('https://' + hostname + '/', '固定域名');
    else console.log('  [提示] tunnel-config.json 里没有填 hostname，请自行到 Cloudflare 后台查看访问地址。\n');

    tunnel.stdout.on('data', (d) => process.stdout.write(d.toString()));
    tunnel.stderr.on('data', (d) => { const s = d.toString(); process.stderr.write(s); scanQuic(s); });
    tunnel.on('error', (e) => console.error('[隧道] 启动失败:', e.message));
    tunnel.on('exit', (c) => onTunnelExit(c));
    tunBackoff.markStarted();
    return;
  }

  // ---- 快速隧道：地址随机 ----
  console.log('[2/2] 正在建立 Cloudflare 临时隧道（地址每次重启都会变）· 协议 ' + tunnelProtocol);
  console.log('      想要固定地址：双击「配置固定域名.bat」\n');
  tunnel = spawn(CF_BIN, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:' + CF_METRICS_PORT, ...protoArgs, '--url', 'http://127.0.0.1:' + PORT], {
    cwd: ROOT, env: process.env,
    windowsHide: HIDE_CHILD_WINDOWS,   // 无控制台模式下别弹黑框（见顶部说明）
  });

  let announced = false;
  function scan(text) {
    if (announced) return;
    const m = text.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/);
    if (m) { announced = true; announce(m[0], '临时地址'); }
  }

  tunnel.stdout.on('data', (d) => { const s = d.toString(); process.stdout.write(s); scan(s); scanQuic(s); });
  tunnel.stderr.on('data', (d) => { const s = d.toString(); process.stderr.write(s); scan(s); scanQuic(s); });
  tunnel.on('error', (e) => console.error('[隧道] 启动失败:', e.message));
  tunnel.on('exit', (c) => onTunnelExit(c));
  tunBackoff.markStarted();
}

// 从 cloudflared 输出里识别 QUIC 抖动，攒够次数就降级 TCP
function scanQuic(text) {
  if (tunnelProtocol !== 'quic') return;
  if (/failed to dial to edge with quic|no recent network activity|failed to dial edge.*quic/i.test(text)) {
    quicFailures += 1;
    if (quicFailures === 1) console.warn('[隧道] 检测到 QUIC 握手失败，开始计数（累计 5 次自动降级 http2）。');
  }
}

// ---- 自动同步到 GitHub ----
// 远端那个不在本机运行的 AI 只能读 GitHub，本地不推它就永远在旧代码上改。
// 这里顺手把它拉起来：启动器本身有看门狗 + 开机自启护着，等于自动同步也一起被守护，
// 不用再单独记着去双击某个 bat。
// 用户主动「自动同步-关闭.bat」后会在目录里留下 .sync-off，这里就尊重它不再启动。
const AUTOSYNC_PID = path.join(ROOT, '.autosync.pid');
const SYNC_OFF = path.join(ROOT, '.sync-off');
function startAutosync() {
  if (fs.existsSync(SYNC_OFF)) {
    console.log('  [自动同步] 已被关闭（存在 .sync-off），本次不启动。想恢复双击「自动同步-开启.bat」。');
    return;
  }
  const script = path.join(ROOT, 'git-autosync.js');
  if (!fs.existsSync(script)) return;
  try {
    const pid = parseInt(fs.readFileSync(AUTOSYNC_PID, 'utf8'), 10);
    if (pid && pid !== process.pid && pidAlive(pid)) {
      console.log('  [自动同步] 已在运行（PID ' + pid + '）。');
      return;
    }
  } catch (e) { }
  try {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT, env: process.env,
      detached: true,        // 独立于启动器存活
      windowsHide: HIDE_CHILD_WINDOWS,
      stdio: 'ignore',       // 它自己会写 同步日志.txt
    });
    child.unref();
    console.log('  [自动同步] 已启动（PID ' + child.pid + '）：本地改动会自动提交并推送到 GitHub。');
  } catch (e) {
    console.error('[自动同步] 启动失败:', e.message);
  }
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
  startAutosync();

  console.log('\n  [守护] 已启用四层自动恢复：服务崩溃重拉 · 隧道断线重连（指数退避，永不放弃）· 每分钟健康探测 · QUIC 失败自动降级 http2。');
  console.log('  [守护] 停止请用「停止公网服务.bat」，或按 Ctrl+C。\n');

  // 轮询「停止标记」：stop-public.js 写入后 3 秒内本启动器优雅退出
  setInterval(() => { if (stopRequested()) shutdown(); }, 3000).unref();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', releaseLock);   // 异常路径也别把锁留下（否则下次启动会被自己挡住）
})();
