# agent-brief 输出字段口径

> **这份文档是「字段口径」，不是用法说明。**
> 它只回答一件事：`agent-brief`（给 AI 读的工作内容提纯包）吐出来的每个字段**是什么类型、什么含义、
> 怎么算出来的、边界在哪**。
> 「怎么跑、怎么调、界面上在哪看」请看 `README.md` §11.12 / §11.14 与 `BOOTSTRAP.md`。
>
> 代码依据：`gn.py` 的 `cmd_agent_brief()`（约 1846 行起）及其调用的
> `_extract_todos()` / `_owner_of()` / `_persona_conf()` / `_persona_body()` / `_content_tags()` /
> `_course_of()` / `_parse_md_head()`；路由依据 `index.js` 的 `/plugins/getnote/brief`。
> 本文所有字段名都取自真实代码，没有自造字段；不确定的地方一律标「待确认」。

---

## 0. 顶层形态与数据来源

- 命令：`python gn.py agent-brief [--into current] [--days N] [--top N] [--recent N] [--top-todos N] [--json]`
- 数据源：**只有本地镜像目录**（`<dataDir>/<into>/` 下的 `*.md`），不调 API、不耗配额、不写平台。
- `--json` 时 stdout 就是**一个 JSON 对象**（`jdump()`：`ensure_ascii=False, indent=2`），
  下表描述的就是这个对象。人读模式（不带 `--json`）只是同一份数据的排版打印，字段完全一致。
- 路由 `GET /plugins/getnote/brief` 额外包了一层信封，见 §11 —— **信封不是提纯包的字段**。
- 参与统计的笔记 = 镜像里**能解析出 `note_id`** 的 `*.md` 文件（`_parse_md_head()` 读文件前 4096 字节）。
  解析不出 `note_id` 的文件直接跳过，不计入任何数字。

---

## 1. 顶层字段表

| 字段名 | 类型 | 含义 | 怎么算出来的 |
|---|---|---|---|
| `ok` | boolean | 固定为 `true` | 字面量 `True`。命令失败时**不会**输出这个对象（见 §11） |
| `generated_at` | string | 生成时刻 | `now_iso()`：取 UTC 当前时间 → 转本地时区 → `isoformat(timespec="seconds")` |
| `scope` | object | 本次统计范围与总量 | 见 §2 |
| `todos_total` | integer | 抽出的待办**总**条数（未截断） | 遍历「自己记的」笔记，逐篇累加 `_extract_todos()` 的返回条数 |
| `todos_by_owner` | object | 待办按人计数 | `{o: 该人待办条数 for o in OWNERS}`，**5 个键恒存在**（没有的人为 0） |
| `todos` | array | 待办明细（**已截断**） | 同上的待办列表，按出现顺序取前 `--top-todos` 条（默认 40） |
| `work_sources` | array | 按来源（课程/专栏/书）聚合 | 遍历**全部**笔记按 `_course_of()` 分组计数，按 `count` 降序取前 `--top`（默认 12） |
| `recent_own_records` | array | 最近自己记的 | 「自己记的」里能解析创建时间的，按 `created` 倒序取前 `--recent`（默认 10） |
| `type_counts` | object | 各笔记类型的篇数 | 遍历**全部**笔记，按 md 头 `- 类型:` 的值分组计数 |
| `own_topics` | object | 「自己记的」按标签 + 知识库聚合 | 见 §7 |
| `by_owner` | array | 「自己记的」按人拆开 | 见 §8；顺序固定，只输出非零的人 |
| `reading_hint` | string | 给 Agent 的使用提示 | 固定文案，不随数据变化 |

顶层共 **12 个键**。`todos_total` 与 `todos` 的长度**不相等**是正常的（后者被 `--top-todos` 截断）。

---

## 2. `scope`

本次统计的口径与总量。

