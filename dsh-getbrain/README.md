# 得到大脑（原 Get 笔记）OpenAPI 受控整理工具包

用途：让本 Harness 的 agent 通过**官方 OpenAPI** 对你的笔记做「分类 + 删除 + 整合」，
且全程受控、可审计、可回滚。零第三方依赖，只用 DSH 自带 Python 标准库。

> **定位（2026-11-20 澄清，v2.10.0）**：这**不是**多人协作 / 多用户 / 团队知识库插件。
> 事实是**一个 Get笔记 账号、三个自然人共用**：我（工作与 AI 思考）、孩子（学习与升学）、
> 老婆（部门会议与客服质量），再加大量全家一起读的课程与书本摘录。
> **维护分类的只有一个人（用户本人）**。插件的职责是**把内容按人分开**，
> 让 AI Agent 读懂「谁的事」—— 不做账号体系、不做权限、不做冲突合并。详见 §11.14。

- 官方 API 文档：<https://doc.biji.com/docs/WOxgwObNNiyMHWk1dl0cJqSxnEd>
- 开放平台（创建应用 / 取 Key / 作废 Key）：<https://www.biji.com/openapi>
- 官方 MCP（备选路径）：<https://doc.biji.com/docs/FmYfw0yXsiXdTtkVzhLcuX8lnxd>

> ⚠️ 硬性前提：**会员账号**。非会员返回 `10201 not_member` / 429 `reason: not_member`。

---

## 0. 当前位置（2026-11-11 迁移）

本包已从 `default-workspace/getnote` 迁到 **`C:\dsh\dw-plugin\dsh-getbrain`**（2026-11-12 并入 dw-plugin 仓库），
数据在 **`C:\dsh\data-getbrain`**（2026-11-12 起：默认就在仓库外侧，与代码分离）。

```
C:\dsh\dw-plugin\dsh-getbrain\  代码（在 dw-plugin 仓库内，随仓库同步）
   index.js                 Host 侧插件 + 22 条 HTTP 路由
   client.js                客户端 UI（设置页 + 侧边栏工作台）
   gn.py / gn.ps1           CLI 实现（Python 标准库，无第三方依赖）
   cordis.patch.yml         插件层补丁（dataDir 留空 → 用代码默认值）

C:\dsh\data-getbrain\       数据（仓库的同级目录，天然不进 Git，永不入库）
   current\                 笔记 Markdown 镜像
   snapshots\ logs\ state\ ...
```

**路径怎么算的（2026-11-12 起改为代码推导，不再写死绝对路径）**：

```
BUNDLE_DIR  = C:\dsh\dw-plugin\dsh-getbrain   （插件目录）
WORKSPACE   = 上一级 = C:\dsh\dw-plugin        （= Git 仓库根本身）
DEFAULT_DATA_DIR = WORKSPACE 的上一级 + data-getbrain = C:\dsh\data-getbrain
```

旧版本默认写 `dataDir = 'getbraindata'`，它是**相对 WORKSPACE** 解析的，于是落到仓库里
`C:\dsh\dw-plugin\getbraindata`，只能靠 `cordis.patch.yml` 写死绝对路径 `C:\dsh\getbraindata`
（当时还配了一个 Junction）把数据拽出仓库。现在默认值改到**仓库同级**，patch 里留空即可，
换机器、换目录都不用再改配置。

**命名约定**：`C:\dsh\data-<技能短名>` 是本机技能的默认数据位（本插件 = `data-getbrain`），
首次运行**自动创建**（幂等）。它不在任何 Git 仓库里 → 不进同步、不进插件包，
**用户数据完全在本机自己掌控**。想换位置就在「设置 → Mgetbrain」里把 `dataDir` 改成绝对路径。

⚠️ **改数据目录时改一处就够**（这是 2026-11-12 的简化）：

1. 首选在「设置 → Mgetbrain」→「下载与目录」→ `统一数据目录` 里改（即时生效，无需重启）。
2. 若要改**默认值**本身：`index.js` 的 `DEFAULT_DATA_DIR` 与 `gn.py` 的 `DEFAULT_DATA_DIR`
   （两处推导规则必须一致）；`cordis.patch.yml` 的 `dataDir` 保持留空，让推导生效。

> 历史坑（仍适用）：`cordis.patch.yml` 的 `config:` 在**行激活时**读取，非空值会**覆盖**
> 代码里的默认值。以前正因为那里写死了绝对路径，只改代码里的常量不生效。

---

## 1. 一次性配置

在开放平台创建应用，拿到 `Client ID (cli_xxx)` 与 `API Key (gk_live_xxx)`（只显示一次）。

`getnote/` 目录本身就是一个**正式 Cordis 插件（Bundle）**：代码 + 插件入口 + SKILL.md 说明都在里面。
配置有五处，任选其一（优先级：**凭据库** > 环境变量 > 插件行 Config > settings.json > config.local.json）；**首选「设置 → Mgetbrain」侧边栏，在哪里输入 Key/ID 见第 9 节**：

**A. 正式插件（可在 DSH 配置界面里填 key 与设定）** → 见第 8 节。

**B. 只用 CLI**：复制 `config.example.json` 为 `config.local.json` 填 key；
复制 `settings.example.json` 为 `settings.json` 改偏好：

```json
// config.local.json（只放 secret）
{ "api_key": "gk_live_你的key", "client_id": "cli_你的clientid", "api_base": "https://openapi.biji.com" }

// settings.json（非敏感偏好，可入库）
// settings.json（非敏感偏好，可入库）—— dataDir 留空就用默认值
{ "dataDir": "", "minInterval": 0.55,
```

**C. 环境变量**（最高优先）：`GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` / `GETNOTE_API_URL` /
`GETNOTE_DATA_DIR` / `GETNOTE_MIN_INTERVAL` / `GETNOTE_MEDIA_IMAGES` / `GETNOTE_CONFIG_FILE`。

**不要把凭据贴进聊天、不要提交仓库**；仓库根 `.gitignore` 已排除 `config.local.json`、`settings.json`、`data/` 与全部运行产物（导出 zip 内由 `gn.py` 动态生成一份同规则的 `.gitignore`）。

### 统一数据目录 dataDir

默认 = **仓库同级的 `data-getbrain`**（本机 `C:\dsh\data-getbrain`，首次运行自动创建）；
可在设置里改成绝对路径，或写相对路径（相对工作区根 = 仓库根）。其下：

| 子目录 | 内容 |
|---|---|
| `downloads/` | 全文字下载（每篇一个 Markdown，含原文 + AI 总结 + 元数据） |
| `intermediate/` | 中间产物索引（如 `latest_download.json`） |
| `snapshots/` | Phase 0 全量只读快照（兜底） |
| `logs/` | 审计日志 `*.jsonl` |
| `state/` | 整理计划与执行结果 |

**下载策略**：默认只取全文字；音频/视频二进制为**硬约束永不下载**；图片需 `media.images=true` 或 `download --with-images`。

#### 目录是怎么初始化的（重要）

**不需要在设置里初始化。** `data/` 及其子目录都是**按需创建**的：

- 第一次调用任何工具时自动建 `data/{logs,state,intermediate,snapshots}/`；
- 第一次调用 `download` 时才建 `downloads/`。

所以如果你刚装完就看到 `downloads/` 是空的，**那是正常的——你还没跑过下载**。

#### 快照 vs 增量：怎么用才对

| 模式 | 命令 | 行为 | 什么时候用 |
|---|---|---|---|
| 快照（默认） | `getnote_download()` | 新建 `downloads/<时间戳>/`，全量重下 | 想留一份“某一刻”的不可变快照 |
| 增量 | `getnote_download(into="current")` | 写回同一目录（相对**数据目录**），只重写 `updated_at` 变了的 | **日常用这个** |

**默认行为其实不适合日常用。** 每次全量重下既慢又费配额，还会在 `downloads/` 里
攒一堆 90% 重复的目录。日常一律传 `into`。

#### ★ 规模现实：你的账号有近 4000 条笔记

2026-11-10 实测：列表翻了 199 页、累计 3980 条。全量下载每条要一次详情请求，
按最小间隔 0.55s 算就是 **约 36 分钟**，而工具默认超时 600s —— **必然跑不完**。

所以全量下载必须**分段做**，靠续传来接上：

```
# 第一段（跑到超时或你手动停）
getnote_download(into="current")   # 相对路径以 dataDir 为基准，不必写全路径
# 已经写进目录的笔记会保留；下次自动接着下剩下的
```

**续传依据是磁盘上的文件名，不是 manifest。**
文件名前缀就是 `note_id`（`<note_id>_<标题>.md`），所以即使进程被 kill、
manifest 根本没写出来，下次扫一遍目录就能知道哪些已下过。

实测验证（809 篇已存在时）：

```
[download] 目录里已有 809 篇，按「已有即跳过」续传
[download] 已有 809 条记录，将跳过未变化的
✅ 下载完成：全文 0 篇 / 跳过 20 篇（未变化） / 失败 0 / 图片 0 / 调用 1 次
```

20 篇只花 1 次调用（列表本身），省掉了 20 次详情请求 —— 配额消耗降 95%。

要强制全量重写：`getnote_download(into="...", force=true)`。
流程是「下载全文字 → 人分析决策 → 生成 plan → apply 改线上」。

运行方式（在工作区根目录执行；`gn.ps1` 已处理 Windows UTF-8 控制台问题）：

```powershell
.\getnote\gn.ps1 doctor --live
.\getnote\gn.ps1 backup
.\getnote\gn.ps1 apply --plan getnote\state\plan.json --confirm CONFIRM
```

`gn.ps1` 只是把参数透传给 `gn.py`，并按 `GETNOTE_PYTHON` > PATH 的 `python`/`py` >
`$DSH_HOME` 自带 Python 的顺序找解释器（**不含任何硬编码用户名**，换机器可用）。
等价的裸调用（需自己设 UTF-8）：`python getnote\gn.py ...`（非 Windows 用 `python3`）。
仅需 Python 3.9+，零第三方依赖。

## 2. 安全模型（三条代码级硬规则）

1. **默认只读**：`doctor / backup / list / detail / search / topics` 全是只读；
   所有写命令不带 `--apply` 时只打印 DRY-RUN 计划，不发包。
2. **删除双重闸门**：`note-delete` 除 `--apply` 外还必须带
   `--i-understand-deletion-may-be-permanent`。因为官方 FAQ 自列 bug：
   「笔记删除后直接彻底删除，未进回收站」「存在严重误删风险」。
3. **全量审计 + 凭据脱敏**：每次请求写 `audit/YYYYMMDD.jsonl`；
   任何可能进入终端/日志的文本经 `redact()` 脱敏；请求体只记哈希不记凭据。

其余护栏：限速 ~1.8 QPS（官方约 2 QPS）、按 `reason` 退让重试、
`HTTP 200 且 success:false` 按失败处理、雪花 ID 一律字符串、
`kb_batch_add` 自动按 20 条切块、`note/update` 的 `tags` 明确标注为「替换覆盖」。

## 3. 四阶段工作流

| 阶段 | 命令 | 是否改动线上 |
|---|---|---|
| **0 备份** | `gn.py backup` → `snapshots/<时间戳>/`（notes_list.json / notes_detail.json / notes.md / manifest.json） | 否（只读） |
| **1 分析** | agent 基于快照聚类/判重，产出 dry-run 整理报告 + `plan.json` 给你过目 | 否 |
| **2 分类+整合** | `gn.py apply --plan plan.json --confirm CONFIRM`；先做加法（tag_add / kb_batch_add / note_save 新建合并笔记并保留原文） | 是（可回滚） |
| **3 删除** | 先降级为「打归档标签 + 移入待清理知识库」；你二次确认后才小批量 note_delete，并去 App 回收站核验 | 是（高危） |

Phase 0 快照是整个流程的兜底，验收前不要删。

## 4. 命令一览

```
[--data-dir PATH]                   统一数据目录（覆盖 settings.json.dataDir）
doctor [--live]                     自检 / 只读连通性测试
download [--max N] [--with-images]  下载全文字到 dataDir/downloads（默认不下载音频/视频）
backup [--max N] [--skip-detail]    Phase 0 全量只读快照
list [--all] [--limit N] [--json]   只读列表
detail <note_id>                    只读详情
search <query> [--top-k N]          只读语义搜索（Top-K 非全量，判重别只靠它）
topics [--include-subscribed]       只读知识库列表
inventory [--into current] [--summary]  本地重建「知识库→目录→书→讲」层级（不调 API、不耗配额）
resolve   --paths "KB\x1f目录\x1f书\x1f讲" [..]  把层级路径解析成 note_id（不调 API、不耗配额；附带 titles）
lecture-notes --course C --lecture L [--kb K] [--book B]  列出一个「讲」下的每条笔记（note_id+标题，纯本地）
personas  [--into current] [--json]  按人盘点这个账号里的内容（我/孩子/老婆/共用/未知；纯本地）
index     [--into current]          建/刷新本地全文索引（sqlite FTS5；纯本地，不调 API）
find      <词..> [--kb K] [--type T] [--owner 我|孩子|老婆|共用|未知] [--limit N] [--json]
                                    检索本地索引（字面检索，不是语义检索）
publish   --kb <库名> [--out DIR]    把一个知识库导出成自包含静态站点（纯本地）

tag-add    --note-id ID --tags A B [--apply]
tag-remove --note-id ID --tag-id TID [--apply]
kb-add     --topic-id TID --note-ids ID.. [--apply]     # 自动按 20 切块
kb-remove  --topic-id TID --note-ids ID.. [--apply]
kb-create  --name NAME [--description D] [--apply]
note-save  --title T (--content X | --content-file F | --stdin) [--tags ..] [--topic-id ..] [--apply]
note-update --note-id ID [--title ..] [--content ..] [--tags ..] [--apply]   # tags 替换覆盖
note-delete --note-id ID --i-understand-deletion-may-be-permanent --apply

apply --plan plan.json --confirm CONFIRM [--dry-run] [--allow-high-risk]
      [--only-op op1 op2] [--limit N] [--continue-on-error]
plan-template                       打印计划文件 JSON 模板
export [--out X.zip] [--include-key] 打包成可移植 zip（默认不含任何凭据）
```

`apply` 的 `--confirm CONFIRM` 是防误跑闸门；计划里含 `note_update` / `note_delete`
时还需 `--allow-high-risk`。

**`--dry-run` 不需要凭据（实测）**：预览只看计划内容、不发包，所以没填 Key 也能先看。
预览会打印每个动作实际的 HTTP 方法和 body，确认无误再真跑。

写闸门是四层，顺序如下（每层都实测过被拦截）：

| 层 | 触发条件 | 实际报错 |
|---|---|---|
| 1 | `op` 不在白名单 | `actions[0] 的 op 非法：note_list；允许 [...]` |
| 2 | 含 `note_update`/`note_delete` 但没 `--allow-high-risk` | `计划含高危操作 ['note_delete']，需额外 --allow-high-risk` |
| 3 | 没 `--confirm CONFIRM` | `需显式 --confirm CONFIRM 才会真正执行（防止误跑）` |
| 4 | `args` 缺字段 | `动作 tag_add 的参数不完整或类型不对（缺/错：'note_id'）` |

> 第 4 层原本会直接撑出 Python traceback，2026-11-10 改成可读提示。

## 5. 计划文件格式（version 1）

由 agent 在 Phase 1 生成、你确认后再执行。`gn.py plan-template` 可打印模板：

