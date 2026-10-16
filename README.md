# ML Suite · 美客多运营工作台

一个自托管的 **Mercado Libre（美客多）运营工作台**，把「关键词排名查询」「店铺数据看板」「箱唛（外箱标签）批量拆分」「公网发布」整合在同一个 Express 服务里对外提供。

- 站点覆盖：**墨西哥 MLM / 巴西 MLB / 阿根廷 MLA / 智利 MLC / 哥伦比亚 MCO**（默认 MLB）
- 技术栈：**Express 4 + 原生 HTML/CSS/JS**（零前端构建、零框架）
- 默认端口：**3000**（可用环境变量 `PORT` 覆盖）
- 公网访问：**Cloudflare 命名隧道**

---

## 功能模块

| 路径 | 模块 | 说明 |
|---|---|---|
| `/` | 落地页 | 官方门面，入口导航 |
| `/search/` | 关键词排名工具 | 输入关键词 → 抓取各站点自然搜索排名 / 商品快照，支持多站点、多页 |
| `/boxmark/` | 箱唛裁切器 | 把一页多标签的 PDF **无损拆分**成「一页一标签」，纯前端（pdf-lib / pdf.js） |
| （看板） | 运营数据中心 | 订单概览、销售额、Listing、广告（含分时）、问答、售后索赔 |
| （集成） | 大麦数据 MCP | 拉取**真实热搜词**，写入「实时热搜词」面板 |
| （集成） | 每日报表 | 定时抓取排名 → 通过 SMTP 邮件推送 |
| （集成） | PushPlus 推送 | 新问答 / 新售后实时推送到微信 |

---

## 目录结构

```
ml-suite/
├── server.js                 # Express 主服务（路由 + 业务逻辑）
├── start-public.js           # 启动器：本地服务 + Cloudflare 隧道（带崩溃自愈）
├── stop-public.js            # 停止器：写 .stop-flag 并结束进程
├── setup-tunnel.js           # 首次下载/配置 cloudflared 快速隧道
├── setup-named-tunnel.js     # 配置固定域名（命名隧道）
├── check-domain.js           # 检查域名/隧道状态
├── daily-report.js           # 每日排名报表（SMTP 发信）
├── dm-client.js              # 大麦数据 MCP 客户端（Node 原生 https）
├── dm-mcp.js                 # 大麦 MCP 命令行（tools / call / quota）
│
├── public/                   # 前端（静态托管于此目录）
│   ├── index.html            # 落地页
│   ├── app.js / style.css    # 主工作台 SPA
│   ├── search/               # 关键词排名工具
│   └── boxmark/              # 箱唛裁切器（含 vendor 版 pdf-lib / pdf.js）
│
├── hot-reload.js             # 热重载监视（轮询 *.js 的 mtime，变了就重启服务）
├── report-schedule.js        # 发报调度决策（纯函数：时区换算 + 该不该发 + 下次时间）
├── version.js                # 版本管理：save / list / rollback / base / apply
├── handoff.js                # 生成「交给外部 AI 的开场白」（含当前基座）+ 源码打包 + DOM 契约清单
├── shots.js                  # 无头 Chrome 截取当前界面 → shots/（改版给 AI 看现状）
├── DESIGN.md                 # 设计系统说明（变量表 / 组件清单 / 改版禁区）
│
├── config.example.json       # 配置模板（全部凭据留空）
├── daily-search-config.json  # ← 真实配置，含凭据（已被 .gitignore 排除，需自行创建）
└── *.bat                     # Windows 双击脚本（启动/停止/版本管理/交接给AI/改界面风格/配置域名/推送代码）
```

---

## 快速开始

### 1. 环境要求

- **Node.js ≥ 18**（推荐 20/22；项目用到内置 `fetch`、`AbortSignal.timeout`）
- Windows / macOS / Linux 均可（`.bat` 脚本仅 Windows 用）

### 2. 安装依赖

```bash
cd ml-suite
npm install
```

### 3. 生成配置

```bash
cp config.example.json daily-search-config.json
```

然后按需编辑 `daily-search-config.json`（**注意：此文件含密钥，永远不要提交到 Git**）。

### 4. 启动

```bash
# 方式一：仅本地
npm start
# → http://localhost:3000

# 方式二：本地 + 公网隧道（Cloudflare）
npm run public
```

