'use strict';
/* 微信提醒（PushPlus）的正文渲染。
 *
 * 单独抽成一个模块的原因：渲染逻辑是纯函数，抽出来才能在探针里直接喂数据断言，
 * 不用起整个 server、也不用真的往微信发一条消息去看长什么样。
 *
 * 这里最要紧的一条业务规则：**已经被关键词规则自动回复掉的提问，推送里必须显眼地说
 * 「已自动回复 · 无需处理」**。否则用户收到「新提问 3 条」跑去后台，发现机器人早回完了，
 * 白跑一趟 —— 推送的价值会被这种噪音磨掉。
 */

// 消息正文里会拼商品标题和买家原文，必须转义
function escPush(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const COLOR_AUTO = '#0f8a5f';   // 已自动回复：绿
const COLOR_LINK = '#3b82f6';

function autoBadge() {
  return '<span style="display:inline-block;background:#e8f8f0;color:' + COLOR_AUTO + ';'
    + 'border:1px solid #b7e6d1;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700;line-height:1.6">'
    + '✅ 已自动回复</span>';
}

/**
 * @param {Array} list 每条 { id, text, time, itemTitle, permalink, autoReplied? { atText, ruleLabel } }
 * @param {string} siteName
 * @returns {string} PushPlus html 正文
 */
function questionPushHtml(list, siteName) {
  const items = Array.isArray(list) ? list : [];
  const autoCount = items.filter(q => q && q.autoReplied).length;
  const allAuto = items.length > 0 && autoCount === items.length;

  const head = [];
  head.push(`<div style="font-size:13px;color:#888;margin-bottom:8px">${escPush(siteName || '')} · 共 ${items.length} 条新提问</div>`);
  if (allAuto) {
    head.push('<div style="background:#eefaf4;border-left:3px solid ' + COLOR_AUTO + ';color:' + COLOR_AUTO + ';'
      + 'font-size:13px;line-height:1.65;padding:9px 12px;margin-bottom:6px">'
      + '这 ' + items.length + ' 条<b>已全部由关键词规则自动回复</b>，<b>不用再去处理</b>，当条存档看一眼就行。</div>');
  } else if (autoCount > 0) {
    head.push('<div style="background:#eefaf4;border-left:3px solid ' + COLOR_AUTO + ';color:' + COLOR_AUTO + ';'
      + 'font-size:13px;line-height:1.65;padding:9px 12px;margin-bottom:6px">'
      + '其中 <b>' + autoCount + ' 条已自动回复</b>（下面标绿的），<b>无需处理</b>；没标的才要你去回。</div>');
  }

  const body = items.map(q => {
    const item = q || {};
    const auto = item.autoReplied;
    const seg = [];
    seg.push('<div style="padding:12px 0;border-bottom:1px dashed #e0e0e0">');
    if (item.itemTitle) seg.push(`<div style="color:#888;font-size:12px;line-height:1.5">${escPush(item.itemTitle)}</div>`);
    seg.push(`<div style="font-size:15px;font-weight:600;color:#111;margin:7px 0;line-height:1.6">${escPush(item.text)}</div>`);
    seg.push(`<div style="color:#999;font-size:12px">#${escPush(item.id)} · ${escPush(item.time)}（巴西时间）</div>`);
    if (auto) {
      seg.push('<div style="margin-top:9px">' + autoBadge()
        + '<span style="color:' + COLOR_AUTO + ';font-size:12px;font-weight:600;margin-left:8px">无需处理</span></div>');
      const who = auto.ruleLabel ? '（规则：' + escPush(auto.ruleLabel) + '）' : '';
      const when = auto.atText ? '已于 ' + escPush(auto.atText) + ' ' : '';
      seg.push(`<div style="color:${COLOR_AUTO};font-size:12px;margin-top:6px;line-height:1.6">${when}自动回复${who}，先不用管这一条。</div>`);
      if (item.permalink) seg.push(`<div style="margin-top:8px"><a href="${escPush(item.permalink)}" style="color:${COLOR_LINK}">👉 打开商品页查看</a></div>`);
    } else {
      if (item.permalink) seg.push(`<div style="margin-top:8px"><a href="${escPush(item.permalink)}" style="color:${COLOR_LINK}">👉 打开商品页去回复</a></div>`);
    }
    seg.push('</div>');
    return seg.join('');
  }).join('');

  return head.join('') + body;
}

/** 推送标题：全自动回复时改成「已自动回复」，让人一眼知道不用点 */
function questionPushTitle(list, siteName) {
  const items = Array.isArray(list) ? list : [];
  const n = items.length;
  const autoCount = items.filter(q => q && q.autoReplied).length;
  const site = siteName ? ' · ' + siteName : '';
  if (n > 0 && autoCount === n) return `🤖 售前已自动回复 ${n} 条${site}（无需处理）`;
  if (autoCount > 0) return `🛒 美客多新提问 ${n} 条（${autoCount} 条已自动回复）${site}`;
  return `🛒 美客多新提问 ${n} 条${site}`;
}

module.exports = { escPush, questionPushHtml, questionPushTitle };