```json
{
  "version": 1,
  "generated_at": "...",
  "confirmed_by": "USER_CONFIRMED",
  "source_snapshot": "snapshots/<时间戳>/manifest.json",
  "actions": [
    {"op": "tag_add", "reason": "归类依据", "args": {"note_id": "1907975006118548200", "tags": ["工作"]}},
    {"op": "kb_batch_add", "reason": "...", "args": {"topic_id": "abc123", "note_ids": ["..."]}},
    {"op": "note_save", "reason": "合并且保留原文", "args": {"title": "...", "content": "..."}}
  ]
}
```

`op` 白名单：`tag_add / tag_delete / kb_batch_add / kb_remove / kb_create /
note_save / note_update / note_delete`。所有 ID 用字符串。

## 6. 已知坑（都会导致数据事故，务必记住）

- `note/update` 的 `tags` 是**替换覆盖**，分类一律优先 `tag_add`。
- 官方删除接口标称「移入回收站可恢复」，但 FAQ 列有彻底删除 bug → 按不可逆对待。
- 雪花 ID >2^53，必须用字符串；`HTTP 200 且 success:false` 仍是失败。
- 列表分页 `cursor`（每页 20）；详情在 `data.note`；普通链接保存是异步的，要轮询 `task/progress`。
- `recall` 的 `top_k`（默认3/最大10）**不是全量**，空结果不证明没有重复。
- 限流：约 2 QPS、读配额 2万/日、20万/月；429 的 `reason` 有
  `qps_global/qps_bucket/quota_day/quota_month/not_member`。
- 订阅知识库只读不可写；每天最多创建 50 个知识库。
- 语音/录音等笔记只能在 App/Web 创建，OpenAPI 可读不可建。

## 7. 移植 / 导出安装 / 跨 session

`dsh-getbrain/` 同时具备**两种身份**（这是本工具包的设计要点）：

- **正式 Cordis 插件（Bundle）**：见第 8 节。已通过 `install_bundle` 装进当前 desktop profile，
  注册 `getnote_*` 模型工具，影响该 profile 的所有工作区与会话。
- **可独立运行的 CLI**：`gn.py` 零第三方依赖、只用 Python 3.9+，把 `getnote/` 文件夹拷到任何机器、
  不装插件也能直接 `python dsh-getbrain/gn.py ...`。

两者共用**同一份代码、同一份配置、同一个 dataDir**，不冲突；插件只是给 CLI 套了一层「DSH 内可配置 + 模型工具」的壳。

### 导出 / 装到另一台 DSH

运行 `./dsh-getbrain/gn.ps1 export` 生成 `dsh-getbrain-toolkit-<时间戳>.zip`（**默认不含任何 Key**），包内附 `INSTALL.txt`。
解压得到 `dsh-getbrain/`，然后二选一：

- **当插件装**（推荐）：在目标 DSH 会话里 `plugin_manager action: install_bundle target: <dsh-getbrain 绝对路径>` → 重启应用 → 填 Key（见第 9 节）。
- **只当 CLI 用**：复制 `config.example.json` → `config.local.json` 填 Key，`settings.example.json` → `settings.json` 改偏好，直接跑 `gn.ps1`。

`gn.ps1` 按 `GETNOTE_PYTHON` → PATH 的 `python`/`py` → `$DSH_HOME` 自带 Python 找解释器（无硬编码用户名）；
非 Windows 用 `python3 dsh-getbrain/gn.py ...`。`gn.py` 用 `Path(__file__).parent` 定位代码，拷到哪里就在哪里生效；
**数据目录默认跟着走**（= 代码目录的上一级 + `data-getbrain`，首次运行自动创建）。

### Key / ID 存在哪里？——五处，优先级从高到低

| 位置 | 优先级 | 说明 |
|---|---|---|
| **DSH 凭据库**（面板输入）`$DSH_HOME/.credentials.yaml` | **1（最高）** | 「设置 → Mgetbrain」两个安全输入框写这里；**不进组合树、不进配置导出、不进日志** |
| 环境变量 `GETNOTE_API_KEY` / `GETNOTE_CLIENT_ID` | 2 | 插件 Config 也注入到这里；适合多机共用 |
| 插件行 Config 的 `apiKey` / `clientId` | 3 | 已弃用明文槽（仍可用）；**明文落组合树** |
| `dsh-getbrain/settings.json` 的 `apiKey` / `clientId` / `apiKeyFile` | 4 | 非敏感偏好文件；`apiKeyFile` 指向本地 json |
| `dsh-getbrain/config.local.json` | 5（最低） | 仓库根 `.gitignore`（及导出包内动态生成的 `.gitignore`）已排除；复制 `config.example.json` 填入 `api_key`/`client_id` |

**优先级实测（2026-11-10，用 stub `creds.resolve` + 真 `apply()` + 真 `gn.py`）**：

| 场景 | `凭据来源` | 实际用的 Key |
|---|---|---|
| 只有凭据库 | `credentials` | 凭据库的（显示 `***`，全脱敏） |
| 只有环境变量 | `env` | 环境变量的（显示 `KEY_ENVV…3456`） |
| **两者都有** | **`credentials`** | **凭据库胜出** ← 优先级 1 的证据 |

另外两个边界也实测过：
- 只存了 Key 没存 Client ID → `⚠ 有 API Key，但缺 Client ID。两个都要填（接口会同时校）。`
- 凭据库 `resolve()` 抛异常 → **不崩溃**，优雅回退到 `凭据来源: none`（`index.js` 里那个 `catch` 真的在起作用）。

`load_credentials()` 按上表解析；`dataDir/logs/*.jsonl` 只记请求路径与 body 哈希，经 `redact()` 脱敏，永不落 Key。
**当前 `config.local.json` 不存在，凭据库里也没有 `GETNOTE_*` 记录 → 还没有任何 Key 被保存。**

### 怎么把能力带到「另一个 session」

- **同一个 profile 的新会话**（已装插件，最常见）：什么都不用传。`getnote_*` 工具与 SKILL.md 纪律
  对该 profile 所有会话都在；新会话直接开工，只需口头交代进度。
- **另一个工作区**：只要还在同一 desktop profile，插件同样生效（profile 级，不是工作区级）。
- **另一台机器 / 另一个 profile**：用 `export` 把文件夹/zip 拷过去，照上面「导出/装到另一台 DSH」重装，
  Key 用**安全通道**单独传（密码管理器 / 本机文件 / 重新填一次 `config.local.json`）。
  `--include-key` 虽可把 Key 打进 zip，但那个 zip 就等同明文凭据，用完即删或去开放平台作废。

> 一句话：**插件管「在 DSH 里可配置 + 自动带纪律」，CLI 管「独立可移植」，
> 凭据管「钥匙」，SKILL.md 管「决策纪律」** —— 四者共用同一份 `dsh-getbrain/` 代码。
## 8. 作为正式 Cordis 插件（Bundle）

`dsh-getbrain/` 目录**本身就是 bundle**（`package.json` + `cordis.patch.yml` + `index.js` +
`client.js` + `locale/` + `icon.svg` + `SKILL.md`）。安装后：

- 该 **profile 的所有工作区 / 所有会话**都获得 `getnote_*` 模型工具；
- agent 可通过 `getnote_guide` 随时读回整理纪律（SKILL.md）；
- **`client.js` 在「设置」里注册一个顶层侧边栏分区「Mgetbrain」**（`settings.section`），
  里面是配置表单，直接填 `apiKey` / `clientId` / `dataDir` / `media.images` / `minInterval` 等；
- 同时也可在 **DSH 插件行配置**（Plugins 页）里改同一份 Config —— 两处写的是同一命名空间 `getnote`。

### 注册的工具

| 工具 | 作用 | 是否改动线上 |
|---|---|---|
| `getnote_guide` | 读回整理纪律 SKILL.md | 否 |
| `getnote_doctor(live)` | 自检 / 只读连通性测试 | 否 |
| `getnote_download(max, withImages, into, force)` | 全文字下载到 `dataDir/downloads`（传 `into` 则增量写回同一目录） | 否 |
| `getnote_backup(max, skipDetail)` | Phase 0 全量只读快照 | 否 |
| `getnote_list(all, limit)` | 只读列表 | 否 |
| `getnote_search(query, topK)` | 只读语义搜索 | 否 |
| `getnote_topics(includeSubscribed)` | 只读知识库 | 否 |
| `getnote_plan_template()` | 打印 plan.json 模板 | 否 |
| `getnote_apply(plan, dryRun, allowHighRisk, limit)` | 执行人工确认过的计划 | 是（仍有 gn.py 闸门） |

`index.js` 把插件 Config 映射成环境变量后 `spawn` 起 `gn.py`；`client.js` 是设置页表单。
**所有写闸门、限速、审计、删除双重确认仍由 `gn.py` 强制**，插件绕不过去。

### 安装

```
plugin_manager  action: install_bundle
target: C:\dsh\dw-plugin\dsh-getbrain
```

（把上面的绝对路径换成目标机 `dsh-getbrain/` 的实际路径。本机已在 profile 里以 `link:` 装好，不需要再装；
重新装用 `& C:\dsh\dw-plugin\install.ps1 -Only dsh-getbrain`。）

### 配置项（「设置 → Mgetbrain」侧边栏 = `cordis.patch.yml` 的 `config`）

所有字段都标了 `.volatile()`，所以会出现在设置表单里；`apiKey`/`clientId` 另标 `role('secret')` 会脱敏不回显。

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKey` / `clientId` | 空 | 可直接粘 key，但**明文落组合树**；留空更安全 |
| `apiKeyFile` | `getnote/config.local.json` | 本地 json 后备（含 `api_key`/`client_id`）。**只在凭据库没给全时才生效**；路径写错会在自检里显式报警 |
| `apiBase` | `https://openapi.biji.com` | OpenAPI 地址 |
| `dataDir` | 空（→ 仓库同级 `data-getbrain`） | 统一数据目录。留空 = 代码推导的默认值；填值则优先 |
| `media.images` | `false` | 图片二进制开关；audio/video 恒不下载 |
| `minInterval` | `0.55` | 请求最小间隔秒 |
| `pythonPath` | 空 | 留空自动找 Python |
| `pythonTimeoutMs` | `600000` | 单次**工具调用**超时 |

> 面板的「测试连接」不走这个 600s：它固定用 **45s（--live）/ 20s（本地）**。
> 原因：600s 是给全量下载留的，用在面板上会让界面转圈 10 分钟。
> 实测依据：把 `pythonTimeoutMs` 设为 `1`（毫秒），面板 doctor 仍成功、耗时 138ms；
> 若面板没覆盖超时，1ms 必然返回 TIMEOUT。

### 重要说明与验证边界

- **改 `client.js` 不用重启**（已实测）：`@deepseek-ai/dsh-client-hmr` 每 500ms stat 轮询所有 client bundle，
  变化时调 `clientModules.rebuilt(id)` 就地把新代码投给浏览器——实测改完 3 秒内新 rev 就能 200。
- **改设置面板里的值也不用重启**（已实测）：所有字段都是 `.volatile()`，loader 的 `_commitVolatile()`
  会通过 `updateVolatile()` 就地把新值写回运行中的 fiber，`apply(ctx, config)` 收到的那个 `config`
  对象被原地改写，所以 `execute()` 里 `cfg(config, ...)` 读到的是最新值。
- **必须重启的只有两件**：① 改 `package.json` 的 `dsh.client`（`client-modules` 构造时同步扫描并缓存
  `pkgMeta`）；② 新装/升级整个包（新增 loader 条目）。改 `index.js`（Host 半边）也需重启，
  因为它是 ESM 模块，已被 `import` 进内存。
- 装进 profile 后**全局生效**：一个能删笔记的工具对所有会话可见，请按需启停。
- 凭据**首选「设置 → Mgetbrain」的两个安全输入框**（写入 DSH 凭据库，不进组合树）；`apiKeyFile` / 环境变量作为备用。把明文写进 patch 是最差选择（`mcp-bundle.md` 亦如此建议）。
- **面板渲染实测（2026-11-10，不需要浏览器）**：自己写了一个极简 React 运行时（`createElement` / `useState` / `useEffect` / `useCallback` / `useSyncExternalStore`），用真 `apply(ctx)` 拿到 `slots.register` 的组件引用，再用真 `inject()` 产生的 props 真执行 `GetnoteSettingsSection`，把元素树跑成了文本。结果：

  **未认证时**（目标 (1) 的直接证据）：
  ```
  h3   "账号凭据（安全存储）"
  label "API Key"   → input [type=password, placeholder="（未设置）"]
  label "Client ID" → input [type=password, placeholder="（未设置）"]
  button "保存凭据"      [disabled=false]
  button "清除已存密钥"  [disabled=true]   ← 未存密钥时正确禁用
  h3   "接入信息"
  p    "打开本页会自动跑一次 gn.py doctor：纯本地检查（解释器、目录、限速、凭据来源），不联网、不耗配额，跟会话里的 getnote_doctor 是同一条命令。下面那个「测试连接」不是同一件事——它是 doctor --live，会真发一次只读请求。"
  button "测试连接（doctor --live，耗 1 次配额）"
  p    "本地自检（doctor）还没回来——刷新页面重试。"
  ```

  **认证成功后**（目标 (3) 的直接证据，mock `/plugins/getnote/status` 返回成功 JSON）：
  ```
  h3   "接入信息"
  p    "下面是从本机实际读出来的状态；点「测试连接」会真的发一次请求。"
  button "测试连接（doctor --live，耗 1 次配额）"
  span "✅ 认证通过，已可调用"
  span "凭据来源" / "file"
  span "API Key"  / "✅"
  span "Client ID" / "✅"
  span "API 地址" / "https://openapi.biji.com"
  span "X-RateLimit-Limit" / "1000"
  span "X-RateLimit-Remaining" / "997"
  span "X-Quota-Daily-Remaining" / "850"
  span "X-RateLimit-Reset" / "1794290000"
  pre  "✅ 连通成功：首页返回 2 条笔记，has_more=False…"
  ```

  两个输入框都是 `type=password`，屏幕上会遮蔽；“清除已存密钥”在无密钥时确实置灰。
  （仍未验证的：像素级样式/布局——那需要真实浏览器渲染引擎。）
- **保存/清除按钮的完整读写回路（2026-11-10 实测）**：用假 React + 假 `creds` 真的点了按钮：

  | 阶段 | 实测行为 |
  |---|---|
  | 初始（库空） | `describe(["GETNOTE_API_KEY","GETNOTE_CLIENT_ID"])`（**收数组**）；清除按钮 `disabled=true` |
  | 点「保存凭据」 | `set(GETNOTE_API_KEY, …)` → `set(GETNOTE_CLIENT_ID, …)` → 刷新 status |
  | 保存后 | 提示语 `凭据已保存到 DSH 凭据库。`；输入框清空；清除按钮**变为可点** |
  | 点「清除已存密钥」 | `unset(GETNOTE_API_KEY)` → `unset(GETNOTE_CLIENT_ID)` |
  | 清除后 | 提示语 `已从凭据库删除。`；清除按钮**回到禁用** |

  其中 `refresh=1` 的请求**恰好只发 1 次**（来自 `saveCreds`），绕过 5s 缓存——
  这就是“保存后接入卡不会停在旧状态”的机制。

  > 调试记录：我第一版把 `creds.describe` 写成忽略参数返回单对象，结果“清除”按钮一直置灰。
  > 查源码发现 `readCreds` 传的是**数组**、返回 `{ref: info}` 映射——是我测试桁错了，不是产品 bug。
  > 同理，Panel 上那句注释说“空库时不开放清除”，但代码里两个 ref 是 `&&` 关系（两个都配了才置灰失败），
  > 实测行为与代码一致：**只要其中一个配了，按钮就可点**。

