// 清理探针/截图脚本留在系统临时目录里的 headless Chrome 配置目录（我的产物，非用户文件）
// 只删：名字命中白名单前缀 **且** 目录内确实有 Chrome profile 特征（Default / Local State）的目录
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PREFIXES = [
  'ml-multi-', 'ml-smoke-', 'ml-quant-', 'ml-hubfx-', 'ml-buyer-', 'ml-ps-', 'ml-tz-', 'ml-cut-',
  'ml-box-', 'ml-boxshot-', 'ml-qauto-', 'ml-qref-', 'ml-pwd-', 'ml-cur-', 'ml-pp-', 'ml-rep-',
  'ml-sel-', 'ml-logo-', 'ml-shot-', 'ml-shots-', 'ml-perf-', 'ml-cost-', 'ml-probe-split-',
  'ml-probe-hc-', 'ml-e2e-', 'ml-e2e2-', 'ml-e2e3-', 'ml-e2e-ads-',
  'cdp-adsh-', 'cdp-dm-', 'cdp-ign-', 'cdp-ml-', 'cdp-ico-', 'cdp-shot-',
];
const TMP = os.tmpdir();
const DRY = process.argv.includes('--dry');
const MAX_AGE_H = Number(process.env.KEEP_H || 0);   // 0 = 全清

function dirSize(dir) {
  let s = 0;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    try {
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) s += dirSize(p);
      else s += fs.statSync(p).size;
    } catch { }
  }
  return s;
}

let total = 0, count = 0, kept = 0;
const now = Date.now();
for (const name of fs.readdirSync(TMP)) {
  const p = path.join(TMP, name);
  let st;
  try { st = fs.statSync(p); } catch { continue; }
  if (!st.isDirectory()) continue;
  if (!PREFIXES.some(pre => name.startsWith(pre))) continue;
  const looksLikeChrome = fs.existsSync(path.join(p, 'Local State')) || fs.existsSync(path.join(p, 'Default'));
  if (!looksLikeChrome) continue;
  if (MAX_AGE_H && now - st.mtimeMs < MAX_AGE_H * 3600e3) { kept++; continue; }
  const sz = dirSize(p);
  total += sz;
  count++;
  if (!DRY) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { console.log('  删除失败 ' + name + '：' + e.message); } }
}
console.log((DRY ? '[试运行] ' : '') + '清理 ' + count + ' 个 headless Chrome 临时目录 · 回收 ' + (total / 1024 / 1024 / 1024).toFixed(2) + ' GB' + (kept ? ' · 保留 ' + kept + ' 个（' + MAX_AGE_H + ' 小时内）' : ''));
