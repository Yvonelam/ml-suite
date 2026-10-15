'use strict';
/* 核验：订单 date_created 的偏移 vs 项目 SALES_TZ(America/Sao_Paulo) 换算是否一致 */
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const cfg = require('./daily-search-config.json');
if (cfg.proxy) setGlobalDispatcher(new ProxyAgent(cfg.proxy));
const BASE = 'https://api.mercadolibre.com';
function tzParts(iso, tz) {
  const d = new Date(iso); if (isNaN(d)) return null;
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute) };
}
async function token() {
  if (cfg.mlAccessToken && cfg.mlTokenExpireAt && Date.now() < cfg.mlTokenExpireAt - 120000) return cfg.mlAccessToken;
  const r = await fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.mlAppId, client_secret: cfg.mlSecret, refresh_token: cfg.mlRefreshToken }) });
  return (await r.json()).access_token;
}
(async () => {
  const t = await token();
  const H = { Authorization: 'Bearer ' + t, Accept: 'application/json' };
  const u = await (await fetch(BASE + '/users/me', { headers: H })).json();
  const d = await (await fetch(`${BASE}/orders/search?seller=${u.id}&sort=date_desc&limit=10`, { headers: H })).json();
  console.log('服务器本地时区 =', Intl.DateTimeFormat().resolvedOptions().timeZone, ' 现在=', new Date().toString());
  console.log('样本 date_created 原串            | 字符串小时 | 圣保罗换算 | 差值');
  (d.results || []).forEach(o => {
    const s = String(o.date_created || '');
    const strHour = s.slice(11, 13);
    const p = tzParts(s, 'America/Sao_Paulo');
    const diff = p ? ((p.hour - Number(strHour) + 24) % 24) : '?';
    console.log(`${s} |    ${strHour}      |    ${p ? p.hour : '?'}      |  ${diff}`);
  });
  // 顺便看 page0 里 date_created 出现的偏移集合
  const offs = new Set((d.results || []).map(o => String(o.date_created).slice(-6)));
  console.log('出现的偏移集合 =', [...offs].join(', '));
})();
