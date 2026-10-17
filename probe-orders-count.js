#!/usr/bin/env node
/**
 * 订单抓取诊断：10 月每天到底多少单、当前接口拿回多少、差在哪个环节。
 * 只读，不改任何数据。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ProxyAgent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY || 'http://127.0.0.1:7897'));

const API = 'https://api.mercadolibre.com';
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'configs', 'admin.json'), 'utf8'));
const H = { Accept: 'application/json', Authorization: 'Bearer ' + cfg.mlAccessToken };
const PORT = Number(process.env.PORT || 3000);
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

async function api(p) {
  const r = await fetch(API + p, { headers: H, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = null; }
  return { status: r.status, data: d };
}

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

const q = (from, to) => `order.date_created.from=${from}T00:00:00.000-03:00&order.date_created.to=${to}T23:59:59.999-03:00`;

(async () => {
  const me = await api('/users/me');
  const uid = me.data.id;
  console.log('卖家 ' + uid + '（' + me.data.site_id + '）\n');

  // ---- 1. 10 月 1 日到今天的总量（用 paging.total 拿真数，不翻页） ----
  const fromAll = '2026-10-01', toAll = '2026-10-17';
  const t1 = await api(`/orders/search?seller=${uid}&${q(fromAll, toAll)}&limit=1`);
  const grandTotal = Number(t1.data?.paging?.total || 0);
  console.log('[1] ' + fromAll + ' ~ ' + toAll + ' 全区间 paging.total = ' + grandTotal + ' 单\n');

  // ---- 2. 逐天拿真数 ----
  console.log('[2] 逐天明细（paging.total，含取消单）');
  const days = [];
  for (let d = fromAll; d <= toAll; d = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) {
    const r = await api(`/orders/search?seller=${uid}&${q(d, d)}&limit=1`);
    const n = Number(r.data?.paging?.total || 0);
    days.push({ d, n });
    process.stdout.write('    ' + d + '  ' + String(n).padStart(4) + ' 单\n');
  }
  const sumDays = days.reduce((a, b) => a + b.n, 0);
  console.log('    合计 ' + sumDays + ' 单（对得上全区间 ' + grandTotal + '）' + (sumDays === grandTotal ? ' ✓' : ' ✗ 有跨日边界问题'));
  const maxDay = days.reduce((a, b) => (b.n > a.n ? b : a), { d: '-', n: 0 });
  console.log('    单日峰值 ' + maxDay.n + '（' + maxDay.d + '）→ 按天切分永远碰不到 1000 条的 offset 上限\n');

  // ---- 3. 当前接口返回多少 ----
  console.log('[3] 当前 /api/ml/profit/orders 实际返回');
  const login = await req('POST', '/api/auth/login', { username: dev.username, password: dev.password });
  const cookie = login.cookie.split(';')[0];
  const t0 = Date.now();
  const r = await req('GET', `/api/ml/profit/orders?from=${fromAll}&to=${toAll}&refresh=1`, null, cookie);
  const ms = Date.now() - t0;
  const d = JSON.parse(r.body);
  console.log('    HTTP ' + r.status + ' · ' + (ms / 1000).toFixed(1) + ' 秒');
  console.log('    返回行数 ' + (d.orders || []).length + ' · totals.orders（去重订单数）' + (d.totals?.orders) + ' · apiTotal ' + d.apiTotal + ' · truncated ' + d.truncated);
  console.log('    → 缺口：' + (sumDays - (d.totals?.orders || 0)) + ' 单\n');

  // ---- 4. 取消单占比 ----
  console.log('[4] 取消/无效单占比（口径说明用）');
  let all = [], off = 0;
  while (off < 1000) {
    const p = await api(`/orders/search?seller=${uid}&${q(fromAll, toAll)}&sort=date_asc&limit=50&offset=${off}`);
    const rows = p.data?.results || [];
    all.push(...rows); off += 50;
    if (!rows.length || off >= Number(p.data?.paging?.total || 0)) break;
  }
  const stat = {};
  for (const o of all) stat[o.status] = (stat[o.status] || 0) + 1;
  console.log('    实际抓到 ' + all.length + ' 单，状态分布：' + JSON.stringify(stat));
  const valid = all.filter((o) => !['cancelled', 'invalid'].includes(String(o.status || ''))).length;
  console.log('    有效（剔除 cancelled/invalid）' + valid + ' 单');
  console.log('\n完成。');
})().catch((e) => console.error('ERR', e));
