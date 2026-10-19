#!/usr/bin/env node
/**
 * ML Suite · 同步状态检查
 *
 * 双击「同步状态.bat」即可，回答四个问题：
 *   1. 自动同步进程还活着吗
 *   2. 本地有没有还没提交的改动
 *   3. 本地有没有还没推上去的提交（→ GitHub 上是旧的）
 *   4. 远端有没有本机还没合入的提交（→ 别的 AI 推的新代码你本地看不到）
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BRANCH = process.env.SYNC_BRANCH || 'main';
const LOG = path.join(ROOT, '同步日志.txt');
const AUTOSYNC_PID = path.join(ROOT, '.autosync.pid');
const SYNC_OFF = path.join(ROOT, '.sync-off');
const SYNC_PAUSE = path.join(ROOT, '.sync-pause');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };

function git(args) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: ROOT, env: GIT_ENV, encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, out: '', err: String((e.stderr || e.message || '')).trim() };
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const C = { r: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', cya: '\x1b[36m', b: '\x1b[1m' };
const line = (k, v) => console.log('  ' + k.padEnd(16, ' ') + v);

console.log('');
console.log(C.b + '  ML Suite · 同步状态' + C.r + C.dim + '   ' + new Date().toLocaleString('zh-CN') + C.r);
console.log('  ' + '─'.repeat(66));

// ---- 1. 自动同步进程 ----
let pid = 0;
try { pid = parseInt(fs.readFileSync(AUTOSYNC_PID, 'utf8'), 10) || 0; } catch (e) { }
if (fs.existsSync(SYNC_OFF)) {
  line('自动同步', C.red + '已关闭' + C.r + '（存在 .sync-off，双击「自动同步-开启.bat」恢复）');
} else if (pidAlive(pid)) {
  line('自动同步', C.grn + '在运行' + C.r + C.dim + '  PID ' + pid + C.r);
} else {
  line('自动同步', C.red + '没在运行' + C.r + '（1 分钟内启动器会自动拉起；也可以双击「自动同步-开启.bat」）');
}
if (fs.existsSync(SYNC_PAUSE)) line('暂停标记', C.yel + '有 .sync-pause，当前暂停提交' + C.r);

// ---- 2. 未提交改动 ----
const st = git(['-c', 'core.quotepath=false', 'status', '--porcelain']);
const files = st.ok && st.out ? st.out.split('\n').filter(Boolean) : [];
if (!files.length) {
  line('未提交改动', C.grn + '无' + C.r + C.dim + '  工作区干净' + C.r);
} else {
  line('未提交改动', C.yel + files.length + ' 个文件' + C.r + C.dim + '（停手 25 秒后自动提交，最多等 5 分钟）' + C.r);
  for (const f of files.slice(0, 8)) console.log('      ' + C.dim + f + C.r);
  if (files.length > 8) console.log('      ' + C.dim + '… 另有 ' + (files.length - 8) + ' 个' + C.r);
}

// ---- 3+4. 领先 / 落后 ----
const f = git(['fetch', '--quiet', 'origin', BRANCH]);
if (!f.ok) {
  line('远端连通', C.red + '拉取失败' + C.r + C.dim + '  ' + (f.err || '').slice(0, 120) + C.r);
} else {
  const ahead = Number(git(['rev-list', '--count', 'origin/' + BRANCH + '..HEAD']).out) || 0;
  const behind = Number(git(['rev-list', '--count', 'HEAD..origin/' + BRANCH]).out) || 0;
  line('未推送', ahead === 0
    ? C.grn + '0 个' + C.r + C.dim + '  GitHub 上已是最新' + C.r
    : C.red + ahead + ' 个提交' + C.r + C.dim + '  GitHub 上还是旧代码！' + C.r);
  line('未合入', behind === 0
    ? C.grn + '0 个' + C.r + C.dim + '  远端没有新东西' + C.r
    : C.yel + behind + ' 个提交' + C.r + C.dim + '  远端有新代码，本机工作区干净时会自动合入' + C.r);
  line('当前 HEAD', C.cya + (git(['rev-parse', '--short', 'HEAD']).out || '?') + C.r
    + C.dim + '   远端 ' + (git(['rev-parse', '--short', 'origin/' + BRANCH]).out || '?') + C.r);
}

// ---- 最近日志 ----
if (fs.existsSync(LOG)) {
  const all = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  console.log('');
  console.log('  ' + C.b + '最近 8 条同步记录' + C.r);
  for (const l of all.slice(-8)) console.log('  ' + C.dim + l + C.r);
}

console.log('');
console.log('  ' + '─'.repeat(66));
console.log('  ' + C.dim + '出问题时：① 看上面「自动同步」是否在运行 ②「未推送」不再增长说明推上去了' + C.r);
console.log('  ' + C.dim + '③ 远端 AI 推的代码需要本机合入，工作区干净时每 2 分钟自动做一次' + C.r);
console.log('');
