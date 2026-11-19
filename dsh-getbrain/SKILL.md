---
name: dsh-getbrain
description: 整理「得到大脑 / Get笔记」笔记时的强制纪律——用官方 OpenAPI，先全文字下载与全量备份、人分析决策后再改、写操作需确认、删除按不可逆对待。当任务涉及笔记分类、删除、整合、打标签、知识库归类，或使用 getnote_* 工具时使用。
whenToUse: 用户要求整理/归类/删除/合并 Get笔记（得到大脑）笔记，或提到 getnote / 得到大脑 / 全文字下载 / 笔记快照 / 整理计划 / 统一数据目录时。
---

# 得到大脑（Get笔记）整理纪律

> 本文件既是「说明书」，也是本 Bundle 的一部分。`dsh-getbrain/` 目录整体是一个正式 Cordis 插件：
> `index.js` 注册 `getnote_*` 模型工具，`client.js` 在「设置」里提供 Mgetbrain 侧边栏配置表单，
> `gn.py` 是真正干活的官方 OpenAPI 客户端，本文件是给 agent 看的纪律。装了插件后可用 `getnote_guide` 随时读回。

## 铁律（不可绕过）

1. **只用官方 OpenAPI，通过 `dsh-getbrain/gn.py`（或 `getnote_*` 工具）**。禁止逆向网页接口、第三方 MCP、直接手写 curl 批量删改。
2. **先下载 + 备份**：`getnote_download`（全文字到 `dataDir/downloads/`）供人先分析决策；
   任何写操作前必须 `getnote_backup`（Phase 0 全量只读快照到 `dataDir/snapshots/`），验收前不删。
3. **默认只读**：`doctor / download / backup / list / search / topics` 只读；写命令不带 `--apply` 一律只是 DRY-RUN。
4. **先出方案再动手**：基于下载/快照产出 dry-run 整理报告 + `plan.json`，**用户确认后**才 `getnote_apply`（内部仍需 `--confirm CONFIRM`）。
5. **删除按不可逆对待**：官方 FAQ 自列 bug「删除后直接彻底删除、未进回收站」。优先降级为「打归档标签 + 移入待清理知识库」；真删需二次确认 + `--i-understand-deletion-may-be-permanent`，并去 App 回收站核验。
6. **凭据安全**：在「设置 → Mgetbrain」→「账号凭据」里输入 API Key / Client ID，点「保存凭据」——它写入 DSH 凭据库 `$DSH_HOME/.credentials.yaml`（仅本机该用户可读），**不进组合树**。也可用环境变量 `GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` 或 `apiKeyFile`。不回显、不写聊天/日志/仓库。面板保存即时生效（无需重启）。

## 统一数据目录（dataDir）

默认 = **仓库同级的 `data-getbrain`**（本机 `C:\dsh\data-getbrain`，首次运行自动创建）。
它在任何 Git 仓库之外：不进同步、不进插件包，数据完全在本机自己掌控。
插件 Config 的 `dataDir` 填了就优先用它；留空就是上面的默认值。其下：
**默认只下载全文字**；音频/视频二进制为硬约束永不下载；图片需 `media.images=true` 或 `download --with-images`。

## 关键坑

- `note/update` 的 `tags` 是**替换覆盖** → 分类一律用 `tag_add`。
- 雪花 ID 一律字符串；`HTTP 200 且 success:false` 仍是失败。
- **层级不在服务器上**：知识库（topics）是**平**的，没有 parent/folder；`knowledge/detail` → 404。
  「知识库→目录→书→讲」只能由 `gn.py inventory` 从本地镜像重建（课题标签 = 目录，标题《》 = 书）。
- **子笔记只能一层且不可逆**：`parent_id` 创建后不可改（`immutable_parent_relation`）、无法摘除、
  无法列子列表（相关端点全 404），**删父会连带丢子**（子笔记变 `10500 note_not_found`）。
  所以不要把一整本书的划线搬成子笔记，用标签 + 知识库分组。
- **侧边栏写操作走“三层门”**：`/plan`（只写计划文件、白名单四 op）→ `/apply` 默认干跑
  → 真写需 `confirm:"APPLY"` + `dryRun:false`，>200 个动作还要 `allowHighRisk`。
  删除**故意没接进面板**，必须走 `gn.py note-delete --confirm DELETE` 独立流程。
- **`kb_batch_add` 是“加入”不是“移动”**：不会把笔记从原知识库移走；要去掉旧的得 `kb_remove`。
  `tag_add` 同理是追加，不是覆盖。
