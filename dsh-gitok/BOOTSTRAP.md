# dsh-gitok · BOOTSTRAP 操作手册

> 命令行手册：**装机、验证、排错、迁移**。全部命令可直接复制。
> 代码怎么设计、为什么这么定 → 见 [`ADR.md`](./ADR.md)；面板长什么样 → 见 [`README.md`](./README.md)。
>
> 快照时间：**2026-11-12** ｜ 版本 **0.2.0** ｜ 宿主机 `REDMIPRO` ｜ profile `desktop`

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

期望：两次 `--check` 都不输出内容（exit 0）；第三行打印 `0.2.0 true [...]`。

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
tools: gitok_doctor,gitok_list,gitok_verify,gitok_login,gitok_revoke,gitok_adopt
routes: /plugins/gitok/status
```

**这是最有价值的一条验证**：它证明 Host 半能加载、Config 能解析、6 个工具和路由都注册上了，
完全不依赖 DSH 是否重启过。面板出问题而这条通过时，几乎一定是「没重启」或「没重装」。

### 2.3 第三层：运行时（需要 DSH 正在跑）

```powershell
# 端口每次启动都变，从运行时上下文的 GUI URL 里取，不要写死
$port = 59615   # ← 换成当前实际端口
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

应看到 `8276917 dsh-gitok v0.2.0：设置里新增「Git 认证」面板...` 在最近几条里。

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
| `C:\dsh\getbraindata` 等数据目录 | 不在本插件范围，按各自插件文档处理 |
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
[ ] install.ps1 -Check 显示 dsh-gitok v0.2.0 status=active link-junction
[ ] node --check lib/index.js 通过
[ ] node --check lib/client.js 通过
[ ] mock ctx 测试：tools=6, routes=/plugins/gitok/status
[ ] 完全退出 DSH 再打开
[ ] 设置里能看到「Git 认证」分区
[ ] 面板徽标是绿色 / 显示「已配置，认证可用」
[ ] 点「重新检查」能刷新（不是转圈卡死）
[ ] 点「查看原始报告」能展开体检文本
[ ] 对话里调 gitok_doctor 能返回报告
[ ] GET /plugins/gitok/status 返回 level=ok
```

第 4 条通过而第 6 条不通过 → 浏览器半问题（重装 + 重启）。
第 4 条就不通过 → 宿主半问题（看 `dsh.client` / 语法 / profile 安装）。
