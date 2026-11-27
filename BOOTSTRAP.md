# BOOTSTRAP · 用命令行把 dshplug 仓库在多台终端之间同步

> 目标：**先手工打通**「改源码 → 推到 Git → 另一台拉下来 → 装好能用」这条链，
> 不依赖任何插件面板，也不依赖 `dsh-synchub` 的自动同步（那是后续才做的事）。
> 本文是**操作手册**；设计理由看 [`dsh-synchub/ADR.md`](<dsh-synchub/ADR.md>)，插件总览看 [`README.md`](<README.md>)。
>
> 环境基线（写死，避免以后腐烂）：Windows / PowerShell 5.1+ / DSH `0.2.2-rc.1`（`desktop` profile）/
> 仓库根 `C:\dsh\dshplug` / 远端 `github.com/mengfanchun2017/dshwp-plugin.git` 分支 `master`。
> 日期：2026-11-12。

---

## 0. 先纠正三个坑（你刚踩到的）

### 0.1 `./plugpush.sh` 不存在

仓库里是 **PowerShell 脚本 `plugpush.ps1`**，没有 `.sh`。
你看到的报错 `无法将"./plugpush.sh"项识别为 cmdlet…` 就是因为文件名写错：

```powershell
PS C:\dsh\dshplug> .\plugpush.sh     # ✗ 不存在
PS C:\dsh\dshplug> .\plugpush.ps1 -List    # ✓ 正确
```

### 0.2 聊天框里输入 `!` 不会执行命令

DSH **没有**「在对话输入框里以 `!` 开头执行 shell 命令」的功能——那是 Claude Code / aider 的习惯。
（源码级证据：`app.asar` 里 `startsWith("!")` 只出现在「实验标志取反」和 glob 否定两处，与命令执行无关。）
所以你打 `!` 没反应是正常的，不是坏了。

**正确位置：右侧栏的「终端」标签页**（官方包 `dsh-client-ui-sidebar-terminal`，源码注释：
*Open the execution environment's default shell in the Session's current working directory from the Web sidebar*）。
它开的是 **PowerShell**，工作目录 = 当前会话的工作目录。若当前会话 cwd 不是 `C:\dsh\dshplug`，先 `cd`：

```powershell
cd C:\dsh\dshplug
```

> 没有右侧终端标签时：右侧栏 → 终端（或「创建终端」/ `openTerminal`）。
> 也可以完全绕开 GUI，直接用**外部 Windows Terminal / PowerShell 窗口**跑下面所有命令 —— 本文的命令两边通用。

### 0.3 调用 `.ps1` 的正确写法

本机执行策略 `LocalMachine = RemoteSigned`，本仓库脚本可**直接**用 `.\脚本.ps1` 或 `& 路径\脚本.ps1` 运行，
不需要 `powershell -ExecutionPolicy Bypass`（实测 `& .\plugpush.ps1 -List` 正常输出）。

| 写法 | 是否可用 | 说明 |
|---|---|---|
| `.\plugpush.ps1 -List` | ✓ | 已在 `C:\dsh\dshplug` 下 |
| `& C:\dsh\dshplug\plugpush.ps1 -List` | ✓ | 任意目录，最稳，推荐 |
| `.\plugpush.sh` | ✗ | 文件不存在 |
| `! .\plugpush.ps1` | ✗ | `!` 不是 DSH 的命令前缀 |
| `bash plugpush.sh` | ✗ | 没有这个文件，且本机不是 bash 环境 |

**参数里的中文说明要用双引号**；`-All` / `-List` / `-DryRun` / `-Tag` 是开关，不带值。

---

## 1. 三条命令的分工（先背下来）

| 命令 | 作用 | 会不会写远端 |
|---|---|---|
| [`install.ps1`](<install.ps1>) | 把 `list.json` 里的插件以 `link:`（目录 Junction）**注册进本机 DSH profile** | 否，纯本机 |
| [`plugpush.ps1`](<plugpush.ps1>) | 把本地改动 **commit + push** 到 Git 远端 | **是** |
| `git pull` | 从远端把别人的改动拉到本机 | 否，只拉 |

一句话：**改源码即时生效（Junction），默认什么都不上行；要同步给别人，才显式跑 `plugpush.ps1`。**

---

## 2. 完整流程：A 机改 → B 机恢复（手工打通）

### 第 0 步（每台机器只做一次）：前置条件