- 本会话验证到哪一步（可复现）：
  JS 语法、ESM 导入、**10 个工具**离线 `apply()` 注册、manifest/locale/SVG/YAML、Python 编译；
  **线上实测（2026-11-10，带签名 cookie 拉真实首页）**：`__DSH_BOOT__` 共 **85 个条目**，getnote 完整条目：
  ```json
  {"id":"dsh-getbrain",
   "url":"plugins/??dsh-getbrain/client.js&rev=1a1a060c64f0",
   "rev":"1a1a060c64f0",
   "inject":["@deepseek-ai/dsh-client-ui-settings",
             "@deepseek-ai/dsh-client-ui-settings-general",
             "@deepseek-ai/dsh-api-remotes"],
   "immediately":true}
  ```
  ——证明新增的 `dsh-api-remotes` 依赖**已被运行时接受并写进启动图**，无需再重启。
  再用同一个 cookie 拉那个 bundle URL：**HTTP 200，30279 B**，内容里
  `settings.section` / `GetnoteSettingsSection` / `credExplain` / `navigator.clipboard`
  全部在位——**这就是浏览器实际会执行的那份代码**。

- **为什么 inject 里必须有 `@deepseek-ai/dsh-api-remotes`**（已查 asar 源码确认）：
  `ctx.remote.credentials` 的 `describe/set/unset` 三个方法由
  `@deepseek-ai/dsh-api-settings-controller` 定义（`service: "credentialsController"`），
  但它自己**没有** `dsh.client` 入口；实际是 `@deepseek-ai/dsh-api-remotes/lib/client.js`
  内含 `dsh-api-settings-controller#credentials/describe|set|unset` 并挂到 `ctx.remote` 上。
  所以声明 `dsh-api-remotes` 而不是 `dsh-api-settings-controller`。

  **仍未验证**：侧边栏在真实浏览器里的像素级渲染（本会话无浏览器控制），这一段请你在页面里核对。

## 9. 在哪里输入 API Key / Client ID（详细）

### 先拿到两个值

