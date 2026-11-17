/* 探针/截图脚本的 Chrome 临时目录工具
 *
 * 背景（2026-11-17）：所有探针都用 fs.mkdtempSync(os.tmpdir()) 建 Chrome 配置目录，
 * kill 掉浏览器后从不删除 —— 一个 profile 20~80MB，跑几十轮就攒出 5GB+，全落在 C 盘
 * （Windows 的 os.tmpdir() 就是 C:\Users\<user>\AppData\Local\Temp）。
 * 现在统一走 profileDir()：进程退出（含 Ctrl+C / 正常结束）自动删；
 * 另外每次创建前顺手清扫 12 小时前的残留（进程被强杀时 exit 钩子不会执行）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PREFIXES = [
  'ml-multi-', 'ml-smoke-', 'ml-quant-', 'ml-hubfx-', 'ml-buyer-', 'ml-ps-', 'ml-tz-', 'ml-cut-',
  'ml-box-', 'ml-boxshot-', 'ml-qauto-', 'ml-qref-', 'ml-pwd-', 'ml-cur-', 'ml-pp-', 'ml-rep-',
  'ml-sel-', 'ml-logo-', 'ml-shot-', 'ml-shots-', 'ml-perf-', 'ml-cost-', 'ml-probe-split-',
  'ml-probe-hc-', 'ml-e2e-', 'ml-e2e2-', 'ml-e2e3-', 'ml-e2e-ads-',
  'cdp-adsh-', 'cdp-dm-', 'cdp-ign-', 'cdp-ml-', 'cdp-ico-', 'cdp-shot-',
];

let swept = false;
/** 清掉 12 小时前的残留 profile（只在每个进程里扫一次） */
function sweepOld(maxAgeHours = 12) {
  if (swept) return;
  swept = true;
  const tmp = os.tmpdir();
  const cutoff = Date.now() - maxAgeHours * 3600e3;
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return; }
  for (const name of names) {
    if (!PREFIXES.some(p => name.startsWith(p))) continue;
    const dir = path.join(tmp, name);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
      // 只删确实是 Chrome profile 的目录，别误伤同名普通文件
      if (!fs.existsSync(path.join(dir, 'Local State')) && !fs.existsSync(path.join(dir, 'Default'))) continue;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch { }
  }
}

/** 建一个用完即删的 Chrome profile 目录 */
function profileDir(prefix) {
  sweepOld();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch { } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { cleanup(); process.exit(1); });
  }
  return dir;
}

module.exports = { profileDir, sweepOld, PREFIXES };