```powershell
# 1) 两台机器必须把仓库放在【完全相同的绝对路径】（link: 写死绝对路径，见 ADR-002 / ADR-008）
#    这里统一为 C:\dsh\dshplug

# 2) 检查 Git 可用
git --version

# 3) 本机仓库级设置（MinGit 的 schannel 会报 SEC_E_NO_CREDENTIALS，必须换 OpenSSL）
git -C C:\dsh\dshplug config http.sslBackend openssl

# 4) 认证：交给 dsh-gitok（GCM + Windows 凭据管理器），不要手工填 PAT
#    在 DSH 里说一句「初始化 git 认证」即可，等价于跑：
#      gitok_bootstrap                       # S0 自检 → S1 幂等配 helper → S2 登录 → S3 验收
#    它做的事：把 credential.helper 指向 GCM，密钥由 GCM 写进 Windows 凭据管理器
#    （DPAPI 加密，用户态可见、离开本机不可用），令牌全程不经过我和聊天。
#
#    为什么不再推荐手贴 PAT：
#      · PAT 会以明文留在命令历史/聊天记录里，且永不过期，泄露即长期有效
#      · 凭据管理器里是 LegacyGeneric 明文条目，换机器要重贴，容易贴错账号
#      · GCM 支持设备流刷新，过期自动续，不用记"这个 token 什么时候到期"
#
#    要确认现在是什么状态：gitok_doctor（只读体检，令牌只报类型与长度）
#    要端到端验证：          gitok_verify（对目标仓库跑 git ls-remote）
#    要换掉旧凭据：          gitok_rotate（先预检通路，断网时不会误删可用凭据）
#
#    历史备注：SSH（git@github.com:）在本机实测不通，所以这里统一用 HTTPS。
#    现在有了 GCM 也不必回头用 SSH —— HTTPS + GCM 已经不需要记密码。
```

> 网络是间歇的：直连可能 `Connection was reset`，代理 7897 可能 `TLS connect error`。
> 单次失败不代表不通，**先重试 2~3 次**再判断。判断标准：`git -C C:\dsh\dshplug ls-remote --heads origin` 能返回 ref。

### 第 1 步（A 机）：看状态

```powershell
cd C:\dsh\dshplug

git status -sb                                        # 本地改动 / 分支
git rev-list --left-right --count origin/master...HEAD # 左=落后, 右=领先
& .\plugpush.ps1 -List                               # 清单里有哪些插件（含 dev）
& .\install.ps1 -Check                               # 体检：link-junction / orphan / missing …
```

### 第 2 步（A 机）：改代码 → 预览 → 推

```powershell
cd C:\dsh\dshplug

# 必做：先预览会提交什么（不 commit、不 push、不需要远端）
& .\plugpush.ps1 -All "说明这次改了什么" -DryRun

# 确认列表无误后真正推送
& .\plugpush.ps1 -All "说明这次改了什么"

# 只推某一个插件（不推根级文件、不推别的插件）
& .\plugpush.ps1 dsh-synchub "增加 ADR"

# 发布一个版本点时打 tag（用该插件 package.json 的 version）
& .\plugpush.ps1 dsh-synchub "v0.3.2" -Tag
```

`-All` 现在的语义（**2026-11-12 已修**）：`list.json` 里**登记过的所有插件目录（含 `status: dev`）+ 根级文件**
（`list.json` / `install.ps1` / `plugpush.ps1` / `.gitignore` / `.gitattributes` / `README.md` / `BOOTSTRAP.md`，
并对根目录其它已跟踪文件做兜底收集）。之前过滤 `status -eq 'active'`，会漏掉 `dev` 插件和根文件，已废弃。

> ⚠️ `git status` 可能混着**不是本次要提交的改动**（例如你自己改的 `cordis.patch.yml` / `index.js`）。
> 推之前一定看一眼 `-DryRun` 输出的清单；整目录 stage 会把该插件下所有改动一起带上。
>
> `archive/`（冻结归档区，按全局规则）是**给人看的项目档案**，不属于 `list.json` 登记目录，
> `plugpush.ps1 -All` 的根级兜底只收「仓库根的直接文件」、不收子目录，所以**不会**把它误推；
> 要把它纳入版本库需显式 `git add archive/`。`archive/*/packages/` 下的 `.zip`/`.tgz` 被根 `.gitignore` 忽略，
> 只在本机存在，跨机要手动传压缩包。
### 第 3 步（B 机 / 另一终端）：拉取 + 安装

```powershell
cd C:\dsh\dshplug

# 1) 拉（比 pull 更保守：不自动合并，落后就明确报错）
git fetch origin
git status -sb
git merge --ff-only origin/master
# 或者直接：git pull --ff-only

# 2) 生成 link: Junction —— 只有这三种情况才需要：
#    ① 新机器第一次  ② 新增/删除了插件  ③ list.json 改了
& .\install.ps1

# 3) 完全退出 DSH 再打开（首次加载新 bundle 必须；之后改源码不用）

# 4) 验收
& .\install.ps1 -Check      # 期望所有 active 插件都是 link-junction
git log -3 --oneline
```

