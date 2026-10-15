'use strict';

/**
 * ML Suite · 后端代码热重载
 *
 * 轮询一个目录下的所有 .js 文件的修改时间，一旦发现变化就回调。
 *
 * 为什么用「轮询 mtime」而不是 fs.watch：
 *   fs.watch 在不同编辑器下的行为不一致（有的先写临时文件再 rename，事件里拿到的是临时文件名），
 *   轮询 mtime 简单、跨编辑器稳定，对本项目这点文件量来说开销可以忽略。
 *
 * 抽成独立模块是为了能单独测试 —— 直接跑启动器会连带着启动第二份 server.js，
 * 会触发 PushPlus 推送、污染广告采样数据，测试成本太高。
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {object} opts
 * @param {string}   opts.root        要监听的目录
 * @param {number}  [opts.interval]   轮询间隔 ms（默认 1000）
 * @param {number}  [opts.debounce]   防抖 ms（默认 800）；文件写一半就重启会导致服务反复崩溃
 * @param {function(string)} opts.onChange  变更回调，参数为文件名
 * @param {function():boolean} [opts.shouldStop] 返回 true 则不再触发回调
 * @returns {{check: function(): (string|null), stop: function(): void}}
 *          check() 手动触发一次扫描，返回发生变化的文件名（无变化返回 null）—— 供测试使用
 */
function createWatcher(opts) {
  const root = opts.root;
  const interval = opts.interval || 1000;
  const debounce = opts.debounce || 800;
  const onChange = opts.onChange || function () { };
  const shouldStop = opts.shouldStop || function () { return false; };

  // 收集目录下所有 .js 的 mtime
  function scan() {
    const out = new Map();
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return out; }
    for (const n of names) {
      if (!/\.js$/i.test(n)) continue;
      try { out.set(n, fs.statSync(path.join(root, n)).mtimeMs); } catch (e) { /* 文件正被写入时可能 stat 失败，忽略 */ }
    }
    return out;
  }

  let known = scan();
  let timer = null;
  let stopped = false;

  // 与上一次快照比对，返回第一个发生变化的文件名
  function diff() {
    const next = scan();
    let changed = null;

    for (const entry of next) {
      const n = entry[0];
      const t = entry[1];
      if (!known.has(n) || known.get(n) !== t) { changed = n; break; }
    }
    if (!changed) {
      for (const n of known.keys()) {
        if (!next.has(n)) { changed = n + '（已删除）'; break; }
      }
    }

    known = next;
    return changed;
  }

  function schedule(name) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped || shouldStop()) return;
      onChange(name);
    }, debounce);
  }

  function check() {
    if (stopped || shouldStop()) return null;
    const changed = diff();
    if (changed) schedule(changed);
    return changed;
  }

  const tick = setInterval(check, interval);
  if (tick.unref) tick.unref();

  return {
    check,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(tick);
    },
  };
}

module.exports = { createWatcher };
