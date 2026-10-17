#!/usr/bin/env node
/**
 * 按区间验证利润接口的抓取完整性。
 * 用法：node probe-profit-range.js [from] [to]
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const PORT = Number(process.env.PORT || 3000);
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));
const FROM = process.argv[2] || '2026-10-01';
const TO = process.argv[3] || new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

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

(async () => {
  const login = await req('POST', '/api/auth/login', { username: dev.username, password: dev.password });
  const cookie = login.cookie.split(';')[0];

  const url = `/api/ml/profit/orders?from=${FROM}&to=${TO}`;
  const r1 = await req('GET', url + '&refresh=1', null, cookie);
  const d1 = JSON.parse(r1.body);
  if (!d1.ok) { console.error('接口异常：' + r1.body.slice(0, 300)); process.exit(1); }

  console.log('区间 ' + d1.range.from + ' ~ ' + d1.range.to);
  console.log('接口耗时      ' + (r1.ms / 1000).toFixed(1) + ' 秒（冷，含真实拉运费）');
  console.log('抓取策略      ' + (d1.strategy || '-'));
  console.log('平台总单数    ' + d1.apiTotal);
  console.log('实际抓到      ' + d1.pulled + (d1.pulled === d1.apiTotal ? '  ✓ 一单不差' : '  ✗ 差 ' + (d1.apiTotal - d1.pulled) + ' 单'));
  console.log('取消/无效     ' + d1.cancelled);
  console.log('有效订单      ' + d1.totals.orders);
  console.log('商品行数      ' + d1.totals.lines);
  console.log('可算利润行    ' + d1.totals.matched + ' / ' + d1.totals.lines);
  console.log('件数          ' + d1.totals.units);
  console.log('利润合计      ¥' + d1.totals.profitCny + ' · 毛利率 ' + (d1.totals.margin == null ? '—' : d1.totals.margin + '%'));
  console.log('truncated     ' + d1.truncated);

  const miss = {};
  for (const x of d1.orders) for (const m of (x.missing || [])) miss[m] = (miss[m] || 0) + 1;
  console.log('缺失原因分布  ' + (Object.keys(miss).length ? JSON.stringify(miss) : '无'));

  const r2 = await req('GET', url, null, cookie);
  console.log('\n热读取        ' + (r2.ms / 1000).toFixed(2) + ' 秒');
})();
