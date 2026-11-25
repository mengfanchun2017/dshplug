# dsh-gitok · BOOTSTRAP 操作手册

> 命令行手册：**装机、验证、排错、迁移**。全部命令可直接复制。
> 代码怎么设计、为什么这么定 → 见 [`ADR.md`](./ADR.md)；面板长什么样 → 见 [`README.md`](./README.md)。
>
> 快照时间：**2026-11-23** ｜ 版本 **0.4.5** ｜ 宿主机 `REDMIPRO` ｜ profile `desktop`

---

## 0. 三个必读前提

### 0.1 路径**不要求**固定，但移动/改名后必须重装

先分清两件事，这是本节唯一容易搞混的点：

| 谁依赖绝对路径 | 后果 |
|---|---|
| **代码**：不依赖 | `lib/index.js` 用 `import.meta.url` 推导 `here`，`install.ps1` 用 `$PSScriptRoot` → 仓库搬到哪里都能跑 |
| **profile 的 `link:` 声明**：依赖 | `link:` 把**绝对路径**写进 `~/.dsh/profiles/<profile>/package.json`。目标被移走 = 链接断 |

所以：**可以在任何目录 clone/开发**，只是搬完之后跑一次 `install.ps1 -Force` 把声明重新指向新位置。
不必为了迁就旧路径而把仓库搬回去。

> **断链的险恶之处（实测 2026-11-22）**：Junction 的目标被移走后，
> `Test-Path <链接>` 仍返回 `True`、`LinkType` 仍是 `Junction`，**只有访问子项才失败**。
> 所以不能用「Test-Path 过了」当作健康依据。旧的 `install.ps1 -Check` 只在 `file:` 硬链接形态下查断链，
> `link:` 断链会被静默报成 green —— 现已修复（新增 `Test-BrokenJunction`，
> 真去读 `package.json`，读不到就报「链接已断」）。

### 0.2 改配置要重启 App，改代码不用（但加 `dsh.client` 要重装）

| 改了什么 | 生效方式 |
|---|---|
| `lib/index.js`（宿主半） | **完全退出 DSH 再打开** |
| `lib/client.js`（浏览器半） | 刷新页面（浏览器每次现取） |
| `cordis.patch.yml` 的 `config:` | **完全退出 DSH 再打开**（行激活时读） |
| `package.json` 的 `dsh.client` | **重装插件** + 重启。本机开发用 `install.ps1 -Force`；用公开仓库装的则重新跑一次 `dsh plugin --profile <p> add '<地址>'`（实测重复 add 输出 `Already up to date`，无副作用） |

「刷新页面」不等于「重启 DSH」。宿主半改动只刷页面是**不生效**的 —— 这是本项目最容易误判的一条。

### 0.3 `gitok_*` 是模型工具，不是命令行命令

在 PowerShell 里敲 `gitok_doctor` 会得到
`无法将"gitok_doctor"项识别为 cmdlet` —— 这是**正常**的，它不是 exe 也不在 PATH 里。
它是给 AI 会话用的工具。要触发就在对话里说「跑一下 gitok_doctor」。

---

## 1. 首次安装

两条路，**按「谁用」选，不要混**：

| 场景 | 走哪条 | 需要本地有仓库吗 |
|---|---|---|
| 另一台机器 / 给别人装 / 从零装 | **§1.1 公开仓库地址**（首选） | **不需要** |
| 在本机改代码、要 `link:` 热更新 | §1.2 `install.ps1` | 需要 |
| 把**同仓库的另一个插件**也装上（M* 配套） | 见 **§1.4 与 Msynchub 的关系** | **不需要** |

### 1.1 给一台新的 DSH 装（公开仓库地址，首选）

> **这一步不需要先把仓库下载下来。** 插件发布在公开 GitHub 仓库上，
> 给 DSH 一个地址它自己去取源码。下面的命令全部在**目标机器**上执行，
> 目标机器上不需要有 `C:\dsh\dw-plugin`。

**唯一的前置条件：桌面版必须先打开过至少一次，然后完全退出。**

```text
① 装好 DSH 桌面版 → ② 打开它一次（随便看看）→ ③ 完全退出（不是最小化）
```

否则 `dsh plugin --profile desktop add` 会直接报错：

```text
Open DeepSeek Harness Desktop once to initialize its profile,
then fully quit it before running dsh plugin --profile desktop.
```

这是 DSH 对 `desktop` profile 的约定（`desktop` profile 由桌面应用创建，CLI 不许凭空造），
不是本插件的限制。用 `--profile web` 不受此限（它会自己初始化）。

#### 路线 A：图形界面（最省事，不碰命令行）

```text
设置 → 插件 → 添加插件
  → 在「包名或地址」里粘贴整行（含 #path: 部分）：

github:mengfanchun2017/dswp-plugin#path:/dsh-gitok
```

装完会提示「已安装，请重启 DSH 加载它」—— **完全退出再打开**。
这条路不需要 clone 仓库、不需要 `dsh` 在 PATH、不需要管引号。

> **两条地址的形态对照**（实测都能装，`#` 后面的部分一字不能少）：
>
> | 写法 | 例子 |
> |---|---|
> | 宿主简写（**推荐**） | `github:mengfanchun2017/dswp-plugin#path:/dsh-gitok` |
> | 完整 URL | `https://github.com/mengfanchun2017/dswp-plugin#path:/dsh-gitok` |
> | 带 `.git` | `https://github.com/mengfanchun2017/dswp-plugin.git#path:/dsh-gitok` |
> | `#path:` 后**不**带斜杠 | `github:mengfanchun2017/dswp-plugin#path:dsh-gitok`（也可以） |
>
> 两种写法装出来的是同一个包；`github:` 简写在网页表单里更不容易被自动补全改坏。

#### 路线 B：命令行

```powershell
# 引号不能省：spec 里带 #，PowerShell 裸写会把 # 之后当注释截掉
dsh plugin --profile desktop add 'github:mengfanchun2017/dswp-plugin#path:/dsh-gitok'
```

- `--profile desktop` 是桌面应用的 profile；纯 CLI 用户一般用 `--profile web`，按自己的改。
- `#path:/dsh-gitok` **不能省**：本仓库是 monorepo，插件在子目录里，
  不带 `path:` 就指向仓库根，而根 `package.json` 不是插件（没有 `dsh.bundle`）。
  省掉它会报「**这个包没有声明组合包，无法作为插件安装**」——不是网络问题。
- 同一个插件**重复 add 一次是安全的**（输出 `Already up to date`，不改任何东西），
  所以「不确定装没装上」时直接再粘一次即可，不用先卸载。
