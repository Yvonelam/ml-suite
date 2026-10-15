# AI 协作交接说明

> **用法**：把「✅ 本次修改需求」那段填好，然后让 AI 先读本文件即可。
> 在能访问本机的工具（Claude Code）里，直接说「先读 HANDOFF-PROMPT.md」；
> 在只能访问 GitHub 的网页版里，本文件已在仓库里，它也能读到。

---

## 背景

这是我自用的项目「ML Suite · 美客多运营工作台」，仓库：

**https://github.com/Yvonelam/ml-suite**

请你先克隆/读取这个仓库，把结构看懂之后再动手改。下面是必要背景，读完再问我问题（有疑问一次性问全，别一轮一问）。

## ⚠️ 当前运行状态（先看这段）

**服务已经在跑了**：本地 `http://localhost:3000` + Cloudflare 隧道 `https://ml.yvonework.website`，由 `start-public.js` 守护中。

所以：

- ❌ **不要自己跑 `npm start` / `npm run public`** —— 会抢 3000 端口、起第二份服务
- ❌ **不要停服务、不要杀进程、不要双击任何 `.bat`**（`启动公网服务.bat` / `停止公网服务.bat` 都别碰）
- ❌ **不要 `git push`** —— 推送我来做
- ✅ **你只管改代码。改完不用重启任何东西**：前端（`public/`）我刷新浏览器就看到；后端（根目录 `.js`）会自动热重载（约 1 秒，**Cloudflare 隧道不断，公网不中断**）
- ✅ 改完一件事，就执行 `node version.js save "改动说明"` 存一个版本

## 项目是什么

一个**自托管**的 Mercado Libre（美客多 / 拉美最大电商平台）运营工作台。四块功能装在同一个 Express 服务里：

1. **关键词排名工具**（`/search/`）— 输入关键词，抓取各站点自然搜索排名与商品快照
2. **箱唛裁切器**（`/boxmark/`）— 把一页多标签的 PDF **无损拆分**成「一页一标签」，纯前端实现
3. **运营数据看板** — 订单、销售额、Listing、广告（含分时）、买家问答、售后索赔
4. **落地页**（`/`）— 对外门面

另有三块集成：**大麦数据 MCP**（拉真实热搜词）、**SMTP 每日报表邮件**、**PushPlus 微信推送**。

## 技术栈与硬约束

- 后端：**Express 4 + Node 18+**（`server.js`，单文件约 3000 行）
- 前端：**原生 HTML/CSS/JS**，**零构建、零框架、零前端 npm 依赖**，直接改 `public/` 下的文件
- 默认端口 **3000**（环境变量 `PORT` 可覆盖）
- 静态托管在 `public/`，`/search/`、`/boxmark/` 靠子目录天然生效
- 公网：**Cloudflare 隧道**

**以下约定请务必遵守，不要擅自「现代化改造」：**

- ❌ 不要引入 React / Vue / TypeScript / Webpack / Vite 等任何构建工具
- ❌ 不要新增前端 npm 依赖
- ❌ 不要重构目录结构（除非我明确要求）
- ✅ 换行符统一 **LF**（`.gitattributes` 已强制）；`*.bat` 例外用 **CRLF**
- ✅ 注释与 UI 文案用**中文**
- ✅ 保持 `server.js` 的单文件风格

## 关键文件地图

| 文件 | 作用 |
|---|---|
| `server.js` | Express 主服务：全部 API 路由 + 业务逻辑（约 30 条路由） |
| `start-public.js` | 启动器：本地服务 + Cloudflare 隧道，带崩溃自愈（异常退出后 3 秒自动重启，限流 10 次/分钟，监听 `.stop-flag` 优雅停止） |
| `stop-public.js` | 停止器：先写 `.stop-flag` 再杀进程 |
| `daily-report.js` | 每日排名报表（nodemailer 发信） |
| `dm-client.js` | 大麦数据 MCP 客户端（**故意用 Node 原生 `https.request`**） |
| `dm-mcp.js` | 大麦 MCP 命令行：`node dm-mcp.js tools` / `quota` / `call <name> '<json>'` |
| `public/app.js` | 主工作台 SPA |
| `public/search/` | 关键词排名工具 |
| `public/boxmark/` | 箱唛裁切器（含 vendor 版 pdf-lib / pdf.js） |
| `config.example.json` | 配置模板（所有凭据留空），需自行复制为 `daily-search-config.json` |
| `version.js` | 版本管理：`save` / `list` / `rollback`（改完用它存快照） |
| `start-public.js` | 另含**代码热重载**：根目录 `.js` 一变就自动重启服务 |

