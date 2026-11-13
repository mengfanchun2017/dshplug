# dsh-synchub 架构决策记录（ADR）

> 本文件是 `dsh-synchub` 及其配套仓库 `dshplug` 的**设计决策总账**：记录「为什么这样设计」、
> 不可从代码反推的约束、实测发现，以及明确暂缓的功能。
> 决策按时间倒序追加，不删改旧条目；要推翻旧决策就新增一条并标注「取代 ADR-XXX」。
>
> 详细论证与原始证据放在 [`docs/`](./docs/)：
> - [`docs/chatsync-architecture.md`](./docs/chatsync-architecture.md) — 放弃的会话同步插件 chatsync 的深度剖析与自研可行性评估（2026-11-12）
> - [`docs/session-storage-faq.md`](./docs/session-storage-faq.md) — 存储位置 / 未分组 / 合并行为 FAQ（实测）
> - [`docs/session-migration.md`](./docs/session-migration.md) — 会话存储与迁移手册
>
> 本 ADR 与 `README.md` 的分工：README 讲「现在怎么用」，本文件讲「为什么这么定、哪些坑别再踩」。

---

## ADR-001 · dsh-synchub 0.3：用一套引擎同步 DSH 状态，插件源码另管

- **日期**：2026-11-12
- **状态**：已采纳
- **背景**：0.2 只是转发层（会话交给 chatsync、配置交给 dsh-config-manager），两个插件各自实现一遍搬运逻辑，
  冲突裁决与跳过活会话规则不一致；`dsh-config-manager` 的 `localPluginPack` 会把 `link:` 插件 `npm pack`
  成 tarball 并在导入时把 spec 重写成本机绝对路径，与 `dshplug` 仓库管理的插件清单互相打架。
- **决策**：
  1. 会话日志、工作区登记表、附件、技能文件、DSH 配置层，全部由 `dsh-synchub` **一个引擎**同步，只有一套规则、一份历史、一个面板。
  2. 分 `config` / `sessions` **两个独立私有 Git 仓库**（体积与写入频率差异大，避免互相冲爆提交历史）。
  3. 同步面分 `safe` / `caution` / `danger` 三级，danger 是硬约束（`surfaceEnabled()` 直接排除），不可开启。
  4. 推之前先 `fetch` 判落后 → 再 `commit` → 再 `push`；落后就拒绝而不是制造分叉。拉取用 `merge --ff-only`，永不 rebase / force。
  5. 覆盖与删除前一律备份到 `$DSH_HOME/dsh-synchub/backups/<ts>/`；`prune` 默认关闭；`DSH_SESSION_ID` 指向的活会话跳过。
  6. **插件源码不归本引擎**：由 `dshplug` 仓库 + `install.ps1`（`link:` Junction）+ `plugpush.ps1`（显式 commit/push）管理，
     由 `dsh-market` 管安装。`dsh-synchub` 明确排除 `profiles/desktop/package.json`（含 `link:C:/dsh/...` 绝对路径，跨机会让 DSH 起不来）。
- **理由**：见 `README.md` 第 1~5 节与 [`docs/chatsync-architecture.md`](./docs/chatsync-architecture.md) 第五节——
  用户真实用法是**接力式同步**（A 做完 B 接着做），不是并发合并；chatsync 80% 复杂度花在并发合并上，
  本引擎用「远端时间戳 + ff-only」把代码量压到接力覆盖模型，冲突时保留 backup 分支。
- **后果**：两台机器**不能同时**往同一通道推；`--ff-only` 意味着永不自动合并会话 JSONL（刻意，自动合并只会产生坏数据）。

---

## ADR-002 · 跨机工作区必须落在完全相同的绝对路径

- **日期**：2026-11-12（调研结论见 [`docs/session-storage-faq.md`](./docs/session-storage-faq.md) 第 4 节）
- **状态**：已采纳
- **背景**：会话有三处硬绑定绝对路径，任一不一致都会出问题：
  1. `sessions/<编码目录>/` 的目录名 = 工作区绝对路径编码（`C:\dsh\workspace1` → `--C-dsh-workspace1--`）；
  2. `storages/workspace.json` 的 `tables.workspaces[id].path`；
  3. 会话头部 `cwd`（`WorkspaceRegistry.attachSession()` 用 `realpath` 规范化后与 `record.path` 严格比较，不等就过滤掉）。
