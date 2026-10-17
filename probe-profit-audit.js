#!/usr/bin/env node
/**
 * 利润表逐行对账：确认 totals 与逐行求和是否一致，定位金额口径变化来源。
 * 用法：node probe-profit-audit.js [from] [to]
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const PORT = Number(process.env.PORT || 3000);
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));
const FROM = process.argv[2] || '2026-10-01';
const TO = process.argv[3] || '2026-10-17';

function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (buf) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = buf.length; }
    if (cookie) headers.Cookie = cookie;
    const t0 = Date.now();
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, ms: Date.now() - t0, cookie: [].concat(res.headers['set-cookie'] || [])[0] || '' }));
    });
    r.on('error', reject); if (buf) r.write(buf); r.end();
  });
}

const n2 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;
const fmt = (v) => v === null ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const login = await req('POST', '/api/auth/login', { username: dev.username, password: dev.password });
  const cookie = login.cookie.split(';')[0];

  const url = `/api/ml/profit/orders?from=${FROM}&to=${TO}&refresh=1`;
  const r1 = await req('GET', url, null, cookie);
  const d = JSON.parse(r1.body);
  if (!d.ok) { console.error('接口异常：' + r1.body.slice(0, 400)); process.exit(1); }

  const items = d.orders || [];
  const complete = items.filter((x) => x.profit !== null);
  console.log('区间 ' + d.range.from + ' ~ ' + d.range.to + '   接口耗时 ' + (r1.ms / 1000).toFixed(1) + 's   策略 ' + (d.strategy || '-'));

  // ---- 1. 逐行求和 vs totals ----
  const sum = (k, arr) => arr.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const S = {
    revenue: sum('revenueCny', complete),
    saleFee: sum('saleFeeCny', complete),
    shipping: sum('shippingCny', complete),
    tax: sum('taxCny', complete),
    cost: sum('costCny', complete),
    profit: sum('profitCny', complete),
  };
  const recomputed = S.revenue - S.saleFee - S.shipping - S.tax - S.cost;
  console.log('\n--- 逐行求和（人民币，仅可算行 ' + complete.length + '）---');
  console.log('  订单收入   ¥' + fmt(S.revenue));
  console.log('  销售费     -¥' + fmt(S.saleFee));
  console.log('  尾程运费   -¥' + fmt(S.shipping));
  console.log('  税费       -¥' + fmt(S.tax));
  console.log('  成本与头程 -¥' + fmt(S.cost));
  console.log('  ─────────────────────────');
  console.log('  重算利润   ¥' + fmt(recomputed));
  console.log('  逐行利润和 ¥' + fmt(S.profit));
  console.log('  totals     ¥' + fmt(d.totals.profitCny) + '   毛利率 ' + d.totals.margin + '%');
  console.log('  差         ¥' + fmt(S.profit - d.totals.profitCny) + ' / 重算差 ¥' + fmt(recomputed - S.profit));

  // ---- 2. 巴币侧 ----
  const L = {
    revenue: sum('revenue', complete),
    saleFee: sum('saleFee', complete),
    shipping: sum('shipping', complete),
    tax: sum('tax', complete),
    cost: sum('cost', complete),
    profit: sum('profit', complete),
  };
  console.log('\n--- 逐行求和（巴币 BRL）---');
  console.log('  收入 ¥'.replace('¥', 'R$ ') + fmt(L.revenue) + '   销售费 R$ ' + fmt(L.saleFee) + '   运费 R$ ' + fmt(L.shipping));
  console.log('  税费 R$ ' + fmt(L.tax) + '   成本 R$ ' + fmt(L.cost) + '   利润 R$ ' + fmt(L.profit));
  console.log('  汇率（行内）100 BRL = ' + (complete[0] && complete[0].fxCnyPer100) + ' CNY');

  // ---- 3. 分布体检 ----
  const neg = complete.filter((x) => x.profit < 0);
  const zero = complete.filter((x) => x.profit === 0);
  const shipZero = complete.filter((x) => !(Number(x.shipping) > 0));
  const costZero = complete.filter((x) => !(Number(x.costCny) > 0));
  const feeZero = complete.filter((x) => !(Number(x.saleFee) > 0));
  console.log('\n--- 异常分布 ---');
  console.log('  亏损行        ' + neg.length + ' 行 · 合计 ¥' + fmt(sum('profitCny', neg)));
  console.log('  利润为 0      ' + zero.length + ' 行');
  console.log('  运费为 0/缺   ' + shipZero.length + ' 行');
  console.log('  成本为 0/缺   ' + costZero.length + ' 行');
  console.log('  销售费为 0/缺 ' + feeZero.length + ' 行');

  // 运费为 0 的行，看是不是 shipment 没拿到
  if (shipZero.length) {
    console.log('\n  运费为 0 的样例（前 5 行）：');
    for (const x of shipZero.slice(0, 5)) {
      console.log('    ' + x.orderId + ' ' + x.itemId + ' 收入 R$' + n2(x.revenue) + ' 运费=' + x.shipping + ' 利润=' + n2(x.profit));
    }
  }

  // ---- 4. 最大贡献 / 最大拖累 ----
  const byProfit = complete.slice().sort((a, b) => Number(b.profitCny) - Number(a.profitCny));
  console.log('\n--- 利润 TOP5 ---');
  for (const x of byProfit.slice(0, 5)) console.log('  ¥' + fmt(x.profitCny) + '  收入 R$' + n2(x.revenue) + '  运费 R$' + n2(x.shipping) + '  ' + String(x.title).slice(0, 34));
  console.log('--- 亏损 BOTTOM5 ---');
  for (const x of byProfit.slice(-5)) console.log('  ¥' + fmt(x.profitCny) + '  收入 R$' + n2(x.revenue) + '  运费 R$' + n2(x.shipping) + '  ' + String(x.title).slice(0, 34));

  // ---- 5. 未算出行 ----
  const unmatched = items.filter((x) => x.profit === null);
  console.log('\n--- 未算出的行 ' + unmatched.length + ' ---');
  for (const x of unmatched.slice(0, 10)) console.log('  ' + x.orderId + ' ' + x.itemId + ' 缺：' + (x.missing || []).join('、'));
})();
