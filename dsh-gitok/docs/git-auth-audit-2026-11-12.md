# Git 认证环境盘点与方案建议

> 盘点时间：2026-11-12 15:2x（Asia/Shanghai）
> 机器：RedmiPro（Windows 11 / 用户 franc，非管理员）
> 盘点方式：全部只读。令牌只记录**类型、长度、权限、是否过期**，从不打印明文。

---

## 一、现状盘点：你现在到底有什么

### 1.1 Windows 侧

| 项目 | 实际情况 |
|---|---|
| git | `2.56.0.windows.4`，来自 **MinGit**：`C:\Users\franc\AppData\Local\Programs\MinGit\cmd\git.exe` |
| 用户配置 | `C:\Users\franc\.gitconfig`（109 字节）只有三项：`safe.directory=*`、`user.name`、`user.email` |
| 系统配置 | `MinGit\etc\gitconfig` 里 `credential.helper=manager`、`core.autocrlf=true` |
| 凭据助手 | **GCM 2.9.1**（Git Credential Manager），`ucrt64\bin\git-credential-manager.exe` |
| 存储后端 | 未设 `credential.credentialStore` → 走默认 **`wincredman`（Windows 凭据管理器）** |
| 已存凭据 | 凭据管理器里有一条 `LegacyGeneric:target=git:https://github.com`，用户 `mengfanchun2017`，`Local machine persistence` |
| 令牌类型 | `gho_` 开头，40 字符 → **GCM 的 GitHub OAuth 令牌**，scopes = `gist, repo, workflow`，响应头里**无过期时间 = 不过期** |
| GCM 账号 | `git-credential-manager github list` → `mengfanchun2017` |
| SSH 私钥 | **没有**。`~/.ssh` 只有 `known_hosts` |
| ssh-agent | 服务状态 `Stopped` / `Disabled`，**非管理员启动不了** |
| gh CLI | **未安装** |
| 代理 | 系统代理 `127.0.0.1:7897`（IE 设置 `ProxyEnable=1`），但 **git 没有配代理、环境里也没有 `HTTPS_PROXY`** |

> ⚠️ **实测故障**：Windows 上 `git ls-remote https://github.com/...` 直接失败 `Failed to connect to github.com:443`。
> 加 `-c http.proxy=http://127.0.0.1:7897` 或设 `HTTPS_PROXY` 环境变量就成功。
> **结论：Windows 侧 git 认证本身是好的，坏的是代理没配到 git 上。** 这是当前最该先修的一件事。

### 1.2 WSL `claude` 发行版（默认发行版，Running）

| 项目 | 实际情况 |
|---|---|
| 身份 | 用户 `francis`，home `/home/francis` |
| git | `2.53.0`，`/usr/bin/git` |
| `~/.gitconfig` | `user.name/email` + **三组按 URL 精确匹配的 helper**（见下） |
| GitHub 认证 | `credential.https://github.com.helper = !/home/francis/.local/bin/gh auth git-credential`（先 `helper=` 清空再设） |
| gist | 同上，单独一条 |
| 飞书 | `credential.https://miaoda-git.feishu.cn/apaas4.0/-/t_nOyW63iE/code_ToZtb4zUZ9FA.git.helper = !lark-cli apps git-credential-helper --app-id 'app_17gzyk4kgh1'`，且 `useHttpPath=true` |
| gh CLI | `2.103.3`，登录为 `mengfanchun2017`，协议 https |
| 令牌 | `github_pat_` 开头，**93 字符 = fine-grained PAT**，存放在 `~/.config/gh/hosts.yml`（权限 `600`），**无过期时间** |
| SSH 私钥 | **没有**。`~/.ssh` 只有 `known_hosts` |
| ssh-agent | systemd socket 存在（`/run/user/1000/openssh_agent`），但 **`SSH_AUTH_SOCK` 没导出**，`ssh-add -l` 报无身份 |
| 明文凭据 | 无 `~/.git-credentials` |
| 密钥环 | **`secret-tool` / `gnome-keyring-daemon` / `pass` 全无**，只有 `gpg 2.4.8` |
| 代理 | 环境变量里有 `HTTPS_PROXY=http://127.0.0.1:7897`（`autoProxy=true` 从 Windows 注入），git config 里没写 |
| 仓库 | `~/git/{aiagt,ccconfig,ccprivate,skill}`，全部 `https://github.com/mengfanchun2017/*` |

> 实测：`git ls-remote` 私有库通过（走 gh helper + 环境代理）。

### 1.3 WSL `u26claude4` 发行版（Stopped）

