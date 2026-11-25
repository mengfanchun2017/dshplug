# dsh-synchub · Msynchub（同步中心）

把 DSH 的**会话、工作区、附件、技能、配置层**同步到你自己的私有 Git 仓库，
并用一个侧边栏面板把「现在能不能开工 / 该先拉还是先推 / 哪些目录动不得」讲清楚。

> **三份文档分工**：本 [`README.md`](./README.md)=怎么用；[`BOOTSTRAP.md`](./BOOTSTRAP.md)=怎么做（安装/验证/排错/迁移/命令行）；[`ADR.md`](./ADR.md)=为什么（决策+反面代价+已否决方案）。详细调研在 [`docs/`](./docs/)。
>
> **0.11.0（ADR-037）**：合并为**唯一仓库** `dsh-msynchub`——去掉模式切换与分组开关，只留一个 `cfg.remote`；
> 镜像目录从 `payload/` 改为 `dsh-home/`，并自动生成仓库 `README.md`（打开仓库就能看懂）。
> 旧 `dsh-config` 仓库已删除。本文以下章节描述的就是 0.11.0。
>
> **0.12.0（ADR-038）**：新增**插件清单备份/恢复**——只记名字（npm）与名字+位置（link），
> 不记版本；清单落 `dsh-home/plugins/manifest.json`，随同步走；恢复是「预览 → 确认 → 执行」，
> npm 走宿主 `pluginManager` 服务、link 写回依赖后 pnpm install；带开关（默认关，与 dsh-market
> 的备份导出二选一）。

0.16.0 是**侧栏编辑记忆版**（阶段④，ADR-042）：侧栏「⑦ 记忆地图」新增「编辑记忆文件」——选文件、读取、修改、备份后写回。写入走路径白名单（仅 `~/.dsh/memory/` 与 `<工作区>/memory/` 下的 `.md`）+ `confirm=WRITE` 闸门 + 写前备份。

0.15.0 是**整理记忆版**（阶段③，ADR-041）：把「现有记忆 + 范围内最近会话」交给模型合并去重，备份后覆盖回 `<工作区>/memory/PROJECT.md`，让记忆保持常新。支持手动（设置页「立即整理」）与定时（`tidy.intervalHours`）。

0.14.0 是**归档总结版**（阶段②，ADR-040）：会话归档时按工作区开关，用模型把会话整理成 Markdown 写入 `<工作区>/memory/PROJECT.md`（用户级 `~/.dsh/memory/USER.md` 可选）。新增归档事件监听（`workspace/session-archived`）、`GET /api/dsh-synchub/memory`、`POST /api/dsh-synchub/memory/archive`、同步面 `memory`，设置页新增「记忆管理」卡（总开关 / provider·model / 逐工作区开关 / 手动归档总结）。写前自动备份、只追加不覆盖。

0.13.0 是**记忆地图版**（阶段①，只读，ADR-039）：把 DSH 的「记忆」讲清楚——它不是一个文件，而是四层（记忆文件 / 用户全局规则 / 项目规则 / 技能）加会话日志。新增 `lib/memory.js` 枚举，`GET /api/dsh-synchub/memory-map`，侧边栏「⑦ 记忆地图」卡（默认折叠）与设置页「记忆文件」卡。**只读、不写盘**。记忆落点约定：工作区级 `<workspace>/memory/`、用户级 `~/.dsh/memory/USER.md`（归档自动写入与纳入同步是后续阶段）。

0.10.0 是**单仓库模式版**（ADR-036，已被 0.11.0 取代）：曾提供「单仓库/双仓库」切换与两个分组开关。



0.9.0 是**会话救援版**（ADR-034 收窄），只回答一个问题：**会话现在能不能打开。**

你当时的原话：「如果报错了先修复避免不能用，就可以了，其他交给专业的 session 管理插件」。
所以这一版把上版的 9 类巡检**砍到只管一件事**：

- **能用就是能用**（`health: 'ok'`）—— 重复登记、空组目录、该归档的，一律只报告、不主动改。
- **不能用但一键能修**（`health: 'repairable'`）—— 只有一个「一键修复（N）」按钮。
- **不能用且需要你指定目标**（`health: 'needs-human'`）—— 不显示一键按钮，而是把每一条列出来，
  让你自己选目标。猜错会把会话搬到错的地方，比不改更麻烦。

根因是一对必须同时成立的指针：

| 一半 | 位置 | 改名后变成 |
|---|---|---|
| 会话正文 | `$DSH_HOME/sessions/<编码后的工作区路径>/<sessionId>/` | 仍在**旧**路径的目录里 |
| 归属登记 | `$DSH_HOME/storages/workspace.json` 的 `sessionIds` | 仍挂在**旧**工作区记录上 |

DSH 在目录改名后会**新建**一个 `workspaceId` 指向新路径，旧记录变成死指针。**只修一半是最坑的**：
只改登记不搬目录 → 侧边栏有了这条、点进去空白；只搬目录不改登记 → 文件在但永远不显示。

所以这版的做法是：**先只读体检列出问题，再让你选修哪个，两半一起改。**

判定轴只有一根：**这件事会不会让会话打不开 / 看不见**。

| impact | 问题 | 典型成因 | 怎么修 |
|---|---|---|---|
| blocking | `orphan-group-relocatable` 可改指 | **目录改名了**（旧路径已不存在） | 选一个现存工作区 → 搬正文 + 补登记 |
| blocking | `orphan-group-recoverable` 可重建 | 目录还在，但工作区登记丢了 | 重建一条登记，或搬进已有工作区 |
| blocking | `dangling-ref` 悬空引用 | 会话删了，登记没删 | 清引用（**安全**，不动任何正文文件） |
| blocking | `unregistered-live` 未登记 | 正文就在有效组里，却没挂到任何工作区 | 补一条登记（**安全**，不搬目录） |
| blocking | `group-mismatch` 分组错位 | 正文在 A 组，登记在 B 工作区 | 搬目录到 B 组 |
| blocking | `workspace-path-missing` | 工作区路径已消失 | **不自动修**，需你在 DSH 里重新添加那个工作区 |
| advisory | `duplicate-ref` 重复登记 | 删掉工作区又加回来 | 只保留一个归属（**只报告，不自动改**） |
| advisory | `orphan-group-dead` 无处可归 | 原目录彻底删了，对不上任何人 | 归档建议（**只隐藏，不删正文**；不自动做） |
| advisory | `empty-group` 空组 | 改名后留下的空壳 | 删空目录（**只报告，不自动删**） |

advisory 项全部折叠在「明细与整洁项」里，**不进一键修复**，但每条仍有自己的按钮，
想手动处理时点一下就行——「不主动做」不等于「没入口」。

`summary.health` 只有三种值，客户端据此决定显示什么：

