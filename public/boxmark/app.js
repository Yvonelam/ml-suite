/* =========================================================
   箱唛切割器 · Box Mark Cutter
   纯前端实现：pdf.js 渲染分析 + pdf-lib 无损裁切导出
   ========================================================= */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const { PDFDocument } = PDFLib;

const MM2PT = 72 / 25.4;   // 毫米 -> PDF 点
const POOL = 2;            // 二值图降采样倍数（内存/速度平衡）

/* ---------------- 状态 ---------------- */
const state = {
  fileName: '',
  srcBytes: null,
  pages: [],          // { pageIndex, num, view, q, maskScale, maskW, maskH, mask, thumb, boxes:[] }
  mode: 'auto',
  gapAuto: true,
  params: {
    gapMm: 3,
    minSizeMm: 8,
    quality: 1.6,
    marginMm: 1.5,
    rows: 2,
    cols: 2
  }
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const dropEl = $('drop');
const fileEl = $('file');
const panelEl = $('panel');
const statsEl = $('stats');
const resultsEl = $('results');
const dockEl = $('dock');
const dockText = $('dock-text');
const progressEl = $('progress');
const progressText = $('progress-text');
const progressFill = $('progress-fill');
const toastEl = $('toast');

/* =========================================================
   1. 基础工具
   ========================================================= */
const nextTick = () => new Promise((r) => setTimeout(r, 0));

function toast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.className = 'toast'; }, 2600);
}

function setProgress(pct, text) {
  if (pct === null) { progressEl.hidden = true; return; }
  progressEl.hidden = false;
  progressFill.style.width = Math.round(pct * 100) + '%';
  if (text) progressText.textContent = text;
}

function debounce(fn, ms) {
  let t;
  return function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
}

/* =========================================================
   2. 图像 -> 二值掩码
   ========================================================= */

// 估算页面背景亮度（取边缘像素的高分位数，避开内容）
function computeThreshold(img) {
  const { width: W, height: H, data } = img;
  const samples = [];
  const stepX = Math.max(1, Math.floor(W / 80));
  const stepY = Math.max(1, Math.floor(H / 80));
  const push = (x, y) => {
    const i = (y * W + x) * 4;
    const a = data[i + 3];
    const lum = a < 24 ? 255 : (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    samples.push(lum);
  };
  for (let x = 0; x < W; x += stepX) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y += stepY) { push(0, y); push(W - 1, y); }
  samples.sort((a, b) => a - b);
  const bg = samples[Math.floor(samples.length * 0.78)] || 255;
  // 白底 -> 245；浅灰底 -> 比背景再暗一点
  const thr = bg > 200 ? bg - 10 : bg - 14;
  return Math.max(50, Math.min(245, thr));
}

// 生成降采样二值掩码（块内取"最大值"，细线不会丢）
function buildMask(img) {
  const { width: W, height: H, data } = img;
  const thr = computeThreshold(img);
  const mw = Math.max(1, Math.ceil(W / POOL));
  const mh = Math.max(1, Math.ceil(H / POOL));
  const mask = new Uint8Array(mw * mh);

  for (let y = 0; y < mh; y++) {
    const y0 = y * POOL;
    for (let x = 0; x < mw; x++) {
      const x0 = x * POOL;
      let on = 0;
      for (let dy = 0; dy < POOL && !on; dy++) {
        const yy = y0 + dy;
        if (yy >= H) break;
        const row = yy * W;
        for (let dx = 0; dx < POOL; dx++) {
          const xx = x0 + dx;
          if (xx >= W) break;
          const i = (row + xx) * 4;
          if (data[i + 3] < 24) continue;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (lum < thr) { on = 1; break; }
        }
      }
      mask[y * mw + x] = on;
    }
  }
  return { mask, maskW: mw, maskH: mh };
}

/* =========================================================
   3. 积分图 + 投影切分（XY-Cut）
   ========================================================= */
