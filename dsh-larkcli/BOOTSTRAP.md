# dsh-larkcli · BOOTSTRAP（怎么做）

| 文档 | 回答什么 | 什么时候读 |
|---|---|---|
| [README.md](README.md) | **怎么用**：工具、面板、多账户、例子 | 想用它做点什么 |
| **BOOTSTRAP.md**（本文） | **怎么做**：安装、验证、排错、换机、升级、改哪要重启 | 装不上 / 坏了 / 换机器 |
| [ADR.md](ADR.md) | **为什么**：决策 + 反面代价 + 已否决方案 | 想改设计 |

---

## 0. 先看三条

### 0.1 `lark_*` 是模型工具，不是 PowerShell 命令

在 PowerShell 里敲 `lark_call` 会得到 `无法将"lark_call"项识别为 cmdlet` —— 这是**正常**的，
它不是 exe 也不在 PATH 里。它是给 AI 会话用的工具，要触发就在对话里说「跑一下 lark_doctor」。

（人手想在终端里试，用 `.\lark.ps1 "im +chat-list --as bot"`，那是另一个入口。）

### 0.2 改哪要重启、改哪刷页面就行

| 改了什么 | 生效方式 | 耗时 |
|---|---|---|
| `lib/client.js`（浏览器半 / 面板） | **刷新页面** | 1s |
| `lib/index.js` / `lib/core.js` / `lib/service.js`（宿主半） | **完全退出 DSH 再打开** | 20s |
| `cordis.patch.yml` 的 `config:` | **完全退出 DSH 再打开**（行激活时读） | 20s |
| `package.json` 的 `dsh.client` / `files` | **重装**（`install.ps1 -Force`）+ 重启 | 1min |
| `lark-cli-win\lark-cli.exe` 升级 | **重启**（进程按路径现起，但版本缓存要重载） | 20s |

> **「刷新页面」≠「重启 DSH」**。宿主半改动只刷页面**不生效** —— 这是这类项目最容易误判的一条。
> 判断方法：改完宿主半后调一个工具，若行为没变就是没重启。

### 0.3 装是 `link:` Junction，之后改代码不用再装

`install.ps1` 建的是目录 Junction（不是文件硬链接），所以改完保存就生效，
不用重跑 install、不用退出 DSH。只有三种情况要再跑：新机器首次、增删插件、`list.json` 改了。

---

## 1. 首次安装

```powershell
# ① 确认清单里有它、status=active、bundle 合格
& C:\dsh\dshplug\install.ps1 -Check

# ② 装（建 link: Junction）
& C:\dsh\dshplug\install.ps1 -Only dsh-larkcli

# ③ 补齐二进制（不入 git，50 MB，带官方 SHA256 校验）
cd C:\dsh\dshplug\dsh-larkcli
.\scripts\fetch-lark-cli.ps1

# ④ 完全退出 DSH 再打开（首次加载新 bundle 必须重启）
```

`-Check` 应该显示 `dsh-larkcli  v0.1.0  status=active  link-junction`。

### 为什么不用 `dsh plugin add`

`package.json` 里没有 npm 上的包，`dsh plugin add dsh-larkcli` 会去 npm 找、必然失败。
自研插件一律 `install.ps1`（写 `link:` 绝对路径）。也**不要**用 `plugin_manager` 的
`install_bundle` —— 那条路会写 profile 的 `package.json`，与本仓库的 link: 机制冲突。

---

## 2. 验证（4 层，从便宜到贵）

### 2.1 文件与依赖（不启 DSH）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd C:\dsh\dshplug\dsh-larkcli

