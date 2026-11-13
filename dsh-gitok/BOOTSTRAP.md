# dsh-gitok · BOOTSTRAP 操作手册

> 命令行手册：**装机、验证、排错、迁移**。全部命令可直接复制。
> 代码怎么设计、为什么这么定 → 见 [`ADR.md`](./ADR.md)；面板长什么样 → 见 [`README.md`](./README.md)。
>
> 快照时间：**2026-11-13** ｜ 版本 **0.3.0** ｜ 宿主机 `REDMIPRO` ｜ profile `desktop`

---

## 0. 三个必读前提

### 0.1 路径必须固定在 `C:\dsh\dshplug\dsh-gitok`

`link:` 安装把**绝对路径**写进 profile 的 `package.json`。换路径 = 换机器时必须重装。
不要在别的目录 clone 一份来开发。

### 0.2 改配置要重启 App，改代码不用（但加 `dsh.client` 要重装）

| 改了什么 | 生效方式 |
|---|---|
| `lib/index.js`（宿主半） | **完全退出 DSH 再打开** |
| `lib/client.js`（浏览器半） | 刷新页面（浏览器每次现取） |
| `cordis.patch.yml` 的 `config:` | **完全退出 DSH 再打开**（行激活时读） |
| `package.json` 的 `dsh.client` | **重装插件**（`install.ps1 -Force`）+ 重启 |

「刷新页面」不等于「重启 DSH」。宿主半改动只刷页面是**不生效**的 —— 这是本项目最容易误判的一条。

### 0.3 `gitok_*` 是模型工具，不是命令行命令

在 PowerShell 里敲 `gitok_doctor` 会得到
`无法将"gitok_doctor"项识别为 cmdlet` —— 这是**正常**的，它不是 exe 也不在 PATH 里。
它是给 AI 会话用的工具。要触发就在对话里说「跑一下 gitok_doctor」。

---

## 1. 首次安装

```powershell
# ① 确认清单里有这个插件且 status=active
& C:\dsh\dshplug\install.ps1 -Check

# ② 装（建 link: Junction）
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok

# ③ 完全退出 DSH，再打开
#    首次加载新 bundle 必须重启，Junction 只保证之后改代码即时生效
```

`-Only` 会按 `list.json` 里 `status -eq 'active'` 过滤。
如果报 `没有匹配的插件（检查 -Only 或 list.json 的 status）`，去 `list.json` 确认该条
`status` 是 `"active"`、`installedOn` 含当前机器名（`["REDMIPRO"]`）。

**重装 / 强制刷新**（改了 `package.json` 的 `dsh.client` 或 `files` 时）：

```powershell
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok -Force
```

不加 `-Force` 时，脚本看到已是 `link-junction` 就认为「无需操作」，**不会更新元数据**。
加了 `-Force` 会先 remove 再 add，所以顺序是「先重装、再重启」，不要反过来。

---

## 2. 验证（三层，逐层加深）

### 2.1 第一层：语法与加载（不需要 DSH 运行）

```powershell
$node = "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

# 语法
& $node --check C:\dsh\dshplug\dsh-gitok\lib\index.js
& $node --check C:\dsh\dshplug\dsh-gitok\lib\client.js

# package.json 合法性 + dsh.client 是否在
& $node -e "const j=require('C:/dsh/dshplug/dsh-gitok/package.json');console.log(j.version, !!j.dsh.client, j.files)"
```

期望：两次 `--check` 都不输出内容（exit 0）；第三行打印 `0.3.0 true [...]`。

### 2.2 第二层：宿主半注册（mock ctx，不起 DSH）

