#!/usr/bin/env node
/**
 * 箱唛「自动识别」切分回归：真实文件 + 合成版面，验「一个箱唛不能被切成几块」
 *
 * 起因：真实外箱标第 14 页只有 2 个箱唛、右边半页是空白，
 *      被切成了 23 块（用户截图：「每次到最后一个识别出现错误」）。
 *      根因是 xyCut 拿区域**原始宽度**算 tol，大片留白把 tol 灌大，
 *      而箱唛自己的 1px 边框线正好卡在 tol 上，整条空白带被当成缝隙。
 *
 * 用法：node probe-boxmark-cut.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG = 9391;
const API = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API;
const dev = JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8'));

const REAL3 = 'E:/Works-WZ/Seller/BR/发货/2026.11.4 美客多上门取件 210南美森/外箱标 Envio-80335786-Etiquetas-do-volumes.pdf';
const REAL1 = 'D:/Downloads/外箱标 Envio-79903002-Etiquetas-do-volumes_箱唛单页 (1).pdf';

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
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : '')); } };

(async () => {
  const ck = await login();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-cut-'));
  const child = spawn(BROWSERS[0], ['--headless=new', '--remote-debugging-port=' + DBG, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--window-size=1440,900', '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, id = 0; const pending = new Map(); const errors = [];
  const send = (m, p = {}) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').split('\n')[0]); return r.result.value; };

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
    });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Network.setCookie', { name: 'ml_session', value: ck, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(300); if (await ev('document.title||""')) break; }
    for (let i = 0; i < 40; i++) { const g = await ev("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(250); }
    for (let i = 0; i < 60; i++) { if (await ev('typeof analyzePdf === "function" && typeof PDFLib === "object"')) break; await sleep(200); }

    // 在页面里装一个「跑一次 PDF，返回每页块数 + 块尺寸」
    await ev(`window.__runPdf = async function (u8) {
      boxState.srcBytes = u8.buffer.slice(0);
      boxState.fileName = 'probe.pdf';
      boxState.mode = 'auto'; boxState.gapAuto = true;
      boxState.params.gapMm = 3; boxState.params.minSizeMm = 8;
      await analyzePdf();
      return boxState.pages.map(p => ({
        num: p.num, failed: !!p.failed, n: p.boxes.length,
        sizes: p.boxes.map(b => [Math.round(b.w), Math.round(b.h)])
      }));
    };
    window.__b64ToU8 = function (b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
    true`);

    async function runFile(file, label, expect) {
      if (!fs.existsSync(file)) { console.log('\n[跳过] ' + label + '（文件不在了：' + file + '）'); return; }
      const b64 = fs.readFileSync(file).toString('base64');
      const pages = await ev(`window.__runPdf(window.__b64ToU8(${JSON.stringify(b64)}))`);
      console.log('\n[' + label + '] ' + pages.length + ' 页');
      console.log('  ' + pages.map(p => p.num + ':' + p.n).join('  '));
      ok(!pages.some(p => p.failed), label + ' 没有渲染失败的页', pages.filter(p => p.failed).map(p => p.num));
      const got = pages.map(p => p.n);
      ok(JSON.stringify(got) === JSON.stringify(expect), label + ' 每页块数符合预期', { got, expect });
    }

    // ---------- 1. 真实文件：13 页各 3 个 + 最后一页 2 个（这就是用户报的那份） ----------
    await runFile(REAL3, '真实外箱标 14 页', [...Array(13).fill(3), 2]);

    // ---------- 2. 真实文件：工具的导出结果，每页 1 个箱唛 ----------
    await runFile(REAL1, '真实单标签 20 页', Array(20).fill(1));

    // ---------- 3. 合成版面：几种常见分版 ----------
    const CASES = [
      { name: '3 列 × 1 行', cols: 3, rows: 1, expect: [3] },
      { name: '2 列 × 2 行', cols: 2, rows: 2, expect: [4] },
      { name: '1 列 × 3 行', cols: 1, rows: 3, expect: [3] },
      { name: '2 列 × 2 行 但只有 3 个（右下空）', cols: 2, rows: 2, skip: [3], expect: [3] },
      { name: '1 个箱唛偏在左边、右边整页空白', cols: 2, rows: 1, skip: [1], expect: [1] },
      { name: '3 列 × 1 行 但只有 2 个（右边空）', cols: 3, rows: 1, skip: [2], expect: [2] }
    ];
    for (const c of CASES) {
      const res = await ev(`(async () => {
        const { PDFDocument, rgb } = PDFLib;
        const doc = await PDFDocument.create();
        const W = 841.89, H = 595.28, M = 18;
        const gx = 18, gy = 18;
        const cw = (W - M * 2 - gx * (${c.cols} - 1)) / ${c.cols};
        const ch = (H - M * 2 - gy * (${c.rows} - 1)) / ${c.rows};
        const skip = ${JSON.stringify(c.skip || [])};
        const page = doc.addPage([W, H]);
        let idx = 0;
        for (let r = 0; r < ${c.rows}; r++) for (let col = 0; col < ${c.cols}; col++) {
          const i = idx++;
          if (skip.indexOf(i) >= 0) continue;
          const x = M + col * (cw + gx), y = H - M - (r + 1) * ch - r * gy;
          page.drawRectangle({ x, y, width: cw, height: ch, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.8 });
          page.drawRectangle({ x: x + cw * 0.1, y: y + ch * 0.84, width: cw * 0.8, height: ch * 0.08, color: rgb(0.05, 0.05, 0.05) });
          page.drawText('RSP01', { x: x + cw * 0.12, y: y + ch * 0.62, size: Math.min(30, ch * 0.11), color: rgb(0.05, 0.05, 0.05) });
          page.drawText('FULL', { x: x + cw * 0.68, y: y + ch * 0.9, size: 9, color: rgb(0.1, 0.45, 0.2) });
          // 假条码：一排竖条
          for (let b = 0; b < 34; b++) {
            const bw = (b % 3 === 0) ? 2.4 : 1.1;
            page.drawRectangle({ x: x + cw * 0.12 + b * 3.2, y: y + ch * 0.34, width: bw, height: ch * 0.18, color: rgb(0.05, 0.05, 0.05) });
          }
          for (let k = 0; k < 4; k++) page.drawText('SHIP TO / DESTINO ' + k, { x: x + cw * 0.1, y: y + ch * (0.22 - k * 0.05), size: 7, color: rgb(0.15, 0.15, 0.15) });
        }
        const bytes = await doc.save();
        return window.__runPdf(bytes);
      })()`);
      console.log('\n[合成 ' + c.name + '] ' + res.map(p => p.num + ':' + p.n).join('  '));
      const got = res.map(p => p.n);
      ok(JSON.stringify(got) === JSON.stringify(c.expect), '合成 ' + c.name + ' → ' + c.expect.join('/'), got);
      // 同一页里各块尺寸应该差不多（差太多说明被切碎了）
      const p0 = res[0];
      if (p0.sizes.length > 1) {
        const ws = p0.sizes.map(s => s[0]), hs = p0.sizes.map(s => s[1]);
        const spread = Math.max(...ws) / Math.min(...ws);
        const spreadH = Math.max(...hs) / Math.min(...hs);
        ok(spread < 1.15 && spreadH < 1.15, '合成 ' + c.name + ' 各块尺寸一致', { ws, hs });
      }
    }

    if (errors.length) { console.log('\n控制台异常：'); errors.slice(0, 8).forEach(e => console.log('  · ' + e)); }
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
  }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('探针崩了：' + e.message); process.exit(1); });
