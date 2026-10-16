#!/usr/bin/env node
/*
 * 浏览器端验证：广告分时图 / 热力图里**再也不出现小数单量**。
 * 做法：真·悬停那根柱子（CDP Input.dispatchMouseEvent），读 tooltip 原文。
 * 依赖：本机已跑的 ML Suite（PORT，默认 3000）+ auth-data/dev-login.json。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DBG_PORT = 9365;
const API_PORT = Number(process.env.PORT || 3000);
const HOST = 'http://127.0.0.1:' + API_PORT;

function readDevLogin() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'auth-data', 'dev-login.json'), 'utf8')); } catch { return null; } }
async function login() {
  const dev = readDevLogin() || {};
  const body = Buffer.from(JSON.stringify({ username: process.env.ML_ADMIN_USER || dev.username, password: process.env.ML_ADMIN_PASSWORD || dev.password }));
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: API_PORT, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      s => { let d = ''; s.on('data', c => d += c); s.on('end', () => { const sc = [].concat(s.headers['set-cookie'] || []).find(v => v.startsWith('ml_session=')); sc ? res(decodeURIComponent(sc.split(';')[0].slice(11))) : rej(new Error(d)); }); });
    r.on('error', rej); r.write(body); r.end();
  });
}
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const browser = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => { http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });

let pass = 0, fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (ok || !extra ? '' : '\n     ' + extra));
  ok ? pass++ : fail++;
}

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-probe-split-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=' + DBG_PORT, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars', '--mute-audio', '--window-size=1440,1000', '--user-data-dir=' + userDir, 'about:blank'], { stdio: 'ignore' });
  let ws = null, msgId = 0; const pending = new Map();
  const send = (m, p = {}) => { const id = ++msgId; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(m + ' timeout')); } }, 30000); }); };
  const evaluate = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;

  try {
    let target = null;
    for (let i = 0; i < 80; i++) { try { const l = await getJson('http://127.0.0.1:' + DBG_PORT + '/json/list'); target = l.find(t => t.type === 'page'); if (target) break; } catch (e) { } await sleep(250); }
    if (!target) throw new Error('浏览器调试端口没起来');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws 连接失败'))); });
    ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });

    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const cookie = await login();
    await send('Network.setCookie', { name: 'ml_session', value: cookie, url: HOST + '/', path: '/' });
    await send('Page.navigate', { url: HOST + '/index.html#ads' });
    for (let i = 0; i < 40; i++) { await sleep(300); const t = await evaluate('document.title||""'); if (t) break; }
    for (let i = 0; i < 40; i++) { const g = await evaluate("(function(){var s=document.getElementById('splash');if(!s)return true;if(s.classList.contains('leave'))return true;try{s.style.setProperty('display','none','important')}catch(e){}return false})()"); if (g) break; await sleep(300); }
    await sleep(3000);

    // 单天（今天）+ 出单口径
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsRange button')).filter(function(x){return x.dataset.r==='today'})[0];if(b)b.click();})()");
    await sleep(12000);
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsHourView button')).filter(function(x){return x.dataset.v==='hour'})[0];if(b)b.click();var m=[].slice.call(document.querySelectorAll('#adsHourMetric button')).filter(function(x){return x.dataset.m==='orders'})[0];if(m)m.click();})()");
    await sleep(2500);

    console.log('\n--- 原始数据 & 分摊结果 ---');
    const info = await evaluate(`(function(){
      var D = (typeof adsHour!=='undefined') ? adsHour : null;
      if(!D || !D.data || !D.data.byDay || !D.data.byDay.length) return JSON.stringify({err:'拿不到 adsHour.data'});
      var day = D.data.byDay[0];
      var sp = adSplitForDay(day);
      var nonzero = [];
      for (var h=0;h<24;h++) if (day.hours[h]>0) nonzero.push({h:h, 出单:day.hours[h], 广告:sp[h], 自然:day.hours[h]-sp[h]});
      return JSON.stringify({ date:day.date, 出单:day.orders, 广告单量:day.adUnits, 逐小时:nonzero, 广告合计:sp.reduce(function(a,b){return a+b;},0) });
    })()`);
    console.log('  ' + info);

    console.log('\n--- 断言：整数 ---');
    const o = JSON.parse(info);
    if (o.err) { check('拿得到分时数据', false, o.err); }
    else {
      check('广告单合计 = 当天广告单量（' + o.广告单量 + '）', o.广告合计 === Math.min(o.广告单量, o.出单), '实际 ' + o.广告合计);
      const anyFrac = o.逐小时.some(x => !Number.isInteger(x.广告) || !Number.isInteger(x.自然));
      check('逐小时广告单 / 自然单全是整数', !anyFrac, JSON.stringify(o.逐小时));
    }

    console.log('\n--- 断言：悬停柱子读 tooltip ---');
    // 找一根有数据的柱子，取其中点，用 CDP 真·移动到那里
    const hit = await evaluate(`(function(){
      var hb = document.querySelector('#adsHourBody svg rect.hb[data-i]');
      if(!hb) return '';
      var r = hb.getBoundingClientRect();
      return JSON.stringify({ i: Number(hb.dataset.i), x: r.left + r.width/2, y: r.top + Math.max(2, r.height/2) });
    })()`);
    if (!hit) { check('页面里能找到柱子', false, '没找到 rect.hb'); }
    else {
      const p = JSON.parse(hit);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(p.x), y: Math.round(p.y), button: 'none' });
      await sleep(600);
      const tip = await evaluate("(function(){var t=document.getElementById('hhTip');return t?t.innerText.replace(/\\n/g,' | '):'';})()");
      console.log('  悬停 ' + String(p.i).padStart(2, '0') + ':00 → ' + tip);
      check('tooltip 里有内容', !!tip, '(空)');
      check('tooltip 不含小数单量', !/\d+\.\d+\s*单/.test(tip), tip);
      check('tooltip 不含「0.5」', !/0\.5/.test(tip), tip);

      // 顺手截图留证（悬停状态保持中）
      try {
        const shotDir = path.join(__dirname, 'shots');
        if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        const out = path.join(shotDir, 'ads-hour-fixed.png');
        fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
        console.log('  📷 截图: ' + out);
      } catch (e) { console.log('  (截图失败: ' + e.message + ')'); }
    }

    console.log('\n--- 断言：热力图格子 title 无小数 ---');
    // 热力图只在「多天」范围下出现（单天会被 renderAdsHour 强制成按小时视图）
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsRange button')).filter(function(x){return x.dataset.r==='7d'})[0];if(b)b.click();else{var b2=[].slice.call(document.querySelectorAll('#adsRange button')).filter(function(x){return /7|周/.test(x.textContent)})[0];if(b2)b2.click();}})()");
    await sleep(15000);
    await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('#adsHourView button')).filter(function(x){return x.dataset.v==='heat'})[0];if(b)b.click();})()");
    await sleep(3500);
    const titles = await evaluate("(function(){var t=[].slice.call(document.querySelectorAll('#adsHourBody td')).filter(function(e){return /广告 \\d+/.test(e.title||'')});return JSON.stringify({n:t.length, sample:t.slice(0,6).map(function(e){return e.title;})});})()");
    const parsed = JSON.parse(titles || '{"n":0,"sample":[]}');
    console.log('  找到 ' + parsed.n + ' 个格子，样例: ' + (parsed.sample[0] || '(无)'));
    check('热力图能找到带广告拆分的格子', parsed.n > 0, '0 个');
    check('格子 title 里「广告 x / 自然 y」都是整数', parsed.sample.every(t => !/广告 \d+\.\d+/.test(t) && !/自然 \d+\.\d+/.test(t)), titles);

    console.log('\n' + (fail === 0 ? '✅ 浏览器端全部通过' : '❌ 有 ' + fail + ' 项失败') + `（${pass} 通过 / ${fail} 失败）\n`);
    child.kill(); process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FAIL ' + e.message);
    try { child.kill(); } catch (x) { }
    process.exit(1);
  }
})();
