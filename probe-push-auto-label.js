#!/usr/bin/env node
/**
 * 微信提醒：售前提问推送里的「已自动回复」标注。
 *
 * 背景：自动回复是 1 分钟一轮，推送是 N 分钟一轮，两边各跑各的。
 * 推送先到就会出现「推 3 条新提问叫你去回」，点进后台发现机器人早回完了 —— 白跑一趟。
 * 现在推送前先同步跑一轮自动回复，正文里对已回的逐条打「✅ 已自动回复 · 无需处理」，
 * 标题也改成「售前已自动回复 N 条（无需处理）」。
 *
 * 这个探针分两段：
 *   1) 直接喂数据给 push-format.js 的纯函数，断言文案/标题/转义（确定性，不依赖环境）
 *   2) 打 ?preview=1 走一遍真实链路，确认能拿到 title/html 且不发送
 *
 * 用法：node probe-push-auto-label.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { questionPushHtml, questionPushTitle, escPush, buildQuestionPayload } = require('./push-format');

const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail))); }
}
const has = (hay, needle) => String(hay).indexOf(needle) >= 0;

const base = {
  id: 111, text: 'Qual o tamanho?', time: '10-23 09:12',
  itemTitle: 'Wireless Headset', permalink: 'https://mercadolivre.com.br/p/MLB1',
};

(async () => {
  console.log('\n— 1. 纯渲染：全部已自动回复 —');
  const allAuto = [
    { ...base, autoReplied: { atText: '10-23 09:15', ruleLabel: 'tamanho' } },
    { ...base, id: 222, text: 'Tem garantia?', autoReplied: { atText: '10-23 09:15', ruleLabel: 'garantia / garantia?' } },
  ];
  const htmlAll = questionPushHtml(allAuto, '巴西站');
  const titleAll = questionPushTitle(allAuto, '巴西站');
  ok(/已自动回复/.test(titleAll), '标题包含「已自动回复」', titleAll);
  ok(/无需处理/.test(titleAll), '标题包含「无需处理」', titleAll);
  ok(has(titleAll, '2 条'), '标题带条数', titleAll);
  ok(has(titleAll, '巴西站'), '标题带站点', titleAll);
  ok(!/去回复/.test(htmlAll), '正文里不再出现「去回复」的行动指令');
  ok(/打开商品页查看/.test(htmlAll), '链接改成「打开商品页查看」（不是「去回复」）');
  ok((htmlAll.match(/✅ 已自动回复/g) || []).length === 2, '两条都打了「✅ 已自动回复」徽标',
    (htmlAll.match(/✅ 已自动回复/g) || []).length);
  ok((htmlAll.match(/无需处理/g) || []).length >= 2, '每条都写了「无需处理」');
  ok(/已全部由关键词规则自动回复/.test(htmlAll), '顶部有一句「已全部…自动回复」的总括', null);
  ok(has(htmlAll, '不用再去处理'), '总括明确说「不用再去处理」');
  ok(has(htmlAll, '10-23 09:15'), '写明自动回复的时间');
  ok(has(htmlAll, 'tamanho'), '写明命中的规则关键词');

  console.log('\n— 2. 纯渲染：混合（部分已回 / 部分没回）—');
  const mixed = [
    { ...base, autoReplied: { atText: '10-23 09:15', ruleLabel: 'tamanho' } },
    { ...base, id: 333, text: 'Vocês enviam para Portugal?' },
  ];
  const htmlMix = questionPushHtml(mixed, '巴西站');
  const titleMix = questionPushTitle(mixed, '巴西站');
  ok(has(titleMix, '1 条已自动回复'), '标题写「1 条已自动回复」', titleMix);
  ok(/1 条已自动回复/.test(htmlMix), '正文总括写「1 条已自动回复」', null);
  ok(has(htmlMix, '没标的才要你去回'), '正文明确指出「没标的才要你去回」');
  ok(has(htmlMix, '👉 打开商品页去回复'), '没自动回复的那条仍然给「去回复」');
  ok((htmlMix.match(/✅ 已自动回复/g) || []).length === 1, '只有一条带徽标',
    (htmlMix.match(/✅ 已自动回复/g) || []).length);

  console.log('\n— 3. 纯渲染：全都没自动回复（回归，别把老行为改坏）—');
  const none = [{ ...base }, { ...base, id: 444, text: 'Chega em quantos dias?' }];
  const htmlNone = questionPushHtml(none, '巴西站');
  const titleNone = questionPushTitle(none, '巴西站');
  ok(titleNone === '🛒 美客多新提问 2 条 · 巴西站', '标题与改动前完全一致', titleNone);
  ok(!/已自动回复/.test(htmlNone), '正文里没有「已自动回复」字样');
  ok(!/无需处理/.test(htmlNone), '正文里没有「无需处理」字样');
  ok((htmlNone.match(/去回复/g) || []).length === 2, '两条都给「去回复」',
    (htmlNone.match(/去回复/g) || []).length);
  ok(!/border-left:3px solid/.test(htmlNone), '没有多余的绿色总括条');

  console.log('\n— 4. 转义：买家原文 / 标题里带标签和引号 —');
  const evil = [{
    id: 555, text: '<img src=x onerror=alert(1)> "aspas" & \'single\'',
    time: '10-23 10:00', itemTitle: '<b>bold</b>', permalink: 'https://x.test/a?b=1&c=2',
    autoReplied: { atText: '10-23 10:01', ruleLabel: '<script>' },
  }];
  const htmlEvil = questionPushHtml(evil, '<svg onload=1>');
  ok(!/<img src=x/.test(htmlEvil), '买家原文里的 <img> 被转义');
  ok(!/<script>/.test(htmlEvil), '规则名里的 <script> 被转义');
  ok(!/<b>bold<\/b>/.test(htmlEvil), '商品标题里的 <b> 被转义');
  ok(!/<svg onload/.test(htmlEvil), '站点名里的 <svg> 被转义');
  ok(has(htmlEvil, '&amp;c=2'), '链接里的 & 被转义成 &amp;');
  ok(escPush('"a"') === '&quot;a&quot;', 'escPush 处理双引号');
  ok(escPush(null) === '', 'escPush 处理 null');

  console.log('\n— 5. payload 映射：命中/没命中/时间戳 —');
  const batch = [
    { id: 9001, text: 'Qual o tamanho?', date_created: '2026-10-23T12:15:00.000Z', item_id: 'MLB1' },
    { id: 9002, text: 'Tem garantia?', date_created: '2026-10-23T12:20:00.000Z', item_id: 'MLB2' },
  ];
  const titles = { MLB1: { title: 'Wireless Headset', permalink: 'https://x.test/1' } };
  const autoMap = { 9001: { at: 1761300000000, ruleId: 'rule-a', ruleLabel: 'tamanho' } };
  const pl = buildQuestionPayload(batch, titles, autoMap, () => '10-23 09:15');
  ok(pl.length === 2, '两条都映射出来', pl.length);
  ok(!!pl[0].autoReplied, '命中 autoReplied 的那条带标记');
  ok(pl[0].autoReplied.ruleLabel === 'tamanho', '带上命中的关键词', pl[0].autoReplied);
  ok(pl[0].autoReplied.atText === '10-23 09:15', '自动回复时间经过 stamp 格式化', pl[0].autoReplied.atText);
  ok(pl[1].autoReplied === null, '没命中的那条 autoReplied=null（不是 false/undefined）', pl[1].autoReplied);
  ok(pl[1].itemTitle === '', '没有标题的商品留空字符串', pl[1].itemTitle);
  ok(buildQuestionPayload([{ id: 1, text: '' }], {}, {}, () => '')[0].text === '(无文字内容)', '空提问文本有兜底');
  // 关键：数字 id 与字符串 key 不能因为类型不同而匹配不上
  const pl2 = buildQuestionPayload([{ id: 9001, text: 'x', item_id: 'MLB1' }], titles, { '9001': { at: 1, ruleLabel: 'k' } }, () => 't');
  ok(!!pl2[0].autoReplied, '数字 id 对字符串 key 也能命中（不能靠类型相等）');

  console.log('\n— 6. 空列表不炸 —');
  ok(questionPushHtml([], '巴西站').indexOf('共 0 条新提问') >= 0, '空列表也能渲染');
  ok(!/已自动回复/.test(questionPushTitle([], '巴西站')), '空列表标题不提自动回复');
  ok(questionPushHtml(null, null).length > 0, 'null 入参不抛异常');

  console.log('\n— 7. 真实链路：?preview=1 只渲染不发送 —');
  const ck = await login();
  const pv = await post('/api/push/check?only=questions&preview=1', {}, ck);
  ok(pv && pv.status === 200, '预览接口返回 200', pv && pv.status);
  const body = pv && pv.json;
  ok(body && body.ok === true, 'ok=true', body && body.ok);
  if (body && body.preview) {
    ok(body.preview === true, '明确标记为 preview');
    ok(typeof body.title === 'string' && body.title.length > 0, '返回了标题', body.title);
    ok(typeof body.html === 'string' && body.html.length > 0, '返回了正文 HTML', body.html && body.html.length);
    ok(!body.pushAt, '预览不会真的发送（没有新的推送记录）');
    console.log('     标题：' + body.title);
    if (body.autoReplied != null) console.log('     其中已自动回复：' + body.autoReplied + ' 条');
  } else {
    // 基线没建 / 没有新提问时不会进入渲染分支，这也算预期；把原因打出来
    console.log('     （本次没有可预览的新提问：' + ((body && body.summary) || '未知') + '）');
    ok(body && (body.baseline === true || body.fresh === 0 || body.pushed === 0),
      '没有新提问时走的是「不推送」分支，符合预期', body && body.summary);
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('✗ ' + e.message); process.exitCode = 1; });

function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}

function post(pathname, payload, cookie) {
  const body = Buffer.from(JSON.stringify(payload || {}));
  return new Promise((res, rej) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length };
    if (cookie) headers.Cookie = 'ml_session=' + cookie;
    const r = http.request({ host: '127.0.0.1', port: API, path: pathname, method: 'POST', headers },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { } res({ status: s.statusCode, json: j, raw: d }); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