| health | 含义 | 界面 |
|---|---|---|
| `ok` | 会话都能打开 | 绿 `● 能用`，不给修复按钮 |
| `repairable` | 有打不开的，但一键能修 | 黄 `● 能修`，给「一键修复（N）」 |
| `needs-human` | 有打不开的，但必须你指定目标 | 红 `● 要你定`，逐条列出 + 目标下拉 |
安全边界（每一条都有测试盯）：

- **只读扫描永不写盘**；执行前先把 `workspace.json` 备份到 `backups/doctor-<时间>/`。
- **搬目录一律「复制 → 逐字节+逐文件校验 → 删源」**，中途失败源目录还在。
- **30 秒内还在写入的会话拒绝搬**（不碰正在用的会话）。
- **subagent 会话不参与判断** —— 它们本来就该藏在组目录里，不该出现在侧边栏；把它们当「未分组」是误报。
- **改指必须你选目标**，工具绝不猜：猜错会把会话塞进错的工作区，比不修更麻烦。
- 改完 `workspace.json` 要**重启 DSH** 才按新归属显示（会话正文是即时生效的）。

新增 [`lib/sessiondoctor.js`](./lib/sessiondoctor.js)（独立引擎，不塞进 3500 行的 `index.js`）
与 [`test/sessiondoctor-smoke.cjs`](./test/sessiondoctor-smoke.cjs)（23 条断言，含干净现场不许瞎报、
无 `confirm` 必须拒绝且不写盘、subagent 不误报、回滚点里存的必须是执行前原文，
以及 J 组 6 条钉死职责边界：`impact` 不漏网、`health` 三态、
**一键救援（不传 ids）只动 blocking 且不碰空组目录**）；
[`test/render-smoke.cjs`](./test/render-smoke.cjs) 共 **98 条**，E0c 段是**真渲染**断言
（未扫描 / 有发现 / 报错 / 干净现场 / 缺字段，以及本机真实态 `needs-human`
与升级中间态「新 client + 旧 index」两种必须覆盖的分支）。

> 这套渲染断言当场抓到一个会白屏的真 bug：`payload.candidates[0]` 在旧版宿主半
> （升级中：新 client + 旧 index，压根不给 `payload`）时抛渲染期 TypeError，
> 整块侧边栏白屏且无任何提示。已改为 `candsOf` / `firstCand` 安全取值，
> 并加两条源码护栏。**变异测试过**：去掉 `Array.isArray` 保护，断言立即变红。

0.7.0 是**改名与大仓库友好版**（ADR-031/032/033），解决三类"看起来好了其实没好"：

① **工作区改名后会话变「未分组」** → 新增 `session-move`（单条 + 批量）：
   自动搬正文目录并改 `workspace.json` 归属，先备份再动、复制后逐字节校验。
   实测本机把 10 个会话从 `--C-dsh-base--` 迁到 `--C-dsh-dw-base--`，全部通过。
② **「查不到」被画成「一切正常」**（假绿第三次）→ 代码仓库卡现在分四态：
   读不到（红 `✗`）/ 未连远端（黄 `!`，说「本地有提交也无处可推」）/ 有差异（黄 `!`）/ 真同步（绿 `✓`）。
   之前的 bug：仓库目录已改名不存在，三个零被画成「已同步」——用户反问「你从哪检查来的」。
③ **每次点侧边栏都要等刷新** → 模块级 20 分钟缓存 + 首帧直接渲染上次结果，
   头部改说「14:32 的结果（15 分钟内沿用，打开不用等）」。命中缓存**仍然后台刷新**，只是不让人等。

同批新增：设置面板可**增删任意 git 仓库**（不再只能手改 `config.json`），
路径任意、不必在 `C:\dsh` 下 —— 对应「我还有一个之前的仓库要做同步但不在 dsh 目录下」。
新增 [`test/sessionmove-smoke.cjs`](./test/sessionmove-smoke.cjs)（7 组，含 14 个真实目录交叉验证）。

0.6.0 是**双机工作流完善版**（ADR-029/030）：
① 主按钮改为「立即同步」：拉取（ff-only）→应用→暂存→提交→推送一口气，
   下班点一下全上线；旧的「提交并推送」「拉取并应用」降为次按钮。
② 分叉（两台各自推过）产品化：面板出现「分叉处理（二选一）」卡，
   以本机为准（覆盖云，force-with-lease）或以远端为准（覆盖本机，reset+apply），
   覆盖前双向备份提交哈希到 `backups/diverge-*`；可先「看两边的提交」再决定。
   不做三方合并——会话是 append-heavy JSONL/zstd，文本合并产出不可读结果（ADR-014 同源证据）。
新增 [`test/diverge-smoke.cjs`](./test/diverge-smoke.cjs)。


0.5.9 是**侧边栏重做版**（兼修一个致命性能缺陷）：之前每次进侧边栏都是同一屏长篇说明，
写着「还缺两个仓库地址」与「同步中心状态接口不可用」——但设置里地址明明已经填好。
两个独立问题：
① **四个接口全部超过前端 30 秒超时**：`/preflight` 37.6s、`/self-check` 42.7s（限 30s → 中止）。
   耗时全在网络上：`ls-remote` 3.9s + `fetch` 2.8s，三个接口各跑一遍就是 20s+。
   修法：`/status?fast=1` 完全不访网（实测 **10562ms → 593ms**）、`fetch` 结果 8 秒缓存且存 Promise
   让并发请求共用一趟网络往返、慢接口不再阻塞首屏且超时提到 60s。
② **内容职责错位**：九张说明卡摊开，真正关心的四个数字埋在最下面。
   新增首屏仪表盘：一句话结论 + 四个数字（待同步 / 落后 / 待推送 / 自动同步开关）
   + 「下次自动：约 N 分钟后」+ 按钮组（0.6.0 起主按钮是「立即同步」）。
   其余说明全部收进「说明与其他」折叠区。
关键原则：**`own=null`（没拿到数据）时不再显示「还缺两个仓库地址」**。
没拿到数据 ≠ 没配 —— 那条误导会让用户去重填已经正确的配置。见 ADR-028。

0.5.8 是**假绿修复版**（重要）：面板显示「两通道已建 · 0/0/0 · 可以开始工作」，
但 GitHub 上 `dsh-session` 是空的、`dsh-config` 里只有旧的 `snapshots/`。
根因：`channelState` 用 `git status --porcelain -uno` 当作「有东西没同步」——
空仓库的 git 工作区恒为干净，`dirty` 恒为 0，于是 preflight 判「payload 已对齐本机」「可以开始工作」，
而本机 265 个文件一个都没进 payload。修了三处：
① 新增 `pending`（真实未暂存数，仅在显式 `scan` 时算，不挂轮询）与 `payloadMissing`（便宜的 existsSync）；
② 面板/preflight 一律改用 `unsynced = dirty + pending`，「两通道仓库」不再把 `.git` 在就叫「已建」，
  改为「未建 / 空仓库（无提交）/ 无 payload（未同步）/ 已同步」四态；
