# dshplug · 自研 DSH 插件仓库

一个 Git 仓库，**根目录直接放插件目录**（没有多余的 `plugins/` 层）。
`list.json` 是注册表：新增插件加一条即可。每台机器可以只装自己需要的那几个。

## 现在有几个仓库

**两个**，不是三个。0.3 起会话与配置合并到同一个同步引擎下，但**仍分两个 Git 仓库**：

| 仓库 | 内容 | 谁写 | 谁读 |
|---|---|---|---|
| **`dshplug`**（本仓库） | 自研插件**源码** | 你显式跑 `plugpush.ps1` | 另一台 `git pull` |
| `dsh-sessions` | 会话日志、工作区登记表、附件 | `dsh-synchub` 自动推 | 另一台自动拉 |
| `dsh-config` | 技能文件、DSH 配置层（不含密钥） | `dsh-synchub` 自动推 | 另一台自动拉 |

> 之前的 `dsh-config` / `dsh-sessions` 由 `dsh-config-manager` 和 `chatsync` 分别写。
> **0.3 起这两个插件都被 `dsh-synchub` 取代**（`chatsync` 已废弃）。
> `dsh-synchub` **不**同步插件——插件由 `dsh-market` 管。

工作区源码（`3d-forge` 等）归各自项目仓，不进这些。
**可再生成的 3D 产物 / 密钥都不进任何仓库。**

## 目录约定（扁平）

