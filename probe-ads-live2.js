'use strict';
/* 长时间采样：判断美客多当天花费计数器的更新粒度（20 次 × 60s ≈ 20 分钟） */
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
  const todayAcc = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
  const url = `${BASE}/advertising/${site}/advertisers/${adv}/product_ads/campaigns/search?date_from=${todayAcc}&date_to=${todayAcc}&metrics=clicks,prints,cost,units_quantity&aggregation_type=DAILY&limit=1&offset=0`;
  let first = null;
  for (let i = 0; i < 20; i++) {
    try {
      const j = await (await fetch(url, { headers: H })).json();
      const row = (j.results || [])[0] || {};
      const stamp = new Date().toISOString().slice(11, 19);
      if (first == null) first = { cost: Number(row.cost), clicks: Number(row.clicks) };
      const dC = (Number(row.cost) - first.cost).toFixed(2);
      const cl = (Number(row.clicks) - first.clicks);
      console.log(`[${stamp}Z] #${String(i + 1).padStart(2)} cost=${row.cost} (+${dC}) clicks=${row.clicks} (+${cl}) prints=${row.prints} units=${row.units_quantity}`);
    } catch (e) { console.log('[' + new Date().toISOString().slice(11, 19) + 'Z] err ' + e.message); }
    if (i < 19) await sleep(60000);
  }
})();
