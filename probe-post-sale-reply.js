#!/usr/bin/env node
/*
 * Pós-venda 私信回复字段探针（只探测，不发真实消息）
 *
 * 目标：搞清美客多到底要哪些字段。已知 old body `{from:{user_id}, text}` 报
 *   "The field 'to_user_id' is required"
 * 所以这里用「故意缺 text」的方式逐个试容器格式：
 *   - 若回 "text ... required" → 说明 from/to 这组被接受了（字段名对了）
 *   - 若还回 "to_user_id required" → 字段名不对，换下一个组合
 * 缺 text 时平台一定不会真发出消息，安全。
 *
 * 用法：node probe-post-sale-reply.js <packId>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7897';
try { setGlobalDispatcher(new ProxyAgent(PROXY)); } catch (e) { }

const CFG = path.join(__dirname, 'daily-search-config.json');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const API = 'https://api.mercadolibre.com';
const PACK = process.argv[2] || '';
if (!PACK) { console.error('用法：node probe-post-sale-reply.js <packId>'); process.exit(1); }

async function call(p, init = {}, token) {
  const r = await fetch(API + p, {
    ...init,
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: r.status, data };
}

(async () => {
  let token = cfg.mlAccessToken;
  if (!token) { console.error('配置里没有 access_token'); process.exit(1); }

  // 拉一次线程，拿卖家/买家 user_id
  let th = await call(`/messages/packs/${PACK}/sellers/${cfg.mlUserId}?tag=post_sale&mark_as_read=false`, {}, token);

  // token 过期就走服务端刷新（服务端会把新 token 写回配置）
  if (th.status === 401) {
    console.log('access_token 已过期，请先在页面「API 设置」点一次授权/刷新，再跑本探针');
    process.exit(1);
  }
  const msgs = (th.data && th.data.messages) || [];
  const uid = String(cfg.mlUserId || '');
  const fromIds = [...new Set(msgs.map(m => String((m && m.from && m.from.user_id) || '')))].filter(Boolean);
  const buyerId = fromIds.find(x => x !== uid) || '';
  console.log('HTTP ' + th.status + ' · 消息 ' + msgs.length + ' 条 · 卖家 ' + uid + ' · 对方 ' + (buyerId || '(未识别)'));
  console.log('conversation_status =', JSON.stringify((th.data && th.data.conversation_status) || {}));
  if (msgs.length) console.log('最后一条 =', JSON.stringify({ from: msgs[msgs.length - 1].from, text: String(msgs[msgs.length - 1].text || '').slice(0, 40) }));
  if (!buyerId) { console.error('没识别出对方 user_id，后续无从试起'); process.exit(2); }

  const p = `/messages/packs/${PACK}/sellers/${uid}?tag=post_sale`;
  const variants = [
    ['A json  from+to 嵌套', { 'Content-Type': 'application/json' }, JSON.stringify({ from: { user_id: uid }, to: { user_id: buyerId } })],
    ['B json  from+to_user_id 扁平', { 'Content-Type': 'application/json' }, JSON.stringify({ from: { user_id: uid }, to_user_id: buyerId })],
    ['C json  from.user_id + to.user_id 顶层字符串', { 'Content-Type': 'application/json' }, JSON.stringify({ from: { user_id: Number(uid) }, to: { user_id: Number(buyerId) } })],
    ['D form  from+to 嵌套', {}, new URLSearchParams({ from: JSON.stringify({ user_id: uid }), to: JSON.stringify({ user_id: buyerId }) })],
    ['E multipart from+to', {}, (() => { const fd = new FormData(); fd.append('from', JSON.stringify({ user_id: uid })); fd.append('to', JSON.stringify({ user_id: buyerId })); return fd; })()],
    ['F json  from 数组 users', { 'Content-Type': 'application/json' }, JSON.stringify({ from: { user_id: uid }, to: { user_id: buyerId }, users: [uid, buyerId] })],
  ];
  for (const [label, headers, body] of variants) {
    let res;
    try { res = await call(p, { method: 'POST', headers, body }, token); }
    catch (e) { console.log('  ' + label + ' → 异常 ' + e.message); continue; }
    const msg = (res.data && (res.data.message || res.data.error)) || JSON.stringify(res.data || {}).slice(0, 160);
    const okish = /text|message/i.test(String(msg)) && /required|invalid|null/i.test(String(msg));
    console.log('  ' + label + ' → HTTP ' + res.status + ' · ' + String(msg).slice(0, 140) + (okish ? '   ✅ 字段组合被接受（只差 text）' : ''));
    if (okish) { console.log('\n可用组合：' + label); break; }
  }
})().catch(e => { console.error('探针出错：' + e.message); process.exit(1); });
