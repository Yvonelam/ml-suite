'use strict';

/**
 * ML Suite · 发报调度决策（纯逻辑，可单独测试）
 *
 * 三个设计要点，都是冲着原来的 bug 去的：
 *
 * 1) 时区一律用 Intl + 显式 Asia/Shanghai，不依赖系统时区、也不手工加减偏移量。
 *    原来的写法 `now + (getTimezoneOffset() + 480) * 60000` 在系统时区是北京时确实是
 *    对的，但一旦机器时区被改、或跨夏令时，就容易出问题，且很难验证。
 *
 * 2) 判定条件从「小时==H 且 分钟==M」改成「今天已经过了计划时间、且今天还没发过 → 发」。
 *    原写法依赖 setInterval(60s) 恰好落在那一分钟里；只要事件循环被卡一下导致某次 tick
 *    跨过整分钟，当天就再也不会发。改成「过了就补」之后，错过一分钟也只是晚一分钟发。
 *
 * 3) 用 lastReportDate（北京日期）做「一天最多一封」去重，避免补发逻辑把邮件发重。
 */

const TZ = 'Asia/Shanghai';

// hourCycle: 'h23' 保证午夜输出 00 而不是 24
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const PART_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function pad(n) { return String(n).padStart(2, '0'); }

/** 北京日期 YYYY-MM-DD */
function beijingDate(d = new Date()) {
  return DATE_FMT.format(d);
}

/** 北京时间的 {hour, minute} */
function beijingHM(d = new Date()) {
  const parts = TIME_FMT.formatToParts(d);
  const get = (t) => Number(parts.find((x) => x.type === t).value);
  return { hour: get('hour'), minute: get('minute') };
}

/** 北京时间的 {date, hour, minute} */
function beijingParts(d = new Date()) {
  const { hour, minute } = beijingHM(d);
  return { date: beijingDate(d), hour, minute };
}

/** 北京时间可读标签 YYYY-MM-DD HH:mm */
function beijingLabel(d = new Date()) {
  const parts = PART_FMT.formatToParts(d);
  const get = (t) => parts.find((x) => x.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 日期字符串加减天数（按 UTC 计算，避免夏令时干扰） */
function addDays(dateStr, n) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d) + n * 86400000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * 此刻该不该发日报？
 *
 * @param {{scheduleEnabled?:boolean, scheduleHour?:number, scheduleMinute?:number}} cfg
 * @param {Date}   now             当前时间
 * @param {string} lastReportDate  最近一次成功发送的北京日期（YYYY-MM-DD）；空串表示从未发过
 * @returns {{fire:boolean, reason:string, date:string, hour:number, minute:number, scheduledAt:string}}
 *   reason 取值：
 *     'disabled'      定时未启用
 *     'invalid-time'  时间配置非法
 *     'not-yet'       今天还没到计划时间
 *     'already-sent'  今天已经发过了（去重）
 *     'on-time'       正好到点，发
 *     'catch-up'      已经过了计划时间且今天还没发 → 补发（含「错过整分钟」的场景）
 */
function decideReportFire(cfg, now, lastReportDate) {
  const p = beijingParts(now);
  const base = { fire: false, reason: '', date: p.date, hour: p.hour, minute: p.minute, scheduledAt: '' };

  if (!cfg || !cfg.scheduleEnabled) return Object.assign(base, { reason: 'disabled' });

  const h = Number(cfg.scheduleHour);
  const m = Number(cfg.scheduleMinute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return Object.assign(base, { reason: 'invalid-time' });
  }

  const scheduledAt = `${p.date} ${pad(h)}:${pad(m)}`;

  if (String(lastReportDate || '') === p.date) {
    return Object.assign(base, { reason: 'already-sent', scheduledAt });
  }

  const cur = p.hour * 60 + p.minute;
  const target = h * 60 + m;
  if (cur < target) return Object.assign(base, { reason: 'not-yet', scheduledAt });

  return Object.assign(base, { fire: true, reason: cur === target ? 'on-time' : 'catch-up', scheduledAt });
}

/**
 * 下次发送时间（北京时间可读串）；未启用或配置非法则返回 ''
 *
 * 注意「今天已发过」的情况：即使现在还没到计划时间，今天也不会再发了（去重），
 * 所以下次必然是明天 —— 否则界面上会显示一个永远不会发生的「今天 14:00」。
 */
function computeNextRun(cfg, now = new Date(), lastReportDate = '') {
  if (!cfg || !cfg.scheduleEnabled) return '';
  const h = Number(cfg.scheduleHour);
  const m = Number(cfg.scheduleMinute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return '';

  const p = beijingParts(now);
  const hhmm = `${pad(h)}:${pad(m)}`;
  const cur = p.hour * 60 + p.minute;
  const target = h * 60 + m;
  const sentToday = String(lastReportDate || '') === p.date;

  return (!sentToday && cur < target) ? `${p.date} ${hhmm}` : `${addDays(p.date, 1)} ${hhmm}`;
}

module.exports = {
  TZ,
  beijingDate,
  beijingHM,
  beijingParts,
  beijingLabel,
  addDays,
  decideReportFire,
  computeNextRun,
};
