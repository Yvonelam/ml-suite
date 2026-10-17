#!/usr/bin/env node
/** 取利润接口里一行真实数据，把「尾程运费」的每个组成项和换算过程打印出来 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const PORT = Number(process.env.PORT || 3000);
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (buf) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = buf.length; }
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, cookie: [].concat(res.headers['set-cookie'] || [])[0] || '' }));
    });
    r.on('error', reject); if (buf) r.write(buf); r.end();
  });
}
const n = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

(async () => {
  const login = await req('POST', '/api/auth/login', { username: dev.username, password: dev.password });
  const cookie = login.cookie.split(';')[0];
  const r = await req('GET', '/api/ml/profit/orders?from=2026-10-17&to=2026-10-17', null, cookie);
  const d = JSON.parse(r.body);
  const rows = (d.orders || []).filter((x) => x.profit !== null);
  console.log('当日可算利润行数：' + rows.length + ' / ' + (d.orders || []).length + '\n');

  for (const x of rows.slice(0, 3)) {
    const fx = x.fxRate;                    // 1 CNY = fx 本币
    const cnyPer100 = x.fxCnyPer100;        // 100 本币 = cnyPer100 人民币
    console.log('━'.repeat(64));
    console.log('商品：' + x.title.slice(0, 40) + '   数量 ' + x.qty + '   币种 ' + x.currency);
    console.log('汇率：100 ' + x.currency + ' = ' + n(cnyPer100, 4) + ' CNY  →  1 CNY = ' + n(fx, 6) + ' ' + x.currency);
    console.log('');
    console.log('  ① 订单收入（本币）      ' + n(x.revenue) + '   → 人民币 ' + n(x.revenueCny));
    console.log('     ↳ 算法：unit_price × 数量 ÷ ' + n(fx, 6));
    console.log('  ② 销售费（本币）        ' + n(x.saleFee) + '   → 人民币 ' + n(x.saleFeeCny));
    console.log('     ↳ ML 返回的 order_item.sale_fee × 数量，再折人民币');
    console.log('  ③ 运费（本币）          ' + n(x.shipping) + '   → 人民币 ' + n(x.shippingCny));
    console.log('     ↳ shipment 的 senders[卖家].cost，按整单实售价占比摊到本行');
    console.log('  ④ 税额（本币）          ' + n(x.tax) + '   → 人民币 ' + n(x.taxCny) + (x.taxAssumed ? '   ⚠ 平台未代扣，按 0 计' : ''));
    console.log('     ↳ order.taxes.amount，null 视为 0');
    console.log('  ─────────────────────────────────────────────');
    console.log('  ★ 页面「尾程运费」列 = ③ = ' + n(x.shipping) + ' ' + x.currency + ' → 人民币 ' + n(x.shippingCny)
      + (Number(x.tax || 0) ? '（另有税 ' + n(x.tax) + ' ' + x.currency + ' → ' + n(x.taxCny) + '，以「含税」小字显示）' : '（平台未代扣税，④=0 不显示）'));
    console.log('  ─────────────────────────────────────────────');
    console.log('  ⑤ 成本与头程 → 本币     ' + n(x.cost) + '   → 人民币 ' + n(x.costCny));
    console.log('     ↳ (填写成本¥ + 头程¥) × ' + n(fx, 6) + ' × 数量 + 其他扣款×数量');
    console.log('  ⑥ 订单利润（本币）      ' + n(x.profit) + '   → 人民币 ' + n(x.profitCny));
    console.log('     ↳ ① − ② − ③ − ④ − ⑤ = ' + n(x.revenue) + ' − ' + n(x.saleFee) + ' − ' + n(x.shipping) + ' − ' + n(x.tax) + ' − ' + n(x.cost));
    console.log('     ↳ 利润率 ' + n(x.margin) + '%');
  }
  console.log('━'.repeat(64));
})();
