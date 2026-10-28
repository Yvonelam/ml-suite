#!/usr/bin/env node
/**
 * API 边界测试：对每个接口灌畸形参数，断言不出现 500 / HTML 错误栈 / 进程不掉。
 * 只打参数校验层，不发真实抓取请求（都带非法参数，应当在抓数据前就被挡住）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 3000;
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data/dev-login.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   → ' + JSON.stringify(extra).slice(0, 200) : '')); } };

function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { s.resume(); s.on('end', () => { const c = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); c ? res(decodeURIComponent(c.split(';')[0].slice(11))) : rej(new Error('登录失败')); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
function req(ck, p, method = 'GET', body) {
  return new Promise((res, rej) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { Cookie: 'ml_session=' + ck, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res({ code: s.statusCode, body: d, type: s.headers['content-type'] || '' })); });
    r.on('error', rej);
    r.setTimeout(25000, () => { r.destroy(); rej(new Error('timeout')); });
    if (payload) r.write(payload); r.end();
  });
}

// 判定：不能是 500，也不能吐出 HTML（HTML 说明掉到 Express 默认错误页或 auth 门）
function judge(label, r, { allow = [200, 400, 404, 422] } = {}) {
  const isHtml = /text\/html/i.test(r.type);
  const crash = /at Object\.|ReferenceError|TypeError|Cannot read|undefined is not|node_modules/i.test(r.body);
  ok(r.code < 500 && !crash && !isHtml, label, { code: r.code, type: r.type, head: String(r.body).slice(0, 160) });
}

(async () => {
  const ck = await login();
  console.log('已登录，开始边界测试\n');

  console.log('=== 1. 数字型参数（负数 / 字母 / 超大 / 小数） ===');
  const numericPaths = [
    '/api/ml/orders?limit=-1&offset=0',
    '/api/ml/orders?limit=abc&offset=xyz',
    '/api/ml/orders?limit=999999&offset=-999',
    '/api/ml/orders?limit=1.5&offset=2.7',
    '/api/ml/claims?limit=-5',
    '/api/ml/claims?limit=abc',
    '/api/ml/questions?limit=0',
    '/api/ml/questions?limit=1e9',
    '/api/ml/ads/hourly?days=-3',
    '/api/ml/ads/hourly?days=abc',
    '/api/search?kw=&site=MLB&pages=0',
    '/api/search?kw=&site=MLB&pages=999',
  ];
  for (const p of numericPaths) {
    try { judge(p, await req(ck, p)); } catch (e) { ok(false, p + ' 请求异常', e.message); }
  }

  console.log('\n=== 2. 日期型参数（倒序 / 非法 / 未来 / 超长跨度） ===');
  const datePaths = [
    '/api/ml/profit/orders?from=2026-10-28&to=2026-10-01',
    '/api/ml/profit/orders?from=abc&to=xyz',
    '/api/ml/profit/orders?from=&to=',
    '/api/ml/profit/orders?from=2026-13-45&to=2026-02-30',
  ];
  for (const p of datePaths) {
    try { judge(p, await req(ck, p)); } catch (e) { ok(false, p + ' 请求异常', e.message); }
  }

  // 跨度上限：这三处原来都没限制，from=1990&to=2030 会切成上万次 API 调用、直接把请求挂死
  console.log('\n=== 2b. 超大跨度必须被 400 秒回（不能挂死） ===');
  for (const [p, label] of [
    ['/api/ml/profit/orders?from=1990-01-01&to=2030-12-31', '利润统计'],
    ['/api/ml/sales?from=1990-01-01&to=2030-12-31', '销售统计'],
    ['/api/ml/listings?from=1990-01-01&to=2030-12-31', 'Listing 统计'],
  ]) {
    const t0 = Date.now();
    try {
      const r = await req(ck, p);
      const ms = Date.now() - t0;
      ok(r.code === 400 && /跨度/.test(r.body) && ms < 5000,
        label + ' 40 年跨度被 400 快速拒绝（' + ms + 'ms）', { code: r.code, ms, head: r.body.slice(0, 100) });
    } catch (e) { ok(false, label + ' 超长跨度请求异常', e.message); }
  }

  console.log('\n=== 3. 站点参数（非法 / 小写 / 注入） ===');
  for (const s of ['MLX', '', 'mlb', 'MLB<script>', '../../etc/passwd', 'MLB%00']) {
    const p = '/api/test?site=' + encodeURIComponent(s);
    try { judge('/api/test?site=' + (s || '(空)'), await req(ck, p)); } catch (e) { ok(false, p + ' 异常', e.message); }
  }

  console.log('\n=== 4. 路径参数（不存在的 id / 注入） ===');
  for (const id of ['__nope__', '0', '../../etc/passwd', 'a'.repeat(500)]) {
    try { judge('GET /api/ml/claims/' + id.slice(0, 20), await req(ck, '/api/ml/claims/' + encodeURIComponent(id))); } catch (e) { ok(false, 'claims/' + id + ' 异常', e.message); }
  }

  console.log('\n=== 5. POST 空体 / 畸形 JSON / 错误类型 ===');
  const posts = ['/api/config', '/api/push/config', '/api/send-report'];
  for (const p of posts) {
    try { judge('POST ' + p + ' 空体', await req(ck, p, 'POST', '')); } catch (e) { ok(false, p + ' 异常', e.message); }
    try { judge('POST ' + p + ' 错类型', await req(ck, p, 'POST', { rules: 'not-an-array', enabled: 'yes', keywords: 123 })); } catch (e) { ok(false, p + ' 异常', e.message); }
  }

  // 畸形 JSON 过去会掉进 Express 默认错误页：400 + 一整段 HTML（含文件路径与堆栈）。
  // 前端 mlGet 里的 r.json() 直接失败，用户只看到「HTTP 400」。现在必须回 JSON。
  console.log('\n=== 5b. 畸形 JSON 必须回 JSON，不能泄漏 HTML 堆栈 ===');
  for (const p of posts.concat(['/api/ml/questions/auto-reply'])) {
    const method = p.includes('auto-reply') ? 'PUT' : 'POST';
    try {
      const r = await req(ck, p, method, '{bad json');
      const isJson = /application\/json/i.test(r.type);
      const leak = /at Object\.|node_modules|<pre>|SyntaxError:/i.test(r.body);
      ok(r.code === 400 && isJson && !leak,
        method + ' ' + p + ' 畸形 JSON → 400 + JSON 无堆栈',
        { code: r.code, type: r.type, head: r.body.slice(0, 120) });
    } catch (e) { ok(false, method + ' ' + p + ' 畸形 JSON 异常', e.message); }
  }

  console.log('\n=== 6. PUT 自动回复：脏数据是否被挡住 ===');
  const putBad = [
    { rules: 'not-array' },
    { rules: [{ id: '', keywords: 'not-array', reply: {} }] },
    { rules: [{ keywords: ['a'.repeat(200)], reply: 'x'.repeat(3000) }] },
    { enabled: true, rules: [] },
    { rules: [{ keywords: ['ok'], reply: 'ok', enabled: 'truthy' }] },
  ];
  for (const b of putBad) {
    try { judge('PUT 脏数据 ' + JSON.stringify(b).slice(0, 60), await req(ck, '/api/ml/questions/auto-reply', 'PUT', b)); } catch (e) { ok(false, 'PUT 异常', e.message); }
  }

  console.log('\n=== 7. 未登录访问（应 401，不能漏数据也不能 500） ===');
  for (const p of ['/api/config', '/api/ml/orders', '/api/settings', '/api/push/status']) {
    const r = await new Promise((res, rej) => {
      const q = http.request({ host: '127.0.0.1', port: PORT, path: p }, s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res({ code: s.statusCode, body: d, type: s.headers['content-type'] || '' })); });
      q.on('error', rej); q.end();
    });
    ok(r.code === 401 || r.code === 302 || r.code === 403, '未登录 ' + p + ' 被拒（' + r.code + '）', r.code);
    ok(!/sellerId|accessToken|smtpPass|password/i.test(r.body), '未登录 ' + p + ' 响应不含敏感字段');
  }

  console.log('\n=== 8. 服务是否还活着 ===');
  const alive = await req(ck, '/api/auth/me').catch(e => ({ code: 0, body: e.message }));
  ok(alive.code === 200, '边界测试跑完后服务仍正常', alive.code);

  // 限流识别是纯函数，直接读源码验算（售后提醒漏检就是它没兜住导致的）
  console.log('\n=== 9. 限流识别 isRateLimited ===');
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const mm = src.match(/function isRateLimited\([\s\S]*?\n\}\n/);
  if (!mm) { ok(false, 'server.js 里找不到 isRateLimited'); }
  else {
    let fn = null;
    try { fn = eval('(' + mm[0].replace(/^function\s+isRateLimited/, 'function') + ')'); } catch (e) { ok(false, 'isRateLimited 无法求值：' + e.message); }
    if (fn) {
      for (const [st, d, exp, label] of [
        [429, {}, true, 'HTTP 429'],
        [429, { error: 'local_rate_limited' }, true, '429 + local_rate_limited'],
        [200, { error: 'local_rate_limited' }, true, '200 但 body 是 local_rate_limited'],
        [400, { message: 'Local_Rate_Limited' }, true, '大小写混合'],
        [500, { error: 'internal' }, false, '普通 500 不算限流'],
        [404, null, false, '404 且无 body 不算'],
        [200, { ok: true }, false, '正常响应不算'],
      ]) {
        const got = fn(st, d);
        ok(got === exp, 'isRateLimited(' + label + ') = ' + exp, got);
      }
    }
  }

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