- `dsh` 不在 PATH（提示「无法将 dsh 项识别为 cmdlet」）就用完整路径：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop add 'github:mengfanchun2017/dswp-plugin#path:/dsh-gitok'
```

三个常见错误改法：

| 症状 | 原因 | 改法 |
|---|---|---|
| `ERR_PNPM_ADDING_TO_ROOT` / 装到了奇怪位置 | 没给 `--profile` | 补上 `--profile desktop`（或 `web`） |
| `这个包没有声明组合包，无法作为插件安装` | 漏了 `#path:` | 本仓库是 monorepo，必须 `#path:/dsh-gitok` |
| `ERR_PNPM_GIT_RESOLVE_FAILED` + `schannel` / `TLS connect error` | git 没走代理（pnpm 的代理配置对 git 无效） | `git config --global http.proxy http://127.0.0.1:7897` 与 `https.proxy` 同值 |
#### 验证装对了没有

```powershell
# A) 依赖声明与 bundle 列表里都要有它（两者是不同东西，缺一不可）
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
#   dependencies → "dsh-gitok": "github:mengfanchun2017/dswp-plugin#path:/dsh-gitok"
#   dsh.profile.bundles → 数组里有 "dsh-gitok"

# B) 装下来的文件数（实测 18 个）
(Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-gitok" -Recurse -File).Count
#   18
```

**为什么不需要 `prepare` / `allowBuilds`**：git 安装取源码而不是构建产物，一般确实需要构建步骤。
本插件是纯 ESM JavaScript，没有构建、没有 `postinstall`、没有运行时依赖，所以 pnpm 不会拦脚本，
用户也不用改 `pnpm-workspace.yaml`。实测装下来 18 个文件（`lib/`、`locale/`、`cordis.patch.yml`、
`icon.svg`、三份文档、`docs/`、`tools/`）、`dsh.bundle.patch` 在位、
DSH 的 `evaluatePluginCompatibility()` 返回「无未满足要求」。

### 1.2 本机开发装（`install.ps1`，需要仓库在本地）

这一节**只在本机成立**，因为 `install.ps1` 依赖三样东西：

```text
1. 仓库已 clone 到本地（里面有 list.json）
2. link: 会把绝对路径写进 profile 的 package.json
3. Windows + 桌面版 DSH
```

换了机器 / 或机器上没有这份仓库，**回去看 §1.1**。

```powershell
# ① 确认清单里有这个插件且 status=active
& C:\dsh\dw-plugin\install.ps1 -Check

# ② 装（建 link: Junction）
& C:\dsh\dw-plugin\install.ps1 -Only dsh-gitok

# ③ 完全退出 DSH，再打开
#    首次加载新 bundle 必须重启，Junction 只保证之后改代码即时生效
```

`-Only` 会按 `list.json` 里 `status -eq 'active'` 过滤。
如果报 `没有匹配的插件（检查 -Only 或 list.json 的 status）`，去 `list.json` 确认该条
`status` 是 `"active"`、`installedOn` 含当前机器名（`["REDMIPRO"]`）。

**重装 / 强制刷新**（改了 `package.json` 的 `dsh.client` 或 `files` 时）：

```powershell
& C:\dsh\dw-plugin\install.ps1 -Only dsh-gitok -Force
```

不加 `-Force` 时，脚本看到已是 `link-junction` 就认为「无需操作」，**不会更新元数据**。
加了 `-Force` 会先 remove 再 add，所以顺序是「先重装、再重启」，不要反过来。

### 1.3 两条路线共存，不冲突

同一个 profile 里 `dependencies` 只能写一种形态：要么 `github:...#path:/dsh-gitok`，
要么 `link:C:/...`。从一条切到另一条，装上就行（后装的覆盖声明）；
回退用 §1.1 的地址重装一次即可。

### 1.4 与 Msynchub 的关系（两个插件怎么一起装到另一台 DSH）

#### 一句话

**两个插件在同一个公开仓库里，各占一个子目录；各自用自己的 git 地址安装，互不依赖。**
装好任一个都不需要另一个，但**多机同步这件事要两个一起才完整**：
Msynchub 负责「把数据搬过去」，Mgitok 负责「让 git 有权限搬」。

| | **Mgitok**（本插件） | **Msynchub** |
|---|---|---|
| 干什么 | git 凭据与认证：登录、体检、撤销、端到端验证 | 把会话 / 工作区 / 附件 / 技能 / 配置层 / 全局 `AGENTS.md` 同步到私有 Git 仓库 |
| 管的是 | **权限**（能不能推） | **内容**（推什么过去） |
| 能不能替对方 | 不能——它只碰凭据，不同步任何文件 | 不能——它**不接收也不保存凭据**，推送报 401 就卡住 |
| 装在哪 | 设置里没有侧边栏（设计如此，ADR-011） | 侧边栏 + 设置两处都在 |

> **顺序上的唯一硬要求**：`sync-plugins.ps1`（A 机导出的插件清单 → B 机一键装齐）
> 只能在**本机还没有 `package.json`** 时恢复清单。所以「先装这两个、再跑一键装齐」
> 会只装到这两个（详见 §9A.0.2）。

#### 两条地址（整行复制，`#` 之后的部分一字不能少）

```text
# Mgitok（本插件）
github:mengfanchun2017/dswp-plugin#path:/dsh-gitok

# Msynchub
github:mengfanchun2017/dswp-plugin#path:/dsh-synchub
```

Msynchub 那份文档里同一条地址写成 `https://github.com/mengfanchun2017/dswp-plugin#path:dsh-synchub`，
**两种写法等价**（实测都 `exit 0`）。差异只在 `#path:` 后面那个斜杠：带不带都行。

**Msynchub 的命令行等价写法**（要单引号，理由同 §1.1 路线 B）：

```powershell
dsh plugin --profile desktop add 'github:mengfanchun2017/dswp-plugin#path:/dsh-synchub'
```

图形界面走同一条入口：**设置 → 插件 → 添加插件**，两条地址分别粘一次。

#### 装完怎么确认两个都到位

```powershell
$pkg = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
$j  = Get-Content $pkg -Raw | ConvertFrom-Json

# ① dependencies 里两条都在（值就是上面那两行地址）
$j.dependencies.'dsh-gitok'
$j.dependencies.'dsh-synchub'

# ② dsh.profile.bundles 里也都要有 —— 只有 dependencies 不算数
$j.dsh.profile.bundles

# ③ 包内容都在（gitok 实测 18 个文件；synchub 看 client.js 在不在）
(Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-gitok" -Recurse -File).Count
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-synchub\lib\client.js"
```

**两处都要看**：`dependencies` 是「装没装」，`dsh.profile.bundles` 是「启没启用」。
只有前者时，工具可能能用但设置里那一栏不会出现。

#### 完整收尾（新机器从装插件到能用）

```text
① 装两个插件        §1.1 / 本节地址，装完完全退出 DSH 再打开
② 配 Msynchub       设置 → Msynchub → 填两个私有仓地址 → 保存 → 重新检查
③ 登录 Mgitok       设置 → Mgitok → 一键初始化（凭据进 Windows 凭据管理器）
④ 重启 DSH          cordis.patch.yml 的 config 在行激活时读，改完必须重启
⑤ 建基线            A 机「立即同步」；B 机「拉取并应用」
```

