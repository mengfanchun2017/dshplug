# BOOTSTRAP · 用命令行把 dshplug 仓库在多台终端之间同步

> 目标：**先手工打通**「改源码 → 推到 Git → 另一台拉下来 → 装好能用」这条链，
> 不依赖任何插件面板，也不依赖 `dsh-synchub` 的自动同步（那是后续才做的事）。
> 本文是**操作手册**；设计理由看 [`dsh-synchub/ADR.md`](<dsh-synchub/ADR.md>)，插件总览看 [`README.md`](<README.md>)。
>
> 环境基线（写死，避免以后腐烂）：Windows / PowerShell 5.1+ / DSH `0.2.2-rc.1`（`desktop` profile）/
> 仓库根 `C:\dsh\dshplug` / 远端 `github.com/mengfanchun2017/dshplug.git` 分支 `master`。
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

# 4) 认证：HTTPS + PAT，Windows 凭据管理器各机做一次
#    GitHub → Settings → Developer settings → Fine-grained token
#    只授权 dshplug 私有仓库、只给 Contents: Read and write
#    首次 push 时 GCM 弹窗：用户名 = GitHub 账号，密码栏粘贴 PAT（不是账号密码）
#    SSH 实测被墙，不要用 git@github.com: 地址
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

## 4. 常见报错对照

| 报错 | 原因 | 处理 |
|---|---|---|
| `无法将"./plugpush.sh"项识别为 cmdlet…` | 文件名写错 | 用 `plugpush.ps1` |
| `!` 输入没反应 | DSH 没有 `!` 命令前缀 | 去右侧栏「终端」标签页，或外部 PowerShell |
| `SEC_E_NO_CREDENTIALS (0x8009030e)` | MinGit schannel | `git -C C:\dsh\dshplug config http.sslBackend openssl` |
| `Connection was reset` / `TLS connect error` | 网络间歇 | 重试 2~3 次；必要时临时 `git config http.proxy http://127.0.0.1:7897`，用完 `--unset` |
| `dsh plugin add` 找不到本地插件 | 自研插件不在 npm | 一律用 `install.ps1`，不要 `dsh plugin add <本地包名>` |
| `plugpush` 之后另一台还是旧代码 | 忘了 `install.ps1` / 没退出重开 DSH | 新机器首次必须 `install.ps1` + 完全退出再打开 |
| 改了 `cordis.patch.yml` 不生效 | 配置层在**行激活时**读取 | 必须**重启 App**；`client.js` 只需刷新页面 |
| `src refspec main does not match any` | 分支名猜错 | 脚本已改为跟随本地当前分支（本机是 `master`）；显式 `-Branch` 才覆盖 |

---

## 5. 目录名 / 包名 / 清单 name：三者已统一

**2026-11-12 起，四个自研插件的「目录名 = 包名 = `list.json` 的 `name`」全部一致**：
`dsh-synchub` / `dsh-getbrain` / `dsh-pixel` / `dsh-larkcli`（`dsh-gitok` 同理）。
所以 `plugpush.ps1 <名字>`、`install.ps1 -Only <名字>` 直接用目录名即可，不再有 `@local` 前缀、
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
> 补充坑：npm 上 `dsh-pixel@0.0.1` 是**别人**（dushaobindoudou）占名的包，与你本地
> `dsh-pixel@0.1.0` 无关。判断「装的是不是我的版本」只看 profile 里的 `link:` / 版本号，
> 不要看市场里有没有同名包。详见 [ADR-008](<dsh-synchub/ADR.md>)。

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

## 7. 当前仓库状态（2026-11-12，写死快照）

| 项 | 值 |
|---|---|
| 分支 / 远端 | `master` → `https://github.com/mengfanchun2017/dshplug.git` |
| 本地 HEAD | `3221bdf`（`origin/master` = `5438e0ad`，**ahead 1**：「新增 dsh-pixel」未推） |
| 未提交 | 根 `.gitignore`、`plugpush.ps1`、`README`、`ADR.md`、`docs/`、4 份插件内文档/代码、`dsh-getbrain/{cordis.patch.yml,index.js}`（后两项是你之前的 dataDir 绝对路径修正，非本次改动） |
| `dsh-synchub` 状态目录 | `C:\Users\franc\.dsh\dsh-synchub\` **不存在** → 同步引擎尚未配置，面板会显示「尚未配置」；本文不依赖它 |
| 本次脚本修复 | `plugpush.ps1` 去掉 `status -eq 'active'` 过滤（含 `dev` 插件 + 根级文件）；`install.ps1 -Check` 汇总改用 `packageName`（否则 `dsh-getbrain` 误报 missing） |

> 下一步（`dsh-synchub` 自动同步）属于**后续插件内容**：在 GUI 设置 → 同步中心填
> `dsh-config` / `dsh-sessions` 两个私有仓库远端，第一台「① 推送」建基线、第二台「① 拉取」。
> 在打通本文的命令行链路之前，先不要配它，免得两条通道互相干扰。

---

## 8. 验收清单

- [ ] `& .\plugpush.ps1 -List` 列出 4 个插件（含 `dsh-larkcli`）
- [ ] `& .\plugpush.ps1 -All "x" -DryRun` 的清单里能看到 `dsh-larkcli`、根级 `.gitignore`、`BOOTSTRAP.md`
- [ ] `& .\install.ps1 -Check` 输出「全部为 link: 形态且已安装」（`dev` 插件的 `missing` 不算问题）
- [ ] A 机 `plugpush` 后 `git rev-list --left-right --count origin/master...HEAD` 右列为 0
- [ ] B 机 `git pull --ff-only` 后 `git log -1` 与 A 一致
- [ ] B 机 `& .\install.ps1 -Check` 同样全绿
- [ ] B 机完全退出 DSH 再打开，插件面板/侧栏出现
- [ ] 两台机器工作区绝对路径一致（`C:\dsh\dshplug`）
