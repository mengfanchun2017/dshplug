# dsh-synchub · BOOTSTRAP（怎么做）

> 三份文档分工固定：
>
> | 文档 | 回答什么 | 什么时候读 |
> |---|---|---|
> | [`README.md`](./README.md) | 怎么用（面板、同步面、API、配置项） | 日常使用、查某个按钮/接口 |
> | [`BOOTSTRAP.md`](./BOOTSTRAP.md)（本文） | 怎么做（安装 / 验证 / 排错 / 迁移 / 命令行手册） | 首次安装、换机器、出问题要动手时 |
> | [`ADR.md`](./ADR.md) | 为什么（决策 + 反面代价 + 已否决方案） | 想改设计、质疑「为什么这样」时 |
>
> 详细调研证据在 [`docs/`](./docs/)。本文日期与版本写死：0.5.3 / 2026-11-17。

---

## 0. 先记住这一条：改哪部分要重启，哪部分刷页面就行

| 你改了什么 | 要让改动生效 |
|---|---|
| `lib/client.js`（浏览器半：面板/设置 UI） | **刷新页面**即可 |
| `lib/index.js`（宿主半：路由/同步引擎） | **完全退出 DSH 再打开** |
| `package.json`（清单/依赖） | **完全退出 DSH 再打开** |
| `cordis.patch.yml`（配置层） | **完全退出 DSH**（config 在行激活时读取） |

> 这是本类插件最容易误判、最浪费时间的点。0.5.x 新增功能全在 `index.js`，**改完必须完全重启**；本插件的离线 smoke 只证明逻辑正确，不替代真机重启验收。

---

## 0.4 两条安装路径怎么选 + 升级 + 关于 dsh-market

| | A. git 地址安装 | B. 本地目录 link: 安装 |
|---|---|---|
| 怎么做 | 设置 → 插件 → 添加插件，填 `<仓库>#path:dsh-synchub` | 先 clone 到固定路径，再 `install.ps1 -Only dsh-synchub` |
| 适合谁 | 只想装这一个插件的第三方 | **自己的每一台机器**（0.6.0 起推荐；含开发机） |
| 拿到什么 | 远端当前提交的快照 | 指向本地源码的 Junction（改源码即时生效） |
| 升级 | 界面「更新」或卸载后用同一地址重装 | `git pull` 一次即升级（无需重装；改了 index.js 完全重启） |
| 代价 | 没有版本自动升级；要手动重装；拿不到 install.ps1 / 其余插件 / 文档 | 路径写死、每台都要 clone + install；磁盘上多一份仓库 |

**为什么 git 地址要带 `#path:dsh-synchub`**：dshplug 是多插件 monorepo，仓库根不是 bundle；
不指子目录，DSH 在根上找不到 `dsh.bundle.patch`，会报「没有声明组合包」。

**上架 dsh-market 是不是最优？** 长期看是多机分发的终点——上架后变成「市场一键安装 + 市场内升级」，
省去上面两条路径的手动步骤。但现在**没上**：需要去掉 `private: true`、选 npm 包名、执行发布，
这是发布决策（ADR-017），本会话不做。在那之前 A/B 两条已够用。

---
## 0.5 在家那台 DSH 上从零安装（照做就行）

前提：这台（家机）已能正常打开 DSH，且 PATH 里没有 node（正常，DSH 自带运行时）。
下列命令在 DSH 右侧栏「终端」里跑（默认 PowerShell）。

### 第 1 步：把仓库放到固定路径
所有机器（可多台，不限于两台）**必须用完全相同的路径**，否则 `link:` 里的绝对路径对不上（ADR-002）。

```powershell
# 目标：C:\dsh\dshplug 存在且是 git 仓库
New-Item -ItemType Directory -Path 'C:\dsh' -Force | Out-Null
cd C:\dsh
git clone https://github.com/mengfanchun2017/dswp-plugin.git dshplug
```

**验证**（应该输出 `dshplug` 和若干文件名）：

```powershell
ls C:\dsh\dshplug | Select-Object -First 5 Name
test -f C:\dsh\dshplug\list.json; "list.json 存在: $?"
```

> 若已 clone 过，只需 `git -C C:\dsh\dshplug pull`。
> 若不想 clone（想用 git 地址直接装），跳到 §6.1，但那仍然需要本节能访问 GitHub。

