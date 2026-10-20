#!/usr/bin/env node
/**
 * 死代码 / 重名函数审计
 *
 * 做法：扫出 server.js 与 public/app.js 里所有顶层 `function NAME(` 与 `const NAME = (...) =>`，
 * 再去全仓（排除 vendor / node_modules / .git）数每个名字的出现次数。
 *   · 出现次数 = 1  → 只有定义，零引用 = 静态死代码
 *   · 同名定义 > 1  → 重名（后者覆盖前者，容易埋坑）
 *
 * ⚠️ 已知误报：名字里含 `$` 的标识符（如 `$$`、`$x`）会因为正则 `\b` 对 `$` 这种非单词字符
 *    不成立而数成 0 次，误判成死代码。看到 `$` 开头的名字，务必再用字面搜索确认一次：
 *      grep -c '\$\$(' public/app.js
 *    实测 `$$` 有 15 处调用，不是死代码。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TARGETS = ['server.js', 'public/app.js'];
const SKIP_DIR = ['node_modules', '.git', 'vendor', 'auth-data', 'shots'];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|css|json|md)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const allFiles = walk(ROOT, []);
const cache = new Map();
function read(p) {
  if (!cache.has(p)) { try { cache.set(p, fs.readFileSync(p, 'utf8')); } catch (e) { cache.set(p, ''); } }
  return cache.get(p);
}

// 统计「整个仓库里这个名字出现多少次」（按词边界）
function refCount(name) {
  const re = new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b', 'g');
  let n = 0;
  for (const f of allFiles) {
    const c = read(f);
    if (c.indexOf(name) < 0) continue;
    const m = c.match(re);
    if (m) n += m.length;
  }
  return n;
}

function declsOf(file) {
  const src = read(path.join(ROOT, file));
  const lines = src.split('\n');
  const out = [];
  const seen = new Map();
  lines.forEach((ln, i) => {
    let m = ln.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) m = ln.match(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/);
    if (!m) return;
    const name = m[1];
    if (!seen.has(name)) seen.set(name, []);
    seen.get(name).push(i + 1);
    out.push({ name, line: i + 1, file });
  });
  return { out, seen };
}

const results = [];
const dupes = [];
for (const f of TARGETS) {
  const { out, seen } = declsOf(f);
  for (const [name, lns] of seen) if (lns.length > 1) dupes.push({ file: f, name, lines: lns });
  for (const d of out) results.push({ ...d, refs: refCount(d.name) });
}

const dead = results.filter((r) => r.refs <= 1).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const once = results.filter((r) => r.refs === 2);

console.log('扫描文件 ' + allFiles.length + ' 个 · 顶层定义 ' + results.length + ' 个');
console.log('\n=== 零引用（只有定义，出现 1 次）= 静态死代码 ===');
if (!dead.length) console.log('  无');
for (const d of dead) console.log('  ' + d.file + ':' + d.line + '  ' + d.name);

console.log('\n=== 重名定义（同名声明 > 1 次）===');
if (!dupes.length) console.log('  无');
for (const d of dupes) console.log('  ' + d.file + '  ' + d.name + '  出现在第 ' + d.lines.join(' / ') + ' 行');

console.log('\n=== 仅出现 2 次（定义 + 1 次引用）—— 只剩一处调用，改之前要看清 ===');
if (!once.length) console.log('  无');
for (const d of once) console.log('  ' + d.file + ':' + d.line + '  ' + d.name);