- 列表 `cursor` 分页每页 20；详情在 `data.note`；`recall` 的 `top_k` 非全量，判重别只靠它。
- 限流 ~2 QPS（可配 `minInterval`）、读 2万/日 20万/月；429 按 `reason` 退让。订阅库只读；每天最多建 50 库。
- 会员是硬前提（否则 `10201 not_member`）。
- **面板保存的配置即时生效**（volatile 字段就地写回运行中的插件）。只有改 `index.js`（Host 模块已入内存）或 `package.json` 的 `dsh.client` 才需重启；改 `client.js` 由 client-hmr 热重载。
  **注**：本条已过时/需修正——实测改 `index.js` 新增的**路由**必须重启 App 才生效
  （进程内存里的旧注册表不会热更）；改 `client.js` 刷页即可；`gn.py` 是子进程，改完即生效。

## 撤销（2026-11-18 新增）

写错分类可以回退，但**前提是写前拍了快照**。

- `gn.py undo-snapshot --plan <plan>`：只读，把要改的每条笔记的**原归属**（知识库+标签）存成 `state/undo-<stamp>.json`。
- `gn.py undo --plan <undo文件> --confirm UNDO [--dry-run] [--allow-large]`：按**状态收敛**回滚。
- 侧边栏 `/apply` 真写时**自动**先拍快照；拍不到就**中止写入**（宁可这次不改，不能改了无法回退）。

为何不能只靠反向操作：`kb_batch_add` 是“加入”不是“移动”，天真地 `kb_remove` 会把原本的归属也踢掉；
`tag_add` 同理。必须知道“改之前是什么样”。详见 `docs/UNDO-DESIGN.md`。

边界：只还原**归属**，不还原正文（`note_update` 的内容旧文不存）；`note_delete` 不进撤销体系。

## AI 动作：发芽 / 审问 / 连线（2026-11-18 新增）

**平台端只能查不能生成**（实测：`GET /resource/note/sprout?id=` 返回 `has_sprout`；POST 同路径 404；
13 个其他 AI 端点全 404）。所以：

- `gn.py sprout --note-id <id>`：查平台已有发芽内容（只读）。
- `gn.py context-pack --note-id <id> [--limit N]`：把「中心笔记 + 同系列其他讲 + 跨系列相关段落 + 关键词」
  拼成给 AI 的素材包，**纯本地、不发网络请求**。
- `gn.py prompts [--ensure] [--name sprout|interrogate|link]`：提示词存在 `<dataDir>/prompts/`，
  首次自动创建，之后**用户改文件就生效，不用改代码**。

“发芽”（用户原话：「让发芽一下，看能不能把沟通和另外两个做一个补充」）= 基于已有记录联想补全、指缺口。
“审问” = 出题逼真理解（不给答案），对应渐进式总结 Layer 4。“连线” = 辨别真假相关。

三者**都不自动写入**：结果只展示，用户自己决定要不要动手。

为何需要 context-pack：只给一条笔记就发芽，AI 会泛泛而谈；它需要知道这条在哪个系列里、
别讲了什么、别处哪里聊过。关键词质量踩过三次坑（详见 `docs/AI-ACTIONS.md` §3）。

## 知识管理立场（为何功能长这样）

完整推导见 `docs/PKM-THEORY.md`。核心事实与结论：

- 库里 **94% 是课程划线摘录（4053 条），只有 6% 是你自己的记录（269 条）**。
- 所以两堆要**分开对待**：划线按「来源形状」组织（机器做），自己的记录按「可行动性」组织（人+AI）。
- 不要把这 4053 条按主题重分类进 PARA——一门课能横跨多个主题，重分类等于人工读 4053 条。
- 树上做「浏览与批量搬运」，**不要在树上做思考**（层级结构不适合发现跨域联系）。
- 真正缺的不是更花的分类树，而是渐进式总结的 **Layer 2–4**（加粗/高亮/用自己的话）。
## 标准流程

```
getnote_guide                       # 读本纪律（层级/子笔记限制也在里面）
getnote_doctor(live=true)           # 验会员/Key/网络
getnote_download                    # 全文字落地 → 人分析决策
getnote_backup                      # Phase 0 兜底快照
# 我基于下载/快照出 dry-run 报告 → 用户确认 → 生成 plan.json
getnote_apply(plan="<dataDir>/state/plan.json")   # 需用户确认
```
CLI 等价：`.\dsh-getbrain\gn.ps1 doctor --live` / `download` / `backup` / `apply --plan ... --confirm CONFIRM`。
完整命令、计划格式、迁移说明见 `C:\dsh\dshplug\dsh-getbrain\README.md`（插件目录内，不在数据目录）。

> 说明书管「决策纪律」，`gn.py` 的代码闸门管「执行」——双保险，任一层被绕过另一层仍拦得住。
