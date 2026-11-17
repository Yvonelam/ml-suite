// 临时：目录占用统计（找 C 盘大户用），跑完可删
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'C:/Users/Administrator/AppData/Local';
const TOP = Number(process.argv[3] || 12);

function size(dir, depth) {
  let total = 0;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    try {
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) total += depth > 0 ? size(p, depth - 1) : dirSize(p);
      else { const st = fs.statSync(p); total += st.size; }
    } catch { }
  }
  return total;
}
function dirSize(dir) { return size(dir, 0); }

const rows = [];
let entries = [];
try { entries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch (e) { console.error('读不到 ' + ROOT); process.exit(1); }
for (const it of entries) {
  if (!it.isDirectory()) continue;
  const p = path.join(ROOT, it.name);
  const s = dirSize(p);
  rows.push([s, it.name]);
}
rows.sort((a, b) => b[0] - a[0]);
for (const [s, n] of rows.slice(0, TOP)) console.log((s / 1024 / 1024 / 1024).toFixed(2).padStart(7) + ' GB  ' + n);
console.log('--- 合计 ' + (rows.reduce((a, b) => a + b[0], 0) / 1024 / 1024 / 1024).toFixed(2) + ' GB · 目录数 ' + rows.length);