1. 打开 [开放平台](https://www.biji.com/openapi) →「创建应用」→ 得到：
   - **API Key**：`gk_live_xxxxx`（只显示一次，立即保存）
   - **Client ID**：`cli_xxxxx`
2. 账号必须是**会员**，否则所有调用返回 `10201 not_member`。

### 四条输入路径（按「设置面板优先」排序）

#### 路径 A：**设置 → Mgetbrain 侧边栏（你要的入口，首选）**

`client.js` 在「设置」里注册了一个**顶层侧边栏分区「Mgetbrain」**（与「通用」「插件」同级）。
打开 **设置**（快捷键 Ctrl+, / Cmd+,）→ 左侧栏点 **Getnote** → 右侧出现配置表单：

- **账号凭据（安全存储）**：`API Key`、`Client ID` —— 这两个写入 DSH 凭据库，**不进组合树**
- **凭据文件**：`apiKeyFile`（可选的本地 json 回退）
- **下载与目录**：`统一数据目录`（dataDir）、`下载图片` 开关、`请求最小间隔`
- **高级**：`OpenAPI 地址`、`Python 解释器`、`单次调用超时`

填好密钥后点 **「保存凭据」**（不是下面那个通用的「保存」）。它会调
`ctx.remote.credentials.set('GETNOTE_API_KEY', ...)`，落到 `$DSH_HOME/.credentials.yaml`：

- 写入位置：`C:\Users\<你>\.dsh\.credentials.yaml`
- 权限：ACL 为 `NT AUTHORITY\SYSTEM` / `BUILTIN\Administrators` / 你本人 FullControl（**实测**）。
  注意：这三条 ACE **是从父目录继承来的**，不是凭据文件自带的显式保护。
- **不会写进 `cordis.patch.yml`**（即不会明文落进组合树）——已实测：点保存时 `configForms.mutate` 被调 **0 次**
- 保存后面板上下次只显示「已保存」，**永不回显密钥本身**

> **Windows 上的真实情况（重要，与 README 早期说法不同）**：
> `dsh-credentials-local` 源码（从 `app.asar` 提取，32KB）里有这一句：
> `if (process.platform === "win32") return;` —— **Windows 下它直接跳过 owner-only 权限校验**。
> 它自己的注释说得很直白（原文）：
> > Windows has no mode to inspect — its ACLs are not expressible here — so the check is skipped
> > rather than faked, and the file's protection there is whatever the create and replace APIs express.
>
> 对文件设的 `mode: 384`（`0o600`）/ `dirMode: 448`（`0o700`）在 Windows 上也不生效。
> 实测：代码请求 `0o600`，`stat().mode & 511` 得到 **438 = `0o666`**（全局可读）。
> 换句话说：**在 Windows 上保护来自你用户目录的继承 ACL，而不是 DSH 自己施加的权限限制。**
>
> **但“权限隔离”这个词得打个折**（2026-11-10 对比实测）：
> `Get-Acl .credentials.yaml` 与 `Get-Acl cordis.patch.yml` 的 ACE **一模一样**——
> 都是 `SYSTEM` / `Administrators` / 你本人 FullControl，且都开继承。
> 所以**凭据文件在权限上并不比明文配置更安全**。它真正的价值是：
> 不进组合树、不被配置导出带走、不进日志。
>
> 诚实说明边界：这不是 OS 密钥链。同一系统账号下的进程（包括本 AI 的工具进程）
> 技术上读得到它。它防的是“明文散落在配置文件/日志/仓库里”，不防“同账号恶意程序”。
> 要更强隔离需要 OS keychain（DSH 尚未提供）。

其余非秘密配置点下面的 **「保存」**，走 `form.mutate(ops, revision)`，即时生效、不清空。

> 密钥走两条完全不同的通道：
> - **秘密**（apiKey/clientId）→ `ctx.remote.credentials`（凭据库，不进配置）
> - **非秘密**（dataDir/media.images/apiBase…）→ `configForms.get('getnote')`（volatile 配置）
>
> 旧版把密钥也放在 config 里（即使标了 `role('secret')`，`dsh-config-editor` 仍会把它们写进
> `cordis.patch.yml` 明文）。本版已把密钥从 Config 表单里拿掉，只保留两个标记为「已弃用」的兼容槽。

### 认证成功后：你会看到什么

面板里的「**接入信息**」区块就是为这个做的。

先澄清两个容易混淆的东西（2026-11-16 修正）：

| | 做什么 | 联网 | 耗配额 |
|---|---|---|---|
| 打开页面时自动跑的 `doctor` | 本地自检：解释器、五个子目录、限速、凭据来源 |  否 | 否 |
| 按钮「测试连接」= `doctor --live` | 在自发基础上多发一次只读 `note/list` | 是 | 1 次读 |

它俩**不是同一件事**，以前的文案写成“抽「测试连接」获取”是错的。点 **「测试连接」** 后给出：
然后给出：

| 项 | 含义 |
|---|---|
| `✅ 认证通过，已可调用` / `❌ 未通过` | 基于 `gn.py doctor --live` 的真实结果 |
| `凭据来源` | `credentials`=安全凭据库（面板输入的）；`env`=环境变量；`file:xxx.json`=本地 json；`none`=未配置 |
| `API Key` / `Client ID` | ✅ 表示已配置（**不显示值**） |
| `API 地址` | 当前使用的 OpenAPI base（默认 `https://openapi.biji.com`） |
| `数据目录` | 统一数据目录绝对路径（下载/快照/日志/状态全在里面） |
| `会员状态` | `✅ 有效` / `❌ 无效（not_member）` / `未测试`——**只在 `live` 模式下才有值** |
| `配额` | 官方响应头里的 `RateLimit-*` / `Quota-*` 字段。**实测官方不下发这些头**，所以真实环境通常显示“官方未下发”，不是故障 |
| 下方「原文」区域 | `gn.py doctor` 的完整输出（Python、5 个子目录、下载策略、限速等） |

> **会员/配额是怎么来的（实测说明）**：
> - **会员状态**：`live` 连通成功 → 能读列表就说明是会员；失败时若 `code=10201 / reason=not_member` → 明确报“非会员”。
>   （已用本地假服务器分别模拟 200 与 400+10201，两条分支都跑通）
> - **配额**：读 HTTP 响应头（`RateLimit` / `Quota` / `Remaining` / `Reset` / `Retry-After`），
>   官方若下发就直接展示；**若不下发则诚实写“官方未在响应头下发”**，不编造数字。
>   - 假服务器测试：返回 `X-RateLimit-Limit: 1000` / `X-RateLimit-Remaining: 997` 时面板能拿到。
>   - **真实 API 实测（2026-11-10）**：直接打 `https://openapi.biji.com/open/api/v1/resource/note/list`，
>     无论带不带（假）凭据，响应头只有 `Date/Content-Type/Content-Length/Connection/Set-Cookie/
>     Access-Control-*/G-Client-Ip/G-Powered-By/G-Timestamp`——**没有任何 RateLimit/Quota 字段**。
>   - 结论：**真实环境下这一栏基本会是“官方未下发”而不是数字**。想知道配额只能看 429 的 `reason`。
>     这不是 bug，是官方接口就不给。真到限流时 `gn.py` 会报 `429 → 配额/QPS`。

> **认证成功后的完整 status（2026-11-10 实测，真 `index.js` 路由处理器 + 本地 mock）**：
> 用真实 `apply(ctx, config)` 起 plugin，直接调用注册到 `webServer` 的
> `/plugins/getnote/status` handler（`ROUTE.kind/path/handler` 都拿到了），
> 把 handler 的输出原样解析。两种 mock 场景：
>
> | 字段 | mock 下发配额头 | mock 不下发（仿真真实 API） |
> |---|---|---|
> | `ok` | `true` | `true` |
> | `member` | `{reported:true, ok:true, text:"✅ 有效（能正常读列表，说明是会员账号）"}` | 同左 |
> | `quota` | `{X-Quota-Daily-Remaining:"850", X-RateLimit-Limit:"1000", X-RateLimit-Remaining:"997", X-RateLimit-Reset:"1794290000"}` | `{}`（空） |
> | 面板配额栏 | 逐项列表 | `配额：官方未在响应头下发（无 RateLimit/Quota 字段），只能靠 429 错误判断` |
> | `origin` / `apiKeySet` / `clientIdSet` | `file` / `true` / `true`（凭据库场景） | 同左 |
> | `credDiag` | `{servicePresent:true, error:null, canWrite:true}` | 同左 |
>
> 两种场景 `member` 都是 `ok:true`，**证明“认证成功”与“官方给不给配额”是两回事**，
> 不会因为没配额就把会员状态弄成未知。
>
> **日志脱敏也实测了**：跑完查 `data/logs/*.jsonl`，测试用的
> `TESTKEY_MOCK` / `TESTCID_MOCK` / `DBSAVED_KEY` / `DBSAVED_CID` **一个都没出现**；
> 每行只有 `method` / `path` / `status` / `code` / `body_keys` / `body_sha256`。

也可在任何会话里直接问：**「跑一下 getnote_status，带 live」**（工具名 `getnote_status`），
效果等同，且不用打开设置页。

### 怎么用（面板底部也内置了这段）

认证通过后，在任意会话里直接用自然语言说，我会调对应工具：

| 你说 | 我会调 | 说明 |
|---|---|---|
| 「先跑一下 getnote_doctor」 | `getnote_doctor` | 本地自检，不消耗配额 |
| 「把笔记全量下载下来」 | `getnote_download` | 只拉全文字；音频/视频永不下载 |
| 「做一次快照」 | `getnote_backup` | Phase 0，写操作前必须做 |
| 「搜一下我笔记里关于 XX」 | `getnote_search` | 语义检索 |
| 「列一下我的知识库」 | `getnote_topics` | |
| 「把 A、B 两篇重复的合并」 | `getnote_plan_template` → 你确认 → `getnote_apply` | 写闸门：没 `CONFIRM` 不执行 |
| 「现在接到什么状态」 | `getnote_status` | 接入信息（可加 live） |

> 面板里这段说明自带 **「复制说明」** 按钮：点一下把上面 6 条 + 安全约束整段写进剪贴板
> （按钮会变成「已复制 ✓」）；若浏览器不允许读写剪贴板，会回退为自动选中该区块，你 `Ctrl+C` 即可。
> （两条路径都已离线实测：clipboard 收到完整文本；禁用 clipboard 时 selection 回退生效）
>
> **安全约束**：默认只读；写操作必须先出 plan 给你确认；删除按不可逆对待，需
> `--confirm CONFIRM` + `--i-understand-deletion-may-be-permanent` 双重闸门。

#### 路径 B：写本地文件（最安全的兜底，100% 找得到）
100% 可靠、不依赖任何 GUI。直接在工作区建文件 **`dsh-getbrain/config.local.json`**（复制 `config.example.json` 改）：

```json
{
  "api_key": "gk_live_你的API_Key",
  "client_id": "cli_你的Client_ID",
  "api_base": "https://openapi.biji.com"
}
```

- 文件在 `C:\dsh\dw-plugin\dsh-getbrain\config.local.json`；仓库根 `.gitignore`（及导出包内动态生成的 `.gitignore`）已排除，不会入库。
- 插件 `cordis.patch.yml` 里 `apiKeyFile: ''` 时，`index.js` 的默认值 `dsh-getbrain/config.local.json` 就指向它 ——
  插件读不到 Config 里的 Key 时会回退到这个文件。
- **不用重启**：面板保存的 volatile 值会就地写回运行中的插件（已实测）。
- 验证：`getnote_doctor(live=true)`，或 `./dsh-getbrain/gn.ps1 doctor --live`。

> 想改目录/限速/图片开关，另建 **`dsh-getbrain/settings.json`**（复制 `settings.example.json`），
> 改 `dataDir`、`minInterval`、`media.images`。这是非敏感偏好，可入库。


#### 路径 C：在 DSH「插件」页的配置表单里填（与路径 A 同一份数据）

插件行注册了 `Config` schema（含 `apiKey` / `clientId` / `dataDir` / `media.images` 等），Plugin Manager 会为它渲染一份表单。界面入口：

1. 打开 **设置 → 插件**（Plugin Manager）。
2. 在「已安装」列表找 **「得到大脑 · 笔记整理」**（包名 `dsh-getbrain`）。
3. 展开该 bundle → 找到行 **`getnote`** → 点行上的 **「配置 getnote」/齿轮**按钮，进入该行配置表单。
4. 表单里填 `apiKey`（=API Key）、`clientId`（=Client ID）、`dataDir`、`media.images` 等 → 保存。
5. 保存即生效（volatile 字段就地写回，不用重启）。

⚠️ 提醒：
- 组合树是**明文落盘**的，把 Key 填这里等于把凭据写进 profile 配置；按官方 `mcp-bundle.md`
  的建议，更稳妥是留空 `apiKey`/`clientId`，用 `apiKeyFile` 指向本地 json（路径 B）。
- 若插件页没显示「配置」按钮，**用路径 A 的「设置 → Mgetbrain」侧边栏或路径 B 即可**，
  三者写的是同一命名空间，功能完全一样，不必耗在找入口上。

#### 路径 D：环境变量（适合多机 / CI）
启动 DSH 之前设（或写进系统环境变量），优先级最高，会覆盖 A / B / C：

```powershell
$env:GETNOTE_API_KEY = "gk_live_你的key"
$env:GETNOTE_CLIENT_ID = "cli_你的clientid"
# 可选：
$env:GETNOTE_DATA_DIR = "D:\我的笔记数据"
$env:GETNOTE_MEDIA_IMAGES = "false"
```
### 五个已修复的坑（2026-11-10 实测，全部有证据）

这三个坑的表现**完全一样**：设置面板里除顶部两个凭据输入框外，其余控件全部点不动，且**没有任何灰字提示**。
凭据框能用是因为它走 `remote.credentials`，跟 `configForms` 是两条独立数据源。

按调试顺序记录，后两个是真正的根因。

---

**坑 A：`Config` 为 `undefined`，导致 `describe()` 直接跳过本插件（★ 真正的根因之一）**

`dsh-settings` 的 `describe()` 有一条硬门槛：

```js
const schema = this.schema(entry)          // = entry.fiber.runtime.Config
if (schema === undefined || entry.fiber === undefined ||
    entry.fiber.runtime === null || entry.fiber.state !== 2) return []
if (volatileForm(schema) === undefined) return []
```

`schema()` 内部还会检查 `"toJSON" in schema`。

如果 `Config` 是 `undefined`，这个插件**根本不会出现在 `describe()` 的返回列表里**，
于是 `configForms.get(任何名字)` 都是 `status:'unavailable'` → `ready=false` → `disabled=true`。

本插件是 `link:` 安装（真实路径在工作区里，没有自己的 `node_modules`），
所以 `index.js` 用 `createRequire` 去找 `@deepseek-ai/schemastery`。**第一版锚点选错了**：

```js
const profileDir = process.env.DSH_PROFILE_DIR || ''   // ❌ 生产环境里不存在
```

实测 Host 进程（Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行）的 `DSH_*` 环境变量只有两个：

```
DSH_CLIENT_VERSION = 0.2.2-rc.1
ELECTRON_RUN_AS_NODE = 1
```

**没有 `DSH_PROFILE_DIR`，也没有 `DSH_HOME`、`DSH_PROFILE`。** 于是锚点回落到插件自己的
`index.js`（无 `node_modules`）→ `resolve` 失败 → `z = null` → `ConfigShape = undefined`。

可靠锚点是 `process.cwd()`，实测就是 profile 目录 `C:\Users\franc\.dsh\profiles\desktop`
（其下 `node_modules\@deepseek-ai\schemastery` 存在）。现在改成多锚点 + 多绝对路径依次尝试。

验证（`/plugins/getnote/diag` 从 Host 侧读到）：

```
修复前： ConfigPresent:false  zPresent:false  describeCount:26  hasBareGetnote:false
修复后： ConfigPresent:true   zPresent:true   describeCount:27  hasBareGetnote:true
```

**教训：验证 `Config` 是否可用，必须在 Host 进程里验证，不能在本地 shell 里验证——
本地 shell 里 `DSH_PROFILE_DIR` 是设过的，会给出假阳性。**

---

**坑 B：`cfg()` 没解 volatile 包装，`spawn` 拿到对象（★ 另一个真根因）**

`Config` 里每个标了 `.volatile()` 的字段，运行时读出来**不是普通值，而是包装对象**：

```js
config.apiBase            // { get: [Function], Symbol(cosmokit.volatile.write): [Function] }
config.media.images       // 同样是包装对象
config.media              // 普通对象（容器不是 volatile，只有叶子是）
```

`resolvePython()` 里 `cfg(config,'pythonPath','')` 返回了这个包装对象（truthy），
于是 `return explicit` 把对象交给了 `spawn(exe, ...)`，报：

```
The "file" argument must be of type string. Received an instance of Object
```

后果是 `getnote_doctor` / `getnote_download` / `getnote_status` 全部失败。

修法：统一用 `unwrap()` 剥掉 `{ get() }` 包装，`cfg()` 和 `media.images` 都走它。

```js
function unwrap(v) {
  let cur = v
  for (let i = 0; i < 4 && cur !== null && cur !== undefined; i++) {
    if (typeof cur === 'object' && typeof cur.get === 'function') {
      try { cur = cur.get() } catch { break }
    } else break
  }
  return cur
}
```

顺带一个易错点：**只有 `media` 容器本身是普通对象，它的叶子 `images` 才是 volatile**。
给整个 `media` 加 `.volatile()` 会触发 schemastery 报错（见「坑 C」）。

---

**坑 C：`configForms` 的命名空间与 entry id 的关系（容易误判，但本项目里它不是病因）**

调试初期曾怀疑命名空间写错。实测结论：**`ns` 就是不带前缀的 `getnote`**，
`describe()` 返回的 27 个条目全部不带 `include:` 前缀（`session-log-deepseek`、`better-sidebar`、`getnote` …）。

`plugin_manager` 里显示的 `entryId: "include:getnote"` 是**管理面板的条目 id**，不是配置命名空间。
两者来源不同，不要混淆：

```
entryId:  "include:getnote"    <- plugin_manager 显示，用于 set_plugin 的 target
ns:       "getnote"            <- settings.describe() 返回，用于 configForms.get()
patchId:  "getnote"
```

`client.js` 仍保留候选式探测，避免以后 DSH 改前缀：

```js
const FORM_NS_CANDIDATES = ['getnote', 'include:getnote']
function pickForm(configForms) {
  const list = FORM_NS_CANDIDATES.map((ns) => configForms.get(ns))
  const hit = list.find((f) => {
    try { const s = f && f.getSnapshot && f.getSnapshot(); return s && s.status === 'ready' }
    catch { return false }
  })
  return hit || list[0]
}
```

**坑 D：`media: z.object({...}).volatile()` 会让整个设置面板变灰**

schemastery 不允许「volatile 字段包在另一个 volatile 字段里」，会报：

```
$.media.images volatile fields require a fixed object path without an enclosing volatile field
```

这个错误在 `ConfigForms.decode()` 里被吞掉，`status` 永远停在 `loading`，
于是 `ready=false` → `disabled=true` → **面板上所有输入框/开关全部点不动**，
而且**不会提示任何错误**（因为错误分支根本没把 message 传给 UI）。

正确写法：**只让叶子字段带 `.volatile()`，外层 object 不要加**：

```js
// ❌ 错：外层也 volatile
media: z.object({ images: field(...) }).default({}).volatile(),
// ✅ 对：只叶子 volatile，volatileForm 会递归找到它
media: z.object({ images: field(...) }).default({}),
```

**【坑 E】`.credentials.yaml` 变非法会让凭据服务永久停在 failed**

`LocalCredentialProvider` 的服务初始化顺序是：

```js
await this.loadInitial();      // ← 解析失败在这里抛异常
if (!this.spec.watch) return;
const watcher = watch(...);    // ← 永远走不到
```

`loadInitial()` 里的 `parseCredentialsDocument()` 没有 try/catch。文件一旦不是合法 YAML：
服务激活失败 → **watcher 根本没建立** → 即使事后把文件改好，也**没有任何监听器知道**。

表现：`credDiag.servicePresent: false`，面板顶部提示凭据服务未挂载，**所有插件的凭据一起失灵**
（不只是 getnote）。文件即使后来修好也不会自愈。

**自治办法**：禁用再启用 getnote 插件（`plugin_manager set_plugin enabled:false → true`）
就能连带把 `credentials` 服务重新拉起来（本次实测有效）；否则重启 DSH。

### 验证填对了

填好直接跑：`getnote_doctor(live=true)` 或 `.\dsh-getbrain\gn.ps1 doctor --live`（面板填的不用重启；如走环境变量则需重启）。
看到 `✅ 连通成功` 即生效；常见报错：
- `10201 not_member` → 非会员；
- `10001` → Key/Client ID 填错或已作废；
- `429 reason=qps_global/quota_day` → 限流，稍后重试。
**粘贴后的三步自检（2026-11-10 真实事故总结）**：

面板把值写进 `.credentials.yaml` 时是**字符串直存**，不做任何格式校验。而网页上的 Key 经常是**截断显示**的（`gk_live_xxxx...xxxx`），直接 Ctrl+A/C 会把省略号一起拿进去。一旦存进去：

1. **整个 YAML 变非法**（若同时带了未闭合的 `"` 和 `\`）→ `credentials` 服务激活失败 → 面板显示 `credDiag.servicePresent: false`，**所有**插件的凭据一起失灵（不只是 getnote）。
2. 就算 YAML 没坏，Key/CID 也带脏字符 → 一律 401，**报错看不出区别**。

跑下面这段自查（只输出形状，不打印密钥）：

```powershell
$node = "C:\Users\franc\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$js = @'
const fs=require('fs');
const t=fs.readFileSync(process.env.USERPROFILE+'/.dsh/.credentials.yaml','utf8');
const g=n=>{const m=t.match(new RegExp('^ {2}'+n+':[ \\t]*(.*)$','m'));return m?m[1].trim():''};
for(const n of ['GETNOTE_API_KEY','GETNOTE_CLIENT_ID']){
  const v=g(n);
  const bad=[...v].map((c,i)=>({c,i})).filter(o=>!/[A-Za-z0-9_-]/.test(o.c));
  console.log(n+': 长度='+v.length+' 前缀='+JSON.stringify(v.slice(0,8))+' 非法字符='+bad.length);
  bad.forEach(o=>console.log('    位置'+o.i+' = '+JSON.stringify(o.c)+' (码'+o.c.charCodeAt(0)+')'));
}
'@
Set-Content $env:TEMP/c.cjs $js -Encoding UTF8; & $node $env:TEMP/c.cjs; Remove-Item $env:TEMP/c.cjs
```

预期（合法时）：`非法字符=0`；`GETNOTE_API_KEY` 前缀 `"gk_live_"`、**长度 73**；
`GETNOTE_CLIENT_ID` 前缀 `"cli_"`、长度 36。

> ⚠ **注意：Key 里的 `.` 是合法的，不要手动删掉。**
> 实测：完整 73 字符（第 24 位就是 `.`）时接口返回 200；把那个 `.` 删掉或换成别的字符后
> 立刻变 `401 code=10004 unauthorized`。文档里不提供样例长度，只能以实测为准。
>
> 另：从普通 shell 直接跑 `gn.py doctor` 会报 `凭据来源: none`，**这是正常的** ——
> `gn.py` 读不到 DSH 的凭据库（它能读 env / apiKeyFile / config.local.json）。
> 只有经 `index.js` 调用时，才会把凭据库的值注入成环境变量传给 `gn.py`。
> 想看真实状态，请用面板的「测试连接」，或 `GET /plugins/getnote/status?live=1`。
> **本次真实事故（2026-11-10）**：用户粘贴后 `GETNOTE_API_KEY` 变成了 `"gk_live_…"` 开头、`…\` 结尾，
> 且第 24 位是省略号 `.`；`GETNOTE_CLIENT_ID` 只是一段 16 位十六进制（真正的 `cli_…` 36 位被截剩尾巴），
> 另外文件里还多出一行粘贴残留 `4ef38ad5c29d Client ID: cli_…`。
> 后果：YAML 非法 → `servicePresent: false` → 连其他插件的凭据也一起不可用。
>
> **正确做法**：在 https://www.biji.com/openapi 点 Key 旁的**复制按钮**（或双击选中完整值），
> 绝不要拖选网页上带 `…` 的显示文本。Client ID 是 `cli_` 开头的 36 位，不是纯 hex。

**真实 API 的 401 输出（2026-11-10 实测，用假密钥触发）**：

```
❌ 连不上：官方拒绝了这对凭据（HTTP 401）。
   通常是：API Key 或 Client ID 没填/抄错/抄不完整，或两者不是同一个应用下的。
   去 https://www.biji.com/openapi 重新看一眼（Key 只显示一次，错了只能重建）。
   原始报文：HTTP 401：{"success":false,...,"error":{"code":10004,...,"reason":"unauthorized",...}}
会员状态      : ⚠ 无法判定（凭据未通过认证，原因见上）
```

早期版本会把这一整串原始 JSON 摆在第一行、后面再叫你“看上方 JSON 里的 code”——
真实用户看不懂。现在改成先用中文说清楚，原报文降级为“原始报文”供排查。

**只填了一个字段时（实测三种）**：

| 你填了 | 提示 |
|---|---|
| 只有 API Key | `⚠ 有 API Key，但缺 Client ID。两个都要填（接口会同时校）。` |
| 只有 Client ID | `⚠ 有 Client ID，但缺 API Key。两个都要填（接口会同时校）。` |
| 两个都没 | `⚠ 凭据未配置（API Key 与 Client ID 都缺）。` |

早期版本一律说“凭据未配置”，你明明填了一个会以为自己没保存成功。

### 当前状态

`dsh-getbrain/config.local.json` **不存在**，`$DSH_HOME/.credentials.yaml` 里**也没有 `GETNOTE_*` 记录** —— 还没有任何凭据被保存（截至 2026-11-10 验证）。
填好后：`getnote_doctor(live=true)` → `getnote_download` → （人分析）→ `getnote_backup` → dry-run 报告 → 你确认 → `getnote_apply`。

## 10. 左侧边栏工作台（2026-11-10 新增）

### 机制：两个 slot 必须配合

DSH 没有「随便新建一个顶层页」这回事，但它**确实**提供了左侧边栏导航的
官方机制，而且是专门为这种场景设计的。源码（`app.asar`）里的 slot 规格：

| slot | 类型 / 作用域 | 作用 | 关键选项 |
|---|---|---|---|
| `sidebar.panellist` | list / root | 左侧边栏的图标按钮 | `id`（必填）、`order`、`label`、`locale` |
| `main` | keyed / root | 主区域内容 | `key`（必须与上面的 `id` **完全一致**） |

官方原话抓住了定位：

> *“A left-sidebar entry is navigation, not a second content area.
> Use it when the user needs a persistent place to reopen a feature.”*

已占用的 `main` key（别撞）：`conversation` / `plugin-manager` / `schedule`。
我们用 `getnote-workbench`。

### 官方实际写法（照这个抄，别自己发明）

从 `app.asar` 里挖出来的两处真实注册：

```js
// Plugins 面板
slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 0,
                 label: () => t('panel'), locale: NS }, PluginsPanelIcon)
// Schedule 面板
slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10,
                 locale: MANAGER_NS, label: () => t('panel') }, TaskManagerIcon)
// main
slots.register({ name: 'main', key: PANEL_ID, locale: NS, store,
                 inject: () => ({ ...face, ... }) }, Page)
