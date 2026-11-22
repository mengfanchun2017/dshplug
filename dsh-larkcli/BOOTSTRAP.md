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
| `lib/index.js` / `lib/core.js` / `lib/service.js` / `lib/install.js` / `lib/scopes.js` / `lib/identity.js` / `lib/resolver.js`（宿主半） | **完全退出 DSH 再打开** | 20s |
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
& C:\dsh\dw-plugin\install.ps1 -Check

# ② 装（建 link: Junction）
& C:\dsh\dw-plugin\install.ps1 -Only dsh-larkcli

# ③ 二进制：不用手工下载了。首次启动后在会话里：
#    lark_install action="install"
#    或设置面板 → Mlarkcli → lark-cli 本体 →「安装」
#    （从 registry.npmmirror.com 下载 + 比对官方 SHA256 + 原子替换；不经过 GitHub）
# ④ 完全退出 DSH 再打开（首次加载新 bundle 必须重启）
```

`-Check` 应该显示 `dsh-larkcli  v0.2.1  status=active  link-junction`。

### 1.1 幂等：重复执行不会坏

上面三步**全部可重入**，不需要先卸载、也不会叠出重复条目：

| 重复执行 | 结果 |
|---|---|
| `-Check` 跑多次 | 纯只读，不写任何东西 |
| `-Only` 跑多次 | 检到已有 link 就跳过；配置被改坏的会重建，不会叠第二条 |
| `lark_install action="install"` | 已是最新就直说“已是最新”，不重下载；要强制重装传 `force` |

所以「装坏了」的通用第一动作就是：**再跑一次 `-Only dsh-larkcli`，然后重启**。
不用先想怎么卸干净 —— 没有半步卸载状态。

### 为什么不用 `dsh plugin add`

`package.json` 里没有 npm 上的包，`dsh plugin add dsh-larkcli` 会去 npm 找、必然失败。
自研插件一律 `install.ps1`（写 `link:` 绝对路径）。也**不要**用 `plugin_manager` 的
`install_bundle` —— 那条路会写 profile 的 `package.json`，与本仓库的 link: 机制冲突。

---

## 2. 验证（4 层，从便宜到贵）

### 2.1 文件与依赖（不启 DSH）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd C:\dsh\dw-plugin\dsh-larkcli

& $node test/run.mjs      # 38 项：纯函数 + 数据层 + 失败态
& $node test/client.mjs   # 浏览器半形态与 slot 注册
& $node test/smoke.mjs    # 宿主半结构 + 15 个工具 + 12 条路由都要齐全
& $node test/tools.mjs    # 27 项：真实 CLI + 真实凭据跑每个工具
& $node test/v2.mjs       # 76 项：scopes / resolver / install + 故障回归
& $node test/activate.mjs  # apply() 在 5 种 ctx 下都不崩（无 webServer / config 缺失 / 垃圾 config）
& $node test/sync-merge.mjs # 14 项：config.json 只能合并 —— user token / 未知字段 / currentApp 不得被抹
```

全绿再往下。当前实测：**38 + 27 + 76 + client + smoke + activate 全通过**。

