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
const fs = require('fs');
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
  // -c core.quotepath=false：否则含中文的文件名会被 git 转义成 \344\272 这类八进制，看不懂
  const r = git(['-c', 'core.quotepath=false', 'status', '--porcelain']);
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

// ---------- 命令：打印当前基座 ----------
// 交给外部 AI（Claude 等）的基座永远是「此刻的 HEAD」，不要用口头报的数字，那些会过期。
function cmdBase() {
  const short = git(['rev-parse', '--short', 'HEAD']).out;
  const when = git(['log', '-1', '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%ad']).out;
  const subject = git(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--pretty=format:%s']).out;
  const dirty = porcelain().length;

  console.log('\n  当前基座（HEAD）：' + short);
  console.log('    时间：' + when);
  console.log('    说明：' + subject);
  console.log('    工作区：' + (dirty ? dirty + ' 个文件未提交（基座 ≠ 磁盘现状）' : '干净'));
  console.log('\n  想让外部 AI 对齐，直接双击「交接给Claude.bat」，会自动把基座填进去。\n');
}

// ---------- 命令：应用外部 AI 给的 patch ----------
// 之所以带 3-way：对方生成 patch 时用的基座可能比我现在的 HEAD 早一两个提交，
// 只要两边改的不是同一段代码，git 就能自动合上，不必要求基座完全一致。
//
// 坑：`git apply --3way` 隐含 `--index`，会把改动**直接写进暂存区**。
// 那样一来 `git checkout -- <文件>` 就还原不掉了（它会从暂存区恢复）。
// 所以 3-way 成功后我们会把涉及的路径从暂存区退回去，保持「改动都还在工作区」的一致心智。
function patchPaths(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const set = new Set();
  txt.split('\n').forEach((line) => {
    const m = /^(?:\+\+\+|---) [ab]\/(.+)$/.exec(line);
    if (!m) return;
    const p = m[1].replace(/\t.*$/, '').trim();
    if (p && p !== 'dev/null') set.add(p);
  });
  return Array.from(set);
}

function cmdApply(patchFile) {
  if (!patchFile) {
    console.log('\n  用法：node version.js apply <patch文件>\n');
    return;
  }
  const file = path.resolve(ROOT, patchFile);
  if (!fs.existsSync(file)) die('找不到 patch 文件：' + file);

  const before = git(['rev-parse', '--short', 'HEAD']).out;
  const dirtyBefore = porcelain().length;

  const tiers = [
    { name: '3-way 合并', args: ['apply', '--3way', '--whitespace=nowarn', file] },
    { name: '直接应用', args: ['apply', '--whitespace=nowarn', file] },
    { name: '容错应用（合不上的段落成 .rej）', args: ['apply', '--reject', '--whitespace=nowarn', file] },
  ];

  let applied = '';
  let lastErr = '';
  for (const t of tiers) {
    const r = git(t.args);
    if (r.ok) { applied = t.name; break; }
    lastErr = r.out;
  }

  const paths = patchPaths(file);

  // 把 3-way 顺带写进暂存区的内容退回工作区，让后续「丢弃」只需 git checkout --
  const unstaged = applied === '3-way 合并' && paths.length
    ? git(['reset', '-q', 'HEAD', '--'].concat(paths)).ok
    : false;

  if (!applied) {
    console.log('\n  ✗ patch 没能应用。git 的说明：\n');
    console.log('    ' + lastErr.split('\n').join('\n    '));
    console.log('\n  常见原因：对方用的基座和当前代码在同一段位置上已经不一样了。');
    console.log('  建议：把「node version.js base」的输出发给对方，让它基于最新基座重新出 patch。\n');
    process.exit(1);
  }

  // 冲突标记检测：3-way 有可能「应用成功但内容带冲突」
  const conflicted = paths.filter((p) => {
    try { return fs.readFileSync(path.join(ROOT, p), 'utf8').includes('<<<<<<<'); }
    catch (e) { return false; }
  });
  const rej = porcelain().filter((l) => l.endsWith('.rej'));

  const touched = git(['-c', 'core.quotepath=false', 'status', '--porcelain', '--'].concat(paths))
    .out.split('\n').filter(Boolean);

  console.log('\n  ✓ patch 已应用（' + applied + '）');
  console.log('    基座未变：' + before + '（只改动工作区，还没有提交）');
  console.log('    涉及文件：');
  if (touched.length) touched.forEach((l) => console.log('      ' + l));
  else console.log('      （没有检测到变化，patch 可能是空的）');
  if (unstaged) console.log('    （已把 3-way 顺带放进暂存区的改动退回工作区）');

  if (conflicted.length || rej.length) {
    console.log('\n  ⚠ 有冲突没合干净，动手前先检查：');
    conflicted.forEach((p) => console.log('      ' + p + '  ← 文件里有 <<<<<<< 冲突标记，需要人工合并'));
    rej.forEach((l) => console.log('      ' + l.replace(/^\?\?\s*/, '') + '  ← 合不上的片段'));
    console.log('    先别急着 save。想整体丢弃这次 patch：git checkout -- <上面列的文件>');
    console.log('');
    return;
  }

  console.log('\n  下一步：');
  console.log('    ① 刷新页面看效果（后端会自动热重载）');
  console.log('    ② 满意 → node version.js save "这次改了什么"');
  console.log('    ③ 不满意 → git checkout -- <上面列的文件>  整体丢弃这次 patch');
  if (dirtyBefore) {
    console.log('\n  注意：应用前工作区本来就有 ' + dirtyBefore + ' 个文件改动，' +
      'save 时会把它们和 patch 一起提交，确认一下是否需要。');
  }
  console.log('');
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
  if (cmd === 'base') {
    cmdBase();
    return;
  }
  if (cmd === 'apply') {
    cmdApply(argv[1]);
    return;
  }

  console.log('\n  ML Suite · 版本管理\n');
  console.log('  用法：');
  console.log('    node version.js save "改动说明"       保存当前版本');
  console.log('    node version.js list                  查看历史版本');
  console.log('    node version.js rollback <编号|标签>   回滚到指定版本');
  console.log('    node version.js base                  查看当前基座（交给外部 AI 用）');
  console.log('    node version.js apply <patch文件>      应用外部 AI 给的 patch');
  console.log('    node version.js                       打开交互菜单\n');
})();
