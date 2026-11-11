# dsh-plugins · 自研 DSH 插件仓库

一个 Git 仓库，**根目录直接放插件目录**（没有多余的 `plugins/` 层）。
`list.json` 是注册表：新增插件加一条即可。每台机器可以只装自己需要的那几个。

这是两台机器上的**第 3 个仓库**（另两个是会话同步仓 `dsh-sessions`、配置同步仓 `dsh-config`）。

## 三个仓库各管什么（不要混）

| 仓库 | 内容 | 谁写 | 谁读 |
|---|---|---|---|
| **`dsh-plugins`**（本仓库） | 自研插件**源码** | 你显式跑 `plugpush.ps1` | 另一台 `git pull` |
| `dsh-config` | DSH 配置快照（设置/插件清单/MCP/技能，不含密钥） | `dsh-config-manager` 自动推 | 另一台自动拉 |
| `dsh-sessions` | 会话日志、附件、工作区映射 | `chatsync` 自动推 | 另一台自动拉 |

工作区源码（`3d-forge` 等）归各自项目仓，不进这三个。
**可再生成的 3D 产物 / 密钥都不进任何仓库。**

## 目录约定（扁平）

```
C:\dsh\dsh-plugins\
├─ list.json          ← 插件注册表（新增插件就改这里）
├─ install.ps1        ← 按 list.json 装全部 / -Only 装单个 / -List / -Check
├─ plugpush.ps1       ← 显式「提交 + 推送」指定插件
├─ .gitignore
├─ README.md
├─ dsh-synchub\       ← 插件 1：同步中心
│  ├─ package.json     # 必须有 dsh.bundle.patch + dsh.client
│  ├─ cordis.patch.yml
│  └─ lib\ {index.js, client.js}
├─ <单位电脑插件 1>\   ← clone 过来直接放根目录
└─ <单位电脑插件 2>\
```

**一个插件目录能被注册，只需两个条件**：
`package.json` 带 `dsh.bundle.patch`；`cordis.patch.yml` 有一行
`- insert: - id: <name>`，`id` 等于宿主半 `export const name`。
`install.ps1 -Check` 会逐个校验，不合格的目录不会误装。

## 两条命令的分工（核心设计）

| 命令 | 做什么 | 什么时候用 |
|---|---|---|
| `install.ps1` | 把 `list.json` 里的插件**注册进本机 DSH profile** | 新机器、新增/删除插件后 |
| `plugpush.ps1` | 把某个插件的**本地改动 commit + push 到远端** | 你明确决定「这个版本可以同步给另一台了」 |

**默认什么都不自动上行。** `plugpush.ps1` 不跑就没有任何 commit、没有任何 push——
这就是你说的「不提交就相当于本地插件」，完全成立，两台机各自本地改、互不干扰。

关于 `file:` 依赖的开发体验（实测结论，容易踩坑）：

- pnpm 把 `file:` 目录**硬链接**进 `node_modules`（同一 inode，不是复制）。
- **用编辑器「原地保存」**（改完保存同一个文件）→ 已安装副本立刻同步，不用重跑 install。
- **但用会「替换文件」的工具**（本会话里的 `write`/`edit`、某些编辑器、IDE 的重构/格式化、
  git checkout、解压缩覆盖）会生成**新 inode**，硬链接就断了 → 已安装副本还是旧代码。
  本次实测：`package.json`/`lib/*.js` 断链后安装副本仍停在 0.1.0。
- 断链的表现：**改了没生效**。此时跑一次 `install.ps1 -Only <名字>`（内部 remove+add）
  即可重新建立硬链接；不确定就 `-Check` 看目录，或直接重跑一次，代价只有半秒。

所以开发习惯建议：**改完源码跑一次 `install.ps1 -Only <名字>` 再退出重开 DSH**，
别依赖硬链接的即时性。

```powershell
# 看清单
& "C:\dsh\dsh-plugins\install.ps1" -List
& "C:\dsh\dsh-plugins\plugpush.ps1" -List

# 检查每个插件目录是否合格、是否已装
& "C:\dsh\dsh-plugins\install.ps1" -Check

# 装（新机器 / 新增插件）
& "C:\dsh\dsh-plugins\install.ps1"
& "C:\dsh\dsh-plugins\install.ps1" -Only dsh-synchub

# 推（只有你明确要同步时才推）
& "C:\dsh\dsh-plugins\plugpush.ps1" dsh-synchub "增加设置面板"
& "C:\dsh\dsh-plugins\plugpush.ps1" dsh-synchub "修红点逻辑" -Tag
& "C:\dsh\dsh-plugins\plugpush.ps1" dsh-synchub "看看会提交啥" -DryRun
```

