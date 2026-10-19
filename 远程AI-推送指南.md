# 远端 AI 改完代码怎么自己 push（一次性配置，约 3 分钟）

## 为什么会一直叫你 push

`https://github.com/Yvonelam/ml-suite` 是**公开仓库**：任何 AI 都能 `git clone` 读到最新代码，
但**不能推**。远端 AI 改完文件后没有写权限，只能提示你「请 push」——它没错，是没钥匙。

本机的自动同步（`git-autosync.js`）只管**本机**的改动。它推得再勤，也推不了远端 AI 那边沙箱里的文件。

所以要做的事只有一件：**给远端 AI 一把只开这一个仓库的钥匙**。

---

## 方案 A · 给远端 AI 一个 Token（推荐）

### 第 1 步：在 GitHub 生成 Token

1. 打开 https://github.com/settings/personal-access-tokens/new
   （也可以点右上角头像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token）
2. 填写：
   | 字段 | 填什么 |
   |---|---|
   | Token name | `ml-suite-remote-ai` |
   | Expiration | 90 days（到期再生成一个，别选 No expiration） |
   | Repository access | **Only select repositories** → 只勾 `ml-suite` |
   | Permissions → Repository permissions → **Contents** | **Read and write** ← 只开这一个就够了 |
   | Permissions → **Metadata** | 会自动变成 Read-only，别管它 |

3. 点 Generate token，复制那串 **`github_pat_xxxxxxxx`**（**只显示一次**，关掉页面就再也看不到）

> 这把钥匙只能动 `ml-suite` 这一个仓库的内容，碰不到你的其它仓库；随时可以在同一页面 Revoke 掉。

### 第 2 步：交给远端 AI

把下面整段发给它（把 `github_pat_xxx` 换成你刚复制的）：

```text
把这个仓库的写权限配好，以后你改完代码自己提交并推送，不要再叫我 push。

仓库：https://github.com/Yvonelam/ml-suite  （main 分支）
Token：github_pat_xxxxxxxxxxxxxxxx

请执行：
1) 如果还没克隆：
   git clone https://github_pat_xxxxxxxxxxxxxxxx@github.com/Yvonelam/ml-suite.git
   cd ml-suite
2) 设好提交署名（必须是这个）：
   git config user.name "Yvonelam"
   git config user.email "kimilam668@gmail.com"
3) 开始改之前先拉一次，避免基于旧代码改：
   git pull --rebase origin main
4) 改完后自己提交并推送，用中文写清楚改了什么：
   git add -A
   git commit -m "fix(利润): 这里写具体改了什么"
   git push origin main

以后每一轮改完都执行第 3、4 步。不要问我怎么 push，也不要让我手动操作。
如果 push 报 non-fast-forward，先 git pull --rebase origin main 再 push 一次。
```

### 第 3 步：验证通了

改完第一次之后，本机双击 **「同步状态.bat」**，看到这两行就对了：

```
未推送   0 个  GitHub 上已是最新
未合入   N 个  远端有新代码，本机工作区干净时会自动合入
```

「未合入」那一行会在 2 分钟内自己变成 0 —— 本机已经会自动把远端 AI 推的代码合进来了（见下面「本机这一侧已经改好」）。

---

## 方案 B · 零配置：让远端 AI 走 GitHub 网页提交

如果那个 AI 有「GitHub 连接器 / MCP」，或者你只是自己偶尔在网页上改几行：

- 打开 https://github.dev/Yvonelam/ml-suite （把 GitHub 仓库页的域名 `github.com` 换成 `github.dev`，会直接在浏览器里打开 VS Code）
- 改完在左侧源代码管理面板点 ✓ 提交 → 再点 Sync Changes

**这种提交直接在 GitHub 上发生，不存在 push 不上去的问题**，本机 2 分钟内自动合入。

适合：改几行文案、改配置。不适合：大范围重构（网页编辑器不方便跑测试）。

---

## 方案 C · 远端 AI 只给 patch（没有 shell / 不能联网时）

远端 AI 把改动输出成 diff，你在本机执行：

```bash
cd E:\ML-suite
git apply --verbose 改动.patch
```

`git apply` 之后工作区就有改动了，**本机自动同步会在 25 秒后帮你提交并推送**，你什么都不用做。

这是最保守的方式：钥匙始终不离开你的电脑。缺点是每次都要手动转一手文件。

---

## 本机这一侧已经改好（不用你操作）

| 能力 | 以前 | 现在 |
|---|---|---|
| 本地改动 → GitHub | 自动推 ✓ | 自动推 ✓ |
| 远端改动 → 本机 | **不会拉**（只能等下次自己改代码时顺带 rebase） | 工作区干净时**每 2 分钟自动 fetch**，远端领先就 `pull --rebase` 合入 |
| 自动同步进程挂了 | 没人管，静默失效 | 启动器**每 60 秒体检**，死了原地拉起（看门狗也管一份） |
| 看状态 | 只能翻 同步日志.txt | 双击 **「同步状态.bat」**：进程在不在 / 未提交 / 未推送 / 未合入 |

排查顺序永远是：双击「同步状态.bat」→ 看「自动同步」是否在运行 → 看「未推送」有没有在涨。

---

## 安全提醒

- Token **只放远端 AI 的运行环境**，绝对不要写进这个仓库的任何文件（仓库是公开的，写进去等于公开）
- 泄漏了就去 https://github.com/settings/tokens 找到它点 **Revoke**，再生成一个新的
- 不要给 `repo` 全权限的老式 token，用 fine-grained 只开 `ml-suite` + `Contents: Read and write`
- 提交署名统一 `Yvonelam <kimilam668@gmail.com>`，这样 GitHub 上能看到是你
