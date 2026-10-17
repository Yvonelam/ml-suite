#!/usr/bin/env node
/**
 * 订单/件数口径核对：把「订单数」「件数」「取消单」「多商品单」全部摊开。
 * 用法：node probe-order-units.js [from] [to]
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const PORT = Number(process.env.PORT || 3000);
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));
const FROM = process.argv[2] || '2026-10-01';
const TO = process.argv[3] || '2026-10-18';

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

  // 直接借 debug 接口：这里改用 profit/orders，但取消单会被过滤，所以再单独拉一次原始订单
  const r = await req('GET', `/api/ml/profit/orders?from=${FROM}&to=${TO}&refresh=1`, null, cookie);
  const d = JSON.parse(r.body);
  if (!d.ok) { console.error('接口异常：' + r.body.slice(0, 300)); process.exit(1); }

  console.log(`区间 ${d.range.from} ~ ${d.range.to}`);
  console.log('平台 paging.total      ' + d.apiTotal);
  console.log('实抓（去重后）         ' + d.pulled);
  console.log('取消 / 无效            ' + d.cancelled);
  console.log('有效订单               ' + d.totals.orders);
  console.log('有效件数               ' + d.totals.units);
  console.log('商品行（有效）         ' + d.totals.lines);

  // 按订单聚合已抓到的明细，看多商品 / 多件的情况
  const byOrder = new Map();
  for (const x of d.orders) {
    const k = x.orderId;
    const o = byOrder.get(k) || { items: new Set(), units: 0, lines: 0 };
    o.items.add(x.itemId); o.units += Number(x.qty) || 0; o.lines++;
    byOrder.set(k, o);
  }
  let multiItem = 0, multiQty = 0, units = 0;
  for (const o of byOrder.values()) {
    if (o.items.size > 1) multiItem++;
    if (o.units > o.items.size) multiQty++;
    units += o.units;
  }
  console.log('\n--- 有效订单结构 ---');
  console.log('订单数（聚合后）       ' + byOrder.size);
  console.log('一件多单（qty>1）      ' + multiQty + ' 单');
  console.log('一单多品（不同 Listing）' + multiItem + ' 单');
  console.log('件数（聚合后）         ' + units);

  // 取消单里还有多少件？用原始订单列表接口兜底
  const raw = await req('GET', `/api/ml/orders?from=${FROM}&to=${TO}&limit=1000`, null, cookie);
  try {
    const j = JSON.parse(raw.body);
    const list = j.orders || j.data || [];
    if (list.length) {
      const st = {}; let allUnits = 0, validUnits = 0;
      for (const o of list) {
        const s = String(o.status || '');
        st[s] = (st[s] || 0) + 1;
        const u = (o.order_items || []).reduce((a, it) => a + (Number(it.quantity) || 1), 0);
        allUnits += u;
        if (!['cancelled', 'invalid'].includes(s)) validUnits += u;
      }
      console.log('\n--- /api/ml/orders 原始列表（' + list.length + ' 单）---');
      console.log('状态分布               ' + JSON.stringify(st));
      console.log('全部件数（含取消）     ' + allUnits);
      console.log('有效件数               ' + validUnits);
    } else {
      console.log('\n/api/ml/orders 返回空或结构不同：' + raw.body.slice(0, 200));
    }
  } catch (e) {
    console.log('\n/api/ml/orders 不可用：' + raw.body.slice(0, 200));
  }
})();