| 字段名 | 类型 | 含义 | 怎么算出来的 | 示例值 |
|---|---|---|---|---|
| `dir` | string | 镜像目录的绝对路径 | `str(DATA_DIR / (args.into or "current"))` | `C:\dsh\data-getbrain\current` |
| `days` | integer \| null | 本次 `--days` 取值 | `days or None`：传 0 或不传 → `null` | `30` / `null` |
| `notes_total` | integer | 参与统计的笔记篇数 | 经过 `--days` 过滤后的 `notes` 列表长度 | `4321` |
| `own` | integer | 其中「自己记的」篇数 | `type ∈ OWN_TYPES` 的篇数 | `269` |
| `excerpts` | integer | 其中「摘录」篇数 | `notes` 里不属于 `own` 的部分 | `4052` |

- `own + excerpts == notes_total`（摘录就是「非自己记的」）。
- `OWN_TYPES = {audio, meeting, internal_record, local_audio, plain_text, img_text, recorder_audio, recorder_flash_audio}`。
  不在这 8 个里的（如 `ref` / `link` / `class_audio`）一律算摘录。
- `days` 的过滤是**近似**的，见 §10.1 第 2 条。

---

## 3. 待办：`todos_total` / `todos_by_owner` / `todos[]`

### 3.1 `todos_total`

integer。所有「自己记的」笔记里抽出的待办总条数，**不做条数截断**。

### 3.2 `todos_by_owner`

object，键是归属枚举的 5 个值（`我` / `孩子` / `老婆` / `共用` / `未知`），值是 integer。
即使某个人一条待办都没有，键也**一定存在**（值为 0）。
各值之和 == `todos_total`。

### 3.3 `todos[]`（数组，元素字段）

| 字段名 | 类型 | 含义 | 取值范围 / 枚举 | 怎么算出来的 | 示例值 |
|---|---|---|---|---|---|
| `text` | string | 待办正文 | 非空字符串 | 取列表行去掉前缀后 `strip()`；以「无明确」开头的行被丢弃 | `给孩子填志愿表` |
| `note_id` | string | 来源笔记 id | 数字字符串 | 来源笔记 md 头的 `- note_id:` | `1852421912689929313` |
| `title` | string | 来源笔记标题 | 可能为 `""` | 来源笔记的 H1（`# ...`） | `8/12 家庭会议` |
| `type` | string \| null | 来源笔记类型 | 同 `type_counts` 的键 | 来源笔记 md 头 `- 类型:`，解析不到为 `null` | `meeting` |
| `owner` | string | 这条待办归谁 | `我` / `孩子` / `老婆` / `共用` / `未知` | 对**来源笔记**跑 `_owner_of()`（见 §9） | `孩子` |
| `created` | string \| null | 来源笔记创建日期 | `YYYY-MM-DD` 或 `null` | 从文件正文正则抓 `- 创建: YYYY-MM-DD HH:MM:SS`；抓不到为 `null` | `2026-08-12` |

- 数组顺序 = 笔记在镜像里的处理顺序（`sorted(base.glob("*.md"))`），**不是按时间或按人排序**。
- 数组长度 ≤ `--top-todos`（默认 40）。
- 待办只从「自己记的」笔记里抽，摘录一律不抽。
- 抽取规则本身很窄，见 §10.1 第 1 条。

---

## 4. `work_sources[]`（数组，元素字段）

按「来源」（课程 / 专栏 / 书 / 单篇）聚合，用来回答「时间主要花在哪」。
**统计范围是全部笔记（含摘录）**，所以头部通常是被摘录的课程。

