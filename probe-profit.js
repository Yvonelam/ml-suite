#!/usr/bin/env node
/**
 * 利润接口诊断探针
 *   ① 单次运费接口的真实延迟（决定并发要开到多大）
 *   ② 运费接口到底返回什么结构 —— 为什么利润表 17 行全部「运费缺失」
 *
 * 用真实 token 打美客多 API（走 Clash 代理），不改数据库、不写缓存。
 */
'use strict';

const fs = require('fs');
const path = require('path');

let ProxyAgent, setGlobalDispatcher;
try { ({ ProxyAgent, setGlobalDispatcher } = require('undici')); } catch (e) {
  console.error('缺少 undici'); process.exit(1);
}
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';
setGlobalDispatcher(new ProxyAgent(PROXY));

const API = 'https://api.mercadolibre.com';
const CFG = path.join(__dirname, 'auth-data', 'configs', 'admin.json');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
if (!cfg.mlAccessToken) { console.error('配置里没有 mlAccessToken'); process.exit(1); }
const H = { Accept: 'application/json', Authorization: 'Bearer ' + cfg.mlAccessToken };

async function api(p) {
  const t0 = Date.now();
  const r = await fetch(API + p, { headers: H, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let d = null; try { d = text ? JSON.parse(text) : null; } catch { d = { raw: text.slice(0, 300) }; }
  return { status: r.status, ms: Date.now() - t0, data: d };
}

function tzToday() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date());
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const me = await api('/users/me');
  if (me.status !== 200) { console.error('取用户失败', me.status, me.data); process.exit(1); }
  const uid = me.data.id;
  console.log('卖家 ID: ' + uid + ' · 站点: ' + me.data.site_id);

  const to = tzToday(), from = addDays(to, -9);
  console.log('统计区间: ' + from + ' → ' + to + '（巴西时间）\n');

  // ---- ① 拉订单 ----
  const tOrder = Date.now();
  const q = `order.date_created.from=${from}T00:00:00.000-03:00&order.date_created.to=${to}T23:59:59.999-03:00`;
  let raw = [], offset = 0, total = 0;
  while (raw.length < 500) {
    const r = await api(`/orders/search?seller=${uid}&${q}&sort=date_asc&limit=50&offset=${offset}`);
    if (r.status !== 200) { console.error('拉订单失败', r.status, r.data); break; }
    const rows = r.data.results || [];
    total = Number(r.data.paging?.total || rows.length);
    raw.push(...rows); offset += 50;
    if (!rows.length || offset >= total) break;
  }
  console.log('[1] 订单：' + raw.length + ' 条（apiTotal=' + total + '），耗时 ' + ((Date.now() - tOrder) / 1000).toFixed(1) + ' 秒');

  const valid = raw.filter((o) => !['cancelled', 'invalid'].includes(String(o.status || '')));
  const shipIds = [...new Set(valid.map((o) => String(o.shipping?.id || '')).filter(Boolean))];
  const noShip = valid.filter((o) => !o.shipping?.id).length;
  console.log('    有效订单 ' + valid.length + ' · 有 shipment ' + shipIds.length + ' 个 · 无 shipment ' + noShip + ' 单\n');

  // ---- ② 运费接口延迟 + 结构 ----
  const sample = shipIds.slice(0, 24);
  console.log('[2] 运费接口探测（' + sample.length + ' 个 shipment，并发 6 批）');
  const results = [];
  const tShip = Date.now();
  for (let i = 0; i < sample.length; i += 6) {
    const part = await Promise.all(sample.slice(i, i + 6).map(async (id) => {
      let t0 = Date.now(), d = null, via = 'marketplace/…/costs', status = 0;
      try {
        const r = await api(`/marketplace/shipments/${id}/costs`);
        status = r.status; d = r.data; via = 'marketplace(' + r.status + ')';
      } catch (e) {
        via = 'marketplace(异常 ' + e.message + ')';
      }
      if (status !== 200) {
        const t1 = Date.now();
        try {
          const r2 = await api(`/shipments/${id}/costs?seller_id=${uid}`);
          if (r2.status === 200) { d = r2.data; via += ' → shipments(' + r2.status + ')'; status = 200; }
          else via += ' → shipments(' + r2.status + ')';
        } catch (e) { via += ' → shipments(异常)'; }
        t0 = t0; // keep
      }
      return { id, ms: Date.now() - t0, via, d, ok: status === 200 };
    }));
    results.push(...part);
  }
  const elapsed = (Date.now() - tShip) / 1000;
  const oks = results.filter((r) => r.ok);
  const msList = results.map((r) => r.ms).sort((a, b) => a - b);
  const avg = msList.reduce((a, b) => a + b, 0) / msList.length;
  console.log('    成功 ' + oks.length + '/' + results.length + ' · 总耗时 ' + elapsed.toFixed(1) + ' 秒');
  console.log('    单次延迟：中位 ' + msList[Math.floor(msList.length / 2)] + 'ms · 平均 ' + Math.round(avg) + 'ms · 最慢 ' + msList[msList.length - 1] + 'ms');
  if (oks.length) {
    const estimate = Math.ceil(shipIds.length / 6) * avg / 1000;
    console.log('    → 推算全部 ' + shipIds.length + ' 个、并发 6：约 ' + estimate.toFixed(0) + ' 秒');
    console.log('    → 并发 12：约 ' + (estimate / 2).toFixed(0) + ' 秒 · 并发 16：约 ' + (estimate / 16 * 6).toFixed(0) + ' 秒');
  }

  // ---- ③ 结构：为什么运费缺失 ----
  console.log('\n[3] 运费返回结构（前 4 个成功的原始响应）');
  const currencyOf = {};
  for (const o of valid) {
    const c = o.currency_id || (o.order_items?.[0]?.currency_id) || '';
    currencyOf[o.id] = c;
  }
  let shown = 0;
  for (const r of oks) {
    if (shown >= 4) break;
    shown++;
    const d = r.d || {};
    const senders = Array.isArray(d.senders) ? d.senders : [];
    const seller = senders.find((x) => String(x.user_id) === String(uid)) || senders[0];
    console.log('\n  --- shipment ' + r.id + '（' + r.via + '，' + r.ms + 'ms）---');
    console.log('    顶层键: ' + Object.keys(d).join(', '));
    console.log('    currency_id = ' + JSON.stringify(d.currency_id) + '   shipping_fee = ' + JSON.stringify(d.shipping_fee));
    console.log('    senders: ' + JSON.stringify(senders).slice(0, 400));
    console.log('    取到的 cost = ' + JSON.stringify(seller?.cost) + ' / 判定 currency = ' + JSON.stringify(d.currency_id || ''));
  }

  // ---- ④ 币种对照：订单币种 vs 运费币种 ----
  console.log('\n[4] 币种对照检查（运费 currency 与订单 currency 是否一致）');
  let match = 0, mismatch = 0, empty = 0;
  const samples = [];
  for (const r of oks) {
    const d = r.d || {};
    const feeCurrency = d.currency_id || '';
    const orderCurrency = d.currency_id ? d.currency_id : null;
    if (!feeCurrency) { empty++; samples.push({ id: r.id, fee: '(空)', order: '?' }); }
    else { match++; }
  }
  console.log('    运费响应带 currency_id: ' + match + ' · 缺 currency_id: ' + empty);

  const curSet = {};
  for (const o of valid) { const c = o.currency_id || ''; curSet[c] = (curSet[c] || 0) + 1; }
  console.log('    订单币种分布: ' + JSON.stringify(curSet));

  // 直接看几个订单币种和对应运费币种是否一致
  console.log('\n    逐单核对（前 6 个）：');
  const orderByShip = {};
  for (const o of valid) { const sid = String(o.shipping?.id || ''); if (sid && !orderByShip[sid]) orderByShip[sid] = o; }
  for (const r of oks.slice(0, 6)) {
    const o = orderByShip[r.id];
    const d = r.d || {};
    console.log('      shipment ' + r.id + ' · 订单币种=' + (o?.currency_id || '?') + ' · 运费币种=' + JSON.stringify(d.currency_id || '') + ' · senders=' + (Array.isArray(d.senders) ? d.senders.length : '无'));
  }

  console.log('\n完成。\n');
})();