- **决策**：A、B 两台机器把工作区放在**逐字符相同**的绝对路径（例如都 `C:\dsh\workspace1`）。
  不采用「在 B 上用 junction 造出 A 的旧路径」，也**不改写 zstd 日志里的 cwd**（多帧压缩，风险高）。
- **理由**：路径一致时三处天然一致，零改造、零风险；chatsync issue #10/#21 里作者也承认「工作区映射还没做」，
  相同路径是唯一绕开该缺口的方法。
- **后果**：`config.json` 里的 `workspace` 字段只用于体检（检查该路径在本机存在），**不参与同步面路径改写**；
  路径不同的机器接入会看到会话归到「未分组」或打开报 `working-directory: directory does not exist`。

---

## ADR-003 · `workspace.json` 的导入是并集合并，不是整文件覆盖

- **日期**：2026-11-12
- **状态**：已采纳
- **决策**：跨机合并时，`workspaceIds`、`workspaces` 各条 `sessionIds`、`archivedSessionIds`、`pinnedSessionIds`
  一律取**并集**；`path` 按目标机真实路径改写；`defaultWorkspaceId` 不参与匹配（工作区身份是 UUID，不是 `title="default"`）。
- **理由**：整文件覆盖会丢掉 B 本机其它工作区、归档、置顶与排序；DSH 自身 `bootstrap()` 也是按 session 头部 cwd 做归并而非清空。
- **后果**：`prune` 必须显式传参才删——「远端没有」既可能是 A 删了，也可能是 A 还没推。

---

## ADR-004 · DSH 会话（Session）存储结构实测记录

- **日期**：2026-11-12（本次会话实测 + `app.asar` 内实现源码核对）
- **状态**：记录性条目（不产生代码变更）
- **实测环境**：
  | 项 | 值 |
  |---|---|
  | DSH 版本 | `0.2.2-rc.1`（CLI `dsh --version`），Desktop 安装 ProductVersion `0.2.2.0` |
  | 更新通道 | `nightly`（`resources/app-update.yml` → `https://download.deepseek.com/dsh-desk/feeds/win-x64/`） |
  | 安装形态 | per-user：`C:\Users\franc\AppData\Local\Programs\DeepSeek Harness`（HKCU 卸载项） |
  | DSH_HOME | `C:\Users\franc\.dsh`（`DSH_HOME` 环境变量与默认值一致） |
  | profile | `desktop`（桌面端自动注入，复用即可，不需新建） |
  | 机器 | `FRANCIS-HOME-I7` |
  | Node（启动日志） | `24.21.0` |

### 4.1 会话正文的物理结构

```
$DSH_HOME\sessions\
    <工作区绝对路径编码>\            ← 例 --C-dsh-dshplug-- / --C-Users-franc-Documents-deepseek-harness-default-workspace--
        <sessionId>\                 ← 随机 UUID，或 session-<uuid>
            session.v4.jsonl.zstd  ← zstd 多帧压缩的 JSONL 事件日志（不能单次解压、不能文本编辑）
```