| 字段名 | 类型 | 含义 | 取值范围 | 怎么算出来的 | 示例值 |
|---|---|---|---|---|---|
| `name` | string | 来源名 | 任意字符串；兜底为 `(无来源)` | `_course_of()`：优先第一个**内容标签**（已剔除「得到」与载体标签），否则 md 头 `- 来源:`，都没有则 `(无来源)` | `万维钢·精英日课6` |
| `count` | integer | 该来源篇数（含摘录） | ≥ 1 | 分组累加 | `926` |
| `own` | integer | 该来源里「自己记的」篇数 | 0 ~ `count` | 同组内 `type ∈ OWN_TYPES` 的篇数 | `0` |
| `first` | string \| null | 该来源最早创建日期 | `YYYY-MM-DD` 或 `null` | 组内能解析创建时间的笔记取最小值；一篇都没有则 `null` | `2025-02-27` |
| `last` | string \| null | 该来源最晚创建日期 | `YYYY-MM-DD` 或 `null` | 同上取最大值 | `2026-11-20` |

- 数组长度 ≤ `--top`（默认 12，HTTP 路由上限 50），按 `count` 降序。
- `own` 全为 0 是**常见现象**（来源头部是摘录），不代表数据错。

---

## 5. `recent_own_records[]`（数组，元素字段）

| 字段名 | 类型 | 含义 | 取值范围 | 怎么算出来的 | 示例值 |
|---|---|---|---|---|---|
| `note_id` | string | 笔记 id | 数字字符串 | md 头 `- note_id:` | `1852421912689929313` |
| `title` | string | 笔记标题 | 可能为 `""` | H1 | `国航数字化研讨纪要` |
| `type` | string | 笔记类型 | 8 个 own 类型之一 | md 头 `- 类型:` | `meeting` |
| `created` | string | 创建时间 | `YYYY-MM-DD HH:MM` | 能解析出创建时间的笔记才会进这个数组 | `2026-11-20 22:06` |
| `todos` | integer | 这篇笔记抽出的待办条数 | ≥ 0 | `len(_extract_todos(...))`，与归属无关 | `3` |

- 只含「自己记的」笔记，**摘录不进这个数组**。
- 解析不出创建时间的笔记被整体排除（不是排在最后）。
- 数组长度 ≤ `--recent`（默认 10，HTTP 路由上限 50），按 `created` 倒序。

---

## 6. `type_counts`

object：键 = 笔记类型字符串，值 = 该类型的篇数（integer）。

- 统计范围是**全部**笔记（含摘录），不是只有「自己记的」。
- 键来自 md 头的 `- 类型:` 行；类型很多且包含平台各种值。
- 边界：如果某篇笔记解析不到 `- 类型:`，其 `type` 为 `null`，
  作为 JSON 对象键时会被序列化成字符串 `"null"`（`json.dumps` 行为）。**此形态未实测，待确认**。

---

## 7. `own_topics`

「自己记的」笔记按**标签**与**知识库**两个轴分别聚合。
分两轴的理由：同一个名字可能同时是标签和知识库，合起来数会把两个东西加在一起。

| 字段名 | 类型 | 含义 | 取值范围 | 怎么算出来的 | 示例值 |
|---|---|---|---|---|---|
| `tags` | array | 主题标签 Top N | 元素 `{name: string, count: integer}` | 对 own 笔记跑 `_content_tags()`（剔除「得到」与载体类标签）后计数，按 `count` 降序取前 `--top` | `[{"name":"高考志愿填报","count":13}]` |
| `kbs` | array | 知识库 Top N | 元素 `{name: string, count: integer}` | 对 own 笔记的 `topics`（知识库名）计数，按 `count` 降序取前 `--top` | `[{"name":"fencing","count":7}]` |
| `untagged` | integer | 「标签和知识库**都**没有」的篇数 | ≥ 0 | `not _content_tags(h) and not (h.get("topics") or [])` | `49` |
| `no_content_tag` | integer | 过滤后没有主题标签的篇数 | ≥ 0 | `not _content_tags(h)` | `60` |
| `no_kb` | integer | 没进任何知识库的篇数 | ≥ 0 | `not (h.get("topics") or [])` | `219` |