**日常改代码不用重跑 `install.ps1`**：`link:` 是目录 Junction，文件怎么替换都透过链接读，保存即生效。
（`file:` 硬链接会在「删除+重建」保存时断链，所以本仓库坚持用 `link:`。）

### 第 4 步（B 机改了东西，回传给 A）

在 B 上重复第 2 步，A 上重复第 3 步。**任何时刻只让一台机器往同一分支推**；
两边都改过就先 `git fetch` 看谁领先，`--ff-only` 会拒绝非快进，别用 `force`。

---

## 3. 场景速查

| 场景 | 命令 |
|---|---|
| 我在这台改了代码，想让另一台拿到 | `& .\plugpush.ps1 -All "msg" -DryRun` → `& .\plugpush.ps1 -All "msg"`；另一台 `git pull --ff-only` |
| 另一台刚推过，我这边开工前 | `git fetch origin` → `git status -sb` → `git merge --ff-only origin/master` |
| 只想看会提交什么，不想动远端 | `-DryRun`（上面第 2 步第一条） |
| 只推一个插件 | `& .\plugpush.ps1 dsh-synchub "msg"`（不带 `-All`） |
| 新机器第一次接入 | `git clone <url> C:\dsh\dshplug` → `& .\install.ps1` → 完全退出 DSH 再打开 |
| 新增了一个插件目录 | 改 `list.json` → `& .\install.ps1 -Only <名字>` → `& .\plugpush.ps1 -All "新增 X"` → 另一台 `pull` + `install.ps1` |
| 检查插件装好没 | `& .\install.ps1 -Check`（全绿 = 「全部为 link: 形态且已安装」；`orphan` = 有残留链接但无依赖声明，DSH 不加载，重装可修。`dev` 插件显示 `missing` 是正常的，不计入汇总） |
| 看当前同步面板状态 | 在 GUI 侧边栏「同步中心」看；**终端里 `curl /api/dsh-synchub/status` 会 401**（要浏览器会话 cookie），别用它判断 |
| 推失败 / 报落后 | 先 `git fetch origin` + `git merge --ff-only origin/master`，再重跑 `plugpush.ps1`；不要 `push -f` |

---

## 3.1 改了什么要不要重启（2026-11-27 实测，源码级）

**结论：桌面端现在改宿主半源码也不用重启。** 但这是**配置出来的**，不是默认的，所以先把边界写死。

| 改了什么 | 桌面端（desktop profile） | 其它 profile / CLI |
|---|---|---|
| `client.js`（浏览器半） | 应用窗口 `Ctrl+R` | 刷新页面 |
| `cordis.patch.yml` 的 `config:` | **不用重启**（HMR 监听 patch → remount 该行） | 同上 |
| `lib/index.js` 等宿主半源码 | **不用重启**（已配 `hmr.root`） | **要重启**（`root: []`） |
| `package.json` 的 `exports` / `main` / `dsh.*` | 要重启 | 要重启 |
| 新增依赖 / 装新插件（`install.ps1`） | 要重启（首次装载） | 要重启 |
| 改插件 `version` / `engines.dsh` | 要重启 | 要重启 |

### 为什么（源码级）

- HMR 在桌面端**是启用的**：`dsh-desktop-host/lib/index.js` 调 `runProfile(...)` → `dsh/src/profile-boot.ts` 里 `hostCtx.provide('profileContext', ...)` → base 组合包 `cordis.patch.yml` 的 `hmr` 行 `disabled: !!js "!ctx.get('profileContext')"` 为 false。
- 但 base 组合包把该行写死 `config: { root: [] }`，注释原文是 "Profile configuration reloads by default; module roots are opt-in"。`root: []` = **只监听配置**（`profile/package.json`、profile 与 home 两级 `cordis.patch.yml`），**不监听任何源码目录**。这就是「改源码要重启」的根因，是默认行为不是 bug。
- 每次 recompose 时 `Hmr.reconcileProfile()` 会比对 **profile 目录 + 所有 `link:` 目标**（`profileRoots()` 读 `node_modules` 里的符号链接），所以只要触发一次 recompose，link: 插件的磁盘改动就会被热替换。
- 本仓库插件全部是 `link:` Junction（`install.ps1 -Check` 全绿可证），所以只要让 watcher 能「看见」源码目录即可。

### desktop profile 已做的配置

`~/.dsh/profiles/desktop/cordis.patch.yml` 末尾（2026-11-27 加，备份 `.bak-hmr-20261127-211014`）：

```yaml
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  config:
    base: "file:///C:/dsh"
    root:
      - "dw-plugin/dsh-synchub"
      - "dw-plugin/dsh-getbrain"
      - "dw-plugin/dsh-gitok"
      - "dw-plugin/dsh-larkcli"
      - "dw-base/demo-rag/dsh-rag"
```