### 第 2 步：装插件（建 link: Junction）

```powershell
& "C:\dsh\dshplug\install.ps1" -Only dsh-synchub
```

**验证**（看是否出现 `dsh-synchub` 且形态为 link）：

```powershell
& "C:\dsh\dshplug\install.ps1" -Check
```

预期看到「全部为 link: 形态且已安装」或 `dsh-synchub ... link-junction`。

### 第 3 步：完全退出 DSH 再打开

不是刷新页面——宿主半 `lib/index.js` 只在启动时加载。
托盘图标 → 退出 → 确认进程结束 → 重新打开。

**验证**：侧边栏出现「Msynchub」；设置里出现「Msynchub」一栏。
若没出现，先查 `package.json` 的 `exports["./client"]` 在不在（存在则为其他原因，看 §5 排错表）。

### 第 4 步：自检（关键）

打开侧边栏 Msynchub，**第一张卡就是自检结论**：

- 显示「✓ 同步已就绪」→ 完成，可以用了；
- 显示「✗ 还不能同步（N 项待处理）」→ 点开下面的「怎么做（N 步）」，
  每条都写了「缺什么 / 去哪里 / 怎么验」，按顺序做即可。

### 第 5 步：配置两个仓库

1. 在 GitHub 建**两个空私有仓库**（Private；**不要**勾 README / .gitignore / License，否则首次推送会被拒）。
2. 到「设置 → Msynchub → 通道地址」填两条地址；或在侧边栏面板下方的输入框直接填（只改通道地址）。
3. 点「保存」，再点「重新检查」。

**验证**：通道行不再显示「未配置远端」，而是 `N 落后 / N 领先 / N 脏`。

### 第 6 步：把 Git 认证配通

本插件**不接收也不保存凭据**。推荐装 `dsh-gitok`：

```powershell
& "C:\dsh\dshplug\install.ps1" -Only dsh-gitok
# 完全退出 DSH 再打开，到「设置 → Mgitok」点一键初始化
```

它会检查 Windows 凭据管理器、credential helper、明文凭据、代理、SSH 私钥口令。

**验证**（不装 gitok 也能自己验）：

```powershell
git ls-remote https://github.com/<你>/dsh-config
```

能列出 ref 就说明认证已通；报错则先解决凭据/代理。

### 第 7 步：建基线

- **这台（家机）**：面板点「立即同步」（0.6.0 主按钮：拉+推一口气；旧版是「提交并推送」）。
- **另一台**：面板点「拉取并应用」。

> 若两台都各自推过（分叉），面板会出现「分叉处理（二选一）」卡：先点「看两边的提交」
> 确认各自多了什么，再选以本机为准（覆盖云）或以远端为准（覆盖本机）；两个方向都会先备份（ADR-030）。

**验证**：双方自检卡都变成「✓ 同步已就绪」。

---

## 1. 安装（新机器，只做一次）

自研插件不在 npm，走本仓库的 `link:` 分发（见 ADR-008 / ADR-017 决策：维持本地分发）。

```powershell
# 新机器先把 dshplug 仓库放到与另一台完全相同的路径（例 C:\dsh\dshplug）
& "C:\dsh\dshplug\install.ps1" -Only dsh-synchub
# 完全退出 DSH 再打开
```

- `install.ps1` 建的是目录 **Junction（`link:`）**，改源码即时生效，日常**不用**重跑它。
- 只有三种情况要重跑：新机器首次、新增/删除插件、`list.json` 改动。
- 若 PowerShell 5.1 报「禁止运行脚本」，见仓库根 `BOOTSTRAP.md` §0.3（临时 `Set-ExecutionPolicy -Scope Process Bypass`）。

---

## 2. 首次配置（仓库模式 + Git 认证）

在设置页「Msynchub → 新用户从这里开始」按第 0→4 步走，等价命令行/要点：

1. **选仓库模式**：设置页「仓库模式」——`single`（一个地址，推荐数据量不大时）或 `split`（两个地址，默认）。
   - 单仓库：GitHub 建**一个空私有仓库**（不勾 README/.gitignore/License），填到一个地址即可。
   - 双仓库：建两个（`dsh-config`、`dsh-sessions`）。