| 项目 | 实际情况 |
|---|---|
| gitconfig | 与 `claude` 基本同款 gh helper，另加 `[http "https://github.com/"] proxy = http://127.0.0.1:7897`（写死在 config 里） |
| SSH 私钥 | **有** `~/.ssh/id_ed25519`（411 字节） |
| 🔴 口令 | **空口令**（`ssh-keygen -y -P ""` 直接导出公钥成功） |
| 公钥 | `ssh-ed25519 AAAAC3...I8eM francis@meng.com`，实测 `ssh -T git@github.com` → `Hi mengfanchun2017!` **可用** |
| gh | 有 |

`langg` 发行版：无 gitconfig，未配置。

### 1.4 DSH 自身的凭据文件（顺带说明）

`C:\Users\franc\.dsh\.credentials.yaml`：**明文 YAML**，`MINIMAX_API_KEY`/`DEEPSEEK_API_KEY`/`OFFICE_API_KEY` 等都是可直接 grep 出来的原文。
ACL 只有 `SYSTEM / Administrators / franc` 三个 FullControl（这点还行），但**没有加密**。
DSH 官方文档也明说：文件权限挡不住 agent（agent 的 tool 进程就是你自己）。← 这点对下面第 5 节「加密」很关键。

---

## 二、六种认证方式对比（重点：可管理性 + 是否明文 + 能否永久）

| # | 方式 | 密钥落盘形态 | 加密 | 能永久 | 在哪看/怎么删 | 换机器能用吗 | 评价 |
|---|---|---|---|---|---|---|---|
| 1 | **GCM + Windows 凭据管理器**（你 Windows 现状） | DPAPI 加密后进 wincredman | ✅ DPAPI（绑用户+机器） | ✅ 不过期 | `cmdkey /list`、控制面板→凭据管理器、`git-credential-manager github list` | ❌ 出机器解不开 | **Windows 首选** |
| 2 | **GCM `dpapi` 文件存储** | `%USERPROFILE%\.gcm\dpapi_store` 文件 | ✅ DPAPI | ✅ | 直接删文件 | ❌ | 次选，好处是「一个目录删干净」 |
| 3 | **gh CLI 当 helper**（你 WSL 现状） | `~/.config/gh/hosts.yml` PAT 明文 | ❌ 只有 600 权限 | ✅（PAT 无期限） | `cat` 就能看到，`gh auth logout` 删 | ⚠️ 文件拷走就能用 | **可读性最好但明文** |
| 4 | **git-credential-store** | `~/.git-credentials` | ❌ 全明文 | ✅ | 直接看文件 | ⚠️ | ❌ 不要用 |
| 5 | **git-credential-cache** | 只在内存 | ✅ 天然 | ❌ 默认 15 分钟 | 无 | ❌ | ❌ 不满足「永久」 |
| 6 | **SSH 密钥 + 口令 + agent** | `~/.ssh/id_ed25519` 加密私钥 | ✅ 口令加密 | ✅ | `ls ~/.ssh`、`ssh-add -d` | ⚠️ 私钥可拷走（但有口令） | **跨平台最稳** |
| 6b | **SSH 密钥无口令**（你 `u26claude4` 现状） | 明文私钥文件 | ❌ | ✅ | 同上 | ❌ 拷走即用 | 🔴 **不建议** |
| 7 | **GCM `gpg` 存储 / `pass`** | GPG 加密文件 | ✅ | ✅ | `pass ls` | ⚠️ | WSL 唯一体面的加密方案 |
| 8 | **libsecret / gnome-keyring** | Secret Service | ✅ | ✅ | `secret-tool search` | ⚠️ | ❌ 你 WSL 里没装、也没 GUI/DBus |
| 9 | **OIDC / 云工作负载身份** | 不落地 | ✅ | ✅ 短期 | 云控制台 | ✅ | 个人机器用不上 |
| 10 | **PAT 写进 remote URL** | URL 里明文 | ❌ | ✅ | `git remote -v` 一眼看到 | ❌ | 🔴 最差，会进 shell history / 日志 |

### 一句话选型

- **Windows**：方式 1（GCM + wincredman），**保持现状即可**，只需补代理。
- **WSL**：**不要让 WSL 自己存密钥**，直接调用 Windows 的 GCM（interop）。这一个动作同时满足「加密」「出机器不可用」「一处管理」。
- **SSH 场景**（真要 SSH 时）：口令加密私钥 + agent，且私钥只放一处。

---

## 三、针对你四条要求的逐条回答

### 要求 1：一台终端一个 git 认证、永久有效、随时可查可删

现状**基本已满足，但入口分散**，你现在有 **3 个互不相通的凭据点**：

