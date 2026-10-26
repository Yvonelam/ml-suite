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
| （集成） | PushPlus 推送 | 新问答 / 新售后实时推送到微信（已被自动回复的问答会标「已自动回复 · 无需处理」） |

---

## 目录结构

```
ml-suite/
├── server.js                 # Express 主服务（路由 + 业务逻辑）
├── start-public.js           # 启动器：本地服务 + Cloudflare 隧道（带崩溃自愈 + 单实例锁）
├── stop-public.js            # 停止器：写 .stop-flag 并结束进程
├── autostart-watchdog.js     # 看门狗：每分钟查「启动器进程 + 端口」，掉了自动拉起（开机自启用）
├── autostart.vbs             # 开机自启入口（纯 ASCII，放启动文件夹；由「开机自启-开启.bat」安装）
├── git-autosync.js           # 自动同步：本地一有改动就自动提交并推送到 GitHub（给远端 AI 用）
├── version.js                # 版本管理：save 打快照标签 / rollback 回滚
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
└── *.bat                     # Windows 双击脚本（启动/停止/开机自启/版本管理/交接给AI/改界面风格/配置域名/推送代码）
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

1. **在用的界面只有一套结构**：`public/index.html` + `public/style.css`（7 个视图共用）。配色的三层主题表见 `DESIGN.md` §0.1 —— 现在有 5 套美术风格（经典深色 / 柔雾玻璃 / 彩色毛玻璃 / 典藏金 / 动态玻璃），改颜色要连 Logo 一起改。
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

## 开机自启 & 断不了线（没人管也能自己回来）

六层保护，按「谁死了 / 什么坏了」分工：

| 出问题的东西 | 谁来救 | 多久 |
|---|---|---|
| `server.js` 崩溃退出 | `start-public.js` 自带守护 | 3 秒起，指数退避 |
| `cloudflared` 进程退出 | 同上，自动重连 | 3 秒起，指数退避 |
| 进程活着但公网 530（半开连接） | 每分钟三层健康探测 | ≤ 3 分钟 |
| QUIC（UDP）被网络掐死 | 自动降级 `--protocol http2`（TCP） | 攒够 5 次失败 |
| 整个启动器被关窗口 / 被系统回收 | `autostart-watchdog.js` 看门狗 | ≤ 60 秒 |
| 服务还在、但启动器没了（孤儿） | 同上，重新接管隧道（**访问不中断**） | ≤ 60 秒 |
| **看门狗自己也死了** | **计划任务 `ML-Suite Watchdog` 每 10 分钟确认一次** | ≤ 10 分钟 |
| 机器重启 / 重新登录 | 计划任务的登录触发器 + 启动文件夹里的 `ML-Suite-Autostart.vbs` | 登录即拉起 |

> **为什么多了「看门狗看门狗」这一层（2026-10-24 教训）**
> 那天 11:40 服务被硬杀（不是崩溃，日志直接断掉，连 `[服务] 已退出` 都没有），结果公网一直断到有人发现。
> 原因不是护栏不够，而是**看门狗自己在 10-19 06:21 就无声死了** —— 它当时最后一行日志停在
> 「启动器在跑（PID 24496）但端口 3000 不通（第 1/2 次）」，之后再没有任何记录。
> 死了 5 天没人知道，因为没人看门狗。
>
> 两处修复：
> 1. `autostart-watchdog.js` 加了 `uncaughtException` / `unhandledRejection` 兜底 + 给两个 `spawn` 挂了 `error` 监听
>    （spawn 失败是**异步** `'error'` 事件，不监听就会被当成未捕获异常把进程干掉）。死掉的看门狗比没有看门狗更糟——
>    因为你以为它在看。
> 2. 用**计划任务**托管看门狗：登录时触发 + 每 10 分钟触发一次，`MultipleInstances=IgnoreNew`、
>    `ExecutionTimeLimit=0`（不超时）。看门狗活着时重复触发直接被任务计划器忽略（连日志都不刷），
>    死了就在 10 分钟内被重建。
>
> ⚠️ **任务必须用 S4U 主体（`-LogonType S4U`）**，这是踩出来的：
> 用默认的「只在用户登录时运行」，`node.exe` 是控制台程序，每次触发都会在桌面上**弹一个黑窗口**
> （2026-10-26 就是这样，10 分钟弹一次）。用户把窗口关掉 = 看门狗被杀 → 10 分钟后任务再弹一个，
> 形成「一直有 cmd 弹出来」的循环。
> S4U 让任务跑在**会话 0**，全程无窗口，而且注销后也不受影响。
> 所以 `开机自启-开启.bat` 里那行 `Register-ScheduledTask` 带了
> `-Principal (New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType S4U -RunLevel Limited)`，别删。
>
> ⚠️ 为什么不能靠 `spawn(detached:true)` 就够了：**Windows Job Object 里 detached 逃不出去。**
> 从某个终端/会话里拉起的进程，只要那个会话的 Job 关闭，整棵树都会被带走——
> `detached` 只在 POSIX 上真正独立。所以持久化必须交给 Task Scheduler，不能挂在交互式会话下。

**关键设计：永不放弃。** 早期版本是「1 分钟内重启超过 10 次就放弃」——网络抖动一分钟，服务就永久下线，必须人工重启。现在改成指数退避：

```
3s → 6s → 12s → 24s → 48s → 96s → 192s → 300s → 300s → …（封顶 5 分钟，永远重试）
```

任何一次起来后**稳定存活满 60 秒**，计数立刻归零；下次抖动又从 3 秒开始。既能秒级恢复偶发抖动，又能在长期故障时不刷屏、不烧 CPU。

**为什么不能只看「进程还在不在」：** cloudflared 进程活着、`/ready` 也返回 200，但到边缘的连接已经死了（半开连接）——这时公网一直 530，进程却安安静静跑十几个小时。2026-10-17 就是这么挂的。所以健康探测有三条腿：

| 信号 | 说明 |
|---|---|
| `127.0.0.1:20241/ready` | 有没有握上健康连接 |
| `/metrics` 的 `cloudflared_tunnel_ha_connections` | 实际活动连接数（0 = 一条都没有） |
| 真去 GET `https://ml.yvonework.website/` | 端到端，骗不了人。**直连不通会再用 Clash 代理试一次**，两边都不通才判定隧道坏了（避免误杀） |

