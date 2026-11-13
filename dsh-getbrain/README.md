# 得到大脑（原 Get 笔记）OpenAPI 受控整理工具包

用途：让本 Harness 的 agent 通过**官方 OpenAPI** 对你的笔记做「分类 + 删除 + 整合」，
且全程受控、可审计、可回滚。零第三方依赖，只用 DSH 自带 Python 标准库。

- 官方 API 文档：<https://doc.biji.com/docs/WOxgwObNNiyMHWk1dl0cJqSxnEd>
- 开放平台（创建应用 / 取 Key / 作废 Key）：<https://www.biji.com/openapi>
- 官方 MCP（备选路径）：<https://doc.biji.com/docs/FmYfw0yXsiXdTtkVzhLcuX8lnxd>

> ⚠️ 硬性前提：**会员账号**。非会员返回 `10201 not_member` / 429 `reason: not_member`。

---

## 0. 当前位置（2026-11-11 迁移）

本包已从 `default-workspace/getnote` 迁到 **`C:\dsh\dshplug\dsh-getbrain`**（2026-11-12 并入 dshplug 仓库），
数据在 **`C:\dsh\data-getbrain`**（2026-11-12 起：默认就在仓库外侧，与代码分离）。

```
C:\dsh\dshplug\dsh-getbrain\  代码（在 dshplug 仓库内，随仓库同步）
   index.js                 Host 侧插件 + 3 个 HTTP 路由
   client.js                客户端 UI（设置页 + 侧边栏工作台）
   gn.py / gn.ps1           CLI 实现（Python 标准库，无第三方依赖）
   cordis.patch.yml         插件层补丁（dataDir 留空 → 用代码默认值）

C:\dsh\data-getbrain\       数据（仓库的同级目录，天然不进 Git，永不入库）
   current\                 笔记 Markdown 镜像
   snapshots\ logs\ state\ ...
```

**路径怎么算的（2026-11-12 起改为代码推导，不再写死绝对路径）**：

```
BUNDLE_DIR  = C:\dsh\dshplug\dsh-getbrain   （插件目录）
WORKSPACE   = 上一级 = C:\dsh\dshplug        （= Git 仓库根本身）
DEFAULT_DATA_DIR = WORKSPACE 的上一级 + data-getbrain = C:\dsh\data-getbrain
```

旧版本默认写 `dataDir = 'getbraindata'`，它是**相对 WORKSPACE** 解析的，于是落到仓库里
`C:\dsh\dshplug\getbraindata`，只能靠 `cordis.patch.yml` 写死绝对路径 `C:\dsh\getbraindata`
（当时还配了一个 Junction）把数据拽出仓库。现在默认值改到**仓库同级**，patch 里留空即可，
换机器、换目录都不用再改配置。

**命名约定**：`C:\dsh\data-<技能短名>` 是本机技能的默认数据位（本插件 = `data-getbrain`），
首次运行**自动创建**（幂等）。它不在任何 Git 仓库里 → 不进同步、不进插件包，
**用户数据完全在本机自己掌控**。想换位置就在「设置 → Getnote」里把 `dataDir` 改成绝对路径。

⚠️ **改数据目录时改一处就够**（这是 2026-11-12 的简化）：

1. 首选在「设置 → Getnote」→「下载与目录」→ `统一数据目录` 里改（即时生效，无需重启）。
2. 若要改**默认值**本身：`index.js` 的 `DEFAULT_DATA_DIR` 与 `gn.py` 的 `DEFAULT_DATA_DIR`
   （两处推导规则必须一致）；`cordis.patch.yml` 的 `dataDir` 保持留空，让推导生效。

> 历史坑（仍适用）：`cordis.patch.yml` 的 `config:` 在**行激活时**读取，非空值会**覆盖**
> 代码里的默认值。以前正因为那里写死了绝对路径，只改代码里的常量不生效。

---

## 1. 一次性配置

在开放平台创建应用，拿到 `Client ID (cli_xxx)` 与 `API Key (gk_live_xxx)`（只显示一次）。

