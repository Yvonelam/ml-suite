#!/usr/bin/env node
/**
 * ML Suite · 版本管理
 *
 * 用途：让 AI 改代码这件事变得「可回退」。
 *   - save     把当前所有改动存成一个版本（提交 + 打标签）
 *   - list     列出最近的版本
 *   - rollback 回滚到某个版本（回滚前会先把当前状态自动备份，绝不丢东西）
 *
 * 用法（推荐直接双击「版本管理.bat」进交互菜单）：
 *   node version.js save "改了热搜词卡片"
 *   node version.js list
 *   node version.js rollback 2
 *   node version.js rollback snap-20261015-165500
 *
 * 说明：所有 git 输出都由本脚本捕获后再打印，避免 Windows 控制台代码页把中文搞乱。
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const readline = require('readline');

const ROOT = __dirname;
const SNAP = 'snap-';     // 版本快照标签前缀
const SAFETY = 'safety-'; // 回滚前自动备份标签前缀
const LIST_LIMIT = 30;

// ---------- git 调用封装（永远不让 git 直接往终端写字） ----------
function git(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: Object.assign({}, process.env, {
        LC_ALL: 'C',            // 让 git 自己的提示语走英文，规避中文 Windows 的 GBK/UTF-8 冲突
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
      }),
    });
    return { ok: true, out: String(out).replace(/\s+$/, '') };
  } catch (e) {
    const buf = String(e.stdout || '') + String(e.stderr || '');
    return { ok: false, out: (buf || e.message || '').trim() };
  }
}

function die(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

function ensureRepo() {
  const r = git(['rev-parse', '--is-inside-work-tree']);
  if (!r.ok) die('找不到 git，或当前目录不是 git 仓库。\n  ' + r.out);
  if (r.out !== 'true') die('当前目录不是 git 仓库：' + ROOT);
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function porcelain() {
  const r = git(['status', '--porcelain']);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean);
}

// ---------- 命令：保存版本 ----------
function cmdSave(message) {
  const changes = porcelain();
  if (!changes.length) {
    console.log('\n  没有检测到任何改动，无需保存。');
    return;
  }

  const msg = (message && String(message).trim()) || '未命名改动';
  const ts = now();
  const tag = SNAP + ts;

  const add = git(['add', '-A']);
  if (!add.ok) die('暂存改动失败：\n  ' + add.out);

  const commit = git(['commit', '-m', msg]);
  if (!commit.ok) {
    // 唯一可预期的「失败」是没有可提交内容（比如全是空行改动）
    if (/nothing to commit/i.test(commit.out)) {
      console.log('\n  没有实质改动需要保存。');
      return;
    }
    die('提交失败：\n  ' + commit.out);
  }

  const sha = git(['rev-parse', '--short', 'HEAD']).out;
  const tagRes = git(['tag', '-a', tag, '-m', msg]);

  console.log('\n  ✓ 已保存版本 ' + tag + '  （提交 ' + sha + '）');
  console.log('    说明：' + msg);
  console.log('    改动 ' + changes.length + ' 个文件');

  if (!tagRes.ok) {
    console.log('    （标签创建失败，但提交已成功，不影响回滚）');
  } else {
    console.log('\n  不满意想回到这一版：node version.js rollback ' + tag);
  }
}

// ---------- 命令：列出版本 ----------
function readCommits(limit) {
  const r = git([
    '-c', 'i18n.logOutputEncoding=UTF-8',
    'log',
    '--date=format:%Y-%m-%d %H:%M',
    '--pretty=format:%h\x1f%ad\x1f%d\x1f%s',
    '-n', String(limit),
  ]);
  if (!r.ok) die('读取提交历史失败：\n  ' + r.out);

  return r.out.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\x1f');
    const sha = parts[0] || '';
    const date = parts[1] || '';
    const deco = parts[2] || '';
    const msg = parts.slice(3).join(' ').trim();
    const tags = (deco.match(/tag: [^,)\s]+/g) || []).map((s) => s.slice(5));
    return { sha, date, msg, tags };
  });
}

function cmdList() {
  const commits = readCommits(LIST_LIMIT);
  if (!commits.length) {
    console.log('\n  还没有任何版本记录。');
    return commits;
  }

  console.log('\n  ' + '='.repeat(74));
  console.log('   编号  提交      时间               版本标签 / 说明');
  console.log('  ' + '='.repeat(74));

  commits.forEach((c, i) => {
    const no = String(i + 1).padStart(3, ' ');
    const tag = c.tags.find((t) => t.startsWith(SNAP)) || c.tags[0] || '';
    console.log('  [' + no + ']  ' + c.sha.padEnd(8) + '  ' + c.date.padEnd(17) + '  ' +
      (tag ? tag + ' ' : '') + c.msg);
  });

  console.log('  ' + '='.repeat(74));
  console.log('  [ 1 ] 是最新的（当前状态）。回滚示例：node version.js rollback 2\n');
  return commits;
}

// ---------- 命令：回滚 ----------
function resolveTarget(target, commits) {
  const t = String(target).trim();
  if (!t) return null;

  // 纯数字 = 列表里的编号
  if (/^\d+$/.test(t)) {
    const idx = parseInt(t, 10) - 1;
    if (idx < 0 || idx >= commits.length) return { error: '编号超出范围（可用 1 - ' + commits.length + '）' };
    return { sha: commits[idx].sha, desc: '#' + t + ' ' + commits[idx].sha + ' ' + commits[idx].msg };
  }

  // 标签或 sha
  const verify = git(['rev-parse', '--verify', '--quiet', t + '^{commit}']);
  if (!verify.ok || !verify.out) return { error: '找不到这个版本：' + t };
  const short = verify.out.slice(0, 7);
  const subj = git(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--pretty=format:%s', verify.out]).out;
  return { sha: verify.out, desc: t + ' (' + short + ') ' + subj };
}

function cmdRollback(target, commits) {
  const list = commits || readCommits(LIST_LIMIT);
  const resolved = resolveTarget(target, list);
  if (!resolved) return console.log('\n  已取消。');
  if (resolved.error) return console.log('\n  ✗ ' + resolved.error + '\n');

  const headSha = git(['rev-parse', '--short', 'HEAD']).out;
  const headSubject = git(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--pretty=format:%s']).out;

  // 1) 先把「当前状态」备份成一个标签，保证回滚本身也可逆
  const safetyTag = SAFETY + now();
  const safety = git(['tag', '-a', safetyTag, '-m', '回滚前自动备份：' + headSha + ' ' + headSubject]);
  if (!safety.ok) {
    console.log('\n  ✗ 备份当前状态失败，为安全起见已中止回滚：\n    ' + safety.out + '\n');
    process.exit(1);
  }

  // 2) 硬回滚到目标版本
  const reset = git(['reset', '--hard', resolved.sha]);
  if (!reset.ok) die('回滚失败：\n  ' + reset.out);

  const destSha = git(['rev-parse', '--short', 'HEAD']).out;
  const dirty = porcelain();

  console.log('\n  ✓ 已回滚');
  console.log('    从：' + headSha + '  ' + headSubject);
  console.log('    到：' + destSha + '  ' + resolved.desc);
  console.log('    回滚前的状态已备份为标签：' + safetyTag);
  console.log('\n  反悔了？回到回滚前：node version.js rollback ' + safetyTag);
  if (dirty.length) {
    console.log('  （注意：有 ' + dirty.length + ' 个未跟踪文件未受影响，如各类缓存文件）');
  }
  console.log('\n  服务会自动热重载，刷新浏览器即可看到回滚后的效果。\n');
}

// ---------- 交互式菜单 ----------
function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (;;) {
    console.log('\n  ============================================================');
    console.log('   ML Suite · 版本管理');
    console.log('  ============================================================');
    console.log('   [1] 保存当前版本（把现在的改动存成一个可回滚的快照）');
    console.log('   [2] 查看历史版本');
    console.log('   [3] 回滚到某个版本');
    console.log('   [0] 退出');
    console.log('  ============================================================');

    const choice = (await ask(rl, '   请选择 [0-3]：')).trim();

    if (choice === '0' || choice === '') { break; }

    if (choice === '1') {
      const msg = (await ask(rl, '   这一版改了什么？（回车跳过）：')).trim();
      cmdSave(msg);
      continue;
    }

    if (choice === '2') {
      cmdList();
      continue;
    }

    if (choice === '3') {
      const commits = readCommits(LIST_LIMIT);
      if (!commits.length) { console.log('\n  还没有任何版本记录。'); continue; }
      cmdList();

      const pick = (await ask(rl, '   回滚到哪个编号？（直接回车取消）：')).trim();
      if (!pick) { console.log('\n  已取消。'); continue; }

      const target = resolveTarget(pick, commits);
      if (!target || target.error) { console.log('\n  ✗ ' + (target ? target.error : '无效输入') + '\n'); continue; }

      const confirm = (await ask(rl, '   确认回滚到 ' + target.desc + ' ？(y/N)：')).trim().toLowerCase();
      if (confirm !== 'y' && confirm !== 'yes') { console.log('\n  已取消。'); continue; }

      cmdRollback(pick, commits);
      continue;
    }

    console.log('\n  ✗ 无效选择，请输入 0 - 3。');
  }

  rl.close();
  console.log('\n  再见。\n');
}

// ---------- 入口 ----------
(function main() {
  ensureRepo();
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || '').toLowerCase();

  if (!cmd) return menu();

  if (cmd === 'save' || cmd === 'snapshot') {
    cmdSave(argv.slice(1).join(' '));
    return;
  }
  if (cmd === 'list' || cmd === 'ls' || cmd === 'log') {
    cmdList();
    return;
  }
  if (cmd === 'rollback' || cmd === 'back') {
    if (!argv[1]) {
      console.log('\n  用法：node version.js rollback <编号|标签|提交号>');
      cmdList();
      return;
    }
    cmdRollback(argv.slice(1).join(' '));
    return;
  }

  console.log('\n  ML Suite · 版本管理\n');
  console.log('  用法：');
  console.log('    node version.js save "改动说明"       保存当前版本');
  console.log('    node version.js list                  查看历史版本');
  console.log('    node version.js rollback <编号|标签>   回滚到指定版本');
  console.log('    node version.js                       打开交互菜单\n');
})();
