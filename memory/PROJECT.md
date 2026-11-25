## 2026-11-25 归档：session-8f9b0b80-a48e-4115-9547-f56ff9b06358

- 工作区：dw-plugin
- 模型：deepseek-account/deepseek-flash

# 会话归档：B 机插件安装方式与 BOOTSTRAP 文档更新

## 结论与决策

1. **可以用 Git 地址安装**，不必先手动 clone 到固定路径。`dsh-plugin-manager` 的 `parseInstallSpec`（asar 内 `dsh-plugin-manager/lib/types/install-spec.js`）已实际验证可解析以下三种写法，均归为 `kind: 'git'`、host `github.com`：
   - `github:owner/repo#path:/<subdir>`
   - `.../dshplug#path:<subdir>`
   - `https://github.com/.../<repo>.git#path:<subdir>`
2. **两个插件同属一个 monorepo**：`C:\dsh\dw-plugin`，仓库 `dshplug`，分支 `master`，远端 `https://github.com/mengfanchun2017/dshplug.git`（公开仓库）。因是 monorepo，安装必须带 `#path:`。
3. **可直接粘贴的两个地址**（来自各自 BOOTSTRAP.md）：
   - gitok：`github:mengfanchun2017/dshplug#path:/dsh-gitok`
   - synchub：`https://github.com/mengfanchun2017/dshplug#path:dsh-synchub`
4. **安装命令形式**：`dsh plugin --profile desktop add '<地址>'`。前置条件：DSH 桌面版需先启动过一次、然后**完全退出**（`--profile web` 无此限制）。
5. **顺序问题（重要）**：用户原计划"先在 B 机装 gitok + synchub，再跑 `sync-plugins.ps1`"，与手册不符。`两机同步-操作手册.md` §4 Q2 明确 **gitok 在最后，不是最前**；以手册 7 步顺序为准。
6. **两条安装路线可共存**：GUI 路线 A 与 CLI 路线 B 均可，最后一次安装生效（`dsh-gitok/BOOTSTRAP.md` §1.3）。
7. **已知能力边界**：`dsh-synchub` 无法同步插件清单——`lib/index.js` 的 `surfaceEnabled()` 硬编码拒绝 `tier === 'danger'`。

## B 机权威顺序（手册 7 步）
1. 安装 DSH → 2. clone 两个仓库到 `C:\dsh\dw-plugin`、`C:\dsh\dw-base` → 3. 登录 GitHub → 4. 跑 `sync-plugins.ps1` → 5. 配 synchub → 6. 登录 gitok → 7. 重启。

注：`dw-base`（`dshwp-base`）为**私有仓库**，需认证；`dshplug` 公开。

`sync-plugins.ps1` 行为：还原 `inside\profile-manifest.json` → 用 `link:` 依赖执行 `pnpm install`，安装前校验 link 目标，并追加 `pnpm-workspace.yaml`。

## 待办
- [ ] **更新两个 BOOTSTRAP.md**（用户 2026-11-25 新需求）：在 `dsh-gitok/BOOTSTRAP.md`、`dsh-synchub/BOOTSTRAP.md` 中写入
  - 两插件的关系说明；
  - 如何把地址复制给 DSH 安装（含上述两个完整地址与 `dsh plugin ... add` 命令）；
  - 使该页可被搜索到、用户照 GitHub 上的 bootstrap 页即可装完；
  - 明确的"完成判据/勾选清单"，让用户知道工作已完成。
  - 状态：已提出，随后两次"继续"；**未见完成确认**。