2. 设置页「仓库地址」填地址（单仓库一个 / 双仓库两个；HTTPS 或 SSH 都行，取决于本机已配通哪种）。
3. **Git 认证自己搞定**（本插件不接收/不保存凭据）：推荐装 `dsh-gitok`，「设置 → Mgitok」一键初始化——
   它会检查 Windows 凭据管理器、credential helper、明文凭据、代理、SSH 私钥口令并给修复命令。
   不装也行；HTTPS / GCM OAuth / SSH 均可，只要本机 git 能读写你的私有仓库。
4. 第一台点「提交并推送」建基线；第二台点「拉取并应用」。**两台工作区必须落在完全相同的绝对路径**（ADR-002）。

> 本机若 MinGit schannel 报 `SEC_E_NO_CREDENTIALS (0x8009030e)`，仓库级切 OpenSSL：
> `git -C C:\dsh\dshplug config http.sslBackend openssl`。网络间歇失败先重试 2~3 次再换路，详见仓库根 README。

---

## 3. 验证（怎么确认装好、跑通）

### 3.1 离线逻辑验证（不需要 DSH 运行）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$P = 'C:\dsh\dw-plugin\dsh-synchub'
& $node --check "$P\lib\index.js"
& $node --check "$P\lib\client.js"
& $node --check "$P\lib\sessiondoctor.js"

