# 设计系统与改版须知

> 这份文档是给协作 AI 看的。**要改界面排版 / 美术风格之前，先完整读一遍。**
> 只改功能、不动样式的任务，可以只扫一眼「🚫 绝对不能碰」那一节。

---

## 0. 先搞清楚：真正在用的界面只有一个

**所有在用的界面都在「主工作台」里** —— `public/index.html` + `public/style.css` + `public/app.js`，
**一套结构 + 三层可选主题**（见 0.1），7 个视图：`#hub`（概览）`#rank`（关键词排名）`#orders`（订单）`#questions`（问答）
`#claims`（售后）`#ads`（广告）`#box`（箱唛）。

**改版 90% 的情况下只需要动 `public/style.css` 一个文件。**

| 位置 | 状态 | 说明 |
|---|---|---|
| `public/index.html`<br>`public/style.css`（约 500 行）<br>`public/app.js` | ✅ **在用** | 主工作台。7 个视图共用这一套结构，配色由三层主题表叠加 |
| `public/search/*`（独立的 1500 行 CSS + app.js） | ⚠️ **已退役** | 打开 `/search/` 会立刻执行 `location.replace('../index.html#rank')` 跳回工作台的「关键词排名」视图 |
| `public/boxmark/*`（独立的 300 行 CSS + app.js） | ⚠️ **已退役** | 同理，`/boxmark/` 会跳到 `#box` |

也就是说：**那两个独立页的 CSS，目前在任何一个真实页面上都不会生效**。

### 0.1 五套美术风格 + 五版 Logo（改版别漏）

界面有 **5 套可切换的美术风格**，点侧边栏左上角 Logo 弹出菜单选择，选择记在 `localStorage.mlsuiteTheme`：

| key | 名称 | 由什么决定 |
|---|---|---|
| `classic` | 经典深色 | `style.css` 的 `:root`（三张主题表都 `disabled`） |
| `mist` | 柔雾玻璃 | 只开 `theme-mist.css` |
| `glass` | 彩色毛玻璃 | mist + color 都开（`theme-color.css` 建立在 `theme-mist.css` 之上） |
| `gold` | 典藏金 | mist + gold 都开（`theme-gold.css` 同样建立在 `theme-mist.css` 之上） |
| `motion` | 动态玻璃 | mist + color + motion 都开（`theme-motion.css` 排最后，复用 G 的配色材质，只把背景换成循环视频） |

**Logo 跟着主题一起换**，五版成品并列挂在 `.brand-logo` 里，靠 `html[data-theme=…]` 切透明度，不切 `src`（所以不闪白、不会 404）：

| 主题 | 文件 | 观感 |
|---|---|---|
| `classic` | `public/ml-suite-mark-classic.svg` | 近黑芯片底 + 青紫渐变描边 + 青紫渐变 ML |
| `mist` | `public/ml-suite-mark-mist.svg` | 淡雾白磨砂底 + 石板蓝灰 ML + 顶部高光 |
| `glass` | `public/ml-suite-mark-glass.svg` | 紫→粉渐变底 + 白 ML + 玻璃高光 |
| `gold` | `public/ml-suite-mark-gold.svg` | 暖褐近黑底 + 烫金渐变 ML + 双圈细金描边 |
| `motion` | `public/ml-suite-mark-motion.svg` | 紫粉动态渐变底 + 三道流动波纹 + 白 ML |

**典藏金专属素材**：`public/gold-ridges.svg` 是一整幅山水，由 `theme-gold.css` 挂在 `.liquid-bg::before`（贴底，`height:min(58vh,520px)`），
`::after` 再压一圈暗角；星点则是 `.liquid-bg` 背景栈里的十几个 1px `radial-gradient`。

画面从后往前一共这些层，**顺序不能乱**：

1. **星空**（CSS 渐变，只在上半屏，中间让给天光）
2. **五层山**（`f5`→`f1`，越远越亮、越近越黑，靠明度差做纵深；每层一条金脊线 `stroke=url(#rim)`）
3. **三道雾带**（`radialGradient#mist` 的椭圆，压在山与山之间）
4. **湖面**：水底色 `#wtr` → **山峦倒影**（把远山/次远山沿水天线 `translate(0,876) scale(1,-1)` 翻折，再用 `clipPath#wc` 裁进水面）→ `#sink` 让倒影越往下越沉 → 软光斑 `#glow` 叠出水面反光 → 水天交界亮线 `#hzn` → 涟漪（近处短而亮、远处长而淡）

光线逻辑照着一张「黄昏山脊」参考图做的：**顶上天光暖、中间压暗、山脊处贴地平线暖雾、剪影本身近黑**。
这四点缺一个就会变成「一片糊的棕色」而不是画册感；**水面少了倒影就永远是块黑板**。