```
C:\dsh\dshplug\
├─ list.json          ← 插件注册表（新增插件就改这里）
├─ install.ps1        ← 按 list.json 装全部 / -Only 装单个 / -List / -Check
├─ plugpush.ps1       ← 显式「提交 + 推送」指定插件
├─ .gitignore
├─ README.md
├─ dsh-synchub\       ← 插件 1：同步中心（同步引擎）
│  ├─ package.json    # 必须有 dsh.bundle.patch + dsh.client
│  ├─ cordis.patch.yml
│  ├─ README.md       # 架构、同步面分级、状态机、API
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

### 改源码即时生效，不需要任何手动步骤

插件用 **`link:`** 装进 profile（pnpm 建的是目录 **Junction**，指向插件目录本身）。
文件怎么替换都透过链接读，所以**你改完保存就生效**，不用重跑 install、不用退出 DSH。

为什么不用 `file:`：`file:` 是**按文件硬链接**。任何「删除+重建」的保存方式
（`write`/`edit` 工具、IDE 原子改名、git checkout、解压覆盖）都会换 inode → 断链，
已安装副本停在旧代码。这是早前「改了没生效」的真实根因，实测复现过
（`package.json`、`lib/*.js` 断链后安装副本仍是旧版本）。

改 `link:` 之后实测三种写入方式（原地写 / 删除重建 / 原子改名）**全部即时生效**，
inode 变了也不影响。

> 只有三种情况需要跑 `install.ps1`：新机器首次、新增/删除插件、`list.json` 改动。
> 日常改代码不在其中。`-Force` 可强制重装。

### `install.ps1 -Check` 会检出五类问题并给出修复命令

```
link-junction   正常，改代码即时生效
file-hardlink   file: 形态，可能已断链  → 跑 install.ps1 自动升级为 link:
copy            更旧的复制形态          → 跑 install.ps1
orphan          node_modules 有残留链接但 package.json 无声明（DSH 不会加载）→ 跑 install.ps1
missing         声明了但没装出来        → 跑 install.ps1
```

`orphan` 是 `dsh plugin remove` 的真实副作用：它**只删 `package.json` 里的依赖声明，
却把 `node_modules` 里的 Junction 留在原地**。这种状态插件不会加载，但目录看起来正常，
所以脚本特意以**依赖声明**而不是目录存在来判断，并在重装前先清掉残骸
（删除 Junction 不会影响源目录，已实测）。

```powershell
# 看清单
& "C:\dsh\dshplug\install.ps1" -List
& "C:\dsh\dshplug\plugpush.ps1" -List

# 检查每个插件目录是否合格、是否已装
& "C:\dsh\dshplug\install.ps1" -Check

# 装（新机器 / 新增插件）
& "C:\dsh\dshplug\install.ps1"
& "C:\dsh\dshplug\install.ps1" -Only dsh-synchub

# 推（只有你明确要同步时才推）
& "C:\dsh\dshplug\plugpush.ps1" dsh-synchub "增加设置面板"
& "C:\dsh\dshplug\plugpush.ps1" dsh-synchub "修红点逻辑" -Tag
& "C:\dsh\dshplug\plugpush.ps1" dsh-synchub "看看会提交啥" -DryRun
```

`-Tag` 会按 `package.json` 的 `version` 打一个 `<包名>-v<版本>` 的 tag——
**版本由你决定何时 bump**，不是「一改就自动提交」。

> 两个脚本的 `-RepoRoot` 默认取**脚本自身所在目录**，不再写死路径。
> （早前默认写死 `C:\dsh\dsh-plugins`，而仓库实际克隆在 `C:\dsh\dshplug`，
> 结果开箱就报「找不到清单」。）

## 第一次配远端 + 认证（只做一次）

本机已装 Git for Windows 的 **Git Credential Manager**，
HTTPS + PAT 会弹一次系统登录窗并记住，不用把 token 写进任何文件。

1. 去 GitHub 建一个**私有**仓库 `dshplug`
2. Settings → Developer settings → **Fine-grained token**，只授权这个仓库、只给 `Contents: Read and write`
3. 首次推送（`-Remote` 会顺手把 `origin` 配好）：

```powershell
& "C:\dsh\dshplug\plugpush.ps1" dsh-synchub "init" `
  -Remote "https://github.com/<你的用户名>/dshplug.git"
```

第一次 `git push` 时 GCM 会弹窗，用户名填 GitHub 账号、**密码栏粘贴 PAT**（不是账号密码），
之后凭据存进 Windows 凭据管理器，两台机各做一次。
（SSH 实测全被墙，所以走 HTTPS；`git@github.com:` 那种地址不要用。）

### 本机必须的 git 设置（只有一项）

这台机器上 MinGit 默认的 schannel 后端会失败
（`ACQUIRE_CREDENTIALS_HANDLE_FAILED: SEC_E_NO_CREDENTIALS 0x8009030e`），
必须换 OpenSSL。这是**仓库级**设置，不改全局：

```powershell
git -C C:\dsh\dshplug config http.sslBackend openssl
```

> **网络是间歇的，别把临时状态当结论。**
> 实测同一分钟里：直连一会 `Connection was reset`、一会 25s 后成功；
> 代理（verge-mihomo 在 7897 确实听着）则稳定报
> `TLS connect error: unexpected eof while reading`。
> 两者都会失败，**谁觉得快用谁**，别写死。
>
> 当前仓库级没配代理（直连重试基本能通）。如果你那阵子直连全挂，
> 临时加回来就行，用完可以再拿掉：
> ```powershell
> git -C C:\dsh\dshplug config http.proxy http://127.0.0.1:7897
> # 修好了就删：
> git -C C:\dsh\dshplug config --unset http.proxy
> ```
> 判断标准就一条：`git -C C:\dsh\dshplug ls-remote --heads origin` 能返回 ref
> 就算通；失败先重试 2~3 次再换路 —— 单次失败在这台机器上不代表网络不通。

## 两台机器的安装顺序（重要）

`link:` 规格会把**绝对路径**写进 `profile/package.json`，
而这个文件的跨机同步由 `dsh-synchub` 明确**排除**（它是 danger 级，永不同步），
因为另一台没有同一路径 → **DSH 启动失败**。

```
1. 两台机都把本仓库放在同一个绝对路径 C:\dsh\dshplug（clone 或拷贝）
2. 每台各跑一次  & C:\dsh\dshplug\install.ps1
3. 完全退出 DSH 再打开
4. 再用 dsh-synchub 配好两个同步仓的远端
```

> 之后改源码**即时生效**（`link:` Junction），不用再跑 install；
> 只有「另一台也要拿到」时才跑 `plugpush.ps1` + 那边 `git pull`。

## 插件同步 vs 状态同步（边界）

| 东西 | 归谁管 | 为什么 |
|---|---|---|
| 插件源码 + 清单 | **本仓库**（`plugpush.ps1` 显式推） | 需要版本、tag、可回滚 |
| 插件的**安装**（profile 里的 `package.json`） | `dsh-market` | 它管 registry 与 profile 依赖 |
| 会话 / 工作区 / 附件 / 技能文件 / 配置层 | **`dsh-synchub`** | 一套引擎、一份历史、一个面板 |
| 密钥、设备身份、运行时、缓存 | **谁都不管** | 泄露或失效风险，各机各自生成 |

`dsh-synchub` **不同步** `profiles/desktop/package.json`——那里含 `link:C:/dsh/...`
绝对路径，跨机搬运会让 DSH 起不来。插件清单请用 `install.ps1` 在每台机上各自生成。

## 新增一个插件的步骤

1. 根目录建 `<名字>\`，放 `package.json` + `cordis.patch.yml` + `lib\`
2. 在 `list.json` 的 `plugins` 数组加一条（name / dir / version / description / status=active）
3. 本机 `& .\install.ps1 -Only <名字>` → 完全退出 DSH 再打开 → 确认面板/侧栏出现
4. `& .\plugpush.ps1 <名字> "新增 <名字>"` → 另一台 `git pull` + `& .\install.ps1 -Only <名字>`
5. 想发布一个版本点时：bump `package.json` 的 `version`，推时加 `-Tag`

> 第 3、4 步里「装」是必需的：`link:` 需要 pnpm 建一次 Junction。
> 但**之后改这个插件的代码就不用再装了**。

## 已知限制

- 路径必须两台一致（`C:\dsh\dshplug`）。单位电脑若 DSH 工作区也在 `C:\dsh`，天然满足。
- 0.x 的 caret 不跨 minor：插件若锁 `engines.dsh`，升级 DSH 后要同步更新。
- `list.json` 只是本机注册表，不是 npm registry；`dsh plugin add <包名>` 仍会去 npm 找，
  所以自研插件一律用 `install.ps1`（`link:` 路径）。