- `untagged` ⊆ (`no_content_tag` ∩ `no_kb`)，三个数字**口径不同、会重叠，不能相加**。
- 只统计「自己记的」笔记，摘录不进这块。
- `tags` / `kbs` 都受 `--top` 截断，被截掉的名字不出现在数组里，但 `untagged` 等计数是全量的。

---

## 8. `by_owner[]`：按人分块

这是「一个账号三个人」在提纯包里的落点。**只统计「自己记的」笔记。**

| 字段名 | 类型 | 含义 | 取值范围 / 枚举 | 怎么算出来的 | 示例值 |
|---|---|---|---|---|---|
| `owner` | string | 这一块是谁的 | `我` / `孩子` / `老婆` / `共用` / `未知` | `_owner_of()` 的结果 | `孩子` |
| `count` | integer | 这个人名下的自己笔记篇数 | ≥ 1 | 分组累加 | `81` |
| `todos` | integer | 这些笔记抽出的待办总条数 | ≥ 0 | 组内每篇 `len(_extract_todos())` 累加 | `165` |
| `kbs` | array | 命中的知识库 Top 8 | 元素 `{name: string, count: integer}` | 组内 `topics` 计数，按 `count` 降序取前 **8** 个 | `[{"name":"university","count":9}]` |
| `why_samples` | array | 判定理由样本，最多 3 条 | 元素 `{title: string, why: array<string>}` | 组内最多留 3 条非空理由 | 见下 |

`why_samples[]` 的子字段：

| 字段名 | 类型 | 含义 | 取值范围 | 怎么算出来的 | 示例值 |
|---|---|---|---|---|---|
| `title` | string | 样本笔记标题 | 最长 40 字符（超出截断） | `(h.get("title") or "")[:40]` | `强基计划报名材料清单` |
| `why` | array\<string\> | 判定理由，最多 3 条 | 每条形如 `知识库「x」` / `标题含「y」` / `正文含「z」`；也可能是 `手动指定` / `两边分数相同，无法判定` / `本地信号不足` / `摘录，无明确归属` | `owy[:3]`（`_owner_of()` 返回的理由列表切片） | `["知识库「university」"]` |

- 数组顺序**固定**为 `我 → 孩子 → 老婆 → 共用 → 未知`，便于 Agent 稳定读取。
- **篇数为 0 的人不会出现**（`by_owner_out` 只 append 有记录的 owner），所以「缺键」= 0，不是数据缺失。
- `todos` 的总和应与 `todos_by_owner` 一致，可交叉校验。
- `why_samples` 允许为空数组（该组所有笔记的 `why` 都为空时）。

---

## 9. 归属（owner）口径

### 9.1 它是本地算出来的，**不是平台字段**

`owner` 在得到/Get笔记平台上**不存在**。它是本插件用本地镜像的内容推出来的一个本地标签，
只存在于本插件的产物（提纯包、`find --owner` 的过滤、索引的 `owner` 列）里，**从不写回平台**。

### 9.2 取值枚举（只有这 5 个）

| 值 | 含义 |
|---|---|
| `我` | 判给用户本人 |
| `孩子` | 判给孩子 |
| `老婆` | 判给配偶 |
| `共用` | 全家共用 / 无法归到某个人 |
| `未知` | 本地信号不足，**故意不猜**，留给用户手动指定 |

对应常量：`OWNER_ME` / `OWNER_KID` / `OWNER_SPOUSE` / `OWNER_SHARED` / `OWNER_UNKNOWN`，
元组 `OWNERS` 顺序即 `by_owner` 的输出顺序。

### 9.3 判定算法（`_owner_of()`，返回 `(owner, score, why)`）

按优先级从高到低：

1. **手动钉死**：`<dataDir>/state/personas.json` 的 `notes[note_id]` 若命中 5 个枚举之一，
   直接返回该 owner，`score = 999`，`why = ["手动指定"]`。**优先级最高，覆盖以下全部规则。**