> `test/e2e.mjs` **不在上面**：它是人工诊断脚本（真实凭据跑一遍并打印原始输出，无断言），
> 查“为什么调不通”时手动跑。别把它当回归测试。

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
| 工具报「找不到 lark-cli.exe」 | 50 MB 二进制不入 git | `lark_install action="install"`（或面板「安装」） |
| 升到新版但 `--version` 没变 | 宿主半缓存了版本号 | 完全退出 DSH 重开 |
| 面板显示「镜像不可达」 | npmmirror 不通 | 查代理 / 网络；GitHub 也不通时这是唯一源，没别的路 |
| 工具报「还没有任何账户」 | 新机器首次，或旧凭据没导入 | `lark_account_upsert` → `lark_account_set_secret` |
| `failed to read secret file` | **这是本次迁移踩的坑**：旧 `config.json` 写死了绝对路径，目录一搬就断 | 插件会按本机路径**重新生成** config.json，重启后会自愈；手改过的 config 删掉即可 |
| bot ❌ | secret 错 / 应用未发布权限 | `lark_account_set_secret` 重写；去开放平台核对权限已发布 |
| user ❌ | 还没授权，或 token 过期太久 | `lark_login_start qrcode=true` → 点链接或扫码 → `lark_login_finish` |
| 二维码显示不出来 / 生成二维码失败 | **配置目录是 CLI 的保护区**，`--output` 不能落在 `LARKSUITE_CLI_CONFIG_DIR` 里 | 插件已改用 `mkdtemp`（cwd 也跟着换）；若手改过请抄回这一模式 |
| 面板说「token 存在（未验证）」 | 这是故意的不假装健康 | 点「验证 token」/ `lark_identity verify=true`（~1.1s/账户） |
| 点「我已完成授权」后说「还没检测到你确认授权」 | `auth login --device-code` 是**长轮询**，没点确认就干等；手动按钮等 8s、自动轮询等 5s 就返回 | 先去手机/浏览器点「同意」；device_code 在 10 分钟内仍有效，重复兑换实测幂等（连试 3 次均正常），不会“第二次必败” |
| **授权完成但面板还是「user 未授权」** | 两个完全不同的原因，先分清：<br>① 光在浏览器点「同意」**不会**自动生效，必须拿 device_code 去兑换（0.2.2 前只能手动兑换）；<br>② **0.2.2 及之前有一个致命 bug：`syncCliConfig` 每次都用新对象整份覆盖 `config.json`，把 CLI 刚写进去的 `users`（也就是 user token）抹掉了。** 这才是「点了很多次都没用」的真凶，已存 0.2.3 修复 | ① 已自动轮询（4s/次，10 分钟上限），或点「刷新状态」；<br>② 升到 0.2.3+。**自检办法**：看 `auth status` 里 `user.status`。如果它是 `missing` 且账户目录里粘着一个 `refresh_<appId>_ou_<openid>.lock`，那就是“token 曾经存在过、随后被抹掉”的典型痕迹 |
| **`config.json` 里的 user token 会不会再被抹掉** | 不可能无条件乐观 | `test/sync-merge.mjs` 专守这一条：连续同步 5 次后断言 `users` / `open_id` / `access_token` / 未知字段 / `currentApp` 全在。已做变异测试：把实现改回整份覆盖，该测试**立即变红** |
| 面板一直「等待你在浏览器/手机上确认…」不停 | 那份 `login-pending.json` 已过期但还在被拿去兑换（0.2.2 前会死循环空转） | 0.2.2 起 `loginFinish` 先校 `expiresAt`，过期就删文件并直说「请重新拿一条新的」 |
| 授权链接过期 / 扫码报错 | 每个 `login-start` 生成新 `flow_id`，旧码只能用一次 | 重新 `lark_login_start`（面板「授权 user 身份」）拿新链接 |
| 面板「状态接口不可用」 | Host 半没加载 | 完全退出 DSH 重开（不是刷页面） |
| **设置里完全找不到「Mlarkcli」，且右键/工具都正常** | **`client.js` 的 `inject` 漏列了 `apply` 里用到的服务**（本插件 0.2.0 真实踩过：用了 `ctx.locale` 却只写 `['slots']`）。Cordis 只注入声明过的服务，没列就是 `undefined`，`apply` 首行抛 `TypeError`，**整个浏览器半静默不注册** | 不是重启问题也不是缓存问题。打桩 ctx 只放声明过的服务跑一遍 `apply`，会直接抛 `Cannot read properties of undefined`；`test/client.mjs` 已加静态守卫，把源码里所有 `ctx.xxx` 与 `inject` 逐个核 |
| 工具超时 | 大查询没分页 | `--page-limit` / `--page-size`，或 `timeoutMs` 加大 |
| `lark_scopes` 说缺权限但开放平台看着已给 | 改完权限没发布 | 开放平台「创建版本并发布」 |
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
1) clone 仓库到同一个绝对路径 C:\dsh\dw-plugin     # 路径必须一致（link: 写绝对路径）
2) & C:\dsh\dw-plugin\install.ps1 -Only dsh-larkcli
3) 完全退出 DSH 再打开
4) 会话里 lark_install action="install"        # 下载 + SHA256 + 原子替换，不需要手敲 PowerShell
5) 会话里 lark_doctor → 它会告诉你缺什么
6) 重建账户：
   lark_account_upsert        id="work" ... appId="cli_xxx" description="..." tags=[...]
   lark_account_set_secret    account="work" appSecret="..."
   lark_scopes profile="read" # 缺什么权限？（给预填好的申请链接）
   lark_login_start / _finish （要 user 身份时）

**凭据不会跟着仓库走**（数据目录在仓库外，且 `_native-config` 被 `.gitignore` 挡住），
所以新机器必须重新填一次 secret —— 这正是设计意图：密钥不出机器。

---

## 5. 升级二进制

**不用手敲命令**，三种方式等价（都走同一套 `lib/install.js`）：

```
lark_install action="check"     # 只查：本机 / 最新 / 镜像可达
lark_install action="install"   # 真升级
```

或设置面板 → Mlarkcli → `lark-cli 本体` →「检查更新」→「升级」。

内部流程（读 `lib/install.js` 可核对）：

1. `GET https://registry.npmmirror.com/-/binary/lark-cli/` 列版本 → 取最大
2. 下载 `lark-cli-<ver>-windows-amd64.zip`（带跟随重定向；npmmirror 会 302）
3. **必须**拿到官方 SHA256 才对；`checksumFor()` 返回空 → **直接拒绝**，不擦“可能没校验”的包
4. 解压到 `lark-cli-win/staging/x-<ver>` → 探活 `--version` → 确认自报版本对
5. 原子替换：旧 exe 重命名为 `.old-<ts>`，新 exe 就位，失败自动回滚
6. 同步 `README.md` / `CHANGELOG.md` / `LICENSE`

GitHub 直连在国内常超时（本机 `ECONNRESET` / `CRYPT_E_REVOCATION_OFFLINE`），
所以**只用 npmmirror**。升级后重启 DSH（版本有缓存）。

---

## 6. 推送 / 同步

```powershell
# 看会提交什么（不提交）
& C:\dsh\dw-plugin\plugpush.ps1 dsh-larkcli "看看会提交啥" -DryRun

# 真正推
& C:\dsh\dw-plugin\plugpush.ps1 dsh-larkcli "dsh-larkcli v0.1.0：9 工具 + 多账户 + 设置面板"
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
cd C:\dsh\dw-plugin\dsh-larkcli
.\lark.ps1 auth status
.\lark.ps1 "im +chat-list --page-size 10 --as bot"
.\lark.ps1 "im +messages-search --query 周报 --page-size 5"
```

`lark.ps1` 走的是**同一份** `_native-config`（旧的单账户目录），与本插件的 `data-larkcli` 相互独立。
两条路都能用；插件是给模型用的快路径，`lark.ps1` 是给人用的。详见 [lark-native-setup.md](lark-native-setup.md)。