- `root`/`base` 是**启动期**配置（HMR 插件 apply 时建 watcher）→ **改完要完全退出 DSH 再打开**，之后就不用了。
- **不能写成 `root: ["C:/dsh/dw-plugin"]`**（2026-11-27 实测踩到）：base 留默认（profile 目录）时，chokidar 吐出的相对路径带一串 `..`，`dsh-hmr` 用默认 `ignored` 的 `**/.*` 去匹配，picomatch 4.0.7 把反斜杠当转义符 → profile 目录之外的文件**全被忽略**，watcher 静默不触发（实测：等 4 秒无事件）。
- 把 `base` 指到仓库父目录后路径不再有 `..`，但此时反斜杠路径下 `**/.*` 又**什么都不匹配**，所以 `.git`/`node_modules` 必须靠「不放进 `root`」排除。已实测五个插件目录内无点文件/点目录/node_modules。
- `base` 也不能写 `C:/dsh`：`new URL('C:/dsh', baseUrl)` 会把它当 scheme `c:`，`fileURLToPath` 直接报错。必须写 `file://` URL。
- 新增自研插件时，往 `root` 里加一行 `<父目录>/<插件目录>` 即可（不要图省事直接写仓库根）。
- 换机器/换仓库位置时只改这两行路径。

### 验证（桌面端看不到 HMR 日志）

`hmr` 的 `watching [...]` / `reload plugin ...` 走 Cordis logger → 宿主子进程 stdout → Electron 主进程 stdout，**打包应用里不落盘**（`~/.dsh/logs` 与安装目录 `debug.log` 都没有）。所以用行为验证：

1. 改一个自研插件宿主半的某个 HTTP 路由返回值（例如 `dsh-synchub` 的 `/status` 加个临时字段）。
2. 浏览器地址栏直接开 `http://127.0.0.1:<当前端口>/api/dsh-synchub/status?fast=1`（浏览器带会话 cookie；终端里 `curl` 会 401）。
3. 看到新字段 = 生效；看不到 = 没生效。验完删掉临时字段。
---

## 4. 常见报错对照

| 报错 | 原因 | 处理 |
|---|---|---|
| `无法将"./plugpush.sh"项识别为 cmdlet…` | 文件名写错 | 用 `plugpush.ps1` |
| `!` 输入没反应 | DSH 没有 `!` 命令前缀 | 去右侧栏「终端」标签页，或外部 PowerShell |
| `SEC_E_NO_CREDENTIALS (0x8009030e)` | MinGit schannel | `git -C C:\dsh\dshplug config http.sslBackend openssl` |
| `Connection was reset` / `TLS connect error` | 网络间歇 | 重试 2~3 次；必要时临时 `git config http.proxy http://127.0.0.1:7897`，用完 `--unset` |
| `dsh plugin add` 找不到本地插件 | 自研插件不在 npm | 一律用 `install.ps1`，不要 `dsh plugin add <本地包名>` |
| `plugpush` 之后另一台还是旧代码 | 忘了 `install.ps1` / 新机器首次要完全退出再打开 | 新机器首次必须 `install.ps1` + 完全退出再打开（首次装载） |
| 改了 `cordis.patch.yml` 不生效 | 先看是不是改完没保存/改错了文件 | 配置层改动**热生效**（`dsh-hmr` 监听 profile 与 home 两级 patch）；不生效多半是改到了别的 profile。`client.js` 只需刷新页面 |
| `src refspec main does not match any` | 分支名猜错 | 脚本已改为跟随本地当前分支（本机是 `master`）；显式 `-Branch` 才覆盖 |

---

## 4.1 右侧文件列表的 U / M 徽标是什么（不是错误）

那是 DSH「Local changes / Changes」面板（`client-ui-forge`）根据 **Git 状态**画的徽标：

| 徽标 | 颜色 | 含义 |
|---|---|---|
| **U** | 绿色 | **Untracked**——新文件，Git 还没跟踪（`??`）；尚未 `git add` |
| **M** | 黄色 | **Modified**——已跟踪文件被改过（` M`） |

其他可能出现的：**D** 删除、**R** 重命名（悬停显示旧名）。
这些只是提醒「哪些东西还没提交」，不影响插件运行；用 `plugpush.ps1 -All` 提交后就会消失。
（当前 `U` 对应 `BOOTSTRAP.md` / `archive/` / `dsh-synchub/ADR.md` / `docs/`；
`M` 对应 `.gitignore` / `README.md` / `plugpush.ps1` / `install.ps1` / `dsh-getbrain/*` 等。）

---
## 5. 目录名 / 包名 / 清单 name：三者已统一