2. **知识库信号**：笔记挂的每个知识库名若在 `conf["kb"]` 里，该 owner `+12`（`PERSONA_KB_WEIGHT`），
   理由记 `知识库「<名>」`。
3. **标题关键词**：每个命中的关键词 `+5`（`PERSONA_TITLE_WEIGHT`），**最多算 3 个**（`PERSONA_TITLE_CAP`），
   理由记 `标题含「<词>」`。
4. **正文关键词**：每个命中的关键词 `+1`（`PERSONA_BODY_WEIGHT`），**最多算 5 个**（`PERSONA_BODY_CAP`），
   理由记 `正文含「<词>」`。
   - 正文指 `_persona_body()` 处理后的文本：只取 `## 原文（全文字）` 到 `## AI 总结` 之间，
     并删掉图片 markdown、`<img>`、`http(s)://` 链接。
   - 命中判断：中文按**子串**；纯 ASCII 词按**词边界**（避免 `AI` 命中 URL 里的 `AId`）。
5. **定案条件**：最高分 `≥ 5`（`PERSONA_MIN_SCORE`）**且**严格大于第二名。
6. **两道「不足以定案」闸门**（触发则落到第 7/8 条）：
   - **泛词闸门**：唯一证据是一个**标题泛词**（`PERSONA_WEAK_WORDS`，如「实验」「论文」「大学」），
     话题词不能当身份证据。
   - **摘录闸门**：摘录类笔记（`type ∉ OWN_TYPES`）仅凭**单条标题词**不定案，
     必须有知识库信号或 ≥2 条标题命中。
7. **平分**：最高分 `≥ 5` 但与第二名同分 → 返回 `未知`，`why = ["两边分数相同，无法判定"]`。
8. **分数不够**：
   - 自己记的笔记 → `未知`，`why` 为已有理由，或兜底 `["本地信号不足"]`。
   - 摘录 → `共用`，`why = ["摘录，无明确归属"]`。

关键词表与知识库表可由 `personas.json` 的 `keywords` / `kb` 覆盖（未写的键沿用内置默认）。

### 9.4 在 agent-brief 里的两个推论

- `todos[].owner` 与 `by_owner[].owner` 都是对**来源笔记**跑 `_owner_of()` 得到的。
- `by_owner` **只遍历「自己记的」笔记**，摘录的归属结果（`共用`）不进入 `by_owner`。
  因此 `by_owner` 里出现 `共用`，**只能来自 `personas.json` 的手动钉死**。

---

## 10. 诚实边界（哪些是近似、哪些会漏）

### 10.1 会漏 / 会偏的地方

1. **待办抽取很窄**：只认 AI 总结里的 `### 待办事项` 小节（允许带 `📋` / `📝` 前缀），
   只取 `- ` / `* ` / `• ` 开头的列表行，且丢弃以「无明确」开头的行。
   没有这个小节 = 抽到 0 条，**这不代表事情都做完了**，只代表这篇没被结构化。
2. **`--days` 过滤是近似的**：过滤条件是 `if cutoff and created and created < cutoff`。
   解析不出创建时间的笔记（`created is None`）**不会被 `--days` 排除**，会一直留在结果里。
3. **`first` / `last` / `recent_own_records` 都只认能解析出创建时间的笔记**；
   解析不出的笔记在时间维度上等于不存在。
4. **标签与知识库数组受 `--top` 截断**（默认 12），长尾名字看不到；
   `untagged` / `no_content_tag` / `no_kb` 是全量计数，与截断无关。
5. **`by_owner` 只含「自己记的」**，所以它回答的是「我自己的/家人的记录在忙什么」，
   不等于账号全貌；要看全貌需结合 `work_sources`（含摘录）。
6. **`owner` 是启发式推断，不是事实**。归错会污染下游（`find --owner`、`by_owner`、索引的 owner 列）。
   代码里已有实测数字：纯关键词只能判出一部分，剩余约 36% 判不出来、另有少数两边同分。
   所以「未知」是**设计上的可见缺口**，不是 bug。
