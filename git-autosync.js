#!/usr/bin/env node
/**
 * ML Suite · 自动同步到 GitHub
 *
 * 解决什么：另一个不在本机运行的 AI 只能读 GitHub。本地改完不推，它就永远在旧代码上改，
 * 越拖越落后（用户原话：「落后几百个版本」）。这个进程的作用就是让 GitHub 上的 main
 * 始终跟本地一致，不需要人记得去点「推送代码」。
 *
 * 工作方式（轮询而不是文件监听，更稳）：
 *   每 30 秒跑一次 `git status --porcelain`
 *     · 没有改动            → 顺手补推（之前失败积压的提交）
 *     · 第一次发现改动      → 记下时间，等 15 秒（合并连续编辑，避免每存一次盘就一个 commit）
 *     · 改动持续超过 15 秒  → git add -A + commit + push
 *
 * 为什么不用 fs.watch：Windows 上 recursive watch 会漏事件、也会被 .git 内部写入干扰；
 * 轮询 git status 天然只关心「工作区是否真的脏了」，而且 20-30 秒的延迟刚好起到防抖作用。
 *
 * 推送失败绝不丢东西：
 *   · 提交留在本地，下一轮继续推
 *   · 指数退避 5s→10s→…→5 分钟封顶，不会刷日志
 *   · 远端有新提交（non-fast-forward）→ 自动 pull --rebase --autostash 再推一次
 *
 * 安全护栏：
 *   · 严格遵守 .gitignore（auth-data/、daily-search-config.json、tunnel-config.json、
 *     运行日志.txt、shots/ 全部被排除，不会被推上去）
 *   · .sync-pause 存在时完全不动手（想临时停就建这个文件）
 *   · .git/index.lock 存在、或处于 merge/rebase/cherry-pick 中途 → 本轮跳过，绝不抢 git 的活
 *   · 单实例锁 .autosync.pid
 *
 * 停止：双击「自动同步-关闭.bat」，或直接结束 node 进程。
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOG = path.join(ROOT, '同步日志.txt');
const PAUSE_FLAG = path.join(ROOT, '.sync-pause');
const PID_FILE = path.join(ROOT, '.autosync.pid');
const BRANCH = process.env.SYNC_BRANCH || 'main';

const POLL_MS = Number(process.env.SYNC_POLL_MS) || 20 * 1000;        // 轮询间隔
// 提交时机用「静默」而不是「固定等待」：编辑一停手 25 秒就提交。
// 原来是「第一次看到改动就等 15 秒」，连续改 10 分钟会产出十几个碎提交；
// 现在改成等「文件不再被改动」，配合 MAX_WAIT 兜底，长时间连改也最多 5 分钟推一次。
const QUIET_MS = Number(process.env.SYNC_QUIET_MS) || 25 * 1000;
const MAX_WAIT_MS = Number(process.env.SYNC_MAX_WAIT_MS) || 5 * 60 * 1000;
const PUSH_BACKOFF_MAX = 5 * 60 * 1000;
const LOG_MAX_BYTES = 1024 * 1024;   // 同步日志超过 1MB 自动截断，别无限长
// 拉取间隔：工作区干净时每 2 分钟 fetch 一次，看远端（别的 AI / 别的机器）有没有新提交。
// 老版本只 push 不 fetch，所以远端推上来的改动永远进不了本机 —— 单向半闭环。
const FETCH_MS = Number(process.env.SYNC_FETCH_MS) || 2 * 60 * 1000;

// GIT_TERMINAL_PROMPT=0：凭据失效时立刻报错，而不是弹窗卡死一个后台进程
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  const line = '[' + stamp() + '] [自动同步] ' + msg + '\n';
  try {
    try {
      if (fs.statSync(LOG).size > LOG_MAX_BYTES) fs.writeFileSync(LOG, '（日志超过 1MB，已截断）\n');
    } catch (e) { }
    fs.appendFileSync(LOG, line);
  } catch (e) { }
  if (process.stdout.isTTY) { try { process.stdout.write(line); } catch (e) { } }
}

function git(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, out: (out || '').trim(), err: '' };
  } catch (e) {
    const out = e.stdout ? String(e.stdout) : '';
    const err = e.stderr ? String(e.stderr) : (e.message || '');
    return { ok: false, out: out.trim(), err: err.trim() };
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---- 单实例 ----
try {
  const old = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  if (old && old !== process.pid && pidAlive(old)) {
    log('已有自动同步在运行（PID ' + old + '），本次退出。');
    process.exit(0);
  }
} catch (e) { }
try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (e) { }
process.on('exit', () => {
  try { if (parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(PID_FILE); } catch (e) { }
});

// ---- 状态 ----
let dirtySince = 0;          // 第一次看到「有改动」的时间
let lastChangeAt = 0;        // 最近一次「文件真的又被改了」的时间
let lastSig = '';            // 改动文件 + mtime 的指纹，用来判断是不是还在写
let pushBackoff = 5000;      // 当前推送退避间隔
let lastPushFailAt = 0;      // 上次推送失败时间

// 把「哪些文件脏了 + 各自 mtime」做成指纹。指纹变了说明还在编辑，
// 静默计时就得重来 —— 这样连续改一个文件不会每 20 秒切一刀。
function dirtySignature(files) {
  let sig = '';
  for (const line of files) {
    const p = line.slice(3).trim().replace(/^"|"$/g, '').replace(/\\"/g, '"');
    let mt = '?';
    try { mt = String(fs.statSync(path.join(ROOT, p)).mtimeMs); } catch (e) { }
    sig += p + ':' + mt + ';';
  }
  return sig;
}

// git 正在做别的事（合并 / rebase / 加锁）时，绝对不要插手
function gitBusy() {
  const g = path.join(ROOT, '.git');
  for (const f of ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
    if (fs.existsSync(path.join(g, f))) return f;
  }
  return '';
}

function aheadCount() {
  const r = git(['rev-list', '--count', 'origin/' + BRANCH + '..HEAD']);
  return r.ok ? (parseInt(r.out, 10) || 0) : 0;
}

// 远端比本地多几个提交（本机落后多少）
function behindCount() {
  const r = git(['rev-list', '--count', 'HEAD..origin/' + BRANCH]);
  return r.ok ? (parseInt(r.out, 10) || 0) : 0;
}

// ---- 从远端拉 ----
// 只在工作区干净时合入：正在编辑的文件被 rebase 换掉，热重载会读到半成品。
// --autostash 是双保险，万一有残留改动也不会丢。
let lastFetchAt = 0;
let lastPulledHead = '';

function syncFromRemote(force) {
  const now = Date.now();
  if (!force && now - lastFetchAt < FETCH_MS) return false;
  lastFetchAt = now;

  const f = git(['fetch', '--quiet', 'origin', BRANCH]);
  if (!f.ok) {
    log('拉取远端状态失败（本地不受影响，稍后重试）：' + (f.err || f.out).slice(0, 200));
    return false;
  }

  const behind = behindCount();
  if (!behind) return false;

  const remoteHead = git(['rev-parse', '--short', 'origin/' + BRANCH]).out;
  if (remoteHead && remoteHead === lastPulledHead) return false;

  log('远端有 ' + behind + ' 个新提交（' + remoteHead + '），开始合入…');
  const r = git(['pull', '--rebase', '--autostash', 'origin', BRANCH]);
  if (r.ok) {
    const head = git(['rev-parse', '--short', 'HEAD']).out;
    lastPulledHead = remoteHead;
    log('已合入远端 ' + behind + ' 个提交，本地现在是 ' + head + '。');
    // 合进来的若是 .js 改动，热重载会自己重启服务，这里只提示一下
    log('（若改动涉及后端代码，服务会自动热重启，无需手动操作）');
    return true;
  }

  log('合入远端失败（可能有冲突），已撤销 rebase，本地提交保持完整：' + (r.err || r.out).slice(0, 300));
  git(['rebase', '--abort']);
  lastPulledHead = remoteHead;   // 避免同一批提交反复撞
  return false;
}

function tryPush() {
  const now = Date.now();
  if (now - lastPushFailAt < pushBackoff) return;

  const p = git(['push', 'origin', 'HEAD:' + BRANCH]);
  if (p.ok) {
    if (pushBackoff !== 5000) log('推送已恢复。');
    pushBackoff = 5000;
    log('已推送到 GitHub（' + BRANCH + '），远端已是最新。');
    return;
  }

  const err = (p.err || p.out).trim();

  // 远端有本机没有的提交（比如别人/别的 AI 推过）→ rebase 一次再推
  if (/non-fast-forward|fetch first|rejected|\(fetch first\)/i.test(err)) {
    log('远端有新提交，先 rebase 再推…');
    const r = git(['pull', '--rebase', '--autostash', 'origin', BRANCH]);
    if (r.ok) {
      const p2 = git(['push', 'origin', 'HEAD:' + BRANCH]);
      if (p2.ok) {
        log('rebase 后推送成功。');
        pushBackoff = 5000;
        return;
      }
      log('rebase 成功但推送仍失败：' + (p2.err || p2.out).slice(0, 300));
    } else {
      log('rebase 失败（可能有冲突，需人工处理）：' + (r.err || r.out).slice(0, 300));
      // 冲突时先撤销 rebase，回到干净状态，避免仓库卡在 rebase 中途
      git(['rebase', '--abort']);
      log('已撤销 rebase，本地提交保持完整，等人工处理冲突。');
    }
    lastPushFailAt = now;
    pushBackoff = 10 * 60 * 1000;   // 冲突属于要人管的事，别每 30 秒撞一次
    return;
  }

  // 网络抖动 / 认证问题：指数退避，无限重试
  lastPushFailAt = now;
  pushBackoff = Math.min(pushBackoff * 2, PUSH_BACKOFF_MAX);
  log('推送失败，' + Math.round(pushBackoff / 1000) + ' 秒后重试：' + err.slice(0, 240));
}

function commitAndPush(files) {
  git(['add', '-A']);

  // 提交信息带上变更清单，远端 AI 一眼就知道改了什么
  const shown = files.slice(0, 8).join('\n');
  const more = files.length > 8 ? '\n… 另有 ' + (files.length - 8) + ' 个文件' : '';
  const msg = ('[auto] ' + stamp() + ' · ' + files.length + ' 个文件\n\n' + shown + more).slice(0, 4000);

  const c = git(['commit', '-m', msg]);
  dirtySince = 0;

  if (!c.ok) {
    const err = (c.err || c.out);
    if (/nothing to commit|no changes added/i.test(err)) return;
    log('提交失败：' + err.slice(0, 300));
    return;
  }
  const hash = git(['rev-parse', '--short', 'HEAD']).out;
  log('已提交 ' + files.length + ' 个文件（' + hash + '）');
  tryPush();
}

// -c core.quotepath=false：不加的话中文文件名会被转义成 "\350\207\252..." 八进制，
// 远端 AI 看提交信息根本不知道改了哪个文件。
function gitStatusPorcelain() {
  return git(['-c', 'core.quotepath=false', 'status', '--porcelain']);
}

function tick() {
  if (fs.existsSync(PAUSE_FLAG)) {
    dirtySince = 0;
    return;
  }

  const busy = gitBusy();
  if (busy) { log('git 正忙（' + busy + '），本轮跳过。'); return; }

  const st = gitStatusPorcelain();
  if (!st.ok) { log('git status 执行失败：' + st.err.slice(0, 200)); return; }

  const files = st.out ? st.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];

  // 工作区干净 → 先把本地没推的补推掉，没得推就去远端看看有没有新东西
  if (!files.length) {
    dirtySince = 0; lastSig = ''; lastChangeAt = 0;
    if (aheadCount() > 0) { tryPush(); return; }
    syncFromRemote();
    return;
  }

  // 判断「还在写」还是「已经停手」
  const sig = dirtySignature(files);
  if (sig !== lastSig) {
    if (!dirtySince) {
      dirtySince = Date.now();
      log('检测到 ' + files.length + ' 个文件有改动，停手 ' + Math.round(QUIET_MS / 1000) + ' 秒后自动提交推送。');
    }
    lastSig = sig;
    lastChangeAt = Date.now();
    return;
  }

  const quiet = Date.now() - lastChangeAt;
  const waited = Date.now() - dirtySince;
  // 停手够久就提交；一直连着改则最多等 MAX_WAIT 强制推一次，避免长时间不落袋
  if (quiet < QUIET_MS && waited < MAX_WAIT_MS) return;

  commitAndPush(files);
  lastSig = ''; lastChangeAt = 0;
}

// ---- 启动 ----
const ONCE = process.argv.includes('--once');
log('自动同步已启动（PID ' + process.pid + '）：每 ' + Math.round(POLL_MS / 1000) + ' 秒检查一次，'
  + '停手 ' + Math.round(QUIET_MS / 1000) + ' 秒即自动提交并推送到 origin/' + BRANCH + '（连改时最多 ' + Math.round(MAX_WAIT_MS / 60000) + ' 分钟兜底一次）；'
  + '空闲时每 ' + Math.round(FETCH_MS / 60000) + ' 分钟拉一次远端，别人推上来的改动会自动合入。');
if (fs.existsSync(PAUSE_FLAG)) log('注意：.sync-pause 存在，当前处于暂停状态。');

const head = git(['rev-parse', '--short', 'HEAD']);
log('当前 HEAD ' + head.out);

if (ONCE) {
  // 手动跑一轮：先在本地检查改动 / 补推，再强制拉一次远端。给 sync-status 和排查用。
  lastFetchAt = 0;
  tick();
  syncFromRemote(true);
  const h2 = git(['rev-parse', '--short', 'HEAD']).out;
  const st = gitStatusPorcelain();
  log('单轮结束：HEAD ' + h2 + '，工作区' + (st.out ? '有未提交改动（下次静默 25 秒后会提交）' : '干净') + '，领先远端 ' + aheadCount() + ' 个提交。');
  process.exit(0);
}

tick();
// 注意：这里**不能** unref，否则事件循环里没有引用者，进程跑完第一轮就退出了
setInterval(tick, POLL_MS);

process.on('SIGINT', () => { log('收到停止信号，退出。'); process.exit(0); });
process.on('SIGTERM', () => { log('收到停止信号，退出。'); process.exit(0); });
