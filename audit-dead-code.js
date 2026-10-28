#!/usr/bin/env node
/**
 * 死代码扫描器（一次性分析工具，不参与运行）
 * 用法：node audit-dead-code.js
 *
 * 检查项：
 *   1) 顶层 function/const/let 定义，统计在「其他地方」被引用的次数
 *   2) public/app.js 的 $ 选择器用到的 id  vs  index.html 里真实存在的 id
 *   3) index.html 里的 id  vs  app.js 是否引用（未被引用的 id 可能是死标记）
 *   4) style.css / theme-*.css 里的类名 vs html+js 里的出现
 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

const files = {
  server: R('server.js'),
  app: R('public/app.js'),
  html: R('public/index.html'),
  css: R('public/style.css'),
};
const themeCss = ['theme-color.css', 'theme-gold.css', 'theme-mist.css', 'theme-motion.css']
  .map(f => ({ f: 'public/' + f, s: R('public/' + f) }));

// ── 1. 顶层声明与引用计数
function topLevelDecls(src) {
  const out = [];
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = re.exec(src))) out.push({ name: m[1] || m[2], kind: m[1] ? 'function' : 'var', idx: m.index });
  return out;
}
function countRefs(src, name) {
  const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
  return (src.match(re) || []).length;
}
function auditDecls(label, src, otherSrcs) {
  console.log('\n=== ' + label + ' 顶层声明 ===');
  const decls = topLevelDecls(src);
  const unused = [], once = [];
  for (const d of decls) {
    const self = countRefs(src, d.name) - 1; // 减掉声明本身
    const other = otherSrcs.reduce((n, s) => n + countRefs(s, d.name), 0);
    if (self + other === 0) unused.push(d.name);
    else if (self + other === 1) once.push(d.name);
  }
  console.log('声明总数: ' + decls.length);
  console.log('完全没被引用 (' + unused.length + '): ' + (unused.join(', ') || '（无）'));
  console.log('只被引用 1 次 (' + once.length + '): ' + (once.join(', ') || '（无）'));
  return { decls, unused, once };
}

const srv = auditDecls('server.js', files.server, [files.app]);
const app = auditDecls('public/app.js', files.app, [files.html]);

// ── 2. app.js 用到的 id
const usedIds = new Set();
for (const m of files.app.matchAll(/\$\('#([\w-]+)'\)/g)) usedIds.add(m[1]);
for (const m of files.app.matchAll(/getElementById\('([\w-]+)'\)/g)) usedIds.add(m[1]);
for (const m of files.app.matchAll(/querySelector(?:All)?\('#([\w-]+)/g)) usedIds.add(m[1]);

// ── 3. html 里声明的 id
const htmlIds = new Set();
for (const m of files.html.matchAll(/\bid="([\w-]+)"/g)) htmlIds.add(m[1]);

const missing = [...usedIds].filter(x => !htmlIds.has(x)).sort();
const unusedIds = [...htmlIds].filter(x => !usedIds.has(x)).sort();

console.log('\n=== id 对账 ===');
console.log('app.js 引用的 id: ' + usedIds.size + ' / index.html 声明的 id: ' + htmlIds.size);
console.log('\n⚠ app.js 用了但 HTML 里没有的 id (' + missing.length + ')' +
  '  ← 这些 $() 会返回 null（可能有 ?. 兜底，但值得逐个看）:');
console.log('  ' + (missing.join(', ') || '（无）'));
console.log('\nHTML 里有但 app.js 没引用的 id (' + unusedIds.length + ')' +
  '  ← 可能是纯 CSS 锚点，也可能是死标记:');
console.log('  ' + (unusedIds.join(', ') || '（无）'));

// ── 4. CSS 类名对账
function cssClasses(src) {
  const set = new Set();
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComment.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) set.add(m[1]);
  return set;
}
const allCss = files.css + themeCss.map(x => x.s).join('\n');
const cssSet = cssClasses(allCss);
const jsHtml = files.html + '\n' + files.app;
const deadCss = [...cssSet].filter(c => {
  // 类名可能被字符串拼接造出来，用宽松匹配：整词出现即可
  const re = new RegExp('(?<![\\w-])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
  return !re.test(jsHtml);
}).sort();

console.log('\n=== CSS 类名对账 ===');
console.log('CSS 里定义的类: ' + cssSet.size);
console.log('HTML/JS 里一次都没出现的类 (' + deadCss.length + ')' +
  '  ← 注意：可能由拼字符串生成，需人工确认:');
console.log('  ' + (deadCss.join(', ') || '（无）'));

// ── 5. 空 catch / 吞异常
console.log('\n=== 吞异常点 ===');
for (const [label, src] of [['server.js', files.server], ['public/app.js', files.app]]) {
  const hits = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) hits.push((i + 1) + ': ' + line.trim());
    else if (/\.catch\(\s*(?:\(\s*\)|\(\w+\)|function\s*\(\s*\))?\s*=>\s*\{?\s*\}?\s*\)/.test(line)) hits.push((i + 1) + ': ' + line.trim());
  });
  console.log(label + ' (' + hits.length + ')');
  hits.slice(0, 60).forEach(h => console.log('  ' + h));
  if (hits.length > 60) console.log('  …还有 ' + (hits.length - 60) + ' 处');
}
