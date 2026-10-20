'use strict';

const MAX_RULES = 50;
const MAX_KEYWORDS_PER_RULE = 20;
const MAX_KEYWORD_LENGTH = 80;
const MAX_REPLY_LENGTH = 2000;

function normalizeMatchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
}

function sanitizeRules(input, makeId) {
  if (!Array.isArray(input)) throw new Error('回复规则格式无效');
  if (input.length > MAX_RULES) throw new Error('最多保存 50 条回复规则');
  const generateId = typeof makeId === 'function'
    ? makeId
    : (() => 'rule-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const ids = new Set();
  return input.map((raw, index) => {
    const row = raw && typeof raw === 'object' ? raw : {};
    const values = Array.isArray(row.keywords)
      ? row.keywords
      : String(row.keywords || '').split(/[,，;；\n]/);
    const keywords = [];
    const normalized = new Set();
    for (const value of values) {
      const keyword = String(value == null ? '' : value).trim();
      if (!keyword) continue;
      if (keyword.length > MAX_KEYWORD_LENGTH) throw new Error('第 ' + (index + 1) + ' 条规则的单个关键词不能超过 80 个字符');
      const matchKey = normalizeMatchText(keyword);
      if (!normalized.has(matchKey)) { normalized.add(matchKey); keywords.push(keyword); }
      if (keywords.length > MAX_KEYWORDS_PER_RULE) throw new Error('每条规则最多填写 20 个关键词');
    }
    const reply = String(row.reply == null ? '' : row.reply).trim();
    if (!keywords.length) throw new Error('第 ' + (index + 1) + ' 条规则至少填写一个关键词');
    if (!reply) throw new Error('第 ' + (index + 1) + ' 条规则的回复文本不能为空');
    if (reply.length > MAX_REPLY_LENGTH) throw new Error('第 ' + (index + 1) + ' 条回复不能超过 2000 个字符');
    let id = String(row.id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) id = String(generateId());
    while (ids.has(id)) id = String(generateId());
    ids.add(id);
    return { id, keywords, reply, enabled: row.enabled === true };
  });
}

function matchRule(questionText, rules) {
  const text = normalizeMatchText(questionText);
  if (!text) return null;
  for (const rule of (Array.isArray(rules) ? rules : [])) {
    if (!rule || rule.enabled !== true) continue;
    if ((rule.keywords || []).some(keyword => {
      const term = normalizeMatchText(keyword).trim();
      return term && text.includes(term);
    })) return rule;
  }
  return null;
}

function keepRecentIds(value, max = 2000) {
  const list = Array.isArray(value) ? value : [];
  const ids = new Set();
  for (const value of list) {
    const id = String(value || '');
    if (!id) continue;
    ids.delete(id);
    ids.add(id);
  }
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  return limit ? [...ids].slice(-limit) : [];
}

module.exports = { MAX_RULES, MAX_KEYWORDS_PER_RULE, MAX_KEYWORD_LENGTH, MAX_REPLY_LENGTH, normalizeMatchText, sanitizeRules, matchRule, keepRecentIds };