```

我自己第一版漏了 `locale`，而且把 `main` 的 `inject` 写成只返回 `{ t }`。
两处都已改正。

### 图标必须是 SVG 本身（不能包一层）

源码注释写得很明确：

> *“The glyph is the row's direct icon child, as on every other panel row:
> an inline wrapper makes it the baseline of a line box inside the row's glyph slot,
> which lifts it above the label.”*

所以 `GetnoteIcon` 直接 `return h('svg', …)`，外层不能套 `div`/`span`。

### 关键澄清：`dsh.client.inject` 不控制加载

我一开始以为看不到图标是因为 `package.json` 的 `dsh.client.inject` 里没写
`dsh-client-ui-sidebar` / `dsh-client-ui-layout`，于是把它们加了进去。

但源码明确否定了这个理解：

> *“`dsh.client.inject` entries only **order activation** and stay allowed.”*

它只管**激活顺序**，不决定包加载与否。加进去无害（能保证 sidebar/layout 先于我们激活），
但不是必要修复。真正让改动生效的只有一件事：**重启 App**。

### 我能验证什么、不能验证什么

**能**（已实测，有 HTTP 证据）：

| 路由 | 用途 | 状态 |
|---|---|---|
| `GET /plugins/getnote/status` | 凭据 / 会员 / 配额 | ✅ 200，`?live=1` 时真调一次 `doctor --live` |
| `GET /plugins/getnote/summary` | 本地镜像统计（纯文件扫描，**不耗配额**） | ✅ 200，返回真实数据 |
| `GET /plugins/getnote/inventory` | 层级树（本地重建，60s 缓存，`?refresh=1` 强制） | ✅ 200，4321 条 / 123 个知识库节点 |
| `GET /plugins/getnote/log` | 审计日志尾部（`?lines=200`） | ✅ 200，读最新 `logs/<日期>.jsonl` |
| `POST /plugins/getnote/plan` | 选中层级 → 解析 note_id → 写 `state/plan.pending.json`（**不执行**） | ✅ 200，`confirmed_by` 留 `PENDING_USER_CONFIRM` |
| `POST /plugins/getnote/apply` | 执行计划；默认干跑，真写需 `confirm:"APPLY"` + `dryRun:false` | ✅ 200，干跑实测发 0 个请求 |
| `GET /plugins/getnote/report` | 浏览器端 slot 注册自报 | ✅ 200（待页面刷新后填充） |

**不能**：我看不到浏览器 DOM。所以「图标是否真的出现」这类问题，
必须靠页面里跑一段上报代码把结果回传，或者人眼看。

为此 `client.js` 在注册完 slot 后会 POST 一条自报：

```js
// 浏览器刷新后，这条就有内容了
GET /plugins/getnote/report
// → { report: { panelId, sidebar: {ok, totalEntries, ids}, main: {ok}, slotsApi: {...} } }
```

`totalEntries` 能把两种失败区分开：

- `totalEntries` 里**没有** `getnote-workbench` → 我的注册没生效
- `totalEntries` 里**有** `getnote-workbench` 但界面没图标 → 注册成功了，是渲染层的事

### 工作台已经是一个真操作界面（2026-11-16 重写）

早先四个标签页里，「处理建议 / 确认执行 / 执行日志」三页都只是占位字（写的是“这里会…”），
用户看到的只是一份设置页的镜像。这一版把它换成真能干活的四页：

| 标签 | 内容 | 数据来源 |
|---|---|---|
| **分类调整**（默认页） | 可展开的层级树：知识库 → 目录 → 书 → 讲，逐层带条数，末尾可勾选批量操作；选好后选目标（知识库 / 标签）生成计划 | `GET /plugins/getnote/inventory` → `gn.py inventory --summary` |
| **笔记现状** | 总数 / 未归知识库 / 无标签 / 可拆专题 Top8 + 类型分布 | `GET /plugins/getnote/summary`（纯本地扫） |
| **确认执行** | 逐条列出待执行动作（动作 / 目标 / 条数），可「先干跑」再「真写」（双点确认） | `POST /plugins/getnote/plan` → `resolve`；`POST /plugins/getnote/apply` → `gn.py apply` |
| **执行日志** | 写操作的审计流水（读 `<数据目录>/logs/<日期>.jsonl`） | `GET /plugins/getnote/log?lines=200` |

**为什么层级树要放在工作台而不是设置页**：「设置」是填参数的地方，「工作台」是干活的地方。
分类调整需要展开/勾选/多选，这在设置表单里做不了。

**为什么层级不在服务器上**：官方 `/resource/knowledge/list` 只返 `id/topic_id/name/description/cover/scope/created_at/updated_at/stats`，
`scope` 实测永远 `DEFAULT`，没有 `parent`/`folder`/`level` 任何字段；`/resource/knowledge/detail` 直接 404。
所以「知识库→目录→书→讲」这棵树只能在本地重建，具体见 §11。

**为什么加 60 秒缓存**：扫 4321 个 Markdown 头部约 1–3 秒，面板每次重渲染都扫一遍会把侧边栏拖卡。
缓存存在 Host 内存里（`invCache`），重启即清；要强制刷新就在 URL 后加 `?refresh=1`。

现状页的数字（4321 篇时）：

```
本地镜像 4321 篇 │ 未归知识库 2055（48%）│ 无标签 15（0.3%）
可拆专题 Top3：万维钢·精英日课6 905 / 优秀员工沟通训练营 370 / 录音笔记 149
```

**降级入口**：同一份 summary 也放进了「设置 → Mgetbrain」页（`MirrorSummary` 组件），
万一侧边栏 slot 在某个版本上不生效，设置里照样看得到。

### 重渲染验证方式（没浏览器也能测）

侧边栏在浏览器里，但我不能操作 DOM。所以用了一个离线渲染作为代替：
用最小 React 替身（只实现 `createElement/useState/useEffect/useCallback`）把 `renderStructure()`
拉出源码直接执行，把元素树拍平成文本，覆盖六个场景：加载中、展开到「讲」、加载失败、镜像空、
勾选后的动作条。六个都逐行对了输出（树层次、缩进、条数、☐/☑）。

**这能证明的**：组件函数不抛异常、四个状态分支都有输出、层级与条数与真数据一致。
**这不能证明的**：真实浏览器里的点击、滚动、样式渲染。那两项只能刷新页面人眼看。


### 一个统计陷阱：平台名会盖掉课程名

第一版把标签和知识库一视同仁统计，结果排行第一是「得到」2665 ——
那是平台名，不是课程。加 `isTopical()` 黑名单过滤（排除“得到/录音笔记/图片笔记”
以及一切以“笔记/记录”结尾的名字）后，排行才变得有意义。

### 四项目标的证据强度（诚实版）

| 目标 | 已验证 | 未验证的边界 |
|---|---|---|
| (1) 手工输入 Key/ID | 真组件渲染出 2 个 `type=password` 输入框；模拟输入→点保存→`creds.set` 两次→输入框清空→提示“已保存” | 真实浏览器里的鼠标点击/键盘输入（我用的是直接调 `onChange`/`onClick`） |
| (2) 密钥安全存储 | 凭据库优先于环境变量（优先实测）；日志里 4 个测试密钥一个都没出现；写入只走 `creds.set`，不进组合树；`.credentials.yaml` ACL 实测与普通配置一样 | **它不是 OS 密钥链**，同账号进程可读；未做“实际落盘后与备份 hash 一致”的真实写入测试（怕动你的库，用了隔离 stub） |
| (3) 接入信息五项 | mock 成功响应下，渲染树里会员状态 / 配额 4 项 / API 地址 / 数据目录 / 自检结果 **全部出现**；真 `gn.py` + 真 `index.js` 路由处理器 | **从未见过真实 `openapi.biji.com` 的成功响应**——所有“成功”都是本地 mock 走真代码路径 |
| (4) 可复制说明 | 真点“复制说明”→剪贴板拿到 335 字符 / 12 行 / 6 条用法 / 含安全约束 | 浏览器可能拦 `navigator.clipboard`（已有降级提示 + 自动选中文字） |

**一句话**：代码层面的四条都跑通了，剩下的是**真实凭据下的端到端确认**——那个只能由你填 Key 来完成。

---

## 11. 层级结构：知识库 → 目录 → 书 → 讲 → 划线（2026-11-16 实测）

### 11.1 你的描述 vs 平台真实能力

你说的结构：

```
知识库（最大集合，如万维钢）
  └─ 目录（精英日课1 / 2 / 3）
       └─ 书（通常拆成 6 讲）
            └─ 讲（每讲一篇笔记）
                 └─ 划线（每划一下 = 1 条笔记）
```

**平台只提供最上面和最下面两层**，中间三层要自己重建。证据：

| 你以为有 | 实际 |
|---|---|
| 知识库能套知识库 | ❌ `/resource/knowledge/list` 只返 `id/topic_id/name/description/cover/scope/created_at/updated_at/stats`，**无 parent/folder/level**；`scope` 恒为 `DEFAULT`；`/resource/knowledge/detail` → 404 |
| 笔记能附加笔记（多级） | ⚠️ **只能一层**。给子笔记再加子笔记 → `{"code":10000,"message":"当前笔记不允许创建子笔记"}` |
| 能改附加关系 | ❌ `parent_id` **不可变**：`note/update` 传 `parent_id` → `parent_id is not supported when updating an existing note; use save_note with parent_id to create a child note`（`constraint: immutable_parent_relation`）。既不能改挂、也不能摘下 |
| 能列出一篇笔记的子笔记 | ❌ 试过 `/resource/note/children`、`/child/list`、`/attach/list`、`/relation`、`/list/child` —— 全部 404。只能在 `note/detail` 里看 `children_count` 和 `children_ids` |

### 11.2 推荐结构（已在代码里实现）

因为服务器不提供中间层，所以**层级全部从本地镜像推导**，不存到线上。
推导规则（`gn.py` 的 `_course_of` / `_book_of`）：

| 层级 | 从哪来 | 例子 |
|---|---|---|
| **知识库** | `topics` 字段（官方真实存在的） | `icosa`、`working`、`family` |
| **目录（专栏/课程）** | 标签里除「得到」以外的那个 system 标签 | `万维钢·精英日课6（年度日更）`、`熊太行·关系攻略` |
| **书** | 文章标题 `《》` 里的那段 | `《智能简史》5：模型思考者` → `智能简史` |
| **讲** | 文章标题全文 | `《智能简史》5：模型思考者` |
| **划线** | 每一条 `ref` 笔记（type=`ref`） | 同一讲平均 21 条 |

真实验证结果（4321 篇，2055 篇未归任何知识库）：

```
(未归知识库)
  └─ 万维钢·精英日课6（年度日更）  905 条 / 14 本书
       ├─ 智能简史        140 条 / 10 讲   ← 一本拆 10 讲，每讲 6–19 条划线
       ├─ 心智重构         96 条
       ├─ 怎样激励10到25岁的人   81 条
       ├─ 萎靡            72 条
       └─ …
```

**为什么“讲”这一层必须存在**：如果不按文章题目聚合，905 条划线就是一堆看不出结构的碎片——
用户根本不知道它们在说什么。按「讲」聚合后，一屏幕就能看出“这本书讲了什么、我划了哪些”。

### 11.3 为什么不把一本书的 100+ 条划线做成子笔记

技术上能做（已实测），但**强烈不推荐**，理由是四个硬约束：

1. **只能一层**：书的子笔记不能再有子笔记。书 → 讲 → 划线这个三层结构压根表达不了。
2. **父笔记不可变**：建错了不能改、不能摘下，只能删了重来。
3. **删父会丢子**：实测删掉父笔记后，子笔记返回 `10500 note_not_found`（被连带删除或隐藏）。
   一不小心删掉“书”，下面几十条划线全部消失。
4. **没有反向接口**：无法“列出这本书的所有划线”，只能逐条 `note/detail` 看 `children_count`。
5. 而且这个账号里 **4326 条笔记只有 10 条有子笔记**（共 12 个子）——说明这个功能官方自己也没当主结构用。

**已否决的方案**：把「书」建成父笔记、把「讲」建成子笔记。
否决理由：一本书 10 讲、每讲十几条划线，一共 140 条。1 层限制下你只能选“书→讲”或“讲→划线”，
两层都想要就必须突破平台限制，而突破不了。且建完不可改，风险远大于收益。

**实际采用的方案**：

- 层级只存在于**本地**（`gn.py inventory` 重建，侧边栏展示）；
- 线上用**标签 + 知识库**做扁平分组（官方支持、可反复调、不会丢数据）；
- `parent_id` 只留给**将来真正小规模、提前规划好的**附加关系（比如把“我对这本书的总结”挂到“这本书”下面），
  不用来搬运已有划线。

### 11.4 给界面和调整的建议

- 想把一个目录独立出去（比如「万维钢·精英日课6」单占一个知识库）：按**目录**批量加知识库，
  不要按单条笔记一条条移。
- 「得到」这个标签是平台自动加的（全库 2665 条），**不要拿它当分类维度**。
- 2055 条未归知识库的笔记里，大部分是课程划线——它们靠「目录」标签就能认出来，
  所以“未归知识库”不等于“没法分类”，不要因为这个数字焦虑。
### 11.5 写操作已经接通（2026-11-16 实装）

读完层级只是前半；真正要能改。现在的链路是四步，每一步都有证据：

```
勾选「讲」→ POST /plan（Host 用 resolve 把路径翻成 note_id，产出 plan.json）
          → 界面预览动作表（不联网）
          → 点「先干跑」→ POST /apply {dryRun:true}（gn.py apply --dry-run，发 0 个请求）
          → 点「我要真写」再点一次 → POST /apply {dryRun:false}（真写）
