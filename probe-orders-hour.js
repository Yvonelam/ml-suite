'use strict';
/* 拉最近订单，dump 字段，看是否有广告归因/时间戳字段 */
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const cfg = require('./daily-search-config.json');
const PROXY = cfg.proxy || '';
if (PROXY) setGlobalDispatcher(new ProxyAgent(PROXY));
const BASE = 'https://api.mercadolibre.com';

async function token() {
  if (cfg.mlAccessToken && cfg.mlTokenExpireAt && Date.now() < cfg.mlTokenExpireAt - 120000) return cfg.mlAccessToken;
  const r = await fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.mlAppId, client_secret: cfg.mlSecret, refresh_token: cfg.mlRefreshToken }) });
  const d = await r.json(); if (!d.access_token) throw new Error(JSON.stringify(d).slice(0, 200)); return d.access_token;
}

(async () => {
  const t = await token();
  const H = { Authorization: 'Bearer ' + t, Accept: 'application/json' };
  const u = await (await fetch(BASE + '/users/me', { headers: H })).json();
  console.log('seller=', u.id, 'site=', u.site_id);
  const url = `${BASE}/orders/search?seller=${u.id}&sort=date_desc&limit=3`;
  const d = await (await fetch(url, { headers: H })).json();
  const list = (d.results || []);
  console.log('订单数:', list.length, 'total=', d.paging && d.paging.total);
  list.forEach((o, i) => {
    console.log(`\n--- 订单 ${i + 1} ---`);
    console.log('id=', o.id, 'status=', o.status, 'date_created=', o.date_created, 'date_closed=', o.date_closed);
    console.log('tags=', JSON.stringify(o.tags));
    console.log('所有字段=', Object.keys(o).join(', '));
    if (o.order_items && o.order_items[0]) console.log('item0 keys=', Object.keys(o.order_items[0]).join(', '), '| sale_fee=', o.order_items[0].sale_fee);
    if (o.payments && o.payments[0]) console.log('payment0 keys=', Object.keys(o.payments[0]).join(', '));
    if (o.context) console.log('context=', JSON.stringify(o.context).slice(0, 200));
    if (o.mediations) console.log('mediations=', JSON.stringify(o.mediations).slice(0, 120));
  });
  // 顺便看：按小时过滤是否可行（date_created 支持时分秒过滤）
  const probe = `${BASE}/orders/search?seller=${u.id}&order.date_created.from=2026-10-12T09:00:00.000-03:00&order.date_created.to=2026-10-12T09:59:59.999-03:00&limit=1`;
  const p = await (await fetch(probe, { headers: H })).json();
  console.log('\n[小时区间过滤] total=', p.paging && p.paging.total, 'err=', p.error || p.message || '-');
})();