# 全部 11 份；任何一份非 0 就停
Get-ChildItem "$P\test" -Filter *.cjs | Sort-Object Name | ForEach-Object {
  & $node $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "FAIL $($_.Name)" }
}
```
各套件自己的通过标志（`ALL PASS` / `SYNCHUB_SMOKE_OK` / … / `会话体检 smoke：23 通过 / 0 失败`）。
全绿 = 11/11 套件 exit 0。

| 套件 | 盯什么 |
|---|---|
| `render-smoke.cjs` | 浏览器半**真渲染**：首帧/有数据/报错/钩子序（含 E0b+E0c 体检卡） |
| `synchub-smoke.cjs` | 27 路由注册 + 三槽 + CSS + 新卡片 |
| `sessiondoctor-smoke.cjs` | 体检引擎：**23 条**，只读性/confirm 闸门/不误报 subagent/回滚点原文 + **J 组 6 条职责边界**（impact 不漏网 / health 三态 / 一键救援不碰空组） |
| `sessionmove-smoke.cjs` | 单条+批量迁移（含 14 个真实目录交叉验证） |
| `purge-smoke.cjs` | 受控删除 |
| `sessionnote-smoke.cjs` | 蒸馏文档 |
| `state-smoke.cjs` | 状态目录真实状态 |
| `unsynced-smoke.cjs` | 假绿回归：unsynced/pending/payloadMissing |
| `diverge-smoke.cjs` | 分叉二选一 |
| `repo-sync-smoke.cjs` | 代码仓库四态 |
| `single-smoke.cjs` | 单仓库模式（ADR-036）：模式抽象 / 分组开关 / payload 落点 / 单通道状态 / 失败态 |

十一份 smoke 用临时夹具，**不碰真实 DSH 会话数据、不发网络请求**
（`unsynced-smoke` / `repo-sync-smoke` 会读真实仓库目录，但**只读**：不 stage、不 commit、不 push）。

> **为什么必须有 `render-smoke`（2026-11-18 踩过）**：`node --check` 只查语法。
> 当时工作区卡片里 `e('div',{...},…)` 后面漏了一个逗号，下一行的
> `(status && … ? … : null)` 于是变成对上一个函数返回值的**调用**，
> 抛 `e(...) is not a function`。而这一支**只在 `form` 非空（配置读回来）后才求值**，
> 所以首帧正常、接口一回数据就整块白屏——用户看到的就是「点 Msynchub 什么都没有」。
> 改面板后只跑 `node --check` = 等于没测。
>
> `render-smoke` 用最小 react 桩把 `client.js` 真跑一遍，断言：注册出三个槽位、
> 首帧不抛错、**有数据不抛错**（分别覆盖 `missingInMap` 非空与空 `workspaceMap`）、
> 两次渲染钩子序一致（条件 hooks 同样会白屏）、以及源码级漏逗号护栏。
> 已验证它真能报：把同一处逗号删掉做成坏副本，该测试立即 10 项失败、exit 1。

### 3.2 真机验证（改完 `index.js` 必须做）

1. **完全退出 DSH 再打开**（托盘退出，确认进程结束）。
2. 侧边栏 `Msynchub` 面板能打开、能滚动到下面的卡片；未配远端时「先连上两个私有仓库」必须在「下一步」之前（顺序错会让拉取/推送按钮变成空转）。
3. 设置 → Msynchub →「当前状态」里看「状态目录=已初始化/未初始化」「两通道仓库=已建/未建」「回滚点个数」是否与本机实际相符。
4. 配好远端后，面板「下一步」头卡给出正确的那一件事（该拉还是该推）。

---
## 4. 各版本新功能怎么用（命令行等价接口）

### 4.1 受控删除单个会话（ADR-013）

GUI 不提供会话删除；本功能先备份再原子改多处，默认二次确认。

```text
GET  /api/dsh-synchub/purge-session?id=<sessionId>               # 预览（只读）
POST /api/dsh-synchub/purge-session  {id, confirm:"<同一个id>"}  # 执行
GET  /api/dsh-synchub/purge-session?id=<id>&verify=1             # 重启后验收
```

面板操作：④ 卡 → 填 id → 预览影响 → 再逐字输入一次 id → 解锁「确认删除」。
**必须 DSH 完全退出后操作并重启**；回滚点在 `$DSH_HOME\dsh-synchub\backups\purge-*\`，含 `RESTORE.md`。搜索索引是 DSH 派生库会自愈，不直接写。

### 4.2 会话蒸馏成文档（ADR-015）

不自动导出 compact 摘要（那是给模型续用的上下文）。面板 ⑤ 卡取模板 → 人填结论 → 确认写盘，落到会话所属工作区的 `docs/session-notes/`，由工作区 git 管。

```text
GET  /api/dsh-synchub/session-note?id=<id>[&filename=…]          # 预览 + 模板
POST /api/dsh-synchub/session-note  {id, content, confirm:"WRITE"}# 写盘（原样模板会被拒）
```

### 4.3 状态目录真实状态（ADR-016）

```text
GET  /api/dsh-synchub/state     # 只读：初始化 / 两仓库 .git / 回滚点数 / hint
```

`status` 响应也带 `state` 字段。`stateInfo` 只读、**绝不创建目录**。

---

### 4.4 会话救援（ADR-034，0.9.0 收窄）

> **0.9.0 把职责砍到只剩一件事：会话能不能打开。**
> 重复登记、空组目录、该归档的，一律只报告不主动改——那是专门的会话管理插件的事。
> 你当时的原话：「如果报错了先修复避免不能用，就可以了，其他交给专业的 session 管理插件」。

### 什么时候用它

**只要动过工作区目录的名字或位置，就先跑一次体检。** 典型信号：

- 侧边栏里出现「未分组」，但那些会话你明明在用；
- 会话标题变成「未命名」；
- 侧边栏里看得到某个会话，**点进去是空的**；
- 把工作区删掉又加回来之后，多出一批会话。

这几件事**都不是数据丢了**。会话正文（`sessions/**/session.v4.jsonl.zstd`）一直在磁盘上，
坏掉的是它和 `workspace.json` 归属之间的对应关系。

### 图形界面

侧边栏 → **⑤ 会话体检与修复**：

1. 点「检查一下（只读）」→ 画面只出现**一行结论**，三选一：
   - 绿 `● 能用` —— 会话都能打开，没事做，按钮也不出现；
   - 黄 `● 能修` —— 有打不开的，给一个「一键修复（N）」，点一下就好；
   - 红 `● 要你定` —— 有打不开的，但**必须你指定改到哪个工作区**（猜错会搬到错的地方）。
2. 「要你定」时逐条列出，每条前面有下拉框选目标工作区，再点「确认并…」。**工具不会替你选。**
3. 整洁项（重复登记、空组、可归档）全部折在「明细与整洁项」里，
   **不影响使用、不进一键修复**，但每条仍有自己的按钮，想清就点。
4. 修完自动复查一遍，告诉你还剩几处不能自动修。

**看 `health` 而不是数条数**：`ok` / `repairable` / `needs-human` 三态就是「你能不能用」。
条数多不等于有事 —— 十几条 advisory 也是 `ok`。
### 命令行等价接口

```powershell
$API = 'http://127.0.0.1:<当前端口>/api/dsh-synchub'