```

**为什么不让浏览器直接拼 plan**：浏览器拿不到数据目录路径、写不了文件，而
`gn.py apply` 必须读一个真实 `plan.json`。更关键的是 **note_id 必须由同一份镜像数据解析**——
让浏览器带着 4000 个 id 来回传，既没必要也容易和命令行的结果错位。
所以新增了 `gn.py resolve`：界面只传长得像 `知识库/目录/书/讲` 的路径，
Host 把路径交给 `resolve` 换回 note_id。两边走同一个 `_parse_md_head`，数量不会对不上。

**`resolve` 的三层实测**（同一份镜像，`\x1f` 分隔，给几段就匹配几层）：

| 传入的路径 | 解析出的 note_id 数 | 与树里显示的是否一致 |
|---|---|---|
| `智能简史/《智能简史》10：文明之旅（完）` | 12 | ✅ 12 |
| `智能简史`（整本书） | 140 | ✅ 140 |
| `万维钢·精英日课6（年度日更）`（整个目录） | 905 | ✅ 905 |

**动作怎么生成**：

- 归到知识库 → **一条** `kb_batch_add`（官方有批量接口，一次最多 20 个 id 自动切块）。
- 加标签 → **逐条** `tag_add`（官方没有批量标签接口）。140 条的整本书就是 140 个动作，
  界面上只展开前 50 条，其余显示「…还有 90 个动作未展开」。

**护栏（按你的要求做得比较啰嗦，因为面板能被鼠标误触）**：

| 位置 | 护栏 |
|---|---|
| `/plan` 路由 | 只允许 `tag_add` / `tag_delete` / `kb_batch_add` / `kb_remove` 四个 op；带 `note_delete` 直接 400 |
| `/plan` 路由 | 单次最多 2000 个选中路径（防止一次选爆） |
| `/apply` 路由 | 必须显式传 `confirm: "APPLY"`，否则 400 |
| `/apply` 路由 | 默认 `dryRun: true`；真写要再传 `dryRun: false` |
| `/apply` 路由 | 超过 200 个动作的真写必须额外传 `allowHighRisk: true` |
| 界面 | 「我要真写 → 需再点一次」→ 变成红色「确认写入线上（不可撤销）」才真发 |

**没有做的事（故意的）**：

- **没有把删除接进分类调整**。删除必须走 `gn.py note-delete` + `--confirm DELETE` 的独立流程，
  不允许从「勾选一下」触发。你提到的「删除没用的」我还没接——它需要一个独立的入口和
  输入确认词，不应该和分类调整混在一个按钮里。
- **没有做「移动」，只做「叠加」**。`kb_batch_add` 是加入知识库，不会把笔记从原知识库移走；
  `tag_add` 是追加标签，不会覆盖旧标签。要去掉旧的得显式 `kb_remove` / `tag_delete`。
  这是官方语义，不是我们的懒惰——批量「移动」在 API 层就是不存在。

**离线验证方式**（不启浏览器、不启宿主，直接跑）：把 `index.js` 里三个 render 函数
用 React 替身抽出来跑 19 个场景，含：空数据、加载中、失败态、140 条截断、armed 态、
执行成功/失败结果。全部通过。这类验证的价值是**首帧 undefined 这种致命 bug**
（曾导致永久空白）会被抓住，而不是等用户看到白屏。

### 11.6 「执行日志」页读的是真实审计文件

之前这个页是空壳（`log.lines` 恒为 `[]`）。现在 `GET /plugins/getnote/log?lines=200`
读 `<数据目录>/logs/<YYYYMMDD>.jsonl` 的最后 N 条，一行压成一句人话：

```
2026-11-16T10:15:04+08:00  OK       POST /resource/note/delete        366ms  note_delete(HIGH RISK)
2026-11-16T10:15:13+08:00  FAIL     GET  /resource/note/detail code=10500 note_not_found 249ms
2026-11-16T10:31:59+08:00  DRY-RUN  POST /resource/knowledge/note/batch-add      kb_batch_add
```

状态三档：`OK` / `FAIL`（`success:false`）/ `DRY-RUN`。不缓存——日志随时在长，
缓存会让人以为没动静。页头显示文件名与总条数，右上角有「刷新」。

### 11.7 拖拽归类 + 撤销（2026-11-18）

**拖拽**：目录行与书行可拖到「我的知识库」里任意一个库上，松手即生成计划（**不直接写**）。
- 为何不直接写：拖拽只是意图，可能拖错。必须先在「确认执行」页看到「把 N 条归到 X」才能决定。
- 为何书架不可作目标：那 111 个是平台按书自动建的，往里拖会造出双重归属，且用户删不掉书架。
- 勾选框仍逐层可用，两者不冲突：拖拽改「放到哪」，勾选改「选中哪」。

**撤销**：每次**真写**前自动拍一份「归属快照」，失败就**中止写入**（宁可这次不改，不能改了无法回退）。

```powershell
python gn.py undo-snapshot --plan state/plan.pending.json   # 只读
python gn.py undo --plan state/undo-20261118-165613.json --confirm UNDO --dry-run
python gn.py undo --plan state/undo-20261118-165613.json --confirm UNDO
```

为何不能只靠反向操作：`kb_batch_add` 是「加入」不是「移动」，天真的 `kb_remove` 会把原本的归属也踢掉。
必须知道「改之前是什么样」——所以存快照，按**状态收敛**回滚，而不是执行逆操作。

**实测闭环**（真笔记 `1927331041815714728`）：

| 阶段 | topics | 三个原有标签 |
|---|---|---|
| 写前 | `[]` | 完整 |
| 写入后 | `[icosa]` | 完整 |
| 撤销后 | `[]` | **完整（一条无损）** |

三道闸门实测均生效：重复撤销被拒、缺 `--confirm UNDO` 被拒、`--dry-run` 不改状态且幂等（第二次算出 0 个动作）。
详见 [docs/UNDO-DESIGN.md](docs/UNDO-DESIGN.md)。

### 11.8 发芽 / 审问 / 连线（2026-11-18）

**先说平台事实**（逐个探过，全部只读 GET）：

| 端点 | 结果 |
|---|---|
| `GET /resource/note/sprout?id=` | **200**，返回 `{sprout, has_sprout}` |
| `POST /resource/note/sprout` | 404（**不能通过 API 生成发芽**） |
| `/resource/ai/sprout` 等 13 个候选 | 404 |

所以本插件的做法：**平台只能查，生成由 DSH 的 AI 做**。

```powershell
python gn.py sprout --note-id 1918061344897183496          # 查平台已有发芽
python gn.py context-pack --note-id 1918061344897183496   # 拼素材包（纯本地，不联网）
python gn.py prompts                                     # 看/改提示词
```

`context-pack` 产物：中心笔记 + 同系列其他讲（`siblings`）+ 跨系列相关段落（`related`）+ 关键词。

**关键词质量踩了三次坑**（真实记录，别再重蹈）：

| 版本 | 做法 | 结果 |
|---|---|---|
| v1 | 滑窗取 2–4 字 | 抽出「整体来讲」「的东西」→ 相关全是噪声 |
| v2 | 加黑名单 + 提高门槛 | 仍有「这一块」「整体来」→ 滑窗不认词边界 |
| **v3** | 先按标点切短句 + 禁虚词/数词开头 + 禁填充词子串 + 用全库文档频次剔除泛词 | 「硬技能」「软技能」「数据壁垒」 |

效果：同一条笔记的相关结果从「8 个全是误命中」变成「1 个真相关」。**宁可少，不要假。**

**提示词可改**：存在 `<数据目录>/prompts/{sprout,interrogate,link}.md` + `actions.json`，
首次自动创建，之后**改文件即生效，不用改代码**。内置三个按钮：发芽 / 审问 / 连线。

三者**都不自动写入**——结果只展示，确认后你自己决定。详见 [docs/AI-ACTIONS.md](docs/AI-ACTIONS.md)。

### 11.9 知识管理立场（为何功能长这样）

完整推导见 [docs/PKM-THEORY.md](docs/PKM-THEORY.md)。三个决定性的实测事实：

1. **94% 是课程划线（4052 条），只有 6% 是你自己的记录（269 条）** —— 两堆必须分开对待。
2. **只有 1 条笔记同时在 2 个以上知识库** —— 现有库实质是单归属，不需要复杂多归类。
3. **110/122 个「知识库」与同名标签重复** —— 进一步说明现有结构是「来源桶」而非「主题分类」。

结论：
- 4052 条划线按**来源形状**组织（机器做，已实现）；269 条自有记录才适用 PARA 的「可行动性」。
- **不要**把 4052 条按主题重分类进 PARA：一门课能横跨经济学到育儿，重分类等于人工读 4052 条。
- 树上做「浏览与批量搬运」，**不在树上做思考**（层级不适合发现跨域联系）。
- 真正缺的不是更花的分类树，而是渐进式总结的 **Layer 2–4**（加粗/高亮/用自己的话）。

### 11.10 界面修正（2026-11-18）

- **颜色变量全部改正**：之前用了一批**根本不存在**的变量（`--dsh-bg-secondary`、
  `--dsw-alias-status-danger` 等）。`var(--x, fallback)` 会静默取 fallback，
  所以浅色主题下会变成**白底白字**。现在用的 16 个 token 已逐个从 `app.asar` 枚举验证存在。
- **去掉「非书本／单篇」伪层级**：63 个目录里有 61 个，书层只有一个孩子叫这个占位符，
  占一整层缩进却零信息量。现在直接展平到目录下。
- **每一层都能勾选**：知识库 / 目录 / 书 / 讲 各自有勾框，父层级不再只能逐篇点。
- **`#untopiced` 映射修复**：界面合成行 `#untopiced` → 服务端真实前缀 `(未归知识库)`，
  否则选「整行 2055 条」会解析不到任何笔记。

> **重启规则（实测修正）**：改 `client.js` → 刷页即可；改 `index.js` 新增的**路由** → **必须重启 App**
> （进程内存里的注册表不会热更）；改 `gn.py` → 立即生效（每次请求重新拉起子进程）。

### 11.11 删除 + 知识库下拉 + 颜色彻底修正（2026-11-19）

用户报三个 bug，逐个查到了根因，都不是“写字错了”而是接错了东西：

**（a）白色底色按钮看不见字**

根因不是“用了错的变量”，而是**用了根本不存在的变量**。实测从 `app.asar` 枚举：
`--dsw-alias-*` 共出现 155 个，但**真正被定义只有 138 个**，17 个是只被用、从没定义
（`--dsw-alias-fill-l1`、`--dsw-alias-bg-l1`、`--dsw-alias-bg-elevated`、
`--dsw-alias-label-error` 等）。`var(--x)` 查不到就是空，于是背景透明、文字用硬编码 `#fff`
→ 深色主题下白底白字。

修正：填充用 `--dsw-alias-state-business-primary`，前景用
`--dsw-alias-label-primary-foreground`（这个 token 在浅色下是 `#fff`、深色下是 `#0f1115`，
**会随主题翻转**，所以才是安全的前景色）。硬编码 `#fff` 已清零。

> 验证方式：把 `app.asar` 解开、枚举所有 `--dsw-alias-*\s*:` 定义，再拿 `client.js`
> 用到的 15 个 token 去比对——**15/15 全部已定义**。这一步不能省，因为
> `var(--x, #fff)` 的 fallback 会把拼写错误完全掩盖。

**（b）填知识库 ID 根本做不到**

根因：界面要 `topic_id`，而 `inventory` **一直就返回 `knowledge_bases[].id`**，只是没接。
现在改成下拉选择（`ownKb` 里就是真实 id），另加「新建知识库」→ 只填名字，
后端 `kb_ensure` 按名字幂等创建，**不需要任何人看见 ID**。

**（c）删除功能（可加提醒）**

删除是单程票：官方 FAQ 自列「删除后直接彻底删除，未进回收站」「存在严重误删风险」。
所以不是简单加个按钮，而是四道闸门：

| 闸门 | 位置 | 作用 |
|---|---|---|
| ① 默认收起 | 界面 | 不主动展开就不会误触 |
| ② 勾「我知道可能不可恢复」 | 界面 | 服务端校验 `acknowledged:true`，**不勾直接 400** |
| ③ 干跑 | 界面 + `gn.py` | 只做备份不发删除包 |
| ④ 二次点「真的删掉」 | 界面 | 先「准备删除」置 armed，才出现真删按钮 |

**关键设计：删前必须先存本地副本**。`_save_to_trash()` 抓 `note/detail` 的正文，
写成 `<数据目录>/trash/<note_id>_<标题>.md` + 同名 `.json`；
**存不下来就拒绝删除**（返回 4），不给“反正有回收站”的幻觉。

> 诚实的边界：这只保证**内容救得回来**，不是**操作可撤销**。
> `note_id` 由服务端分配，重建出来是新 ID，历史链接与标签引用全断。

**（d）顺带修掉两个静默 bug**

- **层级路径分隔符不一致**：树里用 `\u0000` 分隔（`ck` / `bKey` / `lk`），
  `gn.py` 要 `\x1f`。不转就会把整串当成一个库名，**永远 0 命中且不报错**。
- **扁形书占位层残留**：树里用 `\u0001flat` 占位对齐列，镜像里没有这一层，
  必须剔掉，否则带「书」层的路径也永远 0 命中。

新增两个路由（都要重启 App 才生效）：
- `POST /plugins/getnote/delete` — 需 `confirm:'DELETE'` + `acknowledged:true`，默认干跑
- `POST /plugins/getnote/resolve` — 把勾选的层级路径解析成 `note_id`（只读、不联网）

实测验证：单层/两层/三层含 flat 四种路径形态均正确命中 120 条；
删除干跑写出 483 字节含全文的 md；服务端对 `acknowledged:false` 返回 400。

> 本轮仍然**没有**做批量删除，也**不打算做**。单程票操作必须一条一条来。

### 11.12 合并 + ID 表 + AI 提纯包（2026-11-19）

前三轮补的是「能不能用」，这一轮补的是目标里剩下的三件事：**合并笔记**、
**名字/ID 不再静默失效**、**让 AI 真读懂用户在忙什么**。

**（a）合并笔记（目标②的最后一块）**

平台没有合并接口，只能「读旧正文 → 写一条新笔记」。这个动作有个不可消除的代价：
**新笔记会得到全新的 `note_id`，所有指向旧 ID 的引用全断**。所以设计上不假装它可逆：

- 默认**不删任何旧笔记**，只做内容合并；删旧仍是上面那套一条一条的删除流程。
- 新正文每个来源块都带 `note_id` 和原始链接，半年后还能回溯这句话是谁说的。
- 合并来源会另存一份 `state/merge-<时间戳>.json`，记下「这条新笔记是从哪几条拼的」。

闸门三道（实测全部生效）：

| 闸门 | 命令层 | 路由层 | 界面层 |
|---|---|---|---|
| 至少两条 | 退出码 2 | 400 | 按钮变灰不可点 |
| 承认新 ID | 缺 `--i-understand-new-id` 退出码 3 | 需 `acknowledged:true` | 勾「我知道会得到新 ID」才解锁 |
| 默认干跑 | 不带 `--apply` 只预览 | `dryRun !== false` 即干跑 | 先「准备合并」再出真按钮 |

实测：3 条 → 1 条，正文 3,583 字符，每段来源齐全；只有 1 条时退出码 2；
`--apply` 但没承认新 ID 时退出码 3；不存在的 ID 时**整单中止**（不静默跳过）。

**（b）ID 表：把「名字当外键」这个隐患摆到明面上**

插件里有大量「按名字找目标」的地方，用户改个名字就会静默失效且不报错。
`gn.py ids` 扫全部镜像，重建 `state/ids.json`（名字 → id），并检三类问题：

```
✅ ID 表已写入 state/ids.json
   扫描镜像 4321 篇｜知识库 122 个｜标签 841 个

⚠ 同名不同 ID（1 组）——按名字选目标会选错：
   [标签] 「AI」→ 36117013, 36111209（26 篇）
```

这是**实测抓到的真 bug**：标签「AI」下有两个不同 ID。任何按名字做标签操作的地方，
都会只命中其中一个而悄悄漏掉另一个。

> 性能踩坑：第一版 33.9 秒，因为每个文件读了两遍（`_parse_md_head` 一次、
> 再 `read_text` 一次抓标签 id）。改成让 `_parse_md_head` 一并解出 `tag_pairs`
> 后降到 **2.0 秒**（17 倍）。标签 id 必须用**对列表**而不是 dict——
> 同一条笔记可能挂两个同名不同 id 的标签，用 dict 会吃掉一个。

**（c）`agent-brief`：给 AI 读的「我在忙什么」**

`summary` / `inventory` 是给**人**看结构的，AI 需要的是内容层面的东西。
`agent-brief` 只读本地镜像，输出四块：

| 块 | 内容 | 为什么需要 |
|---|---|---|
| 待办 | 从 AI 总结的 `### 📋 待办事项` 小节里抽纯列表行 | 实测 **431 条**没闭合的待办，是 AI 最能直接帮上忙的地方 |
| 主要来源 | 按课程/专栏数时间落在哪 | 看出来时间分配，但**自己的计数全是 0** |
| 自己的主题 | 那 269 篇自己记的按标签+知识库聚合 | 只有这块能回答「我在忙什么」 |
| 最近动态 | 按时间倒序的自己记录 + 各自待办数 | 接续上下文用 |

关键判断：**不能把 4052 篇摘录当成「工作内容」**。它们按来源数是头部
（「万维钢·精英日课6」926 篇），但自己的计数是 0 ——
那不是工作方向，是阅读记录。所以单独分出 `own_topics`。

实测发现（这才是真正的问题）：自己记的 269 篇里，**219 篇没进任何知识库**（81%），
60 篇只有「得到」或载体标签、没有说话的主题标签。剔除这些无效标签后，
真正有主题的只剩：高考志愿填报(13)、强基计划(8)、AI(7)、志愿填报(5)、
航空服务(5)、击剑(5)、民航服务(4)、训练记录(4)、AI项目(3)。
知识库名是 `susan` / `aisnip` / `fencing` / `university` 这种用户自建短名。

> 「得到」标签下有 38 篇自己的随手记（`plain_text`），全是生活记录
> （「秋天的石榴」「一桶酸奶」「咖啡盲盒」）。它不是主题，是来源标记——
> 所以统计时用 `_content_tags()` 把它和载体标签一起剔掉。
> 剔除前后「未归」从 13 篇变成 49 篇：**之前那个 13 是被「得到」标签蒙住了**，
> 看起来有归类，实际没有主题信息。

> 待办只认标题小节、不全文搜「待办」：实测普通正文里这个词出现很多次
> （「讨论待办事项」），全搜会把一堆不是行动项的话当成任务。

**（d）三条新路由（宿主半，需重启 App）**

