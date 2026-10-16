#!/usr/bin/env node
/*
 * 单元验证：直接从 public/app.js 抠出 adSplitForDay 的真身来跑，避免"测试的是我复述的逻辑"。
 * 关注点：结果必须**全为整数**、加总恒等于 min(广告单量, 当天总单)、且每格不超过该小时订单数。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const start = src.indexOf('function adSplitForDay(');
if (start < 0) { console.error('找不到 adSplitForDay'); process.exit(1); }
// 从函数头开始做花括号配平，抠出完整函数体
let i = src.indexOf('{', start), depth = 0, end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
const fnSrc = src.slice(start, end);
const adSplitForDay = new Function(fnSrc + '; return adSplitForDay;')();

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (ok ? '' : `\n     得到 ${JSON.stringify(got)}\n     期望 ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
const isInt = a => a.every(v => Number.isInteger(v));
const sum = a => a.reduce((s, v) => s + v, 0);

console.log('\n【真实场景】2026-10-16：出单 2 单（01:00、03:00），广告单量 1');
{
  const day = { date: '2026-10-16', orders: 2, units: 1, adUnits: 1, hours: (() => { const h = new Array(24).fill(0); h[1] = 1; h[3] = 1; return h; })() };
  const r = adSplitForDay(day);
  console.log('  结果:', JSON.stringify(r.filter(v => v > 0)) + '  合计=' + sum(r));
  check('全是整数（不再有 0.5）', isInt(r), true);
  check('合计 = 当天广告单量 1', sum(r), 1);
  check('每格不超过该小时订单数', r.every((v, h) => v <= day.hours[h]), true);
}

console.log('\n【一单多件】广告件数 5 > 当天订单 2 → 钳到 2');
{
  const h = new Array(24).fill(0); h[1] = 1; h[3] = 1;
  const r = adSplitForDay({ orders: 2, adUnits: 5, hours: h });
  check('合计 = 2（被钳制）', sum(r), 2);
  check('全是整数', isInt(r), true);
}

console.log('\n【余数分配】出单 4（2/1/1），广告单量 3');
{
  const h = new Array(24).fill(0); h[0] = 2; h[1] = 1; h[2] = 1;
  const r = adSplitForDay({ orders: 4, adUnits: 3, hours: h });
  console.log('  结果:', JSON.stringify(r.slice(0, 4)));
  check('合计 = 3', sum(r), 3);
  check('全是整数', isInt(r), true);
  check('不超过各小时订单数', r.every((v, i2) => v <= h[i2]), true);
}

console.log('\n【边界】无广告单 / 无订单 / 全天都是广告单');
{
  const h = new Array(24).fill(0); h[5] = 2;
  check('广告单量 0 → 全 0', sum(adSplitForDay({ orders: 2, adUnits: 0, hours: h })), 0);
  check('当天 0 单 → 全 0', sum(adSplitForDay({ orders: 0, adUnits: 3, hours: h })), 0);
  check('广告单量 = 总单 → 整份给出', JSON.stringify(adSplitForDay({ orders: 2, adUnits: 2, hours: h }).filter(v => v)), JSON.stringify([2]));
  check('字段缺失不崩', JSON.stringify(adSplitForDay({})), JSON.stringify(new Array(24).fill(0)));
  check('day 为 null 不崩', JSON.stringify(adSplitForDay(null)), JSON.stringify(new Array(24).fill(0)));
}

console.log('\n【稳定性】同样输入跑 200 次结果一致（不抖动）');
{
  const h = new Array(24).fill(0); h[0] = 2; h[1] = 1; h[2] = 1;
  const day = { orders: 4, adUnits: 3, hours: h };
  const first = JSON.stringify(adSplitForDay(day));
  let stable = true;
  for (let k = 0; k < 200; k++) if (JSON.stringify(adSplitForDay(day)) !== first) { stable = false; break; }
  check('结果稳定', stable, true);
}

console.log('\n【随机压力】1000 组随机输入：整数 + 守恒 + 不越界');
{
  let bad = 0;
  for (let k = 0; k < 1000; k++) {
    const hours = new Array(24).fill(0);
    let orders = 0;
    const n = 1 + Math.floor(Math.random() * 8);
    for (let j = 0; j < n; j++) { const hh = Math.floor(Math.random() * 24); const c = 1 + Math.floor(Math.random() * 5); hours[hh] += c; orders += c; }
    const adUnits = Math.floor(Math.random() * 10);
    const r = adSplitForDay({ orders, adUnits, hours });
    const cap = Math.min(adUnits, orders);
    if (!isInt(r) || sum(r) !== cap || !r.every((v, idx) => v <= hours[idx] && v >= 0)) {
      bad++; if (bad <= 3) console.log('   ✗ orders=' + orders + ' adUnits=' + adUnits + ' hours=' + JSON.stringify(hours.filter(v => v)) + ' got=' + JSON.stringify(r));
    }
  }
  check('1000 组全部合法', bad, 0);
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有 ' + fail + ' 项失败') + `（${pass} 通过 / ${fail} 失败）\n`);
process.exit(fail === 0 ? 0 : 1);
