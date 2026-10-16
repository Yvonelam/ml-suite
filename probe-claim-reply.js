#!/usr/bin/env node
/**
 * ML Suite · 售后发消息「只读诊断」
 *
 * 用：node probe-claim-reply.js 5594696922 [更多ID...]
 *
 * 做三件事（全部只读，不会真正发出任何消息）：
 *   1. 打印索赔详情（type / stage / 各 player 的 available_actions）
 *   2. 打印完整消息线程（sender_role -> receiver_role、时间、正文）
 *   3. 用「空 message」探测 send-message 端点，比对不同 receiver_role 的返回，
 *      以此判定：缺 receiver_role（param action is null）/ 角色被识别但无权限（send message is not allowed）…
 *
 * 为什么需要：send-message 的必填字段是 message + receiver_role。
 *   少 receiver_role → 美客多报 "param action is null"；
 *   带了但当前轮次没下发动作 → "send message is not allowed"（这属于正常状态，不是 App 的锅）。
 * 空 message 探测之所以安全：美客多的校验顺序是「先解析 receiver_role → 再校验 message」，
 *   所以空消息永远会在 message 这一步被拒，不可能真正投递。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

const CFG_LEGACY = path.join(__dirname, 'daily-search-config.json');
// 账号隔离后配置按账号存放（auth-data/configs/<uid>.json），旧的根目录文件只是遗留
const CFG = (() => {
  const p = process.env.ML_CFG || path.join(__dirname, 'auth-data', 'configs', 'admin.json');
  return fs.existsSync(p) ? p : CFG_LEGACY;
})();
const BASE = 'https://api.mercadolibre.com';
setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897'));

function cfg() { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
async function token() {
  const c = cfg();
  if (c.mlTokenExpireAt && Date.now() > c.mlTokenExpireAt - 120000 && c.mlRefreshToken) {
    const r = await fetch(BASE + '/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: c.mlAppId, client_secret: c.mlSecret, refresh_token: c.mlRefreshToken }),
    });
    const d = await r.json();
    if (!d.access_token) throw new Error('刷新令牌失败 ' + JSON.stringify(d));
    c.mlAccessToken = d.access_token; c.mlRefreshToken = d.refresh_token || c.mlRefreshToken;
    c.mlTokenExpireAt = Date.now() + (d.expires_in || 21600) * 1000;
    fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
    return d.access_token;
  }
  return c.mlAccessToken;
}
async function req(method, p, t, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : null; } catch { d = { raw: txt }; }
  return { status: r.status, data: d };
}
const short = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n || 70);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n, ' ');

(async () => {
  const ids = process.argv.slice(2);
  if (!ids.length) { console.log('用法：node probe-claim-reply.js <索赔ID> [更多ID...]'); process.exit(0); }
  console.log('配置来源：' + CFG);
  const t = await token();
  for (const ID of ids) {
    const c = (await req('GET', '/post-purchase/v1/claims/' + ID, t)).data || {};
    console.log('\n================ 索赔 ' + ID + ' ================');
    console.log('type=' + c.type + '  stage=' + c.stage + '  status=' + c.status + '  reason=' + c.reason_id + '  resource=' + c.resource + '/' + c.resource_id);
    for (const p of (c.players || [])) {
      console.log('  player  role=' + pad(p.role, 11) + ' type=' + pad(p.type, 8) + ' user=' + p.user_id + '  actions=' + JSON.stringify((p.available_actions || []).map(a => (a && a.action) || a)));
    }
    const msgs = (await req('GET', '/post-purchase/v1/claims/' + ID + '/messages', t)).data;
    const arr = Array.isArray(msgs) ? msgs : [];
    console.log('  ---- 消息 ' + arr.length + ' 条 ----');
    for (const m of arr) {
      console.log('  [' + m.sender_role + ' -> ' + m.receiver_role + '] ' + short(m.date_created, 16) + '  ' + short(m.message, 66));
    }
    console.log('  ---- send-message 角色探测（空消息，不会真发出）----');
    const EP = '/post-purchase/v1/claims/' + ID + '/actions/send-message';
    for (const role of [null, 'mediator', 'complainant']) {
      const body = { message: '' };
      if (role) body.receiver_role = role;
      const r = await req('POST', EP, t, body);
      console.log('  receiver_role=' + pad(role, 12) + ' -> HTTP ' + r.status + '  ' + JSON.stringify((r.data && (r.data.message || r.data)) || ''));
    }
    console.log('  解读：某个 role 返回「send message is not allowed」= 该 role 对当前阶段是有效收件人，但你本轮没有发送权限（正常状态，等对方回应）；');
    console.log('        某个 role 落到「Message cant be null」= 该 role 的发送权限是通的（真正发送时正文非空即可成功）。');
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