- `POST /plugins/getnote/merge` — 需 `confirm:'MERGE'` + `acknowledged:true`，默认干跑
- `GET  /plugins/getnote/ids` — 返回 `state/ids.json` 的一致性报告（纯本地）
- `GET  /plugins/getnote/brief?days=&top=&recent=` — 工作内容提纯包（纯本地）

界面：「笔记现状」页新增「AI 能读到什么」卡片（待办 / 自己的主题 / 名字撞 ID /
重新体检）；分类调整页新增「合并笔记」区。

> 路由层踩坑：`runGn` 返回的 `code` 是**字符串** `'OK'` / `'EXIT_1'`，
> 不是数字。写成 `ok: out.code === 0` 会**永远 false**，把成功的合并报成失败。
> 全仓库现已统一用 `out.ok`。

**（e）样式表修复**

`P.rowLine` / `P.boolRow` 之前一直在用却**从未定义**，取到 `undefined`
→ 「一行一条」的布局其实一直没生效（不报错，只是挤成一团）。已补上。
现在 `panelStyles()` 共 51 个键，`P.*` 用法与定义**零缺口**（自动校验）。

验证：24 项断言全绿（文案中英 300/300 对齐、213 个 `T()` 零缺失、
合并三道闸门、样式键零缺口、无硬编码颜色）。



### 11.13 本地全文检索 + 按库发布（2026-11-20，v2.9.0）

这一节补的是原目标里最难的一项：**把库当知识库用**。
前 12 节解决了「怎么整理」，这一节解决「整理完怎么查、怎么给别人」。

**（a）为什么自己做索引，不用官方 recall**

`gn.py search` 调的是官方 `recall`，实测三个硬限制：

| 限制 | 后果 |
|---|---|
| 语义 Top-K，上限 10 条 | 「把 4321 篇当知识库查」根本不够 |
| 空结果不证明没有 | 判重时不能依赖它 |
| 没有「按知识库过滤」参数 | 而「在某个库里找」是最常用的问法 |
| 每次都要联网 + 吃配额 | 检索是最频繁的动作，不该每次都花钱 |

所以新增 `gn.py index` / `gn.py find`，走本地 sqlite FTS5，**不联网、不耗配额**。

**（b）中文分词踩的两个坑（都实测过）**

- `unicode61`（默认）：把一整串中文当成**一个 token** → 搜「高考」命中 **0**。
- `trigram`：要求查询 **≥3 字符** → 「高考」「填报」这种两字词全废，
  而两字词恰恰是中文里最常见的。

最终方案：**自己切相邻二元组（bigram）再交给 FTS5**。
「志愿填报」→ `志愿 愿填 填报`，两字词照样命中。实测：

```
搜「高考」    -> '高考'                 2 命中
搜「志愿填报」-> '志愿 愿填 填报'      1 命中
搜「填报」    -> '填报'                1 命中
```

代价是索引体积约为原文 2 倍（18.4 MB 镜像 → 42.2 MB 索引），可以接受。

**（c）摘录不能直接用 FTS5 的 `snippet()`**

`snippet()` 只能作用在**被索引的列**上，而那一列存的是二元组 token，
截出来是「志愿 愿填 填报」这种碎片，没法给人看。
所以原文另存在 `meta.body`（只用于生成摘录，不参与检索），
`_make_snippet()` 从原文定位查询词再截上下文。

**（d）正文要截掉 `## AI 总结`**

我们的镜像在正文后面还跟一段自己写的 `## AI 总结` 包装层。
不截掉的话搜「总结」会命中**全部 4321 篇**，把真正相关的结果全冲掉。
截掉后索引从 50.1 MB 降到 42.2 MB。

**（e）实测数据**

| 动作 | 结果 |
|---|---|
| 首次建索引 | 4321 篇 / **39.3 秒** / 42.2 MB |
| 增量（无变化） | 4321 未变 / **2 秒** |
| 单次检索 | **约 170 ms** |

**（f）按知识库发布**

`gn.py publish --kb <库名>` 导出一个**自包含**目录：

```
index.html     目录页
<标题>.html    每篇一页
search.html    纯前端搜索（数据内联成 JSON）
```

三个设计取舍：

1. **不引任何外部 CDN** —— 拿到目录的人可能在内网、断网。css/js 全内联，
   字体用系统字族。实测外部资源引用数 = **0**。
2. **搜索数据内联进 html**，不放外链 js —— `file://` 下外链脚本会被 CORS 挡住，
   而「双击 index.html 就能用」是硬要求。
3. **文件名保留中文**，但挡掉路径分隔符与控制字符，并处理重名（实测有同名笔记）。

实测：`云端革命` 库 130 篇 → 132 文件 / 425 KB / **0.9 秒**。

导出物里**不含任何凭据**，也不含 note_id 之外的私有字段。

**（g）三条新路由**

| 路由 | 方法 | 说明 |
|---|---|---|
| `/plugins/getnote/find?q=&kb=&type=&limit=` | GET | 本地检索 |
| `/plugins/getnote/index` | POST | 建/刷新索引 |
| `/plugins/getnote/publish` | POST | 按库导出 |

`index` 与 `publish` **不需要 `confirm` 闸门** —— 它们只写本地文件，
不发任何写请求到平台。这是有意区分的：闸门是给「改线上数据」用的。

`find` 在没建索引时返回 **409 + `needIndex: true`**，而不是笼统的 400：
界面据此显示「点建索引」而不是「检索失败」。

**（h）界面**

「笔记现状」页新增「本地检索与发布」区：搜索框（300 ms 防抖）、
「建索引」按钮、知识库名输入 + 「导出」按钮。
七个状态都做了桩渲染验证：idle / needIndex / loading / ready-empty /
ready-hits / pub-ready / error。

> 防抖这里有个容易忽略的坑：异步检索要做**序号比对**（`srchSeq`），
> 否则「先发的请求后返回」会用旧结果覆盖新结果。

**（i）这一项仍然没做的**

- 检索是**字面匹配**，不是语义检索。搜「高考」不会命中「升学考试」。
  想要语义得接 embedding，那是另一个量级的工作。
- 导出是**静态站点**，不是「发布到某个平台」。没有账号体系、没有权限控制。
- 这里的「给别人读」= **把静态目录发出去**，仅此而已。
  此前把这件事写成「多人使用 / 多人协作维护同一份库」是**错的理解**：
  本插件不做多用户协作、不做账号体系、不做权限与冲突合并（已明确否决，
  理由见 `docs/PKM-ROADMAP.md` §4.3）。真实的「多人」是**一个共享账号里混着
  三个人的内容**，由用户一个人维护分类 —— 见下一节 §11.14。

### 11.14 归属（persona）：一个账号，三个人（2026-11-20，v2.10.0）

**（a）先把话说清楚：这不是多人协作**

这一节纠正一个被写歪很久的定位。用户原话：

> 多人维护这个你理解错了。我是说我这个 get 笔记是多人用一个账户，所以内容会比较杂，
> 有学习的（孩子）也有工作和 AI 思考的（我的）还有部门会议的（老婆的）。
> 这些信息是让你做好分类的背景信息。维护（做分类）主要还是我一个，
> 不是这个插件要多人使用做处理。

| 曾经写歪的说法 | 真实情况 |
|---|---|
| 多租户 / 多人协作编辑 / 团队知识库 | **不做**。没有账号体系、没有角色权限、没有冲突合并 |
| 三个人各有一个账号 | **只有一个** Get笔记 账号，三个人共用 |
| 插件是给人「一起用」的 | 插件只服务**一个维护者**（用户本人），帮他把混杂内容按人分开 |
| 分类是团队流程 | 分类是用户一个人的日常动作，插件只是让他少花力气 |

定位因此收敛成一句话：**让 AI Agent 分清「谁的事」**。
不分清的代价很具体：不提纯的话，Agent 会把「孩子的志愿填报」当成我的工作方向，
把「老婆的客服中心例会」当成我的部门会议，然后拿一堆别人的事给我出主意。

**（b）数据构成：为什么「按人分开」是刚需**

全账号 **4321 篇**（本地镜像实测）：

| 类别 | 数量 | 占比 | 性质 |
|---|---:|---:|---|
| **自己记的**（录音 / 会议 / 手记 / 图片文字等 8 种 type） | **269** | **6%** | 带工作方向与待办，**需要按人分开** |
| 得到课程 + 电子书摘录 | **4052** | **94%** | 全家一起读的语料，基本不属于某一个人 |

自己记的这 269 篇里，**只有 50 篇进了知识库，219 篇没有任何知识库**。
也就是说：绝大多数内容既没有「是谁的」标记，也没有主题标记 —— 这正是归属轴要解决的问题。

收紧闸门后的实测分布（`gn.py personas`，2026-11-20）：

| 归属 | 全部笔记 | 其中自己记的 |
|---|---:|---:|
| 我 | 118 (2.7%) | 77 |
| 孩子 | 98 (2.3%) | 74 |
| 老婆 | 19 (0.4%) | 19 |
| 共用 | 3984 (92.2%) | 0 |
| 未知 | 102 (2.4%) | 99 |

「共用」占 92% 不是没判，是**判对了**：4052 篇摘录本来就属于全家，不该硬塞给某一个人。
需要按人看的只有自己记的那 269 篇，其中 **170 篇（63%）已定案**，
剩下 79 篇留「未知」等一个明确指示（另有 20 篇空白/测试笔记，无内容可归属）。

另有 **111 个「得到电子书书架」+ 约 1836 篇未归类摘录**，书名像《克拉拉与太阳》
《自驱型成长》。那是**孩子/家庭在读什么书**，不是用户自建的知识库。
把书架当知识库会让人误以为「我有 111 个知识库」，实际那只是阅读记录。

**（c）三个人的画像**（从真实数据测得，不是设定）

| 归属 | 内容主线 | 命中的知识库（实测篇数） |
|---|---|---|
| **我** | AI 平台、算力、大模型、智能体、国航数字化、飞书、知识管理、数据治理 | `aisnip`(10)、`working`(3)、`icosa`(3)、`projectu`(1) |
| **孩子** | 高考、强基计划、志愿填报、院校专业、高二高三、语文作文提分、击剑训练、大学新生课程 | `fencing`(7)、`university`(6)、`chinese`(1)、`nemomeng的知识库`(1) |
| **老婆** | 民航服务质量管理、客服投诉处理、国航客服中心例会、暑运、民航法修订 | `susan`(16) |
| **共用** | 家里一起读的课程与书本摘录 | `family` 默认为「共用」；绝大多数摘录也从这里出 |
| **未知** | 本地信号不足 | 不硬猜，留给人来指 |

**（d）五类归属**

`gn.py` 里是模块级常量，顺序固定（界面与 JSON 都按这个顺序输出，读者不用靠名字猜位置）：

```python
OWNER_ME      = "我"
OWNER_KID     = "孩子"
OWNER_SPOUSE  = "老婆"
OWNER_SHARED  = "共用"
OWNER_UNKNOWN = "未知"
OWNERS = (OWNER_ME, OWNER_KID, OWNER_SPOUSE, OWNER_SHARED, OWNER_UNKNOWN)
```

**（e）三种信号与权重**（`_owner_of()`）

| 信号 | 权重 | 为什么这么定 |
|---|---|---|
| 知识库命中 | **+12** | 人手动把笔记放进某个库，是最可靠的意图信号 |
| 标题关键词 | **+5 / 个**，最多算 3 个 | 标题是作者自己起的，噪声最低 |
| 正文关键词 | **+1 / 个**，最多算 5 个 | 正文长，单个词的说服力要压低 |
| 按 `note_id` 手动钉住 | **最高优先（score 999）** | 人说了算，直接返回该归属，不再打分 |

**两个「不足以定案」的闸门**（这一条是修出来的，不是一开始就想到的）：

| 闸门 | 规则 | 为什么 |
|---|---|---|
| **泛词** | `PERSONA_WEAK_WORDS` 里的词（`实验` `论文` `大学` `报告` `分析` `训练` `工作`…）**不能单独定案** | 标题命中一个词就 +5 = 阈值，于是一个词就能定案。实测踩到：《AB实验：科学归因与增长的利器》被判给孩子（那是技术书，不是孩子的实验课）；《一页纸的诺贝尔奖论文》被判给孩子（那是我自己写的读书笔记）。这些词描述的是**话题**，不是**人** |
| **摘录** | 摘录要定案，必须有知识库信号，或**两个以上**独立标题词 | 摘录是全家一起读的语料，标题里的词是**书的主题**。实测「数字化」让 **171 篇**得到课程摘录被判成「我」——那不是我的工作内容 |

闸门只压「证据不足的定案」，不碰证据充分的：`击剑`（孩子，4 条理由）、`飞书`（我）、
`susan` 库（老婆，16 篇）全部照旧。收紧后自己记的 269 篇定案率 **63%（171 → 170）**，
几乎没掉，但错判的类别塌掉了 —— 「我」从 368 篇降到 **118 篇**（多出来的 250 篇本来就是摘录）。

判定规则：

- 最高分 ≥ 阈值（5）且**严格大于**第二名 → 判给该人；
- 两个候选**同分** → 判「未知」（说明关键词本身串台，交给人）；
- 分数不够 → 摘录判「**共用**」（全家一起读的），自己记的判「**未知**」。

`why` 字段返回中文理由，例如 `知识库「susan」`、`标题含「强基」`、`正文含「暑运」`。
**没有理由的归属等于猜**，用户无法复核也就无法纠正，所以理由必须落进输出。

**（f）为什么不能只靠关键词（反面代价，实测）**

纯关键词判定归属，269 篇自己记的只能分到：

| 我 | 孩子 | 老婆 | 歧义 | 未知 |
|---:|---:|---:|---:|---:|
| 67 | 81 | 20 | 4 | 97 |

**97 篇（36%）判不出来**，还有 4 篇两边都像。原因是关键词天然串台：
「国航」同时属于我的国航数字化和老婆的国航客服中心，「训练」同时是大模型训练
和击剑训练，「客服」同时是我的智能客服案例和老婆的投诉处理。

所以归属是**三种信号叠加**：知识库归属 + 关键词 + 手动钉住。
关键词只是补充，知识库信号是主力，人随时可以用 `note_id` 覆盖。
这条代价也写进了 `docs/PKM-ROADMAP.md` §4.3。

**（g）用法一：按人盘点（`personas`）**

纯本地、不调 API、不耗配额。回答「这个账号里都有谁的东西、各多少」：

```powershell
python gn.py personas                    # 人读：五类各多少篇 + 自己记的按人拆 + 未知样本
python gn.py personas --into current     # 指定镜像子目录（默认 current）
python gn.py personas --json             # 给界面/Agent 用
```

输出四块：全部笔记按归属、自己记的按人拆开（附命中的知识库）、
空白/测试笔记（单独一堆，标「不用管」）、判不出来带理由的样本清单、归属配置路径。
「空白/测试」单独列，是因为把空白录音混进「需要你指一下」的清单，真正该指的会被淹没。

**（h）用法二：按人检索（`find --owner`）**

索引建好后（`gn.py index`）每条记录都带 `owner`，检索可以直接按人过滤：

```powershell
python gn.py find "强基" --owner 孩子        # 只找孩子的
python gn.py find "客服" --owner 老婆        # 只找老婆的
python gn.py find "智能体" --owner 我 --json # 只找我的，JSON 里每条带 owner
```

不按人过滤时，搜「强基」出来的多半是孩子的志愿填报 —— 和「我自己的工作」
混在同一个结果列表里就没法用。这就是归属轴最直接的价值。

**（i）用法三：按人看工作内容（`agent-brief` 的 `by_owner`）**