Windows 用户可直接双击 **`启动公网服务.bat`**。

停止：`Ctrl+C`，或双击 **`停止公网服务.bat`**（会写 `.stop-flag`，防止启动器自动重连）。

---

## 开发工作流（改完即生效 · 不满意可回滚）

这套组合是给「让 AI 帮你改代码」准备的：**改完不用手动重启，刷新浏览器就是新版本；改得不满意随时退回上一版。**

### 热重载

| 你改的东西 | 生效方式 |
|---|---|
| **前端**（`public/` 下的 html / js / css） | **刷新浏览器即可**，无需重启（静态资源已设 `Cache-Control: no-store`） |
| **后端**（根目录 `.js`：`server.js`、`dm-client.js`、`daily-report.js` 等） | **自动重启服务**（启动器每秒检查一次文件修改时间，防抖 800ms 后重启；**Cloudflare 隧道全程在线，公网不会断**） |

- 关闭热重载：启动前设环境变量 `WATCH=0`
- ⚠️ 热重载由 `启动公网服务.bat` / `npm run public` 提供。若你用的是 `npm start`，后端改动仍需自己 `Ctrl+C` 重启

### 版本管理

双击 **`版本管理.bat`** 打开交互菜单（保存 / 查看 / 回滚）。命令行等价写法：

```bash
node version.js save "改了热搜词卡片"      # 把当前所有改动存成一个版本（提交 + 打 snap- 标签）
node version.js list                      # 查看最近 30 个版本（带编号）
node version.js rollback 3                # 回滚到列表里的第 3 版
node version.js rollback snap-20261015-170200
```

**回滚是安全的**：每次回滚前，脚本会先把「当前状态」自动打成一个 `safety-时间戳` 标签。所以连回滚本身都能反悔：

```bash
node version.js rollback safety-20261015-170211   # 退回「回滚之前」的状态
```

回滚会改动工作区文件 → 自动触发热重载 → 刷新浏览器就是回滚后的版本。

### 推荐的协作节奏

让 AI **每改完一件事就存一版**：

```bash
node version.js save "AI 这次改了什么"
```

版本列表就会是一条清晰的时间线，任何一步都能一键退回。

### 交给外部 AI 改代码（Claude / GPT / Gemini 都行）

这套流程**和是哪家 AI 无关**。双击 **`交接给AI.bat`** → 自动生成一段开场白并**复制到剪贴板** → 打开任意 AI 直接粘贴 → 在【】里填需求。

生成的这段话里已经包含：仓库地址、**当前基座 commit**、最近几次改动、你能怎么干活（够不到电脑的网页版 / 能操作本机的 CLI 版）、硬约束（不要 push / 不要起服务 / 不要动 `.bat`）、需求填写模板。

想针对某一家微调措辞（主要是提醒它「读不到仓库」这件事）：

```bash
交接给AI.bat gpt        # 或 gemini / claude；不带参数就是通用版
```

对方**读不到仓库**时（GPT、Gemini 网页版通常是这种情况），先打包源码给它：

```bash
node handoff.js pack    # 生成「给AI的源码.txt」（约 640 KB，40 个源码文件），上传给对方即可
```

**关于「基座」——别用固定 commit**：

基座就是「对方以哪一版代码为基准来改」。它**不能固定**：`main` 一直在往前走，固定成旧 commit 会让对方读到旧代码，把已经修好的地方改回旧样子。正确做法是让**对方自己取**：

```bash
git rev-parse --short HEAD      # 对方拿到代码后自己跑，结果就是基座
```

我这边落地 patch 时用的是 `git apply --3way`（三方合并），所以基座差一两个提交通常也能自动合上：

```bash
node version.js base                  # 看当前基座
node version.js apply --clip           # 应用剪贴板里的 patch（推荐：从聊天窗口复制即可）
node version.js apply 对方给的.patch    # 或从文件应用
```

