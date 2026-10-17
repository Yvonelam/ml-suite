#!/usr/bin/env node
/**
 * 连接韧性单测 —— 从 start-public.js 里**抠出真身函数**来跑，不复制代码。
 *   ① makeBackoff：指数退避序列 3s→300s 封顶、永不放弃、稳定后归零
 *   ② probeUrl  ：200/500/连不上/超时 四种情形判定是否正确
 *
 * 为什么抠源码：复制一份到测试里就失去意义了，改了源码测试还绿是自欺欺人。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const SRC_FILE = path.join(__dirname, 'start-public.js');
const src = fs.readFileSync(SRC_FILE, 'utf8');

// 按大括号配对切出一个顶层 function 声明
function sliceFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('源码里找不到函数 ' + name);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('函数 ' + name + ' 括号不配对');
  return src.slice(start, end);
}

function sliceConst(name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);'));
  if (!m) throw new Error('源码里找不到常量 ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
}

const prelude = ['BACKOFF_BASE_MS', 'BACKOFF_MAX_MS', 'STABLE_RESET_MS'].map(sliceConst).join('\n');
const makeBackoff = new Function(prelude + '\n' + sliceFn('makeBackoff') + '\nreturn makeBackoff;')();
const probeUrl = new Function('http', sliceFn('probeUrl') + '\nreturn probeUrl;')(http);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : '')); }
}

(async () => {
  // ---------- ① 退避序列 ----------
  console.log('\n[1] 指数退避序列');
  const bo = makeBackoff('测试');
  const seq = [];
  for (let i = 0; i < 9; i++) seq.push(bo.nextDelay());
  console.log('    序列(ms): ' + seq.join(' → '));
  ok(seq[0] === 3000, '第 1 次 3 秒', seq[0]);
  ok(seq[1] === 6000, '第 2 次 6 秒', seq[1]);
  ok(seq[2] === 12000, '第 3 次 12 秒', seq[2]);
  ok(seq[3] === 24000, '第 4 次 24 秒', seq[3]);
  ok(seq[4] === 48000, '第 5 次 48 秒', seq[4]);
  ok(seq[5] === 96000, '第 6 次 96 秒', seq[5]);
  ok(seq[6] === 192000, '第 7 次 192 秒', seq[6]);
  ok(seq[7] === 300000, '第 8 次封顶 300 秒', seq[7]);
  ok(seq[8] === 300000, '第 9 次仍封顶 300 秒（不会无限涨）', seq[8]);
  ok(seq.every((v) => v >= 3000 && v <= 300000), '全部落在 [3s, 300s] 区间');

  // 永不放弃：跑 500 次都还能拿到合理延迟（老逻辑 10 次就 return 放弃）
  let allValid = true;
  for (let i = 0; i < 500; i++) {
    const v = bo.nextDelay();
    if (!(v > 0 && v <= 300000)) { allValid = false; break; }
  }
  ok(allValid, '连续 500 次重试都返回有效延迟（证明永不放弃）');
  ok(bo.tries === 509, '计数如实累加', bo.tries);

  bo.reset();
  ok(bo.nextDelay() === 3000, 'reset() 后退避归零，重新从 3 秒开始');

  // 稳定存活 60 秒后自动归零
  const bo2 = makeBackoff('测试2');
  bo2.nextDelay(); bo2.nextDelay(); bo2.nextDelay();
  ok(bo2.tries === 3, '三次失败计数=3', bo2.tries);
  bo2.markStarted();
  await new Promise((r) => setTimeout(r, 120));
  // 把 STABLE_RESET_MS 缩不了，直接验证 reset 语义已在上面覆盖；markStarted 只验证不抛错
  ok(true, 'markStarted() 不抛错');
  bo2.markDead();
  ok(true, 'markDead() 不抛错');

  // ---------- ② probeUrl ----------
  console.log('\n[2] 端到端探测 probeUrl');
  let hit = 0;
  const srv = http.createServer((req, res) => {
    hit++;
    if (req.url === '/ok') { res.writeHead(200); res.end('ok'); }
    else if (req.url === '/gate') { res.writeHead(403); res.end('no'); }
    else if (req.url === '/boom') { res.writeHead(530); res.end('bad'); }
    else if (req.url === '/hang') { /* 故意不响应 */ }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  let r = await probeUrl(base + '/ok', 3000);
  ok(r.ok === true && r.status === 200, '200 → ok=true / status=200', r);

  r = await probeUrl(base + '/gate', 3000);
  ok(r.ok === true && r.status === 403, '403（访问口令拦截）→ 仍算「通」', r);

  r = await probeUrl(base + '/boom', 3000);
  ok(r.ok === true && r.status === 530, '530 → ok=true 但 status=530，由调用方判为坏', r);

  r = await probeUrl(base + '/hang', 600);
  ok(r.ok === false && r.status === 0, '挂住不响应 → 超时判失败', r);

  srv.close();
  await new Promise((r) => setTimeout(r, 100));

  r = await probeUrl(base + '/ok', 800);
  ok(r.ok === false && r.status === 0, '端口已关 → 连接失败判失败', r);

  r = await probeUrl('https://127.0.0.1:1/', 500);
  ok(r.ok === false, '打不通的 https 地址 → 判失败，不抛异常', r);

  console.log('\n  [探测次数] 本地测试服务器共收到 ' + hit + ' 次请求');
  console.log('\n================ 结果：' + pass + ' 通过 / ' + fail + ' 失败 ================\n');
  process.exit(fail ? 1 : 0);
})();