```powershell
$node = "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_HOME="$env:USERPROFILE\.dsh"; $env:DSH_PROFILE="desktop"

& $node --input-type=module -e "
const m = await import('file:///C:/dsh/dshplug/dsh-gitok/lib/index.js');
const tools=[], routes=[];
m.apply({
  effect:f=>{f();return()=>{}},
  tools:{register:d=>{tools.push(d.name);return()=>{}}},
  inject:(d,fn)=>fn({effect:f=>{f();return()=>{}},webServer:{register:r=>{routes.push(r.path);return()=>{}}}}),
}, m.Config({targets:['windows']}));
console.log('tools:', tools.join(','));
console.log('routes:', routes.join(','));
"
```

期望输出：

```
tools: gitok_doctor,gitok_list,gitok_verify,gitok_login,gitok_revoke,gitok_adopt,gitok_bootstrap,gitok_rotate,gitok_monitor
routes: /plugins/gitok/status,/plugins/gitok/login,/plugins/gitok/revoke,/plugins/gitok/rotate,/plugins/gitok/bootstrap
```
**这是最有价值的一条验证**：它证明 Host 半能加载、Config 能解析、9 个工具和 5 条路由都注册上了，

### 2.3 第三层：运行时（需要 DSH 正在跑）

```powershell
# 端口每次启动都变，从运行时上下文的 GUI URL 里取，不要写死
  $port = 64594   # ← 换成运行时上下文里的当前端口（每次启动都变）
try {
  $r = Invoke-WebRequest "http://127.0.0.1:$port/plugins/gitok/status" -TimeoutSec 40 -UseBasicParsing
  $j = $r.Content | ConvertFrom-Json
  "level   : $($j.status.level)"
  "summary : $($j.status.summary)"
  "helpers : $($j.status.helper)"
  "creds   : $($j.status.credTargets.Count)"
  "report  : $($j.report.Length) 字符"
} catch { "失败: $($_.Exception.Message)" }
```

期望：

```
level   : ok
summary : 已配置，认证可用
creds   : 1
```

**404 的含义**：路由没挂上。按顺序排查 ①DSH 是否在 `index.js` 修改**之后**启动的
②是否重装过 ③`webServer` 服务是否存在（纯 CLI 模式没有）。

面板里看不见「Git 认证」分区时，先跑这一条 —— 能返回 JSON 就说明问题在浏览器半（`dsh.client`），
返回 404 就说明问题在宿主半（重启/重装）。

---

## 3. 日常开发循环

```powershell
# 只改宿主半 → 重启 DSH
code C:\dsh\dshplug\dsh-gitok\lib\index.js

# 只改浏览器半 → 刷新页面即可
code C:\dsh\dshplug\dsh-gitok\lib\client.js

# 改完必跑的语法门
& $node --check C:\dsh\dshplug\dsh-gitok\lib\index.js
& $node --check C:\dsh\dshplug\dsh-gitok\lib\client.js
```

**同时改两半时按宿主半处理**（要重启）—— 别为了省一次重启而误判「面板没生效」。

### 3.1 单独测 `runDoctor` / `parseStatus`（不经过工具和界面）

这两个函数不导出，用一个临时模块桥接：

```powershell
$node = "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$gcm  = "C:/Users/franc/AppData/Local/Programs/MinGit/ucrt64/bin/git-credential-manager.exe"

& $node --input-type=module -e @"
import fs from 'node:fs';
const p='C:/dsh/dshplug/dsh-gitok/lib/index.js';
fs.writeFileSync('C:/dsh/dshplug/dsh-gitok/lib/_probe.mjs',
  fs.readFileSync(p,'utf8') + '\nexport { runDoctor, parseStatus };');
const m = await import('file:///C:/dsh/dshplug/dsh-gitok/lib/_probe.mjs');
const api = { targets:()=>['windows'], gcm:()=>'$gcm', probeTimeout:()=>20000 };
const text = await m.runDoctor(api);
console.log(JSON.stringify(m.parseStatus(text,'$gcm'),null,2));
fs.unlinkSync('C:/dsh/dshplug/dsh-gitok/lib/_probe.mjs');
"@
```

东西用完自己删，别留在 `lib/` 里（`files` 白名单没列它，但会污染工作区）。

---

## 4. 发布

