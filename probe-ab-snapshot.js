#!/usr/bin/env node
/**
 * A/B 快照：把 /api/ml/profit/orders 的确定性字段算成一个指纹，
 * 用来对比「删除 4 个零引用函数」前后接口输出是否完全一致。
 * 用法：node _ab-snapshot.js <输出文件> [from] [to]
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const OUT = process.argv[2] || '/tmp/ab.json';
const FROM = process.argv[3] || '2026-09-01';
const TO = process.argv[4] || '2026-09-30';
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (buf) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = buf.length; }
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => d += c);
      res.on('end', () => resolve({ body: d, cookie: (res.headers['set-cookie'] || [])[0] || '' }));
    });
    r.on('error', reject); if (buf) r.write(buf); r.end();
  });
}

// 只保留确定性字段：去掉时间戳 / 缓存标记 / 实时广告与汇率（那些会随时间漂移，与代码无关）
function scrub(o) {
  const drop = new Set(['updatedAt', 'cached', 'fxPublishedAt', 'fxRate', 'fxCnyPer100', 'at']);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (drop.has(k)) continue;
        if (/^(ad|adCost|adAmount|adUnits|netProfit|adTotal|adRate)/i.test(k)) continue;
        out[k] = walk(v[k]);
      }
      return out;
    }
    return v;
  };
  return walk(o);
}

(async () => {
  const l = await req('POST', '/api/auth/login', { username: dev.username, password: dev.password });
  const ck = l.cookie.split(';')[0];

  const parts = {};
  const r1 = await req('GET', `/api/ml/profit/orders?from=${FROM}&to=${TO}&refresh=1`, null, ck);
  const d1 = JSON.parse(r1.body);
  if (!d1.ok) { console.error('利润接口异常：' + r1.body.slice(0, 200)); process.exit(1); }
  parts.profitOrders = scrub(d1);

  // 顺手把几个纯读接口也纳入指纹（广告/订单/Listing）
  for (const [key, p] of [
    ['hourly', `/api/ml/ads/hourly?from=${FROM}&to=${TO}`],
    ['summary', `/api/ml/orders/summary?from=${FROM}&to=${TO}`],
  ]) {
    try {
      const r = await req('GET', p, null, ck);
      const j = JSON.parse(r.body);
      parts[key] = scrub(j);
    } catch (e) { parts[key] = { error: String(e.message).slice(0, 80) }; }
  }

  const json = JSON.stringify(parts);
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  fs.writeFileSync(OUT, json, 'utf8');
  console.log('已写入 ' + OUT);
  console.log('指纹 ' + hash.slice(0, 32));
  const t = parts.profitOrders.totals || {};
  console.log('区间 ' + FROM + '~' + TO + ' | 全部单 ' + t.allOrders + ' / 件 ' + t.units
    + ' | 有效 ' + t.orders + ' | 可算行 ' + t.matched + '/' + t.validLines
    + ' | 利润 ¥' + t.profitCny + ' | 产品 ' + (parts.profitOrders.products || []).length + ' 个');
})();