- 目录名规则：把工作区绝对路径里的 `:` `\` `/` 换成 `-`，首尾各加 `--`。
- `sessionId` 是随机 UUID，跨机碰撞概率可忽略 → 拷目录天然是**并集叠加**。
- 附件是 `$DSH_HOME\attachments\v1` 下全局 sha256 内容寻址池，引用与路径无关，整目录搬即可。

### 4.2 目录可按日期排序（本次确认）

`session.v4.jsonl.zstd` 的 `LastWriteTime` 就是该会话最后一次写入时间，因此
**按目录/文件的修改时间排序 = 按会话活跃时间排序**，可以作为「哪些会话旧、哪些该留存」的直观依据。

本机 2026-11-12 实测：共 **75 个** session 目录，时间跨度 `2026-10-09 14:13` → `2026-11-12 14:33`。

| 月份 | 数量 |
|---|---|
| 2026-10 | 33 |
| 2026-11 | 42 |

按日期（活跃日）：

| 日期 | 数量 | 日期 | 数量 |
|---|---|---|---|
| 10-09 | 6 | 11-06 | 1 |
| 10-16 | 1 | 11-07 | 3 |
| 10-20 | 1 | 11-09 | 10 |
| 10-21 | 1 | 11-10 | 13 |
| 10-26 | 14 | 11-11 | 5 |
| 10-27 | 5 | 11-12 | 10 |
| 10-28 | 1 | | |
| 10-29 | 1 | | |
| 10-30 | 3 | | |

按工作目录（slug）聚合：

| 数量 | slug |
|---|---|
| 52 | `--C-Users-franc-Documents-deepseek-harness-default-workspace--` |
| 7 | `--C-skill--` |
| 3 | `--C-dsh-dshplug--` / `--C-dsh-ragdemo--` |
| 2 | `--C-dsh-mantaplugin--` / `--C-dsh-workspace1--` |
| 1 | `--C-dsh-agent--`、`--C-dsh-agentdemo--`、`--C-dsh-dsh-getbrain--`、`--C-dsh-dsh-larkcli--`、`--C-dsh-plug-getnote--`、`--C-dsh-plug-larkcli--` |

> 注意：目录名里的旧工作区（`--C-dsh-plug-*-`、`--C-dsh-agentdemo--` 等）是历史遗留，
> 在 `workspace.json` 里已无对应登记 → 这些会话是「未分组」孤儿。这与
> [`docs/session-storage-faq.md`](./docs/session-storage-faq.md) 第 2 节的 35 个孤儿结论一致。

### 4.3 归档与归属不是文件，是 `workspace.json` 里的 id 数组

`$DSH_HOME\storages\workspace.json`（`unit.name=workspace`, `version=2`）：

```jsonc
"global": {
  "workspaceIds": [...],
  "archivedSessionIds": [ ... ],   // 归档 = 一组 session id，默认视图隐藏；不移动文件、不删除
  "pinnedSessionIds": [ ... ]     // 置顶，最近置顶的在前
},
"tables": {
  "workspaces": {
    "<workspaceId>": { "path": "...", "title": "...", "sessionIds": [ ... ] }  // 决定「在哪个工作区能看到」
  }
}
```

- **归档 = 把 sessionId 加进 `archivedSessionIds`**，同时清掉该会话的置顶；不改变它属于哪个 workspace；
  归档行置灰、不可打开，但可重命名/分叉/取消归档。源码：Workspace 注册表文档与 `ArchivedSessionGate`。
- **「未分组」不是存储**，是 `workspaceId === ""` 的 UI 派生桶：会话存在但没登记进任何 `sessionIds` 就落进去。
- 删除工作区 ≠ 删除会话，只是删注册记录，会话全部掉进「未分组」。
- 本机当前 `archivedSessionIds` 约 40 条、`pinnedSessionIds` 2 条、7 个工作区、约 35 个已登记会话。

### 4.4 关键结论：只删 `.zstd` 文件 ≠ 删除会话

这是本次最容易误解的一点，**明确记录**：

- 删掉 `sessions\...\<id>\session.v4.jsonl.zstd` 只是删正文。`workspace.json` 里
  `archivedSessionIds` / `pinnedSessionIds` / 各 workspace 的 `sessionIds` 仍引用这个 id，
  列表会留下**悬空引用**（打开报错 / 被当作空白新会话复活），磁盘与注册表不一致。
- 还有 `storages/session_projcache/` 的投影缓存（标题、cwd）和搜索索引需要对账。
- 因此「删一个会话」至少要同时改：物理目录 + `workspace.json` 的四处引用 + 投影缓存 + 搜索索引，
  且必须在 **DSH 完全退出**时做（运行时改会被内存状态回写覆盖）。
- **GUI 明确不提供会话删除**（源码原文：「没有 Session 删除：会话可以归档但绝不会被删除」）。
  底层 ACP 有 `session/delete`，但那是协议/内部生命周期用，不是暴露给用户的动作。

---

## ADR-005 · 会话不手动删除；删除能力后续以功能实现

- **日期**：2026-11-12
- **状态**：已采纳（结论）/ 待实现（功能）
- **决策**：
  1. **不手工删会话文件**。日常「收起」一律用 GUI 的归档（可逆、有撤销），归档是设计上唯一的收起手段。
  2. 物理清除若确有必要，**必须做成 `dsh-synchub` 的一个受控功能**，而不是命令行手删。
  3. 该功能必须：先全量备份 → 校验会话静止（无运行中 turn / subagent / job / schedule）→
     一次性改「正文目录 + `workspace.json` 四处引用 + projcache + 搜索索引」→ 重启验收 → 保留回滚点。
  4. 在功能落地前，任何「按日期批量清理旧会话」的冲动都先用归档 + 视图筛选解决，不碰磁盘。
- **理由**：手工删会留下悬空引用与索引不一致（ADR-004 §4.4）；归档本身零成本且可逆；
  删除是不可逆操作，理应由工具统一保证原子性与备份，而不是靠人记得改几个文件。
- **后果**：`dsh-synchub` 的 `prune` 语义目前只作用于「同步镜像里远端已删的文件」，
  **不等于**「删 DSH 会话」；两者不要混用。后续功能建议单独命名（如 `purgeSession`）并默认二次确认。

---

## ADR-006 · 会话无法移动；用「知识持久化」替代，移动功能后续评估

- **日期**：2026-11-12
- **状态**：已采纳（结论）/ 待评估（移动功能）
- **背景**：GUI 没有「移动会话到别的工作区」。会话归属由**创建时的工作目录 cwd** 决定且不可变：
  `session.create` 复用/创建时校验「属于请求的目录」，跨目录报 `session/conflict`；
  fork 复制源会话的 `cwd`；`attachSession()` 要求 `cwd` 与 `record.path` 严格相等。
  Workspace 只是把「某目录下的 sessionIds」记一份分组账，拖拽排序改的是显示顺序，不是归属。
- **决策**：既然搬不动，就不搬。把旧会话里**确定的结论**持久化成文档，让新工作区/新会话能直接读到，
  而不是试图把历史对话搬过去。两种载体：
  1. **设计决策类 → ADR / 文档**：像本文件一样，写进插件仓库（或对应工作区目录），随 `dshplug` 仓库走版本、随 git 同步。
     本 ADR 与 `docs/` 三份调研就是这种载体的第一个实例。
  2. **过程性结论 → 会话 compact 输出**：评估见下。
- **「把 compact 输出存进工作区」是否需要 —— 评估结论：需要，但定位为「人工蒸馏文档」，不是自动导出**

  | 维度 | 判断 |
  |---|---|
  | DSH 有没有 compact | 有。`/compact` 命令（`dsh-command-compact`）与自动压缩（`dsh-compaction-basic`）都真实存在，成功时把选定历史替换为一条 `compaction/summary` 事件，摘要内容块写入会话日志（`data.summary[]`，可选 `rawOutput[]`）。 |
  | 能不能直接当文档用 | **不能直接当**。它是「给模型继续用的上下文摘要」，不是给人看的决策记录；且写在 zstd 压缩日志里，取出来要逐帧解码。 |
  | 是否值得做 | **值得，但要人工把关**。对「耗时几小时、结论零散、无法再写一遍」的会话，让模型输出一份结构化 Markdown（决策 / 结论 / 待办 / 文件路径 / 未解决问题），存进对应工作区（例如 `<workspace>/docs/session-notes/` 或仓库 `docs/`），提交进 git。这是**人对内容负责**的蒸馏，不是把压缩摘要原样 dump。 |
  | 与 ADR 的关系 | 二者互补：ADR 记「稳定的、要长期遵守的决策」；session-note 记「一次会话的事实与过程」。ADR 是主，session-note 是辅。**不要**把自动 compact 输出直接当 ADR。 |
  | 自动化程度 | 暂不做自动导出。原因：摘要面向模型、可能含无关细节或敏感路径；且「哪些算确定结论」需要人判断。先保持人工：会话结束前让模型整理成一份文档，由你确认后落盘。 |
  | 与同步的关系 | 这些 Markdown 落在**工作区文件**里，由工作区自己的 git 仓管理；`dsh-synchub` 不搬工作区文件（只搬 `.dsh` 状态）。因此它天然跨机可见，不依赖会话迁移。 |

- **移动功能**：后续视真实需求再开发。若要做，必须同时解决 cwd 改写（zstd 多帧解码→改 JSONL→重压）
  + `session_projcache` 的 `cwd`/`workingDirectory`/`identity.path` + `workspace.json` 归属 + 物理目录重命名，
  风险高；在「相同绝对路径」（ADR-002）与「知识持久化」两条替代路径够用之前，不投入。
- **后果**：本仓库形成约定——**重要结论写进文档并 commit，不指望靠翻旧会话找回**。
  `dsh-synchub/docs/` 与 `dsh-synchub/ADR.md` 就是这条约定的落地示例。

---

## ADR-007 · `dsh-*` 子目录不再各自带 `.gitignore`，统一由仓库根管理

- **日期**：2026-11-12
- **状态**：已采纳
- **背景**：`dsh-getbrain/`、`dsh-larkcli/`、`dsh-pixel/` 从各自原仓库并入 `dshplug` 时，
  把原仓库的 `.gitignore` 一起带了进来（git 残留）。这些文件已被根仓库跟踪，
  内容互相重复且部分规则（`config.local.json`、`_native-config/`、`*.exe`）本该由根规则统一覆盖。
  根目录必须保留 `.git` / `.gitignore` / `.gitattributes`（它们是 `dshplug` 仓库本身，不是残留）。
- **决策**：删除三个子目录里的 `.gitignore`，把其中**仍然有效且根规则没有**的排除项合并进根 `.gitignore`；
  同步更新引用了「子目录 .gitignore」的文档措辞。
- **理由**：单一仓库只应有一套忽略规则；多份 `.gitignore` 容易出现「这个文件到底被谁挡住」的误判，
  也是 merge 残留最容易藏污纳垢的地方。
- **后果**：子目录不再是「看起来像独立 git 仓库」的形态。`gn.py` 的 `PORTABLE_FILES` 去掉 `.gitignore`，
  改为打包时用 `PORTABLE_GITIGNORE` 动态写入 `getnote/.gitignore`，导出包仍自带凭据保护；
  各 README / 脚本里「`.gitignore` 已排除」的措辞统一改为「仓库根 `.gitignore`」。
- **验证**：`check-ignore` 确认 `_native-config/appsecret.txt`、`lark-cli.exe`、`config.local.json` 仍被挡；
  `config.example.json` / `settings.example.json` / `gn.py` 未被误伤；`gn.py` AST 校验通过；仓库内只剩根 `.git`。
---

## ADR-008 · 自研插件当前全部本地加载，不发布到插件市场

- **日期**：2026-11-12
- **状态**：已采纳（当前阶段）
- **实测**：`C:\Users\franc\.dsh\profiles\desktop\package.json` 的依赖分两类——
  - **本地源码（`link:` Junction）**：`dsh-synchub`、`dsh-getbrain`、`dsh-pixel`、
    `@local/dsh-preview-editor`、`dsh-rag`，全部指向 `C:\dsh\dshplug\...` 或工作区目录；改源码即时生效，不经过 npm。
  - **市场/线上包（版本号）**：`dshmarket`、`billion-context`、`dsh-better-sidebar`、`dsh-context`、`dsh-mobile`、
    `@muxiuesd/dsh-pixel-studio`、`dsh-connect-trae`、`dsh-connect-workbuddy`、`dsh-better-edit`，由 `dsh-market` 管安装与升级。
  四个自研包的 `package.json` 全部 `private: true`，**未发布**；`dsh-synchub` / `dsh-pixel` 还锁了
  `engines.dsh: >=0.2.0-rc.1 <0.3.0-0`，与本机 DSH `0.2.2-rc.1` 匹配。
- **决策**：
  1. 现阶段**不从插件市场安装自研插件的线上版本**，就用 `dshplug` 仓库 + `install.ps1`（`link:`）+ `plugpush.ps1`（显式推）管理。
  2. 两类包互不替换：`dsh-synchub` 明确不同步 `profiles/desktop/package.json`（danger 级），
     因此第二台机器必须**各自跑一次 `install.ps1`** 生成本机依赖声明，不能靠同步搬过去。
  3. 升级 DSH 大版本后，先检查 `engines.dsh` 范围再决定是否 bump；0.x 的 caret 不跨 minor。
- **理由**：`link:` 规格把绝对路径写进 profile，跨机不可搬运，所以「市场安装 + 本地源码」不能混在同一条依赖上；
  本地开发期 `private: true` 也避免误 `npm publish`。
- **若将来要发布**：需（a）去掉 `private`、选定不与现有包冲突的 scoped 名（npm 上 **`dsh-pixel` 已被他人占名**，
  现为 `dsh-pixel@0.0.1` 作者 dushaobindoudou，与本地 `dsh-pixel@0.1.0` 无关）；（b）把依赖从 `link:` 改成版本号；
  （c）在另一台机器用 `dsh plugin add <包名>` 装线上版。发布后要同步更新 `list.json` 的版本字段并保留 `-Tag` 习惯。
- **后果**：本地改代码 → 即时生效；要让第二台拿到 → `plugpush.ps1` 推 + 第二台 `git pull`；
  「市场里有同名包」不代表装的是你的版本，务必以 profile 里的 `link:` / 版本号为准。

---

## ADR-009 · 命令行 bootstrap：先手工打通多终端同步，脚本不再按 status 过滤

- **日期**：2026-11-12
- **状态**：已采纳（已实现）；操作手册见仓库根 [`BOOTSTRAP.md`](<../BOOTSTRAP.md>)
- **背景**：
  1. 用户误以为 DSH 聊天框里 `!` 能执行 shell 命令（那是 Claude Code / aider 的习惯）。源码级核实：
     `app.asar` 里 `startsWith("!")` 只用于「实验标志取反」与 glob 否定，**DSH 无 `!` 命令前缀**；
     真正跑命令的是右侧栏「终端」标签（`dsh-client-ui-sidebar-terminal`），默认 shell = PowerShell，
     cwd = 会话工作目录。仓库脚本是 `.ps1` 不是 `.sh`。
  2. `plugpush.ps1` 原先用 `Where-Object { $_.status -eq 'active' }` 过滤要推的目录，
     导致 `status: dev` 的 `dsh-larkcli` 与根级文件（`.gitignore` / `README.md` / `BOOTSTRAP.md` 等）
     永远同步不出去 —— 本次清理 git 残留恰好踩到。
  3. `install.ps1 -Check` 的汇总用 `$_.name`（清单名）去查 `Get-InstallState`，
     而 profile 里按**包名**声明依赖；当时 `dsh-getbrain` 的包名（`@local/getnote-organize`）与目录名不一致，
     于是明明装好了却报 `missing`「1 个插件尚未安装」。
- **决策**：
  1. `plugpush.ps1` **不看 status**：`list.json` 登记过的目录全推（含 dev）；
     另显式收集根级文件清单 + 对「仓库根直接子文件」做兜底，保证根 `.gitignore` 等不漏。
     `status` 只归 `install.ps1` 用来决定「装不装」，不决定「推不推」。
  2. `install.ps1 -Check` 汇总改用 `packageName`（无则 `name`）；`dev` 插件显示 `missing` 属正常，不计入汇总。
  3. 多终端同步链路固定为：`install.ps1`（本机注册 `link:`）→ 改源码（即时生效）→
     `plugpush.ps1 -All "msg" -DryRun` 预览 → `plugpush.ps1 -All "msg"` → 另一台 `git pull --ff-only` + `install.ps1`。
     默认**不自动上行**，也不依赖 `dsh-synchub` 的自动同步（那是后续插件内容）。
  4. 不向第二台同步 `profiles/desktop/package.json`（danger 级，含 `link:C:/dsh/...`）；
     每台机器各自跑 `install.ps1` 生成声明。
- **理由**：`status` 是「安装状态」而非「发布范围」；清单主键、目录名、npm 包名是三个层次，
  混用会同时造成「漏推」与「误报」。把这两处改掉后，`-DryRun` 能完整反映待发布内容，
  `-Check` 全绿才真正代表可用。
- **反面代价**：`-All` 现在会 stage 一个插件目录下的**所有**改动（包括别人/上一次未提交的改动），
  因此 `BOOTSTRAP.md` 强制要求先跑 `-DryRun` 看清单；整目录 stage 也意味着无法只发该插件的一部分文件。
- **已否决的替代方案**：
  - 按 `status` 加白名单（继续漏 dev）→ 否决；
  - 把根级文件写进 `list.json` 当成一个伪插件 → 破坏清单语义，否决；
  - 用 `git add -A` 一次全提交 → 会把本机临时改动与归档区一起推上去，否决。
- **验证**：`plugpush.ps1 -All -DryRun` 输出含 `dsh-larkcli`、`.gitignore`、`BOOTSTRAP.md`；
- **验证**（ADR-009 当时）：`plugpush.ps1 -All -DryRun` 输出含 `dsh-larkcli`、`.gitignore`、`BOOTSTRAP.md`；
  `install.ps1 -Check` 输出「全部为 link: 形态且已安装」；两个脚本 PowerShell 语法解析通过。
  （后续：执行策略与编码问题见 ADR-010。）

---

## ADR-010 · `.ps1` 必须带 UTF-8 BOM；包名统一为 `dsh-getbrain`

- **日期**：2026-11-12
- **状态**：已采纳（已实现）
- **背景**（两个独立问题，同一轮暴露）：
  1. **执行策略 + 编码**：DSH 右侧终端开的是 **Windows PowerShell 5.1**，其 `LocalMachine` 执行策略为
     `Undefined`（默认 Restricted），因此 `plugpush.ps1` 报「在此系统上禁止运行脚本」；
     而本机 `pwsh` 7 的 `LocalMachine` 是 `RemoteSigned`，所以工具里能跑、用户那里不能。
     进一步：脚本是 **UTF-8 无 BOM**，5.1 按系统 ANSI(GBK) 解码 → 中文全变乱码，
     且 `<包名>` 里的 `<` 被当成重定向符 → 直接语法错误。
  2. **历史包名**：`dsh-getbrain` 目录的 `package.json` 叫 `@local/getnote-organize`，
     靠 `list.json` 的 `packageName` 桥接，导致名字三层次（目录 / 包名 / 清单名）不一致。
- **决策**：
  1. 仓库内 `.ps1` 统一加 **UTF-8 BOM**（`EF BB BF`）；5.1 与 pwsh 7 都正确识别，不动任何一行代码。
  2. 不改系统全局执行策略；调用方式二选一（写进 `BOOTSTRAP.md` §0.3）：
     - 当次终端临时放开：`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`
     - 或用 `powershell -NoProfile -ExecutionPolicy Bypass -File <脚本> …`
  3. 包名统一为 **`dsh-getbrain`**（目录名 = 包名 = 清单 name）；删除 `list.json` 的 `packageName`。
     同步修改：`package.json` 的 `name`、`cordis.patch.yml` 的 `name:`、`client.js` 的 `__ModuleLoader__` `id`、
     `SKILL.md` 的 name，以及全部文档。**改名后必须重装**：先 `install.ps1 -Only dsh-getbrain`，
     再 `dsh plugin remove @local/getnote-organize` 清旧包（`dsh plugin remove` 只删声明、常留 Junction，
     需手动删 `node_modules/@local/getnote-organize`）。
  4. **不变的部分**：工具名 `getnote_*`、路由 `/plugins/getnote/*`、配置命名空间 `getnote`、
     数据目录默认位 `C:\dsh\data-<短名>` 全部保留——它们是产品功能名而非包名，
     改了会破坏已保存的配置与凭据。
- **理由**：BOM 是唯一既让 5.1 正确解码又不改代码的办法；包名统一后 `packageName` 桥接失去意义，
  继续保留只会让「三个名字」继续分歧。
- **反面代价**：改名会断开旧 `link:`，**已装机器必须重跑 `install.ps1` + 清旧包**；
  任何记录旧包名的外部引用（截图、旧文档、别的机器未更新的 clone）会暂时对不上。
  另：`.ps1` 加 BOM 后，某些只认纯 UTF-8 的工具（罕见的 lint）可能报第一条字符异常。
- **已否决的替代方案**：
  - 把脚本改名为 `.cmd` 包装器 → 多一层维护，且丢失 `-List/-Check` 等参数传递便利；
  - 把中文全改成英文以避开 ANSI 问题 → 用户环境是中文，报错信息变英文反而难用；
  - 继续保留 `@local/getnote-organize` → 用户明确要求去掉历史包名。
- **验证**：PS 5.1 下 `plugpush.ps1 -List` / `install.ps1 -Check` 中文正常、`exit=0`；
  `install.ps1 -Check` 全绿；Junction 目标为 `C:\dsh\dshplug\dsh-getbrain`；
  旧 `@local/getnote-organize` 已从 profile 移除（14 packages）；`node --check` 两个 JS 通过。

---
## 待办 / 后续候选（未形成决策，仅登记）

| 议题 | 触发条件 | 备注 |
|---|---|---|
| `purgeSession` 受控删除功能 | 归档项多到影响使用、或确需 GDPR 式清除 | 见 ADR-005，必须备份 + 原子改多处 |
| 会话移动 / cwd 改写 | 工作区必须换路径、且无法用相同路径（ADR-002）解决 | 见 ADR-006，风险高，优先级低 |
| compact 输出自动蒸馏为文档 | 人工蒸馏被证明太麻烦 | 需先定义「什么算确定结论」的模板与人工确认闸门 |
| 同步面板接入真实状态 | `dsh-synchub` 配好两个远端后 | 当前 `~/.dsh/dsh-synchub/` 状态目录尚未初始化，见 README 第 11 节 |
| 自研插件是否发布到市场 | 需要在第二台机器之外分发时 | 见 ADR-008：当前全部 `private: true`，靠 `link:` + git 仓库分发；npm 上 `dsh-pixel` 已被他人占名 |