# ① 只读体检（永不写盘）
Invoke-RestMethod "$API/session-doctor" -Headers @{'sec-fetch-site'='same-origin'} | ConvertTo-Json -Depth 6

# ② 看接口自述（问题分类表 + 安全边界）
Invoke-RestMethod "$API/session-doctor/help" -Headers @{'sec-fetch-site'='same-origin'} | ConvertTo-Json -Depth 4

# ③ 一键救援（只跑 rescue.ids：影响「能不能用」且 safe 的，绝不碰空组/重复登记）
Invoke-RestMethod "$API/session-doctor" -Method Post -ContentType 'application/json' `
  -Headers @{'sec-fetch-site'='same-origin'} -Body '{"confirm":"REPAIR"}'

# ④ 改指：把某个组的会话搬到指定工作区（wsId 从 ① 的 actions[].payload.candidates 里取）
Invoke-RestMethod "$API/session-doctor" -Method Post -ContentType 'application/json' `
  -Headers @{'sec-fetch-site'='same-origin'} `
  -Body ('{"confirm":"REPAIR","ids":["relocate:' + $组名 + '"],"targets":{"relocate:' + $组名 + '":"' + $wsId + '"}}')
```

> 端口每次启动都变，从运行时上下文取，不要写死。
> `POST` 不带 `confirm:"REPAIR"` 会被拒（400），这是故意的闸门。

### 手动确认工作区 id

`workspace.json` 里每个工作区都有 `id` / `path` / `title`：

```powershell
$ws = Get-Content "$env:USERPROFILE\.dsh\storages\workspace.json" -Raw | ConvertFrom-Json
$ws.tables.workspaces.PSObject.Properties | ForEach-Object {
  [pscustomobject]@{ id = $_.Name; title = $_.Value.title; path = $_.Value.path; sessions = $_.Value.sessionIds.Count }
} | Format-Table -AutoSize
```

### 回滚

每次执行都会先写回滚点：

```
$DSH_HOME\dsh-synchub\backups\doctor-<时间戳>\storages\workspace.json
```

出问题就把这个文件拷回去，再完全重启 DSH：

```powershell
$b = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-synchub\backups" -Filter 'doctor-*' | Sort-Object Name | Select-Object -Last 1
Copy-Item "$($b.FullName)\storages\workspace.json" "$env:USERPROFILE\.dsh\storages\workspace.json" -Force
```

搬动过的会话目录**没有自动回滚**（源已被校验后删除），但每条 finding 的 `evidence` 里都记了原组名，
手工搬回即可：`Move-Item "$env:USERPROFILE\.dsh\sessions\<目标组>\<sessionId>" "$env:USERPROFILE\.dsh\sessions\<原组>\"`。

### 体检不做什么（别指望它）

| 不做 | 原因 |
|---|---|
| 不自动扫描（打开侧边栏不会跑） | 要遍历上百个会话目录并逐个解压首帧，比 `/status` 贵得多 |
| 不修「工作区路径已不存在」 | 目录是该重建还是该删，只有你知道；它只报告 |
| 不猜改指目标 | 猜错会把一整批会话塞进错的工作区，比不修更麻烦 |
| 不动 subagent 会话 | 它们本来就藏在组目录里、本来就不该出现在侧边栏 |
| 不检查会话内容是否损坏 | 只解首帧拿 header；`broken` 仅表示找不到正文文件或首帧读不出 |
| 不重启 DSH | 改完 `workspace.json` 要你自己重启，侧边栏才按新归属显示 |

### 4.5 单仓库模式（ADR-036，0.10.0）

用户原话：「配置两个仓库太麻烦，量也不大」。设置页「仓库模式」选 **单仓库** 即可：

- 一个私有仓库地址（填到「私有仓库地址」）；
- 两个分组开关：**同步配置组**（技能库 + 配置层 + 全局 `AGENTS.md`）/ **同步会话组**（会话 + 工作区登记 + 附件）；
- 物理上只有一个仓库 `repos/all`、一个 `payload/`，两组的文件顶层不冲突所以共存。

**从旧的双仓库迁移**（不会自动合仓，数据不丢）：