```powershell
# 预览：会提交哪些文件（不 commit、不 push）
& C:\dsh\dshplug\plugpush.ps1 -Name dsh-gitok -DryRun

# 真正推
& C:\dsh\dshplug\plugpush.ps1 -Name dsh-gitok -Message "dsh-gitok v0.2.1：xxxx"
```

### 4.1 ⚠️ `plugpush.ps1` 会带上仓库根级文件

它除了插件目录，还会 `git add` 根级的 `list.json`、`install.ps1`、`plugpush.ps1`、
`.gitignore`、`README.md`、`BOOTSTRAP.md`，并有一段 fallback 全量清扫。

**如果同时有另一个会话在改根目录，它会把别人未完成的工作一起提交。**

稳妥做法（本仓库曾因此改用）：

```powershell
cd C:\dsh\dshplug
& git add -- dsh-gitok list.json          # 只挑自己的
& git status --porcelain                   # 核对暂存内容
& git -c user.name="Francis Meng" `
      -c user.email="31639417+mengfanchun2017@users.noreply.github.com" `
      commit -m "dsh-gitok v0.2.1：xxxx"
& git push -u origin master
```

分支是 **`master`**。`plugpush.ps1` 的 `-Branch` 参数默认写的是 `'main'`，
但它第 145 行会用 `git branch --show-current` 覆盖，所以实际推的是当前分支 —— 不用手动传。

---

## 5. 迁移到另一个工作区（用户下一步要做的）

目标：把开发从「临时会话」切到 `C:\dsh\dshplug` 工作区继续。

### 5.1 前提

代码**已经在** `C:\dsh\dshplug\dsh-gitok` 且已推送（`8276917`）。
不是「搬过去」，而是「确认那边拿到的是最新版」。

```powershell
cd C:\dsh\dshplug
& git pull --ff-only
& git log --oneline -3
```

应看到与 `dsh-gitok v0.3.0` 相关的提交在最近几条里。

### 5.2 切换 DSH 工作区

把 DSH 的工作区目录设为 `C:\dsh\dshplug`（或它的子目录）。
工作区切换后**新会话**才会注入那边的 `AGENTS.md`。

### 5.3 切过去之后第一件事

```powershell
& C:\dsh\dshplug\install.ps1 -Check          # 确认 dsh-gitok 仍是 link-junction / active
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok -Force   # 换工作区后建议强制刷一次元数据
```

然后**完全退出 DSH 再打开**，跑 §2.3 的运行时验证。

### 5.4 起手读什么（按顺序）

1. `dsh-gitok/README.md` 第 15 行「面板长什么样」+ 第 52 行「为什么做这个」—— 建立目标感
2. `dsh-gitok/ADR.md` —— 先看 ADR-002（不接触密钥）和 ADR-006（WSL 关闭），这两条决定了能改什么
3. `dsh-gitok/README.md` 第 408 行起「踩坑记录」8.1~8.10 —— 十个已经踩过的坑，别重踩
4. 本文件 §2.2 的 mock 注册验证 —— 最快的健全性检查

### 5.5 迁移时最容易丢的东西

| 会丢 | 怎么补 |
|---|---|
| Windows 凭据管理器里的 token | **带不走**（DPAPI 绑机器）。新机跑一次 `gitok_login` |
| `C:\dsh\data-*` 等技能数据目录 | 不在本插件范围。数据不进仓库、不进插件包；到新机后由插件首次运行自动重建（或手动拷贝） |
| profile 里的 `link:` 绝对路径 | 新机路径必须同为 `C:\dsh\dshplug\dsh-gitok`，否则改 `package.json` 重装 |
| 本机特定的 GCM 路径 | 检查 `cordis.patch.yml` 的 `gcmPath`；留空则自动探测 |

### 5.6 新机器第一次跑，可能缺的三样

