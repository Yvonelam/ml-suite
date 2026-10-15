#!/usr/bin/env node
/**
 * ML Suite · 生成「交给外部 AI」的交接信息（Claude / GPT / Gemini …通用）
 *
 * 设计前提：这套东西**和具体是哪家 AI 无关**。任何 AI 只要能读代码、能给出一份 patch，
 * 就能接进来改这个项目。真正有差别的只有两件事：
 *   1) 它能不能「够到」代码 —— 能联网读公开仓库 / 能读本机目录，还是只能靠我贴给它？
 *   2) 它交付的形状 —— 给 patch，还是给整份文件？
 * 所以这里按「目标 AI」微调措辞，其余部分完全一致。
 *
 * 关于「基座」：绝不能固定成某个 commit。仓库一直往前走，固定住会让对方读到旧代码，
 * 把已经修好的地方改回旧样子。正确做法是让对方 clone 后自己跑 `git rev-parse --short HEAD`。
 *
 * 用法：
 *   node handoff.js                生成通用开场白并复制到剪贴板
 *   node handoff.js claude         针对 Claude 微调（默认就是通用版，差别很小）
 *   node handoff.js gpt            针对 ChatGPT / GPT
 *   node handoff.js gemini         针对 Gemini
 *   node handoff.js pack           把全部源码打包成一个 txt，方便上传给网页版 AI
 *   node handoff.js base           只打印当前基座
 *   node handoff.js --print        只在终端打印，不复制
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_TXT = path.join(ROOT, '交接给AI.txt');
const PACK_TXT = path.join(ROOT, '给AI的源码.txt');
const REPO_URL = 'https://github.com/Yvonelam/ml-suite';
const RECENT_LIMIT = 6;

// ---------- git ----------
function git(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: Object.assign({}, process.env, { LC_ALL: 'C', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }),
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

function currentBase() {
  return {
    short: git(['rev-parse', '--short', 'HEAD']),
    when: git(['log', '-1', '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%ad']),
    subject: git(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--pretty=format:%s']),
  };
}

function recentCommits(limit) {
  const out = git(['-c', 'i18n.logOutputEncoding=UTF-8', 'log',
    '--date=format:%m-%d %H:%M', '--pretty=format:%h\x1f%ad\x1f%s', '-n', String(limit)]);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const p = line.split('\x1f');
    return { sha: p[0] || '', date: p[1] || '', msg: p.slice(2).join(' ').trim() };
  });
}

function dirtyCount() {
  const out = git(['status', '--porcelain']);
  return out ? out.split('\n').filter(Boolean).length : 0;
}

// ---------- 各 AI 的差异点 ----------
// getCode：它怎么拿到代码；deliver：它怎么把成果交回来
const TARGETS = {
  generic: {
    key: 'generic',
    title: '通用（Claude / GPT / Gemini 都适用）',
    getCode: [
      '  - **能联网读仓库 / 能跑命令**：直接 `git clone ' + REPO_URL + '`，或读仓库里的文件。',
      '  - **只能聊天、够不到仓库**：告诉我你需要看哪几个文件，我把内容贴给你 / 上传给你。',
      '    不确定要哪些文件时，直接说「我需要整个源码」，我给你一个打包好的源码文件。',
    ],
    deliver: [
      '  - **改动的文件比较大**（如 `server.js`、`public/app.js`）→ 给我 `git diff` 格式的 patch。',
      '  - **改动的文件比较小**（不到 200 行）→ 直接把**完整文件内容**给我，那样最不容易出错。',
    ],
  },
  claude: {
    key: 'claude',
    title: 'Claude',
    getCode: [
      '  - Claude 网页版可以读公开仓库：`' + REPO_URL + '`；Claude Code 能直接读我本机目录。',
      '  - 如果只看到部分文件，告诉我需要哪些，我补给你。',
    ],
    deliver: [
      '  - 用 `git diff` 输出 patch（保留 `index` 行、不要加 `--no-prefix`），贴在聊天里给我就行。',
      '  - 小文件（不到 200 行）可直接给完整文件内容。',
    ],
  },
  gpt: {
    key: 'gpt',
    title: 'ChatGPT / GPT',
    getCode: [
      '  - ChatGPT 网页版**通常读不到我的仓库**，别假设自己能看到本机或私有内容。',
      '  - 需要代码时直接告诉我「给我这几个文件」，我会把内容贴给你，或上传一个打包好的源码文件。',
    ],
    deliver: [
      '  - 用 `git diff` 输出 patch，**放在一个 ```diff 代码块里**，我直接从聊天复制。',
      '  - 小文件（不到 200 行）可直接给完整文件内容。',
      '  - ⚠️ 不要把 diff 折行、不要加省略号缩写、不要在 patch 里插解释文字 —— 会被 git 拒绝。',
    ],
  },
  gemini: {
    key: 'gemini',
    title: 'Gemini',
    getCode: [
      '  - Gemini 网页版**通常读不到我的仓库**，别假设自己能看到本机或私有内容。',
      '  - 需要代码时直接告诉我「给我这几个文件」，我会把内容贴给你，或上传一个打包好的源码文件。',
    ],
    deliver: [
      '  - 用 `git diff` 输出 patch，**放在一个 ```diff 代码块里**，我直接从聊天复制。',
      '  - 小文件（不到 200 行）可直接给完整文件内容。',
      '  - ⚠️ 不要把 diff 折行、不要加省略号缩写，也不要输出任何「改写片段」以外的说明文字混在 patch 里。',
    ],
  },
};

function buildMessage(base, commits, dirty, t) {
  const recent = commits.length
    ? commits.map((c) => '  - ' + c.sha + '  ' + c.date + '  ' + c.msg).join('\n')
    : '  - （没有历史记录）';

  const dirtyBlock = dirty
    ? [
        '',
        '⚠️ 我这台机器上还有 ' + dirty + ' 个文件刚改完、**还没提交**。也就是说：',
        '   你 clone 到的 HEAD 里不包含它们。如果下面这件事正好会碰到那些文件，',
        '   请先停下来问我，别直接改 —— 否则会和我未提交的改动打架。',
        '',
      ].join('\n')
    : '';

  return [
    '你是「ML Suite · 美客多运营工作台」这个项目的协作 AI。请严格按下面执行。',
    '（本条消息是自动生成的，目标：' + t.title + '）',
    '',
    '【仓库】' + REPO_URL,
    '',
    '【基座 base / 怎么定 —— 这条最重要】',
    '  ⚠️ 不要使用任何人（包括我）口头报给你的 commit 号 —— 那些数字一定会过期。',
    '  请你自己取：拿到代码之后执行 `git rev-parse --short HEAD`，把结果当作你的基座。',
    '  如果你拿不到完整仓库（只能聊天），就以「我贴给你的文件内容」为基准，不用管 hash。',
    '  并在你给出的 patch / 成果里注明你用的基座，例如第一行写 `Base: <hash>`。',
    '  我这边此刻的 HEAD 是：' + base.short + '（' + (base.when || '') + '  ' + (base.subject || '') + '）',
    dirtyBlock,
    '【第一步：先读这份文档】',
    '  仓库根目录的 `HANDOFF-PROMPT.md` —— 里面写了项目结构、硬约束、绝对禁止事项。',
    '  在动手之前先读完它。有疑问一次性问全，不要一轮问一个。',
    '',
    '【你怎么拿到代码】',
  ].concat(t.getCode).concat([
    '',
    '【你允许怎么干活】',
    '  A) 你**够不到我的电脑**（网页版）：你只负责产出代码。改完把成果发我，我来落地。',
    '  B) 你**能操作我这台电脑**（Claude Code / Codex CLI / Gemini CLI 这类本地版）：',
    '     可以直接改文件，但**必须**遵守：',
    '       ❌ 不要 `git push`（推送我来做）',
    '       ❌ 不要启动或停止服务（服务已经在跑了）',
    '       ❌ 不要双击 / 修改任何 `.bat`',
    '       ✅ 改完执行 `node version.js save "你这次改了什么"` 存一个版本快照',
    '       ✅ 前端改完我刷新浏览器就能看到；后端改完会自动热重载（约 1 秒，公网不会断）',
    '',
    '【我最近的改动（让你知道代码刚动过什么）】',
    recent,
    '',
    '【第二步：做下面这一件事】',
    '  一次只做一件事。把需求写在下面这段里：',
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
    '- 不要新增依赖、不要引入构建工具、不要重构目录',
    '- 只改这个功能相关的代码，不要顺手重构别处',
    '- 若涉及后端，请说明改了哪个路由 / 字段',
    '- 注释与界面文案用中文',
    '',
    '【你怎么把成果交给我】',
  ]).concat(t.deliver).concat([
    '  - 我会用 `node version.js apply` 落地你的 patch（内部做了三方合并，所以基座差一两个提交',
    '    通常也能自动合上）。我把 patch 从聊天里复制一下就能落地，你不用存成文件。',
    '',
    '---',
    '（本段由 handoff.js 于 ' + stamp() + ' 自动生成，基座 ' + base.short + '）',
  ]).join('\n');
}

// ---------- 打包源码（给够不到仓库的网页版 AI 用） ----------
function cmdPack() {
  const all = git(['ls-files']).split('\n').filter(Boolean);
  const files = all.filter((f) => {
    if (!/\.(js|html|css|json|md|bat|txt|yml|yaml)$/i.test(f)) return false;
    if (/^public\/vendor\//.test(f)) return false;
    if (/^tools\//.test(f)) return false;
    if (/\.min\.js$/i.test(f)) return false;
    if (f === 'package-lock.json') return false;
    if (/^dm-keyword-rank-/.test(f)) return false;   // 关键词排名导出的报告，运行时产物
    if (/^交接给/.test(f) || /^给AI的/.test(f)) return false;
    return true;
  });

  const parts = [
    '# ML Suite · 源码打包（供够不到仓库的 AI 阅读）',
    '# 生成时间：' + stamp() + '   基座：' + currentBase().short,
    '# 说明：下面按文件拼接，每个文件前有 ===== FILE: 路径 ===== 标记。',
    '# 真实凭据（daily-search-config.json）不在里面，已被 .gitignore 排除。',
    '',
  ];
  let bytes = 0;
  files.forEach((f) => {
    let body = '';
    try { body = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return; }
    bytes += body.length;
    parts.push('===== FILE: ' + f + ' =====');
    parts.push(body.replace(/\s+$/, ''));
    parts.push('');
  });

  const text = parts.join('\n');
  fs.writeFileSync(PACK_TXT, text, 'utf8');
  console.log('\n  ✓ 已打包 ' + files.length + ' 个文件 → ' + path.basename(PACK_TXT));
  console.log('    体积约 ' + Math.round(text.length / 1024) + ' KB');
  console.log('    → 把这个文件上传 / 贴给 GPT、Gemini 等够不到仓库的 AI 即可\n');
}

// ---------- 剪贴板 ----------
// 首选 PowerShell Set-Clipboard：从文件读内容，不经过 stdin 管道
// （带 stdin 管道的子进程在受限环境会被拦），实测与文件逐字符一致。
function copyToClipboard(text, filePath) {
  if (filePath) {
    try {
      const p = String(filePath).replace(/'/g, "''");
      const cmd = "Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '" + p + "')";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
        stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20000,
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

// ---------- 入口 ----------
function main() {
  const argv = process.argv.slice(2);
  const noCopy = argv.includes('--print');                       // 位置无关的标志
  const mode = (argv.find((a) => !a.startsWith('-')) || '').toLowerCase();

  const base = currentBase();
  if (!base.short) {
    console.error('\n✗ 读取 git HEAD 失败，确认当前目录是 git 仓库：' + ROOT + '\n');
    process.exit(1);
  }

  if (mode === 'base') {
    const dirty = dirtyCount();
    console.log('\n  当前基座（HEAD）：' + base.short + '  ' + (base.when || '') + '  ' + (base.subject || ''));
    console.log('  工作区：' + (dirty ? dirty + ' 个文件未提交（基座 ≠ 磁盘现状）' : '干净') + '\n');
    return;
  }

  if (mode === 'pack' || mode === 'files') {
    cmdPack();
    return;
  }

  const target = TARGETS[mode] || TARGETS.generic;
  const commits = recentCommits(RECENT_LIMIT);
  const dirty = dirtyCount();
  const msg = buildMessage(base, commits, dirty, target);

  let wrote = false;
  if (!noCopy) {
    try { fs.writeFileSync(OUT_TXT, '\uFEFF' + msg, 'utf8'); wrote = true; } catch (e) { /* 写不了就算了 */ }
  }

  console.log('\n  ============================================================');
  console.log('   ' + target.title);
  console.log('  ============================================================');
  console.log('   基座（HEAD）：' + base.short + '  ' + (base.when || ''));
  console.log('   最近改动 ' + commits.length + ' 条' + (dirty ? '，另有 ' + dirty + ' 个文件未提交' : '，工作区干净'));
  console.log('  ------------------------------------------------------------');

  if (noCopy) {
    console.log(msg);
    console.log('\n  （--print 模式，未复制到剪贴板）\n');
    return;
  }

  const via = copyToClipboard(msg, wrote ? OUT_TXT : '');
  if (via) {
    console.log('   ✓ 已复制到剪贴板');
    console.log('     → 打开你的 AI，直接 Ctrl+V 粘贴，然后在【】里填需求即可');
  } else {
    console.log('   ⚠ 自动复制没成功，手动来一下：');
    console.log('     打开本文件夹里的「' + path.basename(OUT_TXT) + '」');
    console.log('     全选复制（Ctrl+A 再 Ctrl+C）后粘贴给对方即可');
  }
  console.log('  ------------------------------------------------------------');
  console.log('   对方读不到仓库时（GPT / Gemini 网页版通常是），先跑一下：');
  console.log('     node handoff.js pack');
  console.log('   会生成「给AI的源码.txt」，把它一起上传给对方。');
  console.log('  ------------------------------------------------------------');
  console.log('   小提醒：同一时间只让**一个** AI 改同一批文件，改完存一版快照再换下一个，');
  console.log('   否则两边的改动会打架。\n');
}

main();