function buildIntegral(mask, W, H) {
  const S = new Uint32Array((W + 1) * (H + 1));
  const stride = W + 1;
  for (let y = 0; y < H; y++) {
    let run = 0;
    const mrow = y * W, srow = (y + 1) * stride, prow = y * stride;
    for (let x = 0; x < W; x++) {
      run += mask[mrow + x];
      S[srow + x + 1] = S[prow + x + 1] + run;
    }
  }
  return S;
}

function rectSum(S, W, x0, y0, x1, y1) {
  const a = W + 1;
  return S[y1 * a + x1] - S[y0 * a + x1] - S[y1 * a + x0] + S[y0 * a + x0];
}

// 在该区域内寻找最宽的"空白"带（贴边的不算）
// 空白判定带容差：允许零星抗锯齿噪点，否则 1mm 级的窄缝会被判成"有内容"而切不开
function bestGap(S, W, r, dir, minGap) {
  let best = null;

  if (dir === 'y') {
    const len = r.y1 - r.y0;
    if (len < 3) return null;
    const tol = Math.max(1, Math.round((r.x1 - r.x0) * 0.004));
    const rowSum = new Int32Array(len);
    for (let i = 0; i < len; i++) rowSum[i] = rectSum(S, W, r.x0, r.y0 + i, r.x1, r.y0 + i + 1);
    let i = 0;
    while (i < len) {
      if (rowSum[i] <= tol) {
        let j = i; while (j < len && rowSum[j] <= tol) j++;
        const gl = j - i;
        if (i > 0 && j < len && gl >= minGap && (!best || gl > best.len)) {
          best = { len: gl, mid: r.y0 + Math.round((i + j) / 2) };
        }
        i = j;
      } else i++;
    }
  } else {
    const len = r.x1 - r.x0;
    if (len < 3) return null;
    const tol = Math.max(1, Math.round((r.y1 - r.y0) * 0.004));
    const colSum = new Int32Array(len);
    for (let i = 0; i < len; i++) colSum[i] = rectSum(S, W, r.x0 + i, r.y0, r.x0 + i + 1, r.y1);
    let i = 0;
    while (i < len) {
      if (colSum[i] <= tol) {
        let j = i; while (j < len && colSum[j] <= tol) j++;
        const gl = j - i;
        if (i > 0 && j < len && gl >= minGap && (!best || gl > best.len)) {
          best = { len: gl, mid: r.x0 + Math.round((i + j) / 2) };
        }
        i = j;
      } else i++;
    }
  }
  return best;
}

// 递归 XY 切分，返回内容块列表
function xyCut(S, W, H, minGap) {
  const out = [];
  const stack = [{ x0: 0, y0: 0, x1: W, y1: H, depth: 0 }];
  while (stack.length) {
    const r = stack.pop();
    if (r.x1 - r.x0 < 3 || r.y1 - r.y0 < 3 || r.depth > 22) { out.push(r); continue; }

    const cy = bestGap(S, W, r, 'y', minGap);
    const cx = bestGap(S, W, r, 'x', minGap);

    let cut = null;
    if (cy && cx) cut = cy.len >= cx.len ? { dir: 'y', mid: cy.mid } : { dir: 'x', mid: cx.mid };
    else if (cy) cut = { dir: 'y', mid: cy.mid };
    else if (cx) cut = { dir: 'x', mid: cx.mid };

    if (!cut) { out.push(r); continue; }

    if (cut.dir === 'y') {
      stack.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: cut.mid, depth: r.depth + 1 });
      stack.push({ x0: r.x0, y0: cut.mid, x1: r.x1, y1: r.y1, depth: r.depth + 1 });
    } else {
      stack.push({ x0: r.x0, y0: r.y0, x1: cut.mid, y1: r.y1, depth: r.depth + 1 });
      stack.push({ x0: cut.mid, y0: r.y0, x1: r.x1, y1: r.y1, depth: r.depth + 1 });
    }
  }
  return out;
}