```powershell
# ① GCM 是否在
Get-Command git-credential-manager -ErrorAction SilentlyContinue
# 找不到就填 cordis.patch.yml 的 gcmPath，指向 git-credential-manager.exe 绝对路径

# ② git 的 schannel 可能报 SEC_E_NO_CREDENTIALS（MinGit 已知问题）
& git config --global http.sslBackend openssl

# ③ 代理（本机是 127.0.0.1:7897，别处可能不同）
& git config --global http.proxy http://127.0.0.1:7897
```

---

## 6. 常见报错对照表

| 现象 | 根因 | 处理 |
|---|---|---|
| `无法将"gitok_doctor"项识别为 cmdlet` | 它是模型工具不是命令 | 在对话里让 AI 调，别在终端敲 |
| 面板里没有「Git 认证」分区 | 加 `dsh.client` 后没重装 / 没重启 | `install.ps1 -Force` + 完全退出重开 |
| 面板报「状态接口不可用」 | `/plugins/gitok/status` 404 | 跑 §2.2 确认路由注册了；确认 `index.js` 修改早于进程启动 |
| `/status` 一直转圈超 30s | `probeTimeoutMs` 太长或 pwsh 卡住 | `cordis.patch.yml` 把 `probeTimeoutMs` 降到 10000 |
| `没有匹配的插件（检查 -Only 或 list.json 的 status）` | `list.json` 那条不是 `active` | 改 `status: "active"` |
| `gitok_doctor` 输出中文乱码 | pwsh 输出编码不是 UTF-8 | 代码里已设 `[Console]::OutputEncoding`；外部脚本自己也要设 |
| helper 写了但没生效 | `git config key ""` **不清空**旧值 | 必须 `--unset-all` 再 `--add`（见 README 8.1） |
| 查不到 URL 作用域的 helper | `--get-all credential.helper` 只查全局 | 用 `--get-regexp '^credential\..*\.helper$'`（见 README 8.2） |
| `resolveGcm` 报 schemastery 找不到 | link 安装下模块解析路径不同 | 已用 `createRequire(path.join(c,'package.json')).resolve(...)` 解决（见 README 8.4） |
| 面板「仓库级 helper」显示了 `credentialStore: ...` | 正则 `\s*` 吃掉换行 | 已改用 `[ \t]*` + `(.*)`（见 README 8.7） |
| 侧边栏导航文字没翻译 | `t` 写成了直通函数 | 必须 `ctx.locale.bind(NS)`（见 README 8.8） |

---

## 7. 撤销与清理

```powershell
# 卸载插件（保留源码目录，只去掉 profile 里的 link）
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok -Force    # 重装用
# 彻底卸载：从 profile 的 package.json 移除 dsh-gitok，或
cd $env:USERPROFILE\.dsh\profiles\desktop
& pnpm remove dsh-gitok

# 撤销 git 凭据（这个才是删凭据，不可逆）
# 在对话里： gitok_revoke host="github.com" confirm=true
```

`gitok_revoke` **必须**显式传 `confirm: true`，否则只返回提示、不执行。
删完该 host 的 git 操作会重新要求认证。

---

## 8. 验收清单（迁移后逐条打勾）

```text
[ ] install.ps1 -Check 显示 dsh-gitok v0.3.0 status=active link-junction
[ ] node --check lib/index.js 通过
[ ] node --check lib/client.js 通过
[ ] mock ctx 测试：tools=9, routes=5（status + login/revoke/rotate/bootstrap）
[ ] 完全退出 DSH 再打开
[ ] 设置里能看到「Git 认证」分区
[ ] 面板徽标颜色正确（ok 绿 / warn 黄 / error 红 / unknown 灰）
[ ] 「持续监控」六行都在，且 unknown 不冒充绿
[ ] 点「重新检查」能刷新（不是转圈卡死）
[ ] 点「查看原始报告」能展开体检文本
[ ] 对话里调 gitok_doctor / gitok_monitor 能返回报告
[ ] GET /plugins/gitok/status 返回 level 字段
[ ] gitok_bootstrap dryRun=true 不改任何文件（.gitconfig 字节相同）
```
第 4 条通过而第 6 条不通过 → 浏览器半问题（重装 + 重启）。
第 4 条就不通过 → 宿主半问题（看 `dsh.client` / 语法 / profile 安装）。

