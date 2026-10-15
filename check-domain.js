#!/usr/bin/env node
/**
 * ML Suite · 域名接入进度自查
 * 一键确认你的固定域名走到哪一步了：域名服务器改没改、Cloudflare 激活没有、隧道通没通。
 *
 * 用法：node check-domain.js [域名]
 *   不带参数时读取 tunnel-config.json 的 hostname（例如 ml.yvonework.website）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = path.join(ROOT, 'tunnel-config.json');

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return {}; }
}

const cfg = loadCfg();
let target = process.argv[2]
  || (cfg.hostname ? String(cfg.hostname).replace(/^https?:\/\//, '').replace(/\/+$/, '') : '')
  || 'yvonework.website';

// 去掉可能的子域名，拿主域名去查 NS
function apexOf(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoLevel = ['com.cn', 'net.cn', 'org.cn', 'co.uk', 'com.br', 'com.mx', 'co.jp'];
  const last2 = parts.slice(-2).join('.');
  if (twoLevel.includes(last2)) return parts.slice(-3).join('.');
  return last2;
}
const apex = apexOf(target);

async function doh(name, type) {
  const url = 'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=' + type;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    return (j.Answer || []).map(a => a.data);
  } catch (e) {
    return null;
  }
}

const line = '='.repeat(64);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

(async () => {
  console.log('\n' + line);
  console.log('  ML Suite · 固定域名接入进度自查');
  console.log(line);
  console.log('  主域名   : ' + apex);
  console.log('  访问地址 : https://' + target);
  console.log(line + '\n');

  // ---- 1. 域名服务器 ----
  const ns = await doh(apex, 'NS');
  if (ns === null) {
    console.log('  [1/4] 域名服务器 ...... 查询失败（网络或代理异常，请稍后重试）');
    process.exitCode = 1;
    return;
  }
  const nsList = ns.map(s => s.replace(/\.$/, '').toLowerCase());
  const isCloudflare = nsList.some(n => n.endsWith('.ns.cloudflare.com'));
  const isDnspod = nsList.some(n => n.includes('dnspod'));

  if (isCloudflare) {
    console.log('  [1/4] 域名服务器 ...... ✅ 已指向 Cloudflare');
    nsList.forEach(n => console.log('          · ' + n));
  } else if (isDnspod) {
    console.log('  [1/4] 域名服务器 ...... ❌ 仍指向 DNSPod（腾讯云）');
    nsList.forEach(n => console.log('          · ' + n));
    console.log('\n  → 需要做：去腾讯云 / DNSPod 后台把 DNS 服务器改成 Cloudflare 给的两条\n');
  } else {
    console.log('  [1/4] 域名服务器 ...... ⚠️  第三方：' + nsList.join(', '));
    console.log('\n  → 需要做：把 DNS 服务器改成 Cloudflare 给的两条\n');
  }

  if (!isCloudflare) {
    console.log(line);
    console.log('  当前进度：第 1 步未完成 —— 先把域名接入 Cloudflare 并改 DNS 服务器');
    console.log(line + '\n');
    return;
  }

  // ---- 2. 解析记录 ----
  const a = await doh(target, 'A');
  const cname = await doh(target, 'CNAME');
  const hasRecord = (a && a.length) || (cname && cname.length);
  if (hasRecord) {
    console.log('  [2/4] 解析记录 ........ ✅ 已存在');
    (cname || []).forEach(v => console.log('          · CNAME → ' + v));
    (a || []).forEach(v => console.log('          · A     → ' + v));
  } else {
    console.log('  [2/4] 解析记录 ........ ❌ 还没有 ' + target + ' 的解析记录');
    console.log('\n  → 需要做：在 Cloudflare 隧道里添加 Public Hostname：');
    console.log('           Subdomain = ' + target.split('.')[0] + '   Domain = ' + apex);
    console.log('           Type = HTTP   URL = localhost:3000\n');
  }

  // ---- 3. 访问连通性 ----
  if (hasRecord) {
    try {
      const r = await fetch('https://' + target + '/', { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      console.log('  [3/4] 公网访问 ........ ✅ 返回 HTTP ' + r.status + (r.status === 200 ? '（正常）' : ''));
    } catch (e) {
      console.log('  [3/4] 公网访问 ........ ⚠️  暂时打不开：' + e.message);
      console.log('          常见原因：隧道没在本机运行 / DNS 刚改完还没生效');
    }
  } else {
    console.log('  [3/4] 公网访问 ........ ⏸  跳过（解析记录还没有）');
  }

  // ---- 4. 本机隧道 ----
  const tcfg = loadCfg();
  const named = String(tcfg.mode).toLowerCase() === 'named' && tcfg.token;
  console.log('  [4/4] 本机隧道模式 .... ' + (named ? '✅ 固定域名模式（已配置 Token）' : '临时模式（quick）'));

  console.log('\n' + line);
  if (isCloudflare && hasRecord) {
    console.log('  看起来已经通了。若访问不了，双击「启动公网服务.bat」把隧道跑起来。');
  } else if (isCloudflare && !hasRecord) {
    console.log('  进度：第 2 步 —— 去 Cloudflare 建隧道并添加 Public Hostname');
  } else {
    console.log('  进度：第 1 步 —— 把域名接入 Cloudflare，并去注册商改 DNS 服务器');
  }
  console.log(line + '\n');
})();
