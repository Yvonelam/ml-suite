'use strict';
/*
 * 型号（系列）自动识别
 * ------------------------------------------------------------------
 * 店铺里的 Listing 是「一个颜色 / 一个变体一个链接」，标题里唯一稳定的分类线索
 * 就是型号：Headset Gamer Nubwo® U3… / Fone De Ouvido Binnune Bw06… / Fone Nubwo® Hg04l…
 * 同一型号往往有 2~5 个链接，逐链接看利润看不出「U3 这个系列到底赚多少」。
 *
 * 规则（刻意做得可解释，不做模糊匹配）：
 * 1. 标题切词（非字母数字即分隔符），只保留「字母开头 + 中间含数字」的短词：
 *    U3 / G06 / BW06 / HG04L / N7 / N16 / BG02 / EH01 / HW02 / BW01。
 * 2. 剔掉规格词（PS4 / BT5 / V5 …）：它们会在几十个不相关标题里重复，
 *    按频次选会把完全不同的东西并到一起。「3D」「2.4GHZ」「7.1」「80H」都以数字开头，
 *    天然不满足规则 1，不用额外处理。
 * 3. 一个标题里出现多个候选时，**优先选在最多标题里出现过的那个**（用户说的「有重复字眼」），
 *    平票取标题里更靠前的（型号一般紧跟在品牌后面）。
 * 4. 标题里一个候选都没有时退到 SKU 前缀（BW06BB-ML-BR-A → BW06BB），再没有就归「未识别型号」。
 */

// 规格词黑名单：都是「字母开头 + 含数字」但绝不代表型号
const STOP = new Set([
  'PS3', 'PS4', 'PS5', 'PSP', 'PSVITA',
  'BT3', 'BT4', 'BT5', 'BT50', 'BT51', 'BT52', 'BT53',
  'V3', 'V4', 'V5', 'V6', 'USB2', 'USB3', 'USB30', 'USB31',
  'W10', 'W11', 'IOS', 'IP6', 'IP7', 'IP8', 'IP11', 'IP12', 'IP13', 'IP14', 'IP15',
  'MP3', 'MP4', 'TV4', 'TV5', 'TV6', 'HD2', 'HD4', 'FHD', 'UHD',
  'MHZ', 'GHZ', 'HZ1', 'FPS', 'MS1', 'MM35', 'MM25',
  'XBOX360', 'XBOX1', 'ONE2', 'GEN5', 'GEN4',
]);

// 型号形态：1~4 个字母 + 1~4 位数字 + 0~2 个字母（U3 / G06 / BW06 / HG04L / N7）
const TOKEN_RE = /^[A-Z]{1,4}\d{1,4}[A-Z]{0,2}$/;
// 纯数字开头的一律不是型号（3D / 2.4GHZ / 7.1 / 80H）
const NUM_LEAD_RE = /^\d/;

const UNKNOWN = '未识别型号';

/** 从一个标题里取出候选型号（按出现位置升序，去重） */
function tokensOf(title) {
  const text = String(title || '').toUpperCase();
  const seen = new Set();
  const out = [];
  let at = 0;
  for (const raw of text.split(/[^A-Z0-9]+/)) {
    if (raw) {
      if (TOKEN_RE.test(raw) && !NUM_LEAD_RE.test(raw) && !STOP.has(raw) && !seen.has(raw)) {
        seen.add(raw);
        out.push({ token: raw, at });
      }
      at += raw.length + 1;
    }
  }
  return out;
}

/** SKU 前缀兜底：BW06BB-ML-BR-A → BW06BB；不像型号就返回 '' */
function fromSku(sku) {
  const seg = String(sku || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)[0] || '';
  if (!seg || !TOKEN_RE.test(seg) || NUM_LEAD_RE.test(seg) || STOP.has(seg)) return '';
  return seg;
}

/**
 * 给一批商品分配系列。
 * @param {Array<{title?:string, sku?:string}>} items 顺序与返回值一致
 * @returns {string[]} 每项的系列名（绝不返回空串，无法识别时为 UNKNOWN）
 */
function assignSeries(items) {
  const list = (items || []).map(it => ({ cands: tokensOf(it && it.title), sku: (it && it.sku) || '' }));
  const freq = new Map();
  for (const it of list) for (const c of it.cands) freq.set(c.token, (freq.get(c.token) || 0) + 1);
  return list.map(it => {
    let best = null;
    for (const c of it.cands) {
      const f = freq.get(c.token) || 0;
      // 频次优先 → 同频取更靠前的
      if (!best || f > best.f || (f === best.f && c.at < best.at)) best = { token: c.token, f, at: c.at };
    }
    return (best && best.token) || fromSku(it.sku) || UNKNOWN;
  });
}

module.exports = { assignSeries, tokensOf, fromSku, UNKNOWN, TOKEN_RE, STOP };
