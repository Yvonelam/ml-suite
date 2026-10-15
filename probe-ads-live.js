'use strict';
/* 测美客多「当天广告花费」计数器的实盘更新频率：隔段时间取一次，看是否在变 */
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const cfg = require('./daily-search-config.json');
if (cfg.proxy) setGlobalDispatcher(new ProxyAgent(cfg.proxy));
const BASE = 'https://api.mercadolibre.com';
async function token() {
  if (cfg.mlAccessToken && cfg.mlTokenExpireAt && Date.now() < cfg.mlTokenExpireAt - 120000) return cfg.mlAccessToken;
  const r = await fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.mlAppId, client_secret: cfg.mlSecret, refresh_token: cfg.mlRefreshToken }) });
  return (await r.json()).access_token;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const t = await token();
  const H = { 'api-version': '2', Authorization: 'Bearer ' + t, Accept: 'application/json' };
  const adv = cfg.mlAdvertiserId, site = cfg.mlAdvertiserSite || 'MLB';
  const METRICS = 'clicks,prints,cost,units_quantity,total_amount';
  // 账号本地时间 GMT-4 的"今天"
  const now = Date.now();
  const todayAcc = new Date(now - 4 * 3600e3).toISOString().slice(0, 10);
  console.log('账号(GMT-4)今天 =', todayAcc, ' 本地时刻 =', new Date(now).toString());
  const url = `${BASE}/advertising/${site}/advertisers/${adv}/product_ads/campaigns/search?date_from=${todayAcc}&date_to=${todayAcc}&metrics=${METRICS}&aggregation_type=DAILY&limit=1&offset=0`;
  let prev = null;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: H });
    const j = await r.json();
    const row = (j.results || [])[0] || {};
    const stamp = new Date().toISOString().slice(11, 19);
    const delta = prev == null ? '' : ' (Δ' + (Number(row.cost) - prev).toFixed(2) + ')';
    console.log(`[${stamp}Z] cost=${row.cost}  clicks=${row.clicks}  units=${row.units_quantity}  prints=${row.prints}${delta}`);
    prev = Number(row.cost);
    if (i < 4) await sleep(45000);
  }
})();