## 怎么跑

```bash
npm install
cp config.example.json daily-search-config.json   # 再按需填字段
npm start              # → http://localhost:3000
npm run public         # 本地服务 + 公网隧道
```

## 站点与时区

站点常量在 `server.js`：

| 常量 | 国家 | 时区 | 币种 |
|---|---|---|---|
| `MLM` | 墨西哥 | America/Mexico_City | MXN |
| `MLB` | 巴西（默认） | America/Sao_Paulo | BRL |
| `MLA` | 阿根廷 | America/Argentina/Buenos_Aires | ARS |
| `MLC` | 智利 | America/Santiago | CLP |
| `MCO` | 哥伦比亚 | America/Bogota | COP |

时间统一按站点当地时区处理，别用 UTC 直接显示给用户。

## 🚫 绝对禁止

1. **不要提交 `daily-search-config.json`。**
   所有真实凭据（SMTP 授权码、美客多 OAuth token、大麦 API Key）只存在这个文件里，已被 `.gitignore` 排除。**你如果新建任何配置文件，必须同步加进 `.gitignore`。**

2. **不要在源码里硬编码任何密钥。**
   `server.js` 里的 `DEFAULT_CONFIG` 明确全部留空，请保持这个状态。任何返回配置的接口都必须屏蔽敏感字段（现在 `/api/config` 会 `delete` 掉 `dmApiKey`，只回 `dmApiKeySet: true/false`）。

3. **不要用 `fetch` 调大麦 MCP 接口。**
   项目里 `undici` 是 v8.7.0，与 Node 内置 `fetch` 的 dispatcher 接口不兼容（会报 `invalid onRequestStart method`）。大麦一律走 `dm-client.js`。

4. **不要同步调用大麦接口。**
   单次调用约 **25 秒**、消耗约 **5 积分**。所以 `/api/dm/hot-keywords` 只读本地缓存，过期才在后台**异步**刷新（默认 24 小时一轮 ≈ 5 积分/天）。**这个架构不要动。**

5. **不要 `git push`。**
   改完在本地提交即可，推送我来做（我本机有凭据）。

## 改完之后必做：存一个版本快照

我这边已经开了**代码热重载**，所以你改完**不用重启服务**：

- 改**前端**（`public/` 下的 html / js / css）→ 我刷新浏览器就能看到
- 改**后端**（`server.js` 等根目录 `.js`）→ 服务会自动重启（约 1 秒），Cloudflare 隧道保持在线，公网不会断

**每改完一件事，务必执行一次：**

```bash
node version.js save "你这次改了什么"
```

这会把当前所有改动存成一个可回滚的版本（提交 + 打 `snap-` 标签），**这样我改得不满意能一键退回上一版。**

- ✅ 只做 `save`，**一件事一个快照**，说明用大白话写清楚
- ❌ 不要自己 `git reset`、不要回滚、不要删标签 —— 回滚是我的操作
- ❌ 不要为了「看起来干净」把多个不相关的改动塞进同一个快照

## 其他需要知道的

- 抓取美客多**需要科学上网**，配置里的 `proxy` 指向本机 Clash 混合端口（**端口是动态的**，别硬编码 7897）。
- 公网访问有口令 `accessPassword`；留空会自动生成 6 位随机值并打印在启动日志里。
- `push-to-github.bat` 已被 `.gitignore` 排除（我个人自用的推送脚本），你不用管它。

---

# ✅ 本次修改需求

> **（在这里写你要 Claude 做什么，务必包含这三点）**
>
> 1. **改哪个页面 / 哪个功能？**（例如：`/search/` 的结果卡片）
> 2. **期望的效果长什么样？**（越具体越好，有截图/参考图直接贴）
> 3. **怎么算改对了？**（验收标准）

（待补充 —— 把这行替换成你的实际需求）