③ `branchOf` 不再硬写 `main`，改为读本地 `.git/HEAD` 指向的分支——
  `dsh-config` 实际在 `master` 上，写死 `main` 会让 `rev-list HEAD...origin/main` 失败、
  `behind` 错误地停在 0，看起来像「与远端一致」。
新增 [`test/unsynced-smoke.cjs`](./test/unsynced-smoke.cjs)（21 条断言，含源码护栏，已做变异测试）。见 ADR-026。

同版本还做了一次仓库整理（ADR-027，用户拍板）：删掉 `dsh-config` 里 2026-11-12 遗留的
`snapshots/`（29 文件，旧结构，已被 `payload/` 取代），并把两仓库默认分支**统一为 `main`**
（`dsh-config` 原为 `master`：改本地分支 + 推 `main` + 改 GitHub 默认 + 删远端 `master`）。
**注意**：另一台机器若还指向旧 `master`，需 `git fetch --prune && git branch -m master main && git branch -u origin/main`。
代码仍能自适应 `master` 仓库，不依赖这次整理。

0.5.7 是**设置页白屏修复版**：点设置里的 Msynchub 什么都不显示——原因是工作区卡片漏了一个逗号，
`e(...)` 的返回值被当成函数调用，且**只在配置读回来后才炸**，所以首帧正常、数据一到整块空白。
修好之余补了 [`test/render-smoke.cjs`](./test/render-smoke.cjs)：用 react 桩真跑 `client.js`，
覆盖首帧 / 有数据 / 钩子序 / 源码护栏（已做变异测试，确认能拦住旧 bug）。见 ADR-025。

0.5 是**功能完善版**：完成 ADR 待办五项（受控删除会话 / 会话蒸馏文档 / 状态目录真实状态 / 移动评估「不做」/ 发布决策维持本地分发），见 ADR-013~017；补齐 4 份离线 smoke。
0.4 是**面板可用性修复版**：0.3 的引擎不变，侧边栏面板之前**不能滚动**（下面三张卡根本看不到），
且「已有余力」与「还没配」的文案互相矛盾。0.4 重建了面板布局与引导。

0.3 是一次**架构换代**：0.2 只是个「聚合别的插件状态」的转发层，
0.3 自己就是同步引擎——不再依赖 `chatsync` 和 `dsh-config-manager`。
> 源码由仓库 `C:\dsh\dshplug` 的 `list.json` 管理；安装用 `install.ps1`，
> 上线给另一台用 `plugpush.ps1`。详见仓库根 README。

---

## 1. 为什么换成「自己同步」

0.2 的做法是转发：会话交给 `chatsync`、配置交给 `dsh-config-manager`。
实际用下来有两个绕不过去的问题：

1. **两个插件各自实现了一遍搬运逻辑**，冲突裁决、快照回滚、跳过活会话……
   规则不一致，出问题时不知道是谁的锅。
2. `dsh-config-manager` 的 `localPluginPack` 会把 `link:` 插件 `npm pack` 成 tarball，
   导入时**重写 spec 为导入机的绝对路径**——它同步的配置和本仓库管理的插件清单会互相打架。

0.3 的答案：**插件源码仍归 `dsh-market` / 本仓库**，
**其余所有 DSH 状态由 `dsh-synchub` 用一个引擎同步**。
只有一套规则、一份历史、一个面板。

`chatsync` 已废弃，可以卸掉。

---

## 2. 唯一仓库：dsh-msynchub

**一个仓库装下所有 DSH 状态**（ADR-037，0.11.0 起为唯一模式，不再有双仓库/分组开关）。

| 项 | 值 |
|---|---|
| 远端 | `cfg.remote` 一个地址（例如 `https://github.com/<你>/dsh-msynchub`） |
| 本地工作副本 | `$DSH_HOME/dsh-synchub/repos/all/` |
| 镜像目录 | `repos/all/dsh-home/`（= `$DSH_HOME` 的镜像） |
| 仓库根 | 一个 `README.md`（插件自动生成，解释每个目录） |

### 仓库长什么样

```
dsh-msynchub/
├─ README.md                 ← 插件自动生成：这个仓库是什么、目录怎么读
└─ dsh-home/                 ← $DSH_HOME 的镜像（路径一一对应）
   ├─ sessions/              ← 会话日志（zstd；子目录名 = 工作区绝对路径编码）
   ├─ storages/              ← 工作区登记表 workspace.json + 投影缓存
   ├─ attachments/           ← 附件池（sha256 内容寻址）
   ├─ skills/                ← 技能文件本体
   ├─ profiles/<profile>/    ← DSH 配置层（cordis*.yml，不含密钥）
   └─ AGENTS.md              ← 用户全局规则
```

> 旧版曾用 `payload/` 这个名字，0.11.0 已统一改为 `dsh-home/`；
> 插件首次运行时会自动把旧的 `payload/` 迁过来，不用手动搬。

### 为什么用 Git 而不是自己写 manifest

- `HEAD` 的树**就是**权威文件清单——不存在「清单与实际不同步」这种 bug
- 内容寻址自动去重（同一份附件、同一版技能不会存两遍）
- `--ff-only` 天然提供「落后就拒绝」的冲突检测
- 任何时刻可回滚到任意历史点
- 断网也只是推送失败，本地历史照常积累

---

## 3. 同步面分级：safe / caution / danger

不是所有东西都该同步，而且**「危险」是硬约束，不是一个可以勾掉的建议**。

```js
surfaceEnabled(surface, cfg) => Boolean(cfg.surfaces[surface.id]) && surface.tier !== 'danger' && groupEnabled(cfg, surface.channel)
```

### safe（默认开）

| id | 内容 | 说明 |
|---|---|---|
| `sessions` | `sessions/**` | zstd 多帧压缩的会话日志，目录名是工作区绝对路径的编码 |
| `storages` | `storages/**` | `workspace.json` 决定会话归属哪个工作区；`session_projcache` 存 `cwd` |
| `attachments` | `attachments/**` | sha256 内容寻址，与路径无关，跨工作区共享 |
| `skills` | `skills/**` | 技能文件本体；技能的**安装**仍走 dsh-market |
| `agentInstructions` | `AGENTS.md`（仅全局） | 用户全局规则（DSH 每次会话注入）。工作区内的 AGENTS.md 归各工作区自己的 git 管，synchub 不碰 |

> `~/.dsh/skills/<名>/` 里的技能目录**不是插件目录**。
> 插件（`dsh-rag` / `dsh-preview-editor`）在 `profiles/desktop/node_modules/`，
> 技能是独立复制的 markdown 文档，**不是软链，也不从插件包里读**。同名是因为
> 这个插件的用法值得写成可加载的文档。详见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §1。

### caution（默认开，但要看一眼再开）

| id | 内容 | 为什么只是 caution |
|---|---|---|
| `profileConfig` | `profiles/<p>/cordis.patch.yml`、`cordis.yml` | 本机实测只含 `apiKeyEnv` 的**变量名**（`OFFICE_API_KEY` 等）和 baseURL，不含密钥。但 baseURL 是环境特有的，换网络可能连不上 |

