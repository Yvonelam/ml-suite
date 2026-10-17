#!/usr/bin/env node
/**
 * 利润接口端到端验证：登录 → 打 /api/ml/profit/orders → 量耗时 + 校验运费是否不再缺失
 * 跑两次：第一次冷（要真去美客多拉运费），第二次热（应该吃持久缓存秒开）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.PORT || 3000);
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (buf) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = buf.length; }
    if (cookie) headers.Cookie = cookie;
    const t0 = Date.now();
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, ms: Date.now() - t0, cookie: [].concat(res.headers['set-cookie'] || [])[0] || '' }));
    });
    r.on('error', reject);
    if (buf) r.write(buf);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/api/auth/login', { username: dev.username, password: dev.password });
  if (login.status !== 200) { console.error('登录失败', login.status, login.body.slice(0, 200)); process.exit(1); }
  const cookie = login.cookie.split(';')[0];
  console.log('登录成功（' + login.ms + 'ms）\n');

  const q = '/api/ml/profit/orders?from=2026-10-08&to=2026-10-17';
  let pass = 0, fail = 0;
  const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); } };

  // ---- 第一次：强制刷新，走真实拉取 ----
  console.log('[1] 冷启动（refresh，真去美客多拉运费）');
  const r1 = await req('GET', q + '&refresh=1', null, cookie);
  console.log('    HTTP ' + r1.status + ' · 耗时 ' + (r1.ms / 1000).toFixed(1) + ' 秒');
  let d1 = null;
  try { d1 = JSON.parse(r1.body); } catch (e) { }
  if (!d1 || !d1.ok) { console.error('接口返回异常：' + r1.body.slice(0, 400)); process.exit(1); }

  const lines = d1.orders || [];
  const withShip = lines.filter((x) => x.shipping !== null && x.shipping !== undefined);
  const shipMissing = lines.filter((x) => (x.missing || []).includes('运费缺失'));
  const profitOk = lines.filter((x) => x.profit !== null);
  console.log('    行数 ' + lines.length + ' · 有运费 ' + withShip.length + ' · 报「运费缺失」' + shipMissing.length + ' · 可算利润 ' + profitOk.length);
  console.log('    合计：单量 ' + d1.totals.units + ' · 利润 ¥' + d1.totals.profitCny + ' · 毛利率 ' + d1.totals.margin + '%');

  ok(lines.length > 0, '接口返回了订单行', lines.length);
  ok(shipMissing.length === 0, '不再有「运费缺失」', shipMissing.length);
  ok(withShip.length === lines.length, '每一行都拿到了运费', withShip.length + '/' + lines.length);
  ok(withShip.every((x) => typeof x.shipping === 'number' && x.shipping >= 0), '运费都是有效数字');
  ok(lines.every((x) => !x.missing.includes('运费缺失')), 'missing 数组里没有运费缺失');

  if (d1.orders.length) {
    const s = d1.orders.find((x) => x.shipping !== null);
    console.log('    样例：' + (s.title || '').slice(0, 28) + ' · 收入 ' + s.revenue.toFixed(2) + ' ' + s.currency
      + ' · 运费 ' + (s.shipping !== null ? s.shipping.toFixed(2) : '—')
      + ' · 利润 ' + (s.profit !== null ? s.profit.toFixed(2) : '—')
      + ' · 缺失项 [' + s.missing.join('/') + ']');
  }

  // ---- 第二次：热缓存 ----
  console.log('\n[2] 热读取（同一区间，应命中缓存）');
  const r2 = await req('GET', q, null, cookie);
  console.log('    HTTP ' + r2.status + ' · 耗时 ' + (r2.ms / 1000).toFixed(2) + ' 秒');
  ok(r2.status === 200, '第二次仍返回 200', r2.status);
  ok(r2.ms < r1.ms, '第二次比第一次快', { cold: r1.ms, warm: r2.ms });

  const d2 = JSON.parse(r2.body);
  ok((d2.orders || []).length === lines.length, '两次行数一致');
  const ship2 = (d2.orders || []).filter((x) => x.shipping !== null && x.shipping !== undefined);
  ok(ship2.length === withShip.length, '两次运费覆盖数一致', ship2.length + ' vs ' + withShip.length);

  // ---- 第三次：服务重启后的持久缓存（直接查 SQLite 表） ----
  console.log('\n[3] 持久缓存落库检查');
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dirs = fs.readdirSync(path.join(__dirname, 'auth-data', 'data'));
    let rows = 0, path0 = '';
    for (const d of dirs) {
      const p = path.join(__dirname, 'auth-data', 'data', d, 'ads-ledger.db');
      if (!fs.existsSync(p)) continue;
      const db = new DatabaseSync(p);
      try {
        const r = db.prepare('SELECT COUNT(*) AS n FROM ship_cost').get();
        if (Number(r.n) > 0) { rows += Number(r.n); path0 = p; }
      } catch (e) { }
      db.close();
    }
    console.log('    ship_cost 表已存 ' + rows + ' 条' + (path0 ? '（' + path0.replace(__dirname, '.') + '）' : ''));
    ok(rows > 0, '运费已持久化到 SQLite（重启后仍生效）', rows);
  } catch (e) {
    console.log('    跳过（node:sqlite 不可用：' + e.message + '）');
  }

  console.log('\n================ 结果：' + pass + ' 通过 / ' + fail + ' 失败 ================\n');
  process.exit(fail ? 1 : 0);
})();