1. 在 GitHub 新建一个空私有仓库（或指定一个已有的）。
2. 设置页选「单仓库」，把地址填进去；两个分组开关按需要打开。
3. 点「保存」→ 回侧边栏点「立即同步」。插件会把**本机当前文件**重新 stage 进新仓库并推基线。
4. 旧的两个仓库（`dsh-config` / `dsh-sessions`）**留在磁盘与 GitHub 作历史**，不再使用；
   确认新仓库没问题后可以自行归档/删除。

> 单仓库会失去「一个通道坏了另一个能救」的隔离，且提交历史混合（改设置也连带会话提交）。
> 数据量不大时这个交易划算；如果以后后悔，把模式切回「双仓库」即可（两套仓库都还在）。

### 4.6 全局 AGENTS.md 同步（ADR-036）

新增同步面 `agentInstructions`（配置组、safe、默认开），把 `~/.dsh/AGENTS.md` 纳入同步。

- **工作区里的 AGENTS.md 不走这里**：它归各工作区自己的 git（「代码仓库同步」会把 `dw-base/AGENTS.md` 推到 `dshwp-base`）。
- `~/.agents/AGENTS.md`（`DSH_AGENTS_HOME`）本机不存在，暂未纳入。
- 在一台机器改了全局规则会覆盖另一台 —— 这是同步的预期，别写只对本地有意义的路径。

## 5. 排错表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 侧边栏/设置里看不到 Msynchub | 缺 `exports["./client"]` 或 `inject` 漏列服务（本插件 inject=['slots'] 是对的） | 查 package.json exports；打桩跑 `apply` 看缺什么 |
| 改了代码没生效 | 改的是 `index.js` 但没重启 / `client.js` 没刷页面 | 按 §0 表处理 |
| 面板「未初始化」但明明有 config.json | 状态接口读的是磁盘事实，草稿未保存 | 设置页点「保存」 |
| 在侧边栏填了地址但保存没生效 | **0.5.4 已修**：旧版把 setter 用错导致输入被丢 | 升级到 0.5.4 后完全重启；仍复现就截图保存时的接口响应 |
| 设置里保存成功后侧边栏信息没了 | **0.5.4 已修**：旧版侧边栏会把整份配置回写覆盖 | 升级后完全重启；侧边栏现在只改通道地址 |
| 侧边栏/设置都可配、不知道改哪 | 0.5.4 已重划分工 | 侧边栏只看状态+点同步；**所有配置在设置**。侧边栏有「配置在哪里改」卡 |
| 拉取报「远端不存在」 | GitHub 仓库没建或没权限 | 去 GitHub 建空私有仓库（Private、不勾 README），再「重新检查」 |
| 推送被拒「behind-remote」 | 另一台推过、本机落后 | 先「拉取并应用」再推，永不 force |
| 删除会话后列表还看得到 | 没重启，DSH 内存还持有旧会话 | 完全退出再打开，然后 `verify=1` 验收 |
| 删除后同步镜像里还有 | purge 只删本机正文，不动 payload | 下次推送时显式 `prune` 才清远端 |
| **会话掉进「未分组」/ 点了空白** | 工作区目录改名后，正文目录与 `workspace.json` 归属**两半都错位** | 侧边栏「⑤ 会话体检与修复」→ 检查一下；参见 §4.4 |
| 工作区删了又加后会话变成新的 | 删/加会新建 `workspaceId`，旧记录变成死指针 | 同上；体检把这种情况报成 `duplicate-ref` |
| 体检报了一堆「subagent 未登记」 | **不会** —— 旧版本（≤ 0.7.0）的误报；subagent 已排除 | 升级到 0.9.0 |
| **会话能用但体检报一堆「不整齐」** | 0.9.0 只自动修「打不开」，其余只报告 | 看 `health`：是 `ok` 就不用管；不要拿条数吓自己 |
| 体检说「可改指」但下拉里的工作区不对 | 旧路径已不存在，名字相似度只是排序建议 | 自己选对的那个；工具不猜目标 |
| 修完侧边栏还是旧分组 | `workspace.json` 是宿主启动时读的 | **完全重启** DSH（刷页面不够） |
| 体检执行报「正在写入」 | 30 秒内该会话还有改动 | 等会话静下来再修，或关掉那个会话 |