// 收缩到实际内容边界
function tighten(S, W, b) {
  let x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1;
  while (y0 < y1 - 1 && rectSum(S, W, x0, y0, x1, y0 + 1) === 0) y0++;
  while (y1 > y0 + 1 && rectSum(S, W, x0, y1 - 1, x1, y1) === 0) y1--;
  while (x0 < x1 - 1 && rectSum(S, W, x0, y0, x0 + 1, y1) === 0) x0++;
  while (x1 > x0 + 1 && rectSum(S, W, x1 - 1, y0, x1, y1) === 0) x1--;
  return { x0, y0, x1, y1 };
}

/* =========================================================
   4. 单页切分逻辑
   ========================================================= */
function splitPage(page, gapMm, minSizeMm) {
  const { mask, maskW: W, maskH: H, maskScale } = page;
  const S = buildIntegral(mask, W, H);
  const pxPerMm = (maskScale * 25.4) / 72;
  const minGap = Math.max(2, Math.round(gapMm * pxPerMm));
  const minPx = Math.max(3, Math.round(minSizeMm * pxPerMm));

  if (state.mode === 'trim') {
    return [tighten(S, W, { x0: 0, y0: 0, x1: W, y1: H })];
  }

  if (state.mode === 'grid') {
    const t = tighten(S, W, { x0: 0, y0: 0, x1: W, y1: H });
    const rows = state.params.rows, cols = state.params.cols;
    const cw = (t.x1 - t.x0) / cols, ch = (t.y1 - t.y0) / rows;
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = {
          x0: Math.round(t.x0 + c * cw),
          y0: Math.round(t.y0 + r * ch),
          x1: Math.round(t.x0 + (c + 1) * cw),
          y1: Math.round(t.y0 + (r + 1) * ch)
        };
        const tt = tighten(S, W, cell);
        if (tt.x1 - tt.x0 > 2 && tt.y1 - tt.y0 > 2) out.push(tt);
      }
    }
    return out;
  }

  // auto
  const blocks = xyCut(S, W, H, minGap)
    .map((b) => tighten(S, W, b))
    .filter((b) => (b.x1 - b.x0) >= minPx && (b.y1 - b.y0) >= minPx);
  return orderBlocks(blocks);
}

// 阅读顺序：先上后下，再左到右
function orderBlocks(blocks) {
  if (!blocks.length) return blocks;
  const items = blocks.map((b) => ({ b, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, h: b.y1 - b.y0 }));
  const tol = Math.max(4, items.reduce((s, i) => s + i.h, 0) / items.length * 0.55);
  items.sort((p, q) => p.cy - q.cy);
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.cy - last.cy) <= tol) { last.items.push(it); last.cy = (last.cy * (last.items.length - 1) + it.cy) / last.items.length; }
    else rows.push({ cy: it.cy, items: [it] });
  }
  const out = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.b.x0 - b.b.x0);
    for (const it of row.items) out.push(it.b);
  }
  return out;
}

// mask 像素坐标 -> PDF 点坐标
function maskRectToPdf(page, b) {
  const s = page.maskScale;
  const [x0, y0] = page.view.convertToPdfPoint(b.x0 * s, b.y0 * s);
  const [x1, y1] = page.view.convertToPdfPoint(b.x1 * s, b.y1 * s);
  return {
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), manual: false
  };
}

function pdfRectToMask(page, r) {
  const s = page.maskScale;
  const [ax, ay] = page.view.convertToViewportPoint(r.x, r.y);
  const [bx, by] = page.view.convertToViewportPoint(r.x + r.w, r.y + r.h);
  return {
    x0: Math.min(ax, bx) / s, y0: Math.min(ay, by) / s,
    x1: Math.max(ax, bx) / s, y1: Math.max(ay, by) / s
  };
}

/* =========================================================
   5. 自动推荐间距（稳定平台法）
   ========================================================= */