---

## 9. 一台全新机器：从零到可用

### 9.1 三步走（推荐路径）

```powershell
# ① 装插件（只需一次）
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok
# 然后完全退出 DSH 再打开

# ② 在对话里让 AI 跑初始化（推荐先预演）
#    gitok_bootstrap url="https://github.com/<你的仓库>" dryRun=true
#    确认输出合理后，去掉 dryRun 再跑一次：
#    gitok_bootstrap url="https://github.com/<你的仓库>"

# ③ 验证
#    gitok_monitor
```

`gitok_bootstrap` 会按 S0→S4 顺序自己判断哪些该做、哪些跳过：

| 阶段 | 做什么 | 已满足时 |
|---|---|---|
| S0 | 自检 GCM / **系统级+用户级** gitconfig / 代理 / WSL 发行版 / 已有凭据 | 总是执行（只读） |
| S1 | 补 `credential.helper`（只补缺失的） | 跳过 |
| S2 | GCM 登录（弹浏览器/设备码） | 已有凭据则跳过 |
| S3 | 端到端 `git ls-remote` | 无 URL 则如实报「未查」 |
| S4 | 明文凭据收尾建议 | 只提示，不动手 |

### 9.2 手工做（不用 AI 也能完成）

```powershell
# 1) 确认 GCM 在不在（Git for Windows / MinGit 自带）
& "$env:LOCALAPPDATA\Programs\MinGit\ucrt64\bin\git-credential-manager.exe" --version

# 2) 看 helper 到底在哪一层（必须看系统级，不能只看 ~/.gitconfig）
git config --list --show-origin | Select-String "credential.helper"

# 3) 若没配，补上
git config --global credential.helper manager

# 4) 遇到 SEC_E_NO_CREDENTIALS 时（MinGit 的 schannel 已知问题）
git config --global http.sslBackend openssl

# 5) 触发登录（会弹浏览器）—— 或直接用 gitok_login 工具
"$env:LOCALAPPDATA\Programs\MinGit\ucrt64\bin\git-credential-manager.exe" get
#   输入：protocol=https<回车>host=github.com<回车><空行>

# 6) 验证
git -c http.proxy=http://127.0.0.1:7897 ls-remote https://github.com/<owner>/<repo> HEAD
```

> **常见误判**：只看 `C:\Users\<你>\.gitconfig` 会以为「没有 credential helper」。
> 实际上 `helper=manager` 常常在 MinGit 的**系统级** `MinGit\etc\gitconfig` 里。
> 必须用 `git config --list --show-origin` 才能看到全貌。

---

## 10. 日常维护：三件事要分开做

用户要的是「多台机器可靠」——那就必须把**三个不同层**的更新分开，混在一起做必翻车。

### 10.1 三层的边界

| 层 | 是什么 | 谁在管 | 更新方式 |
|---|---|---|---|
| **git 认证** | 凭据本体 | Windows 凭据管理器（DPAPI） | `gitok_bootstrap` / 重登 |
| **DSH 本体** | `dsh` 程序 + profile | 安装包 | 见 10.2 |
| **各 WSL 发行版** | `claude` / `u26claude4` / … | WSL | 见 10.3 |

这三者**互不依赖**：DSH 升级不会碰你的 git 凭据；WSL 里的 gh 登录也不会影响 Windows 侧。
**但**它们的失败会互相伪装：WSL 里 git 报「认证失败」很可能是代理不通，而不是凭据坏了。

### 10.2 DSH 本体更新

**改判依据：先看改的是哪一半。**