**开启**：双击 **`开机自启-开启.bat`** —— 往启动文件夹放一个入口，并立刻把看门狗跑起来。
（计划任务 `ML-Suite Watchdog` 是独立注册的，不受这个开关影响；要连它一起停，用
`Unregister-ScheduledTask -TaskName "ML-Suite Watchdog" -Confirm:$false`）
**关闭**：双击 **`开机自启-关闭.bat`** —— 移除入口 + 结束看门狗（不影响正在跑的服务）。
**临时停服务**：仍然是双击 **`停止公网服务.bat`**。它会写 `.stop-flag`，看门狗看到这个标记就**闭嘴**，不会你刚停完又给你拉起来。

细节：

- 看门狗每分钟做一次「**启动器进程 + 端口 3000**」双重体检：启动器在跑但端口连续 2 次不通 → 判定卡死，杀掉重来；启动器不在但端口还通（孤儿服务）→ 也拉起新启动器，它会复用已在跑的服务、只把隧道接管回来。
- `start-public.js` 带 **单实例锁**（`.launcher.pid`）：开机自启和手动双击撞车时，后来者直接退出，不会跑出两条隧道。
- `autostart.vbs` **必须保持纯 ASCII** —— Windows Script Host 按 ANSI 读它，写 UTF-8 中文注释会乱码。
- 日志统一追加到 **`运行日志.txt`**（前带 `[看门狗]` 前缀的就是它干的）。
- 健康探测的基线会在启动 20 秒后打印一行 `[隧道] 健康探测已接管 ✓`，之后每分钟复查；出现 `健康异常` 就是真的在抖，`强制重启` 就是触发了自愈。

**已实测的故障演练**（`probe-resilience.js` 覆盖退避序列与探测函数）：

- 强杀 `cloudflared` → 3 秒后重连，12 秒内公网恢复 200
- 强杀 `server.js` → 3 秒后重起，隧道全程在线，公网不中断
- 杀启动器 → 看门狗 60 秒内拉起，服务与隧道一并恢复

---

## 自动同步到 GitHub（给「不在本机运行的 AI」用）

