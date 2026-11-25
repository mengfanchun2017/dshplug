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
> 三份文档分工：[`README.md`](./README.md)=怎么用；[`BOOTSTRAP.md`](./BOOTSTRAP.md)=怎么做（安装/验证/排错/迁移/命令行）；本文件=为什么（决策+反面代价+已否决方案）。
> 开源说明：文中 ADR-004/008 的 `C:\Users\franc`、`FRANCIS-HOME-I7` 等是原作者本机实测样例（证据快照），非代码硬编码；**代码中的机器名取 `os.hostname()`、DSH_HOME 取环境变量/默认推导，无任何写死路径**。ADR-016 的 `RedmiPro` 同理。

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

## 附 · 2026-11-16 退役修正（针对 ADR-007 / ADR-008 的过期描述）

- `dsh-pixel` 已于 **2026-11-16 退役**，改用市场插件 `@muxiuesd/dsh-pixel-studio`。
  上文 ADR-007「从各自原仓库并入的插件」、ADR-008「本地源码 `link:` 清单」里提到它的地方
  **按当时的事实保留**，但现状已变：
  - 它**不再**是 `link:` 依赖，也已从 desktop profile 的 `dependencies` / `dsh.profile.bundles`
    和 `list.json` 中摘除；
  - 源码、产物与决策记录收进 `C:\dsh\dshplug\archive\dsh-pixel\`；
  - 因从未提交过 git，`git pull` 到第二台**不会**再得到它。
- **ADR-007 的结论仍然成立**：三个子目录的 `.gitignore` 已删、根规则已统一，退役不影响这条。
- **ADR-008 的结论也仍然成立**：自研插件继续 `link:` + 本地管理；`dsh-pixel` 退役只是少了一个 `link:` 对象。
- ⚠️ **`caches` 同步面里的 `pixel-studio` 不要删**：那是市场插件 `@muxiuesd/dsh-pixel-studio`
  的数据目录（`~/.dsh/pixel-studio/works.json`），与自研 `dsh-pixel` 无关。
  自研版的宿主半根本不读写它（只共享 HTTP 契约），详细证据见
  `archive/dsh-pixel/reference/PLATFORM-EVIDENCE.md` E1 / E2。

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
## ADR-011 · 0.4 面板自带滚动区，并用「下一步」单卡取代重复提醒

- **日期**：2026-11-16
- **背景**：用户报「侧边栏同步中心看不到下面的内容，无法滚动」。实测不是内容多，而是**结构性裁切**：
  宿主 `.mP3x-q_mainPanel` 是 `flex-direction:column;flex:1;min-height:0` 且**没有 overflow**，
  它自己不滚，也不给子项高度约束；插件根节点 0.3 只写了 `padding/max-width`，没有 `height`，
  于是按内容撑开、超出部分被宿主裁掉且拿不到滚动条。② ③ 两卡与操作记录因此完全不可达。
- **结论**：
  1. 根 `.dsc` 设为 `display:flex;flex-direction:column;height:100%;max-height:100%;min-height:0;overflow:hidden`；
     内部拆成固定头部 `.hd`（`flex:0 0 auto`）+ 滚动体 `.body`（`flex:1 1 auto;min-height:0;overflow-y:auto`）。
  2. `settings.section` **不加**自己的滚动容器 —— 设置外壳的 `.options` 已经是 `overflow-y:auto` 且带
     `padding:0 24px 24px`，再加一层会把滚轮困在内层，同时双重内边距。
  3. 新增「下一步」头卡：只显示 `preflight` 选出的那**一个**未完成步骤 + 它的 detail + 动作按钮；
     与开工检查重复的提醒（`remote/behind/ahead/dirty/switch`）不再在「提醒」卡重写一遍。
  4. 通道未配置时在面板内直接给两个地址输入框（`connectCard`），不必先去设置页。
- **理由**：滚动必须由插件自己拥有 —— 宿主既不会替插件滚，也不会给插件高度；
  而卡片的可读性问题本质是**同一信息说了三遍**且关键项埋在中间，减信息比加折叠更有效。
- **反面代价**：
  - 面板自己管理滚动，宿主要哪天改成 `.mainPanel` 自带滚动，这里会变成双层滚动，需要同步改。
  - 固定高度依赖插槽锚点是 `display:contents`（已从 asar 源码确认）——
    若将来宿主把锚点改成高度自适应的普通 `div`，`height:100%` 会失效；已用 `max-height:100%` 做第二道保险。
  - 面板内可直接写 `config.json`，等于把「写配置」的入口从设置页扩大到侧边栏（已限定只写 `channels[ch].remote`）。
- **已否决的替代方案**：
  - 让宿主 `.mainPanel` 加 `overflow:auto` → 要改 App 内部 CSS，影响所有插件，且升级即失效。
  - 给面板加「展开/折叠」把卡片收起来 → 治标：用户本来就想看下面的内容，收起后还要多点一次。
  - 把内容拆成多页签 → 引入状态与导航，与「一屏看完」的初衷相反。
  - 用 `position:absolute;inset:0` 铺满宿主 → 依赖宿主定位上下文，风险高于 `height:100%`。
- **验证**：`synchub-smoke.cjs` 除组件结构外新增 CSS 规则级回归 ——
  断言 `.dsc` 的 `height:100%`/`overflow:hidden`、`.body` 的 `overflow-y:auto`/`min-height:0`、
  `.hd` 的 `flex:0 0 auto` 均存在；断言 `color/background` 不再出现裸十六进制；
  断言每个 `var(--dsw-*)` 都带兜底值。全部通过，`SMOKE_EXIT=0`。

---
## ADR-012 · 显示名改为 `Msynchub`；红点缩小并移到图标左上角；新用户引导写进设置页

- **日期**：2026-11-16
- **背景**：用户要求三件事：（a）把「同步中心（设置与目录）」改名为 **Msynchub**
  （`M` 是 Manta 品牌前缀，`synchub` 是插件名，便于在多插件侧栏里识别）；
  （b）侧栏红点太大且位置不对，要求**更小**并放到**图标左上角**；
  （c）设置页要写清楚新用户怎么配 git/仓库，能照着做。
- **结论**：
  1. 两个插槽的 `label` 都改成 `Msynchub`（`sidebar.panellist` 与 `settings.section`），
     面板 `h2` 同步改。**只改显示名**：目录名、包名、插槽 id、`/api/dsh-synchub/*` 路径、
     `$DSH_HOME\dsh-synchub` 配置目录全部不动。
  2. 侧栏红点 `7px → 5px`，`right:-3 → left:-2`（左上角），
     `box-shadow 2px → 1.5px`，加 `pointer-events:none`，颜色改用主题变量。
  3. 设置页最上方新增「新用户从这里开始」卡（第 0→4 步）+ 安装命令 + 重启边界。
- **理由**：
  - 显示名是仓库级约定（`界面显示名统一为 M+插件名`，见 `~/.dsh/AGENTS.md`），
    `Msynchub` 与 `Mgitok`/`Mlarkcli` 一致；而**标识符不能跟着改**，否则已装用户的
    配置目录、同步仓库、`link:` 路径全部失效 —— 改名成本必须限在 `label` 上。
  - 5px 左上角：原 7px 右上角与宿主自己的角标（未读、运行中）位置重叠，且 7px 在
    16px 图标旁显得过大，像另一个独立的入口。左上角不撞任何宿主角标。
  - 引导写在**设置页**而不是 README，是因为新用户首先打开的就是设置页；
    「要设定 git 等目录对吧」这类问题不该需要去翻仓库。
- **反面代价**：
  - 显示名与目录名不再字面一致，排查问题时需要知道 `Msynchub = dsh-synchub`（已写进 README §10）。
  - 引导卡是写死的中文文案，GitHub 改版（如 PAT 菜单位置）后需手动跟进；已尽量只写稳定路径。
  - 5px 在 1x 屏上偏小，可能不易看见；这是用户明确要求的取舍（「小一点」），
    仍保留 `title` 与 `aria-label` 供悬浮/读屏。
- **已否决的替代方案**：
  - 同时把目录/包名改成 `msynchub` → 破坏 `link:` 安装路径、配置目录、已建立的同步仓库，代价远超收益。
  - 红点继续放右上角但更小 → 仍与宿主角标抢位置。
  - 引导只更新 README → 用户明确要求「在设置中 bootstrap 写清楚」，README 到不了首屏。
  - 用 `locale/*.json` 做多语言显示名 → 本插件没接 locale 体系，单加一层只为一个字符串。
- **验证**：`synchub-smoke.cjs` 新增三组断言 ——
  两个插槽 `label === 'Msynchub'` 且不再含「同步中心」；红点宽高 ≤6（实为 5×5）、
  带 `left` 不带 `right`、贴上边；设置页包含「新用户从这里开始」与第 0–4 步及 `install.ps1`。
  全部通过，`SMOKE_EXIT=0`。
---

## ADR-013 · 实现 ADR-005：purgeSession 受控会话删除（0.5.0）

- **日期**：2026-11-17
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**：ADR-004 §4.4 实测确认「只删 `.zstd` ≠ 删除会话」——`workspace.json` 的四处引用（各 workspace 的 `sessionIds`、`archivedSessionIds`、`pinnedSessionIds`）、`session_projcache`、搜索索引都会留下悬空痕迹。GUI 明确不提供删除。ADR-005 要求做成受控功能而非手删。
- **结论**：在 `dsh-synchub` 增加 `purgeSession`，经 HTTP API 暴露，默认二次确认：
  1. `GET /api/dsh-synchub/purge-session?id=<id>` 预览（只读，不改任何文件）：物理目录、workspace 引用路径、projcache、是否静止；
  2. `POST /api/dsh-synchub/purge-session {id, confirm:<逐字相同的 id>}` 执行：全量备份到 `$DSH_HOME/dsh-synchub/backups/purge-<ts>-<id>/`（含 `rollback.json` + `RESTORE.md`）→ 校验静止 → 原子改 `workspace.json`（临时文件 + rename）→ 删正文目录 + projcache → 失效指纹缓存；
  3. `GET /api/dsh-synchub/purge-session?id=<id>&verify=1` 重启后验收；
  4. 面板增加「④ 受控删除单个会话」卡：预览 → 再次输入同一 id 才解锁删除按钮。
- **关于「四处引用」**：不写死字段名，而是递归遍历整个 `workspace.json` JSON 树，剔除所有等于该会话 id 的数组元素——`unit.version` 升级后多出的引用也会被清掉；同时认 `session-<uuid>` 与裸 `<uuid>` 两种写法（projcache 文件名是裸 uuid）。
- **关于搜索索引**：源码级核实（本机 DSH `dsh-session-query-sqlite/src/index.ts` 的 `_reconcile`）：搜索索引是 SQLite FTS5 **派生库**，每次检索时对照持久化层重建，`persistentDeletes`/`liveDeletes` 会自动删掉已不存在会话的文档。因此**不直接写活索引库**（运行时改活库危险），只删正文；索引随下次检索自愈。本机 `~/.dsh` 下未发现持久化的索引文件（可能为 `:memory:` 或启动器临时路径）。
- **理由**：把不可逆操作收拢到一个有备份、有静止校验、有回滚点的入口，杜绝手工漏改导致的悬空引用；二次确认默认开启，符合 ADR-005「删除须显式」的约束。
- **反面代价**：
  - 执行时到重启之间 DSH 内存状态仍持有旧会话；必须**完全退出 DSH**后再操作并重启，否则内存回写会复原——面板与文档已明确标注。
  - 回滚点默认永久保留（直到用户手动清理），长期占空间；这是「可逆优先」的取舍。
  - 「静止校验」依赖 projcache 的 `turnBoundary`/`sessionStats`/工具调用/子代理字段与日志 mtime，属启发式；若 DSH 改了缓存结构需同步更新（代码注释已标注）。
  - 只删本机正文；同步镜像里仍有该会话，须在下次推送时显式 `prune` 才会从远端移除（沿用 ADR-001 规则二「默认只增不删」）。
- **已否决的替代方案**：
  - 直接写 SQLite FTS 索引删文档 → 否决：派生库会自愈，且改活库有并发风险。
  - 写死 `workspace.json` 四个字段名 → 否决：版本升级易漏；改为递归遍历更稳。
  - 面板点一下就删（无二次确认）→ 否决：违反 ADR-005 默认确认要求。
- **验证**：`dsh-synchub/test/purge-smoke.cjs` 用临时 DSH_HOME 夹具覆盖初始态预览无副作用、四种引用清理、裸/带前缀 id、回滚点生成、confirm 闸门、未静止拒绝、验收接口、搜索索引自愈语义；`PURGE_SMOKE_OK`，`node --check` 双文件通过。**真机完全重启后的界面验收尚未执行**（改 `index.js` 必须重启，见 D 边界）。

---

## ADR-014 · 会话移动 / cwd 改写：评估结论「不做」（0.5.0）

- **日期**：2026-11-17
- **状态**：已采纳（结论：不做，除非新证据推翻）
- **触发**：ADR 待办要求「先评估可行性与风险，风险不可控则明确记为不做并写理由」。本次按 `~/.dsh/AGENTS.md` 的规定补了**源码级证据**（不再只靠 ADR-006 的转述）。
- **源码证据（本机 DSH，2026-11-17 只读核对）**：
  1. `dsh-workspace/src/entity.ts` 的 `attachSession()`：`cwd = realpathNormalize(header.cwd)`，随后 `if (cwd !== this.record.path) throw new Error("cannot attach session … its cwd resolves to …")`。注释明确 **"both inputs (stored header cwd, workspace path) are immutable"**。→ 归属校验拿的是会话头 cwd 与工作区 path 的严格相等，改 `workspace.json` 的 `sessionIds` 绕不过它。
  2. `dsh-api-session-controller/src/commands.ts` 的 `rejectCreation()`：`ApiSessionCwdConflict` → `RemoteError('session/conflict', …)`。→ 创建/复用会话时 cwd 不符直接冲突。
  3. 同文件 `forkWorkspace()`：fork 沿 lineage 找源会话所属 workspace，源 cwd 被继承；没有「改 cwd 再挂到新工作区」的入口。
  4. `dsh-working-directory/src/index.ts`：`working-directory: directory does not exist` 正是 cwd 指向不存在目录时的报错。
  5. 会话正文 `session.v4.jsonl.zstd` 是 **zstd 多帧压缩**（ADR-004 §4.1、`docs/chatsync-architecture.md` §3.5，含实测：单次 `zstdDecompressSync` 只解第一帧）。改 cwd 必须逐帧解码 → 改 JSONL → 重压，且要同步改 projcache 的 `cwd`/`workingDirectory`/`identity.path`。
- **要做「移动」至少同时改对 5 处**：① zstd 多帧里的 cwd ② 物理目录重编码命名 ③ `workspace.json` 归属/归档/置顶 ④ projcache 三处绝对路径 ⑤ 搜索索引重建；而且必须在 DSH 完全退出时做，运行中被内存回写覆盖。任何一处漏掉都会产生「能列出但打不开」「归错工作区」或「继续对话落到旧目录」。
- **结论：不做。** 理由：
  - cwd 与归属是 DSH 源码级 immutable 约束，不是本插件能安全绕过的；用外部工具改写等于和宿主语义对抗。
  - 风险不可控：zstd 多帧解码重压是数据损坏高危操作（chatsync 作者也承认「工作区映射还没做」，见 docs）。
  - 已存在两条**零风险替代路径**且够用（ADR-002 相同绝对路径 + ADR-006 知识持久化），真实需求被覆盖。
- **反面代价**：用户若确实换了工作区路径，无法把旧会话「搬过去」，只能按 ADR-002 让两台用相同路径，或把结论蒸馏成文档（见 A3）在新工作区继续。这是明确告知的取舍，不是隐藏限制。
- **已否决的替代方案**：
  - 只改 `workspace.json` 归属、不改 cwd → 否决：源码会按 cwd 严格校验并过滤，会话归错或打不开。
  - 在目标路径建 junction「骗过」realpath → 否决：需要管理员/开发者模式、路径必须逐字符对齐，仍是脆弱的运行时依赖；ADR-002 已选更稳的相同路径方案。
  - 改 projcache 的 cwd 但不改 zstd 正文 → 否决：正文才是权威，打开时仍按 header.cwd 校验。
- **验证**：本条为评估性决策，不产生代码；证据为上述本机 DSH 源码只读核对（文件与行已记录）。待办表本项标记为「评估完成：不做」。

---

## ADR-015 · compact 输出定位为「人工蒸馏文档」，实现模板 + 确认闸门（0.5.0）

- **日期**：2026-11-17
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**：ADR-006 §「把 compact 输出存进工作区是否需要」评估结论是「需要，但定位为人工蒸馏文档，不是自动导出」。compact 摘要是给模型续用的上下文，写在 zstd 多帧日志里；「哪些算确定结论」需要人判断。
- **结论**：在 `dsh-synchub` 增加 `sessionNote`，走「预览拿模板 → 人填结论 → 确认写盘」三步，**不自动解码 compact 摘要**：
  1. `GET /api/dsh-synchub/session-note?id=<id>[&filename=…]`：从 `workspace.json` 定位会话所属工作区，给出落盘目标 `<工作区>/docs/session-notes/<name>.md` 与蒸馏模板（五章：确定结论 / 决策与理由 / 待办 / 文件路径 / 过程性细节）；只读不写盘。
  2. `POST /api/dsh-synchub/session-note {id, filename?, content, confirm:'WRITE'}`：写盘闸门。`confirm` 必须显式为 `true`/`'WRITE'`；**内容与模板完全相同则拒绝**（逼人真的写结论）；目标已存在则先备份到回滚点且本次不覆盖（避免误盖人写的文档）。
  3. 面板「⑤ 会话蒸馏成文档」卡：取模板 → 在文本框填写 → 点确认写盘。
- **理由**：文档落在**工作区文件**里，由工作区自己的 git 管，天然跨机可见——不依赖 `dsh-synchub` 搬会话、也不需要会话迁移（ADR-006 的替代路径）。人只对内容负责，工具只保证落点安全与闸门。
- **反面代价**：
  - 需要人手动整理，不能一键导出——这是刻意的（摘要面向模型、可能含敏感路径/无关细节）。
  - 写盘到 `<工作区>/docs/session-notes/` 依赖工作区路径在本机真实存在（ADR-002 相同路径已保证）；孤儿会话（未登记工作区）无法自动定位，会明确报错。
  - 文件名用 `path.basename` 剥离目录成分并限定 `*.md` 白名单，防路径穿越；代价是用户不能在文件名里用子目录。
  - 改了 `index.js` 必须完全重启 DSH；本轮只做离线 smoke，未真机重启验收。
- **已否决的替代方案**：
  - 自动解码 zstd compact 摘要并 dump 成文档 → 否决：摘要面向模型不是给人看的，且多帧解码 + 敏感信息风险高（ADR-006）。
  - 写进 `$DSH_HOME` 由 synchub 同步 → 否决：工作区文件应归工作区 git，混进 DSH 状态同步会跨机覆盖。
  - 面板点一下就写、无 confirm → 否决：违反「人对内容负责」的定位。
- **验证**：`dsh-synchub/test/sessionnote-smoke.cjs` 用临时 DSH_HOME + 临时工作区夹具覆盖模板五章、预览定位、未登记会话拒绝、路径穿越剥离、confirm 闸门、空内容/模板原样拒绝、正确写盘、已存在先备份不覆盖；`SESSIONNOTE_SMOKE_OK`；两份 smoke 与 `node --check` 全绿。

---

## ADR-016 · 同步面板接入状态目录真实磁盘状态（0.5.0）

- **日期**：2026-11-17
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**：待办登记「同步面板接入真实状态」时（`~/.dsh/dsh-synchub/` 尚未初始化）。复核发现：状态目录**现在已存在**（`config.json`，machine=RedmiPro，两通道 remote 为空），但面板此前只显示通道 ahead/behind，**从不展示状态目录本身是否初始化、仓库是否建好、有几个回滚点**——即「未初始化」这件事在界面上看不见。
- **结论**：给 `status` 增加只读 `state` 字段，并新增 `GET /api/dsh-synchub/state`，暴露真实磁盘状态：`root` / `rootExists` / `initialized`（目录存在且 config.json 存在）/ `config.exists` + `modifiedAt` / `repos[ch].{hasGit,hasHead,hasPayload}` / `backupCount` / 人类可读 `hint`。设置页「当前状态」卡显示这些字段；`hint` 在未初始化时明确写「保存一次设置或点提交并推送会自动创建 config.json」。
- **原则**：接口**只读、绝不创建目录**——「查过了没事」和「根本没查/没初始化」必须分开（贯穿全插件的原则，见 README §5）。
- **理由**：把「状态目录有没有就绪」从隐形变成面板可见，正是这条待办的本意；不再依赖用户去翻文件系统猜。
- **反面代价**：`stateInfo` 每次 status 请求多做几次 `stat`/`readdir`（可忽略）；它报告的是磁盘事实，可能与内存中的配置草稿不一致（草稿未保存时以磁盘为准，符合「真实状态」定位）。改 `index.js` 需完全重启 DSH，本轮只做离线 smoke + 真实目录只读核对。
- **已否决的替代方案**：
  - 前端自己拼路径去读文件系统 → 否决：浏览器无权读本地磁盘，且路径应由宿主算（AGENTS.md 约定）。
  - 初始化时自动建好所有目录并显示绿色 → 否决：会把「没配远端」伪装成「已就绪」，违反区分原则。
- **验证**：`dsh-synchub/test/state-smoke.cjs` 覆盖初始态（未创建目录、不写盘）、部分初始化（只有 config）、完整态（两仓库 .git/HEAD + backups 计数）；`STATE_SMOKE_OK`。真实目录只读核对：`initialized=true, configExists=true, repos=false/false, backupCount=0`（本机现状，remote 未配），与预期一致。三份 smoke 与 `node --check` 全绿。

---

## ADR-017 · 是否发布到市场：维持本地分发（2026-11-17 用户拍板）

- **日期**：2026-11-17
- **状态**：已采纳（用户决策）
- **背景**：ADR-008 记录了自研插件当前全部 `private: true`、靠 `link:` + git 分发。待办「是否发布到市场」需用户拍板。
- **两种模式的区别（向用户讲清后确认）**：
  | 维度 | 本地分发（现状） | 市场发布 |
  |---|---|---|
  | 安装 | `install.ps1` 以 `link:`（Junction）注册进 profile | `dsh plugin add <包名>` 从 npm 装线上包 |
  | 改代码 | 本机即改即生效 | 不生效，须 bump 版本 + 重新 publish |
  | 给另一台 | `plugpush.ps1` 推 git → 另一台 `git pull` + 各自 `install.ps1` | 另一台直接 `dsh plugin add` |
  | package.json | `private: true` | 去 private + 选 npm 名 + `link:`→版本号 |
  | 代价 | `link:` 绝对路径写进 profile（故 profile 是 danger 级，每台各装各的） | 失去 git tag 式版本管理；本机调试仍要另留 `link:` |
  - 用户对市场发布的理解正确：发布 = 你开发后 publish 到 npm，DSH 通过市场装线上版本，不再装本地代码；本机开发通常仍保留 `link:` 即时调试。
- **决策**：**维持本地分发**。不改 `private`、不选 npm 名、不发布市场、不执行任何 `npm publish` / `git push`。本轮 A5 结论就是 ADR-008 现状的确认。
- **理由**：当前只有两台机器使用，git + `install.ps1` 的接力分发够用；市场发布带来的版本/命名/双轨调试成本没有对应收益。npm 上 `dsh-pixel` 已被他人占名也提示发布需先处理命名冲突。
- **反面代价**：新机器接入要手动 clone 仓库 + 跑 `install.ps1` + 保证路径一致，不能一键装；换来的是全程源码可控、即改即生效。
- **若将来要发布（不在本次执行）**：去 private → 选未被占用的 scoped npm 名 → profile 依赖从 `link:` 改版本号 → 在目标机 `dsh plugin add` → 同步更新 `list.json` 版本与 `-Tag` 习惯。这些是发布决策清单，需届时另行逐项确认。
- **验证**：本条为决策记录，不产生代码；已向用户讲清两模式区别并由用户选择「维持本地分发」。

---

## ADR-018 · 开源发布质量门槛（0.5.0）：去硬编码 / 零敏感信息 / 外部可配置

- **日期**：2026-11-17
- **状态**：已采纳（质量门槛达成；发布决策见 ADR-017）
- **背景**：目标把插件做到「可开源发布质量」。按用户澄清，先理解为**质量门槛**，不等于真的发布；是否去 private / 选 npm 名 / 发市场是独立决策（ADR-017 已定：维持本地分发）。
- **结论 / 核查结果**：
  1. **代码零硬编码**：`lib/` 全量 grep 无 `FRANCIS-HOME-I7` / `RedmiPro` / `C:\Users\<具体用户名>` / 作者 GitHub 名；机器名取 `os.hostname()`、DSH_HOME 取 `$DSH_HOME` 或 `homedir()/.dsh` 推导、`workspace` 是用户配置项（README 示例 `<你的机器名>` / `<you>`）。
  2. **敏感信息零残留**：全插件 grep 无 token（ghp_/github_pat_/sk-）、私钥、邮箱、明文口令。凭据从不写文件（只走 Windows 凭据管理器），README/ADR 反复申明。
  3. **README 外部从零配置**：新用户引导第 0–4 步 + install.ps1 命令 + 两个私有仓库 + PAT 权限 + 重启边界，都在设置页与 README/BOOTSTRAP，外部用户不需要问人。
  4. **实测样例的处理**：ADR-004/008/016 与 `docs/` 里的 `C:\Users\franc`、机器名、会话 id 是**原作者实测证据快照**，不是代码硬编码；已在各文件顶部加「开源说明」注明是样例、请替换为读者自己的值，保留证据但不再误导。
- **反面代价**：实测样例保留会让文档里出现一个具体用户名（已标注为样例）；彻底匿名化会损失证据的可核对性，权衡后选择「标注 + 保留」。
- **已否决的替代方案**：
  - 把所有实测路径替换成占位符并删掉具体值 → 否决：损失证据可核对性（AGENTS.md 要求平台结论有源码级证据）。
  - 现在去 `private` / 选 npm 名 / 发布 → 否决：这是发布决策，用户已选维持本地分发（ADR-017）。
- **验证**：`lib/` 硬编码 grep 无匹配；全插件敏感信息 grep 无匹配；README 配置项为外部占位符；三份 smoke + `node --check` 全绿。

---

## ADR-019 · 0.5.1：回答五个使用疑问 + 面板顺序修复 + 侧栏开关 + 多工作区

- **日期**：2026-11-17
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**：用户提出五个疑问（两仓库能否合并 / 空闲标准 / 是否走第三方 dshmanager / 多工作区怎么填 / 新主机能否用 git 地址安装），
  并指出面板卡片顺序错误（未配远端时「下一步」/拉取推送按钮排在连接引导之上）、要求设置里加「是否在侧边栏显示」。
- **结论**：
  1. **两仓库不合并（暂）**：体积/写入频率差异 + 通道独立性（一个坏另一个能救）是真实价值；
     合并需要改 `SURFACES[].channel` 与 `repos/` 布局，属架构变更，记入待办。代码不禁止两通道填同一地址，
     但那**不是真共用一个工作副本**（仍分 `repos/config` 与 `repos/sessions`）。
  2. **空闲标准明确**：只按本插件收到的 HTTP 操作计时（`idlePushMinutes` + 四条件 + 5 分钟冷却），
     **不检测 DSH 会话是否有运行中的 agent/turn**。已写进面板、README、`/status.auto.standard`。
  3. **插件安装入口纠正**：不是第三方 dshmanager，是 DSH 官方「设置 → 插件 → 添加插件」
     （dsh-market / 插件管理器），支持 npm 包名 / Git 仓库地址 / 本地目录；Msynchub 本身是自研 `link:` 插件，不是市场包。
  4. **多工作区**：`config.workspaces`（数组，一行一个），只用于体检提示，不参与同步路径改写；
     会话归属只看 `workspace.json`。保留单值 `workspace` 兼容旧配置。
  5. **新主机安装卡**：面板「⑥」给出仓库根 / `#path:dsh-synchub` 地址 / 等价命令，均可点复制。
     **必须带 `#path:dsh-synchub`**——dshplug 是 monorepo，根不是 bundle，否则 DSH 报「没有声明组合包」。
  6. **面板顺序修复**：未配远端时 `connectCard` 必须排在 `heroCard` 之前——
     在那之前拉取/推送按钮是空转，用户会以为面板坏了。smoke 已加顺序断言防回归。
  7. **侧栏显示开关**：`config.showInSidebar`（默认 true）。`apply` 同步注册（不闪），
     拿到配置后若为 false 则移除侧栏；**设置分节不受影响**，仍可从设置进入。
- **理由**：这五项都是「用户看得到但猜不到」的信息差；写进面板 + 文档 + 断言，比口头解释更持久。
- **反面代价**：
  - 侧栏开关是「先注册再异步移除」，首帧可能闪一下侧栏项；换来的是不阻塞首屏。
  - 安装卡写死了 `mengfanchun2017/dswp-plugin` 地址（本仓库唯一远端）；换仓库要改代码。
  - `#path:` 子目录安装依赖 pnpm 对该片段的支持，**本轮未在真机实测从 git 地址安装**（需重启 + 联网）。
- **已否决的替代方案**：
  - 把 `#path:` 前端拼成可选，只给仓库根地址 → 否决：根不是 bundle，装必失败。
  - 侧栏开关做成需要重启才生效 → 否决：设置类开关应当保存即生效。
- **验证**：`synchub-smoke.cjs` 新增 16 路由、安装地址/命令、空闲标准四条件、多工作区去重、`showInSidebar` 写入、
  以及**卡片顺序断言**；四份 smoke + `node --check` 全绿。
---

## ADR-020 · 0.5.2：安装地址从真实 remote 推导，不写死也不说硬话

- **日期**：2026-11-17
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**：ADR-019 把安装卡做出来时留下了两个**自己也不满意**的毛病：① 仓库地址在代码里写死
  `https://github.com/mengfanchun2017/dswp-plugin`，换仓库/改 remote 就要改代码；
  ② 卡片里写了一句“当前远端 master 仍是旧版本”，这是**当时的事实**，但写死成文案后，
  一旦推送就会变成假话。这正是本仓库反复强调的“不要把没查当成查过”。
- **结论**：
  1. **地址不写死**：新增 `repoFacts()`，从插件目录上一级的仓库根读 `git remote get-url origin`，
     再用 `normalizeRemoteToHttps()` 归一化（支持 `https://…​.git` / `git@host:path` / `git+https` / `ssh://git@`）。
  2. **无 remote 就诚实降级**：返回 `spec:null` / `command:null`，面板明说“无法给出 git 安装地址，请用本机脚本”，
     **绝不编造地址**。
  3. **版本只报事实**：读 `origin/<branch>:dsh-synchub/package.json`（纯本地引用，不联网），
     输出 `state: same | differs | unknown` + 一句人话。读不到就 `unknown` 并说明原因。
  4. 安装卡改为数据驱动（`own.install`），不再含写死字符串；`/install-info` 与 `/status.install` 都给出同一份数据。
- **理由**：换仓库、改名、换分支都不需要改代码；且“不知道”可以被安全地表达出来——
  这正是频道里反复出现的“查过了没事 vs 根本没查”需分开的原则。
- **反面代价**：
  - `#path:` 子目录安装仍**未在真机实测**（需重启+联网）；本轮只验证了地址生成与归一化。
  - `repoFacts` 每次 `/status` 会多跑 2~3 次 `git`（本地引用读取，毫秒级）；失败全部降级，不影响面板。
  - 依赖“插件目录上一级就是仓库根”这个布局假设（dshplug 扁平布局）；不成立时诚实返回 null。
- **已否决的替代方案**：
  - 继续写死地址，只把“远端旧版”文案改成变量 → 否决：地址仍会腐烂。
  - 联网查 GitHub API 取远端版本 → 否决：面板刷新会变慢且需 token；本地 origin 引用零成本且不联网。
  - 无 remote 时用当前目录路径当安装地址 → 否决：那是本机路径，别的机器不可用，属于假地址。
- **验证**：`synchub-smoke.cjs` 增加两套断言——① 有 remote 时地址必须是 HTTPS `.git`、必须带 `#path:dsh-synchub`、且与 remote 同源；
  无 remote 时必须 `null`（不得编造）；② 版本只能 `same/differs/unknown`，`unknown` 时必须说明原因。
  另对**纯函数** `normalizeRemoteToHttps` 单独覆盖 8 种输入（scp、git+、ssh://、尾斜杠、空串、本地路径等）。
  真实 remote 实测：`https://github.com/mengfanchun2017/dswp-plugin.git` → `https://github.com/mengfanchun2017/dswp-plugin#path:dsh-synchub`，
  与 `git@github.com:…` 写法收敛到同一结果。四份 smoke + `node --check` 全绿。

---

## ADR-021 · 0.5.3：工作区映射表（注册名 + 本地位置）+ 凭据提示改交用户处理

- **日期**：2026-11-17
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**（用户两个真实反馈）：
  1. 原来的「工作区路径（可多个）」是个 textarea，要求用户自己想好写什么，且“不能换行 / 用逗号还是空格”都不清楚——**不好操作**。
     用户希望：每个一行、能增删、能填「本机位置 + 注册名」，而注册名是唯一的（如 `dshplug`、`base`），
     本地位置默认 `C:\dsh\<注册名>` 但可手改。
  2. 原面板文案写「用 HTTPS，不要用 SSH，实测会被墙」「首次推送时弹窗填 PAT」——用户指出**这不对**：
     Git 认证应该由用户自己搞定，并会用 gitok 检查；synchub 应当按 **DSH 已经配通的方式** 确认。
- **结论**：
  1. **工作区映射表** `config.workspaceMap: [{name, path?}]`：
     - `name` = **注册名**，对应 `workspace.json` 里工作区的 `title`（DSH 侧边栏那个名字，大小写不敏感唯一）；
     - `path` 可省略，省略时默认 `<config.workspaceRoot>\<name>`（`workspaceRoot` 默认 `C:\dsh`）；
     - 面板用**表格**：每行注册名 + 本地位置 + 实时对照 + 删除；下面「＋ 增加一行」；
     - 反向提示：DSH 已登记但你没配的工作区会列出来，可「全部加入」。
  2. **三方对照**：`workspaceReport` 把「映射表 / workspace.json 真实登记 / 本机路径是否存在」对一遍，
     给出 `matched | pathDiffers | unregistered` 三态。新增 `GET /api/dsh-synchub/workspaces`，
     并把它并入 `status.workspaceReport` 与 `checkAll` / `preflight` 的工作区检查项。
  3. **凭据文案改为交回用户**：新增 `CredentialNote` 组件（三处复用），明确「本插件不接收/不存储/不转发凭据」，
     推荐装 `dsh-gitok` 一键初始化（它会查 Windows 凭据管理器 / credential helper / 明文凭据 / 代理），
     不装也行；「配好后 Msynchub 按 **DSH 当前已配通的方式** 做一次真实连通性确认，不预设必须用哪种」。
     引导第 3 步从「准备 PAT」改为「把 Git 认证配通（你自己搞定）」。
- **为什么原来的 SSH/PAT 说法是错的**（纠正依据，gitok 实测文档 `git-auth-audit-2026-11-12.md`）：
  - 真正失败的是 **Windows 侧 `https://github.com:443` 直连没配代理**（`Failed to connect to github.com:443`），
    不是“SSH 被墙”；文档里也写了「`u26claude4` 里那把 SSH key 能用，说明 22 端口通」。所以“SSH 实测会被墙”是过度概括。
  - “首次推送弹 PAT”只是 **GCM 的一种交互形态**，不是唯一正道；用户用 GCM OAuth、SSH key、或任何已配通方式都应被接受。
    本插件本就不参与凭据流转（ADR-008 / gitok ADR-002 同一条原则），文案教人填 PAT 属于越位。
- **反面代价**：
  - `workspaceMap` 仍然**不参与同步面路径改写**（会话归属只看 `workspace.json`，ADR-002 不变）；
    它回答的是“要同步哪些工作区、本机在哪”，而不是“把会话搬到哪”。这一点在 UI 与文档都写清楚了。
  - 注册名要手填且必须与 DSH 里的名字对得上；对不上时只能给 `unregistered` 提示，不能自动猜。
  - `workspaceRoot` 默认 `C:\dsh` 是仓库级约定，换目录要手动改；已开放为配置项。
- **已否决的替代方案**：
  - 继续用 textarea + 一堆分隔符说明 → 否决：就是用户抱怨的“不好操作”。
  - 自动从 `workspace.json` 全量生成映射表（不给用户控制）→ 否决：用户可能只想同步其中几个；
    但提供「全部加入」按钮作为快捷方式。
  - 把凭据检查做进 synchub（自己跑 credential helper 检查）→ 否决：那是 gitok 的职责，
    两个插件重复实现会产生不一致结论（ADR-001 早就因为重复实现而废弃 chatsync）。
- **验证**：`synchub-smoke.cjs` 新增：17 路由、`normalizeWorkspaceMap` 五组用例（同名去重 / 默认路径 / 手填保留 / 纯路径取目录名 / 空行丢弃 / 单行保留）、
  `workspaces→workspaceMap` 迁移、UI 表头与「增加一行」「全部加入」「工作区根目录」。
  **真实数据核对**：本机 `workspace.json` 登记 4 个工作区（agent/base/dshplug/rag）；
  配 `dshplug`+`base` 后两者均为 `matched`，默认路径推出 `C:\dsh\dshplug`、`C:\dsh\base`，
  并正确列出未纳入的 `agent`、`rag`。四份 smoke + `node --check` 全绿。

---

## ADR-022 · 0.5.4：修保存链路 + 侧边栏/设置分工重划 + 自检引导

- **日期**：2026-11-18
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**（用户实测反馈）：
  1. 在侧边栏填两个仓库地址，点保存**不生效**；
  2. 到设置里能保存了，但侧边栏的信息没了；
  3. 侧边栏与设置职能区分不清、引导不清晰；要求同步功能先自检、OK 就报状态、不行就引导怎么配、
     并且引导要说清“怎么检查”；bootstrap 要能照着在家里那台装上。
- **根因（两个真 bug）**：
  1. **侧边栏保存不生效**：面板里写 `setDraft('config', v)`，但 `setDraft` 是 `useState` 的 setter，
     它把整个 state 置成了字符串 `'config'`，于是 `draft.config` 永远是 `undefined`，保存时两个 remote 都是空。
     另外输入框用 `defaultValue`（非受控）+ `onBlur` 回写，渲染时序上也会丢值。
  2. **设置保存后侧边栏信息丢失**：侧边栏 `saveRemotes` 先 `GET /config` 拿到整份配置再 `PUT` 回去；
     而设置页改完后的 `workspaceMap` 若尚未在侧边栏刷新过，就会被旧值回写覆盖。两个入口各自读写整份配置 → 互相踩。
- **结论**：
  1. 侧边栏改为**字段级 setter** + **受控输入**（`value` + `onChange`），不再用 `defaultValue`/`onBlur`。
  2. 侧边栏保存**只 PATCH `channels` 两个 remote**，不提交整份配置；
     宿主 `writeConfig` 本就是 base=当前磁盘 + patch 合并，因此不会再冲掉 `workspaceMap`。
  3. **分工重划**：
     - 侧边栏 = 日常（自检结论、通道快照、空闲一行摘要、目录地图、同步按钮）；
     - 设置 = 唯一配置入口（通道地址、工作区映射、同步面、空闲策略、侧栏可见性、检查结果）；
     - 侧边栏显式加一张「配置在哪里改」卡，指向设置，消除“两处都能配”的歧义。
  4. **新增 `selfCheck()` + `GET /api/dsh-synchub/self-check`**：一句话结论（就绪/待处理 N 项）
     + 每条引导含「缺什么 / 去哪里 / 怎么验证」。侧边栏第一张卡就展示它。
  5. 侧边栏移除「② 空闲自动上传」整张配置卡与重复的「开工检查」全量列表（改为仅显未通过项），
     高阶操作（删除会话/蒸馏/安装）收进 `details` 折叠区，不与日常按钮混排。
- **反面代价**：
  - 侧边栏不能再改配置（少了一个入口），但换来「配置只有一处」，不会再互相覆盖。
  - `selfCheck` 内部会调 `preflight`（含 fetch），刷新时会多一次网络尝试；已有 45s 轮询与超时保护。
  - 引导文本是针对当前真实失败原因分支拼的（无地址/仓库不存在/fetch 失败），新增失败类型需要补分支。
- **已否决的替代方案**：
  - 两个入口都写整份配置，靠加锁/版本号避免覆盖 → 否决：复杂且仍会丢并发编辑；职责分开更根治。
  - 侧边栏只读、完全不给填地址 → 否决：首次配置时用户就在面板上，不给输入会多一次跳转（但保存仍走 PATCH）。
- **验证**：
  - `synchub-smoke.cjs`：18 路由；`selfCheck` 未配远端时必显 `还不能同步`，且 guide 含「缺什么/去哪/怎么验」；
    通道全标未配置。
  - **真实配置核对**（本机已填 `dsh-config` / `dsh-session`）：`selfCheck` 返回 `ready:false`，
    两个通道均 `configured:true`，并给出「Git 认证/网络弄通」引导——与当前环境（沙箱里读不到 git）一致。
  - 四份 smoke + `node --check` 全绿；BOOTSTRAP 新增 §0.5「在家那台从零安装」七步，每步带验证命令。

---

## ADR-023 · 0.5.5：修工作区表"输入不进去" + 设置页减负分组 + 侧边栏彻底不写配置

- **日期**：2026-11-18
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**（用户实测）：
  1. 设置页「工作区映射」表格**无法输入**（看着在跑、但打的字不生效）；
  2. 侧边栏与设置的提示和步骤**还是太复杂**，要求深度分析后给建议。
- **根因（第三个真 bug）**：表格渲染用的是**临时占位行** `[{name:'',path:''}]`，
  而 `setWsRow` 改的是 `wsRows`——当时 `wsRows` 是空数组 `[]`。
  对空数组 `.map()` 结果仍是空，**输入被直接丢弃**，于是表现为“在跑但输入不进去”。
- **结论**：
  1. 引入唯一的“有效行” `wsRows = wsRowsRaw.length ? wsRowsRaw : [{name:'',path:''}]`，
     **渲染与编辑用同一份**；删除到空时保留一个空行，否则表格会整张消失。
  2. **设置页减负**：9 张平铺卡 → 三组：① 必做（两个仓库地址）② 可选（本机与同步面）
     ③ 诊断与维护（当前状态/检查结果/目录清单）。新增 `.groupTitle` 分组标题。
     冗长的「新用户 0–4 步」改为 `details` **默认折叠**（内容保留，不再占首屏）。
  3. **侧边栏彻底不写配置**：移除内嵌的通道地址输入框与 `saveRemotes`，
     `connectCard` 改为纯指引（去设置里填、仓库要空私有）。
     配置写入从此**只有设置页 `doSave` 一处**。
- **为什么这是对的（相较上一版的改进）**：
  上一版虽然把侧边栏保存改成了“只 PATCH channels”，但那仍是**第二条写入链路**；
  本轮直接取消这条链路——不是靠“小心不要覆盖”，而是**让它不可能发生**。
- **反面代价**：
  - 首次配置多一次跳转（面板 → 设置）。换来的是单一写入点，不再有覆盖风险。
  - 设置页变成“更长的页面”（三组垂直排列），但首屏只看到①必做，降低了认知负担。
  - 折叠引导后，新用户可能不去点开；因此侧边栏自检卡承担了首屏引导职责。
- **已否决的替代方案**：
  - 保留侧边栏输入但加“草稿合并”逻辑 → 否决：复杂度上去了，且仍可能丢用户输入。
  - 把设置页做成多标签页 → 否决：引入导航状态，且用户已经在两个入口间迷路，不再加一层。
  - 直接删掉 0–4 步引导 → 否决：新人确实需要，折叠已足够。
- **验证**：
  - 新增 bug3 回归断言：不得在渲染处新建占位行；必须存在唯一的“有效行”定义。
  - bug1/bug2 断言随设计更新：侧边栏不得再有 `saveRemotes`/通道输入框；
    设置页通道输入必须是受控 `value=form.channels[ch].remote`；
    仍保留 `mergeConfig` 局部 PATCH 不丢 `workspaceMap` 的实质断言。
  - 四份 smoke + `node --check` 全绿；版本四处一致 0.5.5。

---

## ADR-024 · 0.5.6：确定性自动填写工作区 + 安装两条路径讲清 + 多台机器表述

- **日期**：2026-11-18
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**（用户三个问题）：
  1. 工作区映射只想填名字，后面的路径能不能“检查并填写”（**明确要求不用 LLM**）；
  2. 引导里「装插件的命令」只讲了本地目录（那是已有仓库的做法），应补 git 地址安装作为另一条路；
     git 地址装的后续升级怎么办？是不是上 dsh-market 最优？要求分析并写清楚；
  3. “一次安装，二台机器使用”的说法不准，实际可多台。
- **结论**：
  1. **确定性自动填写**（关键：不涉及 LLM）：`realWorkspaces()` 从 `workspace.json` 读出
     每个工作区的 `title`（注册名）与 `path`（真实路径），作为 `suggestions` 返回；
     面板加「检查并自动填写」按钮，一键把所有真实工作区填入映射表。
     策略：**已手填的路径保留，未填的用真实 path**，不猜、不推断、不调模型。
  2. **安装两条路径**（写进面板、README、BOOTSTRAP）：
     - A git 地址安装（推荐新机器）：设置 → 插件 → 添加插件，填 `<仓库>#path:dsh-synchub`；
       升级靠界面「更新」或卸载重装；拿到的是远端快照，无自动版本升级。
     - B 本地目录 link:（适合开发）：`install.ps1 -Only dsh-synchub`；升级靠 `git pull`，路径写死。
  3. **dsh-market 分析**：长期是多机分发终点（一键安装+市场内升级），但现在没上——
     需去 private、选 npm 名、发布，属发布决策（ADR-017），本会话不做。
  4. **多台表述**：设置/引导/文档里“两台机器”统一改成“多台机器 / 每台机器”。
- **反面代价**：
  - 自动填写以 DSH 真实登记为准：如果某工作区还没在 DSH 里建过，就不会被带进来，仍需手填。
  - git 地址安装版本升级要手动，不像市场能一键更新——这是不上市场的直接代价，已写清。
- **已否决的替代方案**：
  - 让 LLM 根据会话内容猜注册名→路径 → 否决：用户明确不要 LLM；且路径必须是确定事实，不能猜。
  - 只保留本地目录一种安装方式 → 否决：新机器不想 clone 仓库，git 地址更省事。
  - 现在就上 dsh-market → 否决：发布决策未授权（ADR-017），且 npm 名有占用风险。
- **验证**：
  - smoke 新增断言：自动填写基于 `workspaceReport.suggestions`、文案注明“不涉及 AI”、按钮存在。
  - **真实数据核对**：本机 `workspace.json` 读出 2 条 suggestions：
    `base → C:\dsh\base`、`dshplug → C:\dsh\dshplug`，均为确定性路径。
  - 四份 smoke + `node --check` 全绿；版本四处一致 0.5.6。

---

## ADR-025 · 0.5.7：设置页整块白屏 = 少一个逗号（兼补带数据渲染冒烟）

- **日期**：2026-11-18
- **状态**：已采纳（已实现）
- **背景**：用户反馈「设置中点了 msynchub 什么显示都没有」。
  注意这不是“侧栏没入口”也不是“插件没加载”——启动日志里 `apply` 跑了、
  路由 18 条全在、`GET /config` 返回 200，**接口全正常，就是界面空白**。
- **根因**：`SettingsSection` 的工作区卡片里，`e('div', {className:'btns'}, …)`
  这行末尾**漏了一个逗号**。于是在解析上，下一行的
  `(status && …missingInMap… ? … : null)` 变成了对上一个函数返回值的**调用**，
  抛出 `TypeError: e(...) is not a function`。
- **为什么难查**（两个“遮蔽”叠加，这比 bug 本身更值得记）：
  1. **只在 form 非空时求值**。首帧 `form = null`，`&&` 直接短路，这一支根本不跑 →
     首帧完全正常。等 `/config` 回来、`setForm(conf)` 触发重渲染，才炸。
     于是表现是“先闪一下正常、随后整块变白”，而不是“一打开就错”。
  2. `settings.section` 的注册外面包了一层裸 `try { … } catch {}`，
     组件抛错被 React 的渲染阶段吃掉，**控制台也可能看不到温度**，只剩白屏。
  3. `node --check` 查不出——这是合法语法，只是语义错了。
- **结论**：补上逗号，并在原位留一条注释说明“这里必须有逗号”，防止再次被误删。
- **新增防护：`test/render-smoke.cjs`**（这才是本轮真正的产出）：
  用最小 react 桩把 `client.js` 真跑一遍，五段：
  1. `apply` 能注册出三个槽位；
  2. **首帧**（state 全初值）渲染不抛错、有可见文字；
  3. **有数据**（真实 config/status/map 形状）渲染不抛错、文字量达下限；
     单独覆盖 `missingInMap` 非空分支与空 `workspaceMap` 分支；
  4. 同一组件连渲两次，**钩子调用序列必须一致**（条件 hooks 会让真 React 报
     “Rendered more/fewer hooks” → 同样白屏）；
  5. 源码级护栏：去注释、归一化行尾后，检出“…)) 换行后 (cond” 这种漏逗号形态。
- **反面代价**：
  - 渲染桩是手写的，不是真 React：它只能接住“组件函数抛错”与“钩子序变化”，
    接不住真实 React 的其他规则（如 key 警告、非法 DOM 嵌套）。
  - 源码级护栏是正则，对格式化/换行风格敏感（已归一化 `\r`），
    但它终究只是线索，**真正的把守是第 3 段的有数据渲染**。
- **已否决的替代方案**：
  - 只在 `node --check` 上加断言 → 否决：它永远不会报出这个错，等于没测。
  - 只做源码 grep，不做渲染 → 否决：已实测，注释插在 `))` 和 `(cond` 之间时
    正则全部漏报（当时 E 段在坏副本上仍然全绿）；且它能防的只是这一种形状。
  - 把 `try { } catch {}` 去掉让错误暴露 → 否决：那只是把白屏换成整页崩，
    对用户更差；正确做法是组件自身写对 + 测试拦住。
- **验证**：
  - 修复后：`render-smoke` 31 项全绿；设置页渲染 475 节点 / 3180 字符 / 0 报错。
  - **变异测试**（证明这套测试真的能报，而不是永远绿）：把同一处逗号删掉做成坏副本，
    `render-smoke` 立即 10 项失败、exit 1（C 段 8 项 + E 段 2 项），修复版 exit 0。
  - 五份 smoke（render/synchub/purge/sessionnote/state）+ `node --check` 全绿；
    版本四处一致 **0.5.7**。
- **接口约定猎奇（已排除）**：排查时曾怀疑是注册契约不符（官方插件用
  `ctx.effect(...)` + `label: () => t('nav')` + `locale`，本插件用裸 `try` + 字符串 label）。
  实测：`label` 为字符串也能正常进导航，**不是原因**。记录在此以免下一个人重走。

---

## ADR-026 · 0.5.8：面板全绿但 GitHub 是空的 —— 假绿（false-green）

**背景（用户 2026-11-18 实测报障）**

保存设置后，面板显示：本机 `RedmiPro · desktop`、`配置通道 0/0/0`、`会话通道 0/0/0`、
`两通道仓库 配置 已建 · 会话 已建`、`可以开始工作`。
但用户直接去看 GitHub：`dsh-session` **是空的**（零提交），`dsh-config` 里**只有旧的 `snapshots/`**，
本机真正的同步内容一点也没上去。

**根因（两处独立缺陷，叠加出一片假绿）**

① **`dirty` 语义错了。** `channelState` 用 `git status --porcelain -uno` 当「有东西没同步」。
   但两个仓库都是空的（或只有旧提交），**git 工作区本来就是干净的**，`dirty` 恒为 0。
   于是 `preflight` 的「暂存本机变动」步骤判 `ok`，文案写「payload 已对齐本机」，
   `verdict` 直接给出「可以开始工作」。
   实测：`/scan` 报告 **265 个文件待暂存**，而 `/preflight` 同时说「已对齐」。

② **`branchOf` 硬写 `main`。** 注释早就写着「分支不能写死」，但实现仍是
   `BRANCH_CACHE.get(channel) || DEFAULT_BRANCH`（`DEFAULT_BRANCH = 'main'`）。
   `dsh-config` 实际在 **`master`** 上。于是 `rev-list HEAD...origin/main` 直接失败，
   `behind` 停在初始值 0——看起来「与远端一致」，实际上是**没算出来**。

**结论**

新增两个字段，并把所有判定改成用它们：

| 字段 | 含义 | 计算时机 |
|---|---|---|
| `payloadMissing` | `payload/` 目录是否存在 | 总是（就一个 `existsSync`） |
| `pending` | 本机有、payload 没有/不同的真实文件数 | **仅 `opts.scan` 时** |
| `unsynced` | `dirty + pending`，即「还有多少处没同步上去」 | 每次 |
| `scanned` | 本次是否真扫过（区分「没查」与「查过没事」） | 每次 |

- 面板与 `preflight` 一律改用 `unsynced`，不再看 `dirty`。
- 「两通道仓库」不再把 `.git` 存在叫「已建」，改为四态：
  `未建` / `空仓库（无提交）` / `无 payload（未同步）` / `已同步`。
- `branchOf` 在缓存未命中时读本地 `.git/HEAD`（`ref: refs/heads/<name>`），
  读不到才回退 `DEFAULT_BRANCH`。读 `.git/HEAD` 没有子进程开销，可以在同步函数里做。

**为什么 `pending` 不放进 `/status`**

`pending` 要扫全量文件并算 sha256 指纹；本机 `sessions/` 实测 **87 MB / 95 个文件**。
`/status` 是轮询接口（侧边栏圆点靠它），每次都扫会明显拖慢界面。
所以：`/status` 只带便宜的 `payloadMissing`（能判断「从未同步」），
`preflight` 和 `/check` 这类**用户手动触发**的路径才带 `scan: true` 拿精确值。

**反面代价**

- `/status` 里的 `pending` 是 `null`（= 没查），侧边栏因而**无法显示精确待同步文件数**，
  只能显示「还没有 payload」这种定性告警。精确数字要进设置页点一次才会更新。
- `preflight` 变慢：本机实测从 <100ms 增到约 1–2s（87 MB 指纹）。只在手动打开面板时付这个代价。
- 四态用词比两态长，状态卡片一行字变多。

**已否决的替代方案**

| 方案 | 否决理由 |
|---|---|
| 把 `pending` 也算进 `/status` | 轮询接口做 87 MB 哈希，界面会卡；且侧边栏圆点只需要「有没有问题」 |
| 只靠 `payloadMissing` 判断（不算 pending） | 只能抓「一次都没同步过」；首次同步后本机又改了很多文件的情况仍会显示已对齐 |
| 同步时自动 `git push` 不看 `dirty` | 掩盖问题而非暴露；且 `pushChannels` 已有 `behind-remote` 保护，不能绕过 |
| 用 `git status` 的 `--porcelain`（去掉 `-uno`）来数未跟踪文件 | 空仓库里 `payload/` 整个是未跟踪的，数出来是「目录级」而非文件级，仍然不可靠 |
| 把 `master` 重命名为 `main` 对齐默认值 | 远端默认分支已经是 `master`，改名等于在远端造新分支；应让代码适配仓库，而非反过来 |

**验证**

- [`test/unsynced-smoke.cjs`](./test/unsynced-smoke.cjs)：21 条断言，覆盖 `payloadMissing` 与磁盘一致、
  未扫描时 `pending === null`、扫描后 `pending` 为数字、`unsynced === dirty + pending`，
  以及**源码护栏**（`payloadMissing` 不得被写死成常量、`pending` 只能在 `opts.scan` 分支内赋值）。
- **变异测试**：把 `payloadMissing` 改成恒 `false`（回到旧语义）→ 该测试 **2 条失败、exit 1**；正常版 21 条全过。
- 六个 smoke（synchub / purge / sessionnote / state / render / unsynced）+ `node --check` 全绿。
- 真实推送验证：手动 `POST /push` 后 `dsh-config` 推上 `44cfb24..ff3ac51`、
  `dsh-session` 新建 `main` 分支（244 个 payload 文件），`git clone` 复核远端内容一致。

**口头约定**

以后新增任何「是否已同步」的判断，**一律用 `unsynced`，不要用 `dirty`**。
`dirty` 只回答「仓库里有没有未提交的改动」，它**不回答**「本机文件有没有同步上去」。
这两件事在空仓库上会得出相反的结论，而这正是本 ADR 的全部教训。

---

## ADR-027 · 0.5.8：清理遗留 `snapshots/` + 两仓库分支统一为 `main`

**背景**

ADR-026 修完「假绿」后，同步真实跑通了，但也暴露出两个仓库层面的历史遗留：

1. `dsh-config` 里并存两套结构：2026-11-12 的旧 `snapshots/`（29 文件）与新的 `payload/`（21 文件）。
   旧目录不是本插件写入的（提交消息是 `sync: add snapshot sync-<uuid>`，不是本插件的 `synchub: ...`），
   但两套并存会让人分不清哪份是现在生效的。
2. 两仓库默认分支不一致：`dsh-config` 在 **`master`**（GitHub 旧默认），`dsh-session` 在 **`main`**。

用户 2026-11-18 拍板：旧目录**删除**；分支**统一改成新标准**（`main`）。

**结论（已执行）**

| 步骤 | 命令/接口 | 结果 |
|---|---|---|
| 备份 refs/log/status | 写到 `backups/pre-branch-unify-20261118-151627/` | 6 个 txt |
| 从索引移除旧结构 | `git rm -r --cached snapshots` | 29 个文件 |
| 物理删除 | `Remove-Item snapshots -Recurse` | 29 个文件 |
| 提交 | `chore: 删除 2026-11-12 遗留的 snapshots/` | `ab7f449` |
| 推送（先在 master 上） | `git push origin master` | `ff3ac51..ab7f449` |
| 本地改名 | `git branch -m master main` | 完成 |
| 推送 main | `git push -u origin main` | 新建分支 |
| 改 GitHub 默认分支 | `PATCH /repos/{owner}/{repo}` `{"default_branch":"main"}` | 成功 |
| 删远端 master | `git push origin --delete master` | 已删 |

**最终状态（用 GitHub API + `git ls-remote` 复核）**

| 仓库 | 默认分支 | 分支列表 | 总文件 | `payload/` | `snapshots/` |
|---|---|---|---|---|---|
| `dsh-config` | `main` | 只有 `main` | 21 | 21 | 0 |
| `dsh-session` | `main` | 只有 `main` | 246 | 244 | 0 |

**理由**

- `main` 是当前 GitHub 对新仓库的默认值，也是 DSH 生态其他仓库的习惯；两台机器/其他人克隆时不会因默认分支感到意外。
- 旧 `snapshots/` 已被 `payload/` 完全取代，留着只会制造「到底哪份生效」的歧义。
- **先备份再删（并且先只 `--cached`、确认 payload 未受影响、再物理删）**：删错无法从本地恢复，远端历史虽然还在，但没必要冒险。

**反面代价**

- **远端历史里仍保留 `snapshots/` 的提交**（只是 HEAD 不再包含）。真要彻底抹除需 `filter-repo` 重写历史，代价大且会改变所有 commit hash——本 ADR 明确**不做**。
- 删 `master` 会让任何仍指向 `master` 的旧克隆（比如另一台机器）不可 `git pull`，需重设上游：
  `git fetch --prune && git branch -m master main && git branch -u origin/main`。
- 改默认分支需仓库 **admin** 权限（本机 token 有）；只有写权限的人做不到，会在这一步卡住。
- 本机无 `gh` CLI，只能走 REST API + `git ls-remote` 手工验证，不能一条命令完成。

**已否决的替代方案**

| 方案 | 否决理由 |
|---|---|
| 保留 `snapshots/` 当作历史备份 | 远端 git 历史本身就是备份；工作区里再留一份只会让人误以为它是活数据 |
| 只 `--cached` 移除、不物理删 | 工作区会留下未被跟踪的 29 个文件，`git status` 长期报 `?? snapshots/`，反而更乱 |
| 把 `dsh-session` 改成 `master`（反向统一） | `master` 是被淘汰的命名；新标准是 `main` |
| 用 `git filter-repo` 彻底抹除历史 | 会重写所有 commit hash，破坏任何已有克隆；收益（历史更干净）远小于代价 |
| 硬改代码里的 `DEFAULT_BRANCH = 'master'` | 代码已能自适应（ADR-026 读 `.git/HEAD` + `probeBranch`），不需要也不应该为一次仓库整理去写死分支 |

**验证**

- `gh` 不可用，改用 REST API `PATCH` 改默认分支，`GET /repos/.../branches` 复核只剩 `main`。
- `git ls-remote --heads` 复核两仓库只有 `refs/heads/main`。
- 插件实测：`channelState` 对两通道都报 `branch=main / behind=0 / ahead=0 / payloadMissing=false`。
- 六个 smoke + `node --check` 全绿（仓库内容变了但代码未变，重跑确认无回归）。

**口头约定**

插件**不能假设分支名**。`DEFAULT_BRANCH = 'main'` 只是「完全探测不到时的兵底」，
正常路径必须走 `branchOf()`（本地 `.git/HEAD`）与 `probeBranch()`（远端 `ls-remote --symref`）。
将来若再遇到 `master` 仓库（别人用旧习惯建的），**不要为了它改代码**——现有自适应逻辑已经足够。

---

## ADR-028 · 0.5.9：侧边栏重做成仪表盘（兼致命性能缺陷：四个接口全超时）

**背景（用户 2026-11-18 实测报障）**

进入侧边栏每次都是同一屏长篇说明：

> 还缺两个仓库地址 · 必需一步 … 修改点在设置里 → Msynchub …
> 还有这些提醒 · 需要处理 · 同步中心状态接口不可用，先看启动日志
> 配置通道 · 未配置远端 · 0 落后 / 0 领先 / 0 未同步

但设置页里两个仓库地址**明明已经填好**。用户原话：「现在进入感觉太难首了」（太冗长、抓不住重点）。
他要的是四件事：还有多少要同步、差异在哪、下次自动是什么时候、能不能手动触发。

**根因（两个独立问题叠在一起）**

**① 致命性能缺陷：四个接口全部超过前端 30 秒超时。**

实测旧版（0.5.7）：

| 接口 | 耗时 | 前端超时 | 结果 |
|---|---|---|---|
| `/map` | 29 ms | 30 s | ok |
| `/status` | 9–15 s | 30 s | 勉强 ok |
| `/preflight` | 37.6 s | 30 s | **中止** |
| `/self-check` | 42.7 s | 30 s | **中止** |

请求是 `Promise.allSettled` 一起发的。`own` 来自 `/status`，它本身不超时；
但 `own` 的**数据本身是错的**：`conf/sess` 都是 `{}` 时 `noRemote` 为 true，
面板于是显示「还缺两个仓库地址」，同时 `deriveAlerts` 因为 `own` 为空报「接口不可用」。
两句话互相矛盾，用户自然不知道该信哪个。

耗时拆解：`ls-remote` 3.9 s + `fetch` 2.8 s，单通道就 6.7 s；
`/status` `/preflight` `/self-check` 三个接口**各自都要跑一遍**，就是 20 s+。
再加 265 个文件的指纹计算，直接突破 30 s 超时。

**② 侧边栏内容是「文档」不是「仪表盘」。**
即使数据正确，首屏也是九张说明卡（连接引导、自检、配置入口、提醒、明细、通道状态、目录地图…），
真正关心的四个数字埋在最下面。这不是显示 bug，是职责错位。

**结论**

**性能侧：**

1. `/status?fast=1`：**完全不访网**。`fast` 时 `channelState({fetch:false})`，
   `behind/ahead` 仍照算（那读的是本地 `origin/<br>` ref，不是网络），但置 `stale:true` 明说可能陈旧。
   实测 **10562 ms → 593 ms**（快 18 倍）。
2. `fetchRemoteCached`：8 秒 TTL，且**存 Promise**——并发请求共用同一趟网络往返。
3. 侧边栏轮询改成 20 s 一次快接口；慢接口（`preflight`/`self-check`）只在
   首屏、手动刷新、以及隔 5 分钟的定时里跑。超时从 30 s 提到 60 s。

**体验侧：**

4. 新增 `dashCard`，放在 `body` **第一张**：
   - 一句话结论（已同步 / 还有 N 处变动 / 落后 N / 还没连仓库）
   - 四个数字格子：待同步 / 落后 / 待推送 / 自动同步开关
   - 「下次自动：约 N 分钟后 · 空闲 20 分钟触发」（后端新增 `auto.nextAt`）
   - 三个按钮：提交并推送 / 拉取并应用 / 重新检查（推送拉取按钮不再藏在下面）
5. 说明性卡片（目录地图、受控删除、蒸馏文档、新主机安装）全部收进一个 `说明与其他` 折叠区。
6. **`own=null` 时不再显示「还缺两个仓库地址」**：没拿到数据 ≠ 没配。
   这条误导信息会让用户去重填已经正确的配置，比单说「没数据」更糟。

7. **版本错配（刷页面 vs 重启）有回退**：`client.js` 改一次只要刷页面，`index.js` 改一次必须完全重启，
   两者错配是常态。旧宿主半不返回 `summary`，若直接取 `sum.unsynced || 0` 就得到四个 0 →
   仪表盘显示绿色「已同步，不用管」。**那又是一次假绿**（与 ADR-026 同型：把「没查」当「没事」）。
   所以前端保留回退：`summary` 缺失时从旧字段（`dirty`/`payloadMissing`/`scanned`）自己算，
   并在仪表盘底部显式提示「宿主半还是旧版（vX），上面的数字由旧字段推算，不是精确值」。

**反面代价**

- `fast` 模式的 `behind/ahead` 基于上次 fetch 的 ref，**可能陈旧**。
  已用 `stale:true` 标记，但没有在 UI 上显著提示（只在数值上体现）。
- 侧边栏「待同步数」在首帧可能显示上一轮的值（`scan` 只在慢路径跑），
  新的一行注释会说明「精确值正在后台统计」。
- `fetch` 缓存 8 秒：刚 push 完立刻看另一个通道，可能看到旧值，最多晚 8 秒。
- 慢接口仍要 40 s 左右，只是不再阻塞首屏。**没有优化指纹计算本身**，
  如果本机文件数再翻倍，这个值还会涨。

**已否决的替代方案**

| 方案 | 否决理由 |
|---|---|
| 只把前端超时提到 120 s | 把 40 s 的卡顿当正常；用户还是会看到一个长时间空白的侧边栏 |
| 把 `pending` 也放进 `fast` 模式 | 要扫 87 MB / 95 个文件算指纹，轮询接口承受不起（ADR-026 同结论） |
| 侧边栏只保留仪表盘，删掉所有说明 | 新用户不知道去哪配；说明仍需要可查，所以改为折叠而非删除 |
| 把说明文字缩短 | 已经被缩过一次，仍然是九张卡；问题是「全部展开」而非「文字长」 |
| 取消 `fetch`，只看本地 ref | 就永远看不到另一台机器推了什么（ADR-026 的核心风险） |

**验证**

- `test/render-smoke.cjs` 新增 6 条：仪表盘显示待同步数 / 四格子 / 「下次自动」/
  手动按钮存在 / 一句话结论在最前 / **`own=null` 时不得出现「还缺两个仓库地址」**。
- `test/synchub-smoke.cjs` 改断言：从「应有引导卡」改为「**own=null 时不得有**」，
  并新增「仪表盘必须是 body 第一张卡」。
- 六份 smoke + `node --check` 全绿。
- 实测：`fast` 593 ms vs `full` 11588 ms。

**口头约定**

「没拿到数据」与「数据说没配」是两件不同的事实。
UI 上任何一个「你需要去做 X」的引导，都必须只在**真正确认缺失**后才出现；
接口超时、还没返回、解析失败，一律只能报「还在读」或「读不到」，
绝不能推演出一个需要用户行动的错误结论。

---
## ADR-029 · 0.6.0：「立即同步」主按钮 —— 下班点一下全上线

**背景（用户 2026-11-18 提出）**

> 那是不是增加一个立即同步的按钮。比如下班时候我在单位A点击后就都到线上了
> （如果还在处理就等20分钟后处理完成后再同步）

用户的心智模型是对的，但「等 20 分钟后再同步」不需要做：
自动推送的闸门不是「等某个任务完成」，而是「空闲 + 有变动 + 不落后 + 不在冷却期」。
手动点同步时**根本不走这套闸门** —— `/sync` 就是拉+推一口气，不存在排队。

**结论**

1. 仪表盘主按钮改为「立即同步」，点它 = `POST /api/dsh-synchub/sync {pullFirst:true}`：
   拉取（ff-only）→ 应用 → 暂存 → 提交 → 推送，五个步骤一次做完，逐步报告。
2. 旧的「提交并推送」「拉取并应用」降为次按钮（带 title 提示与「立即同步」的区别），供只想单向操作的人用。
3. 拉取阶段失败（含分叉的非快进）时同步整体失败并返回原因，前端检测到「非快进」
   提示改走分叉卡（ADR-030）。

**反面代价**

- 「立即同步」隐含一次网络往返全套（fetch + push），在弱网下可能较慢，
  按钮期间显示「同步中…」且不可重复点击。
- `pullFirst:true` 对领先未落后场景是一次冗余 fetch（几百毫秒），
  换取的是「不需要用户判断当前是哪种状态」。

**已否决的替代方案**

| 方案 | 否决理由 |
|---|---|
| 实现「排队：等 20 分钟后自动同步」 | 误解了闸门机制；手动同步本来就是即时的，不需要排队 |
| 把自动推送的空闲判定改成检测 agent 是否在跑 | `idleStandard()` 已声明：不检测 DSH 会话里有没有 agent 在跑，只按面板/接口手动操作计时（ADR-028 前的既定边界） |
| 立即同步 = 只推送不拉取 | 下班场景应该先把远端状态拉下来再推，否则若家里推过就分叉 |

**验证**

- `test/render-smoke.cjs` 新增：仪表盘主按钮是「立即同步」且旧纯推送仍在。
- 七份 smoke + `node --check` 全绿。

---
## ADR-030 · 0.6.0：分叉（diverged）不做三方合并，给二选一 + 双向备份

**背景（用户 2026-11-18 提出）**

> 我到家之后……是不是在侧边栏提醒，并且可以手动拉取，如果有冲突还可以选择
> 如何做，云覆盖本地或者本地覆盖云，还是说有更好的 merge 策略

现状：落后提醒、切换检测、手动拉取都已存在（ADR-026/ADR-028）。
缺的是「两台都各自推过」这个状态的产品化 —— 以前 `/pull` 会撞
「需要人工处理（非快进）」然后失败，用户只能手动进仓库改。

**结论**

1. **不做三方合并**。会话面是 append-heavy 的 JSONL 与 zstd 压缩块，
   git 文本合并在这种文件上产出的是语法上就无法读的结果（ADR-014 已有
   zstd 多帧风险证据）；配置面 YAML 键序无语义，合并冲突没有正确答案。
   同步引擎的既定模型是「机器轮流」：一台推完另一台才能动。
2. 分叉时面板出现「分叉处理（二选一）」卡：
   - **以本机为准（覆盖云）** = `resolveKeepLocal`：全量 stage+commit 后
     `push --force-with-lease`，远端被覆盖成本机样子。
   - **以远端为准（覆盖本机）** = `resolveKeepRemote`：`reset --hard origin/<br>`
     （丢本机独有提交）+ `applyPayload` 落盘（`backups/<ts>/` 自动备份被覆盖文件）。
3. 覆盖前把被覆盖一侧的提交哈希（前 50 条）写入 `backups/diverge-<ts>/`，
   反悔时可用 `git cherry-pick` / reflog 找回。
4. 「看两边的提交」按钮先预览（`GET /diverge`）再决定，避免盲选。
5. `mode` 参数无默认值：不传直接 400，手滑不会默默选边。

**反面代价**

- 被覆盖一侧的提交从分支历史里消失（只剩哈希备份文件），
  不是 git 层面的分支保留；恢复需要手动 cherry-pick。
- `--force-with-lease` 推送后，第三方（若有）拉取会看到非快进 ——
  但本插件场景只有两台机器，无第三方。
- 二选一是**有损的**：一个方向的提交内容会丢。这是刻意设计：
  与其给一个看不出对错的合并结果，不如给一个明确有损但可预览可恢复的选择。

**已否决的替代方案**

| 方案 | 否决理由 |
|---|---|
| git 三方合并（merge/rebase） | JSONL/zstd 文本合并产出不可读结果（ADR-014）；YAML 键序无语义 |
| 文件级 merge（每文件选边） | 会话目录是数百文件互相引用的整体（workspace.json ↔ .zstd ↔ projcache，ADR-004），逐文件选边会造出引用不一致的状态 |
| 冲突时自动以时间戳新的一方为准 | 时间戳不可靠（机器时钟不同步）；且用户应看得到丢了什么 |
| 建一个合并分支让用户手工解决 | 用户是两台机器的同步场景，不是协作开发；多一个分支多一个永久分歧点 |

**验证**

- `test/diverge-smoke.cjs`（新增）：路由注册 / 非法 mode 400 / 初始态无仓库安全跳过 /
  无 remote 安全降级 / diverged 判定源码护栏。
- `test/render-smoke.cjs` 新增：分叉时二选一卡出现 + 一句话结论明确说普通同步会失败 + 普通拉取提醒不走。
- `test/synchub-smoke.cjs` 改断言：20 条路由（含 diverge / diverge/resolve）。
- 七份 smoke + `node --check` 全绿。
## 待办 / 后续候选（未形成决策，仅登记）

| 议题 | 触发条件 | 备注 |
|---|---|---|
| ~~`purgeSession` 受控删除功能~~ | ~~归档项多到影响使用、或确需 GDPR 式清除~~ | **已实现 2026-11-17**，见 ADR-013；备份 + 静止校验 + 原子改多处 + 回滚点 + 二次确认 |
| ~~会话移动 / cwd 改写~~ | ~~工作区必须换路径、且无法用相同路径（ADR-002）解决~~ | **评估完成 2026-11-17：不做**，见 ADR-014（源码级 immutability 证据 + zstd 多帧风险；用 ADR-002 相同路径 / ADR-006 知识持久化替代） |
| ~~compact 输出自动蒸馏为文档~~ | ~~人工蒸馏被证明太麻烦~~ | **已实现 2026-11-17**：定位为人工蒸馏文档（非自动导出），模板 + confirm 闸门，见 ADR-015 |
| ~~同步面板接入真实状态~~ | ~~`dsh-synchub` 配好两个远端后~~ | **已实现 2026-11-17**：`status.state` + `GET /state` 暴露状态目录真实磁盘状态（初始化/仓库/回滚点），见 ADR-016 |
| 把两个通道合并为一个仓库 | 真觉得两套地址麻烦、且愿意接受大提交 | 代码不禁止两通道填同一地址，但仍是两个工作副本；真合并需改 `SURFACES[].channel` + `repos/` 布局（ADR-019） |
| ~~自研插件是否发布到市场~~ | ~~需要在第二台机器之外分发时~~ | **决策完成 2026-11-17：维持本地分发**（用户拍板），见 ADR-017；不改 private、不发布市场；开源质量门槛另行处理（见 C 项清单） |
| ~~面板显示「已同步」但仓库实际为空~~ | ~~配好远端、看似一切正常、但 GitHub 上没东西~~ | **已修复 2026-11-18**：`dirty` 语义错误 + `branchOf` 硬写 `main`，见 ADR-026；新增 `unsynced`/`pending`/`payloadMissing` 与 `unsynced-smoke` |
| ~~`dsh-config` 里的旧 `snapshots/` 是否清理~~ | ~~确认那些提交无历史价值时~~ | **已完成 2026-11-18（用户拍板「删除」）**：`git rm -r --cached snapshots` + 物理删除 29 个文件，提交 `ab7f449` 并推送。仓库现只有 `payload/`（21 文件），`snapshots` 计数为 0。备份在 `backups/pre-branch-unify-20261118-151627/`（refs/log/status）。 |
| ~~两个通道仓库的分支名不一致（`master` vs `main`）~~ | ~~觉得「打开 GitHub 看到两个不同默认分支」碍眼时~~ | **已完成 2026-11-18（用户拍板「改为统一的、按新标准」）**：`git branch -m master main` + 推送 + GitHub API 改默认分支 + 删远端 `master`。两仓库现均只有 `main` 一个分支。插件仍能自适应 `master` 仓库（ADR-026），不依赖这个结果。 |


---

## ADR-031 · 0.7.0：工作区改名后会话归属迁移（session-move）

**日期**：2026-11-19
**背景**：用户把 `C:\dsh\base` 改名为 `C:\dsh\dw-base`，并在 DSH 里重新添加工作区。结果旧工作区的 10 个会话在侧边栏全部显示为「未分组」 —— 数据没丢，`sessions\--C-dsh-base--\` 下的正文完好，是「归属」丢了。

### 结论

新增 `session-move` 路由，把会话从 A 工作区搬到 B 工作区。两处必须同时改：

| 位置 | 作用 | 不改的后果 |
|---|---|---|
| `storages/workspace.json` 的 `tables.workspaces[wsId].sessionIds` | 侧边栏按这个分组 | 显示「未分组」 |
| `sessions\<组目录>\<会话id>\` | 正文按这个存 | 打开是空的 / 找不到 |

组目录名是**路径编码**：`C:\dsh\dw-base` → `--C-dsh-dw-base--`（盘符与分隔符都换成 `-`，两侧加 `--`）。这是本次实测确认的规则，编码函数 `encodeWorkspaceGroup` 已对 14 个真实目录交叉验证通过。

### 理由

- **这是改名后的必然产物，不是 bug。** DSH 用路径标识工作区，路径一变就产生新 id，旧 id 的会话自然"掉队"。插件不能阻止改名，但必须让改名后可恢复。
- **必须自动化而非手改 JSON。** 涉及正文目录搬迁 + `workspace.json` 嵌套数组编辑，手改两处极易漏一处；漏了就是"看起来恢复了、点进去是空的"。
- **必须可回滚。** 搬会话是不可逆操作。顺序固定为：备份 → 复制 → 校验（文件数 + 字节数）→ 删源。任一步失败都保留源目录，用户数据零风险。
- **批量能力是刚需，但边界要比单个更保守。** 用户一次有 10 个会话要搬，逐个敲 id 不现实。批量**只碰未登记的会话**（`registered.has(n)` 为假），属于别的工作区的一个都不动。

### 反面代价

- 会话正在写入时拒绝迁移（30 秒内有活动 / 有未结束 turn），用户必须等它停下来。这是刻意的：搬正在写的 zstd 多帧日志会损坏数据。
- `projcache` 里的 `cwd` 不改。它是派生缓存，DSH 下次打开会话会自动重建；但重建前的那一小段时间里，如果别的功能读 `cwd` 会读到旧路径。
- 目标工作区必须已在 DSH 里注册过（打开一次即可）。如果用户想"直接搬到还没创建的工作区"，得先建再搬 —— 两步骤。
- 批量迁移会删掉旧组空目录。如果那个路径以后又要用（比如改回来），组目录得重新生成（DSH 自动做，但会是个新目录）。

### 已否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 让用户手改 `workspace.json` | 嵌套对象 + 数组，改错一个逗号 DSH 起不来；且正文目录还得单独搬，两处漏一处就半残 |
| 只改 `workspace.json`，不搬正文目录 | 侧边栏分组正常了，点进去是空的 —— 静默数据错乱，比「未分组」更难发现 |
| 只搬正文目录，不改 `workspace.json` | 依然显示「未分组」，等于没做 |
| 用 `rename` 原子搬移 | 跨组目录可能跨设备/跨卷，`rename` 会失败；复制-校验-删除虽然慢但每步可验证 |
| 迁移时顺便改 `projcache` 的 `cwd` | 缓存格式属于 DSH 内部实现（v7），改它等于猜格式；不改也能自愈，不该越界 |
| 自动迁移所有未分组会话（无需确认） | 用户可能有会话是**故意**留在旧路径的（比如跨项目上下文）；无提示地搬会打乱他的组织方式 |

### 验证

- `sessionmove-smoke.cjs` 7 组断言全过，其中 B 组对磁盘上 14 个真实组目录做了编码/解码交叉验证。
- 真实迁移实测：10 个会话（1 单迁 + 9 批量）全部 `verify.ok = true`，旧组目录已清空删除。
- 回滚点：`C:\Users\franc\.dsh\dsh-synchub\backups\move-<时间>-<会话id>\`


---

## ADR-032 · 0.7.0：「查不到」不许画成「一切正常」（假绿第三次）

**日期**：2026-11-19
**背景**：用户问「dw-base 我还没建仓库，你这个同步成功是从哪里检查来的」。查下去发现是真 bug：`codeRepos` 指向 `C:\dsh\base`，目录已改名不存在，`codeRepoState` 返回 `exists:false`，但 `unsynced/ahead/behind` 保持初始值 `0`；前端把三个 0 画成 `✓ 已同步`。

这是同一类错误的**第三次**：ADR-026 定过「版本错配不许显示四个零」，但只修了那一个场景，没有把规则推广开。

### 结论

代码仓库的每一行有**四种**状态，必须分开画，不许合并成"零 = 正常"：

| 状态 | 判据 | 图标 | 文案 |
|---|---|---|---|
| 读不到 | `r.error` 非空 | 红 `✗` | 直接显示 `error`（如「目录不存在」） |
| 没连远端 | `r.remoteMissing === true` | 黄 `!` | 「未连远端：本地有提交也无处可推，先在设置里填仓库地址」 |
| 有差异 | `unsynced/ahead/behind > 0` | 黄 `!` | 「N 未提交 · N 领先」 |
| 真已同步 | 有远端且三数全零 | 绿 `✓` | 「0 未提交 · <commit>」 |

关键改动：`codeRepoState` 现在在两处设 `remoteMissing` —— 一是 `status --branch` 里没解析到 upstream 时（仓库有远端但当前分支没跟踪），二是函数末尾 `if (!out.remote)`（完全没有 origin）。**第二个是这次补的**：`dw-base` 就是"有 commit、0 未提交、0 领先 0 落后、但根本没有 origin"，三个零在这里毫无意义。

### 理由

- **零是"没有差异"，不是"检查过了"。** 没远端时 `ahead/behind` 恒为 0，因为比较对象不存在。把这种情况画成 ✓，等于告诉用户"你安全"，而实际上他的提交只在本机、硬盘坏了就没了。
- **`error` 字段早就返回了，前端没看。** 这是设计疏漏：后端诚实（`exists:false, error:'目录不存在'`），前端只看数字。规则应该是「后端说有问题，前端必须显式呈现」，而不是「数字是零就绿」。
- **三种非绿状态要给不同动作。** 读不到 → 去改路径；没远端 → 去填仓库地址；有差异 → 点同步。合并成一个"异常"图标，用户不知道该做什么。

### 反面代价

- 多一个字段 `remoteMissing`，前端多一层三元。状态判断从「四个数字」变成「error / remoteMissing / 数字」三段，代码更啰嗦。
- `dw-base` 现在会一直显示黄色「未连远端」，直到用户真的建了 GitHub 仓库。这是**故意的**：它确实没同步到任何地方，不给绿色是对的。用户可能会觉得"我本地明明提交了为什么是黄的" —— 文案必须说清「本地有提交也无处可推」。
- 每次新增仓库字段，都要问一遍「这个字段为空时会不会被当成正常」。这是持续成本。

### 已否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 有 `error` 就把整张卡隐藏 | 用户会以为"卡片没了 = 没配置"，但实际上是配置错了 —— 比显示错误更糟 |
| 把所有非绿状态合并成一个「异常」 | 三种状态要三个不同动作，合并后用户不知道点哪里 |
| 没远端时显示 `ahead` 为「?」 | 前端已经有三种图标语义，再引入一个问号会让图例失控；用黄色 `!` + 明确文案更直接 |
| 自动给仓库配一个默认远端 | 猜用户想推到哪等于替他做决定；推送目标是用户的事 |

### 验证

- `render-smoke.cjs` 新增断言：`没登记代码仓库时不显示代码仓库卡`、`登记了代码仓库时显示卡片与同步按钮`、`代码仓库卡显示未提交数与分支`。
- 实测：配置改正后 `dshwp-plugin` 绿（有远端、0/0/0），`dshwp-base` 黄（无远端）。


---

## ADR-033 · 0.7.0：侧边栏用 20 分钟缓存，打开不再强制联网

**日期**：2026-11-19
**背景**：用户原话「侧边栏每次点击都要重新去刷新，能否设定一个刷新时间，如果没到就以上次结果显示，但是提示上次检查是什么时候，可否和 20 分钟刷新结合，简化处理」。

### 结论

在**模块级**（组件外）加一份 `PANEL_CACHE`，TTL 20 分钟：

- `useState(() => PANEL_CACHE.own)` —— 首帧直接用上次结果，不是 `null`。
- `panelCacheStore()` 在每次成功刷新后回写。
- 头部时间改成 `checkedAtText()`：`14:32 的结果（15 分钟内沿用，打开不用等）`。

**关键：命中缓存不等于不刷新。** `refresh(false)` 照常跑，只是首帧已经有内容了，`loading` 判定（`!own && !err`）自然为假，用户看不到「正在读取本机状态…」。数据依然会被更新，只是不再让他等。

### 理由

- **组件内 `useState` 救不了这个问题。** 侧边栏收起时面板**被卸载**，所有 state 丢失。下次打开必然是空 → 只能重新请求。缓存必须放在模块作用域（进度条消失、组件销毁都不影响）。这是 React 生命周期事实，不是设计选择。
- **20 分钟和已有的两档刷新不冲突，是互补的。** 已有的：20 秒快接口轮询（面板开着时保持新鲜）、5 分钟全量刷新（含 preflight/self-check 慢接口）。20 分钟 TTL 只管一件事：「刚打开那一瞬间要不要等网络」。面板开着时轮询负责新鲜度，关着时不需要新鲜度 —— 这两个时段覆盖了全部时间线。
- **不能只显示「检查于 14:32」。** 用户看不出这个时间是 1 分钟前还是 40 分钟前，也就判断不了该不该点刷新。文案必须同时给出「有多新」和「接下来会怎样」，这才是 ADR-026 那套「状态要回答我要不要管」的落实。
- **"简化处理"按用户原话理解，就是复用 20 分钟这个数。** 不再引入第三个时间参数（已有 20 秒 / 5 分钟 / 空闲阈值 / 过期小时数四个），多加一个只会让配置更难懂。

### 反面代价

- **打开侧边栏可能看到 20 分钟前的数据。** 文案会明说「已过 N 分钟，正在后台更新」，但用户如果只看图标不看文字，可能误判。这是为了省掉等待而付出的代价。
- **缓存跨机器/跨配置不失效。** 如果用户在设置里改了配置再回侧边栏，20 分钟内仍显示旧结果（后台会更新，但不是立刻）。手动点「刷新」可以强制。
- **多了一份全局可变状态。** 测试要额外覆盖，且模块级状态在热重载时可能残留。已经用 `panelCacheFresh()` 的 TTL 兜住"永不更新"的情况。
- 20 分钟是拍的数，没有数据支撑。选它的理由是「和用户提的数值一致」，且长于 5 分钟全量刷新周期，不会出现"缓存比刷新还旧"的错位。

### 已否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 缓存放 `useState` / `useRef` | 组件卸载即丢，下次打开照样等网络 —— 等于没做 |
| 打开时先渲染缓存、完全不刷新 | 用户回来后可能 20 分钟甚至几小时没更新，看到的是彻底过期的数据，且没有任何"正在更新"的提示 |
| 用 `localStorage` 持久化 | 跨会话/跨版本会读到旧 schema，且 `client.js` 热更新后旧结构会炸；模块内缓存随页面刷新清掉，刚好够用 |
| 缓存 5 分钟（对齐全量刷新） | 用户提出的就是 20 分钟；且 5 分钟太短，打开还是要等的情况很多 |
| 只显示相对时间（「3 分钟前」） | 用户还要自己算"3 分钟前算不算久"；直接说「N 分钟内沿用」把结论给了 |
| 打开时不显示任何时间 | 用户不知道数据新旧，会怀疑面板坏了（这正是 0.5.9 之前"未配置"假象的成因之一） |

### 验证

- `render-smoke.cjs` E1 段 7 条断言：缓存是模块级、TTL 是 20 分钟、首帧用缓存初始化、刷新回写缓存、有 `checkedAtText`、文案含分钟数、无时间时显示「尚未检查」。
- 三条断言里最关键的是「首帧用缓存初始化（不是 null）」—— 写成 `useState(null)` 的话，缓存再存也没用，首帧依然是加载态。



---

## ADR-034 · 0.8.0：会话掉进「未分组」是一对指针同时错位，体检必须两半一起修

**日期**：2026-11-21
**背景**：用户原话「侧边栏可以增加一个功能 session 修复，当目录改了名字可以自动检查修复常见问题么 如果出现问题比较麻烦 有时候完全不能工作」。

这不是第一次。`session-7e2afa3c` 那次会话就是同一件事：用户把 `C:\dsh\dshplug` 改名为 `C:\dsh\dw-plugin` 之后，
原来的会话全部变成「未命名」并掉进「未分组」，用户「删除又添加」也没用，反而多出一批 `default-workspace` 的幽灵组。
上一次（ADR-031）做的是 `session-move`：一个会话一个会话地搬。**够修单条，不够排查**——
用户不知道哪几个坏了、为什么坏、还剩几个。这次把它做成可体检、可分级的工具。

### 结论

新增 `lib/sessiondoctor.js` 独立引擎 + `GET/POST /api/dsh-synchub/session-doctor`，
侧边栏加「⑤ 会话体检与修复」卡。核心判据一条：

> **会话正文目录的位置，与它在 `workspace.json` 里的归属，必须同时正确。** 只对一半就是坏的。

扫描只读、永不写盘；执行必须带 `confirm:'REPAIR'`，先备份 `workspace.json`，再逐动作应用，最后**自动复查**。

### 理由

**为什么必须两半一起改**。这是本 ADR 最重要的结论，也是上一版最容易误解的地方：

| 改了什么 | 用户看到什么 |
|---|---|
| 只改 `workspace.json` 登记（不搬目录） | 侧边栏里出现这条会话，**点进去是空白** —— 比原来更糟，因为看起来"修好了" |
| 只搬正文目录（不改登记） | 文件齐全，但侧边栏里永远不显示，等于没修 |
| 两半都改 | 正常 |

DSH 在目录改名后会为该新路径**新建**一个 `workspaceId`，旧记录留着但指向死路径。
所以「把工作区删掉再加回来」不但不修，还会制造第二份登记（→ `duplicate-ref`）。

**为什么不做反向解码**。`sessions/` 下的组目录名是把绝对路径 munge 出来的（`C:\dsh\dw-base` → `--C-dsh-dw-base--`），
但分隔符和路径里本来就有的 `-` 无法区分：`C:\Users\franc\Documents\deepseek-harness\default-workspace`
反解会得到 `deepseek\harness\default\workspace`。**因此一律正向编码比对**（把候选路径 encode 成组名去比），
`encodeGroup` 与 `index.js` 的 `encodeWorkspaceGroup` 有逐字符交叉断言（smoke A1），两处实现不许漂移。

**为什么必须排除 subagent**。本机 104 个会话目录里有 13 个是 subagent（`origin:'subagent'`、
`delegationDepth:1`、有 `parentSession`），它们的目录名是**裸 uuid** 且**故意**不进 `sessionIds`。
初版把「未登记」一律报出来，结果 22 条全是 subagent —— 典型的狼来了。现在 subagent 不参与任何修复判断。

**为什么改指不猜目标**。旧路径已经不存在，没有任何可靠线索指向新名字。
按名字相似度排序只是把最像的排在前面给个默认值，执行时必须由调用方在 `targets` 里显式指定 `wsId`
（smoke D2：不给 `targets` 就跳过并说明原因，目录原地不动）。猜错会把一批会话塞进错的工作区，
用户要在两个错误之间再修一次 —— 比不修更麻烦。

**为什么只读扫描要写进测试**。`doctorScan` 是「先看一眼」的入口，用户会毫无顾虑地点它。
一旦它偷偷写盘，"看看"就可能变"改掉"。smoke I1 直接切出 `doctorScan` 函数体，断言里面**不存在**
`writeFile` / `fsp.rm` / `fsp.cp` / `copyFile` / `mkdir` 任何一个。

### 反面代价

- **体检比别的接口贵**：要遍历 104 个会话目录、对每个首帧做一次 zstd 解压。所以它**不自动跑**
  （不进 `useEffect`、不进 20 秒快轮询、不进 `PANEL_CACHE`），必须用户点「开始检查」。代价是用户得知道有这个按钮。
- **只解首帧**：`.zstd` 是多帧拼接（本机 `session-7e2afa3c` 是 933 帧 / 1.7 MB → 5.8 MB），
  `zstdDecompressSync` 只解第一帧。这刚好够拿 header（`type:"session"` 那行），
  但**不能**用它判断会话是否完整 —— 所以 `counts.broken` 只表示"找不到 `session.v4*` 文件或首帧读不出"，不表示内容损坏。
- **`group-mismatch` 只在"登记唯一"时才自动修**：一个会话被登记进两个工作区时该搬去哪组本身就不确定，
  这时只给 `duplicate-ref` 让人选，不自动搬。
- **改完要重启**：`workspace.json` 是宿主启动时读的，改完侧边栏不会自动重排。
  面板文案写明了这一点；不说的话用户会以为没生效。
- **多一个文件**：引擎单独成文件是为了能单测和被 `__test` 引用，代价是 `exports`/打包要多带一个文件。

### 已否决的替代方案

| 方案 | 否决原因 |
|---|---|
| 直接删掉 `workspace.json` 让它自己重建 | 会丢 `title` / `pinnedSessionIds` / `archivedSessionIds` / 默认工作区，且历史会话全部变「未分组」——把小病治成大病 |
| 反向解码组目录名得到路径 | `-` 语义歧义，`deepseek-harness` 会被拆成两级目录（本机真实存在这个路径，已踩） |
| 修 `sessions/` 目录名就顺手改 `workspace.json`，不做预览 | 用户看不到会改什么，也没机会否决「改指到哪个」 |
| 自动按名字相似度选目标并执行 | 猜错概率不低（`dw-base` vs `dw-plugin` 相似度都高），一旦错了整批会话进错工作区 |
| 把 vault 里的会话"导入"到新工作区（复制而不是移动） | 会产生两份正文，两边继续增长，之后无法判断哪份是活的 |
| 用 `fs.renameSync` 直接改目录名 | 跨卷失败、且没有校验步骤；现在是「复制 → 逐字节/逐文件校验 → 删源」，失败时源还在 |
| 把体检合进 `self-check` | `self-check` 是"能不能开工"的快速判断，要便宜；体检是重活，混在一起会让首屏变慢 |
| 把 doctor 塞进 `index.js` | 已经 3500 行，再塞 700 行无法单测也无法 `node --check` 快速定位 |

### 验证

- `test/sessiondoctor-smoke.cjs` **17 条断言**，10 个套件全绿。关键的是三类"反向"断言：
  干净现场**不许**报 error / 不许给 safe 动作（B1）、无 `confirm` 必须拒绝**且一个字节都不写**（G1）、
  subagent **不许**被当成未分组（F1）。
- 真实数据端到端：本机 `~/.dsh` 实扫 14 组 / 104 目录 → 13 条 finding（7 warn + 6 info）、0 error，
  与本轮手工审计（104/104 首帧可解、0 groupMismatch、0 missingOnDisk）完全一致。
- HTTP 层实测：`GET` 200 + 真实结论、`/help` 200 + 9 类问题表、`POST` 不带 `confirm` → **400** 且错误信息可读。
- 前端不是只有源码正则：`render-smoke.cjs` 新增 **E0c 段 19 条真渲染断言**（未扫描 / 有发现 / 报错 / 干净
  现场 / 缺字段五态）。它当场抓到一个真 bug：`act0.payload.candidates[0]` 在旧版宿主半
  （不给 payload）或候选为空时抛 **渲染期 TypeError** → 整块侧边栏白屏，而且没有任何提示。
  已改成 `candsOf(act)` / `firstCand(act)` 两个安全取值函数，并加两条源码护栏（不许裸下标 + 必须
  对非数组返回 `[]`）。**变异测试过**：把 `Array.isArray` 保护去掉，该断言立即变红。
- 这条 bug 正是「任务 7：测试」的真正价值所在：E0b 那 7 条正则全绿的时候，
  白屏风险一直存在。断言能过不等于界面能开，正则看得见代码看不见求值。
- 钩子序单独验过：同一组数据连续渲染两次，`trail` 序列完全一致（条件 hooks 会让真 React 抛错）。

> **为什么不自动重建那 44 个会话的工作区登记**：用户已明确回复「不用重建了，现在已经恢复了所需内容」。
> 体检只负责把它检出来并给出一键动作，执行与否用户决定。

---

## ADR-035 · 0.9.0：把体检从「9 类巡检」砍到「会话能不能打开」

### 结论

体检引擎只对**一根轴**负责：**这件事会不会让会话打不开 / 看不见**。
每条 finding 新增 `impact` 字段，只取两个值：

| impact | 含义 | 引擎行为 |
|---|---|---|
| `blocking` | 用户打不开 / 看不见 / 工作区开不了 | 进救援范围；`safe:true` 的进 `rescue.ids`，一键修 |
| `advisory` | 只是不整齐，不影响使用 | **只报告，永不自动修**，需用户单独点 |

`summary.health` 三态：`ok`（都能打开）/ `repairable`（打不开但一键能修）/ `needs-human`（打不开且必须人给目标）。
**不传 `ids` 的 `POST` 默认只跑 `rescue.ids`**（旧行为是「全部 safe 动作」，会顺手删空组、去重）。

判据原文用用户的话写：「如果报错了先修复避免不能用，就可以了，其他的交给专业的 session 管理插件」。

### 理由

**上版错在把「整不整齐」当成了自己的职责。** 0.8.0 的 9 类问题里，`duplicate-ref`、`empty-group`、
`orphan-group-dead` 三类即使存在，用户照样能打开会话。把它们摆在首屏、还给一键按钮，
实际效果是：**体检报一堆红字，用户以为自己坏了，其实没坏。** 这是第四次「假红」
（前三次是假绿）。

而且这三件事本来就有专业工具在做：会话管理插件能看到列表、能批量整理。synchub 抢着做，
结果是两边都能改 `workspace.json`，出了事无法定位是谁改的。

**为什么不能反过来全降 advisory。** 实测本机：把 `orphan-group-*` 也降成 advisory 后，
`health` 报 `ok`、排查列表清空 —— 但侧边栏里明明躺着 7 个未分组会话。那是**假绿**，
边界不是「要不要管这事」，而是「会话能不能打开」：未分组会话其实还能从「未分组」里点进去，
但它的归属确实丢了（改名后没归位）；而 44 个会话那个 `orphan-group-recoverable` 是登记彻底丢了，
侧边栏根本列不出来。两者都是 blocking，只是修法不同。

### 反面代价

- **advisory 默认不自动修**：用户如果真想清空组目录 / 去重，得多点几下。
  缓解：advisory 项仍然有自己的按钮（共用的 `actRow`），只是不进一键，不是没入口。
- **`needs-human` 状态经常出现**：本机实测 7 条 blocking 全部 `safe:false`，
  所以一键按钮**不出现**，需要人逐条选目标。这是故意的：猜错比不改更糟，
  但它确实意味着「点一下就好」并不能适用于所有故障。
- **多一个维度**：`impact` 与 `severity` 正交（`workspace-path-missing` 是 blocking + error，
  `orphan-group-recoverable` 是 blocking + warn）。两个字段都得看，多一层心智负担。
- **旧客户端的兼容成本**：旧 client 不认识 `health`/`rescue`，会继续按 `summary.error/warn` 分级，
  且会调不带 `ids` 的 POST —— 此时后端已经改成救援范围，所以旧界面会看到「按钮叫一键修安全项，
  实际只修了一部分」。已做：`healthOf()` 在缺 `health` 时从 `summary.error/warn` 降级推导。
  但**升级时必须重启 DSH**（`index.js` 改了），否则会出现新 client + 旧宿主半的组合。

### 已否决的替代方案

| 方案 | 否决原因 |
|---|---|
| 保持 0.8.0 的「9 类都管」，只把文案改温和 | 问题不在文案，在职责。摆一堆不影响使用的项就是在制造焦虑 |
| 把三类整活项直接删掉不报告 | 用户看得见侧边栏里有空组，工具装作不存在就是第二次「假绿」 |
| 用「严重程度」代替 `impact` 分级 | `severity` 已经在用了，且它与「能不能用」没有对应关系（空组是 info，但 rebuild 44 个会话是 warn — 两者都不是 error） |
| 把所有 advisory 都改成 `safe:false` 来防止误改 | 那就退化成上上版的「全部要二次确认」，用户每点一下都多一步 |
| 让 synchub 把会话管理功能也做了 | 用户明确反对：「其他交给专业的 session 管理插件」；且两边都能改 `workspace.json` 会让故障无法定责 |

### 验证

- `test/sessiondoctor-smoke.cjs` 从 17 条增到 **23 条**，新增 J 组 6 条专盯职责边界：
  - J1 干净现场 `health=ok` 且 `rescue.needed=false`；
  - J2 `dangling-ref` 必须 `impact='blocking'`、`health='repairable'`；
  - **J3 只有空组目录时 `health='ok'`、`blocking=0`** —— 防止把整活项算进不能用；
  - **J4 一键救援（不传 `ids`）只动 `blocking` 且不碰空组目录** —— 直接比对 `r.applied` 的
    `kinds` 严格等于 `['drop-ref']`，并断言空组目录**仍在磁盘上**；
  - J5 `orphan-group-relocatable` 必须 `needs-human` 且**不进** `rescue.ids`；
  - J6 每条 finding 都必须有合法 `impact`，且 `blocking + advisory === total`（防漏网）。
- 实数据双跑比对（本机 `~/.dsh`，14 组 / 104 目录）：
  - 全降 advisory 的试错版：`health=ok`、`blocking=0` —— 与侧边栏里 7 个未分组会话矛盾，**已否决**；
  - 最终版：`health=needs-human`、`blocking=7`（6 个 `orphan-group-relocatable` + 1 个
    `orphan-group-recoverable` 带 44 会话）、`advisory=6`、`rescue.ids=[]`（全部 `safe:false`）——
    与手工审计完全一致。
- `render-smoke.cjs` **98 条全绿**。新增 6 条真渲染断言，分两组：
  - 「结论说能不能用而不是几条」「整洁项折进 details」「只有可一键救援的项进总按钮」；
  - **「本机真实态 `needs-human`」3 条**与 **「升级中间态（新 client + 旧 index）」2 条**。
    后者尤其重要：旧宿主半不返 `impact` 时 `blockingList` 必为空，
    若 `healthOf()` 的降级分支仍写「● 能修」，就是**承诺了一个不会出现的按钮**。
    已改成「● 要你定」+ `hint` 提示重启对齐版本。
- **变异测试过两条新断言**：
  - 把 `label: '● 要你定'` 改成 `'● 能修'` → `needs-human` 那条立即变红；
  - 删掉 `dh.hint` 那行渲染 → 旧版断言立即变红。
  后者还揭出一个自测陷阱：最初断言写 `/重启 DSH/`，而页面上**另一个卡也有这四个字**，
  所以删掉 hint 照样绿。改成只匹 hint 独有的「两半版本对齐」后才真正生效。

---

## ADR-036 · 0.10.0：单仓库模式（一地址 + 两分组开关）+ 全局 AGENTS.md 同步

- **日期**：2026-11-24
- **状态**：已采纳（已实现，待真机重启验收）
- **背景**（用户原话）：
  > 「synchub 现在同步是配置一个仓库 还有 session 一个仓库对吧 是否可以合并为一个，
  >  但是保留开关，两个都可以打开关闭 否则配置起来有点复杂 而且量也不大」

  同时问：每个工作区的 AGENTS.md（记忆文件）要怎么同步；已经开了「代码仓库同步」的
  GitHub 同步，是不是就在那里同步、不在 synchub 跑。

- **调研结论（先纠正两个前提）**：
  1. **两个地址填成同一个仓库 ≠ 合并**。两个通道是**两个独立工作副本**（`repos/config`、
     `repos/sessions`），各自 `.git`/分支/history；填同一 remote 后第二个通道推同分支必然
     落后/分叉（ff-only 拉不下来）。README §11.5 Q1 与 ADR-019 已写明。
  2. **工作区 AGENTS.md 已经同步了**。用户开了「代码仓库同步」（codeRepos，`git add -A`），
     `C:\dsh\dw-base\AGENTS.md` 已被跟踪并推到 `dshwp-base`（`git log` 实证）。
     synchub 只搬 `$DSH_HOME`，**刻意不碰工作区文件**，两者不会重复搬。
     真正没同步的只有**全局 `~/.dsh/AGENTS.md`**（不在任何同步面，也不在任何 payload）。

- **决策**：
  1. **单仓库模式** `cfg.mode==='single'`：一个物理仓库 `repos/all`、一个 `cfg.remote`；
     `config` / `sessions` 退化为**逻辑分组**，`channels.<group>.enabled` 成为**分组过滤器**
     （决定哪些同步面参与 stage/apply）。逻辑通道只剩 `'all'` 一个。
  2. **双仓库模式** `cfg.mode==='split'` 保留，且为**默认**（老配置没有 `mode` 字段，
     不能默认切成单仓库，否则会悄悄改掉已有用户的行为）。
  3. 引擎引入 `isSingle / channelsOf / repoKeyOf / remoteOf / groupEnabled / channelLabel`，
     并把 diff/stage/commit/push/pull/apply/channelState/status/preflight/checkAll/selfCheck/
     stateInfo/diverge/autoPush/路由全部改成「按 `channelsOf(cfg)` 循环 + 按 `repoKeyOf` 落盘」。
     单仓库下 payload 顶层路径不冲突（`sessions/` `storages/` `attachments/` `skills/`
     `profiles/` `AGENTS.md`），所以能共存于同一个 `payload/`。
  4. **新增同步面 `agentInstructions`**（config 组、safe、默认开）：只含全局 `AGENTS.md`。
     工作区内的 AGENTS.md 仍归各工作区自己的 git 管。
  5. 客户端不再写死 `channels.config` / `channels.sessions` 两行，改为按 `Object.keys(own.channels)`
     动态渲染；设置页加「仓库模式」下拉 + 单仓库下的一地址 + 两分组开关。

- **理由**：
  - 用户的两台机器数据量不大，两个仓库换来的「隔离」价值低于「要建两个仓库、填两个地址、
    看两套状态」的心智负担。单仓库把配置面从「2 地址 + 2 开关」压到「1 地址 + 2 开关」。
  - 分组开关保留了「只同步某一类」的能力，且现在**真的生效**（以前 `channels.<ch>.enabled`
    只影响 push/pull，stage/apply 仍会搬，名不副实）。
  - 全局 AGENTS.md 是用户跨机要一致的规则文件，且就在 `$DSH_HOME` 里，天然属于本插件的同步面。

- **反面代价**：
  - **失去通道隔离**：一个仓库坏了（远端误删、权限丢失）两类数据一起受影响；以前会话仓库坏了配置仓库还能救。
  - **提交历史混合**：改设置也会连带会话提交，`git log` 不如两仓分明（用户已明确接受「量不大」）。
  - **迁移不是自动的**：老用户要新建（或指定）一个仓库、填 `remote`、把 `mode` 切到 single，
    旧两仓留在磁盘与 GitHub 作历史，插件不会自动合并旧 payload。
  - **分组开关语义变了**：双仓库模式下关掉一个通道现在连 stage/apply 一起停（以前只停 push/pull）。
    这是修正名不副实，但确实改变了老行为。
  - **全局 AGENTS.md 会跨机覆盖**：一台机器改了规则会覆盖另一台的版本，这是同步的预期，
    但要注意别在一台机器上写只对本地有意义的路径。

- **已否决的替代方案**：
  | 方案 | 否决原因 |
  |---|---|
  | 两个 `remote` 填同一个地址 | 仍是两个工作副本，第二通道推同分支必然落后/分叉（README Q1 已写） |
  | 保留两个逻辑通道但共用一个物理仓库目录 | `dirty`/`ahead` 等仓库级指标会在两个通道上重复计数，状态与摘要都要特殊打补丁，比改成单通道更脏 |
  | 把全局 AGENTS.md 也交给代码仓库同步 | 它在 `~/.dsh`，不在任何工作区仓库里，代码仓库同步够不着 |
  | 把工作区 AGENTS.md 也加进 synchub | 与代码仓库同步重复搬，且工作区文件应归工作区 git（ADR-001 边界） |
  | 默认改成单仓库（DEFAULTS.mode='single'） | 老配置没有 `mode` 字段，会悄悄把已有双仓库用户切走，风险不可控 |

- **验证**：
  - 新增 `test/single-smoke.cjs` **38 条**：模式抽象纯函数、`mergeConfig` 收 mode/remote、
    分组开关过滤、stage 落 `repos/all/payload` 且不建 `repos/config`、diff 归零、
    `channelState('all')`/`statusPayload` 只报一个通道且摘要不重复计数、关掉配置组后
    AGENTS.md 不进 payload、apply 回写、空配置失败态引导文案。
  - 现有 10 份 smoke 中 9 份全绿；`diverge-smoke` 的源码护栏已随实现更新。
    `repo-sync-smoke` 在本沙箱因 `spawnSync git EPERM` 无法跑（测试自己起 git，非本次改动引入）。
  - **真机重启验收未做**：改了 `index.js`，必须完全退出 DSH 再打开；单仓库的真实 push/pull
    需要在真机（能跑 git 的环境）上验。

---

## ADR-038 · 0.12.0：插件清单备份/恢复（npm + link 两类）纳入同步中心

- **日期**：2026-11-25
- **状态**：已采纳（已实现，待真机重启验收）
- **背景（用户原话）**：
  > 「有插件备份和恢复功能（手动，可以定期执行）」
  > 「执行时候如果没变化，就不更新文件，记录插件就是名字，不记录版本」
  > 「恢复时候点击后会弹出修改内容，点击确认后再更新（都是从插件走，版本为最新）」
  > 「备份恢复都通过 synchub 的仓库记录文件」
  > 「与其装很多的插件儿，不如我这个 synchub 把这些需要同步的所有事情都在这里处理，所以功能会有扩展」
  > 「link 这一块……npm 你可以分类，npm 没有几个，然后备份同步只走它；下一个是 link 的检查，
  >  点了检查之后就从 synchub 里面同步的仓库里去检查，如果仓库里有 dsh-plugin 这个仓库……
  >  它就自己恢复添加上」
  > 「我这个同步可以有开关，我如果别人用了 ds-market 这个插件同步这块也可以关上，
  >  就作为放在自己，这样才能节约一个仓库的配置」

- **调研结论（先纠正三个前提）**：
  1. **`profileManifest` 面硬编码不同步，但「只记名字」的清单是安全的**。
     `surfaceEnabled()` 对 `danger` 直接返回 false（`lib/index.js:952`），理由是
     `package.json` 含 `link:C:/dsh/...` 绝对路径，跨机搬运会让 DSH 起不来。
     而本功能只记**名字（npm）/ 名字+相对位置（link）**，不含绝对路径 spec，
     因此可以作为一条**新路径**进唯一仓库（ADR-037），不必动 `profileManifest` 的 danger 定性。
  2. **桌面宿主已提供 `pluginManager` 服务，运行时可装 npm 插件，不必自己 spawn pnpm、
     也不必退出 DSH**。`ctx.get('pluginManager')` 暴露 `listBundles / installBundle /
     removeBundle / cancelInstall`（证据：dsh-market `lib/index.js:304`、
     `lib/official-desktop.js:502-543`、asar 内 `@deepseek-ai/dsh-plugin-manager/README.md`）。
     dsh-market 在官方桌面端就是走它，并明确「绝不 fallback 到 `dsh plugin --profile desktop`」
     （`lib/official-desktop.js:493-500` 注释：CLI 会要求 Desktop 完全退出）。
     所以「写个脚本去跑 dsh CLI」不是唯一解，**优先用宿主服务**。
  3. **`link:` 插件无法用 `installBundle` 装**。官方 manager 只接受 npm 目标
     （`lib/official-desktop.js:547` 的 `TARGET_RE` 校验，超出即 127）；
     dsh-market 恢复 `link:` 的办法是**写回 `package.json` 的 `link:` spec 再 `pnpm install`**
     （`lib/routes.js:2693-2708`）。synchub 的 link 恢复必须走同一条路。
  4. **dsh-market 已有备份/恢复，可借鉴、不可重复搬**。它导出 profile 配置快照
     （含 `package.json`），存 WebDAV/私有 Gist，每日自动备份（前端 localStorage 计时），
     恢复是「合并式 + 校验 + 回滚」，UI 有「预览 → 确认」两步。证据：
     `lib/backup.js:15-17,94-151,153-202,204-240,609-654`、`lib/gist.js:29-33,312-330`、
     `lib/snapshot.js:37,388-485`、`client/client.js:15164-15188`。
     **它的「插件清单」是配置快照的一部分，和本功能重叠**，所以本功能必须带开关。
  5. **synchub 已有全部所需机制**：sha256 diff（`lib/index.js:1043`，内容相同即 `unchanged`
     不写盘）、60s 单定时器（`lib/index.js:3517`，`autoPushTick` + `codeRepoAutoTick` + 本功能的备份 tick）、
     预览→确认范式（`purge-session` / `session-move`）、覆盖前备份（规则二）、
     `codeRepos` 只读状态（`lib/index.js:1419`，可判断 link 目标目录是否存在）。

- **决策**：
  1. **新增「插件清单」备份，落 `dsh-home/plugins/manifest.json`**，
     复用唯一仓库（ADR-037），**不新增仓库**。`profileManifest` 面的 danger 定性不变。
  2. 清单结构只记最小信息，**不记版本**：
     `{ "plugins": [ { "name": "dsh-free-search", "kind": "npm" },
                   { "name": "dsh-gitok", "kind": "link",
                     "linkPath": "C:/dsh/dw-plugin/dsh-gitok" } ] }`。
     npm 只记名字（恢复时裸名安装 = 最新）；link 记名字 + 目标路径（仅用于「检查」，
     不用于跨机搬运）。可用 `cfg.pluginSync.includeLink` 控制是否把 link 纳入清单。
  3. **备份**：优先 `pluginManager.listBundles()` 取已装 bundle（含 `source` spec，可区分
     npm/link/git）；宿主服务不可用时回退读 `profiles/<p>/package.json` 的 dependencies。
     写入走现有 `diffLocalToPayload`/`stageChanges`，**内容相同则不写盘、不产生提交**
     （用户要求「没变化就不更新文件」由 sha256 比对天然满足；写盘后进提交）。
  4. **周期执行**：复用 60s 定时器，新增 `cfg.pluginSync.autoMinutes`（0=不自动，仅手动）。
     备份是只读+写 payload，风险低；**恢复绝不自动**，只能手动。
  5. **恢复 = 预览 → 确认 → 执行**：
     - 预览（只读）：对比「清单 vs 当前已装」，列出 新增 npm / 新增 link / link 目标缺失；
       link 目标是否存在，用 `codeRepoState`（`cfg.codeRepos`，如 `C:\dsh\dw-plugin`）判断。
     - 执行：npm 走 `pluginManager.installBundle(name)`（运行时生效，无需退出 DSH）；
       link 走「校验目标存在 → 备份 `package.json` → 写 `link:` 依赖与
       `dsh.profile.bundles` → 跑 bundled pnpm install」。执行前必须备份被覆盖的
       `package.json`（规则二），失败可回滚。
  6. **开关**：`cfg.pluginSync.enabled`（默认 **关**）。语义是「插件清单是否由本插件备份/恢复」。
     与 dsh-market 的备份导出**二选一**：用户用 dsh-market 备份时关掉此项，避免两处
     同时判定插件清单（`client.js` 已有一句「两套不要同时管同一个东西」的提醒，
     本开关把它变成可执行开关）。

- **理由**：
  - 用户的两台机器插件要一致，而插件清单是唯一还没被任何自研通道覆盖的同步面；
    放进 synchub 后，「会话 / 配置 / 技能 / 插件清单」一个面板管完，符合用户
    「与其装很多插件，不如 synchub 把所有要同步的事在这里处理」的诉求。
  - 复用唯一仓库而非新开仓库：清单只有几十行 JSON，独立仓库的管理成本大于收益；
    且 ADR-037 已把配置面收束为「一个地址、一个仓库」，再加仓库会把它变回去。
  - npm 走宿主服务而不是自己 spawn pnpm：宿主服务已处理写锁、`restart-required`、
    build 审批、平台校验，自造轮子会重蹈 dsh-market 上千行 pnpm 兼容逻辑。
  - link 之所以只「检查 + 重新链接」而不是备份源码：源码归 `dshplug` 仓库管（ADR-001），
    B 机本来就必须 clone 它；synchub 只需确认目标在、再补 profile 依赖。

- **反面代价**：
  - **npm「版本为最新」不可复现**：清单不记版本，恢复时装的是恢复当天的最新版；
    若某插件新版不兼容，恢复结果与备份时的机器不同。用户已明确选「最新版」。
  - **link 恢复要跑 pnpm**：这是本插件第一次在恢复路径里执行包管理器；
    需要处理 pnpm 失败/文件占用，且会改 `package.json`（已用备份缓解）。
  - **与 dsh-market 的边界靠开关维持**：两个都开就会重复；开关默认关，
    但用户要自己知道该关哪个。
  - **`pluginManager` 服务并非所有宿主都有**：CLI/web 宿主可能没有，
    此时 npm 恢复要回退到生成命令让用户执行，能力降级（必须在预览里写清）。
  - **清单由备份时机决定**：自动备份间隔内新装的插件，要等下一次备份才进清单。

- **已否决的替代方案**：
  | 方案 | 否决原因 |
  |---|---|
  | 打开现有 `profileManifest` 面的开关 | `surfaceEnabled()` 对 danger 硬编码 false（`lib/index.js:952`），且它含 `link:` 绝对路径，跨机会让 DSH 起不来 |
  | 让 synchub 自己 spawn `dsh plugin --profile desktop add ...` | 官方桌面端 CLI 拒绝该 profile（要求 DSH 完全退出）；运行中调用必然失败 |
  | 用 `pluginManager.installBundle` 装 link: 插件 | manager 只接受 npm 目标（`TARGET_RE`），link 目标被拒（127） |
  | 恢复时只生成命令让用户贴终端 | 用户明确要「点击确认后再更新」；且 npm 走宿主服务可自动完成，只给命令是能力浪费 |
  | 新增一个同步仓库放插件清单 | 几十行 JSON 不值得一个仓库；ADR-037 刚把配置面收束为唯一仓库 |
  | 记版本号以便精确复现 | 用户明确「不记录版本、都装最新」 |
  | 把 link 源码也备份进 synchub | 源码归 `dshplug` 仓库（ADR-001），且跨机路径不同；备份源码会重复且失真 |

- **验证（实现时补）**：
  - 备份：清单写入 `dsh-home/plugins/manifest.json`，内容相同重复执行不产生新提交（sha256 比对）。
  - 无变化：连续两次备份 `git log` 无新提交。
  - 预览：只读，不改 `package.json`；能区分 npm/link，link 目标缺失要显式列出。
  - 恢复：执行前 `package.json` 有备份；npm 走宿主服务；link 恢复后目标目录存在且 profile 依赖含 `link:`。
  - 开关：`pluginSync.enabled=false` 时备份不写 payload、恢复按钮不可用。
  - 全部 smoke 与 `node --check` 全绿；改 `index.js` 需重启 DSH 验收。