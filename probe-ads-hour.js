'use strict';
/* 探测 Mercado Ads product_ads campaigns/search 支持哪些聚合粒度（能否按小时） */
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const cfg = require('./daily-search-config.json');

const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || cfg.proxy || '';
if (PROXY) setGlobalDispatcher(new ProxyAgent(PROXY));
console.log('proxy =', PROXY || '(direct)');

const BASE = 'https://api.mercadolibre.com';

async function token() {
  const c = require('./daily-search-config.json');
  if (c.mlAccessToken && c.mlTokenExpireAt && Date.now() < c.mlTokenExpireAt - 120000) return c.mlAccessToken;
  const r = await fetch(BASE + '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: c.mlAppId, client_secret: c.mlSecret, refresh_token: c.mlRefreshToken }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('refresh failed: ' + JSON.stringify(d).slice(0, 200));
  console.log('token refreshed');
  return d.access_token;
}

function fmt(d) { return d.toISOString().slice(0, 10); }
const today = new Date();
const to = fmt(today);
const from = fmt(new Date(today.getTime() - 2 * 86400000));

(async () => {
  const t = await token();
  const H = { 'api-version': '2', Authorization: 'Bearer ' + t, Accept: 'application/json' };
  const adv = cfg.mlAdvertiserId;
  const site = cfg.mlAdvertiserSite || 'MLB';
  const METRICS = 'clicks,prints,cost,units_quantity,total_amount';

  const tries = [
    { desc: 'DAILY(基线)', extra: 'aggregation_type=DAILY&limit=1&offset=0' },
    { desc: 'HOURLY', extra: 'aggregation_type=HOURLY&limit=1&offset=0' },
    { desc: 'HOUR', extra: 'aggregation_type=HOUR&limit=1&offset=0' },
    { desc: 'HOURS', extra: 'aggregation_type=HOURS&limit=1&offset=0' },
    { desc: 'DAILY+breakdowns=hour', extra: 'aggregation_type=DAILY&breakdowns=hour&limit=1&offset=0' },
    { desc: 'granularity=hour', extra: 'granularity=hour&limit=1&offset=0' },
    { desc: 'aggregation_type=HOURLY + date_format', extra: 'aggregation_type=HOURLY&date_format=hour&limit=1&offset=0' },
  ];

  for (const t2 of tries) {
    const url = `${BASE}/advertising/${site}/advertisers/${adv}/product_ads/campaigns/search?date_from=${from}&date_to=${to}&metrics=${METRICS}&${t2.extra}`;
    try {
      const r = await fetch(url, { headers: H });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch {}
      const sample = j && j.results && j.results[0];
      console.log(`\n[${r.status}] ${t2.desc}`);
      if (j && j.results) {
        console.log('  results:', j.results.length, (j.paging ? 'paging.total=' + j.paging.total : ''));
        console.log('  row0:', JSON.stringify(sample));
      } else {
        console.log('  body:', txt.slice(0, 220));
      }
    } catch (e) { console.log(`\n[ERR] ${t2.desc}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 800));
  }
})();