| 改了什么 | 生效方式 | 耗时 |
|---|---|---|
| `lib/client.js` | 刷新页面 | 1s |
| `lib/index.js` | **完全退出 DSH 再打开** | 30s |
| `cordis.patch.yml` 的 `config:` | **完全退出 DSH 再打开**（行激活时读） | 30s |
| `package.json` 的 `dsh.client` / `files` | **重装 + 重启** | 1min |

```powershell
# 改了 package.json（dsh.client / files / version）→ 必须重装
& C:\dsh\dshplug\install.ps1 -Only dsh-gitok -Force
# 然后完全退出 DSH 再打开
```

> 不加 `-Force` 时，脚本看到已是 `link-junction` 就认为「无需操作」，
> **不会更新元数据**。所以改了 `dsh.client` 必须加 `-Force`。

**验证更新真的生效了**（不看进程、不看日志，看实际注册）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --check C:\dsh\dshplug\dsh-gitok\lib\index.js
& $node --check C:\dsh\dshplug\dsh-gitok\lib\client.js
```

面板侧：刷新页面后看「持续监控」是否出现六行 —— 出现就是新版本，没出现就是旧版。

### 10.3 WSL 发行版（`claude` 等）更新

这一层最容易搞坏，因为**三个地方都可能存认证**：

| 位置 | 内容 | 性质 |
|---|---|---|
| `~/.config/gh/hosts.yml` | `oauth_token: github_pat_…` | **明文 PAT** |
| `~/.git-credentials` | `https://user:token@github.com` | **明文** |
| `credential.https://<host>.helper` | 指向哪个代答器 | 只是指针，不存密钥 |

**推荐形态（决策 D）：WSL 不自存任何密钥，全部借 Windows 那份。**

#### 10.3.1 一眼看懂原理

WSL 里的 git 在需要凭据时，会执行 `credential.helper` 里配置的那条命令。
只要那条命令指向 **Windows 上的 `git-credential-manager.exe`**（通过 `/mnt/c/...` 路径
经 WSL interop 调用），凭据就会从 **Windows 凭据管理器**里读出并直接回给 git。

```
WSL git  ──fork──▶  /mnt/c/.../git-credential-manager.exe
                          │
                          ▼
                   Windows 凭据管理器（DPAPI 加密）
                          │
                          ▼
                    username/password 回给 WSL git（只在内存里）
```

所以 **WSL 磁盘上零密钥**，轮换时只需在 Windows 重登一次，所有发行版自动跟着变。

#### 10.3.2 完整命令（2026-11-13 在 `claude` 与 `u26claude4` 实测通过）

先确定 GCM 的 Windows 路径，再换算成 WSL 路径：

```powershell
# Windows 侧路径（按实际安装位置调整）
$gcmWin = "$env:LOCALAPPDATA\Programs\MinGit\ucrt64\bin\git-credential-manager.exe"
Test-Path $gcmWin   # 必须返回 True
```

换算规则：`C:\Users\franc\...` → `/mnt/c/Users/franc/...`

```bash
# === 在 WSL 里执行（把 claude 换成你的发行版名）===
GCM=/mnt/c/Users/franc/AppData/Local/Programs/MinGit/ucrt64/bin/git-credential-manager.exe

# ① 先确认这个端点上能执行到 GCM（interop 是否开着）
test -x $GCM && echo OK || echo MISSING

# ② 备份，改坏了能回退
cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S)

# ③ 接管。注意两个 host 都要做——gh 的 helper 同时对 gist.github.com 生效
git config --global --get-all 'credential.https://github.com.helper'      # 先看原来是什么
for h in github.com gist.github.com; do
  git config --global --unset-all "credential.https://$h.helper" 2>/dev/null || true
  git config --global --add "credential.https://$h.helper" "!$GCM"
done

# ④ 复查：每个 host 应当只剩一条，且指向 GCM
git config --global --get-all 'credential.https://github.com.helper'
git config --global --get-all 'credential.https://gist.github.com.helper'
```

```bash
# ⑤ 验证端到端（挑一个有 remote 的真实仓库）
cd ~/git/<某个仓库>
timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"
```