### 5.1 自己确认「配置到底生效了没」

不用猜，三个层次任选：

1. **看自检卡**（最简单）：侧边栏第一张卡。`✓ 同步已就绪` = 真的能用；
   `✗ 还不能同步（N 项）` = 展开「怎么做」，每条都有「怎么验」。
2. **看通道行**：`未配置远端` → 地址没生效；`N 落后 / N 领先 / N 脏` → 地址已生效。
3. **看磁盘上的真实配置**（绕过 UI 验证）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-synchub\config.json" -Raw
```

关注 `channels.config.remote` 与 `channels.sessions.remote` 是不是你填的值。
是 → UI 与磁盘已同步；不是 → 保存没落盘（向上排查）。

### 5.2 接口级手动验证

```powershell
# 快接口（侧边栏轮询用；不访网，实测 < 1s）
Invoke-RestMethod "http://127.0.0.1:<当前端口>/api/dsh-synchub/status?fast=1" | ConvertTo-Json -Depth 6

# 全量状态（带 install / workspaceReport；要访 GitHub，更慢）
Invoke-RestMethod http://127.0.0.1:<当前端口>/api/dsh-synchub/status | ConvertTo-Json -Depth 6

# 自检结论（一句话结论 + 逐步引导）
Invoke-RestMethod http://127.0.0.1:<当前端口>/api/dsh-synchub/self-check | ConvertTo-Json -Depth 6

# 开工检查逐项
Invoke-RestMethod http://127.0.0.1:<当前端口>/api/dsh-synchub/preflight | ConvertTo-Json -Depth 6
```

> 端口每次启动都变，从浏览器地址栏取。


> 设计如此、不是 bug：红点在图标左上角 5×5 是用户明确要求的小尺寸（ADR-012）。
> 侧边栏与设置**两处都在是刻意的**，但职责不同：侧栏=操作，设置=配置（ADR-022）。

---

## 6. 迁移 / 换机器

### 6.1 方式 A：只用 git 地址（不 clone 仓库，推荐给新主机）

DSH 官方入口 **设置 → 插件 → 添加插件**（dsh-market / 插件管理器），填：

```text
https://github.com/mengfanchun2017/dswp-plugin#path:dsh-synchub
```

命令行等价：

```powershell
dsh plugin add https://github.com/mengfanchun2017/dswp-plugin#path:dsh-synchub
```

- **必须带 `#path:dsh-synchub`**：dshplug 是多插件 monorepo，仓库根不是 bundle，不指子目录会报「没有声明组合包」。
- 这些地址在面板「⑥ 新主机安装」卡里可以一键复制（复制失败会明说「只是选中了」）。
- 来源是 GitHub，本机必须能直连或配代理。

### 6.2 方式 B：clone 仓库 + link:（本机开发用）

`install.ps1 -Only dsh-synchub` 建 `link:` Junction，**改代码即时生效**，适合开发。

### 6.3 迁移步骤
1. 两台机器路径必须完全一致（`C:\dsh\dshplug`、工作区 `C:\dsh\workspace1` 等，ADR-002）。
2. 新机器：clone 仓库 → `install.ps1 -Only dsh-synchub` → 完全重启 → 配两远端 → 「拉取并应用」。
3. 首次接入时插件发现本地仓库已 `git init` 但无 `HEAD`，会自动 bootstrap（把脚手架移到 `backups/pre-bootstrap-*` 再对齐远端）。
4. 0.2 旧插件（`chatsync` / `dsh-config-manager`）可卸载；`chatsync` 已废弃。
5. `workspace.json` 的导入是**并集合并**（ADR-003），`prune` 默认关闭——「远端没有」不等于「删了」。

---

## 7. 已知限制

- 只面向 Windows（`Windows\MinGit`、`$USERPROFILE\.dsh`）。
- 会话日志是 zstd 多帧，插件不解压、只按字节搬；改 cwd/移动会话不可行（ADR-014 评估为「不做」）。
- 两台不能同时推同一通道；`--ff-only` 永不自动合并会话 JSONL。
- 大文件 `MAX_FILE_BYTES` 200MB，超过跳过并记入 `skipped`。
- `profile/package.json` 含 `link:` 绝对路径是 danger 级永不同步，每台各自 `install.ps1` 生成。