面板比另外两套更实（`rgba(44,33,21,.90) → rgba(12,9,6,.96)`），因为背景是整幅山水，面板再透就会把山脊线漏到图表底下
（参考图里的信息块本身也是近不透明的深色板 + 细金边）。页标题 `.ph2 h1` 做成烫金渐变文字（`background-clip:text`，用 `@supports` 兜底）。

**动态玻璃的素材与取舍**（`theme-motion.css`）：

- 背景视频 `public/bg-dynamic.mp4`（1280×672 / 13.3 秒 / 849KB），是从一段 4K、8 分钟、233MB 的 macOS Monterey 动态壁纸里截的。
  **做法是「正放 + 倒放」拼接**：正放 6.65 秒后再倒放同一段，首尾天然相接，不需要调交叉淡化。
  重新生成（换片段只要改 `-ss` 的秒数，改快慢只要改 `setpts` 的分母）：

  ```bash
  # 1) 截 12 秒 → 加速 1.8 倍（setpts 分母越大越快）→ 压到网页尺寸 + 30fps
  #    -ss 118 这段是量出来的「运动最强」区间，别随手换
  ffmpeg -ss 118 -t 12 -i 源视频.mp4 -vf "scale=1280:672,setpts=PTS/1.8,fps=30" -an \
    -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart tmp.mp4
  # 2) 正放 + 倒放，做成无缝循环
  ffmpeg -i tmp.mp4 -filter_complex \
    "[0:v]split[a][b];[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];[a][r]concat=n=2:v=1[v]" \
    -map "[v]" -an -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart public/bg-dynamic.mp4
  # 3) 首帧当 poster
  ffmpeg -i public/bg-dynamic.mp4 -frames:v 1 -vf "scale=1280:-1" -q:v 5 public/bg-dynamic-poster.jpg
  ```

  验证接缝别用眼睛看：抽第 0 帧和最后一帧比 PSNR，**接缝的 PSNR 应该高于普通相邻帧**（实测接缝 46.25dB vs 相邻 41.05/41.50dB）才是无缝。

- **「动感」要量化，不能凭感觉调**。用法是把画面缩成 320×168、`tblend=difference` 取相邻帧差、`signalstats` 输出 `YAVG`，
  这个均值就是运动强度：

  ```bash
  ffmpeg -ss 5 -t 3 -i 源视频.mp4 -vf \
    "fps=2,scale=320:168,tblend=all_mode=difference,signalstats,metadata=mode=print:file=-" \
    -f null - 2>&1 | grep YAVG
  ```

  实测原片各时段差异很大（t=5s→1.26 / t=60s→0.94 / t=120s→**2.22** / t=240s→1.22 / t=420s→1.54），
  第一次随手取的 t=330 只有 1.68，成品 1.43。换成 t=118 起 + 加速 1.8× 后，成品运动强度升到 **3.51**（2.45 倍）。
- **模糊半径会直接毁掉动感**。9px 时波浪边缘的细节全被抹平，而人眼就是靠这些边缘判断快慢——片子的实际运动强度只涨了 30%，
  观感却像慢了一倍。现在用 `blur(5px)`（手机 `4px`）。**调模糊前先想清楚：这是背景，不是前景文字，不需要那么糊。**

- **视频用 `data-src` 而不是 `src`**，只有第一次切到这套皮肤才下载，其它四套皮肤一个字节都不下。
  播放控制全在 `app.js` 的 `syncBgVideo()`：切走暂停、切回续播、`prefers-reduced-motion` 下不自动播、标签页隐藏时暂停。
- **「默认隐藏」写在 `style.css`，不能只写在 `theme-motion.css`** ——主题表被 `disabled` 时它的规则一起失效，
  视频会以行内元素露在背景左上角（探针抓到过这个 bug）。
- **性能上最重要的一条**：不在面板上用 `backdrop-filter`，改成**把视频整层模糊一次**（`filter:blur(5px)`）。
  背景是逐帧变化的视频，85 个元素挂 `backdrop-filter` 等于每帧重算 85 次模糊；模糊一层视频只需一次。
  实测把 `backdrop-filter` 从 85 个降到 5 个（只留 `.modal/.account-menu/.account-dialog/.theme-menu` 这几个浮层）。
  必须用 `html[data-theme=motion] *{backdrop-filter:none!important}` 全域压——这些规则散落在三张表里，逐个列选择器一定漏。

⚠️ 五版必须保持**同一构图**（都是 `256×256`、圆角 `rx=66`、居中 `ML` 字标、字号 `104`／`letter-spacing -6`／基线 `y≈132`），只换材质和颜色 —— 否则切风格时会像换了家公司。

改主题色板时**记得同步改 Logo**，否则会出现「界面变蓝、Logo 还是紫的」。改完必须跑：