> **MCP 配置就在这一层**：一条 server = 一行 `@deepseek-ai/dsh-mcp-client`，不存在全局 `mcp.json`。
> 它会跟着 `profileConfig` 走——所以跨机前先看 `url` / `command` 是不是本机特有。
> 更稳的做法是把 MCP 行写进本仓库某个插件的 `cordis.patch.yml`，跟着 `plugpush` 走。
> 详见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §2。

### danger（**永远不同步**，不可开启）

| id | 内容 | 后果 |
|---|---|---|
| `profileManifest` | `profiles/<p>/package.json`、`pnpm-workspace.yaml` | 含 `link:C:/dsh/...` 绝对路径。另一台没有同一路径 → **DSH 启动失败** |
| `credentials` | `.credentials.yaml` | API key，进仓库即泄露。**MCP 的 key 也存在这里**（或环境变量/`.env`），优先级：凭据文件 > 环境变量 > 项目 `.env` > home `.env`。配置里只出现 `!!js` 引用，不出现明文 |
| `traeAuth` | `.trae-auth.*.json` | 设备令牌 |
| `workbuddy` | `.workbuddy-*.json` | 设备身份，应各机各自登录 |
| `mobileKeys` | `mobile-access/**` | iroh TLS 私钥，泄露即中间人 |
| `runtimes` | `dsh-runtimes`、`node_modules`、`.pnpm` | 可重建，数百 MB，跨平台失效 |
| `caches` | `plugins`、`pixel-studio`、`workbuddy-vault`、`dsh-market` | 本地缓存，重建即可 |
| `quarantine` | `_sessions-quarantine-*` | 疑似损坏的历史会话，留档用 |
| `logs` | `logs` | 本机运行时日志，同步过去只会误导排障 |
| `profileOther` | `profiles/` 除那两份 yml 之外 | 还包括 `node_modules`、`.pnpm`、缓存的登录态 |
| `deviceId` | `.anonymous-user-id` | 每台机一个身份；同步会让两台机互相冒充 |

插件清单整份（`package.json`）不同步是刻意的：**插件由 `dsh-market` 管**，
而 `link:` 规格里的绝对路径本来就不能跨机搬运。

> **例外（ADR-038，0.12.0 起）**：新增「插件清单备份」——只记**名字**（npm）与
> **名字+目标位置**（link），不含绝对路径 spec、不含版本，落 `payload/plugins/manifest.json`，
> 复用 config 仓库。恢复走「预览 → 确认 → 执行」，npm 用宿主 `pluginManager` 服务安装，
> link 校验目标存在后重新链接。开关 `cfg.pluginSync.enabled`（默认关），与 dsh-market 的
> 备份导出二选一。详见 [`ADR.md` ADR-038](./ADR.md)。
---

## 4. 三条硬规则

### 规则一：绝不「落后还写」

推之前先 `fetch`，落后就**拒绝**而不是强行合并：

```js
// ⚠ 顺序故意是「先 fetch 判落后 → 再 commit → 再 push」。
// 早先版本先 commit 再检查，落后时会先在本地凭空造一个分叉提交，
// 之后 ff-only 永远拉不下来 —— 只能人工 reset。
```

这是 0.3 开发中**真实踩到并修掉**的 bug：早期实现先 `commit` 再检查落后，
两台机器交替使用后 `HEAD` 与 `origin/main` 永久分叉，怎么拉都拉不动。

拉取用 `merge --ff-only`，永不 `rebase`、永不 `force`。
非快进时明确报「需要人工处理」，把选择权交给你。

### 规则二：覆盖和删除前一律备份

任何写回本机的动作，先把原文件复制到
`$DSH_HOME/dsh-synchub/backups/<timestamp>/<原相对路径>`。

删除（`prune`）同样备份——否则 prune 就是不可逆操作
（这也是开发中修掉的一个 bug：早期 prune 分支漏了 `backedUp += 1`，删了却不留底）。

**`prune` 默认关闭**，必须显式传才删。默认行为是「只增不删」：

> 在 B 上 pull 时如果远端删掉了一个会话，B 本地会保留它——
> 因为「远端没有」既可能是「A 删了」，也可能是「A 还没推」。
> 只有你确认后才用 `prune`。

### 规则三：绝不覆盖正在写的会话

`DSH_SESSION_ID` 指向的那个会话文件会被跳过（`skipActive`），
否则会把当前正在对话的日志覆盖坏。

---

## 5. 环境切换检测：知道「现在是谁的主场」

这是「过一段时间没操作就自动上传」和「切环境先拉一把」两个需求的落点。

### 机器身份怎么传播

**不用共享文件**。早期版本把 `synchub/machine.json` 提交进仓库，
结果两台机器每次都改同一个文件 → 每次推送都制造一个真分叉（正是规则一要防的东西）。

改用**提交消息尾注**：

```
synchub: <你的机器名> @ 2026-11-12T04:35:20.468Z

Synchub-Machine: <你的机器名>
Synchub-At: 2026-11-12T04:35:20.468Z
```

各机器只写自己的提交，读时从 `origin/main` 的 `log` 里解析。
两个通道都查，取时间戳更新的那个——可能只有会话通道被推过。

### 状态机

```
statusPayload():
  stamp.machine === cfg.machine ?
    ├─ 是  → switched: false，正常待办
    └─ 否  → switched: true
              → 面板提示「远端最近由 <机器> 推送」
              → verdict 变成「先拉取远端」
```

`preflight()` 把它翻译成一句人话，五种结局：

| verdict | 触发 |
|---|---|
| 尚未配置 | 通道没配远端，或仓库没初始化 |
| 环境未就绪 | `DSH_HOME` 不存在 / git 不可用 |
| 先拉取远端 | 任一通道 `behind > 0`（**包括别人刚推过**） |
| 待推送 | 本地有未推的提交或未暂存的改动 |
| 可以开始工作 | 全部通道既不落后也没有待推 |

**「查过了没事」和「根本没查」必须分开**——这是贯穿全插件的原则。
`fetch` 失败时 `behind` 会保持旧值，所以 `channelState` 显式带一个
`fetched: false` 标记，界面显示「状态未知」而不是绿色勾。

> 开发中修掉的第三个 bug：早期 `channelState` 不 `fetch` 就读 `origin/main`，
> 看到的永远是上次 fetch 的旧快照，把「另一台刚推过」误报成「与远端一致」。
> 现在 `status` / `preflight` / `check` 全部传 `fetch: true`。

### 空闲自动上传

`idlePushMinutes`（默认 20 分钟）+ 5 分钟冷却。触发条件**全部**满足才动：

- 距上次本地改动超过阈值
- 有实际改动（不是空跑）
- **没有落后远端**
- 不在冷却期内

如果落后，它**刻意什么都不做**，只记录原因——
无人值守时最不该做的事就是替你制造分叉。