> **插件清单走 Git，不走 synchub**：`profile/package.json` 里含 `link:` 绝对路径，
> 是 danger 级、代码里硬编码永不同步（`dsh-synchub/lib/index.js` 的 `surface.tier !== 'danger'`）。
> 多台机器装齐插件用 `C:\dsh\dw-base\inside\tools\sync-plugins.ps1`，
> 完整 8 步顺序见 `C:\dsh\dw-base\inside\两机同步-操作手册.md`。

## 2. 验证（三层，逐层加深）

### 2.1 第一层：语法与加载（不需要 DSH 运行）

```powershell
$node = "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

# 语法
& $node --check C:\dsh\dw-plugin\dsh-gitok\lib\index.js
& $node --check C:\dsh\dw-plugin\dsh-gitok\lib\client.js

# package.json 合法性 + dsh.client 是否在
& $node -e "const j=require('C:/dsh/dw-plugin/dsh-gitok/package.json');console.log(j.version, !!j.dsh.client, j.files)"
```

期望：两次 `--check` 都不输出内容（exit 0）；第三行打印 `0.3.10 true [...]`。

### 2.2 第二层：宿主半注册（mock ctx，不起 DSH）

```powershell
$node = "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_HOME="$env:USERPROFILE\.dsh"; $env:DSH_PROFILE="desktop"

& $node --input-type=module -e "
const m = await import('file:///C:/dsh/dw-plugin/dsh-gitok/lib/index.js');
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

### 2.2b 第二层·浏览器半：打桩 ctx 跑 `apply`（**专治「界面不显示但控制台干净」**）

上面的 2.2 只证明宿主半注册成功。**浏览器半是另一套加载**：宿主调一次 `apply`，
它抛错就等于整块没注册，且**不报错、不写日志**。所以必须单独验。

先做最省事的静态检查（几毫秒）：

```powershell
# apply 里出现的每个 ctx.xxx，inject 里都必须有
Select-String -Path C:\dsh\dw-plugin\dsh-gitok\lib\client.js -Pattern 'ctx\.\w+'
```

把结果与 `const inject = [...]` 逐项对照。写 `apply` 时只要多用一个 `ctx.xxx` 就漏，
是这类「静默不显示」的第一嫌疑（ADR-009）。

再跑真验证 —— 按 `inject` 声明**严格**供给服务，缺什么立刻抛：

```powershell
$node = "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

& $node --input-type=module -e "
import fs from 'node:fs';
const code = fs.readFileSync('C:/dsh/dw-plugin/dsh-gitok/lib/client.js','utf8');
const R = { createElement:(t)=>({type:t,kids:[]}), useState:(i)=>[i,()=>{}],
            useEffect:()=>{}, useCallback:(f)=>f, useRef:(v)=>({current:v}) };
let cap=null;
globalThis.window={__ModuleLoader__:{load:o=>{cap=o;}}};
new Function('window',code)(globalThis.window);
const mod=cap.factory(n=>{ if(n==='react') return R; throw new Error('req '+n); });

const mk=(svc)=>{
  const c={effect:f=>{f();return()=>{}}};
  if(svc.includes('slots'))  c.slots={inject:(n,f)=>f(),register:()=>()=>{}};
  if(svc.includes('locale')) c.locale={register:()=>()=>{},bind:()=>()=>'Mgitok'};
  return c;
};
console.log('inject =', JSON.stringify(mod.inject));
mod.apply(mk(mod.inject));          // 按声明供给 → 必须成功
console.log('✅ apply 成功');
"
```

期望输出：

```
inject = ["slots","locale"]
✅ apply 成功
```

**若这里抛 `Cannot read properties of undefined (reading '...')`**，就是 `inject` 漏列了服务 ——
`register` 对应 `locale`/`slots`，`bind` 对应 `locale`。补进 `inject` 即可，不用改逻辑。

想同时确认插槽真的注册出来了，把 `register` 改成记录版：

```js
c.slots={inject:(n,f)=>f(),
         register:(o,comp)=>{console.log('  slot', o.name, o.id||o.key, 'order='+(o.order||'-'));return()=>{}}};
```

期望看到**只有一行**：`settings.section gitok order=65`。

> v0.3.5 起**不再注册** `sidebar.panellist` / `main`（只保留设置入口，见 ADR-011）。
> 如果你看到三行，说明跑的是旧版代码。

> **注意**：浏览器半改完只需**刷新页面**；只有 `package.json` 的 `dsh.client` 变了才需要重装。

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

**404 的含义**：路由没挂上。按顺序排查：
① DSH 是否在 `index.js` 修改**之后**启动的 ② 是否重装过
③ `webServer` 服务是否存在（纯 CLI 模式没有）。

> **❗ 500 先说这一条，不要先去改代码**：若错误串形如 `XXX is not defined`，
> 而源码里这个常量确实存在（`Select-String lib\index.js -Pattern 'const XXX'`），
> 那十有八九是「**代码已修、进程未重启**」——正在跑的 DSH 里还是旧模块。
> 对比两个时间即可确认：
> ```powershell
> Get-Process | Where-Object { $_.ProcessName -like '*Harness*' } | Select-Object Id, StartTime
> (Get-Item C:\dsh\dw-plugin\dsh-gitok\lib\index.js).LastWriteTime
> ```
> 进程 `StartTime` **早于** `LastWriteTime` → 必须完全退出 DSH（关窗口不算）再打开。
> 这类问题的特征是：**冒烟测试是绿的，路由却是 500 的**（因为测试 import 的是磁盘新文件）。

面板里看不见「Mgitok」分区时，先跑这一条 —— 能返回 JSON 就说明问题在浏览器半（`dsh.client`），
返回 404 就说明问题在宿主半（重启/重装）。

**500 的含义与 404 完全不同**：**路由挂上了，但执行时抛错了**。响应正文里带 `error` 字段，
直接读它就能定位（例如 `{"ok":false,"error":"DOCS_WSL is not defined"}`）。
不要往「端口/代理/网络」方向查——500 是纯代码错误，本机回环，与 VPN 无关。

### 2.3b 第三层·路由冒烟测试：专治「语法通过但运行时 ReferenceError」

**为什么需要这一层**：`node --check` 只验**语法**，不验**作用域**。
常量如果被误粘进某个函数体内，`--check` 照样 exit 0，模块 `import` 也照样成功
（只有函数被调用时才抛），直到浏览器请求路由才暴露成 500。
v0.3.4 的 `DOCS_WSL` 就是这么漏的，潜伏到 v0.3.7 才被用户撞上。

所以：**改完 `lib/index.js`，重启 DSH 之前先跑一次这个脚本。**
它用打桩 ctx 真调 `apply`，再真调 status 路由的 handler，**不等 DSH 重启**。

保存为 `C:\dsh\dw-plugin\dsh-gitok\tools\smoke-route.mjs`（见下），然后：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node C:\dsh\dw-plugin\dsh-gitok\tools\smoke-route.mjs
```

期望输出（任一 `FAIL` 都别急着重启，先修）：