`getnote/` 目录本身就是一个**正式 Cordis 插件（Bundle）**：代码 + 插件入口 + SKILL.md 说明都在里面。
配置有五处，任选其一（优先级：**凭据库** > 环境变量 > 插件行 Config > settings.json > config.local.json）；**首选「设置 → Getnote」侧边栏，在哪里输入 Key/ID 见第 9 节**：

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
| **DSH 凭据库**（面板输入）`$DSH_HOME/.credentials.yaml` | **1（最高）** | 「设置 → Getnote」两个安全输入框写这里；**不进组合树、不进配置导出、不进日志** |
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
- **`client.js` 在「设置」里注册一个顶层侧边栏分区「Getnote」**（`settings.section`），
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
target: C:\dsh\dshplug\dsh-getbrain
```

（把上面的绝对路径换成目标机 `dsh-getbrain/` 的实际路径。本机已在 profile 里以 `link:` 装好，不需要再装；
重新装用 `& C:\dsh\dshplug\install.ps1 -Only dsh-getbrain`。）

### 配置项（「设置 → Getnote」侧边栏 = `cordis.patch.yml` 的 `config`）

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
- 凭据**首选「设置 → Getnote」的两个安全输入框**（写入 DSH 凭据库，不进组合树）；`apiKeyFile` / 环境变量作为备用。把明文写进 patch 是最差选择（`mcp-bundle.md` 亦如此建议）。
- **面板渲染实测（2026-11-10，不需要浏览器）**：自己写了一个极简 React 运行时（`createElement` / `useState` / `useEffect` / `useCallback` / `useSyncExternalStore`），用真 `apply(ctx)` 拿到 `slots.register` 的组件引用，再用真 `inject()` 产生的 props 真执行 `GetnoteSettingsSection`，把元素树跑成了文本。结果：

  **未认证时**（目标 (1) 的直接证据）：
  ```
  h3   "账号凭据（安全存储）"
  label "API Key"   → input [type=password, placeholder="（未设置）"]
  label "Client ID" → input [type=password, placeholder="（未设置）"]
  button "保存凭据"      [disabled=false]
  button "清除已存密钥"  [disabled=true]   ← 未存密钥时正确禁用
  h3   "接入信息"
  button "测试连接"
  p    "暂无接入信息（点「测试连接」获取）。"
  ```

  **认证成功后**（目标 (3) 的直接证据，mock `/plugins/getnote/status` 返回成功 JSON）：
  ```
  h3   "接入信息"
  p    "下面是从本机实际读出来的状态；点「测试连接」会真的发一次请求。"
  button "测试连接"
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

#### 路径 A：**设置 → Getnote 侧边栏（你要的入口，首选）**

`client.js` 在「设置」里注册了一个**顶层侧边栏分区「Getnote」**（与「通用」「插件」同级）。
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

面板里的「**接入信息**」区块就是为这个做的。点 **「测试连接」** 会真发一次只读请求（消耗 1 次配额），
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

- 文件在 `C:\dsh\dshplug\dsh-getbrain\config.local.json`；仓库根 `.gitignore`（及导出包内动态生成的 `.gitignore`）已排除，不会入库。
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
- 若插件页没显示「配置」按钮，**用路径 A 的「设置 → Getnote」侧边栏或路径 B 即可**，
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
| `GET /plugins/getnote/summary` | 本地镜像统计（纯文件扫描，**不耗配额**） | ✅ 200，返回真实数据 |
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

### 数据层已接通（真实数字）

工作台四个标签页：**笔记现状 / 处理建议 / 确认执行 / 执行日志**。
现状页显示的都是从 `data/current/*.md` 头部算出来的真实值，例如（2973 篇时）：

```
本地镜像 2973 篇 │ 未归知识库 1655（56%）│ 无标签 25（0.8%）
可拆专题 Top3：万维钢·精英日课6 926 / 优秀员工沟通训练营 370 / 云端革命 260
```

**降级入口**：同一份数据也放进了「设置 → Getnote」页（`MirrorSummary` 组件），
万一侧边栏 slot 在某个版本上不生效，设置里照样看得到。

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