```bash
node probe-theme-logo.js     # 65 项：五张是否都加载成功、每套主题下是否只有对应那张可见、刷新是否记得、有无 404
                             # 另外验动态玻璃的背景视频：懒加载、自动播放、currentTime 真的在走、切走是否暂停、切回是否重复下载
node probe-theme-shot.js gold shot-gold   # 设计用截图：概览顶部 / 概览底部 / 箱唛裁切 / 主题菜单 / 放大页标题
```
`public/index.html` 里既没有 `<iframe>`，也没有 `<link>` 指向它们 —— 它们只是还留在仓库里的历史文件。

所以：

- ✅ **改版只改 `public/style.css`**（必要时配 `public/index.html` 的结构）
- 🚫 **不要去动 `public/search/` 和 `public/boxmark/`** —— 改了在页面上看不见，纯属白费功夫
- ⚠️ 如果你**确实**想恢复那两个独立页、或者想让它们也换新皮肤，那是一个**单独的、更大的任务**，
  要单独提出来（并且先确认那两行 `location.replace` 是否保留）

> 另外注意：那两个退役页里也各自定义了 `--bg` / `--cyan` / `--violet`，取值和主工作台**不一样**。
> 别被它们误导，以为改一处会全站变色。

---

## 1. 主工作台 · 布局骨架

```
┌────────────┬──────────────────────────────────────────────┐
│            │  header.tb                    顶栏 56px sticky │
│  aside     ├──────────────────────────────────────────────┤
│  .side     │  section.view.on                             │
│  228px     │    （同一时刻只显示一个视图）                  │
│  sticky    │                                              │
│            │                                              │
│  .brand    │                                              │
│  #nav      │                                              │
│  （导航）   │                                              │
└────────────┴──────────────────────────────────────────────┘
                    [ .dock ] ← 底部悬浮操作条（可选，fixed）
```

关键类名：

| 类名 | 作用 | 关键样式 |
|---|---|---|
| `.app` | 最外层网格 | `display:grid; grid-template-columns: 228px 1fr` |
| `.side` | 左侧边栏 | `sticky; height:100vh; background:var(--s1); border-right:1px solid var(--bd)` |
| `.brand` | 左上 Logo 区 | 方块 logo 用 `linear-gradient(140deg,var(--cyan),var(--violet))` |
| `#nav` | 导航列表 | 里面的 `<a data-go="...">` 每项含一个内联 `<svg>` 图标 |
| `.tb` | 顶栏 | `sticky; height:56px; backdrop-filter:blur(12px)`，背景是**硬编码**的 `#09090bf0` |
| `.view` | 视图容器 | `display:none`；加 `.on` 才显示，带 `fade` 入场动画 |
| `.ph2` | 页面标题区 | `h1` 22px / `p` 用 `--mut` |
| `.dock` | 底部悬浮条 | `position:fixed; bottom:18px;` 居中 |

**视图切换契约（不能改）**：`section.view` 的 id 必须是 `v-hub` / `v-rank` / `v-box` / `v-orders` / `v-questions` / `v-claims` / `v-ads`；
导航项靠 `data-go="hub|rank|box|orders|questions|claims|ads"` 对应；切换只切 `.on` 类。
这三者是 JS 的硬契约，**改排版时一个都不能动**。

---

## 2. 主工作台 · 设计变量（`public/style.css` 的 `:root`）

```
背景层次（由深到浅）
  --bg   #09090b   页面最底
  --s1   #0e0e11   侧边栏 / 次级面板
  --s2   #131316   卡片主背景
  --s3   #1a1a1f   卡片内嵌块 / 悬浮层

边框
  --bd   #242429   常规边框
  --bd2  #31313a   强调边框
  --line #242429   分隔线（与 --bd 同值）

文字
  --ink  #ededf0   主文字
  --tx2  #a1a1aa   次要文字
  --mut  #71717a   弱化文字 / 占位

语义色
  --ac   #3b82f6   主操作蓝
  --ok   #22c55e   成功 / 上涨
  --bad  #ef4444   错误 / 下跌
  --warn #f59e0b   警告

品牌色（科幻感来源）
  --cyan   #38bdf8  电光青
  --violet #818cf8  星紫

玻璃材质
  --glass               rgba(255,255,255,.045)
  --glass-strong        rgba(255,255,255,.07)
  --glass-border        rgba(255,255,255,.10)
  --glass-border-hover  rgba(56,189,248,.35)

字体
  --f  -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif
```

**当前是深色主题**。若要做浅色主题，**必须整套变量一起替换**（只改 `--bg` 会出现白底白字）。

---

## 3. 主工作台 · 主要组件类名

