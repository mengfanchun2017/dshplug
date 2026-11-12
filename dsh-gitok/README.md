# dsh-gitok

Git 认证一站式管理插件：**检查 / 建议 / 配置 / 验证 / 撤销**，全部收在一个工具集里。

核心思路：把多台终端（Windows + 各 WSL 发行版）的 git 凭据**统一收敛到 Windows 凭据管理器**
（DPAPI 加密、绑定用户+本机、出机器解不开）。WSL 通过 interop 直接调用 Windows 的
`git-credential-manager.exe`，**自己一个字节的密钥都不存**。

> **版本 0.2.0 ｜ 状态 active ｜ 2026-11-12**
> 未发布 npm，已用 `link:` 装进 `desktop` profile（宿主机 `REDMIPRO`）。
> 这份 README 是**交接文档**：设计、机制、实测数据、踩过的坑全在里面，换机器/换工作区照着读就能接着开发。

---

## 面板长什么样

装好后在 **设置 → Git 认证** 里：

```
┌─ Git 认证 ───────────────────────────────┐
│ ● 正常   已配置，认证可用                  │
│                                          │
│ 凭据后端      (default = wincredman)      │
│ git helper    .../gitconfig   manager     │
│ 代理          http://127.0.0.1:7897       │
│ SSH 密钥      (无)                        │
│ gh CLI        not installed              │
│ 已存凭据      1 条                        │
│ GCM 路径      .../git-credential-manager  │
│                                          │
│ [ 重新检查 ]  [ 查看原始报告 ]              │
└──────────────────────────────────────────┘
```

新手不用知道 `gitok_*` 工具名，看卡片 + 点按钮就够。

---
## 目录

