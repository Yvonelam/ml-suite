#!/usr/bin/env node
/* 只读探针：验证 ①账本已生效 ②小时花费 Σ == 当天总额（守恒）③已冻结的天读账本 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 3000);
const req = (method, p, body, cookie) => new Promise((res, rej) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const h = Object.assign({}, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, cookie ? { Cookie: cookie } : {});
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h },
    s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res({ status: s.statusCode, headers: s.headers, body: d })); });
  r.on('error', rej); if (data) r.write(data); r.end();
});
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

(async () => {
  const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));
  const lr = await req('POST', '/api/auth/login', { username: dev.username, password: dev.password });
  const sc = [].concat(lr.headers['set-cookie'] || []).find(v => v.startsWith('ml_session='));
  if (!sc) { console.error('登录失败', lr.status, lr.body); process.exit(1); }
  const cookie = sc.split(';')[0];

  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);   // 巴西日期 GMT-3

  // ---- 单天 ----
  const h = JSON.parse((await req('GET', `/api/ml/ads/hourly?from=${today}&to=${today}`, null, cookie)).body);
  if (!h.ok) { console.error('hourly 失败:', JSON.stringify(h).slice(0, 300)); process.exit(1); }
  const sumHour = r2(h.hourly.reduce((s, x) => s + (Number(x.cost) || 0), 0));
  const dayCost = r2(h.byDay[0] ? h.byDay[0].adCost : 0);
  console.log('=== 单天（' + today + '）===');
  console.log('账本状态:', JSON.stringify(h.ledger));
  console.log('当天广告总额(byDay.adCost):', dayCost);
  console.log('Σ24小时花费            :', sumHour);
  console.log('差额(应≈0)             :', r2(sumHour - dayCost));
  console.log('已实测小时数           :', h.measuredSlots + '/' + h.totalSlots);
  console.log('每小时花费:', JSON.stringify(h.hourly.map(x => x.cost)));
  console.log('每小时出单:', JSON.stringify(h.hourly.map(x => x.orders)));

  // ---- 近 7 天 ----
  const from7 = addDays(today, -6);
  const h7 = JSON.parse((await req('GET', `/api/ml/ads/hourly?from=${from7}&to=${today}`, null, cookie)).body);
  console.log('\n=== 近 7 天（' + from7 + ' ~ ' + today + '）===');
  console.log('账本状态:', JSON.stringify(h7.ledger));
  console.log('日期        广告总额   是否已冻结  小时花费合计  差额');
  (h7.byDay || []).forEach(d => {
    const s = r2((d.hoursCost || []).reduce((a, b) => a + (Number(b) || 0), 0));
    console.log(`${d.date}  ${String(r2(d.adCost)).padStart(9)}   ${(d.final ? 'final' : 'live ').padEnd(9)}  ${String(s).padStart(11)}  ${String(r2(s - d.adCost)).padStart(7)}`);
  });
  const tot7 = r2((h7.byDay || []).reduce((s, d) => s + (Number(d.adCost) || 0), 0));
  const sum7 = r2((h7.hourly || []).reduce((s, x) => s + (Number(x.cost) || 0), 0));
  console.log('区间总额:', tot7, ' Σ小时:', sum7, ' 差额:', r2(sum7 - tot7));

  // ---- 总览接口的按天趋势 ----
  const a = JSON.parse((await req('GET', `/api/ml/ads?from=${from7}&to=${today}`, null, cookie)).body);
  console.log('\n=== /api/ml/ads 按天趋势 ===');
  (a.daily || []).forEach(d => console.log(d.date, 'cost=' + r2(d.cost), 'amount=' + r2(d.totalAmount), 'units=' + d.units));

  // ---- 每日出单（按天图的数据源）----
  console.log('\n=== 每日出单 / 花费（按天图数据源）===');
  (h7.byDay || []).forEach(d => console.log(d.date, 'orders=' + d.orders, 'adCost=' + r2(d.adCost), 'final=' + d.final));

  // ---- 冻结验证：临时把库里的值改掉，接口必须返回账本值（证明冻结后不再用实时接口重算）----
  console.log('\n=== 冻结验证（临时改库 → 请求 → 改回）===');
  const { DatabaseSync } = require('node:sqlite');
  const dbf = path.join(__dirname, 'auth-data', 'data', 'admin', 'ads-ledger.db');
  const db = new DatabaseSync(dbf);
  const probeDate = addDays(today, -3);
  const row0 = db.prepare('SELECT date,cost,level FROM daily WHERE date=?').get(probeDate);
  if (!row0 || row0.level !== 'final') {
    console.log('跳过：' + probeDate + ' 当前不是 final →', JSON.stringify(row0));
  } else {
    const real = row0.cost, fake = 777.77;
    try {
      db.prepare('UPDATE daily SET cost=? WHERE date=?').run(fake, probeDate);
      const q = JSON.parse((await req('GET', `/api/ml/ads/hourly?from=${probeDate}&to=${probeDate}`, null, cookie)).body);
      const gotDay = q.byDay && q.byDay[0] ? r2(q.byDay[0].adCost) : null;
      const gotTot = q.ads ? r2(q.ads.cost) : null;
      const sumH = r2((q.hourly || []).reduce((s, x) => s + (Number(x.cost) || 0), 0));
      console.log('库里改成 ' + fake + ' →接口返回 byDay=' + gotDay + ' / 区间总额=' + gotTot + ' / Σ小时=' + sumH);
      const okAll = gotDay === fake && gotTot === fake && Math.abs(sumH - fake) < 0.05;
      console.log(okAll ? '  ✅ 通过：冻结的天一律读账本，且小时分摊仍守恒' : '  ❌ 失败：接口没有以账本为准');
    } finally {
      db.prepare('UPDATE daily SET cost=? WHERE date=?').run(real, probeDate);
      console.log('已改回原值 ' + real);
    }
  }
})();