```
routes    = /plugins/gitok/status /plugins/gitok/login /plugins/gitok/revoke /plugins/gitok/rotate /plugins/gitok/bootstrap
http      = 200
ok        = true
docsPath  = C:\dsh\dw-plugin\dsh-gitok\docs\WSL-GIT-AUTH.md
docsExists= true
level     = ok | summary = 已配置，认证可用
checks    = heartbeat:unknown plaintext:ok sshkey:ok helper:ok creds:ok deps:ok
```

两个关键断言，缺一不可：

| 断言 | 抓的是什么 |
|---|---|
| `docsExists = true` | 路径类常量算错（`here` 指向 `lib` 而非插件根时，拼出的文件不存在） |
| `checks` 六项齐全且无 `FAIL` | 路由体内的作用域错误（`X is not defined`）在这里必然现形 |

> `heartbeat:unknown` 是**正常的**：没配 `heartbeatUrl` 时该项如实报「没查」，
> 不等于失败。详见 ADR 里四态模型 `ok / warn / error / unknown`。

### 2.3c 第四层·GCM 定位回归测试：专治「明明装着却报未找到」

**为什么还要第四层**：前两层（语法 / 路由）都是「在本机跑」—— 而 v0.4.4 那个 bug
恰恰是**本机恰好命中硬编码路径**，所以两种测试都绿。到了别人机器就报
「❌ 未找到 GCM」，而该机 git 认证完全正常。

这类 bug 的共同点是**判定依据和事实脱钩**，只能靠「断言源码里不许出现开发机路径」
+「逐个验证解析函数」钉住：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node C:\dsh\dw-plugin\dsh-gitok\tools\gcm-detect-check.mjs
```

它查三类事（共 35 条断言）：

| 类别 | 查什么 | 为何不用别的测试代替 |
|---|---|---|
| 静态 | 代码（去注释后）不得含 `C:\Users\<名>\` / `C:\Program Files\...exe`，不得出现 `GCM_CANDIDATES` | 这类字符串**语法完全合法**，`--check` 永远绿 |
| 运行时 | 直接调 `gcmDirsFromExecPath` / `parseGcmProbe` / `helperBareName` / `gcmPathFromHelperValue` / `gcmInstallRootDirs` | 纯函数逻辑错（如把 `!` 命令当裸名）不会抛错，只会默默走错分支 |
| 调用链 | 所有 `gcm()` 调用点必须 `await` | `gcm()` 改成 async 后漏 await 不报错，而是把 Promise 当路径拼进命令 |

**变异测试（已验）**：把旧的 `GCM_CANDIDATES` 硬编码表塞回源码，
这个脚本会立刻报 4 项失败并 exit 1 —— 所以它是真的能拦，不是摆设。
---

## 3. 日常开发循环

```powershell
# 只改宿主半 → 重启 DSH
code C:\dsh\dw-plugin\dsh-gitok\lib\index.js

# 只改浏览器半 → 刷新页面即可
code C:\dsh\dw-plugin\dsh-gitok\lib\client.js

# 改完必跑的语法门
& $node --check C:\dsh\dw-plugin\dsh-gitok\lib\index.js
& $node --check C:\dsh\dw-plugin\dsh-gitok\lib\client.js
```

**同时改两半时按宿主半处理**（要重启）—— 别为了省一次重启而误判「面板没生效」。

### 3.1 单独测 `runDoctor` / `parseStatus`（不经过工具和界面）

这两个函数不导出，用一个临时模块桥接：

```powershell
$node = "$env:USERPROFILE\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$gcm  = "C:/Users/franc/AppData/Local/Programs/MinGit/ucrt64/bin/git-credential-manager.exe"

& $node --input-type=module -e @"
import fs from 'node:fs';
const p='C:/dsh/dw-plugin/dsh-gitok/lib/index.js';
fs.writeFileSync('C:/dsh/dw-plugin/dsh-gitok/lib/_probe.mjs',
  fs.readFileSync(p,'utf8') + '\nexport { runDoctor, parseStatus };');
const m = await import('file:///C:/dsh/dw-plugin/dsh-gitok/lib/_probe.mjs');
const api = { targets:()=>['windows'], gcm:()=>'$gcm', probeTimeout:()=>20000 };
const text = await m.runDoctor(api);
console.log(JSON.stringify(m.parseStatus(text,'$gcm'),null,2));
fs.unlinkSync('C:/dsh/dw-plugin/dsh-gitok/lib/_probe.mjs');
"@
```

东西用完自己删，别留在 `lib/` 里（`files` 白名单没列它，但会污染工作区）。

---

## 4. 发布

```powershell
# 预览：会提交哪些文件（不 commit、不 push）
& C:\dsh\dw-plugin\plugpush.ps1 -Name dsh-gitok -DryRun

# 真正推
& C:\dsh\dw-plugin\plugpush.ps1 -Name dsh-gitok -Message "dsh-gitok v0.2.1：xxxx"
```

### 4.1 ⚠️ `plugpush.ps1` 会带上仓库根级文件

它除了插件目录，还会 `git add` 根级的 `list.json`、`install.ps1`、`plugpush.ps1`、
`.gitignore`、`README.md`、`BOOTSTRAP.md`，并有一段 fallback 全量清扫。

**如果同时有另一个会话在改根目录，它会把别人未完成的工作一起提交。**

稳妥做法（本仓库曾因此改用）：

```powershell
cd C:\dsh\dw-plugin
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

目标：把开发从「临时会话」切到 `C:\dsh\dw-plugin` 工作区继续。

### 5.1 前提

代码**已经在** `C:\dsh\dw-plugin\dsh-gitok` 且已推送（`8276917`）。
不是「搬过去」，而是「确认那边拿到的是最新版」。

```powershell
cd C:\dsh\dw-plugin
& git pull --ff-only
& git log --oneline -3
```

应看到与 `dsh-gitok v0.3.10` 相关的提交在最近几条里。

### 5.2 切换 DSH 工作区

把 DSH 的工作区目录设为 `C:\dsh\dw-plugin`（或它的子目录）。
工作区切换后**新会话**才会注入那边的 `AGENTS.md`。

### 5.3 切过去之后第一件事

```powershell
& C:\dsh\dw-plugin\install.ps1 -Check          # 确认 dsh-gitok 仍是 link-junction / active
& C:\dsh\dw-plugin\install.ps1 -Only dsh-gitok -Force   # 换工作区后建议强制刷一次元数据
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
| profile 里的 `link:` 绝对路径 | **不要求新机路径相同**。路径随便挑，装完跑 `install.ps1 -Force` 把 `link:` 重新指向新位置即可（搬仓后 `-Check` 会报「链接已断」提醒你） |
| 本机特定的 GCM 路径 | 不需要改：`gcmPath` 留空就会自动探测（PATH → 安装根 → 注册表 / `git --exec-path` / `credential.helper`）。只有自动探测都落空时才需填；面板会显示「已找过哪些来源」 |

### 5.6 新机器第一次跑，可能缺的三样

```powershell
# ① GCM 是否在 —— 注意：where.exe 找不到 ≠ 没装！
# PATH 里只有 ...\MinGit\cmd 时 where 会落空，但 git 自己是能找到的：
git --exec-path                 # 例：.../MinGit/ucrt64/libexec/git-core
git credential-manager --version  # 有版本号 = GCM 在（实测 2.9.1 / 3.0.2）