function autoDetectGapMm() {
  const cands = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 15, 20];
  const sample = state.pages.slice(0, Math.min(state.pages.length, 4));
  if (!sample.length) return null;

  const savedMode = state.mode;
  state.mode = 'auto';

  const rows = cands.map((g) => {
    let total = 0; let cvAcc = 0;
    for (const p of sample) {
      const blocks = splitPage(p, g, state.params.minSizeMm);
      total += blocks.length;
      if (blocks.length > 1) {
        const areas = blocks.map((b) => (b.x1 - b.x0) * (b.y1 - b.y0));
        const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
        const sd = Math.sqrt(areas.reduce((a, b) => a + (b - mean) ** 2, 0) / areas.length);
        cvAcc += mean > 0 ? sd / mean : 1;
      } else cvAcc += 2;
    }
    return { g, n: total, cv: cvAcc / sample.length };
  });

  state.mode = savedMode;

  // 找 count 保持不变的最长连续区间（n >= 2）
  let best = null;
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].n === rows[i].n) j++;
    const len = j - i + 1;
    const n = rows[i].n;
    if (n >= 2) {
      const cv = Math.min(...rows.slice(i, j + 1).map((r) => r.cv));
      const score = len / (1 + cv);
      if (!best || score > best.score) best = { score, from: i, to: j, n };
    }
    i = j + 1;
  }
  if (!best) return null;
  return cands[Math.floor((best.from + best.to) / 2)];
}

/* =========================================================
   6. 全量分析
   ========================================================= */
async function analyzePdf() {
  if (!state.srcBytes) return;
  progressEl.hidden = false;
  setProgress(0.02, '正在解析 PDF…');
  await nextTick();

  let pdf;
  try {
    // 传副本：pdf.js 会把 buffer 移交给 worker，避免影响原始数据
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(state.srcBytes) }).promise;
  } catch (e) {
    setProgress(null);
    toast('PDF 解析失败：' + (e && e.message ? e.message : e), 'err');
    return;
  }

  const q = state.params.quality;
  const pages = [];
  const total = pdf.numPages;

  for (let n = 1; n <= total; n++) {
    setProgress(n / total * 0.92, `分析第 ${n} / ${total} 页…`);
    await nextTick();

    let page = null, view = null;
    try {
      page = await pdf.getPage(n);
      view = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: q });

      const big = document.createElement('canvas');
      big.width = Math.max(1, Math.round(vp.width));
      big.height = Math.max(1, Math.round(vp.height));
      const ctx = big.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, big.width, big.height);

      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const { mask, maskW, maskH } = buildMask(ctx.getImageData(0, 0, big.width, big.height));

      // 缩略图（内存友好）
      const TW = 420;
      const sc = Math.min(1, TW / big.width);
      const thumb = document.createElement('canvas');
      thumb.width = Math.max(1, Math.round(big.width * sc));
      thumb.height = Math.max(1, Math.round(big.height * sc));
      const tctx = thumb.getContext('2d');
      tctx.fillStyle = '#ffffff';
      tctx.fillRect(0, 0, thumb.width, thumb.height);
      tctx.drawImage(big, 0, 0, thumb.width, thumb.height);
      big.width = big.height = 0;

      pages.push({
        pageIndex: n - 1, num: n, view, q,
        maskScale: POOL / q, maskW, maskH, mask, thumb, boxes: []
      });
    } catch (e) {
      console.warn('页面渲染失败', n, e);
      pages.push({
        pageIndex: n - 1, num: n, view: view || { width: 595, height: 842, convertToPdfPoint: (a, b) => [a, b], convertToViewportPoint: (a, b) => [a, b] },
        q, maskScale: POOL / q, maskW: 1, maskH: 1, mask: new Uint8Array(1), thumb: null, boxes: [], failed: true
      });
    } finally {
      if (page) page.cleanup();
    }
  }

  try { await pdf.destroy(); } catch (e) { /* ignore */ }

  state.pages = pages;

  // 自动推荐间距
  if (state.mode === 'auto' && state.gapAuto) {
    setProgress(0.96, '正在自动匹配最佳间距…');
    await nextTick();
    const g = autoDetectGapMm();
    if (g != null) {
      state.params.gapMm = g;
      const gi = $('p-gap');
      gi.value = clampRange(gi, g);
      $('v-gap').textContent = Number(gi.value).toFixed(1) + ' mm';
    }
  }

  recomputeAll();
  renderResults();
  setProgress(null);
}