7. **`todos[]` 与 `todos_total` 数量不同**是正常的（`--top-todos` 截断）；
   `todos_by_owner` 与 `by_owner[].todos` 是全量，两者应当一致。
8. **`excerpts` 用 `h not in own` 判断**（字典相等比较）。当前每篇 head 都是不同对象，无实际影响，
   但这是个**按值比较**的写法，不是按 `note_id` 比较。
9. **`type_counts` 含全部笔记**，键集合包含平台各种类型，不是只有 own 的 8 个类型。
10. **路由不暴露全部参数**：`GET /plugins/getnote/brief` 只接受 `days` / `top` / `recent`
    （`top`、`recent` 上限 50），**不暴露 `--into` 与 `--top-todos`**。
    所以走 HTTP 时镜像目录固定是 `<dataDir>/current`，待办明细固定最多 40 条。

### 10.2 明确「不是平台字段」的清单

- `owner`（5 枚举）：本地推断 + 本地配置覆盖，平台无此字段。
- `why_samples` / `why`：本地推断的理由，平台无此字段。
- `todos_total` / `todos_by_owner` / `by_owner`：本地聚合，平台无此结构。
- `scope.dir` / `generated_at` / `reading_hint`：本插件产物元信息。

---

## 11. 路由信封（**不是提纯包的字段**）

`GET /plugins/getnote/brief?days=&top=&recent=`（`index.js`，只支持 GET，其它方法 405）。

| 信封字段 | 类型 | 含义 |
|---|---|---|
| `ok` | boolean | **进程是否退出码 0**（`runGn` 的 `code === 0`），**不是** `brief.ok` |
| `data` | object \| null | 解析成功的提纯包对象；解析失败为 `null` |
| `output` | string | `data` 为 null 时的原始 stdout（截断 40000 字符）；成功时为 `""` |

- 查询参数：`days`（默认 0 = 不过滤）、`top`（默认 12，上限 50）、`recent`（默认 10，上限 50）。
- 未传 `--days` / `--top` / `--recent` 时分别落到 gn.py 的默认值 `0` / `12` / `10`。
- 命令失败（如镜像不存在、镜像里没笔记）时 `data` 为 `null`，原因在 `output` 里；
  **stderr 不回传**（路由只发 `output`），所以 Python traceback 在 HTTP 响应里看不到。
- gn.py 内部失败时自己的输出形如 `{"ok": false, "error": "镜像里没找到笔记", "dir": "..."}`（退出码 1）。

---

## 12. 待确认清单

以下各项**未在代码中找到确切依据**，本文不给出结论：

1. **`type_counts` 中 `type` 解析不到（`null`）时的键形态**：按 `json.dumps` 行为会变成字符串 `"null"`，
   但代码未做防御，也未实测该形态是否真的出现在输出里。
2. **`cmd_agent_brief()` 在镜像目录不存在时 `raise ApiError`**：该异常没有 try/except 包裹，
   路由层最终呈现为何（退出码、`output` 内容）未在代码中找到明确处理路径，待确认。
3. **`why_samples` 的人读打印**用 `'；'.join(s['why'])`，说明 `why` 是数组；
   但 README §11.14（i）只写「理由样本」未声明类型，**以本文（数组）为准**，如与别处文档冲突需复核。
4. **`--into` 传绝对路径**：`DATA_DIR / args.into` 在 `args.into` 为绝对路径时按 pathlib 语义会忽略 `DATA_DIR`，
   代码未显式校验也未在文档中声明，实际行为待确认。
5. **`todos[]` 的 `type` 为 `null`** 时是否稳定输出 `null`（`h.get("type")` 未做 `or ""` 兜底），
   与 `recent_own_records[].type` 的 `or ""` 写法不一致，待确认是否为有意为之。
