'use strict';
/**
 * 大麦数据 MCP 客户端（server.js 与 dm-mcp.js 共用）
 *
 * 端点: https://mcp.damaishuju.com/tools/mcp  (Streamable HTTP, 鉴权走 X-API-Key 请求头)
 *
 * 两点必须注意：
 *  1) server.js 会给全局 fetch 挂 Clash 代理（给美客多用），而大麦是国内服务，
 *     这里改用 Node 原生 https 直连，天然绕过代理，也避免 undici 版本冲突
 *     （node_modules/undici v8 与 Node 内置 fetch 的 dispatcher 接口不兼容，
 *      会报 "invalid onRequestStart method"）。
 *  2) JSON-RPC 的业务数据在 result.content[].text 里，而且是「字符串形式的 JSON」，
 *     必须二次 JSON.parse。
 */
const https = require('https');

const DM_ENDPOINT = process.env.DM_MCP_ENDPOINT || 'https://mcp.damaishuju.com/tools/mcp';

// API Key 优先级：环境变量 DM_MCP_API_KEY → daily-search-config.json 的 dmApiKey。
// 注意：这里**不硬编码密钥**，避免源码被分享/提交时泄漏。
const DM_DEFAULT_KEY = (() => {
  if (process.env.DM_MCP_API_KEY) return process.env.DM_MCP_API_KEY;
  try {
    const p = require('path').join(__dirname, 'daily-search-config.json');
    return JSON.parse(require('fs').readFileSync(p, 'utf8')).dmApiKey || '';
  } catch (e) { return ''; }
})();
const DEFAULT_TIMEOUT = 60000;

function httpsPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('大麦 MCP 地址非法: ' + url)); }
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', (e) => reject(new Error('连接大麦 MCP 失败: ' + e.message)));
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT, () => {
      req.destroy(new Error('大麦 MCP 请求超时（' + ((timeoutMs || DEFAULT_TIMEOUT) / 1000) + 's）'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function parseBody(ct, text) {
  if (ct && ct.includes('text/event-stream')) {
    let out = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        const j = line.slice(5).trim();
        if (j && j !== '[DONE]') { try { out = JSON.parse(j); } catch (e) { } }
      }
    }
    return out;
  }
  try { return JSON.parse(text); } catch (e) { return { raw: text }; }
}

function makeSession(apiKey) {
  const key = apiKey || DM_DEFAULT_KEY;
  let sessionId = null;

  async function rpc(method, params, id) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'X-API-Key': key,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const payload = id == null
      ? { jsonrpc: '2.0', method, params: params || {} }
      : { jsonrpc: '2.0', id, method, params: params || {} };

    const res = await httpsPost(DM_ENDPOINT, headers, JSON.stringify(payload));
    const sid = res.headers['mcp-session-id'];
    if (sid) sessionId = sid;
    if (id == null) return null;                       // 通知类，无响应体
    if (res.status < 200 || res.status >= 300) {
      throw new Error('大麦 MCP HTTP ' + res.status + ': ' + String(res.text).slice(0, 300));
    }
    const json = parseBody(res.headers['content-type'] || '', res.text);
    if (json && json.error) throw new Error('大麦 MCP 错误: ' + JSON.stringify(json.error).slice(0, 300));
    return json;
  }

  async function handshake() {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ml-suite', version: '1.0.0' },
    }, 1);
    await rpc('notifications/initialized', {}, null);
  }

  return { rpc, handshake, apiKey: key };
}

// 取出 result.content[].text 并二次 JSON 解析
function extractResult(r) {
  const content = r && r.result && r.result.content;
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (c.type === 'text') {
      try { return JSON.parse(c.text); } catch (e) { return c.text; }
    }
  }
  return null;
}

/** 调用某个工具，返回已解析的业务数据 */
async function callTool(name, args, apiKey) {
  const s = makeSession(apiKey);
  await s.handshake();
  const r = await s.rpc('tools/call', { name, arguments: args || {} }, 2);
  if (r && r.result && r.result.isError) {
    const detail = extractResult(r);
    throw new Error('工具 ' + name + ' 返回错误: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300));
  }
  return extractResult(r);
}

/** 列出全部工具 */
async function listTools(apiKey) {
  const s = makeSession(apiKey);
  await s.handshake();
  const r = await s.rpc('tools/list', {}, 2);
  return (r && r.result && r.result.tools) || [];
}

/** 查额度（免费，不扣积分） */
async function quota(apiKey) {
  return callTool('get_my_quota_status', {}, apiKey);
}

module.exports = { callTool, listTools, quota, DM_ENDPOINT, DM_DEFAULT_KEY };