**2026-11-12 起，自研插件的「目录名 = 包名 = `list.json` 的 `name`」全部一致**：
`dsh-synchub` / `dsh-getbrain` / `dsh-larkcli`（`dsh-gitok` 同理）。
所以 `plugpush.ps1 <名字>`、`install.ps1 -Only <名字>` 直接用目录名即可，不再有 `@local` 前缀、
也不再有「`=` 也就是」的注释。

> **`dsh-pixel` 已于 2026-11-16 退役**（改用市场插件 `@muxiuesd/dsh-pixel-studio`），
> 源码、产物、决策记录全部收进 [`archive/dsh-pixel/`](<archive/dsh-pixel/README.md>)，
> 已从本清单与 desktop profile 摘除。它当时同样遵守「三者一致」。
> 下文的 npm 占名说明保留，因为「市场里有同名包 ≠ 那是你的包」这条坑对任何自研插件都成立。
也不再有「`=` 也就是」的注释。

| 名字 | 层次 | 谁在用 |
|---|---|---|
| 目录名 | 文件系统 | 你、`list.json` 的 `dir`、`plugpush.ps1` |
| npm 包名 | Node / pnpm / profile 依赖声明 | `package.json` 的 `name`、`dsh plugin list`、Junction 目录名 |
| `list.json` 的 `name` | 本仓库清单主键 | `install.ps1 -Only`、`plugpush.ps1 <包名>` |

> **历史（已清理）**：`dsh-getbrain` 早期包名是 `@local/getnote-organize`（Get笔记 时代留下）。
> `@local/` 只是 npm 的 scope，表示本地私有包，不是 DSH 语法，也不代表市场上有这个包
> （当时 `private: true`，根本没发布）。因为 profile 按**包名**声明依赖，那时 `list.json` 多写了
> `"packageName"` 桥接，`install.ps1 -Check` 也必须按包名查，否则误报「未安装」。
> 现在已统一为 `dsh-getbrain`，`packageName` 字段已删除；**改名会断现有 `link:` Junction，
> 所以这次改名后必须重跑一次 `install.ps1`**（见第 3 步）。脚本仍保留 `packageName` 兼容逻辑，
> 以防未来再出现不一致。
>
> 技能文件 `dsh-getbrain/SKILL.md` 的 `name:` 也已同步改为 `dsh-getbrain`；
> 工具名 `getnote_*`、路由 `/plugins/getnote/*`、配置命名空间 `getnote`、数据目录 `getnote/`
> 是**产品功能名**，不属于包名，保持不变（改了会破坏已保存的配置与凭据）。
> 补充坑：npm 上 **`dsh-pixel@0.0.1` 是别人（dushaobindoudou）占名的包**，
> 与本地曾经的自研 `dsh-pixel@0.1.0`（已退役）**毫无关系**。
> 判断「装的是不是我的版本」只看 profile 里的 `link:` / 版本号，
> 不要看市场里有没有同名包。详见 [ADR-008](<dsh-synchub/ADR.md>)。
> ⚠️ 反面教材：`@muxiuesd/dsh-pixel-studio` 确实是**另一个作者**的市场包（**不是**自研版），
> 现在装的就是它，用 `0.6.1` 版本号区分，别和归档里的 `dsh-pixel@0.1.0` 混为一谈。

### 5.1 界面显示名：`M` + 技能名，全部小写（2026-11-16 确定）

**只规定「用户在界面上看到的名字」，不改目录与包名。**

| 对象 | 规则 | 例子 |
|---|---|---|
| 侧边栏 / 设置里的显示名 | **`M` + 技能名，全小写** | `Mgitok`、`Mlarkcli`、`Mgetbrain` |
| 仓库目录 | `dsh-<技能名>`，保持小写不变 | `dsh-gitok` |
| npm 包名 | 等于目录名 | `dsh-gitok` |
| `__ModuleLoader__.load` 的 `id` | 必须等于包名 | `dsh-gitok` |

**为什么前缀是大写 `M` 而后面全小写：** `M` 是固定品牌标识，不参与链接；
后面的技能名全小写，目的是在列表里排序稳定、不被大小写混排打乱。

**为什么不同时改目录名：** 目录名一改，profile 里的 `link:` Junction 立刻断，
已保存的配置、凭据与工具名都会失联。显示名是展示层，可以随时改；目录是身份层，改了就要重装并迁移。

**新插件接入清单（四个地方都要改，缺一个就不显示）：**

1. `package.json` → `dsh.client` 段存在
2. `package.json` → `exports` 必须有 **`"./client"`**（最容易漏，见下方坑）
3. `lib/client.js` → `ctx.locale.register` 里 `nav` 写显示名
4. `locale/zh.json` + `locale/en.json` → `nav` 写同一个显示名