远端那个 AI 只能读 GitHub（仓库是公开的，clone 不用鉴权），但**不能推**——它改完只能提示你「请 push」。
所以同步必须是**双向**的：本机改动自动推上去，远端推上来的自动拉下来。详见 **`远程AI-推送指南.md`**（一次性给远端 AI 配个 fine-grained token，它就能自己 push）。

**本地一有改动，停手 25 秒左右自动出现在 GitHub 的 `main` 上**；**空闲时每 2 分钟 fetch 一次，远端领先就自动 `pull --rebase` 合入**，不需要人记得点「推送代码」。

它是怎么判断的（轮询，不用文件监听）：

| 时机 | 动作 |
|---|---|
| 每 20 秒 | 跑一次 `git status --porcelain`，并给脏文件算「文件名 + mtime」指纹 |
| 指纹变了 | 说明还在写 → 重置静默计时（连续改一个文件不会每 20 秒切一刀） |
| **停手 25 秒** | `git add -A` → commit → push |
| 连着改不停手 | 最多 **5 分钟** 强制提交一次兜底，避免长时间不落袋 |
| 工作区干净且有未推送提交 | 补推（上次失败积压的） |
| 工作区干净且没有待推 | **每 2 分钟 fetch 一次远端**，领先就 `pull --rebase --autostash` 合入 |

> ⚠️ 老版本**只 push 不 fetch**，所以远端 AI 推的改动永远进不了本机 —— 单向半闭环，这也是「远端改了本地看不到」的根因。
> 合入只在工作区干净时做：正在编辑的文件被 rebase 换掉，热重载会读到半成品。

**看状态不用记命令**：双击 **`同步状态.bat`**，一眼看到「自动同步进程在不在 / 未提交几个 / 未推送几个 / 未合入几个 / 最近 8 条记录」。
命令行等价：`node sync-status.js`（`node git-autosync.js --once` 可以手动跑一轮并强制拉一次）。

**进程挂了会自动复活**：启动器每 60 秒体检一次自动同步（`ensureAutosync()`），死了清掉陈旧 `.autosync.pid` 原地拉起；看门狗也管一份。

**推送失败绝不丢东西**：提交留在本地，指数退避 5s→10s→…→5 分钟封顶、永不放弃。远端有新提交（`non-fast-forward`）会自动 `pull --rebase --autostash` 再推一次；真冲突则 `rebase --abort` 回到干净状态并告警，绝不把仓库卡在 rebase 中途。

**提交信息长这样**，远端 AI 一眼看出改了什么：

```
[auto] 2026-10-18 01:52:10 · 3 个文件

M public/app.js
M public/index.html
?? probe-new.js
```

**护栏（这几条是重点）**：

- 严格遵守 `.gitignore` —— `auth-data/`、`daily-search-config.json`、`tunnel-config.json`、`运行日志.txt`、`shots/` 全部被排除，**不会被推上去**
- `.sync-pause` 存在时暂停提交（进程还在，但不动手）
- `.sync-off` 存在时连启动器都不会把它拉起来 —— 这是「我真的不需要了」的标记
- `.git/index.lock` 存在，或处于 merge / rebase / cherry-pick 中途 → 本轮跳过，绝不抢 git 的活
- 单实例锁 `.autosync.pid`，不会跑出两个
- `GIT_TERMINAL_PROMPT=0`：凭据失效时立刻报错，而不是弹窗把后台进程卡死
- 已设 `core.quotepath=false`，提交信息里的中文文件名不会变成 `"\350\207\252..."` 八进制转义
- `同步日志.txt` 本身在 `.gitignore` 里 —— 否则它写一行日志就产生一次改动，**无限自激提交**

**它跟着谁活**：`start-public.js` 启动时会顺手把 `git-autosync.js` 拉起来（若它没在跑）。启动器本身有看门狗 + 开机自启护着，等于自动同步也一起被守护，**不用单独记着去双击 bat**。

**开始 / 停止**：

| 操作 | 方式 | 效果 |
|---|---|---|
| 开始 | 双击 **`自动同步-开启.bat`** | 清掉 `.sync-off` 并立即启动（最小化窗口） |
| 停止 | 双击 **`自动同步-关闭.bat`** | 写 `.sync-off` + 结束进程，之后启动器/开机自启都不会再拉起 |
| 临时暂停 | 建一个 `.sync-pause` 空文件 | 进程还在，但不提交不推送 |
| 看日志 | **`同步日志.txt`** | 每次检测/提交/推送/重试都有一行 |