function clampRange(input, v) {
  const min = Number(input.min), max = Number(input.max);
  const snapped = Math.round(v / Number(input.step || 1)) * Number(input.step || 1);
  return Math.min(max, Math.max(min, snapped));
}

// 用已有 mask 重新切分（快）
function recomputeAll() {
  for (const page of state.pages) {
    if (page.failed) { page.boxes = []; continue; }
    try {
      const blocks = splitPage(page, state.params.gapMm, state.params.minSizeMm);
      page.boxes = blocks.map((b) => maskRectToPdf(page, b));
    } catch (e) {
      console.warn('切分失败', page.num, e);
      page.boxes = [];
    }
  }
  updateStats();
}

function allBoxes() {
  const out = [];
  for (const p of state.pages) for (const b of p.boxes) out.push({ page: p.pageIndex, ...b });
  return out;
}

function updateStats() {
  const boxes = allBoxes();
  const pagesWith = state.pages.filter((p) => p.boxes.length > 0).length;
  dockText.innerHTML = `共 <b>${state.pages.length}</b> 页 · 识别到 <b>${boxes.length}</b> 个箱唛 · 涉及 <b>${pagesWith}</b> 页`;
  $('btn-export').disabled = boxes.length === 0;
}

/* =========================================================
   7. 结果渲染
   ========================================================= */
function pdfRectToPct(page, r) {
  const v = page.view;
  const [ax, ay] = v.convertToViewportPoint(r.x, r.y);
  const [bx, by] = v.convertToViewportPoint(r.x + r.w, r.y + r.h);
  return {
    left: Math.min(ax, bx) / v.width * 100,
    top: Math.min(ay, by) / v.height * 100,
    w: Math.abs(bx - ax) / v.width * 100,
    h: Math.abs(by - ay) / v.height * 100
  };
}

function renderResults() {
  resultsEl.innerHTML = '';
  statsEl.hidden = false;
  dockEl.hidden = false;
  dropEl.hidden = true;
  panelEl.hidden = false;

  // 统计卡
  const boxes = allBoxes();
  const pagesWith = state.pages.filter((p) => p.boxes.length > 0).length;
  let modeLabel = { auto: '自动识别', trim: '每页一个', grid: '手动网格' }[state.mode];
  statsEl.innerHTML =
    `<div class="stat"><div class="k">页数</div><div class="v">${state.pages.length}</div></div>` +
    `<div class="stat"><div class="k">识别箱唛</div><div class="v cyan">${boxes.length}</div></div>` +
    `<div class="stat"><div class="k">含有箱唛的页</div><div class="v violet">${pagesWith}</div></div>` +
    `<div class="stat"><div class="k">当前模式</div><div class="v" style="font-size:16px">${modeLabel}</div></div>`;

  const frag = document.createDocumentFragment();
  state.pages.forEach((page) => frag.appendChild(buildCard(page)));
  resultsEl.appendChild(frag);
}