- [1. 为什么做这个](#1-为什么做这个)
- [2. 本机实测盘点结果](#2-本机实测盘点结果)
- [3. 六种认证方式对比](#3-六种认证方式对比)
- [4. 插件设计](#4-插件设计)
- [5. 安全模型](#5-安全模型)
- [6. 安装与开发](#6-安装与开发)
- [7. 待办与已知限制](#7-待办与已知限制)
- [8. 踩坑记录](#8-踩坑记录)
- [9. 换工作区继续开发](#9-换工作区继续开发交接清单)

---

## 1. 为什么做这个

多终端开发时，git 凭据经常散落成好几份，每份的加密状态、权限范围、删除方式都不一样：

| 典型位置 | 是否明文 | 能否统一管理 |
|---|---|---|
| Windows 凭据管理器（GCM `wincredman`） | ❌ 加密（DPAPI） | ✅ `cmdkey` / GCM |
| WSL `~/.config/gh/hosts.yml` | ✅ **明文 PAT** | ⚠️ 每台单独 `gh auth logout` |
| WSL `~/.git-credentials` | ✅ **明文** | ⚠️ |
| 各发行版 `~/.ssh/id_*` | 取决于有没有口令 | ⚠️ 分散 |
| 写进 remote URL 的 token | ✅ **明文** | ❌ 还会进 shell history |

本插件的目标：**把第一列收敛到第一行，删掉其余。**

四条硬要求（来自真实需求，不是拍脑袋）：

1. 一台终端一个 git 认证、**永久有效**、随时可查可删可管理
2. 多种认证方式能对比、能区分，知道该选哪个
3. 把「检查 / 建议 / 配置 / 更新」**收进一个插件**
4. **加密**，密钥**出了这台机器就不能用**，不明文保存

---

## 2. 本机实测盘点结果

> 2026-11-12 实测，机器 `RedmiPro`，用户 `franc`（非管理员）。令牌只记类型/长度/权限，从不记明文。

### 2.1 Windows 侧

| 项目 | 实际情况 |
|---|---|
| git | `2.56.0.windows.4`，来自 **MinGit**：`C:\Users\franc\AppData\Local\Programs\MinGit\cmd\git.exe` |
| 用户配置 | `C:\Users\franc\.gitconfig` 只有 `safe.directory=*`、`user.name`、`user.email` |
| 系统配置 | `MinGit\etc\gitconfig` 里 `credential.helper=manager`、`core.autocrlf=true` |
| 凭据助手 | **GCM 2.9.1**（`git-credential-manager.exe` in `ucrt64\bin`） |
| 存储后端 | 未设 `credential.credentialStore` → 默认 **`wincredman`** |
| 已存凭据 | `LegacyGeneric:target=git:https://github.com`，用户 `mengfanchun2017`，`Local machine persistence` |
| 令牌类型 | `gho_` 开头 40 字符 = **GCM 的 GitHub OAuth token**，scopes `gist, repo, workflow`，响应头无过期时间 |
| SSH 私钥 | **没有**（`~/.ssh` 只有 `known_hosts`） |
| ssh-agent | `Stopped` / `Disabled`，非管理员启不了 |
| gh CLI | **未安装** |
| 代理 | ✅ **已修**：`http.proxy` / `https.proxy` = `http://127.0.0.1:7897`，`git ls-remote` 实测通过 |

**结论：Windows 侧认证本身是对的**（DPAPI 加密 + 不过期 + 出机器不可用），
当时的唯一故障是 git 没配代理，直连 `github.com:443` 超时。已在 2026-11-12 修复。

### 2.2 WSL `claude` 发行版（默认，Running）

| 项目 | 实际情况 |
|---|---|
| git | `2.53.0`，`/usr/bin/git`，用户 `francis` |
| GitHub 认证 | `credential.https://github.com.helper = !~/​.local/bin/gh auth git-credential` |
| 飞书 | `credential.https://miaoda-git.feishu.cn/...git.helper = !lark-cli apps git-credential-helper`，`useHttpPath=true` |
| gh CLI | `2.103.3`，账号 `mengfanchun2017` |
| 令牌 | `github_pat_` 开头 **93 字符** = fine-grained PAT，存在 `~/.config/gh/hosts.yml`（`600`），**明文** |
| SSH 私钥 | **没有** |
| ssh-agent | socket 在，但 `SSH_AUTH_SOCK` 未导出，`ssh-add -l` 无身份 |
| 密钥环 | **`secret-tool` / `gnome-keyring` / `pass` 全无**，只有 `gpg 2.4.8` |
| 代理 | 环境变量有 `HTTPS_PROXY`（`.wslconfig` 的 `autoProxy` 注入），git config 里没写 |

### 2.3 WSL `u26claude4` 发行版（Stopped）

| 项目 | 实际情况 |
|---|---|
| gitconfig | 同款 gh helper，**外加** `[http "https://github.com/"] proxy = ...` 写死在 config 里 |
| SSH 私钥 | **有** `~/.ssh/id_ed25519`（411 字节） |
| 🔴 口令 | **空口令**（`ssh-keygen -y -P ""` 直接导出公钥成功） |
| 公钥 | `ssh-ed25519 AAAA...I8eM francis@meng.com`，`ssh -T git@github.com` 实测可用 |

### 2.4 关键安全发现

| 发现 | 说明 |
|---|---|
| 🔴 空口令 SSH 私钥 | `u26claude4` 里那把，拷走即等于账号被盗 |
| 🔴 明文 PAT | WSL 的 `hosts.yml` 是明文，任何 franc 进程可读 |
| 🟠 凭据三处分散 | Windows GCM / claude gh / u26 gh 互不相通，轮换要改三次 |
| 🟡 `C:\wsl` ACL 过宽 | 含 `Authenticated Users: **Modify**`，两个 vhdx 对所有已登录用户可读写 |
| ❓ BitLocker 状态未知 | `manage-bde` 需要管理员，非管理员 shell 确认不了 |

### 2.5 已验证的可行性（插件的地基）

```bash
# WSL 里直接调 Windows 的 GCM，能取到凭据
printf "protocol=https\nhost=github.com\n\n" | \
  /mnt/c/Users/franc/.../ucrt64/bin/git-credential-manager.exe get
# → username=mengfanchun2017   password=<有值>

# 端到端 git 操作也通
git -c credential.helper=<Windows GCM 路径> \
  ls-remote https://github.com/mengfanchun2017/ccprivate.git HEAD
# → 38e1b73f88be9f8d253eab0313f6e4162eceb80a   exit=0
```

**这就是插件的核心机制**：WSL 可以完全不存密钥，只借用 Windows 凭据管理器那一份 DPAPI 密文。

---

## 3. 六种认证方式对比

| # | 方式 | 落盘形态 | 加密 | 能永久 | 在哪看 / 怎么删 | 换机器能用 |
|---|---|---|---|---|---|---|
| 1 | **GCM + 凭据管理器** | DPAPI 密文进 wincredman | ✅ 绑用户+机器 | ✅ | `cmdkey /list`、`git-credential-manager github list` | ❌ 解不开 |
| 2 | **GCM `dpapi` 文件** | `%USERPROFILE%\.gcm\dpapi_store` | ✅ DPAPI | ✅ | 直接删文件 | ❌ |
| 3 | **gh CLI 当 helper** | `~/.config/gh/hosts.yml` | ❌ 仅 600 | ✅ | `cat` 就能看，`gh auth logout` 删 | ⚠️ 拷走即用 |
| 4 | **git-credential-store** | `~/.git-credentials` | ❌ 全明文 | ✅ | 直接看文件 | ⚠️ |
| 5 | **git-credential-cache** | 只在内存 | ✅ 天然 | ❌ 默认 15 分钟 | 无 | ❌ |
| 6 | **SSH 密钥 + 口令** | `~/.ssh/id_ed25519` | ✅ 口令加密 | ✅ | `ls ~/.ssh`、`ssh-add -d` | ⚠️ 有口令才安全 |
| 6b | **SSH 密钥空口令** | 明文私钥 | ❌ | ✅ | 同上 | ❌ 拷走即用 |
| 7 | **GCM `gpg` / `pass`** | GPG 加密文件 | ✅ | ✅ | `pass ls` | ⚠️ |
| 8 | **libsecret / gnome-keyring** | Secret Service | ✅ | ✅ | `secret-tool search` | ⚠️ |
| 10 | **PAT 写进 URL** | URL 里明文 | ❌ | ✅ | `git remote -v` 一眼看到 | ❌ 最差 |

**选型结论**：Windows 用 ①，WSL 借 ① （`gitok_adopt` 做的事），SSH 场景用 ⑥ 且必须带口令。

补充两点本机特有的判断：

- **`useHttpPath` 是关键开关**。设 `true` 后凭据按「host + 仓库路径」区分，同 host 不同仓库可以各存各的。已实测：fake host 上 repoA / repoB 返回不同凭据。这是「一个仓库一个认证」的真正粒度。
- **Windows 的 `gho_` 权限更宽**（`gist, repo, workflow` 全宽），WSL 的 fine-grained PAT 更克制（按仓库按权限）。统一时建议靠向 fine-grained。

---

## 4. 插件设计

本插件两个半区：

| 半区 | 文件 | 职责 |
|---|---|---|
| 宿主（Host） | `lib/index.js` | 6 个工具 + `/plugins/gitok/status` 数据路由 |
| 浏览器（Client） | `lib/client.js` | 设置里的「Git 认证」面板 |

### 4.1 工具清单

| 工具 | 性质 | 作用 |
|---|---|---|
| `gitok_doctor` | **只读** | 逐端点体检：git 版本、helper（含 URL 作用域）、store 后端、代理、SSH 私钥、ssh-agent、明文凭据文件、gh 状态 |
| `gitok_list` | **只读** | 列出已存凭据：凭据管理器条目、GCM 已知账号、各 WSL 端点来源。**只显示 host/用户名** |
| `gitok_verify` | **只读** | 端到端跑 `git ls-remote` 验证通路 |
| `gitok_login` | 触发登录 | 让 GCM 弹浏览器/设备码。**密钥不经过本插件** |
| `gitok_adopt` | **改配置** | 把 WSL 端点的 helper 指向 Windows GCM（先备份） |
| `gitok_revoke` | **删除** | GCM `erase` 删凭据 + 可选清理 WSL 配置。**必须 `confirm: true`** |

> **面向新手时不要提工具名。** 设置里有一个「Git 认证」面板，新手只需看卡片、点「重新检查」。
> 工具名只在需要精确操作（如 `gitok_revoke` 删某一条）时由 AI 代调。

### 4.1.1 设置面板（v0.2.0 新增）

在「设置」侧边栏注册一顶层分区 **Git 认证**（`settings.section`，`id: gitok`，`order: 65`）。

面板做什么：

| 区域 | 内容 |
|---|---|
| 状态卡 | 一个颜色徽标（正常/待处理/异常）+ 一句话结论，如「已配置，认证可用」 |
| 明细行 | 凭据后端、git helper、仓库级 helper、代理、SSH 密钥、gh CLI、已存凭据条数、GCM 路径 |
| 按钮 | 「重新检查」（带 `?refresh=1` 绕过 5s 缓存）、「查看原始报告」（展开完整体检文本） |
| 新手说明 | 告诉用户凭据到底在哪、怎么删、怎么换账号 |

**数据通路**（这是关键，Client 拿不到 Host 的能力）：

```
面板 fetch /plugins/gitok/status?refresh=1
  → Host 路由（webServer.register）实际跑 pwsh 探测
  → 返回 { ok, status:{level,summary,...}, report:"<原始体检文本>" }
```

缓存 5 秒：面板一次渲染可能拉多次，避免每次都起 pwsh 子进程。

`parseStatus()` 把体检文本解析成结构化 JSON。它和 `gitok_doctor` 工具**共用 `runDoctor()`**，
避免两边行为漂移。

### 4.2 端点抽象

插件把所有目标统一成「端点」概念：

- `target === 'windows'` → 直接 `pwsh -NoProfile -Command <cmd>`
- 其他任何字符串 → `wsl.exe -d <name> -e bash -lc <cmd>`（带 `WSL_UTF8=1`）

这样 `doctor` / `list` / `verify` / `adopt` 四个工具都是「遍历端点」的同一套代码，
加一台新 WSL 发行版只需在 `cordis.patch.yml` 的 `targets` 里加个名字。

### 4.3 建议的使用顺序

```
gitok_doctor                     # 1. 先看清现状
gitok_verify  <私有库 URL>        # 2. 确认当前通路是否真的可用
gitok_adopt   targets=[claude]   # 3. 让 WSL 借 Windows 凭据
gitok_verify  <私有库 URL>        # 4. 确认切换后仍可用
# 5. 确认无误后，手动清掉 WSL 里的明文 PAT：gh auth logout
gitok_list                       # 6. 随时查看还剩哪些凭据
gitok_revoke confirm=true        # 7. 需要时精确删除
```

### 4.4 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `gcmPath` | `''` | GCM 绝对路径，留空自动探测 MinGit / Git for Windows |
| `targets` | `['windows']` | 要管理的端点，`windows` = 本机，其余为 WSL 发行版名 |
| `proxy` | `''` | git 走的代理，留空从系统代理读 |
| `useHttpPath` | `false` | 是否按 host+仓库路径区分凭据（一仓一认证） |
| `probeTimeoutMs` | `20000` | 每条探测命令超时 |

> `cordis.patch.yml` 的 `config:` 在**行激活时**读取 → 改配置**必须重启 App**。

---

## 5. 安全模型

### 5.1 硬约束（代码里强制）

1. **不接收 token**：没有任何工具参数叫 `token` / `password` / `secret`。
   登录走 GCM 自己的交互流程，凭据由 GCM 直接写进凭据管理器。
2. **不落盘密钥**：插件自身不写任何凭据文件。
3. **输出必脱敏**：`redact()` 把 `password=`、`oauth_token:`、`gho_*`、`github_pat_*`
   统一换成 `<类型, len=N>`，只保留「有值 / 多长 / 什么类型」。
4. **删除需二次确认**：`gitok_revoke` 不传 `confirm: true` 直接返回提示，不执行。
5. **改配置前先备份**：`gitok_adopt` 在目标上生成 `~/.gitconfig.bak.gitok-<时间戳>`。

### 5.2 加密如何满足「出机器不能用」

Windows 凭据管理器的底层是 **DPAPI**，用当前用户的 master key 加密。
密文绑定「用户 SID + 机器」，拷到别的机器或别的用户下**解不开**。
已实测 `ProtectedData.Protect/Unprotect`（`CurrentUser` scope）roundtrip 正常。

### 5.3 边界（必须理解，别误判）

> **加密防的是：硬盘被拿走、备份泄露、其他用户账户。**
> **它防不了：本机上以你的身份运行的进程。**

任何以你身份运行的 agent / 脚本，都能通过 GCM 取到解密后的凭据 —— 这是操作系统层面的
设计事实，不是本插件的缺陷。DSH 自己的 `.credentials.yaml` 也是同一个边界（而且它是纯明文）。

同理，`wincredman` 存储在**网络登录 / SSH 会话**下不可用，这是 Windows 凭据管理器的固有限制。
远程会话里要改用 `dpapi` store（`credential.credentialStore=dpapi`）。

---

## 6. 安装与开发

### 6.1 目录结构（符合 dshplug 仓库约定）

```
C:\dsh\dshplug\dsh-gitok\
├─ package.json        # name = dsh-gitok，dsh.bundle.patch 指向 cordis.patch.yml
├─ cordis.patch.yml    # - insert: - id: gitok / name: dsh-gitok
├─ lib\index.js        # 宿主半，导出 { name, inject, Config, apply }
└─ README.md           # 本文件
```

**没有 `lib/client.js`**：本插件不声明 `dsh.client`，纯模型工具插件，没有浏览器半、没有侧栏面板。

### 6.2 安装

```powershell
# 装（link: 目录 Junction，改代码即时生效）
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok

# 完全退出 DSH 再打开（首次加载新 bundle 必须）
```

> 别用 `dsh plugin add` —— 自研插件不在 npm，会去 registry 找然后 404。

装完后 `& C:\dsh\dshplug\install.ps1 -Check` 应显示 `link-junction`。

### 6.3 开发循环

```powershell
# 改 lib\index.js → 保存 → 完全退出 DSH 再打开（宿主半改动需重启）
# 改 cordis.patch.yml 的 config: → 必须重启 App
```

`link:` 是目录 Junction，任何写入方式（原地写 / 删除重建 / 原子改名）都即时生效。
只有三种情况要重跑 `install.ps1`：新机器首次、新增/删除插件、`list.json` 改动。

### 6.4 本地验证（不起 DSH 也能测）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 语法
& $node --check C:\dsh\dshplug\dsh-gitok\lib\index.js

# 加载 + Config 解析
$env:DSH_HOME="C:\Users\franc\.dsh"; $env:DSH_PROFILE="desktop"
& $node -e "import('file:///C:/dsh/dshplug/dsh-gitok/lib/index.js').then(m=>console.log(m.name, typeof m.Config))"
```

跑工具本体需要 mock ctx（`ctx.effect` / `ctx.tools.register`），可参考 `dsh-pixel\test\`。

### 6.5 发布

```powershell
& C:\dsh\dshplug\plugpush.ps1 dsh-gitok "说明" -DryRun   # 先看会提交什么
& C:\dsh\dshplug\plugpush.ps1 dsh-gitok "说明"
& C:\dsh\dshplug\plugpush.ps1 dsh-gitok "v0.1.0" -Tag    # 打版本 tag
```

---

## 7. 待办与已知限制

### 7.1 已验证可用（2026-11-12 实测）

- ✅ `gitok_doctor` 在 Windows + claude 两个端点上输出正确
- ✅ `gitok_verify` 两端点 `ls-remote` 均返回 `38e1b73f...`
- ✅ `gitok_list` 正确显示凭据条目与 GCM 账号
- ✅ `gitok_revoke` 不传 `confirm` 时拒绝执行
- ✅ `gitok_adopt` 接管 claude 后 helper 只剩一条，且端到端仍可用
- ✅ 修复后已把 claude 的 `.gitconfig` 还原（493 字节，与原始一致）

### 7.2 待办

- [ ] `gitok_login` 未做真实登录实测（会弹浏览器，需人工在场）
- [ ] 没有 mock ctx 的自动化测试（`test/` 目录还没建）
- [x] ✅ **已装进 `desktop` profile**（2026-11-12，`list.json` 里 `status: active`、`installedOn: ["REDMIPRO"]`）
- [x] ✅ **重启后已验证**：`gitok_doctor` 在会话里实际可用（2026-11-12 16:37）
- [x] ✅ **v0.2.0 设置面板**：`lib/client.js` + `dsh.client` + Host 路由已写完
- [ ] 设置面板**尚未在界面上实际确认渲染**（需重启后在「设置」里看到「Git 认证」分区）
- [ ] 面板里的「重新登录 / 撤销」按钮未做（目前需 AI 代调工具）
- [ ] `gitok_adopt` 没有 `--dry-run` 选项，只能靠备份回滚
- [ ] 没处理 `gitok_revoke` 之后「其他仓库还在用旧凭据」的提示

### 7.3 已知限制

- 只覆盖 **HTTPS** 认证。SSH 密钥不在管理范围（`gitok_doctor` 能看到现状但不管）
- 代理默认值 `127.0.0.1:7897` 是本机端口，换机器要改
- `wincredman` 在网络登录 / SSH 会话下不可用（改用 `dpapi` store）
- `gitok_doctor` 的 Windows 半边依赖 `pwsh` 在 PATH（PowerShell 7）
- **WSL 功能默认关闭**：`cordis.patch.yml` 的 `targets` 目前只有 `windows`。
  用户 2026-11-12 明确「WSL 的都先不动，后续再改，只改 Windows」。
  要启用时把发行版名加回 `targets`（`claude` / `u26claude4`），或用工具参数临时指定
  （如 `gitok_doctor targets=["claude"]`）——注意 `gitok_adopt` 会**真改** WSL 配置

### 7.4 安装状态（2026-11-12）

| 项 | 值 |
|---|---|
| profile | `desktop` |
| 安装形态 | `link-junction` → `C:\dsh\dshplug\dsh-gitok` |
| profile 依赖 | `dsh-gitok@link:../../../../../dsh/dshplug/dsh-gitok` |
| 激活方式 | 自身 `dsh.bundle.patch`，**不**往 profile 的 `cordis.patch.yml` 写 insert |
| 生效条件 | **完全退出 DSH 再打开**（宿主半首次加载必须重启） |

验证过的事项：

- `install.ps1 -Check` → `link-junction`
- 透过 Junction 能读到源码目录全部 5 个文件（改代码即时生效）
- 从 profile 的 `node_modules` 能解析并 `import`，导出 `{name:'gitok', inject:['tools'], Config, apply}` 完整
- `cordis.patch.yml` YAML 可解析，`id: gitok` 与导出的 `name` 一致

---

## 8. 踩坑记录

> 这些坑都真实踩过并修了，改代码前先看一遍能省几小时。

### 8.1 `git config key ""` 不会清空旧值 ⚠️ 最坑

反直觉。很多人以为：

```bash
git config --global credential.https://github.com.helper ""   # ❌ 以为清空了
```

实际上它只是**再追加一个空值**，原有 helper 还在。实测结果：

```
--- 旧行为写入后 ---
                                    # 空行（新加的空值）
!/home/francis/.local/bin/gh auth git-credential    # 旧的还在！
```

结果是「gh helper + GCM 叠加」，两个都生效。正确写法：

```bash
git config --global --unset-all credential.https://github.com.helper
git config --global --add credential.https://github.com.helper '!/mnt/c/.../git-credential-manager.exe'
```

这个 bug 最早写进 `gitok_adopt`，实测时发现「复查 helper」打出两行才抓到。
现在代码里用 `--unset-all` 并在复查时检查行数 > 1 就告警。

### 8.2 URL 作用域的 helper 查不到

`git config --get-all credential.helper` 对 `credential.<url>.helper` 这种
**什么都不返回**。必须：

```bash
git config --global --get-regexp '^credential\..*\.helper$'
```

第一次跑 `gitok_doctor` 时 claude 端点 helper 显示空白，就是因为用了 `--get-all credential.helper`。

### 8.3 Windows 侧 pwsh 中文乱码

`cmdkey /list` 等外部程序按 OEM 码页输出，Node 按 UTF-8 解码就是乱码：

```
---- ƾ�ݹ�������� git ��Ŀ ----     # 实际是「凭据管理器里的 git 条目」
```

解法：在 PowerShell 脚本开头强制 UTF-8。

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
```

`gitok_doctor` 和 `gitok_list` 两处都加了这个前缀。

### 8.4 schemastery 在 link 安装下解析不到

`@deepseek-ai/schemastery` 由宿主提供。link 安装的本地目录里，静态 `import` 会失败。

而且**直接 `import` 包目录也不行**：

```
ERR Directory import '...\@deepseek-ai\schemastery' is not supported
    resolving ES modules
```

因为它的 `package.json` 里 `main` 是 `lib/index.cjs`、`exports.import` 是 `lib/index.mjs`，
没有 `index.js`。硬拼 `path.join(dir, 'index.js')` 也 404。

正解：用 `createRequire(path.join(dir, 'package.json'))` 建根的 require，
再用 `.resolve('@deepseek-ai/schemastery')` 走 `exports` 字段拿真实入口。

```js
const rootReq = createRequire(path.join(c, 'package.json'))
const entry = rootReq.resolve('@deepseek-ai/schemastery')   // → lib/index.cjs 或 lib/index.mjs
const mod = await import(pathToFileURL(entry).href)
const z = mod?.default ?? mod
```

全都失败则退化成「无 Config」（`Config = undefined`）—— 工具仍可用，只是设置面板不出现表单。

### 8.5 volatile 配置字段是包装对象

`Config` 里标了 `.volatile()` 的字段，运行时拿到的是**包装对象**而不是普通值：

```js
config.targets        // → { get: [Function], Symbol(cosmokit.volatile.write): ... }
```

不拆包就会把对象当字符串用。代码里 `unwrap()` / `cfg()` 两个函数专门处理这个，
最多剥 4 层防死循环。

### 8.6 WSL 里 `127.0.0.1` 的代理可达性

`.wslconfig` 有 `networkingMode=mirrored`，所以 WSL 里的 `127.0.0.1:7897`
能直通 Windows 的代理。但**不要依赖这一点**：`autoProxy=true` 已经把
`HTTPS_PROXY` 注进 WSL 环境变量了，用环境变量更稳。

注意：`env -i` 看是 0 个代理变量，`bash -ic` 看是 6 个 —— 因为它是 login shell 才加载的。

### 8.7 `\s*` 会吃掉换行符，正则解析多行文本必坑

写 `parseStatus()` 时踩的。从体检文本里抓值：

```js
// ❌ 错：目标值为空时，\s* 吃掉换行，.+ 抓到下一行
const scoped = text.match(/^helper\(scoped\):\s*(.+)$/m)?.[1]
```

实测：`helper(scoped):` 后面是空的时候，抓到了 `credentialStore: (default = wincredman)`。
界面上就会出现「仓库级 helper = credentialStore...」这种荒唐值。

根因：JS 的 `\s` 包含 `\n`。`\s*` 贪婪地跨过了换行符，然后 `.+` 在**下一行**匹配成功。
而 `/m` 只影响 `^` / `$` 的语义，不影响 `\s` 的字符类。

```js
// ✅ 正：限定在行内空白，并且用 (.*) 允许空
const scoped = text.match(/^helper\(scoped\):[ \t]*(.*)$/m)?.[1] ?? ''
```

两个要点：`[ \t]*` 代替 `\s*`；`(.*)` 代替 `(.+)`（否则空值匹配不上，又回退去跨行）。

### 8.8 Client 半的 `t` 必须用 `ctx.locale.bind(NS)`

第一版写成 `const t = (s) => s`（一个直通函数），结果 locale 字典注了也白注，
设置侧边栏的导航文字拿不到翻译值。

```js
// ❌ 错：字典注册了也不生效
const t = (s) => s

// ✅ 正：从 locale 服务拿绑定函数
ctx.effect(() => ctx.locale.register(NS, { zh:{nav:'Git 认证'}, en:{nav:'Git Auth'} }), '...')
const t = ctx.locale.bind(NS)
```

对照 `dsh-getbrain/client.js:1125` 同写法。注意 `t` 要在 `register` **之后**定义。

### 8.9 加了 `dsh.client` 必须重装，不能只靠 Junction

`link-junction` 让**代码**改动即时生效，但 `package.json` 里的 `dsh.client` 声明
是安装时写进 profile 的。新增浏览器半后如果只改代码不重装，DSH 根本不会去加载 `client.js`。

```powershell
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok -Force
```

`-Force` 必须加：不加的话 `install.ps1` 看到已是 `link-junction` 就认为「无需操作」。
但 `-Force` 会先 `remove` 再 `add`，**没重启 DSH 时可能让运行中的实例短暂找不到包**，
所以顺序上先重装、再重启。

### 8.10 设置面板要读真实数据，必须开 Host 路由

Client 半拿不到 Host 的工具，也起不了 pwsh 子进程。所以「当前认证通不通」
这件事，必须在 Host 侧开一个 HTTP 路由，面板去 fetch。

同 `dsh-getbrain` 的做法：

```js
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: '/plugins/gitok/status',
    handler: async (req, res) => { /* ... */ },
  }), 'gitok: status route')
})
```

注意 `ctx.inject(['webServer'], fn)` 是**服务就绪才回调**；如果宿主没有 webServer
（比如纯 CLI 模式），这段不会执行，但插件其余部分照常工作。

---

## 9. 换工作区继续开发（交接清单）

> 2026-11-12 已从临时工作区搬入 `C:\dsh\dshplug\dsh-gitok`，这是唯一开发位置。

这个插件**没有留在临时工作区**，代码已经放进 dshplug 仓库。换机器 / 换工作区后按下面做：

### 9.1 取代码

```powershell
# 方式 A：本机已在 C:\dsh\dshplug（当前状态）
cd C:\dsh\dshplug

# 方式 B：新机器 clone（路径必须一致，link: 写死绝对路径）
git clone https://github.com/mengfanchun2017/dshplug.git C:\dsh\dshplug
```

### 9.2 把 DSH 工作区切到插件目录

在 GUI 里「选择工作区」→ 选 `C:\dsh\dshplug\dsh-gitok`。
之后新会话的 `cwd` 就在插件目录，右侧终端打开即是，不用 `cd`。
（会话 cwd 硬绑定绝对路径，两台机器要保持逐字符一致。）

### 9.3 新机器要做的三件事

```powershell
# ① 装插件（建 link: Junction）
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok

# ② 完全退出 DSH 再打开

# ③ 验收
& C:\dsh\dshplug\install.ps1 -Check    # 期望 dsh-gitok 是 link-junction
```

### 9.4 起手先读什么

| 顺序 | 读什么 | 为什么 |
|---|---|---|
| 1 | 本文件 §8 踩坑记录 | 六个坑，每个都能浪费你几小时 |
| 2 | 本文件 §5 安全模型 | 别在实现里破坏「不接收 token / 不落盘」 |
| 3 | `docs\git-auth-audit-2026-11-12.md` | 原始盘点报告，含全部实测数据与命令 |
| 4 | `lib\index.js` 顶部注释 | 设计目标与安全铁律写在文件头 |
| 5 | `~\.dsh\AGENTS.md` | 全局开发/归档约定 |

### 9.5 本机当前 git 认证状态（2026-11-12 收尾）

| 项 | 状态 |
|---|---|
| Windows git 代理 | ✅ 已配 `http.proxy` / `https.proxy` = `127.0.0.1:7897`，`ls-remote` 通过 |
| Windows 凭据 | ✅ GCM `wincredman`，`git:https://github.com`，用户 `mengfanchun2017` |
| WSL `claude` | ⏸ **未改动**，仍用 gh helper + 明文 PAT（按用户要求保持原样） |
| WSL `u26claude4` | ⏸ **未改动**，仍有空口令 SSH 私钥（待后续处理） |
| 本插件 | `status: dev`，未装进 profile |

---

## 10. 相关文档

- 仓库总览：[`../README.md`](../README.md)
- 命令行操作手册：[`../BOOTSTRAP.md`](../BOOTSTRAP.md)
- 原始盘点报告：[`docs/git-auth-audit-2026-11-12.md`](docs/git-auth-audit-2026-11-12.md)
- 全局规则（含归档/开发约定）：`~/.dsh/AGENTS.md`