> **【坑】装了但界面上完全看不到，也不报错 —— 十有八九是 `exports` 缺 `"./client"`。**
> 2026-11-16 实测：`dsh-gitok` 的宿主半工具全部能用、HTTP 路由也正常响应，
> 但设置与侧边栏里就是没有它。原因只有这一个 —— `exports` 里只写了 `"."`，
> 没有 `"./client"`，DSH 找不到浏览器入口就静默跳过，**不产生任何报错**。
> 对比当时能正常显示的 `dsh-larkcli` / `dsh-getbrain`，它们都有 `"./client"`、
> `"./locale/*.json"`、`"./icon"` 三项，而 `dsh-gitok` 三项全缺。
> 所以新增插件时，先拿这三个导出与能正常显示的插件逐一对比，比查日志快得多。

**改名进度（2026-11-16）：**

| 插件 | 显示名 | 状态 |
|---|---|---|
| `dsh-gitok` | `Mgitok` | ✅ 已改（`locale` 目录 + `client.js` 全一致） |
| `dsh-larkcli` | `Mlarkcli` | ✅ 已改（2026-11-16，含 `meta.title`） |
| `dsh-getbrain` | `Mgetbrain` | ⬜ 待改 |
| `dsh-synchub` | `Msynchub` | ⬜ 待改 |

改名只动**显示名**（`client.js` 的 `locale.register` + `locale/*.json` 的 `nav`/`meta.title`），
**不碰目录与包名**。改完浏览器半刷页面即可，不用重启。
---

### 5.2 「装了、也启用了，但界面和工具都没有」——先查进程启动时间

2026-11-16 实测一次：`dsh-larkcli` 已装，`list_bundles` 也报
`enabled:true, installed:true, rows:[include:dsh-larkcli]`，
但 `list_plugins` 的 218 条里**根本没有** `include:dsh-larkcli`，
`GET /plugins/larkcli/status` 也 404 —— 插件行存在，但没挂进 fiber。

原因：**跑着的 DSH 进程装载的是启动时那份 `package.json` 的 `dsh.profile.bundles`**。

同一次实测的证据：

| 事实 | 值 |
|---|---|
| 监听 GUI 端口的主进程 PID / 启动时间 | 12672 / **09:48:06** |
| `profiles/desktop/package.json` 被写入的时间 | **10:15:23** |
| 结论 | 进程启动早于配置写入 27 分钟，它手里的 bundles 列表不含新插件 |

**判断命令（不用猜）**：先拿到当前端口，然后

```powershell
$pid0 = (Get-NetTCPConnection -LocalPort <当前端口> -State Listen).OwningProcess
Get-Process -Id $pid0 | Select-Object Id, StartTime
(Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json").LastWriteTime
```

启动时间 **早于** 配置时间 → 必须**完全退出 DSH 再打开**（刷新页面、重开窗口都不算）。

> 三种「看不到」的固定排查顺序：
> 1. **工具能用、面板不出现** → `package.json` 的 `exports` 缺 `"./client"`（§5.1 的坑）。
> 2. **两者都没有、路由 404** → 进程装载的是旧 bundles 列表 → 重启（本节）。
> 3. **重启后仍没有** → 看 `list_plugins` 里有没有 `include:<插件名>`；没有就是 bundle 行没生效，
>    查 `dsh.profile.bundles` 与 `cordis.patch.yml` 的 `id` 是否等于 `export const name`。

另一个同类陷阱：`apply()` 里调用**未验证的 ctx API**（例如 `ctx.set?.()`）会抛异常，
而这类异常会把**整个插件静默废掉** —— 工具不注册、路由不存在、界面不出现，日志还未必有。
`dsh-larkcli/test/activate.mjs` 因此用多种上下文（有无 `webServer`、`config` 缺失/垃圾）
直接跑 `apply()` 并断言不抛异常，把这类问题挡在测试阶段。

---

## 6. 关于「默认工作区目录」的建议（你问的）

### 现状（源码级）

- DSH 首次启动时会自动创建**默认工作区**：`<系统 Documents>\deepseek-harness\default-workspace`。
  本机 = `C:\Users\franc\Documents\deepseek-harness\default-workspace`（`workspace.json` 里记为 `title: "default"`）。
- 目录名 `default-workspace` 是**固定常量**（`DEFAULT_WORKSPACE_DIRECTORY`），不接受参数；
  但 Host 配置有 **`documentsDirectory`** 覆盖项，可以改「系统 Documents 目录」这个根。
  → 也就是说**可以改**，但改的是父目录，结果仍是 `<你指定的目录>\deepseek-harness\default-workspace`。