**必须看到 40 位 SHA 且 `REAL_EXIT=0`。**

```bash
# ⑥ 只有 ⑤ 通过后才删明文 PAT
gh auth logout -h github.com 2>&1 || true
rm -f ~/.git-credentials

# ⑦ 删完立刻再验一次（这时它 100% 依赖 interop 借 Windows 凭据）
cd ~/git/<某个仓库> && timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"
```

#### 10.3.3 顺序绝不能反

**先接管 → 验证通过 → 再删明文。**
反了就会在该端点丢认证；如果这时网络又刚好在抖，你会误判成「插件把凭据搞没了」。

#### 10.3.4 四个实测踩到的坑

**坑 1：`git config key ""` 不是清空。**
它会在多值里**再追加一个空值**，旧 helper 仍然保留，结果是「gh 和 GCM 同时生效」的叠加态。
必须用 `--unset-all` 再 `--add`，最后用 `--get-all` 确认只剩一条。

**坑 2：`git remote -v | head -2; echo exit=$?` 会把失败伪装成成功。**
`$?` 拿到的是 `head` 的退出码，永远是 0。网络超时时输出为空、退出码却是 0。
写验证命令时**不要接管道**，或者直接看输出里有没有 40 位 SHA：

```bash
# 错：超时会显示 exit=0，看不出问题
cd ~/git/repo && timeout 40 git ls-remote origin HEAD | head -3; echo "exit=$?"

# 对：直接取 git 的退出码
cd ~/git/repo && timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"
```

**坑 3：VPN 没开时，任何 helper 都会「超时」，别急着怪 GCM。**
实测未开 VPN 时 DNS 被污染（解析到 `57.155.223.240`），
`git ls-remote` 卡在 `Trying <ip>:443...` 阶段 40~120 秒后超时。
用下面这条**完全不经 helper** 的命令先分清是网络还是凭据：

```bash
# 3 次，全部应在 2 秒内返回；若 10 秒以上或超时，就是网络问题
for i in 1 2 3; do
  s=$(date +%s%N); curl -sS -o /dev/null https://github.com; rc=$?
  e=$(date +%s%N); echo "第$i次: exit=$rc $(( (e-s)/1000000 ))ms"
done
```

判据：`curl` 也慢 → 网络问题，先修网络；`curl` 快而 git 慢 → 才是 helper 问题。

**坑 4：`gh auth logout` 不删文件，只清空内容。**
实测执行后 `~/.config/gh/hosts.yml` 仍然存在，但内容变成 `{}`（3 字节），
`gh auth status` 显示未登录。验证方式：

```bash
f=~/.config/gh/hosts.yml
grep -c oauth_token $f 2>/dev/null || echo "0 条 token"
sed -E 's/(oauth_token: .{8}).*/\1<REDACTED>/' $f   # 应当只有 {}
```

#### 10.3.5 不要碰的例外

`claude` 上还有一条**飞书专用**的 helper，与 GitHub 无关，**不要动**：

```
credential.https://miaoda-git.feishu.cn/…git.helper = !lark-cli apps git-credential-helper --app-id 'app_…'
credential.https://miaoda-git.feishu.cn/…git.usehttppath = true
```

所以接管时**必须按 host 精确指定** `github.com` / `gist.github.com`，
不要图省事去 unset 整个 `credential.helper`（会连飞书那条一起清掉）。

#### 10.3.6 回退

```bash
# 列出现有备份
ls -1t ~/.gitconfig.bak.gitok-* | head

# 恢复到最近一次
cp $(ls -1t ~/.gitconfig.bak.gitok-* | head -1) ~/.gitconfig

# 验证恢复后 helper 回到原样
git config --global --get-all 'credential.https://github.com.helper'
```

恢复到原 helper 后，如果之前已经 `gh auth logout`，需要重新 `gh auth login`
才能让 gh helper 重新可用。

### 10.4 给 Claude（或任何其他 agent）的详细操作说明