# 要看真实路径，去 exec-path 同级的 bin 里找：
#   ...\ucrt64\bin\git-credential-manager.exe   ← Git for Windows 2.56 起的主布局
#   ...\mingw64\bin\...                          ← 老布局
# 都找不到才需要填 cordis.patch.yml 的 gcmPath

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
| 面板里没有「Mgitok」分区 | 加 `dsh.client` 后没重装 / 没重启 | 本机开发：`install.ps1 -Force`；公开仓库装的：重跑一次 `dsh plugin --profile <p> add '<地址>'`。两者都要完全退出重开 |
| 面板报「状态接口不可用」 | `/plugins/gitok/status` 404 | 跑 §2.2 确认路由注册了；确认 `index.js` 修改早于进程启动 |
| `/status` 一直转圈超 30s | `probeTimeoutMs` 太长或 pwsh 卡住 | `cordis.patch.yml` 把 `probeTimeoutMs` 降到 10000 |
| **`/status` 返回 HTTP 500，正文 `XXX is not defined`** | 常量被误写进函数体内，路由在模块作用域取不到 → 运行时 `ReferenceError` | **`node --check` 查不出来**（只验语法、不验作用域）。必须真跑一次路由，见 §2.3b。v0.3.4 的 `DOCS_WSL` 就是此因，v0.3.7 修 |
| `/status` 返回的 `docsPath` 指向不存在的文件 | `here` 语义搞错：它应当是**插件根**（`lib` 的上一级），不是 `lib` | `libDir = dirname(fileURLToPath(import.meta.url))`，再 `here = dirname(libDir)` |
| `没有匹配的插件（检查 -Only 或 list.json 的 status）` | `list.json` 那条不是 `active` | 改 `status: "active"` |
| `gitok_doctor` 输出中文乱码 | pwsh 输出编码不是 UTF-8 | 代码里已设 `[Console]::OutputEncoding`；外部脚本自己也要设 |
| helper 写了但没生效 | `git config key ""` **不清空**旧值 | 必须 `--unset-all` 再 `--add`（见 README 8.1） |
| 查不到 URL 作用域的 helper | `--get-all credential.helper` 只查全局 | 用 `--get-regexp '^credential\..*\.helper$'`（见 README 8.2） |
| `resolveGcm` 报 schemastery 找不到 | link 安装下模块解析路径不同 | 已用 `createRequire(path.join(c,'package.json')).resolve(...)` 解决（见 README 8.4） |
| 面板「仓库级 helper」显示了 `credentialStore: ...` | 正则 `\s*` 吃掉换行 | 已改用 `[ \t]*` + `(.*)`（见 README 8.7） |
| 侧边栏导航文字没翻译 | `t` 写成了直通函数 | 必须 `ctx.locale.bind(NS)`（见 README 8.8） |
| **设置和侧边栏都没有它，控制台干净** | `exports` 缺 `"./client"`（8.11）**或** `inject` 漏列 `locale`（8.12） | 先跑 §2.2 看 apply 是否抛错；不抛就查 `exports` |
| **设置里有、侧边栏没有**（gitok 本插件） | **设计如此**，v0.3.5 起故意不注册侧栏（ADR-011） | 不用修 |
| **设置里有、侧边栏没有**（其他插件） | 没注册 `sidebar.panellist`（8.13） | 补 `sidebar.panellist` + `main` 两个插槽 |
| 徽标显示「未知」但各项都正常 | 未配置的 `heartbeat` 拉低了整体等级（8.14） | 已修；或配 `heartbeatUrl` |

---

## 7. 撤销与清理

```powershell
# 卸载插件（保留源码目录，只去掉 profile 里的 link）
& C:\dsh\dw-plugin\install.ps1 -Only dsh-gitok -Force    # 重装用
# 彻底卸载：从 profile 的 package.json 移除 dsh-gitok，或
cd $env:USERPROFILE\.dsh\profiles\desktop
& pnpm remove dsh-gitok

# 撤销 git 凭据（这个才是删凭据，不可逆）
# 在对话里： gitok_revoke host="github.com" confirm=true
```

`gitok_revoke` **必须**显式传 `confirm: true`，否则只返回提示、不执行。
删完该 host 的 git 操作会重新要求认证。

### 7.1 GitHub 网页侧的三类授权（想知道「这台机器到底是哪条」先看这张表）

本插件只能看到本机写进 Windows 凭据管理器的那一条；**GitHub 网页上是另一个世界**，
两者靠不上名字。三个页面分工：

| 页面 | 里面是什么 | 能不能按机器区分 |
|---|---|---|
| `/settings/applications` | Authorized OAuth Apps。GCM 登录产生的 `gho_` 全在这里，**只显示成一条「Git Credential Manager」** | ❌ 名字是 App 发布方定的，全球同名；撤销是**按 App**，会把该账号下所有机器的 token 一起作废 |
| `/settings/personal-access-tokens` | Fine-grained PAT（GitHub 现在默认推荐） | ✅ 有名字 + 后 4 位，**能单条删**，只影响用它的那台 |
| `/settings/tokens` | Tokens (classic) | ✅ 同上，但权限是全库全宽 |
| `/settings/security-log` | 搜 `oauth_access` | — 这是**判断「哪台机器」的唯一依据**：每条带时间 + IP/城市 |

**想「一台机器一个令牌、名字还认得出」**：只能用 fine-grained PAT，命名带主机名，
例如 `REDMIPRO-20261116`（主机名可用 `$env:COMPUTERNAME` 查，本插件的面板会直接告诉你）。
OAuth 那条路做不到 —— 详见 ADR-014 的 v0.3.11 补遗。
---

## 8. 验收清单（迁移后逐条打勾）

```text
[ ] install.ps1 -Check 显示 dsh-gitok v0.3.11 status=active link-junction
[ ] node --check lib/index.js 通过
[ ] node --check lib/client.js 通过
[ ] mock ctx 测试：tools=9, routes=5（status + login/revoke/rotate/bootstrap）
[ ] 完全退出 DSH 再打开
[ ] 设置里能看到「Mgitok」分区
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

> 这里的「全新机器」指**从没装过这个插件的 DSH**。
> 第①步给的是**公开仓库地址**，不需要先把仓库下载下来（详见 §1.1）。
> 要**同时装 Msynchub**（同仓库的另一个插件）→ 见 **§1.4**，那里有两条地址和收尾顺序。

```text
# ① 装插件（只需一次）—— 给地址，不要去 clone
#    A) 图形界面：设置 → 插件 → 添加插件，粘这一行：
#       github:mengfanchun2017/dswp-plugin#path:/dsh-gitok
#    B) 或命令行：
#       dsh plugin --profile desktop add 'github:mengfanchun2017/dswp-plugin#path:/dsh-gitok'
#    前置：桌面版已打开过一次并完全退出（否则会报 requireDesktopProfile）
#    装完完全退出 DSH 再打开
```

```text
# ② 在对话里让 AI 跑初始化（推荐先预演）
#    gitok_bootstrap url="https://github.com/<你的仓库>" dryRun=true
#    确认输出合理后，去掉 dryRun 再跑一次：
#    gitok_bootstrap url="https://github.com/<你的仓库>"