**和 `version.js` 的关系**：`version.js save` 是「人工里程碑 + 打标签」，autosync 是「不间断兜底」。两者不冲突 —— autosync 只看工作区脏不脏，`version.js` 提交完工作区干净，它就不动。

**一个必须知道的副作用**：autosync 会把**未完成的半成品**也推上去。远端 AI 可能读到一份写到一半的代码。所以要么用 `.sync-pause` 暂停，要么让它推 —— 反正有 `version.js rollback` 和 git 历史兜底。

---

## 订单利润的口径（数字对不上时先看这里）

### 单量 / 件数：三个数字别搞混

| 指标 | 含义 | 2026-10-01~10-17 实测 |
|---|---|---|
| 全部订单 | 平台 `paging.total`，**含取消单** | 780 单 |
| 售出件数 | 所有订单的 `quantity` 之和，**含取消单** —— **这个是美客多后台显示的数** | 847 件 |
| 有效单 / 有效件 | 剔除 `cancelled` / `invalid` / 退款后的 | 731 单 / 793 件 |
| 取消 / 退款 | 只列出来看，**不计入利润** | 49 单 / 54 件 |

> 后台说「774 单 / 841 件」而这里显示 780 / 847，通常只是**多了几单新订单**（比例一致：780−774 = 6 单，847−841 = 6 件，都是一件一单）。
> 别再把「有效单数」当「后台单数」用 —— 老版本只报有效单，永远对不上账。

### 一笔订单买多件 / 买多个不同商品

- **数量 > 1**：按件数核算（成本 × 件数、销售费 × 件数），数量列会标「单笔多件」。实测 10 月有 26 单是多件（最多一单 15 件）。
- **一单多个不同商品**：该单会拆成多行，每行一个 Listing。**运费按实售价比例分摊到每行，摊完加总恒等于整单运费，不会重复扣。**
  实测 10 月 780 单里 `order_items` 全部为 1 项（`totals.ordersWithMultiItem = 0`），这条逻辑目前没被真实触发，但订单结构随时可能变，逻辑保留。

### 取消 / 退款单

**照样列在订单明细里**，行首带「已取消」徽章、整行置灰、商品名加删除线；收入与销售费仍然显示（让你看清这单丢了多少钱），但**运费 / 成本 / 利润一律不给假数** —— 退款后平台会把佣金退回，硬算出来的「利润」是错的。利润合计**只统计有效单**。

### 一行的利润怎么算

**一行的利润 = 订单收入 − 销售费 − 尾程运费 − 税费 − 成本与头程**，全部按巴币算，再按中国银行牌价折人民币。

| 项 | 数据来源 | 口径说明 |
|---|---|---|
| 订单收入 | `order_items[].unit_price × quantity` | 商品实售价，不含运费 |
| 销售费 | `order_items[].sale_fee × quantity` | 平台佣金（含 Mercado Envios 补贴前的销售费） |
| 尾程运费 | `/shipments/{id}/costs` 的 `senders[].cost` | **按实售价比例分摊到同一 shipment 的每个商品行**；结果落 `ship_cost` 表缓存 30 天 |
| 税费 | `order.taxes.amount` | 巴西站实测**恒为 null**（平台不代扣），按 **0** 计并打 `taxAssumed` 标记 —— 不要当成「数据缺失」把整行利润废掉 |
| 成本与头程 | `product-profit.json` 里手工填的 `costCny + freightCny` | 单位成本 × 件数，另加 `otherFee × 件数` |

**列币种是固定搭配，不做切换**：收入 / 销售费 / 尾程运费跟着平台原币走（巴西站 = 巴币 R$，跟后台一一对得上）；
成本与头程 / 订单利润固定人民币（成本本来就是按人民币采购价填的）。两栏币种不同不能直接相减，所以每格都挂了 `title`，鼠标一停就能看到另一币种的折算值。

### 产品出单统计（带主图）

订单明细上方有一块按 Listing 聚合的卡片墙：**主图 + 件数 + 订单数 + 取消件数 + 收入（R$）+ 利润（¥）+ 利润率**，按件数从多到少排，点卡片直接打开该 Listing。

