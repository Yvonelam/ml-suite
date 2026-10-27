#!/usr/bin/env node
/**
 * 邮件链路一键体检：SMTP 端口通不通 / TLS 握得上不 / 授权码对不对 / 代理有没有把邮件带出国
 * 用法：node probe-mail-path.js
 *
 * 为什么要有它：2026-10-27 定时邮件连续失败 6 次，面板只显示
 *   "Client network socket disconnected before secure TLS connection was established"
 * ——这句话跟邮箱八竿子打不着，其实是 Clash 被切成「全局」模式，TUN 把国内 smtp.qq.com:465
 * 也送去机场节点，节点封了邮件端口。跑这个脚本 3 秒就能定位到底是哪一层断的。
 */
'use strict';
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0, warn = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + extra : '')); } };
const W = (label, extra) => { warn++; console.log('  ! ' + label + (extra !== undefined ? ' → ' + extra : '')); };

function readCfg() {
  const p = path.join(__dirname, 'daily-search-config.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function tlsProbe(host, port, timeoutMs) {
  return new Promise(res => {
    const t0 = Date.now();
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs || 8000 });
    let done = false;
    const fin = (ok2, info) => { if (done) return; done = true; try { s.destroy(); } catch (e) { } res({ ok: ok2, ms: Date.now() - t0, info }); };
    s.on('secureConnect', () => fin(true, 'TLS ' + s.getProtocol() + ' / ' + s.getCipher().name));
    s.on('timeout', () => fin(false, '超时'));
    s.on('error', e => fin(false, e.code + ' ' + e.message));
  });
}