- 首次创建有严格前提：Workspace 注册表为空 **且** 没有任何运行时/持久化/已归档 Session。
  一旦成功登记，身份就持久保存；**重复调用不会重新解析目录**，改名保留身份，删登记也不会再自动创建。
  所以「装完插件后发现默认目录不理想」时，靠 GUI 再触发一次自动创建是行不通的。

### 建议（按推荐度）

1. **别依赖默认工作区，自己用「选择工作区」加目录** —— 这是最省事、最可控的。
   在 GUI 里直接用文件夹选择器添加 `C:\dsh\dshplug`（或任意你想要的目录）作为工作区，
   会话的 cwd 就落在那里，右侧终端打开就是该目录，跑 `.\plugpush.ps1` 不用 `cd`。
   本文所有命令都假定你在 `C:\dsh\dshplug` 下，就是基于这个做法。
2. **跨机保持一致**：两台机器把工作区放在**逐字符相同**的绝对路径（ADR-002）。
   会话目录编码、`workspace.json.path`、会话头部 `cwd` 三处都硬绑定绝对路径，
   路径不同会导致会话归到「未分组」或打开报 `working-directory: directory does not exist`。
3. **真要改默认目录**：在 profile 配置层给 workspace controller 配 `documentsDirectory`
   （绝对路径，且 `<该目录>\deepseek-harness\default-workspace` 可写）。
   注意 `cordis.patch.yml` 的 `config:` 在行激活时读取，**改完必须完全退出 DSH 再打开**。
   这只影响「全新安装 / 尚未初始化默认工作区」的机器；本机已经登记过，改它不会搬迁现有默认工作区。
   不建议为了「整齐」去动它——收益低，且容易和已登记的 UUID 对不上。

### 与同步的边界（重要）

`profiles/desktop/package.json` 里含 `link:C:/dsh/...` 绝对路径，`dsh-synchub` 把它列为
**danger 级、永不同步**（搬过去 DSH 会起不来）。所以：

- **插件的「安装声明」必须每台机器各自跑一次 `install.ps1` 生成**，不能靠同步搬 `package.json`；
- 但可以同步的是**源码仓库 `dshplug`**（本文做的）和 DSH 状态（`dsh-synchub` 的两个通道）；
- 想让「另一台装好插件」这件事也自动化，正确做法是**把 `install.ps1` 写进 bootstrap 流程**
  （就是本文第 3 步），而不是同步 profile 清单。

---

## 7. 当前仓库状态（2026-11-19，写死快照）