function buildCard(page) {
  const card = document.createElement('div');
  card.className = 'page-card';

  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `<span>第 <span class="pn">${page.num}</span> 页</span><span class="cnt">${page.boxes.length} 个箱唛</span>`;
  card.appendChild(head);

  const wrap = document.createElement('div');
  wrap.className = 'canvas-wrap';

  if (page.thumb) {
    wrap.appendChild(page.thumb);
  } else {
    const ph = document.createElement('div');
    ph.style.cssText = 'padding:40px;text-align:center;color:#8d9cba;font-size:12px;';
    ph.textContent = '该页渲染失败，已跳过';
    wrap.appendChild(ph);
  }

  const layer = document.createElement('div');
  layer.className = 'box-layer';
  layer.style.cssText = 'position:absolute;inset:0;';
  wrap.appendChild(layer);

  page._layer = layer;
  page._wrap = wrap;

  card.appendChild(wrap);

  if (page.boxes.length) {
    const tools = document.createElement('div');
    tools.className = 'page-tools';
    const btnAll = document.createElement('button');
    btnAll.className = 'btn ghost';
    btnAll.textContent = '按内容重切';
    btnAll.onclick = () => { recomputePage(page); renderBoxes(page); updateStats(); refreshHead(page); };
    const btnNone = document.createElement('button');
    btnNone.className = 'btn ghost';
    btnNone.textContent = '清空本页';
    btnNone.onclick = () => { page.boxes = []; renderBoxes(page); updateStats(); refreshHead(page); };
    tools.appendChild(btnAll);
    tools.appendChild(btnNone);
    card.appendChild(tools);
  }

  renderBoxes(page);
  attachMarquee(wrap, page);
  return card;
}

function refreshHead(page) {
  const card = page._wrap && page._wrap.parentElement;
  if (!card) return;
  const cnt = card.querySelector('.cnt');
  if (cnt) cnt.textContent = page.boxes.length + ' 个箱唛';
  const tools = card.querySelector('.page-tools');
  if (!tools && page.boxes.length) {
    const t = document.createElement('div');
    t.className = 'page-tools';
    const b1 = document.createElement('button');
    b1.className = 'btn ghost'; b1.textContent = '按内容重切';
    b1.onclick = () => { recomputePage(page); renderBoxes(page); updateStats(); refreshHead(page); };
    const b2 = document.createElement('button');
    b2.className = 'btn ghost'; b2.textContent = '清空本页';
    b2.onclick = () => { page.boxes = []; renderBoxes(page); updateStats(); refreshHead(page); };
    t.appendChild(b1); t.appendChild(b2);
    card.appendChild(t);
  }
}

function recomputePage(page) {
  const blocks = splitPage(page, state.params.gapMm, state.params.minSizeMm);
  page.boxes = blocks.map((b) => maskRectToPdf(page, b));
}

function renderBoxes(page) {
  const layer = page._layer;
  if (!layer) return;
  layer.innerHTML = '';
  page.boxes.forEach((b, i) => {
    const pct = pdfRectToPct(page, b);
    const d = document.createElement('div');
    d.className = 'box' + (b.manual ? ' manual' : '');
    d.style.left = pct.left + '%';
    d.style.top = pct.top + '%';
    d.style.width = pct.w + '%';
    d.style.height = pct.h + '%';
    d.innerHTML = `<span class="no">${i + 1}</span>`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除这个箱唛';
    del.onclick = (e) => {
      e.stopPropagation();
      page.boxes.splice(i, 1);
      renderBoxes(page);
      updateStats();
      refreshHead(page);
    };
    d.appendChild(del);
    d.addEventListener('pointerdown', (e) => e.stopPropagation());
    layer.appendChild(d);
  });
}

// 在图上拖拽框选，手动添加一个箱唛
function attachMarquee(wrap, page) {
  if (!page.thumb) return;
  let start = null, rect = null;

  const toPct = (e) => {
    const r = wrap.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100)),
      y: Math.min(100, Math.max(0, (e.clientY - r.top) / r.height * 100))
    };
  };

  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    start = toPct(e);
    rect = document.createElement('div');
    rect.className = 'marquee';
    wrap.appendChild(rect);
    wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!start || !rect) return;
    const p = toPct(e);
    rect.style.left = Math.min(start.x, p.x) + '%';
    rect.style.top = Math.min(start.y, p.y) + '%';
    rect.style.width = Math.abs(p.x - start.x) + '%';
    rect.style.height = Math.abs(p.y - start.y) + '%';
  });

  const finish = (e) => {
    if (!start || !rect) return;
    const p = toPct(e);
    const left = Math.min(start.x, p.x), top = Math.min(start.y, p.y);
    const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
    rect.remove();
    start = null; rect = null;
    if (w < 0.8 || h < 0.8) return;   // 太小视为误触

    const v = page.view;
    const [x0, y0] = v.convertToPdfPoint(left / 100 * v.width, top / 100 * v.height);
    const [x1, y1] = v.convertToPdfPoint((left + w) / 100 * v.width, (top + h) / 100 * v.height);
    page.boxes.push({
      x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), manual: true
    });
    renderBoxes(page);
    updateStats();
    refreshHead(page);
    toast('已手动添加 1 个箱唛', 'ok');
  };

  wrap.addEventListener('pointerup', finish);
  wrap.addEventListener('pointercancel', () => {
    if (rect) rect.remove();
    start = null; rect = null;
  });
}