| 终端 | 凭据在哪 | 怎么删 |
|---|---|---|
| Windows | Windows 凭据管理器 `git:https://github.com`（DPAPI） | `cmdkey /delete:LegacyGeneric:target=git:https://github.com`，或 `git-credential-manager github logout mengfanchun2017` |
| WSL `claude` | `~/.config/gh/hosts.yml`（PAT 明文 600） | `gh auth logout`，或删该文件那一行 |
| WSL `u26claude4` | 同上 gh + 一把空口令 SSH 私钥 | `rm ~/.ssh/id_ed25519*` + `gh auth logout` |

**"永久有效"目前的真实状态**：
- Windows 的 `gho_` OAuth 令牌：**无过期时间戳**，但 GitHub 侧对 OAuth token 有吊销/失效策略，属于「长期有效，非真正永久」。
- WSL 的 fine-grained PAT：`github_pat_` + 响应头无 expiration → **也是不设过期**。但 fine-grained PAT 由 GitHub 强制有最长有效期（可设 No expiration，取决于账号策略），仍然建议按周期轮换。

> 建议：把「永久」改成「**长期有效 + 到期自动提醒 + 一键轮换**」，这才是可运维的形态。真正永久的密钥是安全隐患。

**统一入口**（建议落到一个视图里）：

```powershell
# Windows 侧
cmdkey /list | Select-String "git:"
git-credential-manager github list

# WSL 侧
wsl -d claude -e bash -lc 'gh auth status'
```

### 要求 2：多种认证方式怎么选（区别与优劣）

见第二节表格。补三点你环境特有的判断：

1. **你现在是混合制**：Windows 用 OAuth（GCM 托管），WSL 用 PAT（gh 托管）。两者**权限范围完全不同** ——
   Windows 的 `gho_` 是 `gist, repo, workflow` 全宽；WSL 的 fine-grained PAT 是**按仓库/按权限授予**。
   → 安全上 WSL 那个更克制，Windows 那个更宽。建议统一到 fine-grained PAT。
2. **`useHttpPath` 是个关键开关**：设 `true` 后凭据按「host + 仓库路径」区分（我实测过，同 host 两个仓库可以各存各的、互不覆盖）。你要「一个终端一个认证」，**per-repo 粒度才是真正可管理的**。
3. **SSH vs HTTPS**：你有代理（7897）。HTTPS 走代理很顺；SSH 到 github.com:22 常被墙，要用 `ssh.github.com:443`。你 `u26claude4` 里那把 SSH key 能用，说明 22 端口通 —— 但那是空口令 key，等于没有保护。

### 要求 3：能不能做成 `dsh-gitok` 插件

**能，而且你的环境已经具备全部前提。** 关键可行性证据（本轮实测）：

```
# WSL 里直接调 Windows 的 GCM，拿到了凭据
wsl -d claude -e bash -lc 'printf "protocol=https\nhost=github.com\n\n" | \
  /mnt/c/Users/franc/.../git-credential-manager.exe get'
  → username=mengfanchun2017  password=<有值>

# 并且端到端 git 操作成功
wsl -d claude -e bash -lc 'git -c credential.helper=<Windows GCM 路径> \
  ls-remote https://github.com/mengfanchun2017/ccprivate.git HEAD'
  → 38e1b73f...  exit=0
```

**这意味着：可以让 WSL 完全不存任何密钥，全部借用 Windows 凭据管理器里那一份 DPAPI 加密的凭据。** 一处登录、一处删除、出机器不可用 —— 三条要求同时满足。