`-Tag` 会按 `package.json` 的 `version` 打一个 `<包名>-v<版本>` 的 tag——
**版本由你决定何时 bump**，不是「一改就自动提交」。

## 第一次配远端 + 认证（只做一次）

本机已装 Git for Windows 的 **Git Credential Manager**（`credential.helper=manager-core`），
HTTPS + PAT 会弹一次系统登录窗并记住，不用把 token 写进任何文件。

1. 去 GitHub 建一个**私有**仓库 `dsh-plugins`
2. Settings → Developer settings → **Fine-grained token**，只授权这个仓库、只给 `Contents: Read and write`
3. 首次推送（`-Remote` 会顺手把 `origin` 配好）：

```powershell
& "C:\dsh\dsh-plugins\plugpush.ps1" dsh-synchub "init" `
  -Remote "https://github.com/<你的用户名>/dsh-plugins.git"
```

第一次 `git push` 时 GCM 会弹窗，用户名填 GitHub 账号、**密码栏粘贴 PAT**（不是账号密码），
之后凭据存进 Windows 凭据管理器，两台机各做一次。
（你实测 SSH 全被墙，所以走 HTTPS；`git@github.com:` 那种地址不要用。）

## 两台机器的安装顺序（重要）

`file:` 规格会把**绝对路径**写进 `profile/package.json`，而这个文件会被
`dsh-config-manager` 同步到另一台。那边没有同一路径 → **DSH 启动失败**。

```
1. 两台机都把本仓库放在同一个绝对路径 C:\dsh\dsh-plugins（clone 或拷贝）
2. 每台各跑一次  & C:\dsh\dsh-plugins\install.ps1
3. 完全退出 DSH 再打开
4. 之后才让 dsh-config-manager 开始同步配置
```

> 之后改源码：建议跑一次 `install.ps1 -Only <名字>` 刷新硬链接（见上面「关于 file: 依赖」）；
> 只有「另一台也要拿到」时才跑 `plugpush.ps1` + 那边 `git pull`。

## 与 config-manager 的「本地插件打包」关系（重要）

`dsh-config-manager@0.8.0` 内建 `localPluginPack`：导出 `plugins` 分区时会对
`link:` / `file:` 插件跑 `npm pack`，把 tarball 塞进配置快照，并在导入时**重写 spec 为本机绝对路径**。

所以自研插件其实有**两条**跨机通道：

| 通道 | 触发 | 版本 | 建议 |
|---|---|---|---|
| 本仓库 + `plugpush.ps1` | 你显式 | Git commit/tag，**有版本、可回滚** | ✅ **主通道** |
| config-manager 的 `localPluginPack` | 它的自动/手动导出 | 快照里的 tarball，**会重写 spec** | ⚠️ 会与你手写的 `file:C:/dsh/...` 打架 |

**建议**：在 config-manager 的同步分区里**不要勾 `plugins` 分区**（或至少不勾 `pluginFiles`），
让「插件清单 + 本地插件」只由本仓库管。否则它把 spec 重写成 `dsh-config-manager/local-plugins/...`
下的解包路径，`install.ps1` 写的 `file:C:/dsh/dsh-plugins/...` 就被覆盖了。
（如果你希望重装后连插件都自动回来，那反过来：让 config-manager 管插件，本仓库只当源码存档——
但那样就没有 Git 版本历史了。二选一，别两条一起跑。）

## 新增一个插件的步骤

1. 根目录建 `<名字>\`，放 `package.json` + `cordis.patch.yml` + `lib\`
2. 在 `list.json` 的 `plugins` 数组加一条（name / dir / version / description / status=active）
3. 本机 `& .\install.ps1 -Only <名字>` → 完全退出 DSH 再打开 → 确认面板/侧栏出现
4. `& .\plugpush.ps1 <名字> "新增 <名字>"` → 另一台 `git pull` + `& .\install.ps1 -Only <名字>`
5. 想发布一个版本点时：bump `package.json` 的 `version`，推时加 `-Tag`

## 已知限制

- 路径必须两台一致（`C:\dsh\dsh-plugins`）。单位电脑若 DSH 工作区也在 `C:\dsh`，天然满足。
- 0.x 的 caret 不跨 minor：插件若锁 `engines.dsh`，升级 DSH 后要同步更新。
- `npm pack` 本地插件超过 100 MB 会被 config-manager 跳过并警告——本仓库只放源码，不会到这个量级。
- `list.json` 只是本机注册表，不是 npm registry；`dsh plugin add <包名>` 仍会去 npm 找，
  所以自研插件一律用 `install.ps1`（`file:` 路径）。