| 分类 | 类名 |
|---|---|
| 卡片 | `.card`（`background:var(--s2); border:1px solid var(--bd); border-radius:12px`） |
| 指标卡 | `.kpi`（内含 `.spk` 迷你走势图，用 `data-v` 属性喂数据） |
| 工具入口 | `.tool-card`（概览页的四个大卡，本身就是 `<a data-go="...">`） |
| 两列布局 | `.g2` / `.gl2` / `.ar2` |
| 表单 | `.fld` / `.field` / `.grp` |
| 按钮 | `.btn`（`.btn.y` 主按钮 / `.ghost` 幽灵按钮 / `.clear-btn`） |
| 开关 | `.toggle-switch` / `.toggle-slider` / `.toggle-label` |
| 时间选择 | `.time-picker` / `.time-colon` |
| 状态提示 | `.config-status`（`.success` / `.error` / `.loading` / `.autosave`） |
| 徽标数字 | `.nb`（导航上的红点计数） |
| 表格 / 列表 | `.clist` / `.cthread` / `.cbag` / `.cwait` |
| 图表 | `.hchart` / `.bar` / `.heat` / `.heat-wrap` |
| 空状态 | `.empty` / `.error-card` |
| 箱唛页 | `.dropzone` / `.box-panel` / `.box-stats` / `.box-results` |
| 广告页 | `.ads-bar-hint` |
| 底部条 | `.dock` / `.dock-info` |

> 完整清单直接从 CSS 里 grep 就行：`grep -oE '^\.[a-z][a-z0-9-]+' public/style.css | sort -u`
> 注意本项目的 CSS 大量使用**单行压缩写法**（一条规则写一行），改的时候保持这个风格，别重排。

---

## 4. 🚫 改版时绝对不能碰的东西

**这是改版最容易翻车的地方 —— 把类名/id 改漂亮了，功能直接挂掉。**

1. **JS 依赖的 id 一个都不能删、不能改名。**
   主工作台有 **172 个** id 被 `public/app.js` 用 `$('#xxx')` 引用；关键词排名工具有 **106 处** `getElementById`。
   清单随时可以现场生成：

   ```bash
   node handoff.js dom
   ```

   它会列出「必须保留的 id」和「可以自由改的 id」。**改 HTML 结构前先跑一遍。**

2. **`section.view` 的 id**（`v-hub` / `v-rank` / …）与 **`data-go`** 属性 —— 布局骨架可以改，这两个名字不能动。

3. **`.on` 类语义** —— JS 靠 `classList.toggle('on', ...)` 切换视图和导航高亮。你可以改 `.on` 的**样式**，但不能改这个名字。

4. **内联 `<svg>` 图标** —— 用 `stroke="currentColor"` 跟随文字色。换图标可以，但别把 `viewBox` 和 `currentColor` 弄丢。

5. **不要引入任何外部资源**：
   ❌ CSS 框架（Tailwind / Bootstrap）❌ 预处理器（Sass/Less）
   ❌ 构建工具（Vite / Webpack）❌ npm 前端依赖 ❌ 外部字体 CDN（要能离线跑）
   一切靠手写原生 CSS。

6. **不要动 `public/vendor/`**（里面是本地化的 pdf-lib / pdf.js）。

7. **注意 `.tb` 顶栏的背景色是硬编码的 `#09090bf0`**，不是变量。整体换深浅色时记得同步处理它（改版顺手把它也换成变量是好习惯）。

---

## 5. 推荐的改版流程

改版是**风险最高**的一类改动（牵一发动全身），所以流程比改功能严格：

1. **先出方案，不要直接写代码。** 方案里要有：
   - 打算改哪些文件（精确到文件）
   - 新的 `:root` 变量表（现值 → 新值，逐个列出）
   - 逐区块的改法（侧边栏 / 顶栏 / 卡片 / 表格 / 按钮 …）
   - 哪些地方会动到 HTML 结构，以及**怎么保证 JS 依赖的 id 不受影响**
   - 你判断的风险点
2. **等我确认方案后再给 patch。**
3. **一次只改一个层级**（比如先只调颜色变量，再动布局）—— 别一次性全上，出问题不好回退。
   好消息是：在用的界面只有一套结构，所以「改一处就全站生效」这次是成立的；
   但**配色分布在 `style.css` 的 `:root` + 两层主题表里**，动颜色要三处一起看（见 0.1），Logo 也要跟着改。
4. **改完存快照**：`node version.js save "改版：xxx"`。我这边不满意可以一键回滚，回滚前还会自动备份。

---

## 6. 想先看现状长什么样

让 AI 知道当前视觉长什么样，最好给它截图。项目里有现成的无头截图能力，直接跑：

```bash
node handoff.js shots
```

会把主工作台各个视图截图到 `shots/` 目录，把这些 PNG 一起上传给 AI 即可。