如果你想让 **Claude 自己去把 `claude` 发行版的 git 认证修好**，把下面这段直接贴给它：

```text
你在 WSL 发行版 claude 里。目标：让 git 能推拉 GitHub，且不在本机落盘任何明文密钥。

约束（不要违反）：
- 不要读写任何 token 明文，不要把 token 写进任何文件
- 不要改 remote URL
- 改任何配置前先备份

步骤：
1. 先诊断，把结果原样贴出来：
     git --version
     git config --list --show-origin | grep -i credential
     ls -l ~/.config/gh/hosts.yml ~/.git-credentials 2>/dev/null
     ssh-keygen -y -P '' -f ~/.ssh/id_ed25519   # 能输出公钥 = 空口令私钥，高危
     env | grep -i proxy

2. 判断：
   - 若 credential.https://github.com.helper 已经指向 /mnt/c/ 下的
     git-credential-manager.exe，则已接管，跳到第 4 步。
   - 若指向 gh 或为空，需要接管。

3. 接管（先备份，再清空旧的，再设新的）：
     cp ~/.gitconfig ~/.gitconfig.bak.$(date +%Y%m%d%H%M%S)
     git config --global --unset-all "credential.https://github.com.helper"
     git config --global --add "credential.https://github.com.helper" \
       "!/mnt/c/Users/<你的Windows用户名>/AppData/Local/Programs/MinGit/ucrt64/bin/git-credential-manager.exe"
   注意：必须用 --unset-all。写 git config key "" 并不会清空，只会追加一个空值。

4. 验证：
     git -c http.proxy=<代理> ls-remote https://github.com/<owner>/<repo> HEAD
   成功 = 输出一行 <sha>\tHEAD。

5. 只有第 4 步成功后，才清理明文：
     gh auth logout --hostname github.com
     rm -f ~/.git-credentials

6. 最后报告：
   - 接管前后的 helper 值
   - 第 4 步的实际输出
   - 是否清理了明文（以及清了什么）

如果第 4 步失败，不要继续第 5 步。把 ls-remote 的完整 stderr 贴出来。
```

> 上面这份说明是**自包含**的：Claude 不需要看本仓库任何文件就能执行。
> 它刻意不包含任何 token，只告诉他去哪里借。

---

## 11. 当前本机状态（2026-11-13 实测）

| 端点 | git 版本 | helper | 状态 | 备注 |
|---|---|---|---|---|
| `windows` | 2.56.0.windows.4 | `manager`（系统级） | ✅ `ok` | GCM 2.9.1，proxy 127.0.0.1:7897，1 条凭据 |
| `claude` | 2.53.0 | `gh`（URL 作用域） | ⚠️ `warn` | 明文 `hosts.yml`，`gh auth status` 正常 |
| `u26claude4` | 2.53.0 | `gh`（URL 作用域） | ❌ `error` | **空口令 SSH 私钥（P0）**，且 `gh` token 已失效 |

三件待办（属于用户动作，插件不代劳）：

1. **轮换泄露的 PAT** —— Claude 报告 §2 里贴过完整 `github_pat_…` 明文，必须去 GitHub 撤销重建。
2. **给 `u26claude4` 的 `id_ed25519` 设口令** —— 目前拷走即等于账号被盗。
   ```powershell
   wsl.exe -d u26claude4 -e bash -lc 'ssh-keygen -p -f ~/.ssh/id_ed25519'
   ```
3. **决定 `u26claude4` 还要不要** —— 它的 `gh` token 已失效。
   要么 `gitok_adopt` 接管后登出 gh，要么直接弃用这个发行版。

---

## 12. 下一步阅读

- 代码为什么这么写 → [`ADR.md`](./ADR.md)（含 ADR-008 决策 D）
- 面板长什么样、九个工具怎么选 → [`README.md`](./README.md)
- 路线图与验收标准 → [`docs/plugin-roadmap.md`](./docs/plugin-roadmap.md)