`autoPush` 默认关闭。

---

## 6. 目录一览（面板里能看到的就是这些）

`GET /api/dsh-synchub/map` 返回 17 行：7 个可同步面 + 10 个不同步目录。
每行含 `paths / tier / syncOn / files / bytes / note / exists`。

后 4 行（`logs` / `profileOther` / `deviceId` / `quarantine`）是补上的：
每个机器上的目录都必须能回答「为什么它不在里面」，否则下次迁移时又得重新猜。

危险目录默认**不统计大小**（`deep=1` 才算，且排除 `runtimes` / `caches` /
`profileOther` / `logs` 这类畸大或无穷尽的目录）。
界面在未统计时显示 `—` 而不是 `0`——避免把「没数」看成「是空的」。
本机实测规模（示例机器，2026-11-12）：

```
sessions         71 文件    52.8 MB
storages         73 文件     3.9 MB
attachments      45 文件     3.3 MB
skills           19 文件    45.7 KB   ← 仅 skills/（2026-11-12 移除了 skill-manager）
profileConfig     2 文件    54.4 KB
profileManifest   2 文件     1.4 KB   ← 不同步
```

不同步的部分只是列出来给你确认「它确实被排除在外」，不是让你去算它多大。
其中 `mobile-access` 的 21 个文件里有 14.2 MB 是 iroh TLS 私钥——
这是整个 `~/.dsh` 里最不能进仓库的东西，deep 模式下能看到它被单独标出来。

---

## 6.5 记忆地图（只读）

DSH 的「记忆」不是一个文件，而是几层。侧边栏「⑦ 记忆地图」与设置页「记忆文件」把它们列清楚：

| 层 | 位置 | 谁管 |
|---|---|---|
| 记忆文件 | `<工作区>/memory/`、`~/.dsh/memory/USER.md` | Msynchub（归档时写入，后续阶段纳入同步） |
| 用户全局规则 | `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md`（预留位） | synchub 同步前者；后者不同步 |
| 项目规则 | 项目根（最近 `.git`）→ 工作区路径每层的 `AGENTS.md`/`CLAUDE.md`、`*.local.md` | 各工作区自己的 git |
| 技能 | `<项目根>/.dsh/skills`、`<项目根>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills` | 项目级归工作区 git；用户级 `~/.dsh/skills` 已同步 |
| 会话日志 | `~/.dsh/sessions/**` | synchub 同步（只搬字节，不解压） |

API：`GET /api/dsh-synchub/memory-map`。**只读，不写盘**；枚举失败按「不存在」处理，不让整张表崩。

## 7. 两台机器的前置条件

**工作区路径必须完全相同**（例如都在 `C:\dsh\workspace1`）。这不是洁癖，是三重依赖：

1. `sessions/<编码目录>/` 的目录名 = 工作区绝对路径的编码
   （`C:\dsh\workspace1` → `--C-dsh-workspace1--`）
2. `storages/workspace.json` 的 `tables.workspaces[id].path` 是绝对路径
3. 会话投影缓存里的 `cwd` / `identity.path` 是绝对路径

路径不同 → 会话能搬过去但**在界面上归不到任何工作区**，变成「未分组」孤儿。

> 「未分组」在 DSH 里不是独立存储，而是 `workspaceId === ""` 的 UI 派生桶，
> 所以它没有可同步的实体——只能靠路径一致来避免。

插件路径同样要一致：`link:` 规格把绝对路径写进 `profile/package.json`。

### 分支不写死：main / master 都行

早期版本把 `BRANCH = 'main'` 写死，这在你这台机器上会直接出事：
`dsh-config` 远端只有 `master`，写死 `main` 会推上去一个**平行的空历史分支**，
两台机器各看一半，而旧提交全在 `master` 上——等于凭空丢了历史。

现在的顺序是：`config.channels[ch].branch` → `ls-remote --symref origin HEAD` → `main`。
尚未初始化的仓库，`status` 报 `branch: null` 而不是 `main`——
**「未知」不能伪装成「默认值」**，否则你会以为分支已经确定了。
### 导入是**并集合并**，不是覆盖

这是 DSH 自己的语义，同步引擎必须顺着它：
所以 B 上多出来的会话不会因为 A 推了一版就消失，反之亦然。
也正因如此，`prune` 必须是显式动作。

---

## 8. API

全部挂在 `/api/dsh-synchub/*`（共 **27 条**），只监听 loopback，复用与 chatsync 同源的 origin/跨站 guard。

| 路由 | 作用 | 写本机？ |
|---|---|---|
| `GET /config` | 当前配置 | 否 |
| `GET /status` | 两通道 ahead/behind/dirty + 机器信标 + `state`（状态目录真实磁盘状态） | 否 |
| `GET /state` | 状态目录真实状态（初始化/仓库/回滚点；只读不创建） | 否 |
| `GET /install-info` | 安装信息（插件目录、数据目录、版本，供面板显示绝对路径） | 否 |
| `GET /self-check` | 一次性自检结论 + 引导（含「还缺什么、点哪里」） | 否 |
| `GET /workspaces` | DSH 已登记工作区清单（迁移时的 	o 候选） | 否 |
| `GET /map?deep=1` | 目录一览 | 否 |
| `GET /preflight` | 开工检查（一句话结论 + 逐项） | 否 |
| `GET /check` | 全项体检 | 否 |
| `POST /scan` | 扫描本机改动、算差异（不落盘） | 否 |
| `POST /stage` | 把本机改动写进 payload | 是（仅 payload） |
| `POST /pull` | 拉取（`apply:true` 才写回本机，`prune:true` 才删） | 视参数 |
| `POST /push` | 提交 + 推送（落后则拒绝） | 是（仅 payload） |
| `POST /sync` | pull → 拉取不一致则停；否则 stage → push | 视情况 |
| `POST /auto` | 空闲自动上传的一次 tick | 视情况 |
| `GET /repos` | 代码仓库状态清单（未提交 / 领先 / 落后 / 是否连远端，只读本地） | 否 |
| `POST /repos/sync` `{id}` | 单个代码仓库：add -A → commit → push（无远端则只提交并说明） | 是（提交该仓库） |
| `GET /diverge?id=<通道>` | 分叉详情（两边提交列表 + 建议），只读 | 否 |
| `POST /diverge/resolve` `{side:'local'|'remote', confirm}` | 分叉二选一（覆盖前双向备份提交哈希） | 是（改写 payload/远端） |
| `GET /purge-session?id=<id>` | 受控删除**预览**（只读；见 ADR-013） | 否 |
| `POST /purge-session` `{id, confirm:<同一个id>}` | 受控删除**执行**（二次确认 + 备份 + 原子改多处；需重启验收） | 是（删除单个本机会话） |
| `GET /purge-session?id=<id>&verify=1` | 重启后验收删除是否干净 | 否 |
| `GET /session-move?id=<id>&to=<工作区名>` | 迁移**预览**（只读：看清源/目标组目录、文件数、会不会拒绝） | 否 |
| `POST /session-move` `{id, to, confirm:'MOVE'}` | 迁移**执行**（备份 → 复制 → 校验 → 删源，同时改 workspace.json） | 是（搬本机会话目录） |
| `GET /session-move?id=<id>&to=<工作区名>&verify=1` | 迁移后验收（目标处文件齐、归属已登记、源已清空） | 否 |
| `POST /session-move/group` `{from, to, confirm:'MOVE'}` | **批量**迁移（只碰未登记会话；返回逐条结果，删空旧组目录） | 是（同上，多条） |
| `GET /session-doctor` | **会话体检**（只读）：扫 `sessions/` 与 `workspace.json`，返回 `findings[]` + `actions[]`（ADR-034） | 否 |
| `POST /session-doctor` `{ids?, targets?, confirm:'REPAIR'}` | 体检修复执行：不传 `ids` 只跑 `safe:true` 的；`relocate-group` 必须在 `targets` 里指定目标 `wsId` | 是（搬正文目录 + 改 workspace.json） |
| `GET /session-doctor/help` | 体检接口自述：问题分类表 + 安全边界 + 用法 | 否 |