/* =========================================================
   8. 导出 PDF
   ========================================================= */
async function exportPdf() {
  const items = allBoxes();
  if (!items.length) { toast('没有可导出的箱唛', 'err'); return; }

  setProgress(0.02, '正在生成 PDF…');
  await nextTick();

  try {
    const src = await PDFDocument.load(new Uint8Array(state.srcBytes), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const margin = state.params.marginMm * MM2PT;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (i % 12 === 0) {
        setProgress(i / items.length * 0.9, `正在生成第 ${i + 1} / ${items.length} 个箱唛…`);
        await nextTick();
      }

      const srcPage = src.getPage(it.page);
      const mb = srcPage.getMediaBox();

      let x = it.x - margin;
      let y = it.y - margin;
      let x2 = it.x + it.w + margin;
      let y2 = it.y + it.h + margin;

      x = Math.max(mb.x, Math.min(x, mb.x + mb.width));
      y = Math.max(mb.y, Math.min(y, mb.y + mb.height));
      x2 = Math.max(mb.x, Math.min(x2, mb.x + mb.width));
      y2 = Math.max(mb.y, Math.min(y2, mb.y + mb.height));

      const w = x2 - x, h = y2 - y;
      if (w < 1 || h < 1) continue;

      try {
        const [pg] = await out.copyPages(src, [it.page]);
        pg.setMediaBox(x, y, w, h);
        pg.setCropBox(x, y, w, h);
        out.addPage(pg);
      } catch (e) {
        console.warn('复制页面失败', it.page, e);
      }
    }

    if (out.getPageCount() === 0) {
      setProgress(null);
      toast('导出失败：没有可用页面', 'err');
      return;
    }

    out.setProducer('BoxMark Cutter');
    out.setCreator('BoxMark Cutter');

    setProgress(0.95, '正在写入文件…');
    await nextTick();
    const bytes = await out.save();

    const base = state.fileName.replace(/\.pdf$/i, '') || 'boxmarks';
    download(new Blob([bytes], { type: 'application/pdf' }), `${base}_箱唛单页.pdf`);
    setProgress(null);
    toast(`导出成功：${out.getPageCount()} 页`, 'ok');
  } catch (e) {
    setProgress(null);
    console.error(e);
    toast('导出失败：' + (e && e.message ? e.message : e), 'err');
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* =========================================================
   9. 交互绑定
   ========================================================= */
function applyModeUI() {
  const mode = state.mode;
  panelEl.querySelectorAll('[data-show]').forEach((el) => {
    const list = el.getAttribute('data-show').split(' ');
    el.style.display = list.includes(mode) ? '' : 'none';
  });
  document.querySelectorAll('#seg-mode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const hints = {
    auto: '自动分析页面空白，把多个箱唛分割开',
    trim: '每页只保留一个箱唛，自动裁掉四周空白',
    grid: '按固定行列均分页面'
  };
  $('mode-hint').textContent = hints[mode];
}

const debouncedRecompute = debounce(() => {
  recomputeAll();
  state.pages.forEach((p) => { renderBoxes(p); refreshHead(p); });
  // 刷新统计卡
  const boxes = allBoxes();
  const stats = statsEl.querySelectorAll('.stat .v');
  if (stats.length >= 3) {
    stats[1].textContent = boxes.length;
    stats[2].textContent = state.pages.filter((p) => p.boxes.length > 0).length;
  }
}, 140);

function bind() {
  // 选择文件
  dropEl.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', () => {
    if (fileEl.files && fileEl.files[0]) loadFile(fileEl.files[0]);
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.remove('over'); }));
  dropEl.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // 模态切换
  document.querySelectorAll('#seg-mode button').forEach((b) => {
    b.addEventListener('click', () => {
      if (state.mode === b.dataset.mode) return;
      state.mode = b.dataset.mode;
      applyModeUI();
      if (state.pages.length) {
        recomputeAll();
        renderResults();
      }
    });
  });

  // 参数
  const bindRange = (id, key, fmt, onChange) => {
    const input = $(id);
    const label = $('v-' + id.slice(2));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      label.textContent = fmt(v);
      onChange(v);
    });
    label.textContent = fmt(Number(input.value));
  };

  bindRange('p-gap', 'gapMm', (v) => v.toFixed(1) + ' mm', (v) => {
    state.params.gapMm = v;
    state.gapAuto = false;
    if (state.pages.length) debouncedRecompute();
  });
  bindRange('p-min', 'minSizeMm', (v) => v + ' mm', (v) => {
    state.params.minSizeMm = v;
    if (state.pages.length) debouncedRecompute();
  });
  bindRange('p-margin', 'marginMm', (v) => v.toFixed(1) + ' mm', (v) => { state.params.marginMm = v; });
  bindRange('p-rows', 'rows', (v) => String(v), (v) => {
    state.params.rows = v;
    if (state.pages.length && state.mode === 'grid') debouncedRecompute();
  });
  bindRange('p-cols', 'cols', (v) => String(v), (v) => {
    state.params.cols = v;
    if (state.pages.length && state.mode === 'grid') debouncedRecompute();
  });

  $('p-quality').addEventListener('change', () => {
    state.params.quality = Number($('p-quality').value);
    if (state.srcBytes) {
      if (state.pages.length) { state.pages = []; resultsEl.innerHTML = ''; }
      analyzePdf();
    }
  });

  // 按钮
  $('btn-export').addEventListener('click', exportPdf);
  $('btn-reanalyze').addEventListener('click', () => {
    if (state.srcBytes) analyzePdf();
  });
  $('btn-clear').addEventListener('click', () => {
    state.fileName = '';
    state.srcBytes = null;
    state.pages = [];
    resultsEl.innerHTML = '';
    statsEl.hidden = true;
    dockEl.hidden = true;
    panelEl.hidden = true;
    dropEl.hidden = false;
    $('file-chip').hidden = true;
    $('btn-reanalyze').hidden = true;
    fileEl.value = '';
    toast('已清空');
  });

  // 快捷键：Ctrl/Cmd + E 导出
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      if (!dockEl.hidden) { e.preventDefault(); exportPdf(); }
    }
  });
}

async function loadFile(file) {
  const name = file.name || '';
  if (!/\.pdf$/i.test(name) && file.type !== 'application/pdf') {
    toast('请选择 PDF 文件', 'err');
    return;
  }
  state.fileName = name;
  state.gapAuto = true;
  state.params.gapMm = 3;
  const gi = $('p-gap');
  gi.value = 3;
  $('v-gap').textContent = '3.0 mm';

  dropEl.hidden = true;
  panelEl.hidden = false;
  statsEl.hidden = false;
  dockEl.hidden = false;
  resultsEl.innerHTML = '';
  $('file-chip').hidden = false;
  $('file-chip').textContent = name;
  $('btn-reanalyze').hidden = false;

  setProgress(0.01, '正在读取文件…');
  await nextTick();
  state.srcBytes = new Uint8Array(await file.arrayBuffer());
  applyModeUI();
  await analyzePdf();
}

/* ---------------- 启动 ---------------- */
bind();
applyModeUI();
