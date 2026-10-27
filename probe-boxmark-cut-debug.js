#!/usr/bin/env node
/**
 * 离线复算 splitPage：把 probe-out/boxmask-p*.json 里的掩膜喂给与 app.js 逐字相同的切分代码，
 * 逐层打印 xyCut 的递归过程，定位「2 个箱唛被切成 23 块」是哪一刀切歪的。
 * 用法：node probe-boxmark-cut-debug.js 13 14
 */
'use strict';
const fs = require('fs');
const path = require('path');
const which = process.argv.slice(2).map(Number);
const nums = which.length ? which : [13, 14];

function load(num) {
  const f = path.join(__dirname, 'probe-out', 'boxmask-p' + num + '.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const buf = Buffer.from(j.data, 'base64');
  return { num: j.num, mask: new Uint8Array(buf), W: j.w, H: j.h, maskScale: j.scale, gapMm: j.gap, minSizeMm: j.minSize };
}

// ↓↓↓ 以下与 public/app.js 逐字相同 ↓↓↓
function buildIntegral(mask, W, H) {
  const S = new Uint32Array((W + 1) * (H + 1));
  const stride = W + 1;
  for (let y = 0; y < H; y++) {
    let run = 0;
    const mrow = y * W, srow = (y + 1) * stride, prow = y * stride;
    for (let x = 0; x < W; x++) { run += mask[mrow + x]; S[srow + x + 1] = S[prow + x + 1] + run; }
  }
  return S;
}
function rectSum(S, W, x0, y0, x1, y1) { const a = W + 1; return S[y1 * a + x1] - S[y0 * a + x1] - S[y1 * a + x0] + S[y0 * a + x0]; }
function bestGap(S, W, r, dir, minGap) {
  let best = null;
  if (dir === 'y') {
    const len = r.y1 - r.y0; if (len < 3) return null;
    const tol = Math.max(1, Math.round((r.x1 - r.x0) * 0.004));
    const rowSum = new Int32Array(len);
    for (let i = 0; i < len; i++) rowSum[i] = rectSum(S, W, r.x0, r.y0 + i, r.x1, r.y0 + i + 1);
    let i = 0;
    while (i < len) {
      if (rowSum[i] <= tol) { let j = i; while (j < len && rowSum[j] <= tol) j++; const gl = j - i; if (i > 0 && j < len && gl >= minGap && (!best || gl > best.len)) best = { len: gl, mid: r.y0 + Math.round((i + j) / 2) }; i = j; }
      else i++;
    }
  } else {
    const len = r.x1 - r.x0; if (len < 3) return null;
    const tol = Math.max(1, Math.round((r.y1 - r.y0) * 0.004));
    const colSum = new Int32Array(len);
    for (let i = 0; i < len; i++) colSum[i] = rectSum(S, W, r.x0 + i, r.y0, r.x0 + i + 1, r.y1);
    let i = 0;
    while (i < len) {
      if (colSum[i] <= tol) { let j = i; while (j < len && colSum[j] <= tol) j++; const gl = j - i; if (i > 0 && j < len && gl >= minGap && (!best || gl > best.len)) best = { len: gl, mid: r.x0 + Math.round((i + j) / 2) }; i = j; }
      else i++;
    }
  }
  return best;
}
function xyCut(S, W, H, minGap, log) {
  const out = [], stack = [{ x0: 0, y0: 0, x1: W, y1: H, depth: 0 }];
  while (stack.length) {
    const r = stack.pop();
    if (r.x1 - r.x0 < 3 || r.y1 - r.y0 < 3 || r.depth > 22) { out.push(r); if (log) log('   叶子(过小/太深) ' + JSON.stringify(r)); continue; }
    const cy = bestGap(S, W, r, 'y', minGap), cx = bestGap(S, W, r, 'x', minGap);
    let cut = null;
    if (cy && cx) cut = cy.len >= cx.len ? { dir: 'y', mid: cy.mid } : { dir: 'x', mid: cx.mid };
    else if (cy) cut = { dir: 'y', mid: cy.mid };
    else if (cx) cut = { dir: 'x', mid: cx.mid };
    if (!cut) { out.push(r); if (log) log('   叶子(无缝隙) ' + JSON.stringify(r)); continue; }
    if (log) log('  切 ' + cut.dir + ' mid=' + cut.mid + '  region=' + [r.x0, r.y0, r.x1, r.y1].join(',') + '  cy=' + (cy ? cy.len : '-') + ' cx=' + (cx ? cx.len : '-') + '  depth=' + r.depth);
    if (cut.dir === 'y') { stack.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: cut.mid, depth: r.depth + 1 }); stack.push({ x0: r.x0, y0: cut.mid, x1: r.x1, y1: r.y1, depth: r.depth + 1 }); }
    else { stack.push({ x0: r.x0, y0: r.y0, x1: cut.mid, y1: r.y1, depth: r.depth + 1 }); stack.push({ x0: cut.mid, y0: r.y0, x1: r.x1, y1: r.y1, depth: r.depth + 1 }); }
  }
  return out;
}
function tighten(S, W, b) {
  let x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1;
  while (y0 < y1 - 1 && rectSum(S, W, x0, y0, x1, y0 + 1) === 0) y0++;
  while (y1 > y0 + 1 && rectSum(S, W, x0, y1 - 1, x1, y1) === 0) y1--;
  while (x0 < x1 - 1 && rectSum(S, W, x0, y0, x0 + 1, y1) === 0) x0++;
  while (x1 > x0 + 1 && rectSum(S, W, x1 - 1, y0, x1, y1) === 0) x1--;
  return { x0, y0, x1, y1 };
}

for (const num of nums) {
  const p = load(num);
  const S = buildIntegral(p.mask, p.W, p.H);
  const pxPerMm = (p.maskScale * 25.4) / 72;
  const minGap = Math.max(2, Math.round(p.gapMm * pxPerMm));
  const minPx = Math.max(3, Math.round(p.minSizeMm * pxPerMm));
  console.log('\n===== 第 ' + num + ' 页 =====  掩膜 ' + p.W + 'x' + p.H + ' / minGap=' + minGap + 'px / minPx=' + minPx + 'px (gapMm=' + p.gapMm + ')');
  const raw = xyCut(S, p.W, p.H, minGap, s => console.log(s));
  const tightened = raw.map(b => tighten(S, p.W, b));
  const kept = tightened.filter(b => (b.x1 - b.x0) >= minPx && (b.y1 - b.y0) >= minPx);
  console.log('  xyCut 叶子 ' + raw.length + ' → 过滤后 ' + kept.length);
  kept.forEach(b => console.log('    [' + b.x0 + ',' + b.y0 + ',' + b.x1 + ',' + b.y1 + ']  ' + (b.x1 - b.x0) + 'x' + (b.y1 - b.y0)));
  const drop = tightened.filter(b => !kept.includes(b));
  if (drop.length) console.log('  被丢弃的 ' + drop.length + ' 块：' + drop.map(b => (b.x1 - b.x0) + 'x' + (b.y1 - b.y0)).join(' '));
}