> **受控删除单个会话**（0.5.0）：GUI 不提供删除，物理删 `.zstd` 会留下悬空引用（ADR-004 §4.4）。
> 面板「④ 受控删除单个会话」卡走「预览 → 再输入一次 id → 删除」，执行时先全量备份到
> `$DSH_HOME\dsh-synchub\backups\purge-<ts>-<id>/`（含 `RESTORE.md`），再校验静止、原子改
> `workspace.json` 四处引用 + 删正文目录 + 投影缓存；**搜索索引是 DSH 的派生库，会自愈，不直接写**。
> 删除后必须**完全退出 DSH 再重启**才会生效。该操作只删本机正文，不动同步镜像；要清远端需显式 `prune`。
| `GET /session-note?id=<id>[&filename=…]` | 蒸馏模板预览（只读；落点=会话所属工作区 docs/session-notes/） | 否 |
| `POST /session-note` `{id, content, confirm:'WRITE'}` | 人工蒸馏文档写盘（confirm 闸门，原样模板拒绝） | 是（写工作区文件） |
| `GET /plugin-backup` | 插件清单备份状态（开关/间隔/清单摘要） | 否 |
| `POST /plugin-backup` | **备份插件清单**（只记名字/位置，不记版本；无变化不写盘） | 是（写 dsh-home/plugins/manifest.json + 提交） |
| `GET /plugin-restore` | 恢复预览（只读：新增 npm / 重新链接 link / 目标缺失） | 否 |
| `POST /plugin-restore` `{confirm:'RESTORE'}` | 恢复执行：npm 走宿主服务，link 写回依赖 + pnpm install | 是（装插件 / 改 package.json） |

> **会话蒸馏成文档**（0.5.0，ADR-006/015）：面板「⑤」给一份五章模板（确定结论 / 决策与理由 / 待办 / 文件路径 / 过程性细节），**由人填写后确认写盘**，不自动解码 compact 摘要。文档落在会话所属工作区的 `docs/session-notes/`，由工作区 git 管、跨机可见，`dsh-synchub` 不搬运它。

`/sync` 的顺序是刻意的：**先 pull，拉下来还有问题就停下等人看**，
而不是闷头推上去把冲突藏起来。

---

## 9. 状态目录

```
$DSH_HOME/dsh-synchub/
├─ config.json          ← 本机设置（不进任何通道，两台各设各的）
├─ hash-cache.json      ← mtime/size 指纹缓存，避免每次全量哈希
├─ repos/
│  └─ all/              ← 唯一仓库工作副本（dsh-home/ 是 $DSH_HOME 镜像）
└─ backups/<ts>/        ← 每次覆盖/删除的原文件
```

`dsh-home/` 是镜像子树：`dsh-home/sessions/...` 对应 `$DSH_HOME/sessions/...`。
这样仓库根还能放 `.gitattributes`、`README.md` 等仓库自身的东西，不会和同步内容混在一起。

### 配置项

```json
{
  "machine": "<你的机器名>",
  "remote": "https://github.com/<你>/dsh-msynchub",
  "workspace": "C:\\dsh\\workspace1",
  "surfaces": { "sessions": true, "storages": true, "attachments": true,
                "skills": true, "agentInstructions": true, "profileConfig": true, "profileManifest": false },
  "idlePushMinutes": 20,
  "autoPush": false,
  "staleHours": 48
}
```

`machine` 默认取 `os.hostname()`。**两台务必不同名**，否则环境切换检测失效。

---

## 10. 面板

> **两处的分工（0.5.4 起明确）**：侧边栏只管「看状态 + 点同步」，所有配置只在设置里改。
> 之前两处都能改配置，导致“侧边栏保存不生效 / 设置保存后侧边栏信息没了”两个真 bug（ADR-022）。

| 入口 | 只用做这些 | 不做什么 |
|---|---|---|
| **侧边栏 Msynchub** | ① **仪表盘**（一句话结论 + 四个数字 + 下次自动）；② **分叉二选一卡**（两台各自推过时）；③ 自检结论（就绪/待处理 + 逐步引导）；④ 通道快照（落后/领先/脏）；⑤ 空闲开关一行摘要；⑥ 目录地图；⑦ 按钮：立即同步（主）/ 提交并推送 / 拉取并应用 / 重新检查；⑧ 高级操作折叠区 | **不写任何配置**（不内嵌输入框，也没有保存按钮） |
| **设置 → Msynchub** | **唯一配置入口**：① 必做：仓库模式与仓库地址（单仓库一个 / 双仓库两个）；② 可选：本机设置与工作区映射、同步面开关；③ 诊断与维护：当前状态、检查结果、目录清单 | 不放日常同步按钮 |

**自检怎么用**：打开侧边栏，第一张卡直接告诉你结论。
- `✓ 同步已就绪` → 点「立即同步」（拉+推一口气；0.6.0 前是分两个按钮）。
- 分叉（两台各自推过）→ 用「分叉处理（二选一）」卡，先「看两边的提交」再选边（ADR-030）。
- `✗ 还不能同步（N 项待处理）` → 点开「怎么做（N 步）」，每条都写了**缺什么 / 去哪里 / 怎么验证**。
  按顺序做完，回来点「重新检查」，直到变成 ✓。

> 同一件事只在一处说：侧边栏不重复配置项，设置也不重复日常按钮。

红点只由真实差异派生：落后、未推送、推送失败、环境已切换。
尺寸 5×5、贴在图标左上角，`pointer-events:none` 不挡点击，颜色走主题变量。

### 显示名：`Msynchub`

侧边栏与设置里统一显示 **`Msynchub`**（`M` = Manta 品牌前缀 + 插件名），便于在多插件侧栏里一眼认出。
仓库目录、包名、插槽 id、API 路径仍是 `dsh-synchub`，**两者不要混** —— 改名只动两个插槽的 `label`
（`sidebar.panellist` 与 `settings.section`）与面板内的 `h2`，不碰任何标识符。