`apply` 会**自动清洗**从聊天窗口复制出来的 patch（去掉 ```` ``` ```` 代码围栏、砍掉 patch 前面的说明文字、剥掉多余缩进），落地顺序为 `3-way 合并` → `直接应用` → `容错应用` 三档降级；只改工作区不提交，不满意可 `git checkout -- <文件>` 整体丢弃。

**唯一要守的纪律**：同一时间只让**一个** AI 改同一批文件，改完存一版快照（`版本管理.bat`）再换下一个，否则两边的改动必然打架。

### 让 AI 改界面排版 / 美术风格

改版是风险最高的一类改动，走独立的入口：

```
双击 改界面风格.bat
```

它做两件事：① 生成「**改版模式**」的开场白（放行「允许重做整体样式」，但要求对方**先出方案**、再给 patch）；② 自动把当前界面截图到 `shots/`（主工作台 7 个视图 + 2 个独立页面），你把截图一起上传给 AI —— 光读 CSS 是看不见问题的。

改版必读 **[`DESIGN.md`](DESIGN.md)**，里面写清了三件事：

1. **在用的界面只有一套皮肤**：`public/index.html` + `public/style.css`（7 个视图共用）。
   ⚠️ `public/search/` 和 `public/boxmark/` 是**已退役的独立页** —— 打开 `/search/` 会立刻跳回工作台 `#rank`、`/boxmark/` 跳回 `#box`，它们的 CSS 现在**在任何真实页面上都不生效**，别去改
2. **设计变量表**（`--bg/--s1/--s2/--s3/--bd/--ink/--tx2/--mut/--ac/--ok/--bad/--cyan/--violet/--glass*`）与布局骨架、组件清单
3. **改版禁区** —— 最要命的是「JS 依赖的 id 不能删改」

改版前先跑一次契约核对，它会告诉你哪些 id/class 动了就会把功能改挂：

```bash
node handoff.js dom      # 主工作台 172 个 id 必须保留；另列出 76 个「JS 不依赖、可安全改名」的
```

其他两个命令：

```bash
node handoff.js style    # 只生成改版模式的开场白（不截图）
node handoff.js shots    # 只截图（也可 node shots.js hub ads 只截指定视图）
```

**为什么改版要「先出方案」**：改版往往一次动几十个样式规则，直接给 patch 的话一旦方向不对，你看到的就是一整页面目全非。先要一份方案（改哪些文件 + 新旧变量对照表 + 逐区块改法 + 风险），确认了再让它写代码，成本最低。

---

## 配置说明（`daily-search-config.json`）

| 字段 | 说明 |
|---|---|
| `sites` | 目标站点数组，如 `["MLB"]`、`["MLM","MLB","MLA"]` |
| `proxy` | 抓取美客多时走的 HTTP 代理（国内需科学上网，如 `http://127.0.0.1:7897`） |
| `smtpHost/Port/User/Pass` | 每日报表发信用的 SMTP（Gmail 用**授权码**，不是登录密码） |
| `mlAppId/mlSecret` | 美客多开发者应用凭据（OAuth） |
| `mlAccessToken/mlRefreshToken` | 美客多 OAuth 令牌（由 `/api/ml/oauth/start` 流程自动写入） |
| `dmApiKey` | **大麦数据 MCP** 的 API Key（用于拉取真实热搜词） |
| `dmHotTtlHours` | 热搜词缓存有效期（小时），默认 `24` = 一天刷新一次 |
| `pushToken/pushEnabled` | PushPlus 推送令牌与开关 |
| `accessPassword` | 工作台访问密码（留空则不校验） |

> **安全约定**：源码 `server.js` 里的 `DEFAULT_CONFIG` **不含任何真实凭据**，全部留空。真实值只存在于 `daily-search-config.json`，该文件已被 `.gitignore` 排除；`/api/config` 接口也会自动屏蔽 `dmApiKey` 等敏感字段，只回 `xxxSet: true/false`。

---

## 公网部署（Cloudflare 隧道）

1. 双击 **`启动公网服务.bat`**（或 `npm run public`）
2. 首次运行会自动下载 `cloudflared.exe` 到 `tools/`
3. 窗口里会打印公网地址（快速隧道是随机 `*.trycloudflare.com`）
4. 想固定域名：双击 **`配置固定域名.bat`** → 按提示登录 Cloudflare 授权

**自愈机制**：`start-public.js` 会在服务/隧道异常退出后 **3 秒自动重启**（每分钟限流 10 次），并监听 `.stop-flag` 以支持优雅停止。`server.js` 顶部挂了 `uncaughtException` / `unhandledRejection` 兜底，避免任何未捕获异常直接把整站打挂。