# ③ 验证
#    gitok_monitor
```

> **为什么要先下载仓库才能装 —— 这是一个常见的误解。**
> 不需要。`dsh plugin ... add <地址>` 会让 DSH/pnpm 自己去 GitHub 取源码，
> 目标机器上不需要有 `C:\dsh\dw-plugin`。`install.ps1` 只在**本机开发**时才用
> （它读本地的 `list.json`、建 `link:` Junction）。


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

## 9A. 两台机器：主机 A 已配好，主机 B 怎么跟上

> 这是**最常遇到的真实场景**，和 §9「从零开始的机器」不同：
> 你已经有一台跑顺了的 A，现在要再加一台 B。

### 9A.0 主机 B 第一步：把插件装上（B 上什么都还没有）

先说清最关键的一件事：**你现在人在 B 的 DSH 里，而 B 上没有 `C:\dsh\dw-plugin` 这份仓库。**
所以 B 上**不要**跑 `install.ps1`（那个脚本读本地的 `list.json`，B 上根本没有），
也**不需要**先把仓库 clone 下来 —— 直接把**公开仓库地址**给 DSH，它自己去取源码。
完整两条路线（图形界面 / 命令行）见 **§1.1**，下面只保留 B 特有的部分。

#### 唯一的前置条件：B 的 DSH 必须先打开过至少一次

```powershell
# 在 B 上，什么都别装，先照做：
# ① 装好 DSH 桌面版  ② 打开它一次（随便看看就行）  ③ 完全退出（不是最小化）
```

**为什么必须先打开一次**：`dsh plugin --profile desktop` 有一条硬性检查 ——
profile 目录下没有 `package.json` 就直接抛错（源码 `dsh/src/plugin.ts` 的 `requireDesktopProfile()`）：

```text
Open DeepSeek Harness Desktop once to initialize its profile,
then fully quit it before running dsh plugin --profile desktop.
```

这不是本插件的限制，是 DSH 对 `desktop` profile 的约定：`desktop` profile 由**桌面应用自己创建**，
CLI 不许凭空造一个。实测（把 `DSH_HOME` 指到空目录再跑 `add`）确认会报上面这句。

> 桌面应用建 profile 时固定装上 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`
> （源码 `lib/main.js` 的 `createPluginProfile()` 用的是 `PROFILE_TEMPLATES.web.bundles`）。
> 这就是「设置页面存在」的前提 —— 见 9A.0.1。

#### 路线 1（推荐）：图形界面，不碰命令行

```text
设置 → 插件 → 添加插件
  → 在「包名或地址」里粘贴（整行，含 #path: 部分）：

github:mengfanchun2017/dswp-plugin#path:/dsh-gitok
```

装完界面会提示「已安装，请重启 DSH 加载它」—— **按提示完全退出再打开**。

这条路对 B 最省事：不需要 clone 仓库、不需要 `dsh` 在 PATH、不需要管引号。

#### 路线 2：命令行

```powershell
# 先确认 dsh 在 PATH（安装时通常已写入用户 PATH）：
dsh --version

# 不在 PATH 里（提示「无法将 dsh 项识别为 cmdlet」）就直接用完整路径：
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop add 'github:mengfanchun2017/dswp-plugin#path:/dsh-gitok'
```

**引号不能省**：spec 里带 `#`，PowerShell 里裸写会把 `#` 之后当注释截掉，
结果变成装了仓库根（而根 `package.json` 不是插件，没有 `dsh.bundle`）。
用单引号包住整条 spec，实测成功。

其它报错对照见 §1.2 的表格（`--profile` 缺失 / 漏 `#path:` / 代理不通）。

#### 装完的两条验证

```powershell
# ① 依赖声明与 bundle 列表里都要有它（两者是不同的东西，缺一不可）
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
#   dependencies → "dsh-gitok": "github:mengfanchun2017/dswp-plugin#path:/dsh-gitok"
#   dsh.profile.bundles → 数组里有 "dsh-gitok"

# ② 包内容完整（git 安装取源码，实测 18 个文件）
(Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-gitok" -Recurse -File).Count
#   18
```

**B 上不需要 clone 仓库**：git 安装会把源码取进 pnpm store 再链进 profile，
`C:\dsh\dw-plugin` 只在本机开发（要 `link:` 热更新）时才需要。

只有想在 B 上也改代码时才 clone：

```powershell
git clone https://github.com/mengfanchun2017/dswp-plugin.git C:\dsh\dw-plugin
& C:\dsh\dw-plugin\install.ps1 -Only dsh-gitok
```

注意这会把 profile 里的声明从 `github:...` 换成 `link:C:/...`（见 §0.1），两者只能选一个。

#### 9A.0.1 装完之后，设置里就有吗？—— 有，已逐项确认

用户装完最想知道的就是「界面在哪、是不是都齐了」。装好并**重启后**，B 上会出现：

| 出现的东西 | 具体内容 | 依据（不是推测） |
|---|---|---|
| **设置 → Mgitok** | 状态面板（六个监控项、凭据列表、操作按钮） | `lib/client.js` 注册 `settings.section`，`id: 'gitok'`、`order: 200`、`label` 取 `locale/zh.json` 的 `nav` = `Mgitok` |
| **9 个会话工具** | `gitok_doctor` `list` `verify` `login` `revoke` `adopt` `bootstrap` `rotate` `monitor` | `lib/index.js` 逐个注册 |
| **5 条 HTTP 路由** | `/plugins/gitok/*`（面板的数据通路） | `lib/index.js` |
| **侧边栏图标** | **没有 —— 设计如此，不是 bug** | ADR-011：功能全在设置里，侧栏是重复入口 |

`order: 200` 的含义：Mgitok 排在**所有内置分区之后**，是 M\* 系列的第一个（201/202/203 依次给其他 M 插件）。
所以「内置分区里翻不到」是正常的，往下滚。

#### 设置里没有它？按这三条查，顺序不能颠倒

| 症状 | 原因 | 查法 |
|---|---|---|
| 工具和设置**都没有** | 装完没重启 | 首次装 `dsh.client` 必须重启才加载。完全退出再打开，别只 `Ctrl+R` |
| 工具能用、设置里**没有** | profile 的 `bundles` 里没有它 | 看 `package.json` 的 `dsh.profile.bundles`。只有 `dependencies` 不算数 |
| 两样都在、仍是空白 | 浏览器半没注册成功 | 这是 `inject` 漏服务或 `exports` 缺 `"./client"`，见 §2.2 |