### 新用户引导（设置页顶部）

设置页最上方是一张「新用户从这里开始」卡，按 **第 0→4 步** 写完整流程：

| 步 | 内容 |
|---|---|
| 第 0 步 | 说清到底同步什么（DSH 自己的数据），以及**不**同步什么（插件、代码仓库） |
| 第 1 步 | 在 GitHub 建**两个空的私有**仓库，不勾 README / .gitignore / License |
| 第 2 步 | 填 HTTPS 地址（不用 SSH），保存后点「检查」 |
| 第 3 步 | 建 Fine-grained PAT，只给 Contents 读写；凭据进 Windows 凭据管理器 |
| 第 4 步 | 第一台「提交并推送」建基线，第二台「拉取并应用」；工作区路径必须完全一致 |

卡末还给出了 `install.ps1` 安装命令与**重启边界**（改 `client.js` 刷页面，改 `index.js` / `package.json` 必须完全重启）。
新用户不需要再去翻 README 或问人。

### 0.4 的面板重做（0.3 的实障）

0.3 的面板有三个真问题，0.4 一次改完：

| 问题 | 0.3 的表现 | 0.4 的做法 |
|---|---|---|
| **不能滚动** | 宿主 `.mainPanel` 是不滚动的 flex 列，插件根节点也没建滚动区，卡片一多就被裁在下面，② ③ 和操作记录根本看不到 | 根 `.dsc` 固定 `height:100%` + `min-height:0`，拆成固定头部 `.hd`（标题/状态/刷新）+ 滚动体 `.body`（`overflow-y:auto`）。头部不随内容滚走 |
| **看不清楚** | 待办提醒、开工检查、通道卡片三处把同一件事说了三遍；最要紧的一条埋在清单中间 | 顶部新增「下一步」头卡（大字 + 为什么 + 拆好的动作按钮）；与开工检查重复的提醒不再重复列出 |
| **要跑两处才能配** | 提醒里只说「设置 → Msynchub」，得自己去侧边栏翻设置 | 通道未配置时，面板里直接出现「先连上两个私有仓库」输入框，填完就地保存 |

另修了两处**数据自相矛盾**：

- `preflight.verdict` 之前取的是 `steps[0].title`，而 `remote` 步骤无论成功失败都叫「远端仓库已配置」——于是出现 `todo=2` 却显示「远端仓库已配置」。现在标题随状态变（`远端仓库还没配` / `远端仓库已配置`），`verdict` 变成「先处理：<第一个未完成步骤>」。
- `audit` 步骤的详情之前直接拼内部 id（`configRemote、sessionsRemote`），现在用中文 label（`配置通道远端仓库、会话通道远端仓库`）；`checkAll` 的每一项也都带上了 `label`。

颜色从写死的十六进制改成主题变量（`--dsw-alias-state-{error,warn,success}-primary`、`--dsw-alias-border-l2`、`--dsw-alias-bg-layer-1` 等，均带十六进制兜底），浅色/深色主题都不再出现对比度不足。

> 改了哪部分要重启：`lib/client.js` 刷页面即可；`lib/index.js` 与 `package.json` **必须完全重启 DSH**。

---

## 11. 首次配置

```powershell
# 1. 一个私有仓库（私有、空，不勾 README/.gitignore/License）
#    建议叫 dsh-msynchub —— 所有 DSH 状态都进这一个仓库

# 2. 装插件
& "C:\dsh\dw-plugin\install.ps1" -Only dsh-synchub

# 3. 完全退出 DSH 再打开，进 设置 → Msynchub，在「① 必做：仓库地址」填地址

# 4. 第一台：侧边栏点「立即同步」建立基线
# 5. 其它机器：装插件后在设置里填同一地址，侧边栏点「拉取并应用」
```

### 认证

**Git 认证请你自己搞定，本插件不接收、不存储、不转发任何凭据。**

本插件不预设你必须用哪种认证方式（HTTPS + PAT、GCM OAuth、SSH key 都行）；
只要本机的 git 能读写那个私有仓库，Msynchub 就能用——它会按 **DSH 当前已经配通的方式**
做一次真实连通性确认，不自己实现一套认证。

> 推荐装 [`dsh-gitok`](../dsh-gitok/README.md)：它的「设置 → Mgitok」能一键初始化，
> 并检查 Windows 凭据管理器、credential helper、明文凭据、代理、SSH 私钥口令等，给出修复命令。
> 不装也可以，自己配好一样用。
>
> 纠正一个以前的错误说法：本 README 早前写过“SSH 实测全被墙”。
> 查 gitok 的审计文档（`git-auth-audit-2026-11-12.md`）实际结论是：
> 失败的是 **Windows 侧 `https://github.com:443` 直连没配代理**，而不是 SSH 不通——
> 同一份文档还写了某台 WSL 上那把 SSH key 能用、说明 22 端口是通的。“SSH 全被墙”是过度概括，已改。

> **本机注意**：MinGit 的 schannel 后端在这里会报
> `SEC_E_NO_CREDENTIALS (0x8009030e)`，必须改用 OpenSSL：
> ```powershell
> git -C C:\dsh\dshplug config http.sslBackend openssl
> ```
> **网络是间歇的**：直连会 `Connection was reset`，代理（7897 确实在听）
> 会 `TLS connect error: unexpected eof while reading`，两边都可能挂。
> 当前仓库级没配代理；失败先重试 2~3 次，不要把单次失败当结论。
> 真需要代理时临时加回 `http.proxy`，用完可 `--unset` 删掉。

---

## 11.5 常见问题（2026-11-17 补充）

### Q1. 为什么配置和会话要两个仓库？能合并成一个吗？

**现在能合并了（0.10.0 起）。** 以前不做，是因为两个通道是**两个独立工作副本**，
把两个 `remote` 填成同一地址只会让第二个通道推同分支时落后/分叉，并不是真合并。
现在设置页选「单仓库」即可：一个地址、一个 `repos/all`、两个分组开关（ADR-036）。

仍然保留「双仓库」作为默认，因为它有两个真实价值：

- 体积/写入频率：`config` 几百 KB、改动少；`sessions` 几十 MB 且每次对话都在长，分开历史才不会把配置提交冲爆。
- **通道互相独立**：一个坏了另一个照样能救。

> 单仓库模式会失去这两个价值，换来的是「只填一个地址」。数据量不大时这个交易划算（你的原话：量不大）。
### Q2. 「空闲」到底怎么算？

**空闲 = 距上次对 Msynchub 面板/接口的手动操作超过 `idlePushMinutes`（默认 20 分钟）**，
并且同时满足：确实有本机改动、没落后远端、不在上次自动推送后的 5 分钟冷却期。