- [ ] 清理仓库中残留的探针文件（仍未跟踪）：`_probe-anon1.txt`、`_probe-anon2.txt`、`_probe-empty.gitconfig`、`_probe-gitspec.txt`、`_probe-installspec.js`、`_probe-pm.txt`、`_probe-spec-test.txt`、`_probe-pnpm-git.log`、目录 `_probe-gitinstall\`（含 `.pnpm-store`）。

## 涉及文件路径
- `C:\dsh\dw-plugin\dsh-gitok\BOOTSTRAP.md`（§1.1 路线 A GUI / 路线 B CLI，§1.2 install.ps1，§1.3 两路线共存）
- `C:\dsh\dw-plugin\dsh-synchub\BOOTSTRAP.md`（§6.1 地址，§0.4 A/B 对比表，§0.5 家用机从零安装）
- `C:\dsh\dw-base\inside\两机同步-操作手册.md`（§2 脚本，§4 Q2 顺序）
- `C:\dsh\dw-base\inside\tools\sync-plugins.ps1`（参数 `-Export`、`-Check`、`-RepoRoot`、`-ManifestRel`）
- `C:\dsh\dw-base\inside\tools\安装命令.txt`（路线 B clone + pnpm-workspace.yaml + 14 插件 `dsh plugin add` 清单）
- `C:\dsh\dw-base\inside\profile-manifest.json`（14 deps / 15 bundles，2026-11-22；4 个 `link:` 指向 `C:/dsh/dw-plugin/dsh-*` 与 `C:/dsh/dw-base/demo-rag/dsh-rag`）
- `C:\dsh\dw-plugin\list.json`、`C:\dsh\dw-plugin\install.ps1`
- `~\.dsh\profiles\desktop\package.json`（A 机实际 profile，清单来源）

## 环境
DSH `0.2.2-rc.5`（ProductVersion 0.2.2.0），profile `desktop`，Windows。
## 2026-11-25 归档：session-5d7f6acf-4443-4428-b7dc-346d1c5654dd

- 工作区：dw-plugin
- 模型：deepseek-account/deepseek-flash

# synchub 整合归档

## 结论与决策
- 同步仓库不再保留“配置 / session”双仓库和开关，强制合并为**单一仓库**。
- 唯一同步仓库定为 **`dsh-msynchub`**（由原 `dsh-session` 改名）。
- GitHub 上的 **`dsh-config` 仓库删除**，并重新整理仓库结构。
- `dsh-msynchub` 作为 dsh 同步的唯一仓库；其他 session / 插件的同步也统一使用它。
- 仓库结构需专业设计，便于直接查看、理解备份内容。
- `dshplug` 已在 GitHub 改名为 **`dswp-plugin`**，相关配置与引用需整体更新。
- 用户后续更正：`dshwp-config` **不是**合并目标；相关仓库命名需与 synchub 配置对齐，属于检查更新，不是这些仓库本身有问题。
- 用户确认执行清理。

## 待办
- [ ] 将配置与 session 同步整合进 `dsh-msynchub`，设计清晰目录结构。
- [ ] 删除 GitHub 上的 `dsh-config` 仓库。
- [ ] 更新 `dswp-plugin`（原 `dshplug`）相关配置、引用和命名。
- [ ] 对齐 `dshwp-config` 与 `dswp-plugin` 在 synchub 中的设置位置，避免弄错。
- [ ] 按用户确认执行清理（旧仓库 / 旧配置）。
- [ ] 先查看 `session-85cb7c21-57a0-4ff5-8757-c1b61e8595ef` 对 synchub 的修改，再继续本 session 工作。
- [ ] 其他 session 也在加功能，改动前先列清正在做的内容，避免轻易修改文件。

## 待确认
- 各工作区的 `agent.md` 及其他记忆文件是否需要纳入 `dsh-msynchub` 同步。
- 若已开启其他 GitHub 同步，相关文件是否会在别处同步、从而不在 synchub 中重复处理。
- “清理”的具体范围（旧仓库、旧配置、旧引用）。

## 涉及对象
- 仓库：`dsh-msynchub`、`dsh-config`（待删除）、`dswp-plugin`（原 `dshplug`）、`dshwp-config`
- Session：`session-85cb7c21-57a0-4ff5-8757-c1b61e8595ef`
## 2026-11-25 归档：session-747966af-f5dd-467b-aaa3-a7712644b09e

- 工作区：dw-plugin
- 模型：deepseek-account/deepseek-flash

# 会话归档：dsh-synchub（Msynchub）

## 项目与边界

- 目标：`dsh-synchub`（显示名 `Msynchub`）功能完善 + 可开源发布；同时让 `dshwp-plugin`、`dw-base` 两个代码仓库纳入同步。
- 目录迁移：`C:\dsh\dshplug\dsh-synchub` → `C:\dsh\dw-plugin\dsh-synchub`；`C:\dsh\base` → `C:\dsh\dw-base`；仓库改名 `dshwp-base` / `dshwp-plugin`。
- **硬边界**：不由助手执行 `plugpush.ps1` / `install.ps1` / `git push` / `npm publish`。
- **生效方式**：改 `lib/index.js` 需完整重启 DSH；改 `lib/client.js` 只需页面刷新（Ctrl+R）。
- **禁止触碰** `dsh-getbrain`：不加 `.tmp-*` 的 gitignore 规则、不删其 `.tmp-*` 文件，`gn.py` 保持未提交状态（用户在另一个 session 处理中）。

## 已完成

1. **设置页空白** — 根因是 `lib/client.js`（约 967 行）缺一个逗号；已修复，并新增 `test/render-smoke.cjs` 作为回归防护。
2. **侧边栏重做为仪表盘** — 替代原来"还缺两个仓库地址"式教程文案；改为展示待同步/落后/待推送数量、自动同步状态与下次时间、手动操作按钮（立即同步 / 提交并推送 / 拉取并应用 / 重新检查）。用户确认"已经好了看着不错"。
3. **性能修复** — 旧 `/status` 10.5–15.5 s、`/preflight` 37.6 s、`/self-check` 42.7 s，前端 `getJSON` 30 s 超时导致请求被中断。引入 `fast` 路径与 `FETCH_TTL_MS = 8000` + `FETCH_CACHE`（缓存 Promise，并发请求共用一次网络往返）后，`/status?fast=1` 实测 **723 ms**。
4. **通道仓库整理** — 删除 `dsh-config` 里 2026-11-12 的旧 `snapshots/`（29 个文件，非本插件写入）；两个通道仓库分支统一到 `main`（原 config 为 `master`）。
5. **代码仓库同步能力** — 设置中可配置额外的代码仓库，侧边栏显示其状态并可手动同步；`dshwp-plugin`、`dw-base` 已接入。
6. **`dw-base` "无处提交（git 没有）"** — 已修复；用户确认"同步功能正常了"。
7. **侧边栏初次进入误报"未配置"** — 已修复，不再显示误导性的"刷新中/未配置"文案。
8. **Session 修复能力** — 依据 `session-7e2afa3c-...` 的故障过程，收敛为单一能力（见下决策）。
9. 相关改动已提交并推送（用户下达"提交"）。

## 关键结论与决策

- **session doctor 只做一件事**：报错时把 session 修到"可用"，其余（重复引用、空目录、归档等）交给专业 session 管理插件，不作为 synchub 的职责范围。
- **不重建** `default-workspace` 的 44 个 session 注册（用户明确"不用重建了，现在已经恢复了所需内容"）。
- **分支自适应**：`DEFAULT_BRANCH = 'main'` 仅作兜底；实际分支由 `branchOf()` 读 `.git/HEAD`（正则 `/^ref:\s+refs\/heads\/(\S+)$/`），远端用 `probeBranch()` 走 `git ls-remote --symref origin HEAD`。
- **未同步口径统一**：`unsynced = 仓库未提交 + 本机未暂存`。旧版用 `git status --porcelain -uno` 在两个空仓库上恒为 0，导致面板误显示"已对齐"（用户实际在 GitHub 看到空仓库），因此新增 `payloadMissing`（`!existsSync(payloadDir)`）来区分"零提交/从未暂存"。
- **`pending` 不在轮询里算**：扫全量文件 + 算指纹（sessions 可达 80 MB+）太贵，只在显式 `opts.scan` 时计算，否则置 `null`（表示"没查"，不假装 0）。
- **能省的是进程数，不是字节数**：Windows 上每次 git 调用固定 80–120 ms，与仓库大小无关；`codeRepoState` 控制在 2 次（最多 3 次）git 调用。

## 技术事实（已实测确认）

- `$DSH_HOME` = `C:\Users\franc\.dsh`，是 DSH 的家目录，**不是**插件工作目录；插件状态目录是 `C:\Users\franc\.dsh\dsh-synchub`，其下 `repos\{config,sessions}` 与 `payload/`。
- 同步模型：`$DSH_HOME` →（暂存）→ `payload/` →（commit/push）→ `origin`。
- 网络 git 开销：`ls-remote --symref` 3947 ms、`fetch origin --prune` 2766 ms；本地 `rev-parse` 130 ms、`status --porcelain -uno` 47 ms、`ls-tree -r` 45 ms、`log -1` 44 ms。
- 认证：MinGit 2.56.0.windows.4 + `wincred`；PAT 存于 Windows 凭据管理器 `LegacyGeneric:target=git:https://github.com`，`username=mengfanchun2017`，密码长度 40（经典 `ghp_`，非 GCM OAuth）。这正是家里新机器缺的那一环。
- `gitok` v0.3.11 提供 `gitok_bootstrap`（新机器一键修认证），另有 `doctor/list/verify/login/revoke/adopt/rotate/monitor`。
- Session 存储：`sessions\<munged-workspace-path>\<session-id>\session.v4.jsonl.zstd`；`.zstd` 是**多帧**（`session-7e2afa3c` 为 933 帧，1,738,834 B → 5,842,989 B / 1707 行）；`zlib.zstdDecompressSync` 只解第一帧，而第一帧恰是 `{"type":"session",...}` 头 —— 正好够做 header-only 读取。DSH 内置 Node 为 **v24.21.0**。
- 路径 munging：`--` + 盘符 + `-` 分隔 + `--`，例 `C:\dsh\dw-base` → `--C-dsh-dw-base--`。**反向解码不可靠**（`-` 与路径分隔符歧义），一律正向编码候选路径后比对。
- `workspace.json` 结构：`{unit, global:{initialized, defaultWorkspaceId, workspaceIds[], archivedSessionIds[], pinnedSessionIds[]}, tables:{workspaces:{<wsId>:{path, title, sessionIds[], createdAt, updatedAt}}}}`。
- 插件通过 `link:` 依赖挂载于 `C:\Users\franc\.dsh\profiles\desktop\package.json`。
- 校验用 bundled node：`C:\Users\franc\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，须裸跑（不要接管道），否则沙箱报 `\\.\pipe\LOCAL\...` EPERM。
- `.NET` 的 `[IO.File]::ReadAllText("相对路径")` 按进程 cwd 解析，不认 `Set-Location`，必须用绝对路径。
- `gh` CLI 未安装；GitHub API 走 REST `Invoke-WebRequest`，token 由 `git credential fill` 取，不打印。

## 待办

- `sessiondoctor-smoke.cjs` 测试（用户所说"任务7待处理"）。
- 侧边栏刷新节流：未到刷新时间就复用上次结果，并显示"上次检查时间"，与 20 分钟空闲策略合并简化。
- 设置中支持添加任意路径的代码仓库（非 `C:\dsh` 下），并在侧边栏显示与触发同步。
- 解释项（已答但可沉淀进 README/Bootstrap）：`C:\Users\franc\.dsh` 是什么；`dw-base` 曾误报"同步成功"的原因。
- 新机器 Bootstrap 文档（家用机安装 synchub + gitok + 拉取 `dshwp-plugin`/`dw-base`）。

## 涉及文件路径

- `C:\dsh\dw-plugin\dsh-synchub\lib\index.js`（`VERSION = '0.5.9'`，`inject = ['webServer']`，18 条路由）
- `C:\dsh\dw-plugin\dsh-synchub\lib\client.js`
- `C:\dsh\dw-plugin\dsh-synchub\test\render-smoke.cjs`（另有多份 smoke 脚本）
- `C:\Users\franc\.dsh\profiles\desktop\package.json`
- `C:\Users\franc\.dsh\workspace.json`
- `C:\Users\franc\.dsh\dsh-synchub\repos\{config,sessions}`
- `C:\Users\franc\.dsh\sessions\<munged>\<session-id>\session.v4.jsonl.zstd`
- `C:\dsh\dw-base`、`C:\dsh\dw-plugin`