& $node test/run.mjs      # 38 项：纯函数 + 数据层 + 失败态
& $node test/client.mjs   # 浏览器半形态与 slot 注册
& $node test/smoke.mjs    # 宿主半结构与 9 个工具是否齐全
& $node test/tools.mjs    # 27 项：真实 CLI + 真实凭据跑每个工具
& $node test/e2e.mjs      # 端到端：迁移旧凭据 → status/call/schema
```

全绿再往下。当前实测：**38 + 27 + client + smoke 全通过**。

### 2.2 宿主半能被加载（不启 DSH）

```powershell
& $node -e "import('file:///C:/Users/franc/.dsh/profiles/desktop/node_modules/dsh-larkcli/lib/index.js').then(m=>console.log('name='+m.name,'Config='+(m.Config?'yes':'no'),'dataDir='+m.DERIVED.dataDir))"
```

应输出 `name=dsh-larkcli Config=yes dataDir=C:\dsh\data-larkcli`。

### 2.3 重启后在会话里

```
lark_doctor     # 二进制/版本/数据目录/账户表/每个账户的 secret 与 bot·user 状态
lark_status     # 默认账户的 bot/user
```

`lark_doctor` 是**唯一**会主动告诉你「下一步调哪个工具」的地方，换机器先跑它。

### 2.4 面板

设置 → **飞书**。看到账户卡片就说明浏览器半生效。

HTTP 路由也可直接探（Host 起了才有）：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:64594/plugins/larkcli/status' -UseBasicParsing
```

端口每次启动都变，从运行时上下文取当前 URL。
**重启前探到 404 是正常的** —— 说明 Host 半还没加载，不是坏了。

---

## 3. 排错表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 会话里没有 `lark_*` 工具 | bundle 没激活：没装 / 没重启 | `install.ps1 -Only dsh-larkcli` → **完全退出**重开 |
| `-Check` 显示 `missing` | 只登记没安装 | 同上 |
| `-Check` 显示 `orphan` | `dsh plugin remove` 留下的 Junction 残骸 | 跑 `install.ps1`（会先清残骸再装） |
| 工具报「找不到 lark-cli.exe」 | 50 MB 二进制不入 git | `.\scripts\fetch-lark-cli.ps1` |
| 工具报「还没有任何账户」 | 新机器首次，或旧凭据没导入 | `lark_account_upsert` → `lark_account_set_secret` |
| `failed to read secret file` | **这是本次迁移踩的坑**：旧 `config.json` 写死了绝对路径，目录一搬就断 | 插件会按本机路径**重新生成** config.json，重启后会自愈；手改过的 config 删掉即可 |
| bot ❌ | secret 错 / 应用未发布权限 | `lark_account_set_secret` 重写；去开放平台核对权限已发布 |
| user ❌ | 还没授权，或 token 过期太久 | `lark_login_start` → 浏览器 → `lark_login_finish` |
| 面板「状态接口不可用」 | Host 半没加载 | 完全退出 DSH 重开（不是刷页面） |
| 工具超时 | 大查询没分页 | `--page-limit` / `--page-size`，或 `timeoutMs` 加大 |
| 结果被截断 | 默认 24000 字符上限 | 分页；或 `maxChars` 参数 / 配置调大 |
| PowerShell 里敲 `lark_call` 不认 | 它是模型工具 | 正常，见 0.1 |

### 关于那条 DPoP 警告

Windows 上每条命令的 stderr 都会出现：

```
[lark-cli] [WARN] local DPoP setup failed; new tenant token issued as Bearer: failed to prepare key storage lock
```

**这是无害的**，功能不受影响。插件在 `core.js` 的 `cleanStderr()` 里已经过滤掉，不会污染工具输出。
想彻底消掉可在账户目录跑 `lark-cli config set dpop disabled`（会写进该账户的 config）。
注意：直接写 `config.json` 的 `dpopMode` 字段**不生效**（实测 `auth status` 仍报 `preferred`），
必须用 `config set` 子命令。

---

## 4. 换机器（新 Windows，只装 DSH）