⚠️ **它不检测 DSH 会话里有没有正在跑的 agent/turn**——只按本插件收到的 HTTP 操作计时，
所以 agent 在后台干活、你没碰面板时仍会被判为空闲。`autoPush` 默认关闭。

### Q3. 插件是走「dshmanager」第三方吗？

**不是第三方，是 DSH 官方入口。** 位置：**设置 → 插件 → 添加插件**（界面上叫 dsh-market / 插件管理器）。
它支持三种来源：npm 包名、**Git 仓库地址**、本地目录路径。

本插件（Msynchub）**不是市场插件**，是自研 `link:` 插件——两者分工不同：
市场/插件管理器负责「装插件」，Msynchub 负责「同步 DSH 的数据」。

### Q4. 工作区为什么要填？我有多个工作区（dshplug、base）怎么办？

**该字段只用于体检提示，不影响同步。** 会话归属由 `$DSH_HOME/storages/workspace.json` 决定，不是这里填的路径。

0.5.3 起改成**工作区映射表**，一行一个工作区，每行两列：

| 列 | 含义 |
|---|---|
| **注册名** | DSH 里那个工作区的名字（`workspace.json` 的 `title`），**唯一、不区分大小写**。例：`dshplug`、`base` |
| **本地位置** | 留空 = 自动用 `<工作区根目录>\<注册名>`（默认 `C:\dsh\dshplug`）；也可手填任意路径 |

面板会实时对照三件事：你配的、DSH 真实登记的、本机路径存不存在，给出 `已对齐 / 路径不一致 / 未登记`。
面板里点 **「检查并自动填写」** 即可把 DSH 当前登记的**所有**工作区一次性带进来（注册名 + 真实路径都读自 `workspace.json`）——**纯数据读取，不涉及 AI、不猜路径**。已手填的路径会保留，不会被覆盖；填完看对照列，确认无误再点「保存」。

> 如果只想手动配几个，也可以「＋ 增加一行」逐行写。DSH 里登记了但你没填的仍会单独提示。

> 跨机约束不变：所有机器上这些走同步的工作区必须落在**完全相同的绝对路径**（ADR-002），
> 否则会话能搬过去但会归不到工作区（显示「未分组」）。

### Q5. 新主机怎么装？能直接给 git 地址吗？

**可以。** 但要注意：地址不是写死的，而是从本仓库实际 `git remote origin` 推导。
面板里三个地址都能点按钮复制（复制失败会明说「只是选中了，没进剪贴板」）：

```text
仓库根：      <你的 remote>           例如 https://github.com/you/dshplug.git
synchub 地址：<remote>#path:dsh-synchub
等价命令：    dsh plugin add <remote>#path:dsh-synchub
```

本机实测（本仓库当前 remote）：`https://github.com/mengfanchun2017/dswp-plugin#path:dsh-synchub`。
如果仓库没配 remote，面板会**直接说“无法给出 git 安装地址，请用本机脚本”**，不会编一个。

**为什么要带 `#path:dsh-synchub`**：dshplug 是多插件 monorepo，**仓库根不是 bundle**；
必须指定子目录，DSH 才能在那里找到 `dsh.bundle.patch`。

> ⚠️ 从 git 地址装前先确认远端已 `plugpush` 到你要的版本——否则装到的是远端旧版。
> 本机开发仍推荐 `install.ps1 -Only dsh-synchub`（`link:`，改代码即时生效）。

**推荐的新机安装路径（0.6.0 补充，对应「开发在 dshplug、其余机器走 git」的专业评估）**：

```powershell
# 1. 克隆整个插件仓到与单位机相同的位置（install.ps1 依赖这个布局）
git clone https://github.com/mengfanchun2017/dswp-plugin.git C:\dsh\dshplug
# 2. 装本插件（junction + link，与单位机完全一致）
& C:\dsh\dshplug\install.ps1 -Only dsh-synchub
# 3. 完全重启 DSH，然后 Msynchub 面板里点「拉取并应用」把数据拉下来
```

为什么**开发机用 `install.ps1`、新机器也用 `install.ps1`**（而不是 `dsh plugin add git地址`）：
1. `install.ps1` 是 link/junction 安装 —— dshplug 仓库本身就是插件的真身，
   `git pull` 一次就是「升级」，不需要重装；`dsh plugin add` 装的是拷贝，升级要走重装。
2. 新机器克隆 dshplug 后，还能拿到 `install.ps1` 本身、其余插件（gitok/larkcli…）、
   以及文档三件套 —— 这些不在 `#path:dsh-synchub` 的 bundle 里。
3. 双机「数据同步」（本插件管）与「插件代码分发」（dshplug 仓管）从此都是同一条 git 通道，
   只有一套心智模型：**上班机改代码 → `plugpush` 推 dshplug；回家机 `git pull` + `install.ps1`**。

> `dsh plugin add <remote>#path:dsh-synchub` 这条路仍然可用（DSH 官方入口，装的是子目录拷贝），
> 适合「只想装这一个插件、不要 monorepo」的第三方；自己两台机器不建议。

---
## 12. 已知限制

- **只面向 Windows**（`Windows\MinGit`、`$USERPROFILE\.dsh`）。
- 会话日志是 zstd 多帧，插件**不解压**——只按字节搬。解码仍由 DSH 自己做。
- 两台机器**不能同时**往同一通道推。落后的那台会拒绝推送并提示先拉；
  真分叉（两台各自推过）时面板会出现「分叉处理（二选一）」卡（0.6.0，ADR-030）。
- `--ff-only` 意味着**永不自动合并**（分叉时也是二选一而非三方合并，理由见 ADR-030）。
- 大文件没有 LFS：`MAX_FILE_BYTES` 200 MB，超过跳过并记入 `skipped`。
  本机最大会话 52 MB，够用。
- `dsh-market` 的插件同步与本插件**互相独立**，两者都在用不会有冲突（因为它们管的是不同目录）。

---

## 13. 0.2 → 0.3 迁移

1. 卸载 `chatsync`（已废弃）与 `dsh-config-manager`（若只用于同步）。
   **先确认** `dsh-config-manager` 里的加密备份还有用——那是独立的恢复手段。
2. 在 `dsh-config-manager` 里**取消勾选 `plugins` 分区**，
   避免它 `npm pack` 后重写 spec，和本仓库管理的插件清单打架。
3. 装 0.3，配好两个远端，第一台推一次基线。
4. 第二台拉取时，插件发现本地仓库已 `git init` 但还没有 `HEAD`，
   会自动走 **bootstrap**：把本地 `payload/`、`synchub/`、`.gitattributes`、
   `.gitignore` 移到 `backups/pre-bootstrap-<ts>/` 再对齐远端。

   > 这是开发中修掉的第四个 bug：早期只在「没有 `.git`」时才 bootstrap，
   > 于是「已 init 但空仓」的机器去 pull 会撞上
   > `untracked working tree files would be overwritten by checkout`。

0.2 的信标文件（`sync-beacon/<hostname>.json`）不再需要，可以删掉。
