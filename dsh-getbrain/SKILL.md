---
name: dsh-getbrain
description: 整理「得到大脑 / Get笔记」笔记时的强制纪律——用官方 OpenAPI，先全文字下载与全量备份、人分析决策后再改、写操作需确认、删除按不可逆对待。当任务涉及笔记分类、删除、整合、打标签、知识库归类，或使用 getnote_* 工具时使用。
whenToUse: 用户要求整理/归类/删除/合并 Get笔记（得到大脑）笔记，或提到 getnote / 得到大脑 / 全文字下载 / 笔记快照 / 整理计划 / 统一数据目录时。
---

# 得到大脑（Get笔记）整理纪律

> 本文件既是「说明书」，也是本 Bundle 的一部分。`dsh-getbrain/` 目录整体是一个正式 Cordis 插件：
> `index.js` 注册 `getnote_*` 模型工具，`client.js` 在「设置」里提供 Getnote 侧边栏配置表单，
> `gn.py` 是真正干活的官方 OpenAPI 客户端，本文件是给 agent 看的纪律。装了插件后可用 `getnote_guide` 随时读回。

## 铁律（不可绕过）

1. **只用官方 OpenAPI，通过 `dsh-getbrain/gn.py`（或 `getnote_*` 工具）**。禁止逆向网页接口、第三方 MCP、直接手写 curl 批量删改。
2. **先下载 + 备份**：`getnote_download`（全文字到 `dataDir/downloads/`）供人先分析决策；
   任何写操作前必须 `getnote_backup`（Phase 0 全量只读快照到 `dataDir/snapshots/`），验收前不删。
3. **默认只读**：`doctor / download / backup / list / search / topics` 只读；写命令不带 `--apply` 一律只是 DRY-RUN。
4. **先出方案再动手**：基于下载/快照产出 dry-run 整理报告 + `plan.json`，**用户确认后**才 `getnote_apply`（内部仍需 `--confirm CONFIRM`）。
5. **删除按不可逆对待**：官方 FAQ 自列 bug「删除后直接彻底删除、未进回收站」。优先降级为「打归档标签 + 移入待清理知识库」；真删需二次确认 + `--i-understand-deletion-may-be-permanent`，并去 App 回收站核验。
6. **凭据安全**：在「设置 → Getnote」→「账号凭据」里输入 API Key / Client ID，点「保存凭据」——它写入 DSH 凭据库 `$DSH_HOME/.credentials.yaml`（仅本机该用户可读），**不进组合树**。也可用环境变量 `GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` 或 `apiKeyFile`。不回显、不写聊天/日志/仓库。面板保存即时生效（无需重启）。

## 统一数据目录（dataDir）

默认 = **仓库同级的 `data-getbrain`**（本机 `C:\dsh\data-getbrain`，首次运行自动创建）。
它在任何 Git 仓库之外：不进同步、不进插件包，数据完全在本机自己掌控。
插件 Config 的 `dataDir` 填了就优先用它；留空就是上面的默认值。其下：
**默认只下载全文字**；音频/视频二进制为硬约束永不下载；图片需 `media.images=true` 或 `download --with-images`。

## 关键坑

- `note/update` 的 `tags` 是**替换覆盖** → 分类一律用 `tag_add`。
- 雪花 ID 一律字符串；`HTTP 200 且 success:false` 仍是失败。
- 列表 `cursor` 分页每页 20；详情在 `data.note`；`recall` 的 `top_k` 非全量，判重别只靠它。
- 限流 ~2 QPS（可配 `minInterval`）、读 2万/日 20万/月；429 按 `reason` 退让。订阅库只读；每天最多建 50 库。
- 会员是硬前提（否则 `10201 not_member`）。
- **面板保存的配置即时生效**（volatile 字段就地写回运行中的插件）。只有改 `index.js`（Host 模块已入内存）或 `package.json` 的 `dsh.client` 才需重启；改 `client.js` 由 client-hmr 热重载。

## 标准流程

```
getnote_guide                       # 读本纪律
getnote_doctor(live=true)           # 验会员/Key/网络
getnote_download                    # 全文字落地 → 人分析决策
getnote_backup                      # Phase 0 兜底快照
# 我基于下载/快照出 dry-run 报告 → 用户确认 → 生成 plan.json
getnote_apply(plan="<dataDir>/state/plan.json")   # 需用户确认
```
CLI 等价：`.\dsh-getbrain\gn.ps1 doctor --live` / `download` / `backup` / `apply --plan ... --confirm CONFIRM`。
完整命令、计划格式、迁移说明见 `C:\dsh\dshplug\dsh-getbrain\README.md`（插件目录内，不在数据目录）。

> 说明书管「决策纪律」，`gn.py` 的代码闸门管「执行」——双保险，任一层被绕过另一层仍拦得住。