`agent-brief` 的提纯包里有 `by_owner` 分块，把「自己记的」按人拆开：
每块给出**篇数、未闭合待办数、命中的知识库、理由样本**。

```powershell
python gn.py agent-brief                 # 人读：其中一块是「自己记的：按人拆开」
python gn.py agent-brief --json          # JSON 里取 by_owner 数组
python gn.py agent-brief --days 30 --json
```

这样提纯包能分别回答「我在忙什么」和「孩子在准备什么」，
不再把孩子的志愿填报算进我的工作方向。分块顺序固定为
`我 / 孩子 / 老婆 / 共用 / 未知`，Agent 读的时候位置稳定，不用靠名字猜哪块是谁。

**（j）「未知」为什么不硬猜**

- 给 Agent 一个**错的**归属，比给不出归属更糟：它会拿别人的事给我出主意，
  而用户根本不知道这个结论是猜的。
- 归错会污染下游：`find --owner` 和 `agent-brief by_owner` 全部跟着错。
- 所以宁可让「未知」**可见**：`personas` 打印未知样本清单（带 `note_id`），
  界面也有归属分布块，人能一眼看到还剩多少没指。
- 判不出来的典型是纯手记（`plain_text`）—— 像「#一桶酸奶」「#咖啡盲盒」这种生活碎记，
  本地信号确实不足，硬猜只会更差。**留给人来指，是设计而不是缺陷。**

**（k）手动覆盖：`state/personas.json`**

路径 = `<dataDir>/state/personas.json`（本机 `C:\dsh\data-getbrain\state\personas.json`）。
**文件不存在就用内置默认**；文件坏了不崩，退回默认 —— 归属判错还能改，崩了就什么都拿不到。

可覆盖三块：`kb`（知识库名 → 归属）、`keywords`（归属 → 关键词数组）、
`notes`（`note_id` → 归属，优先级最高）。示例：

```json
{
  "kb": {
    "susan": "老婆",
    "fencing": "孩子",
    "university": "孩子",
    "chinese": "孩子",
    "nemomeng的知识库": "孩子",
    "aisnip": "我",
    "working": "我",
    "icosa": "我",
    "projectu": "我",
    "family": "共用",
    "新工作库": "我"
  },
  "keywords": {
    "老婆": ["民航", "暑运", "旅客", "民航法", "服务质量", "客服中心", "投诉处理", "服务协同", "航班", "例会"],
    "孩子": ["高考", "强基", "志愿", "填报", "院校", "高二", "高三", "作文", "提分", "班主任", "家长会", "击剑", "教练", "分数线", "专业选择", "新生", "军训"],
    "我": ["AI", "大模型", "算力", "智能体", "飞书", "知识管理", "数字化", "架构", "数据治理", "信管部", "云网安", "综保部", "项目管控", "知识库", "语料", "推理"]
  },
  "notes": {
    "1852421912689929313": "我",
    "1852422090930811609": "孩子"
  }
}
```

只写要改的部分即可，未写的键沿用内置默认。改完**重跑 `gn.py index`**，
让索引里的 `owner` 列刷新（`personas` 是每次现算的，不需要重建索引）。

关键词表刻意避开会串台的词：「国航」「客服」「训练」都不用 ——
串台导致错归属，比判不出来更糟，所以宁可窄。

**（l）索引侧的实现要点**

- `gn.py index` 把 `owner` 存进索引（`meta` 表新增 `owner` 列）。
- 老索引用 `ALTER TABLE meta ADD COLUMN owner TEXT` **增量升级，不重建**（重建 4321 篇要 39 秒，改一个列不值当）。
- 归属配置在建索引时**只读一次**：否则 4321 篇每篇读一次文件，IO 会盖过建索引本身。
- **配置改了必须被感知**（这一条是修出来的，不是设计出来的）：
  增量索引原本只按 md 文件的 `mtime` 判断要不要重算。而改 `state/personas.json`
  **不会碰任何 md 文件** → 索引纹丝不动 → 用户把某条从「未知」指成「老婆」之后
  `find --owner 老婆` 还是搜不到，界面上又看不出任何异常，只会觉得「指了没用」。
  现在把配置的 `mtime` 存进库里的 `kv` 表（`persona_sig`，值为 `logic<版本>|mtime<值>`），变了就**全部重算 owner**。
  重算**只 `UPDATE meta`，不重写 FTS 行** —— 后者会让库从 42 MB 涨到 58 MB
  （FTS5 的废弃记录 `VACUUM` 收不回来）。
- **收空间要两步**：FTS5 的 `VACUUM` 管不到影子表，必须先
  `INSERT INTO notes(notes) VALUES('rebuild')` 再 `VACUUM`。
  实测 57.3 MB → rebuild 1.3 秒 → vacuum 0.4 秒 → **41.6 MB**。
  只做 `VACUUM` 一点不收（就是这么踩的）。

**（m）这一项仍然没做的**

- 归属**不是平台字段**：它是本地算出来的，不写回 Get笔记。换台机器没带走 `state/personas.json` 就会退回默认。
- 归属依赖知识库名与关键词，**知识库改名会让归属漂移**（同一条笔记换了库就换了人），改完要重跑 `index`。
- 没有「归属自动学习」：不做反馈训练，人的修正只体现为 `notes` 里的一条钉死。
- 不做多用户协作、不做权限、不做冲突合并 —— 已否决，理由见 `docs/PKM-ROADMAP.md` §4.3。

---

### 11.15 结构体检、向量检索与一批地基修复（2026-11-26，v2.11.0）

**（a）侧边栏「点了空白」的根因与修复（2026-11-22）**

现象：App 窗口里点侧边栏 Mgetbrain，面板一片空白，DevTools 也不报错。

根因：上一轮编辑误插了一个未闭合的 `React.useEffect(() => {`，把 `pkm` / `srch` / `pub` / `inv` / `log` 等 17 个 hooks 全吞进了 effect 回调体。
hooks 写在回调里不会在组件渲染时执行，组件作用域里根本没有这些变量 → `ReferenceError` → 面板空白。
`node --check` 只证明语法合法，**证明不了结构对**，所以这类事故能溜过去。

修复 + 两道防线：

- **类组件错误边界**（`GetnoteErrorBoundary`）：平台的 `SlotErrorBoundary` 会把渲染期异常吞掉，界面只剩空白。
  类组件的 `componentDidCatch` 不参与 hooks 规则，是唯一安全的捕获位置；捕获后把栈 POST 到 `GET /plugins/getnote/report`。
- **注册两次采样探针**：`atApply` 与 `at1500ms` 各采一次，用来区分「我没注册上」与「注册时机太早」（平台槽树首帧之后才声明）。

验证：`GET /plugins/getnote/report` 里 `at1500ms.panellist.ids` 含 `getnote-workbench`、`mine:true`。

**（b）结构体检脚本：把静默缺陷变成机器断言**

```powershell
node tools/structure-check.mjs     # 退出码 0 = 全绿
```

它拦的都是历史上真实踩过的、**不报错但界面就是不对**的类别：

| 检查 | 拦什么 |
|---|---|
| 所有 hooks 缩进 == 6 | 防止再出现「hooks 被吞进 effect 回调」 |
| useEffect 全在顶层 | 同上 |
| `ctx.*` 都在 `inject` 里 | 防「apply 用了没注入的服务 → 浏览器半不注册」 |
| `P.*` 引用的样式键都已定义 | 防「用了没定义的样式键 → 样式静默失效」 |
| 不用 `--dsh-*`、不硬编码 `#fff` | 防深色主题下白底白字 |
| zh / en 键集相等、`T()` 键都存在 | 防英文模式露中文（本次就抓到 36 个只写内联默认值的键） |
| `id` / `key` 都用 `PANEL_ID` | 防侧边栏与面板寻址不一致 |
| `exports` 含 `./client` 等三项 | 防界面不显示且不报错 |

> 这个脚本本身就是被这次事故逼出来的：client.js 已经 3700+ 行 / 100 个 hooks，靠人眼数括号不可持续。

**（c）新增命令（均纯本地或只读）**

| 命令 | 作用 | 是否联网 |
|---|---|---|
| `gn.py mirror-check` | 本地镜像 vs 线上 list 逐条对账，写操作前跑一次 | 只读，耗读配额 |
| `gn.py vec-index` | 建本地稀疏向量索引（TF-IDF + sqlite） | 不联网 |
| `gn.py vec-search --q <词>` | 本地余弦检索，与字面检索互补 | 不联网 |
| `gn.py summarize` | 渐进摘要 Layer 3（关键句自动）+ Layer 4（模板），只写 `<dataDir>/summaries/` | 不联网 |

对应路由：`GET /plugins/getnote/mirror-check`、`GET /plugins/getnote/vec-search`、`POST /plugins/getnote/vec-index`。

> **向量检索的诚实边界**：这是 **TF-IDF 稀疏向量**，不是语义嵌入。真正的语义向量要 embedding 模型（几 GB）与服务端，
> 与本插件「零第三方依赖、离线、可解释」的硬约束相冲突。TF-IDF 能改善排序，但**同义不同词仍会漏**。
> 要语义检索，用 `dsh-rag`（它走云端 embedding）；本插件负责把字面检索与稀疏向量检索做到极致。

**（d）标签双 ID：不再静默命中其中一个**

实测标签「AI」有两个 ID（`36111209` / `36117013`，共 26 篇）。平台按名字处理，命中哪个都不报错。
现在：

- `gn.py tag-remove --tag <名字>` 会先用 `state/ids.json` 解析；**重名直接报错并列出所有 ID**，不猜。
- 计划里的 `tag_add` / `tag_delete` 同理（`tag_delete` 新增 `tag_name` 写法，也有消歧）。
- `kb_ensure` / `topic_name` 遇到同名不同 ID 的知识库也会报错。
- `gn.py ids` 的 `same_name_multi_id` 报告继续作为全局体检。

**（e）计划与审计日志改用 ID 键（ID 表第 2 步）**

`apply` 现在会把**解析后的动作**（`topic_name` → `topic_id`、标签名 → `tag_ids`）写进结果日志
`state/apply-<时间戳>.json` 的 `resolved_actions`，审计时不再需要回查「当时那个名字是哪个 ID」。
撤销记录本身已经按 `note_id` + 归属 ID 存储（`_infer_delta` 只比 ID），这一步补上了计划侧的缺口。

**（f）仓库改名 `dshplug` → `dw-plugin`（2026-11-22）**

文档、代码注释、patch 注释、界面示例文案已全部同步；数据目录 `C:\dsh\data-getbrain` 不受影响。

**（g）顺带修掉的文档矛盾**

- `PKM-ROADMAP.md` §3.2(a) 原写「合并笔记还没做」（实测 v2.9.0 已实装）、§6 落地顺序表整体过时 —— 已改写。
- `PKM-THEORY.md` / `HANDOFF-2026-11-18.md` 里 9 处旧数字 `4053` —— 全部改为实测的 `4052`。
- README §11.14(l) 的 `persona_mtime` —— 改为代码里真实的 `persona_sig`。

**（h）真实写入已经跑通（2026-11-26，不再只是干跑）**

- **合并**：把两条重复的「文件: 《现代思维工具词典》.pdf」合成一条新笔记 `1928038156641538072`；
  旧笔记**全部保留**（合并命令本身不删东西，删旧另走 delete）。来源记录 `state/merge-20261126-005101.json`。
- **删除**：删掉 5 条空白录音（3 条「空白录音笔记」+ 2 条「空语音转写记录」），每条都先存了本地 trash 副本
  （`trash/<note_id>_<标题>.md` + 同名 `.json`），内容救得回来，但**操作本身不可撤销**。
- 治理立场不变：只删「空白/测试」这类无内容笔记；那 4052 条课程摘录**不动**（ROADMAP §7）。

> 新增的宿主路由（`/mirror-check`、`/vec-search`、`/vec-index`）属于**宿主半**改动，
> 按平台规则**必须重启 App** 才会生效；CLI 版本不受影响，现在就能用。

### 11.16 不用再手填笔记 ID + 执行流程重组（2026-11-26，v2.12.0）

**（a）「填 ID」这件事本身就是 bug**

用户反馈：「查平台发芽 菜单里这里要填 id 但我不知道 id」。

根因不在“用户不愿填”：

- `AI 动作` 页的提示写着「在「分类调整」里展开到「讲」能看到」——但 `inventory --summary`
  只给每个讲**有几条**，根本不带 `note_id`，那行提示是错的。
- 而且「讲」≠「笔记」：实测 **660 个讲 / 4322 条笔记**（平均 6.5 条，最多的一个讲 370 条）。
  就算把讲显示成一个 ID，也解决不了「我要的是这一讲里的那一条」。

修复（两条路，都不用手填）：

| 入口 | 做法 |
|---|---|
| `分类调整` 树 | 「讲」行右侧的「N 条 ▾」可展开，懒加载列出这一讲下的每条笔记，每条带「复制 ID」 |
| `AI 动作` 页 | 新增「从「分类调整」带入选中的讲」：把当前勾选 resolve 成笔记列，点一条直接填进输入框 |

新命令 `gn.py lecture-notes --kb --course --book --lecture`（纯本地扫描）；
新路由 `GET /plugins/getnote/lecture-notes`（宿主半，需重启 App）。
`gn.py resolve` 顺带把 `titles`（note_id → 标题）一起返回，界面才能「看着标题挑一条」。

> 复制失败时（浏览器拒绝 `navigator.clipboard`）**不静默**：回退成选中文字 + 明说「只是选中了，没进剪贴板」。

**（b）执行流程重组：两个「造计划」页 + 一个「执行」页**

用户反馈两点：「我刚跑完找不到」「这两个有点类似」。

- 「刚跑完找不到」是真 bug：`renderAuto` **从来没渲染过干跑结果**（`ctl.run(true, ...)`
  设了 `result`，但页面里没有任何地方读它）——点一下「先干跑」看着就像没反应。
- 「有点类似」也是真的：`确认执行` 和 `自动归类` 两页都能写线上，用户不知道刚点的是哪一个计划。

现在固定成一条线：

```
分类调整（手选） ─┐
                 ├─→ 计划（plan.pending.json / plan.classify.json）
自动归类（规则） ─┘        │
                            ↓
                   确认执行（唯一写入口）
                    ① 看清单  →  ② 先干跑  →  ③ 真写（连点两次）
                            ↓
                        撤销（列出每一批，指名哪一份）
```

- **页签顺序 = 工作流顺序**：分类调整 / 自动归类 / 确认执行 / AI 动作 / 笔记现状 / 执行日志。
- **场景导航条**（常驻页首）：「我要：归整一批笔记 / 一次归完未归库的 / 执行·回退 / 让 AI 帮我想 / 看库的情况」
  —— 用户打开面板时想的是「我要干什么」，不是「这几个页签叫什么」。
- **干跑/真写只在「确认执行」页**。自动归类页生成完只给「去「确认执行」干跑 →」。
- **结果卡片**从页面最底部的 `<pre>` 提到按钮正下方，标题直接写「干跑结果（线上未动）」/「已写入线上」/「失败」。
- 计划来源（手工选择 / 自动归类）标在页首；计划特别大（>2000 动作）时只显摘要，干跑仍会打印逐批清单。

**（c）验证**

- 结构体检 13/13；`node --check` 0；`gn.py` 编译通过。
- **`node tools/render-smoke.mjs`**（已入库的回归工具）：用假 React 把 6 个页签 × 3 种计划态 +
  讲展开/失败/空树/带入选择器等共 25 个渲染场景全渲一遍，抓运行时报错。
  这类错 `node --check` 抓不到（结构体检管「结构对不对」，它管「渲不渲得出来」）。
