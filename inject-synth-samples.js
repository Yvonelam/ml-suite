'use strict';
/* 合成 2026-10-13 全天采样（模拟已采满），验证「累计曲线 → 真实小时花费 → 定档」全链路 */
const fs = require('fs');
const path = require('path');
const OFF = -240; // 账号本地 GMT-4
const acctHourStart = (d, h) => Date.parse(d + 'T00:00:00Z') + h * 3600000 - OFF * 60000;

const date = '2026-10-13';
// 造一个真实的日内形态权重（夜低、午后到晚上高）
const w = [1, 1, 0.5, 0.5, 1, 1.5, 2.5, 4, 3, 5, 6.5, 5, 6, 8, 7.5, 6, 6.5, 5.5, 7, 6, 5, 4, 2, 1.5];
const sum = w.reduce((a, b) => a + b, 0);
const TOTAL = 468.00;
let cum = 0;
const arr = [];
for (let h = 0; h <= 24; h++) {
  arr.push({ t: acctHourStart(date, h), c: Math.round(cum * 100) / 100 });
  if (h < 24) cum += TOTAL * w[h] / sum;
}
// 每个小时内部再插一个中间采样，模拟 5 分钟级采样
const mid = [];
for (let i = 0; i < arr.length - 1; i++) {
  mid.push(arr[i]);
  mid.push({ t: Math.round((arr[i].t + arr[i + 1].t) / 2), c: Math.round((arr[i].c + arr[i + 1].c) / 2 * 100) / 100 });
}
mid.push(arr[arr.length - 1]);

const p = path.join(__dirname, 'ads-cost-samples.json');
const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
cur[date] = mid;
fs.writeFileSync(p, JSON.stringify(cur), 'utf8');
console.log('已注入合成采样', date, '点数=', mid.length, ' 终点累计=', mid[mid.length - 1].c);
console.log('预期小时花费(前8小时)=', w.slice(0, 8).map(x => (TOTAL * x / sum).toFixed(2)).join(', '));