| 项 | 值 |
|---|---|
| 分支 / 远端 | `master` → `https://github.com/mengfanchun2017/dshwp-plugin.git`（GitHub 上已改名为 `dshwp-plugin`，本地目录仍是 `C:\dsh\dshplug`） |
| 基线仓库 | `C:\dsh\dw-base`，分支 `main`，**尚未建远端**（本地 `7bf9e2d`，128 文件 / 1.28 MB） |
| 认证 | GCM + Windows 凭据管理器（`gitok_bootstrap` 一键配）。不再手工贴 PAT，见第 0 步 ④ |
| 同步中心 | `C:\Users\franc\.dsh\dsh-synchub\`（`config.json` / `payload/` / `state.json` / `repos/{config,sessions}` / `backups/`） |
| 代码仓库登记 | `dshwp-plugin` → `C:\dsh\dshplug`；`dshwp-base` → `C:\dsh\dw-base`（设置面板可增删，路径任意） |
| 本次脚本修复 | `plugpush.ps1` 去掉 `status -eq 'active'` 过滤（含 `dev` 插件 + 根级文件）；`install.ps1 -Check` 汇总改用 `packageName` |

> **三种"仓库"别混**（这是最容易搞错的一处）：
>
> | 名称 | 是什么 | 谁在管 | 在哪配置 |
> |---|---|---|---|
> | `dsh-config` / `dsh-sessions` | 同步通道：只搬 `profiles/` 与 `skills/` | `dsh-synchub` | GUI 设置 → Msynchub |
> | `dshwp-plugin` / `dshwp-base` | 代码仓库：完整的开发仓库（含源码、文档、提交历史） | `dsh-synchub` 的「代码仓库同步」卡 | 同上，第二张表 |
> | `C:\dsh\dw-base` | 基线工作区目录本身（DSH 的工作区，不是同步通道） | 你自己 / DSH | DSH 工作区列表 |
>
> 前两者**都要远端**，但目的不同：通道是"把我的配置带到另一台机器"，代码仓库是"把我的代码备份到 GitHub"。
> 第三条是**本地目录**，它可以是代码仓库（现在是），也可以完全不入库。

### 7.1 加一个新的代码仓库（不必在 `C:\dsh` 下）

对应场景：「我还有一个之前的仓库要做同步和开发，但不在 dsh 目录下」。

1. GUI 设置 → **Msynchub** → 滚到「代码仓库同步」表。
2. 点「+ 增加一个仓库」，填两项：
   - **路径**：必须是**绝对路径**（如 `D:\work\old-project`）。相对路径会被拒 —— 相对谁都不明确。
   - **间隔**：自动提交的分钟数，`0` 表示不自动提交、只手动点。
3. 保存后回侧边栏，卡片里会多一行。点该行的「同步」即 `add -A → commit → push`。

三个必须知道的边界：

- **「移除」只从清单里删，不删磁盘上的仓库。** 想真删目录得自己动手。
- **没连远端（没有 `origin`）时只提交、不推送**，卡片会显示黄色「未连远端」并说明
  「本地有提交也无处可推」。这是**故意的**：有提交但没推 = 只备份在本机，硬盘坏了就没了，
  不能给它打绿勾（ADR-032）。
- **自动提交只按"过了多少分钟"触发，与"用户是否空闲"无关。**
  同步通道的自动上传看的是空闲，代码仓库看的是时间 —— 两个门是独立的，不要合并（ADR-024）。

先建远端再登记，顺序更省事：

```powershell
# 在本机仓库里建好远端（GitHub 上先建一个空的私有仓库，不要勾 README）
cd D:\work\old-project
git remote add origin https://github.com/<你>/<仓库名>.git
git push -u origin main          # 首次推，之后 Msynchub 就能推了
```

> 建远端这一步 `gh` CLI 没装，只能用网页或 REST API。之后 `Msynchub` 会自己按分钟提交推送。

---
## 8. 验收清单

**仓库与插件**

- [ ] `& .\plugpush.ps1 -List` 列出全部插件（含 `dsh-larkcli`）
- [ ] `& .\plugpush.ps1 -All "x" -DryRun` 的清单里能看到 `dsh-larkcli`、根级 `.gitignore`、`BOOTSTRAP.md`
- [ ] `& .\install.ps1 -Check` 输出「全部为 link: 形态且已安装」（`dev` 插件的 `missing` 不算问题）
- [ ] A 机 `plugpush` 后 `git rev-list --left-right --count origin/master...HEAD` 右列为 0
- [ ] B 机 `git pull --ff-only` 后 `git log -1` 与 A 一致
- [ ] B 机 `& .\install.ps1 -Check` 同样全绿
- [ ] B 机完全退出 DSH 再打开，插件面板/侧栏出现
- [ ] 两台机器工作区绝对路径一致（`C:\dsh\dshplug`）

**认证（新机必做，`gitok_bootstrap` 一条词）**

- [ ] 在 DSH 里说「初始化 git 认证」，`gitok_bootstrap` 跑到 S3 验收通过
- [ ] `gitok_doctor` 报的凭据存储后端是 GCM / 凭据管理器，不是明文文件
- [ ] `gitok_list` 里没有 `~/.git-credentials` 这类明文条目（有就该 `gitok_bootstrap cleanPlaintext`）
- [ ] `gitok_verify` 对 `https://github.com/mengfanchun2017/dshwp-plugin.git` 返回 ref

**Msynchub 面板（打开即验，不用等）**

- [ ] 侧边栏点开**立刻有内容**，不出现「正在读取本机状态…」（说明 20 分钟缓存命中）
- [ ] 头部时间写着「xx:xx 的结果（N 分钟内沿用，打开不用等）」，不是干巴巴的「检查于 xx:xx」
- [ ] 已配置时一句话结论是「已同步，不用管」或明确的待办数，**不是**「还缺两个仓库地址」
- [ ] 代码仓库卡每行是四态之一：绿 `✓`（真同步）/ 黄 `!`（有差异或未连远端）/ 红 `✗`（读不到）
- [ ] `C:\dsh\dw-base` 那行显示**黄色「未连远端」** —— 它确实没推任何地方，不该是绿的
- [ ] 设置里「代码仓库同步」表的路径都是绝对路径，间隔是数字

**会话迁移（改过工作区路径才需要）**

- [ ] `GET /api/dsh-synchub/session-move?id=<id>&to=<工作区名>` 能预览出源/目标组目录
- [ ] `POST` 带 `{confirm:'MOVE'}` 才执行；不带 confirm 必须返回 400 且**不动任何文件**
- [ ] 迁移后侧边栏会话出现在目标工作区，不再是「未分组」
- [ ] `<state>/backups/move-<时间>-<会话id>/` 里有回滚点

**三个测试套件（改了代码就跑）**

- [ ] `test\synchub-smoke.cjs` — 25 条路由 + 导出 + guard
- [ ] `test\sessionmove-smoke.cjs` — 7 组，含 14 个真实组目录交叉验证
- [ ] 其余 7 个 `test\*-smoke.cjs` 全绿（一共 9 个）