> **还有一个前提容易被忽略**：`settings.section` 这个插槽由 `dsh-web-app` 提供。
> 桌面版和无头 CLI 的 `web` profile 都自带它（实测 profile 的 bundles 是
> `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-gitok"]`）。
> 但如果你给 B 用的是 `--profile headless` 这类没有 Web 界面的 profile，
> **设置页面本身就不存在**，插件只剩工具那一半 —— 那不是装坏了。

---

### 9A.1 先说清楚：哪些能带、哪些不能带

主机 B 上做认证，最大的误区是想把 A 的东西「拷过去」。先看这张表：

| 东西 | 能不能从 A 拷到 B | 为什么 |
|---|---|---|
| **DPAPI 凭据密文** | ❌ **绝对不行** | 密文绑定「那台机器的那个 Windows 用户」。拷过去也没法解密，GCM 会当它不存在 |
| **GCM 可执行文件** | 🤷 能拷但没必要 | B 上装 Git for Windows / MinGit 就自带，版本还更新 |
| **`~/.gitconfig`** | ⚠️ 只拷「与凭据无关」的部分 | `credential.helper` 这类可以拷；但若 A 里写过 `gcmPath` 绝对路径或本机代理，拷过去就是错的 |
| **`cordis.patch.yml` 的 `config`** | ⚠️ 要逐项看 | `targets: [claude]` 这种写死的 WSL 发行版名、`proxy` 本机地址，到 B 上可能不存在 |
| **明文 PAT** | ❌ 不要 | 本来就是要消灭的东西 |
| **插件本体** | ✅ 能 | 就是同一个 git 仓库，B 上 clone 即可 |

**一句话：B 上的凭据必须由 B 自己登一次。** 这不是插件限制，是 DPAPI 的物理限制。

### 9A.2 主机 B：给 DSH 做 Windows 认证（4 步）

```powershell
# ── 第 1 步：装插件（B 上只需一次，详见 §9A.0）──────
# 全新 B 上没有仓库，所以不是 install.ps1，而是：
#   设置 → 插件 → 添加插件 → 粘 github:mengfanchun2017/dswp-plugin#path:/dsh-gitok
#
# 命令行写法（= 号）：
dsh plugin --profile desktop add 'github:mengfanchun2017/dswp-plugin#path:/dsh-gitok'
# → 然后完全退出 DSH 再打开（首次装 dsh.client 必须重启，刷新页面不够）
```

```powershell
# ── 第 2 步：先体检，不要直接改 ────────────────────────
# 在 DSH 对话里说：「跑一下 gitok_doctor」
#
# 重点看三行：
#   GCM 路径      —— 有 ❌ 时先看「已找过 / 诊断」那两行：
#                    能跑 `git credential-manager --version` = GCM 在，填 gcmPath 即可
#                    报 not a git command = 真没装，或 helper 名写成了 manager-core
#   credential.helper —— 看看在系统级还是用户级（两处都查才算查了）
#   已存凭据      —— 有「0 条」是正常的，B 还没登过
```

```powershell
# ── 第 3 步：一键初始化（可重入，先 dryRun）──────────────
# 先预演，确认它打算干什么：
#   gitok_bootstrap url="https://github.com/<你的仓库>" dryRun=true
#
# 没问题就去掉 dryRun：
#   gitok_bootstrap url="https://github.com/<你的仓库>"
#
# S0 自检 → S1 补 helper → S2 弹浏览器登录 → S3 验收 → S4 收尾
# 已是正确状态的步骤会自动跳过，重复跑安全
```

```powershell
# ── 第 4 步：自己在 PowerShell 里验证一次（不靠插件）──
# 插件说 OK 是一回事，git 真能用是另一回事，两者都要看：
git ls-remote https://github.com/mengfanchun2017/dswp-plugin.git HEAD
# 能输出一行 <sha>\tHEAD 就成了
```

> **为什么第 4 步不能省**：`gitok_monitor` 的「端到端通路”项在未配置 `heartbeatUrl` 时
> 会如实报 `unknown`（没查 ≠ 通过）。如果想让插件也真的去查，在设置里填 `heartbeatUrl`。

### 9A.3 主机 B：让 B 上的 Claude 也能用同一套

这里要先分清 B 上的 Claude 跑在哪 —— **两种情况的答案完全不同**：

#### 情况①：Claude 在 Windows 上跑（原生 Windows 版）

**什么都不用做。** 它调 `git` → `git` 调 `git-credential-manager.exe` →
读 Windows 凭据管理器。你刚在 9A.2 做的认证它直接用。

验证：在 Claude 里让它跑 `git ls-remote <你的仓库> HEAD`，能出结果就行。

#### 情况②：Claude 在 WSL 里跑（最常见）

这才是需要动手的。**不要**在 WSL 里另装一份 GCM —— 那读不到宿主的凭据库，
只会让你一直在 WSL 里弹登录。正确做法是**让 WSL 的 git 去调 Windows 那个 exe**。

```bash
# ── 在 B 的 WSL 里执行（把 claude 换成你的发行版名）──

# ① 先确认 interop 是开的（否则根本调不到 Windows 程序）
cat /proc/sys/fs/binfmt_misc/WSLInterop      # 期望 enabled

# ② 确认 Windows 的 GCM 从 WSL 里能执行到
#    路径要换成 B 上实际的（MinGit 在 ucrt64\bin，Git for Windows 在 mingw64\bin）
GCM=/mnt/c/Users/<B的Windows用户名>/AppData/Local/Programs/MinGit/ucrt64/bin/git-credential-manager.exe
test -x "$GCM" && echo OK || echo MISSING
#    MISSING = 路径不对或 interop 关着，先解决这个再往下

# ③ 备份（改坏了能回退）
cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S)

# ④ 接管：两个 host 都要配（github 的 helper 不覆盖 gist）
for h in github.com gist.github.com; do
  git config --global --unset-all "credential.https://$h.helper" 2>/dev/null || true
  git config --global --add "credential.https://$h.helper" "!$GCM"
done

# ⑤ 验收（必须真跑通，别只看配置写对了）
git ls-remote https://github.com/mengfanchun2017/dswp-plugin.git HEAD
```

**也可以不手打**，让插件代劳（前提是插件已装进 B 的 DSH，且 B 的 WSL 在 `targets` 里）：

```
# 在 DSH 对话里：
gitok_adopt targets=["claude"] dryRun=true   # 先看它打算改什么
gitok_adopt targets=["claude"]               # 确认后写入
```

它会自动把 Windows GCM 的路径换算成 `/mnt/c/...` 并配好**两个 host**，改前先备份。

#### 情况②的硬边界：借不到就是借不到

如果 B 上的 Claude 跑在**容器**里（不是 WSL），或者环境不允许执行 Windows 二进制，
那 DPAPI 凭据是**无论如何借不到**的 —— 容器里没有 B 的 DPAPI 主密钥。
这种环境只能显式注入凭据（挂载或环境变量），不是配置能解决的问题。

### 9A.4 两台机器的凭据会对不上吗？

会，而且这是**设计如此**，不是 bug：

