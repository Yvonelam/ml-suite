#!/usr/bin/env node
/**
 * 离线对照实验：把 app.js 的 splitPage 换成不同版本，跑全部掩膜，看哪种写法
 * 既能让第 14 页切出 2 个箱唛，又不把第 1~13 页（各 3 个）弄坏。
 * 用法：node probe-boxmark-cut-debug.js [页号...]      → 打印某页的递归过程
 *       node probe-boxmark-cut-debug.js --all         → 全部页面跑所有变体
 */
'use strict';
const fs = require('fs');
const path = require('path');
const all = process.argv.includes('--all');
const nums = process.argv.slice(2).filter(s => /^\d+$/.test(s)).map(Number);

const PREFIX = process.env.MASK_PREFIX || '';
function load(num) {
  const f = path.join(__dirname, 'probe-out', 'boxmask-' + PREFIX + 'p' + num + '.json');
  if (!fs.existsSync(f)) return null;
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
function tighten(S, W, b) {
  let x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1;
  while (y0 < y1 - 1 && rectSum(S, W, x0, y0, x1, y0 + 1) === 0) y0++;
  while (y1 > y0 + 1 && rectSum(S, W, x0, y1 - 1, x1, y1) === 0) y1--;
  while (x0 < x1 - 1 && rectSum(S, W, x0, y0, x0 + 1, y1) === 0) x0++;
  while (x1 > x0 + 1 && rectSum(S, W, x1 - 1, y0, x1, y1) === 0) x1--;
  return { x0, y0, x1, y1 };
}

// ---- 变体 A：现状 ----
function xyCutA(S, W, H, minGap, log) {
  const out = [], stack = [{ x0: 0, y0: 0, x1: W, y1: H, depth: 0 }];
  while (stack.length) {
    const r = stack.pop();
    if (r.x1 - r.x0 < 3 || r.y1 - r.y0 < 3 || r.depth > 22) { out.push(r); continue; }
    const cy = bestGap(S, W, r, 'y', minGap), cx = bestGap(S, W, r, 'x', minGap);
    let cut = null;
    if (cy && cx) cut = cy.len >= cx.len ? { dir: 'y', mid: cy.mid } : { dir: 'x', mid: cx.mid };
    else if (cy) cut = { dir: 'y', mid: cy.mid };
    else if (cx) cut = { dir: 'x', mid: cx.mid };
    if (!cut) { out.push(r); continue; }
    if (cut.dir === 'y') { stack.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: cut.mid, depth: r.depth + 1 }); stack.push({ x0: r.x0, y0: cut.mid, x1: r.x1, y1: r.y1, depth: r.depth + 1 }); }
    else { stack.push({ x0: r.x0, y0: r.y0, x1: cut.mid, y1: r.y1, depth: r.depth + 1 }); stack.push({ x0: cut.mid, y0: r.y0, x1: r.x1, y1: r.y1, depth: r.depth + 1 }); }
  }
  return out;
}

// ---- 变体 B：每层先收紧到内容，再找缝（tol 按「真正有内容的宽度」算，不再被大片空白灌水）----
function xyCutB(S, W, H, minGap, log) {
  const out = [], stack = [{ x0: 0, y0: 0, x1: W, y1: H, depth: 0 }];
  while (stack.length) {
    let r = stack.pop();
    if (rectSum(S, W, r.x0, r.y0, r.x1, r.y1) === 0) { if (log) log('   丢弃空白区 ' + JSON.stringify(r)); continue; }
    r = tighten(S, W, r);
    if (r.x1 - r.x0 < 3 || r.y1 - r.y0 < 3 || r.depth > 22) { out.push(r); continue; }
    const cy = bestGap(S, W, r, 'y', minGap), cx = bestGap(S, W, r, 'x', minGap);
    let cut = null;
    if (cy && cx) cut = cy.len >= cx.len ? { dir: 'y', mid: cy.mid } : { dir: 'x', mid: cx.mid };
    else if (cy) cut = { dir: 'y', mid: cy.mid };
    else if (cx) cut = { dir: 'x', mid: cx.mid };
    if (!cut) { out.push(r); if (log) log('   叶子(无缝隙) ' + [r.x0, r.y0, r.x1, r.y1].join(',')); continue; }
    if (log) log('   切 ' + cut.dir + ' mid=' + cut.mid + '  region=' + [r.x0, r.y0, r.x1, r.y1].join(',') + '  cy=' + (cy ? cy.len : '-') + ' cx=' + (cx ? cx.len : '-'));
    if (cut.dir === 'y') { stack.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: cut.mid, depth: r.depth + 1 }); stack.push({ x0: r.x0, y0: cut.mid, x1: r.x1, y1: r.y1, depth: r.depth + 1 }); }
    else { stack.push({ x0: r.x0, y0: r.y0, x1: cut.mid, y1: r.y1, depth: r.depth + 1 }); stack.push({ x0: cut.mid, y0: r.y0, x1: r.x1, y1: r.y1, depth: r.depth + 1 }); }
  }
  return out;
}

function runSplit(p, variant) {
  const S = buildIntegral(p.mask, p.W, p.H);
  const pxPerMm = (p.maskScale * 25.4) / 72;
  const minGap = Math.max(2, Math.round(p.gapMm * pxPerMm));
  const minPx = Math.max(3, Math.round(p.minSizeMm * pxPerMm));
  const fn = variant === 'B' ? xyCutB : xyCutA;
  const log = variant === 'LOG' ? s => console.log(s) : null;
  const raw = (variant === 'LOG' ? xyCutB : fn)(S, p.W, p.H, minGap, log);
  const kept = raw.map(b => tighten(S, p.W, b)).filter(b => (b.x1 - b.x0) >= minPx && (b.y1 - b.y0) >= minPx);
  return { raw: raw.length, kept, minGap, minPx };
}

const re = new RegExp('^boxmask-' + PREFIX + 'p(\\d+)\\.json$');
const files = fs.readdirSync(path.join(__dirname, 'probe-out')).filter(f => re.test(f))
  .map(f => Number(f.match(re)[1])).sort((a, b) => a - b);

if (all) {
  console.log('页  现状        收紧后先找缝      期望');
  let badA = 0, badB = 0;
  for (const num of files) {
    const p = load(num);
    const A = runSplit(p, 'A'), B = runSplit(p, 'B');
    const want = 2 + (num <= 13 ? 1 : 0); // 前 13 页 3 个，第 14 页 2 个
    const okA = A.kept.length === want, okB = B.kept.length === want;
    if (!okA) badA++;
    if (!okB) badB++;
    console.log(String(num).padStart(2) + '  ' + ((A.kept.length + (okA ? ' ✓' : ' ✗')).padEnd(12)) + ' ' + ((B.kept.length + (okB ? ' ✓' : ' ✗')).padEnd(17)) + ' ' + want);
  }
  console.log('\n现状错 ' + badA + ' 页 / 收紧后错 ' + badB + ' 页');
} else {
  for (const num of (nums.length ? nums : files)) {
    const p = load(num);
    if (!p) { console.log('缺第 ' + num + ' 页掩膜'); continue; }
    console.log('\n===== 第 ' + num + ' 页 =====');
    for (const v of ['A', 'B']) {
      const r = runSplit(p, v);
      console.log(' 变体 ' + v + '：' + r.raw + ' 叶子 → ' + r.kept.length + ' 块  ' + r.kept.map(b => (b.x1 - b.x0) + 'x' + (b.y1 - b.y0)).join(' '));
    }
  }
}
