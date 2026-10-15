#!/usr/bin/env node
/**
 * 大麦数据 MCP 命令行工具（逻辑在 dm-client.js，与 server.js 共用）
 *
 * 用法:
 *   node dm-mcp.js tools                        列出全部工具及参数
 *   node dm-mcp.js call <toolName> '<jsonArgs>'  调用某个工具
 *   node dm-mcp.js quota                         查额度（免费）
 *
 * 说明:
 *   - 免订阅（积分模式）账号按次扣积分；search_categories / get_my_quota_status 免费。
 *   - market_code: MLM=墨西哥 MLB=巴西 MLA=阿根廷 MLC=智利 MCO=哥伦比亚
 *   - keyword 只支持当地语言（MLB 葡萄牙语，其余西班牙语），不支持中文。
 *   - 沙箱里需: env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy node dm-mcp.js ...
 */
'use strict';
const { callTool, listTools, quota } = require('./dm-client');

function print(val) {
  console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
}

(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log('用法: node dm-mcp.js <tools|call|quota> [...]');
    return;
  }

  if (cmd === 'tools') {
    const tools = await listTools();
    console.log('工具数量: ' + tools.length + '\n');
    for (const t of tools) {
      console.log('■ ' + t.name);
      if (t.description) console.log('  ' + String(t.description).replace(/\s+/g, ' ').trim());
      const props = (t.inputSchema && t.inputSchema.properties) || {};
      const req = (t.inputSchema && t.inputSchema.required) || [];
      for (const k of Object.keys(props)) {
        const p = props[k] || {};
        let extra = p.type || '';
        if (p.enum) extra += ' enum[' + p.enum.join('|') + ']';
        if (p.default !== undefined) extra += ' default=' + JSON.stringify(p.default);
        console.log('   ' + (req.includes(k) ? '*' : ' ') + ' ' + k + ' (' + extra + ') '
          + String(p.description || '').replace(/\s+/g, ' ').trim());
      }
      console.log('');
    }
    return;
  }

  if (cmd === 'call') {
    if (!a1) throw new Error("用法: node dm-mcp.js call <toolName> '<jsonArgs>'");
    print(await callTool(a1, JSON.parse(a2 || '{}')));
    return;
  }

  if (cmd === 'quota') { print(await quota()); return; }

  throw new Error('未知子命令: ' + cmd);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