| 事实 | 含义 |
|---|---|
| A 和 B 各登一次 = 各自一个 token | 同一个账号 + 同 App + 同 scope 最多 10 个并存，两台机器完全没问题 |
| 网页的 Revoke 是**按 App 撤销** | 在网页上点撤销会**两台一起失效**。根因是可操作粒度止于 App，不是只有一个凭据 |
| 想「一台一个、能单独撤」 | 只能用 fine-grained PAT 自己起名（如 `REDMIPRO-20261122` / `DESKTOP-B-20261122`） |

所以：**想要按机器区分和单独撤销，就必须走 PAT 路线**；想省事就让两台共用一个 OAuth 授权，
代价是撤销只能一起撤。详见 ADR-014。

### 9A.5 B 上做完后的验收清单

```
[ ] gitok_doctor       —— GCM 找到、helper 指向 GCM、凭据 ≥1 条
[ ] gitok_monitor      —— level=ok（heartbeat 可以是 unknown，那代表没配不是坏了）
[ ] git ls-remote ...  —— 在 Windows PowerShell 里能出 sha
[ ] WSL: git ls-remote —— 如果 B 的 Claude 在 WSL 里，这一步必须也过
[ ] 两个 host 都查     —— github.com 和 gist.github.com 的 helper 都有值
```

### 9A.0.2 先装插件还是先跑「一键装齐」？——必须后装插件

B 机上还有另一条路：`sync-plugins.ps1` 会把 A 机导出的插件清单
（`C:\dsh\dw-base\inside\profile-manifest.json`）一次性装齐 14 个依赖 / 15 个 bundle。
**它和「先用 git 地址装这两个」不能同时成立**，原因在脚本里：

```text
本机 ~/.dsh/profiles/desktop/package.json 不存在  → 从仓库清单恢复
本机已经有 package.json（哪怕只装了 1 个插件）   → 不恢复，只补缺的那几个
```

实测后果：**先装 Mgitok + Msynchub，再跑 `sync-plugins.ps1`，只会装到这两个**，
其余 12 个插件不会补上，脚本也不会报错——它只提示「缺 2 个：dsh-gitok, dsh-synchub」然后正常结束。

所以 B 机二选一：

| 你想要 | 怎么做 |
|---|---|
| **装齐全部插件**（推荐） | clone 两个仓库 → **先不启动 DSH**（避免 profile 被建出来）→ 跑 `sync-plugins.ps1` → 再启动 DSH |
| **只装这两个、手动补其余** | 先粘地址装 Mgitok + Msynchub → 完全退出 DSH → 再跑 `sync-plugins.ps1`（它只补缺的） |

> **「不启动 DSH」为什么重要**：桌面版启动一次就会建出 `package.json`，
> 于是清单永远走不到「恢复」分支。已经启动过了就先把清单改名再跑：
>
> ```powershell
> Rename-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" `
>   "package.json.bak-$(Get-Date -f yyyyMMdd-HHmmss)"
> pwsh -File C:\dsh\dw-base\inside\tools\sync-plugins.ps1 -Check   # 应看到 14 依赖 / 15 bundles
> ```
>
> 完整 8 步顺序见 `C:\dsh\dw-base\inside\两机同步-操作手册.md`（手册里也写了「gitok 在最后，不是最前」）。

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
& C:\dsh\dw-plugin\install.ps1 -Only dsh-gitok -Force
# 然后完全退出 DSH 再打开
```

> 不加 `-Force` 时，脚本看到已是 `link-junction` 就认为「无需操作」，
> **不会更新元数据**。所以改了 `dsh.client` 必须加 `-Force`。

**验证更新真的生效了**（不看进程、不看日志，看实际注册）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --check C:\dsh\dw-plugin\dsh-gitok\lib\index.js
& $node --check C:\dsh\dw-plugin\dsh-gitok\lib\client.js
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

### 10.4 给 Vibe Coding Agent（Claude Code / Codex / Cursor / Trae 等）的详细操作说明

如果你想让 **agent 自己去把 `claude` 发行版的 git 认证修好**，把下面这段直接贴给它
（Claude Code / Codex / Cursor / Trae 都行；下面的 `claude` 是 **WSL 发行版名**，不是工具名，别搞混）：

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

#### 10.4.1 五个依赖前提（缺一个就会卡住，先逐项确认）

给 agent 的那段话假定环境已经具备这些。实际排查时**按顺序验**，不要跳：

| # | 前提 | 怎么验（在 WSL 里跑） | 不成立的表现 |
|---|---|---|---|
| ① | Windows 侧装了 GCM | `"/mnt/c/Program Files/MinGit/ucrt64/bin/git-credential-manager.exe" --version` | 报 No such file → agent 根本无法借到凭据 |
| ② | WSL interop 开着 | `cat /proc/sys/fs/binfmt_misc/WSLInterop` = `enabled` | 执行 Windows exe 报 `Exec format error` |
| ③ | helper 指向 **Windows 的** exe | `git config --get-all credential.https://github.com.helper` | 指向 `/usr/bin/git-credential-manager` → 读不到宿主 DPAPI |
| ④ | WSL 能连代理 | `curl -x <代理> -sI https://github.com` | `ls-remote` 超时 / TLS 错误（§8.6） |
| ⑤ | 只在 ④ 成功后删明文 | `ls ~/.git-credentials ~/.config/gh/hosts.yml` | 删早了 agent 直接失去推送能力，而且回不去 |

**②为什么是硬边界**：DPAPI 密文只能用「同一台机器的同一个 Windows 用户」解开。
WSL 里的 git 不靠 interop 就无法执行 Windows 二进制，也就永远读不到那份密文 ——
这是架构决定的，不是配置问题。纯 bash 容器同理（容器里没有你的 DPAPI 主密钥）。

#### 10.4.2 上面那段话漏了一个坑：gist 是另一个 URL

`credential.https://github.com.helper` **不覆盖** `gist.github.com`。
只配前者时，推普通仓库没问题，一旦涉及 gist 就回退到没认证。两个都要配：

```bash
git config --global --add credential.https://github.com.helper '<GCM 路径>'
git config --global --add credential.https://gist.github.com.helper '<同一个路径>'
```

检查时两个都查：

```bash
git config --get-all credential.https://github.com.helper
git config --get-all credential.https://gist.github.com.helper
```

#### 10.4.3 哪些 agent 根本不需要这套

| agent 跑在哪 | 需要做什么 |
|---|---|
| Windows 原生（Claude Code / Cursor / Trae / Codex CLI 的 Windows 版） | **什么都不用做**。它们调 `git` → `git` 调 GCM → 读 DPAPI，链路天然通 |
| WSL 里 | 按 10.4.1 的 ①→⑤ 配 |
| 容器 / 远程 Linux | 借不到，必须**显式注入**凭据 |

所以：**本插件不需要装到那些 agent 上**，也不应该装。它只是把凭据摆到位并能验收的工具；
真正跨 agent 生效的是「凭据在 Windows 凭据管理器里」这个事实。

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
