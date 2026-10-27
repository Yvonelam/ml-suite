#!/usr/bin/env node
/**
 * 浏览器实测：箱唛裁切「最后一页被切碎」——逐页输出掩膜密度 / 切分块数 / 块尺寸
 * 用法：node probe-boxmark-lastpage.js [pdf路径]
 * 默认用 2026.11.4 那批的 14 页外箱标（就是用户截图里 14 页 / 最后一页 25 块的那份）
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9389;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));
const PDF = process.argv[2] || 'E:/Works-WZ/Seller/BR/发货/2026.11.4 美客多上门取件 210南美森/外箱标 Envio-80335786-Etiquetas-do-volumes.pdf';

const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(p => { try { return p && fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
function login() {
  const body = Buffer.from(JSON.stringify({ username: dev.username, password: dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}

let pass = 0, fail = 0;
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 500) : '')); } };

(async () => {
  if (!fs.existsSync(PDF)) { console.log('找不到 PDF：' + PDF); process.exit(1); }
  const bytes = fs.readFileSync(PDF);
  const b64 = bytes.toString('base64');
  console.log('源文件：' + PDF + '（' + (bytes.length / 1024).toFixed(0) + ' KB）\n');

  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-box-'));
  const outDir = path.join(__dirname, 'probe-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { }
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1440,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map();
  const errors = [];
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };

  try {
    let t = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG + '/json/list'); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) { } await sleep(250); }
    if (!t) throw new Error('浏览器没起来');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push('[' + m.params.type + '] ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    for (let i = 0; i < 60; i++) { if (await ev('typeof analyzePdf === "function" && typeof boxState === "object"')) break; await sleep(200); }

    // 把 PDF 灌进去，跑真实的 analyzePdf 流程（跟用户点上传走的是同一条路）
    await ev(`window.__b64 = ${JSON.stringify(b64)}; true`);
    const info = await ev(`(async () => {
      const bin = atob(window.__b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      boxState.srcBytes = u8.buffer;
      boxState.fileName = 'probe.pdf';
      boxState.mode = 'auto'; boxState.gapAuto = true;
      boxState.params.gapMm = 3; boxState.params.minSizeMm = 8;
      // 每页的阈值都是 buildMask 现算的，包一层把值留下来（analyzePdf 结尾就 destroy 了，没法再取）
      window.__thr = [];
      const orig = window.computeThreshold;
      window.computeThreshold = function (img) {
        const v = orig(img);
        const { width: W, height: H, data } = img;
        const lumAt = (x, y) => { const i = (y * W + x) * 4; const a = data[i + 3]; return a < 24 ? 255 : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
        // 整页墨迹占比（按同一个阈值判），跟掩膜密度对照
        let ink = 0, n = 0;
        for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) { n++; if (lumAt(x, y) < v) ink++; }
        window.__thr.push({ w: W, h: H, thr: v, inkPct: +(ink / n * 100).toFixed(2) });
        return v;
      };
      const t0 = performance.now();
      await analyzePdf();
      window.computeThreshold = orig;
      return { ms: Math.round(performance.now() - t0), pages: boxState.pages.length, gap: boxState.params.gapMm };
    })()`);
    console.log('analyzePdf 完成：' + info.pages + ' 页 / ' + info.ms + ' ms / 自动间距 = ' + info.gap + ' mm\n');

    const stats = await ev(`(() => {
      return boxState.pages.map(p => {
        let ink = 0; const total = p.maskW * p.maskH;
        for (let i = 0; i < p.mask.length; i++) ink += p.mask[i];
        return {
          num: p.num, failed: !!p.failed,
          maskW: p.maskW, maskH: p.maskH,
          inkPct: +(ink / total * 100).toFixed(2),
          maskScale: +p.maskScale.toFixed(4),
          boxes: p.boxes.length,
          sizes: p.boxes.map(b => [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)])
        };
      });
    })()`);

    console.log('页  掩膜          墨迹%   箱唛数  尺寸(pt)');
    for (const s of stats) {
      const head = String(s.num).padStart(2) + '  ' + (s.maskW + 'x' + s.maskH).padEnd(11) + (s.inkPct + '%').padEnd(7) + String(s.boxes).padStart(4) + '   ';
      const sz = s.sizes.slice(0, 6).map(a => a[2] + 'x' + a[3]).join(' ');
      console.log(head + sz + (s.sizes.length > 6 ? ' …' : ''));
    }
    console.log('');

    const bad = stats.filter(s => s.boxes !== stats[0].boxes);
    ok(stats.length === 14, '读出 14 页');
    ok(!stats.some(s => s.failed), '没有渲染失败的页', stats.filter(s => s.failed).map(s => s.num));
    ok(stats.every(s => s.boxes === 3), '每页都切出 3 个箱唛（用户预期）', bad.map(s => 'p' + s.num + '=' + s.boxes));

    // 把有问题的页和正常页都存成缩略图，肉眼对一下
    const shots = await ev(`(() => {
      const out = {};
      for (const n of [1, 13, 14]) {
        const p = boxState.pages.find(x => x.num === n);
        if (p && p.thumb) out[n] = p.thumb.toDataURL('image/png');
      }
      return out;
    })()`);
    for (const n of Object.keys(shots)) {
      const f = path.join(outDir, 'boxmark-p' + n + '.png');
      fs.writeFileSync(f, Buffer.from(shots[n].split(',')[1], 'base64'));
      console.log('  已存 ' + f);
    }

    // 把掩膜导出来，离线复算切分过程（浏览器里不好逐层打印 xyCut 的递归）
    if (process.env.DUMP_MASK) {
      const want = (process.env.MASK_PAGES || '1,13,14').split(',').map(Number);
      const masks = await ev(`(() => { const want = ${JSON.stringify(want)}; const out = [];
        for (const p of boxState.pages) { if (want.indexOf(p.num) < 0) continue;
          let s = '';
          for (let i = 0; i < p.mask.length; i += 8192) s += String.fromCharCode.apply(null, p.mask.subarray(i, i + 8192));
          out.push({ num: p.num, w: p.maskW, h: p.maskH, scale: p.maskScale, gap: boxState.params.gapMm, minSize: boxState.params.minSizeMm, data: btoa(s) });
        }
        return out; })()`);
      for (const m of masks) {
        fs.writeFileSync(path.join(outDir, 'boxmask-p' + m.num + '.json'), JSON.stringify(m));
      }
      console.log('  已导出 ' + masks.length + ' 页掩膜到 probe-out/boxmask-p*.json');
    }

    // 每页的渲染尺寸与阈值（analyzePdf 里现算的，已经存进 __thr）
    const thr = await ev('window.__thr || []');
    if (thr.length) {
      console.log('\n页面   渲染尺寸        阈值   整页墨迹%');
      thr.forEach((t, i) => console.log(String(i + 1).padStart(3) + '   ' + (t.w + 'x' + t.h).padEnd(15) + String(t.thr).padEnd(7) + t.inkPct + '%'));
    }

    if (errors.length) { console.log('\n控制台错误 / 警告：'); errors.slice(0, 10).forEach(e => console.log('  · ' + e)); }
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
  }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('探针崩了：' + e.message); process.exit(1); });