---

## 主要 API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/search` | 单关键词排名查询 |
| GET | `/api/batch-search` | 批量关键词查询 |
| GET/POST | `/api/config` | 读取 / 保存配置（读取时屏蔽密钥） |
| GET | `/api/ml/status` | 美客多授权与令牌状态 |
| GET | `/api/ml/orders/summary` | 订单概览 |
| GET | `/api/ml/sales` | 销售额统计 |
| GET | `/api/ml/listings` | 商品 Listing |
| GET | `/api/ml/ads`·`/api/ml/ads/hourly` | 广告数据 / 分时数据 |
| GET | `/api/ml/questions` | 买家问答列表 |
| POST | `/api/ml/questions/:id/answer` | 回复问答 |
| GET | `/api/ml/claims`·`/api/ml/claims/:id` | 售后索赔列表 / 详情 |
| POST | `/api/ml/claims/:id/reply`·`/ignore` | 回复 / 忽略索赔 |
| GET | `/api/dm/hot-keywords` | **真实热搜词**（只读缓存，`?force=1` 强制后台刷新） |
| GET | `/api/dm/quota` | 大麦数据额度（免费接口） |
| GET | `/api/ml/oauth/start`·`/callback` | 美客多 OAuth 授权流程 |
| POST | `/api/push/test`·`/check` | PushPlus 测试 / 立即检查 |
| POST | `/api/send-report` | 手动触发邮件报表 |

---

## 大麦数据（MCP）集成

- 端点：`https://mcp.damaishuju.com/tools/mcp`（Streamable HTTP，协议 `2024-11-05`）
- 鉴权：请求头 `X-API-Key`（值来自配置的 `dmApiKey`）
- 客户端：`dm-client.js`（**故意使用 Node 原生 `https.request`**，而非 `fetch`/`undici`——规避 undici 版本冲突，且国内站无需走代理）
- 命令行自检：

```bash
node dm-mcp.js tools                    # 列出全部可用工具
node dm-mcp.js quota                    # 查额度（免费）
node dm-mcp.js call search_product_snapshots '{"market_code":"MLB","keyword":"headset gamer","limit":100}'
```

- **热度口径**：对某关键词 Top100 商品求 `orders_last_30_days` 之和，归一化到 `0–100`；`matched_count` 上报时封顶 `10000`。
- **成本控制**：单次调用约 25 秒、约 5 积分。因此 `/api/dm/hot-keywords` **永远只回缓存**，过期才在后台异步刷新（默认 24 小时一轮 ≈ 5 积分/天），绝不阻塞接口。

---

## 常见问题

**Q：站点打不开，Cloudflare 报错 1033？**
隧道在线但本地服务没起来。根因通常是 `server.js` 崩溃退出。本项目已加三层护栏（异常兜底 + 服务自愈 + 隧道重连）；若仍复现，查 `运行日志.txt` 里的 `[服务] 已退出，代码 X` 与堆栈。

**Q：抓取美客多超时 / 失败？**
国内需要代理。确认 `daily-search-config.json` 的 `proxy` 指向你本机的 Clash/Mihomo 混合端口（**端口是动态的**，去客户端「设置」里看当前值，不要照抄文档里的 7897）。

**Q：`npm run public` 之后关掉黑窗口，站就下线了？**
是的，这是前台进程。要常驻请用 `pm2`、Windows 任务计划程序或 `nssm` 注册成服务。

**Q：大麦 MCP 在 WorkBuddy 里连不上？**
「信任」按钮在 **WorkBuddy 客户端侧**（左侧「连接器」→「自定义连接器」→ 配置 MCP → 保存后才会出现「信任」），不是在数据方网站上。

---

## 安全须知

1. `daily-search-config.json`、`tunnel-config.json`、各类 `*-cache.json`、`push-state.json` 均已被 `.gitignore` 排除，**不要强行 `git add -f` 提交**。
2. `push-to-github.bat` 同样被排除（本机自用脚本，含个人仓库地址）。
3. 若曾不小心提交过真实凭据，**改代码不够，必须去对应平台吊销并重新签发**（Git 历史里的记录仍在）。
4. 公网开放时建议设置 `accessPassword`，避免工作台被扫到。

---

## 许可证

私有项目，未声明开源许可。如需复用请先联系作者。
