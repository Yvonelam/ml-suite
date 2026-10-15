#!/usr/bin/env node
/**
 * ML Suite · 固定域名配置向导
 * 把公网地址从「每次重启都变的临时地址」换成「永久固定的自己的域名」。
 *
 * 使用前需要先在 Cloudflare 完成三步（见窗口内提示）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = __dirname;
const CFG = path.join(ROOT, 'tunnel-config.json');
const URL_FILE = path.join(ROOT, '公网地址.txt');

function load() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch { return { mode: 'quick', hostname: '', token: '' }; }
}
function save(o) { fs.writeFileSync(CFG, JSON.stringify(o, null, 2), 'utf8'); }

const line = '='.repeat(64);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

(async () => {
  const cur = load();

  console.log('\n' + line);
  console.log('  ML Suite · 配置固定公网地址');
  console.log(line);
  console.log('  当前模式：' + (String(cur.mode).toLowerCase() === 'named' ? '固定域名（' + (cur.hostname || '未填域名') + '）' : '临时随机地址'));
  console.log(line);
  console.log(`
  开始前，请先在电脑浏览器完成下面三步（都在 Cloudflare，免费）：

  【第 1 步】把域名接入 Cloudflare
      · 打开 https://dash.cloudflare.com → 添加站点 → 输入你的域名
      · 按提示到域名注册商处，把域名服务器（NS）改成 Cloudflare 给的两条
      · 等状态变成「有效」（通常几分钟到几小时）

  【第 2 步】创建隧道
      · 打开 https://one.dash.cloudflare.com → Networks → Tunnels → Create a tunnel
      · 类型选 Cloudflared，起个名字（如 ml-suite），保存
      · 在「Public Hostname」页签添加一条：
          Subdomain : 例如 ml
          Domain    : 选你的域名
          Type      : HTTP
          URL       : localhost:3000
      · 保存后，在安装页选择 Docker/其他方式，复制那串很长的 Token

  【第 3 步】把域名和 Token 填进来（就是下面这两行）
`);

  const host = await ask('  1) 你的完整访问地址（例如 ml.你的域名.com）：\n  > ');
  if (!host || !host.includes('.') || /\s/.test(host)) {
    console.log('\n  ❌ 地址格式不对，请形如 ml.example.com\n');
    rl.close(); process.exit(1);
  }
  const cleanHost = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  const token = await ask('\n  2) 粘贴 Cloudflare 隧道 Token（很长，以 ey 开头，粘贴后回车）：\n  > ');
  if (!token || token.length < 40) {
    console.log('\n  ❌ Token 看起来不对（长度不足），请重新复制完整 Token\n');
    rl.close(); process.exit(1);
  }

  save({ mode: 'named', hostname: cleanHost, token });
  try { fs.writeFileSync(URL_FILE, 'https://' + cleanHost + '/\n', 'utf8'); } catch (e) { }

  console.log('\n' + line);
  console.log('  ✅ 配置完成');
  console.log(line);
  console.log('  以后每次双击「启动公网服务.bat」，地址都会固定为：');
  console.log('     https://' + cleanHost);
  console.log('\n  想改回临时地址：把 tunnel-config.json 的 mode 改回 quick 即可。');
  console.log(line + '\n');

  rl.close();
})();