- 主图来自 `/items?ids=...&attributes=thumbnail`（`mlItemInfo()`），批量 20 个一批，取不到就退化成首字母占位方框，不影响任何数字
- 件数口径与上方汇总卡一致：`units` 只算有效单，`cancelledUnits` 单独标红显示
- 各产品利润相加 ≈ 订单利润合计（差值为四舍五入，探针 `probe-profit-products.js` 断言 < ¥1）

**数字突然变了怎么查**（2026-10-18 踩过一次，记录在此免得再查一遍）：
合计从 ¥72,983.31 掉到 ¥61,958.31，差额 ¥11,025.00 —— 恰好 = 315 件 × ¥35，
对应 `MLB4463974607`（215 件）+ `MLB4463974609`（100 件）两个 Listing 的单价成本被从 ¥35 改成 ¥70。
**不是计算错误，是成本表 `product-profit.json` 被改了。** 判断顺序：

1. `node probe-profit-audit.js <from> <to>` —— 若「收入−销售费−运费−税费−成本」与「利润」和「合计」三者分毫不差，说明算法没坏，往上找数据。
2. `ls -l auth-data/data/admin/product-profit.json` —— 看 mtime 是否落在两次观测之间。
3. 只有运费会变外部数据：查 `ship_cost` 表有没有 `amount=0` 或空币种的脏缓存。

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
| POST | `/api/push/test`·`/check` | PushPlus 测试 / 立即检查（`?only=questions\|claims`、`?preview=1` 只渲染不发） |
| POST | `/api/send-report` | 手动触发邮件报表 |

---

## 微信提醒和「自动回复」怎么配合

两件事跑在两个定时器上，互相不知道对方：

| | 频率 | 干什么 |
|---|---|---|
| 关键词自动回复 | 每 1 分钟 | 拉未回复提问，命中规则就调 `/answers` 回掉 |
| 微信提醒（PushPlus） | 每 N 分钟（可配） | 拉未回复提问，发现「没见过的」就推到微信 |

所以会有个尴尬场景：**推送先到，说「新提问 3 条，去回复」，你点进后台发现机器人早回完了。** 白跑一趟，而且这种噪音多了推送就不想看了。

现在按两条规则处理：

1. **推送前先同步跑一轮自动回复**（`checkNewQuestions` 里，只在自动回复开着时）。这样下面打标签时读到的
   是「已经发生的事实」，不是猜测。这步失败不影响推送，只是按「没自动回复」如实标注。
2. **按结果标**：
   - 全部已回 → 标题 `🤖 售前已自动回复 N 条 · 站点（无需处理）`，正文顶部绿条说明「不用再去处理」
   - 部分已回 → 标题带 `（M 条已自动回复）`，正文里已回的标绿并写「无需再跟进」，没标的仍是「👉 打开商品页去回复」
   - 全没回 → 与改动前完全一致

判定只认 `question-auto-reply.json` 里的 **`autoReplied`**（`{[提问id]: {at, ruleId, ruleLabel}}`），
不认 `processedIds` —— 后者还包含「别人已回 / 提问已失效」，把那些说成「已自动回复」就是撒谎。

想看推送长什么样，不用真发：`POST /api/push/check?only=questions&preview=1` 只渲染返回 `title`/`html`，
不发送、不记 `seen`、也不会替你去回买家。正文渲染的纯函数在 `push-format.js`（探针能直接喂数据断言）。

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

## 自检脚本（改完代码跑一遍，别靠肉眼）

都是纯 Node，不需要额外依赖；涉及浏览器的会自己拉一个 headless Chrome。