// 从 Clash Verge 的运行时配置里找控制管道，读当前是「规则」还是「全局」
function clashMode() {
  return new Promise(res => {
    const cfgPath = path.join(process.env.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev', 'config.yaml');
    if (!fs.existsSync(cfgPath)) return res(null);
    let txt = '';
    try { txt = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { return res(null); }
    const pipeLine = (txt.match(/external-controller-pipe:\s*(\S+)/) || [])[1];
    const secret = (txt.match(/^secret:\s*(\S+)/m) || [])[1] || '';
    if (!pipeLine) return res(null);
    // YAML 里写的就是 \\.\pipe\xxx（反斜杠是字面量），照抄即可，千万别再转义
    const pipe = pipeLine.replace(/^"|"$/g, '');
    const s = net.connect(pipe);
    let buf = '', done = false;
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch (e) { } res(v); };
    s.on('connect', () => s.write(`GET /configs HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${secret}\r\nConnection: close\r\n\r\n`));
    s.on('data', d => buf += d.toString('utf8'));
    s.on('end', () => {
      const i = buf.indexOf('\r\n\r\n');
      try {
        const j = JSON.parse(buf.slice(i + 4));
        fin({ mode: j.mode, tun: !!(j.tun && j.tun.enable) });
      } catch (e) { fin(null); }
    });
    s.on('error', () => fin(null));
    s.setTimeout(4000, () => fin(null));
  });
}

// 全局模式下「所有流量」走 GLOBAL 组里选中的那个节点——邮件能不能发，完全取决于那个节点
// 封不封 465/587。实测（2026-10-27，34 个节点里抽样的 6 个）：
//   美国西雅图2 / 香港精品2 / 英国 / 法国 → 封；日本[CM] / 德国 → 通。
function globalNode() {
  return new Promise(res => {
    const cfgPath = path.join(process.env.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev', 'config.yaml');
    if (!fs.existsSync(cfgPath)) return res(null);
    let txt = '';
    try { txt = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { return res(null); }
    const pipeLine = (txt.match(/external-controller-pipe:\s*(\S+)/) || [])[1];
    const secret = (txt.match(/^secret:\s*(\S+)/m) || [])[1] || '';
    if (!pipeLine) return res(null);
    const pipe = pipeLine.replace(/^"|"$/g, '');
    const s = net.connect(pipe);
    let chunk = [], done = false;
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch (e) { } res(v); };
    s.on('connect', () => s.write(`GET /proxies/GLOBAL HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${secret}\r\nConnection: close\r\n\r\n`));
    s.on('data', d => chunk.push(d));
    s.on('end', () => {
      const buf = Buffer.concat(chunk);
      const i = buf.indexOf('\r\n\r\n');
      try { fin(JSON.parse(buf.slice(i + 4).toString('utf8')).now || null); } catch (e) { fin(null); }
    });
    s.on('error', () => fin(null));
    s.setTimeout(4000, () => fin(null));
  });
}

(async () => {
  const cfg = readCfg();
  console.log('\n=== 1. 邮箱配置 ===');
  ok(!!cfg, '读到 daily-search-config.json');
  if (!cfg) { console.log('\n配置都读不到，后面的检查没意义'); process.exit(1); }
  const host = cfg.smtpHost || 'smtp.qq.com';
  const port = Number(cfg.smtpPort) || 465;
  const user = cfg.smtpUser || '';
  const to = cfg.email || '';
  ok(!!user, 'SMTP 账号已填（' + user + '）');
  ok(!!cfg.smtpPass, 'SMTP 授权码已填（' + (cfg.smtpPass ? cfg.smtpPass.length + ' 位' : '空') + '）');
  ok(!!to, '收件邮箱已填（' + to + '）');
  ok(!!cfg.scheduleEnabled, '定时发送已开启', cfg.scheduleEnabled ? undefined : '面板里没打开，不会自动发');

  console.log('\n=== 2. 代理有没有插手（Clash） ===');
  const cm = await clashMode();
  let node = null;
  if (!cm) { W('读不到 Clash 状态（没装 Clash Verge，或控制管道变了）'); }
  else if (cm.mode === 'global') {
    node = await globalNode();
    W('Clash 是「全局」模式 —— 所有流量（含国内邮箱、国内 API）都走 ' + (node || 'GLOBAL 组选中的节点'));
    console.log('    → 全局模式本身没问题，但邮件能不能发**完全取决于这个节点**是否封 465/587。');
    console.log('      实测封端口：美国西雅图2 / 香港精品2 / 英国 / 法国；能发：日本[CM] / 德国。');
    console.log('      下面第 3 步的结果说了算。');
  } else {
    ok(true, 'Clash 模式 = ' + cm.mode + (cm.tun ? '（TUN 开启）' : '（TUN 关闭）'));
  }

  console.log('\n=== 3. SMTP 端口与 TLS 握手 ===');
  const r = await tlsProbe(host, port);
  ok(r.ok, 'TLS 连 ' + host + ':' + port + '（' + r.ms + 'ms）', r.info);
  if (!r.ok) {
    const r587 = port === 587 ? null : await tlsProbe(host, 587);
    if (r587 && r587.ok) {
      W('但 587 端口是通的（' + r587.ms + 'ms）→ 把「SMTP 端口」改成 587（STARTTLS）就能发', undefined);
    } else if (r587) {
      console.log('    587 也不通（' + r587.info + '）');
      if (cm && cm.mode === 'global') {
        console.log('    → 全局模式下就是这个节点封了邮件端口。要么在 Clash 里把 GLOBAL 组换成日本/德国节点，要么切回「规则」模式。');
      } else {
        console.log('    → 规则模式下还这样，说明直连也被拦（防火墙/运营商），试试把 Clash 切到全局再换个不封 SMTP 的节点。');
      }
    }
  }

  console.log('\n=== 4. 登录握手（不真的发信） ===');
  if (r.ok && user && cfg.smtpPass) {
    let nodemailer = null;
    try { nodemailer = require('nodemailer'); } catch (e) { W('没装 nodemailer，跳过'); }
    if (nodemailer) {
      const t = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass: cfg.smtpPass } });
      try {
        await t.verify();
        ok(true, 'SMTP 认证通过（账号、授权码都没问题）');
      } catch (e) {
        ok(false, 'SMTP 认证失败', e.code ? e.code + ' ' + e.message : e.message);
      }
    }
  } else {
    W('前置条件不满足，跳过登录测试');
  }

  console.log('\n--- 结果 ---');
  console.log(pass + ' 通过 / ' + fail + ' 失败 / ' + warn + ' 提醒');
  if (fail) {
    console.log('\n下一步：');
    if (cm && cm.mode === 'global') console.log('  · 先把 Clash 从「全局」切回「规则」，再跑一次本脚本');
    if (!r.ok) console.log('  · 还不行就把 SMTP 端口从 465 换成 587（STARTTLS）');
    console.log('  · 仍然不通：临时关掉 Clash 的 TUN 模式，单独验证一次是不是代理的问题');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩了：' + e.message); process.exit(1); });