```
1) clone 仓库到同一个绝对路径 C:\dsh\dshplug     # 路径必须一致（link: 写绝对路径）
2) & C:\dsh\dshplug\install.ps1 -Only dsh-larkcli
3) cd C:\dsh\dshplug\dsh-larkcli; .\scripts\fetch-lark-cli.ps1
4) 完全退出 DSH 再打开
5) 会话里 lark_doctor → 它会告诉你缺什么
6) 重建账户：
   lark_account_upsert        id="work" ... appId="cli_xxx" description="..." tags=[...]
   lark_account_set_secret    account="work" appSecret="..."
   lark_login_start / _finish （要 user 身份时）
```

**凭据不会跟着仓库走**（数据目录在仓库外，且 `_native-config` 被 `.gitignore` 挡住），
所以新机器必须重新填一次 secret —— 这正是设计意图：密钥不出机器。

---

## 5. 升级二进制

```powershell
# 去 https://github.com/larksuite/cli/releases 查最新版，然后：
cd C:\dsh\dshplug\dsh-larkcli
Remove-Item lark-cli-win\lark-cli.exe            # 脚本见到已存在会跳过
.\scripts\fetch-lark-cli.ps1 -Version 1.0.100 -Sha256 <官方 checksums.txt 里的哈希>
```

GitHub 直连在国内常超时，脚本用官方 npmmirror 镜像。
**必须核对 SHA256**，脚本会拒绝不匹配的包。升级后重启 DSH（版本有缓存）。

---

## 6. 推送 / 同步

```powershell
# 看会提交什么（不提交）
& C:\dsh\dshplug\plugpush.ps1 dsh-larkcli "看看会提交啥" -DryRun

# 真正推
& C:\dsh\dshplug\plugpush.ps1 dsh-larkcli "dsh-larkcli v0.1.0：9 工具 + 多账户 + 设置面板"
```

仓库根 `.gitignore` 已挡住：`_native-config/`（明文 secret）、`*.exe`（50 MB 二进制）、
`*.zip`。

**推之前自查一遍**：

```powershell
git status --short
git check-ignore -v dsh-larkcli/lark-cli-win/lark-cli.exe dsh-larkcli/lark-cli-win/_native-config/appsecret.txt
```

两个都必须命中忽略规则（实测：`*.exe` 与 `**/_native-config/` 都命中）。
`dsh-larkcli/test/*.mjs` **不被忽略**，照常入库（与 `dsh-pixel/test/` 同待遇）—— 见 §7。
（`dsh-pixel` 已于 2026-11-16 退役，仓库根已无此目录；这条举例仍然成立，它的测试在
`archive/dsh-pixel/source/test/`。）

---

## 7. 已知的 `.gitignore` 细节

根 `.gitignore` 里的 `test/*` 与 `!test/README.md` **带斜杠，只锚定仓库根**，
所以它们只管 `<仓库根>/test/`，**不影响** `dsh-larkcli/test/`。

实测确认：

```powershell
git check-ignore -v test/foo.mjs              # 命中 .gitignore:63 test/*
git check-ignore -v dsh-larkcli/test/run.mjs # exit 1 = 未被忽略，会正常提交
```

因此本插件的 5 个测试文件**不需要** `git add -f`，直接 `git add` 即可（`dsh-pixel/test/` 同理）。

> 早前本文件写过「需要 `git add -f`」，那是**错的** —— 已用 `git check-ignore` 实测纠正。
> （`dsh-pixel` 已于 2026-11-16 退役，上面的举例只说明忽略规则，不代表仓库根还有该目录。）
---

## 8. 手工兜底（插件坏了，只想用 CLI）

```powershell
cd C:\dsh\dshplug\dsh-larkcli
.\lark.ps1 auth status
.\lark.ps1 "im +chat-list --page-size 10 --as bot"
.\lark.ps1 "im +messages-search --query 周报 --page-size 5"
```

`lark.ps1` 走的是**同一份** `_native-config`（旧的单账户目录），与本插件的 `data-larkcli` 相互独立。
两条路都能用；插件是给模型用的快路径，`lark.ps1` 是给人用的。详见 [lark-native-setup.md](lark-native-setup.md)。