| 脚本 | 干什么 |
|---|---|
| `probe-resilience.js` | **连接韧性单测**：指数退避序列（3s→300s 封顶、500 次不放弃）、`probeUrl` 对 200/403/530/超时/连不上的判定。函数是从 `start-public.js` 里抠真身，不复制代码 |
| `probe-profit.js` | **利润接口诊断**：真实打美客多 API，量运费接口延迟、看返回结构（当初就是它查出 `/shipments/{id}/costs` 不返回币种） |
| `probe-profit-api.js` | **利润接口端到端**：登录 → 打接口 → 校验「运费缺失」是否为 0、利润是否算得出来、持久缓存是否落库 |
| `probe-profit-audit.js` | **利润逐行对账**：把明细自己加一遍，验证「收入−销售费−运费−税费−成本 = 利润 = 合计」分毫不差，并打印亏损行/运费为 0 行/未算出行、利润 TOP5 与 BOTTOM5。**怀疑数字不对时先跑它** |
| `probe-order-units.js` | **单量 / 件数口径核对**：平台 `paging.total` vs 实抓数、取消单数、有效件数、全部件数、每单商品行数分布。后台件数对不上时跑它 |
| `probe-profit-products.js` | **取消单 + 产品出单统计（真浏览器）**：断言汇总卡单量/件数、取消单确实列在表里并置灰、产品卡片数、每张卡都有主图且真实加载、产品件数合计 = 有效件数、产品利润合计 ≈ 订单利润合计 |
| `probe-profit-range.js` | **任意区间抓取完整性**：`node probe-profit-range.js 2026-10-01 2026-10-17`，对比平台 `paging.total` 与实抓数，顺带报冷/热耗时 |
| `probe-profit-formula.js` | **单行算式验算**：打印某一行收入/销售费/运费/税额/成本/利润与汇率换算过程 |
| `probe-profit-currency.js` | **币种展示（真浏览器）**：断言三列巴币 + 两列人民币、合计人民币、每格悬停给出另一币种折算、无 console 报错 |
| `probe-smoke.js` | 逐视图冒烟：点遍 8 个视图，抓 console 报错 / 失败请求 / 空白页，并截 `shots/smoke-profit.png` |
| `probe-adsplit.js` | 广告单拆分的整数分配（15 项 + 1000 组随机压力） |
| `probe-ledger.js` | 广告账本冻结语义（跨天 final 永不再改 + 小时分摊守恒） |
| `probe-adsplit-ui.js` | 真浏览器悬停柱子读 tooltip，断言不出现半单 |
| `probe-push-auto-label.js` | **微信提醒的「已自动回复」标注**：纯渲染断言（全自动回复 / 部分 / 全没回 三种文案与标题，买家原文与规则名的 HTML 转义）+ payload 映射（命中/没命中/数字 id 对字符串 key）+ `?preview=1` 真实链路 |
| `sync-status.js` | **同步体检**（双击 `同步状态.bat`）：自动同步进程在不在 / 未提交几个 / 未推送几个（→ GitHub 是旧的）/ 未合入几个（→ 本地没跟上远端），并打印最近 8 条记录 |
| `git-autosync.js --once` | 手动跑一轮同步并强制 fetch+rebase 一次，排查用 |

```bash
node probe-resilience.js && node probe-profit-api.js && node probe-smoke.js
```

---

## 常见问题

**Q：站点打不开，Cloudflare 报错 1033？**
隧道在线但本地服务没起来。根因通常是 `server.js` 崩溃退出。本项目已加三层护栏（异常兜底 + 服务自愈 + 隧道重连）；若仍复现，查 `运行日志.txt` 里的 `[服务] 已退出，代码 X` 与堆栈。

**Q：抓取美客多超时 / 失败？**
国内需要代理。确认 `daily-search-config.json` 的 `proxy` 指向你本机的 Clash/Mihomo 混合端口（**端口是动态的**，去客户端「设置」里看当前值，不要照抄文档里的 7897）。

**Q：公网 530 / 1033，但本地 `127.0.0.1:3000` 好好的？**
这是隧道到 Cloudflare 边缘的连接断了，不是本地服务的问题。现在的自愈链路是：每分钟查 `/ready` + `/metrics` 连接数 + 真打一次公网地址，连续 3~5 分钟不健康就强杀隧道重连（指数退避）。先看 `运行日志.txt` 有没有这三行：`健康异常`（在抖）、`强制重启`（触发了自愈）、`健康探测已接管 ✓`（正常基线）。手动救急仍然是重跑 `启动公网服务.bat`。

**Q：`npm run public` 之后关掉黑窗口，站就下线了？**
是的，这是前台进程。要常驻请双击 `开机自启-开启.bat`（启动文件夹 + 看门狗，最多 60 秒自己回来），或用 `pm2` / `nssm` 注册成服务。

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
