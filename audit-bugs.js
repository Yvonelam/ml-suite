#!/usr/bin/env node
/**
 * 针对性 bug 模式扫描（一次性分析工具）
 * 用法：node audit-bugs.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const TARGETS = [
  ['server.js', 'server'],
  ['public/app.js', 'app'],
  ['auth.js', 'auth'],
  ['push-format.js', 'push'],
  ['daily-report.js', 'report'],
  ['report-schedule.js', 'sched'],
  ['question-auto-reply.js', 'qauto'],
];
const src = {};
for (const [f] of TARGETS) src[f] = fs.readFileSync(path.join(__dirname, f), 'utf8');

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

function scan(label, pattern, opts = {}) {
  const hits = [];
  for (const [f, tag] of TARGETS) {
    const lines = strip(src[f]).split('\n');
    lines.forEach((line, i) => {
      if (opts.skip && opts.skip.test(line)) return;
      const m = line.match(pattern);
      if (m) hits.push({ f, tag, line: i + 1, text: line.trim() });
    });
  }
  console.log('\n=== ' + label + ' （' + hits.length + '） ===');
  // 同一文件里过多的只列前 25 条
  const byFile = {};
  for (const h of hits) (byFile[h.f] = byFile[h.f] || []).push(h);
  for (const f of Object.keys(byFile)) {
    const arr = byFile[f];
    arr.slice(0, 25).forEach(h => console.log('  ' + f + ':' + h.line + '  ' + h.text.slice(0, 150)));
    if (arr.length > 25) console.log('  …' + f + ' 还有 ' + (arr.length - 25) + ' 处');
  }
  return hits;
}

// 1) 松散相等（排除 == null / != null，那是刻意的）
scan('松散 == / !=（排除 == null）', /[^=!]==[^=]|[^!]=![^=]/,
  { skip: /==\s*null|!=\s*null|===|!==/ });

// 2) JSON.parse 没有 try 包裹（同一行内看不到 try）
scan('JSON.parse 调用点（人工确认是否被 try 包住）', /JSON\.parse\(/,
  { skip: /^\s*\/\// });

// 3) parseInt 缺 radix
scan('parseInt 缺少基数 10', /parseInt\((?![^)]*,\s*10\s*\))/,
  { skip: /parseInt\([^)]*,\s*10/ });

// 4) .find(...) 直接跟属性访问（找到会返回 undefined，链式就炸）
scan('.find(...) 后直接取属性（可能 TypeError）', /\.find\([^)]*\)\.[A-Za-z_]/);

// 5) innerHTML 拼接（XSS / 转义遗漏温床）
const inner = scan('innerHTML 赋值（检查是否都过 escHtml）', /\.innerHTML\s*=/);
const innerUnsafe = inner.filter(h => !/escHtml|textContent|=\s*''|=\s*""|render|esc\(/.test(h.text));
console.log('  ↑ 其中未见 escHtml 的：');
innerUnsafe.slice(0, 40).forEach(h => console.log('    ' + h.f + ':' + h.line + '  ' + h.text.slice(0, 130)));

// 6) 浮点累加（金额）
scan('金额累加（+= 且变量名像 sum/amount/total/profit）', /\b(sum|amount|total|profit|revenue|fee)\w*\s*\+=/i);

// 7) 数组下标 / 长度直接比较
scan('length 与 == 比较', /\.length\s*==\s*[^=]/);

// 8) 未处理的 async 调用（顶层 xxx( ) 后没 await/.catch/then）
(function () {
  const hits = [];
  for (const [f] of TARGETS) {
    const lines = strip(src[f]).split('\n');
    lines.forEach((line, i) => {
      // 形如 `  someAsyncFn();` 单独一行且函数名以常见异步前缀开头
      const m = line.match(/^\s*(?:await\s+)?(load|refresh|start|check|run|send|fetch|sync|save|update|apply|do)[A-Z]\w*\s*\([^)]*\)\s*;\s*$/);
      if (!m) return;
      if (/^\s*await\s/.test(line)) return;
      // 后面若有 .catch 说明处理了（在同一行）
      hits.push({ f, line: i + 1, text: line.trim() });
    });
  }
  console.log('\n=== 疑似「调了异步函数但没 await/catch」（' + hits.length + '） ===');
  hits.slice(0, 30).forEach(h => console.log('  ' + h.f + ':' + h.line + '  ' + h.text.slice(0, 130)));
})();

// 9) 重复的函数定义
console.log('\n=== 重复定义 ===');
for (const [f] of TARGETS) {
  const defs = new Map();
  strip(src[f]).split('\n').forEach((l, i) => {
    const m = l.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (m) { (defs.get(m[1]) || defs.set(m[1], []).get(m[1])).push(i + 1); }
  });
  const dups = [...defs].filter(([, v]) => v.length > 1);
  if (dups.length) dups.forEach(([k, v]) => console.log('  ' + f + ': ' + k + ' → 行 ' + v.join(', ')));
}
