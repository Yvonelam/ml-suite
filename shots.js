#!/usr/bin/env node
/**
 * ML Suite · 把当前界面截成一堆图，方便交给外部 AI 看现状
 *
 * 为什么需要：改版任务里，AI 光读 CSS 是「看不见」的 —— 它不知道现在长什么样、
 * 哪块挤、哪块松。给它几张现状截图，改版命中率会高很多。
 *
 * 做法：起一个无头 Chrome，用 CDP 把主工作台的 7 个视图逐个截图，输出到 shots/ 目录
 * （该目录已被 .gitignore 排除）。最后顺带做一次「旧链接」跳转自检。
 *
 * 关于 /search/ 和 /boxmark/：那两个独立页**已退役**，HTML 顶部就一行
 * `location.replace('../index.html#rank|#box')`，打开就跳回工作台对应视图，
 * 所以它们没有自己的界面可截 —— 只做自检，不截图。
 *
 * 用法：
 *   node shots.js               截图全部视图
 *   node shots.js hub ads       只截指定视图
 *   node shots.js --clean       先清空旧的 ui-*.png 再截
 *
 * 前置：本地服务必须在跑（默认 127.0.0.1:3000）。
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'shots');
const PORT = 9351;
const HOST = 'http://127.0.0.1:' + (process.env.PORT || 3000);
const W = 1440;
const H = 1000;
const SCALE = 1.5;      // 放大输出，AI 看得清细节
const SETTLE = 1700;    // 切视图后等数据加载
const MAX_H = 7000;

// 无头浏览器：优先 Chrome，退到 Edge（Windows 上基本总有一个）
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

function findBrowser() {
  for (const p of BROWSERS) { try { if (fs.existsSync(p)) return p; } catch (e) { /* 下一个 */ } }
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => {
    let d = '';
    r.on('data', (c) => (d += c));
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

// 主工作台的视图（hash 路由，见 public/app.js 的 TT 表）
const VIEWS = [
  { key: 'hub', name: '01-概览' },
  { key: 'rank', name: '02-关键词排名' },
  { key: 'orders', name: '03-订单管理' },
  { key: 'questions', name: '04-商品问答' },
  { key: 'claims', name: '05-退货与投诉' },
  { key: 'ads', name: '06-广告投放' },
  { key: 'box', name: '07-箱唛裁切' },
];

// 旧链接自检：/search/ 和 /boxmark/ 这两个独立页**已退役** ——
// 它们的 HTML 顶部写了一行 `location.replace('../index.html#rank|#box')`，
// 打开就跳回工作台对应视图。所以它们没有「自己的界面」可截，只做一次跳转自检。
const LEGACY = [
  { url: HOST + '/search/', expectHash: '#rank', label: '/search/  →  应为 #rank' },
  { url: HOST + '/boxmark/', expectHash: '#box', label: '/boxmark/  →  应为 #box' },
];

async function main() {
  const argv = process.argv.slice(2);
  const browser = findBrowser();
  if (!browser) {
    console.log('\n  ⚠ 没找到 Chrome 或 Edge，跳过截图。\n');
    return 1;
  }

  // 服务在不在？
  try {
    await getJson(HOST + '/api/config');
  } catch (e) {
    console.log('\n  ⚠ 本地服务没在跑（' + HOST + ' 连不上），先启动服务再截图。\n');
    return 1;
  }

  fs.mkdirSync(OUT, { recursive: true });
  if (argv.includes('--clean')) {
    fs.readdirSync(OUT).filter((f) => /^ui-/.test(f)).forEach((f) => {
      try { fs.unlinkSync(path.join(OUT, f)); } catch (e) { /* 忽略 */ }
    });
  }

  const want = argv.filter((a) => !a.startsWith('--'));
  const views = want.length ? VIEWS.filter((v) => want.includes(v.key)) : VIEWS;

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-shots-'));
  const child = spawn(browser, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--no-proxy-server',
    '--hide-scrollbars', '--mute-audio', '--disable-extensions',
    '--window-size=' + W + ',' + H, '--user-data-dir=' + userDir, 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  let msgId = 0;
  const pending = new Map();

  const send = (method, params = {}) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, 30000);
    });
  };
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval 出错');
    return r.result.value;
  };

  try {
    // 等 Chrome 的调试端口起来
    let target = null;
    for (let i = 0; i < 80; i++) {
      try {
        const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* 还没起来 */ }
      await sleep(250);
    }
    if (!target) throw new Error('Chrome 调试端口没起来');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });

    const shoot = async (file) => {
      const m = await send('Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize || { width: W, height: H };
      const height = Math.min(Math.max(H, Math.ceil(cs.height) + 24), MAX_H);
      const r = await send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: W, height, scale: SCALE },
      });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log('    ✓ ' + path.basename(file) + '  (' + W + '×' + height + ', ' + kb + ' KB)');
    };

    console.log('\n  正在截图（无头 ' + path.basename(browser) + '）…\n');

    // 导航 + 确认真的跳过去了。
    // 只发 Page.navigate 是不够的：导航可能被吞掉/被中断，结果拍到的是上一个页面，
    // 而且不同页面还会拍出一模一样的图，不校验根本发现不了。
    // 这里用「页面标题」做落地判据（三个页面标题各不相同），失败时把实际地址打出来。
    const gotoPage = async (url, expectTitle) => {
      let href = '';
      let title = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await send('Page.navigate', { url: url }); } catch (e) { /* 下一轮重试 */ }
        for (let i = 0; i < 40; i++) {
          await sleep(300);
          try {
            const o = JSON.parse(await evaluate("JSON.stringify({h:location.href,t:document.title})"));
            href = o.h; title = o.t;
          } catch (e) { continue; }
          if ((title || '').indexOf(expectTitle) >= 0) return true;
        }
      }
      console.log('    ⚠ 页面没到位：期望标题含「' + expectTitle + '」，');
      console.log('      实际是「' + title + '」@ ' + href);
      return false;
    };

    // 页面有个 #splash 启动动画（position:fixed 的黑色覆盖层，会等三个站点连接自检跑完才退场）。
    // 它铺满整个视口，只要没退场，截图拍到的就全是它。所以每次导航后都必须确认它已经消失。
    const dismissSplash = async () => {
      const probe = "(()=>{const s=document.getElementById('splash');return !s||s.classList.contains('leave');})()";
      for (let i = 0; i < 40; i++) {
        let done = false;
        try { done = await evaluate(probe); } catch (e) { done = true; }
        if (done) break;
        await sleep(500);
      }
      try {
        await evaluate("(()=>{const s=document.getElementById('splash');if(s){s.classList.add('leave');s.style.setProperty('display','none','important');}return 1;})()");
      } catch (e) { /* 没有就算了 */ }
    };

    // 主工作台：先打开一次，再切 hash
    await gotoPage(HOST + '/#hub', 'ML Suite');
    await dismissSplash();
    await sleep(SETTLE);

    for (const v of views) {
      await evaluate("location.hash = '#" + v.key + "'");
      await sleep(SETTLE);
      await shoot(path.join(OUT, 'ui-' + v.name + '.png'));
    }

    // 旧链接自检（不截图，只确认跳转是否正常）
    console.log('\n  【旧链接自检】');
    for (const l of LEGACY) {
      try { await send('Page.navigate', { url: l.url }); } catch (e) { /* 忽略 */ }
      await sleep(1800);
      let href = '';
      try { href = await evaluate('location.href'); } catch (e) { /* 忽略 */ }
      const ok = href.indexOf(l.expectHash) >= 0;
      console.log('    ' + (ok ? '✓' : '⚠') + ' ' + l.label + '   实际：' + (href || '(读不到)'));
    }

    console.log('\n  完成，图片在：' + OUT);
    console.log('  → 把这些 PNG 一起上传给 AI，它才知道现在长什么样。\n');
    return 0;
  } catch (e) {
    console.log('\n  ⚠ 截图失败：' + e.message + '\n');
    return 1;
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* 忽略 */ }
    try { child.kill(); } catch (e) { /* 忽略 */ }
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('\n  截图异常：' + e.message + '\n');
  process.exit(1);
});
