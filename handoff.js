#!/usr/bin/env node
/**
 * ML Suite · 生成「交给外部 AI（Claude 等）」的开场白
 *
 * 为什么需要它：
 *   以前我会口头告诉对方一个固定的 commit 号当基座，但基座是会往前走的
 *   （每次修 bug / 加功能都会产生新提交），口头数字必然过期 → 对方拿着旧基座改，
 *   轻则 patch 打不上，重则把已经修好的代码改回旧样子。
 *
 *   所以这里把「基座」改成**自动取当前 HEAD**，并生成一段可以直接粘贴的开场白。
 *   使用者双击「交接给Claude.bat」→ 内容自动进剪贴板 → 直接粘贴给对方即可。
 *
 * 用法：
 *   node handoff.js            生成并复制到剪贴板
 *   node handoff.js --print    只在终端打印，不复制
 *   node handoff.js base       只打印当前基座（HEAD）
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const OUT_TXT = path.join(ROOT, '交接给Claude.txt');
const REPO_URL = 'https://github.com/Yvonelam/ml-suite';
const RECENT_LIMIT = 6;

function git(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      env: Object.assign({}, process.env, {
        LC_ALL: 'C',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
      }),
    });
    return String(out).replace(/\s+$/, '');
  } catch (e) {
    return '';
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 当前基座（HEAD） */
function currentBase() {
  const short = git(['rev-parse', '--short', 'HEAD']);
  const full = git(['rev-parse', 'HEAD']);
  const subject = git(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--pretty=format:%s']);
  const when = git(['log', '-1', '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%ad']);
  return { short, full, subject, when };
}

/** 最近几次改动，给对方一点「我刚改过什么」的上下文 */
function recentCommits(limit) {
  const out = git(['-c', 'i18n.logOutputEncoding=UTF-8', 'log',
    '--date=format:%m-%d %H:%M', '--pretty=format:%h\x1f%ad\x1f%s', '-n', String(limit)]);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const p = line.split('\x1f');
    return { sha: p[0] || '', date: p[1] || '', msg: p.slice(2).join(' ').trim() };
  });
}

/** 有没有还没提交的改动（有的话要提醒：基座不等于磁盘现状） */
function dirtyCount() {
  const out = git(['status', '--porcelain']);
  return out ? out.split('\n').filter(Boolean).length : 0;
}

function buildMessage(base, commits, dirty) {
  const recent = commits.length
    ? commits.map((c) => '  - ' + c.sha + '  ' + c.date + '  ' + c.msg).join('\n')
    : '  - （没有历史记录）';

  const dirtyLine = dirty
    ? '\n⚠️ 我这台机器上还有 ' + dirty + ' 个文件刚改完、**还没提交**。也就是说：\n' +
      '   你 clone 到的 HEAD 里不包含它们。如果下面这件事正好会碰到那些文件，\n' +
      '   请先停下来问我，别直接改 —— 否则会和我未提交的改动打架。\n'
    : '';

  return [
    '你是我这台电脑上「ML Suite · 美客多运营工作台」项目的协作者。请严格按下面执行。',
    '',
    '【仓库】' + REPO_URL,
    '',
    '【基座 base / 怎么定】',
    '  ⚠️ 不要使用任何人（包括我）口头报给你的 commit 号 —— 那些数字会过期。',
    '  请你自己取：clone 之后执行 `git rev-parse --short HEAD`，把它的结果当作你的基座，',
    '  并在你给出的 patch 第一行注明 `Base: <那个 hash>`。',
    '  我这边此刻的 HEAD 是：' + base.short + '（' + (base.when || '') + '  ' + (base.subject || '') + '）',
    '  → 你 clone 完自检一下：如果和上面这个 hash 一致，说明你拿到的就是最新代码。',
    dirtyLine,
    '【我最近的改动（让你知道代码刚动过什么）】',
    recent,
    '',
    '【第一步】先完整读仓库根目录的 `HANDOFF-PROMPT.md`，按里面的约束干活：',
    '  - 服务已经在跑了，你**不要**自己起服务、不要停服务、不要动任何 .bat',
    '  - 你**不要** push（推送我来做）',
    '  - 不要引入任何构建工具 / 前端 npm 依赖，不要重构目录',
    '  - 注释与界面文案用中文',
    '【第二步】只做下面这一件事（我把要求写在下面）：',
    '',
    '【改哪里】',
    '页面/入口：',
    '大概涉及（不知道就留空）：',
    '',
    '【现状】',
    '现在是这样的：',
    '',
    '【期望效果】',
    '改成这样：',
    '',
    '【验收标准】',
    '- ',
    '- ',
    '',
    '【约束】',
    '- 保持现有视觉风格（深色玻璃 / 科幻风），不要重做整体样式',
    '- 不要新增依赖、不要引入构建工具',
    '- 只改这个功能相关的代码，不要顺手重构别处',
    '- 若涉及后端，请说明改了哪个路由 / 字段',
    '',
    '【交付方式】',
    '  - 用 `git diff` 输出 patch（保留 `index` 行、不要加 `--no-prefix`），贴给我，我来落地。',
    '    我会用 `git apply --3way` 应用，所以哪怕基座差一两个提交，只要不冲突就能自动合上。',
    '  - 不要 push、不要起服务、不要动任何 .bat。',
    '  - 如果改动文件很小（不到 200 行），也可以直接把**完整文件内容**给我，那样最不容易出错。',
    '',
    '---',
    '（本段由 handoff.js 于 ' + stamp() + ' 自动生成，基座 ' + base.short + '）',
  ].join('\n');
}