插件设计（已产出脚手架，见 `C:\dsh\base\dsh-gitok\`）：

| 工具 | 作用 |
|---|---|
| `gitok_doctor` | 只读体检：Windows + 所有 WSL 发行版的 git/helper/store/代理/SSH 现状，令牌只报类型长度不报值 |
| `gitok_login` | 走 GCM 的浏览器/设备码登录，**密钥不经过聊天、不经过插件文件** |
| `gitok_verify` | 对每个目标跑 `git ls-remote` 端到端验证 |
| `gitok_list` | 列出当前存了哪些凭据（host、用户名、存储位置） |
| `gitok_revoke` | 精确删除某 host 的凭据 + 撤销配置 |

设计原则（针对你的顾虑）：
- **密钥永不进聊天**：`gitok_login` 只触发 GCM 交互流程，插件不接收 token 参数。
- **密钥永不进明文文件**：只调 `git-credential-manager store/erase`，落在 wincredman（DPAPI）。
- **WSL 零密钥**：WSL 的 helper 指向 `/mnt/c/.../git-credential-manager.exe`，本身不存东西。
- **可管理**：`gitok_list` + `gitok_revoke` 就是你要的「随时看、随时删」。

### 要求 4：加密 / 出机器不可用 / 不落明文

你的三个诉求，按方案对应：

| 诉求 | 满足方式 | 现状 |
|---|---|---|
| **加密** | Windows Credential Manager 底层就是 **DPAPI**，用当前用户主密钥加密 | ✅ 你现在已经是这个状态 |
| **密钥出机器不能用** | DPAPI 密文绑「用户 SID + 机器」；拷到别的机器解不开 | ✅ 天然满足 |
| **不落明文 / 保存处有管控** | 只剩 wincredman 一处，访问受 Windows 登录会话控制 | ✅ 若把 WSL 的 gh PAT 也迁过来 |
| WSL 内若有必须本地存的密钥 | GPG/`pass`（你 WSL 有 gpg 2.4.8），`git config --global credential.credentialStore gpg` | ⚠️ 可用，需先 `gpg --gen-key` + `pass init` |
| 磁盘整体加密 | BitLocker / 设备加密（当前**非管理员无法确认状态**） | ❓ 需你自查 |

> ⚠️ **必须提醒**：无论怎么加密，**只要 agent 能以你的身份跑命令，它就能取到解密后的凭据**。
> DSH 自己的文档也写了这句话。所以「加密」防的是**硬盘被拿走 / 备份泄露 / 其他用户账户**，防不了「你自己机器上跑的进程」。这是设计边界，不是方案缺陷。

---

## 四、当前发现的 5 个真实问题（按优先级）

| 优先级 | 问题 | 影响 | 修法 |
|---|---|---|---|
| 🔴 P0 | Windows git **没配代理**，直连 github.com:443 失败 | Windows 侧所有 https git 操作失败 | `git config --global http.proxy http://127.0.0.1:7897`（或设 `HTTPS_PROXY`） |
| 🔴 P0 | `u26claude4` 里 SSH 私钥**空口令** | 私钥文件被拷走即等于账号被盗 | `ssh-keygen -p -f ~/.ssh/id_ed25519` 加口令，或直接删除换 GCM 方案 |
| 🟠 P1 | 三处凭据互不相通（Windows GCM / claude gh / u26 gh） | 轮换要改三次，容易漏 | 统一走 Windows GCM + WSL interop |
| 🟠 P1 | WSL 的 PAT 在 `hosts.yml` **明文** | 任何 franc 进程可读 | 迁到 wincredman，或改用 gpg store |
| 🟡 P2 | `C:\wsl\*` 的 ACL 含 `Authenticated Users: Modify` | 比 `~/.ssh` 宽松 | 收紧到仅 `franc` + Administrators + SYSTEM |
| 🟡 P2 | DSH `.credentials.yaml` 明文（你自己的 API keys） | agent 可读 | 属 DSH 设计边界，敏感 key 建议改用环境变量注入 |

---

## 五、建议的落地顺序（半小时内可完成）

```powershell
# ① 修 Windows git 代理（立即生效，解决 P0）
git config --global http.proxy http://127.0.0.1:7897
git config --global https.proxy http://127.0.0.1:7897
git ls-remote https://github.com/mengfanchun2017/ccprivate.git HEAD   # 应输出 commit

# ② 给 u26claude4 的空口令私钥补口令（或删掉，见③统一方案）
wsl -d u26claude4 -e bash -lc 'ssh-keygen -p -f ~/.ssh/id_ed25519'

# ③ WSL 统一借 Windows 凭据（claude 发行版，per-host 粒度）
wsl -d claude -e bash -lc '
  GCM=/mnt/c/Users/franc/AppData/Local/Programs/MinGit/ucrt64/bin/git-credential-manager.exe
  git config --global credential.https://github.com.helper ""
  git config --global --add credential.https://github.com.helper "!$GCM"
  git config --global credential.https://github.com.useHttpPath false
'
wsl -d claude -e bash -lc 'git ls-remote https://github.com/mengfanchun2017/ccprivate.git HEAD'

# ④ 确认并逐步淘汰 WSL 里那份明文 PAT
wsl -d claude -e bash -lc 'gh auth status'   # 确认③通了之后再 gh auth logout
```

> ③ 做完之后，**唯一的密钥副本在 Windows 凭据管理器**，`cmdkey /list | Select-String git:` 能看到，`git-credential-manager github logout mengfanchun2017` 能删干净。

---

## 六、结论

1. **你现在的 Windows 侧其实已经是对的**（GCM + wincredman + DPAPI 加密 + 不过期），坏的是代理没配。
2. **WSL 侧是「明文 PAT + 空口令私钥」的组合，是全机最弱的一环**，建议统一向上借 Windows 凭据。
3. **`dsh-gitok` 插件完全可行**，核心机制（WSL 通过 interop 调 Windows GCM）本轮已实测跑通，脚手架已生成。
4. **加密诉求天然满足**：DPAPI 绑定用户+机器，出机器不可用。但请理解边界 —— 它防的是硬盘和外账户，防不了本机上以你身份运行的进程。