/**
 * 复制到剪贴板。两条路，中文都不会乱码：
 *   1) 首选 PowerShell 的 Set-Clipboard：从文件读内容，**不经过 stdin 管道**
 *      （带 stdin 管道的子进程在某些受限环境会被拦），实测与文件逐字符一致。
 *   2) 退路 clip.exe：喂 UTF-16LE + BOM 的字节流，这是 Windows 上复制 Unicode 的经典做法。
 */
function copyToClipboard(text, filePath) {
  if (filePath) {
    try {
      const p = String(filePath).replace(/'/g, "''");
      const cmd = "Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '" + p + "')";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 20000,
      });
      if (!r.error && r.status === 0) return 'powershell';
    } catch (e) { /* 落到退路 */ }
  }

  try {
    const buf = Buffer.from('\uFEFF' + text, 'utf16le');
    const r = spawnSync('clip', [], { input: buf, shell: false });
    if (!r.error && r.status === 0) return 'clip';
  } catch (e) { /* 放弃 */ }

  return '';
}

function main() {
  const argv = process.argv.slice(2);
  const mode = (argv[0] || '').toLowerCase();

  const base = currentBase();
  if (!base.short) {
    console.error('\n✗ 读取 git HEAD 失败，确认当前目录是 git 仓库：' + ROOT + '\n');
    process.exit(1);
  }

  if (mode === 'base') {
    console.log('\n  当前基座（HEAD）：' + base.short + '  ' + (base.when || '') + '  ' + (base.subject || '') + '\n');
    return;
  }

  const commits = recentCommits(RECENT_LIMIT);
  const dirty = dirtyCount();
  const msg = buildMessage(base, commits, dirty);

  let wrote = false;
  if (mode !== '--print') {
    try { fs.writeFileSync(OUT_TXT, '\uFEFF' + msg, 'utf8'); wrote = true; } catch (e) { /* 写不了就算了 */ }
  }

  console.log('\n  ============================================================');
  console.log('   交给 Claude 的开场白');
  console.log('  ============================================================');
  console.log('   基座（HEAD）：' + base.short + '  ' + (base.when || ''));
  console.log('   最近改动 ' + commits.length + ' 条' + (dirty ? '，另有 ' + dirty + ' 个文件未提交' : '，工作区干净'));
  console.log('  ------------------------------------------------------------');

  if (mode === '--print') {
    console.log(msg);
    console.log('\n  （--print 模式，未复制到剪贴板）\n');
    return;
  }

  const via = copyToClipboard(msg, wrote ? OUT_TXT : '');
  if (via) {
    console.log('   ✓ 已复制到剪贴板');
    console.log('     → 打开 Claude，直接 Ctrl+V 粘贴，然后在【】里填需求即可');
  } else {
    console.log('   ⚠ 自动复制没成功，手动来一下：');
    console.log('     打开本文件夹里的「交接给Claude.txt」');
    console.log('     全选复制（Ctrl+A 再 Ctrl+C）后粘贴给对方即可');
  }
  console.log('  ------------------------------------------------------------');
  console.log('   小提醒：你在让 Claude 改的时候，别同时让我改同一批文件，');
  console.log('   否则两边的改动会打架。\n');
}

main();
