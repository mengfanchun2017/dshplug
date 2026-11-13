# 交接记录 · 预览编辑器插件 + open-in-app 分析

记录时间：2026-11-09 09:30，最后更新 2026-11-10 09:20 (Asia/Shanghai)。用途：跨轮继续工作的唯一权威清单。

---

## 0b. 第四轮（2026-11-10 09:35–10:10）「Edit 排序 + 搜索插件推荐」

用户新指令：① 「Edit放在最后现在是txt在最后 修改」② 「搜索你给根据反馈 跟新和star数推荐我2个」。

**① 结论：字面上的「Edit 在纯文本之后」做不到 —— 这是平台硬编码。** 平台 `dsh-client-ui-sidebar-documentpreview` 的 `TextPreview` 构造候选列表时是 `candidates = [...matched, plainText]`，把自家「纯文本」查看器（`PLAIN_BODY_ID`，`extensions: []`，永不参与排序）**无条件追加到末尾**；菜单 `items: candidates.map(...)` 直接用这个顺序。所以**「纯文本」永远是最后一项，任何插件都改不了**——用户看到的「txt 在最后」正是这个机制。本插件能保证的是 Edit 在「除纯文本外」的查看器里排最后（已用 `builtin` 档 + 后注册的 tiebreak 做到，并加了不变式测试）。**若真实诉求是「打开就能编辑」，正解是 `editableAsDefault: true`，不是追菜单顺序。**

**用户曾选「改成头部独立按钮」，但技术上不可行**（已核实并告知）：`sidebar.right.tab.document.actions` 的 owner props 只有 `absolutePath`，`inject` face 只给 hooks/remote 回调，**拿不到 `actions.selected(tabId, rendererId)`**；而 `ctx.sidebarRight.openResource(address, {params})` 只支持 `line` 参数、没有 renderer 参数。唯一能切换 renderer 的 `actions` 对象是 TextPreview 组件内部私有。要做头部按钮只能整套接管 `sidebar.right.pane.tab`（同 key + priority:-10，`dsh-file-manager` 验证过的做法），代价是丢掉平台全部查看器。

**② 搜索插件推荐（GitHub API 实测，2026-11-10）**：
| 插件 | star | 最近 push | 下载/反馈 | 结论 |
|---|---|---|---|---|
| DSH-better-sidebar | **5029** | 2026-11-09 | fork 481 / issue 188 | star 最高最活跃，但是「侧栏底座」，搜索是 0.14 内置文件树过滤、非通用搜索；接管性强 |
| dsh-plugin-sidebar | 2 | 2026-09-01 | fork 1 | 左右栏都带搜索，但整套替换界面 |
| dsh-file-finder | 2 | **2026-11-05** | v0.6.0，npm 不可用需 GitHub | Ctrl+P 面板，文件名+内容双搜索，最新维护 |
| dsh-file-tree | 1 | 2026-10-28 | — | 右侧文件树 + 筛选框 |
| dsh-session-search-bar | 1 | 2026-10-30 | **awesome 收录、30 天下载 594** | 会话正文搜索，功能最完整、有 SPEC-v2 与性能表 |
| dsh-gui-search | 0 | 2026-11-04 | — | 只增强左侧自带框搜正文，最轻 |
| dsh-file-manager | 0 | 2026-11-05 | 要求 rc.5+/Node22 | 替换 Files tab 带搜索，rc.3 不满足 |

**最终推荐 2 个**：左侧会话 → `dsh-session-search-bar`（star 1、有 awesome 594 下载的真实使用信号、功能最全、只读正文不碰工具输出）；右侧文件 → `dsh-file-finder`（star 2、11-05 最新、文件名+内容双搜索、非侵入面板）。**明确不推 better-sidebar**：5029 star 是它的整体价值，但 0.12.x 根本没有搜索框。

**1.0.5 产物**：`local-dsh-preview-editor-1.0.5.tgz` 34993 B sha256 `08FE261612B41659D080672603DF947513156DDD502112832CD66347B9FA631D`；`.zip` 54598 B sha256 `6DA11A8C187375D24908D9C43F9B47877E37C7FE39537F12B55DCA534665AC72`。验证：`node --check` ×3 exit 0；`verify.mjs` **36/36**；`verify-live.mjs` **11/11 / 200**。

---

## 0. 第三轮（2026-11-10）「升级功能」—— 已完成

用户新指令：① 「现在 edit 什么也不显示」→ 修；② 「默认还是代码、纯文本和 markdown，Edit 可选作为最后的选项」→ 改优先级；③ 「可否在这个侧边栏增加搜索框，搜索下有没有插件 / 自己搜索是否可以」→ 调研。

**① 找到并修掉「Edit 一片空白」的确定性根因**（1.0.2 引入的回归）：`client.js` 里 `const rowTotal = rowCount(draft.text)` 在 return tree 之前无条件执行；首次渲染 `draft = {status:'loading'}`、**`draft.text` 是 undefined**，`undefined.split('\n')` 抛 TypeError → 组件 render 崩溃 → React 不提交任何 effect → `load()` 的 useEffect 永不执行 → **永久空白**。`verify.mjs` 的 `renderReady` 只 seed 过 ready 态，所以 33 项全绿却漏掉了初始态。修复：`rowCount` 对非 string 返回 1；在 `draft.status !== 'ready'` 时提前 return 一个带 `data-preview-editor: 'loading'` 的可见加载态；新增**无 seed 渲染初始态**的回归测试。

**② 默认查看器改回平台内置**：平台注册表 `matchingDocumentPreviews` 的 rank 是 `priority === 'builtin' ? 0 : 1`（`extension` 优先），同档按注册顺序；**所有内置查看器（Code/Text/Markdown/HTML/Image/PDF）都是 `builtin` 且先注册**。我们把两个 renderer 从 `extension` 改为 `builtin`，于是平台自带查看器仍是默认，`Edit` 成为查看器菜单**最后一项**。新增 `editableAsDefault: true` 恢复旧行为（`extension` 档抢回默认）。`_tools/verify-viewer-order.mjs` 复现了平台排序算法，验证 default 下 Edit 永远在最后一位、`editableAsDefault` 下在第一位。

**③ 侧边栏搜索框调研**（子代理完成，详见对话内报告）：
- 左侧会话列表：DSH **本来就自带搜索框**，默认只按标题过滤；`dsh-gui-search`（MIT、rc.3 兼容、桌面 UI 一键装）可升级为搜正文 + 跳转高亮。
- 右侧 Files tab / 文档预览：官方 README 明确「**没有搜索**」「不提供共享搜索接口」，不是藏了开关。
- 现成插件（均兼容 rc.3 Desktop）：`@xiaotuchu/dsh-file-tree`（右侧筛选框）、`dsh-file-finder`（Ctrl+P 面板、内容搜索最全）、`dsh-session-search-bar`（常驻框）。`dsh-file-manager` 最贴合但要 rc.5+/Node22；DSH Better Sidebar 0.12.x **不带**搜索框（0.14 才自带）。
- 自研可行：`ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({name,id,order,locale,inject}, SearchBox))` 可把输入框挂进右侧 Files tab 标题行；但 owner prop **只有 `absolutePath`（根目录）**、官方无共享 store/filter 接口，需自己用 `remote.workspaceFiles.list` 枚举 + `ctx.sidebarRight.openResource()` 打开命中；要真过滤官方树须用同一 `key` + `priority: -10` 替换 `sidebar.right.pane.tab` 正文。坑：不要用 Ctrl+Shift+F（与 `session.fork` 冲突）。

**1.0.4 产物（根 `dist\`，唯一有效目录）**：
- `local-dsh-preview-editor-1.0.4.tgz` 34520 B · sha256 `F716825CECCD9004453CADE3B22C1E38060E100FAB73277B7FCFBD8F6CE03435`
- `local-dsh-preview-editor-1.0.4.zip` 53790 B · sha256 `9E13C529003FEA84836F45C9947EE19BDF6089060A6BDDA84E7BFDD1B90C6255`
- `local-dsh-preview-editor-1.0.4.MANIFEST.txt`
- 验证：`node --check` ×3 exit 0；`verify.mjs` **35/35**；`verify-live.mjs http://127.0.0.1:64874` **11/11 markers / 200 / 57413 bytes**；tarball 含 1.0.4 + 新补丁/README/INSTALL；MANIFEST 哈希一致。
- 同步文档：`cordis.patch.yml`（`editableAsDefault` 说明 + 优先级叙述反转）、`README.md`（优先级章节重写、35 项、blank-Edit 事故复盘）、`INSTALL.zh.md`（默认行为、新键、1.0.4 路径、bug 说明）、`toolkit README`（版本沿革 + 1.0.4 修订块 + 新哈希 + 35 项/11 标记）、技能文件 `C:\Users\franc\.dsh\skill-manager\library\dsh-preview-editor\SKILL.md`（1.0.4、默认查看器 bullet、rowCount 回归注记）、`verify-live.mjs`（11 标记）。
- **刷新页面即可看到修复**（client 代码现取）；改 `cordis.patch.yml` 配置需重启应用。

**仍需用户参与**：截图（从未到达）；open-in-app 方案选择；行号/标记视觉对齐需人眼确认；重启应用装配 dsh-rag 面板；根目录 `dsh-preview-editor-1.0.0.zip` 是用户文件未删。

---

## 1. 用户诉求（来源 m00282，原文要点）

> 「你来修改吧 现在右侧点击编辑的这里相当于把文件发到选择的应用中，这里 default是默认第一个 而且不能改 而且不同文件类型的话会不一样 这里你分析下如何优化 或者搜索下有没有插件 比如我yml文件这个还会显示 截图给你了你看下很离谱 深度分析给出建议 并且编辑界面增加行号和不可见的标记（比如Enter回车）」

拆成三件事：

1. **授权**：修改技能文件（当时指 `C:\Users\franc\.dsh\skills\dsh-preview-editor.md`）。
2. **分析**：右侧栏「用应用打开」控件的机制、为什么 `.yml` 菜单离谱、如何优化、有没有现成插件 → 深度分析 + 建议。
3. **实现**：编辑界面加**行号**和**不可见字符标记**（如回车/Enter）。

后续消息：「上面还有未完成任务」→ `/compact 我要继续完成这个工作你记录下`。

---

## 2. 环境事实（继续前必读）

| 项 | 值 |
|---|---|
| 工作区 | `C:\Users\franc\Documents\deepseek-harness\default-workspace` |
| 文件策略 | workspace-write（工作区内可写；工作区外需批准） |
| GUI URL | 端口每轮变：`57356` → `61470` → `62892`（当前 62892）。跑 `verify-live.mjs` 必须显式传 URL |
| node | `C:\Users\franc\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（PATH 里**没有** node） |
| profile | `%USERPROFILE%\.dsh\profiles\desktop\` 由 Electron 独占；`dsh --profile desktop` 报 "managed exclusively by the Electron application"；本会话无 `plugin_manager` 工具 → 不改 profile |
| 应用启动时间 | 2026/10/26 15:18（dsh-rag 的 client 半边需重启才装配） |
| 技能目录 | 当前可用技能只有 `diagnose-windows-sandbox-acl` + `office*`；`dsh-preview-editor` 不在其中。工作区 `.dsh/skills` 为空、默认全关 |
| 技能工具 | 上一轮模型用过 `skill_manager_get/workspace_list/edit`，但**当前工具集里没有这些工具**，那次编辑结果需核实 |

---

## 3. 已完成（有证据）

### 3.1 行号栏 + 不可见字符标记（③ 已实现）

文件：`dsh-preview-editor/client.js`（1024 → 1556 行，`node --check` exit 0）

- 常量 `DEFAULT_MARKS_MAX_BYTES = 256*1024`、`EDITOR_FONT_SIZE=12`、`EDITOR_LINE_HEIGHT=1.55`、`LINE_HEIGHT_PX`、`EDITOR_PAD_TOP=8`、`EDITOR_PAD_LEFT=10`、`EDITOR_MONOSPACE`（[client.js:75](dsh-preview-editor/client.js) 起）。
- `resolveConfig` 新增 `marks` / `marksMaxBytes` / `lineNumbers`（默认全部开启）；`apply` 写入 `editingMarks` / `editingLineNumbers`。
- 字典新增 5 个**扁平点号 key**（zh+en）：`hint.noMarks`、`hint.noMarksWhy`、`marks.eolLf`、`marks.eolCrlf`、`marks.noEol`。
- 样式新增 `box`/`gutter`/`gutterInner`/`gutterRow`/`eol`/`eolMissing`/`mark`/`markZeroWidth`。
- 新函数：`INVISIBLE_CHARS` Map（[client.js:657](dsh-preview-editor/client.js)）、`CONTROL_CHAR`、`TRAILING_WHITESPACE`、`codePointOf`、`markOf`、`splitInvisible`（[client.js:727](dsh-preview-editor/client.js)）、`markStyle`、`endMarkOf`、`paintLine`（[client.js:784](dsh-preview-editor/client.js)）、`paintRows`、`tokenRows`、`rowCount`（[client.js:870](dsh-preview-editor/client.js)）、`pixels`、`sameTops`、`PlainLayer`（[client.js:952](dsh-preview-editor/client.js)）、`LineNumbers`（[client.js:982](dsh-preview-editor/client.js)）。
- `HighlightLayer` 改为接收 `marks/ends` 并走 `paintRows(tokenRows(...))`；`painted = highlighting || marksOn` 决定 textarea 是否透明（[client.js:1296](dsh-preview-editor/client.js)）；surface 结构 = `gutter` + `box(layer + textarea)`；textarea `onScroll` 同时驱动 layer 的 scrollTop/Left 和 gutter 的 `translateY(-scrollTop)`。
- 行号位置**实测** `[data-preview-editor-line]` 的像素顶（`getBoundingClientRect`），量不到时回退 `padding + index*LINE_HEIGHT_PX`；`ResizeObserver` + rAF 重测。
- 行尾标记 `↵`(LF) / `⏎`(CRLF) / `∅`(末尾无换行，红色)；tooltip 语言中立如 `u+00A0 nbsp`。标记**只加底色不替换字符**，保证光标不错位；行内普通空格不标记，只标记行尾空格。

### 3.2 验证

| 检查 | 结果 |
|---|---|
| `node verify.mjs` | **33/33 checks passed**（原 28 项，新增 5 项：gutter 逐行编号、就地标记、CRLF/缺换行、两个开关独立、mark 上限） |
| `node verify-live.mjs http://127.0.0.1:61470` | `200 / 56157 bytes`（磁盘 client.js 56074 + ~83 字节包装），rev `d3b9fbab0604`，**9/9 markers**，control 404，editing route 401，exit 0 |
| `node --check client.js` / `verify.mjs` / `verify-live.mjs` | 全部 exit 0 |

`verify-live.mjs` 标记位 5 → 9：`useCodeHighlighter`, `action.preview`, `preview-editor/markdown`, `'viewer.label': 'Edit'`, `flat and dotted`, `data-preview-editor-line`, `data-preview-editor-gutter`, `trailing space`, `marks.eolCrlf`。

### 3.3 打包 1.0.2

- `package.json` `1.0.1` → `1.0.2`
- `pwsh -File dsh-plugin-toolkit\pack-plugin.ps1 -PluginDir dsh-preview-editor -DistDir dsh-preview-editor\dist`
- `dist\local-dsh-preview-editor-1.0.2.tgz` 32559 B sha256 `CF7552FE2BF40E408C355C8D1CAEBE4B4E9EF021ED49EA0F83AB4BF4BAE09495`
- `dist\local-dsh-preview-editor-1.0.2.zip` 83866 B sha256 `8CA980CFC6D65ED9E643DAB278FA71CE5600489E20370BECD6F2581AB3F04DBB`
- MANIFEST built 2026-10-27T16:10:42；tarball 内 `package/client.js` = 56074 B = 源码一致
- dist 里 1.0.1 三件套已清；根目录 `dsh-preview-editor-1.0.0.zip` 是用户文件，**未删**

### 3.4 文档已更新

- `dsh-preview-editor/README.md`：配置 YAML 加了 `marks/marksMaxBytes/lineNumbers`；层叠图改成 `surface → gutter + box(pre.shiki + textarea)`；新增章节「Line numbers and invisible characters」含标记表；Limits 里"no line numbers"旧说法改掉，新增"gutter/marks 是绘制出来的、无缩进引导/折叠、长行只标第一行、对齐依赖共享常量"。
- `dsh-preview-editor/INSTALL.zh.md`：开头补功能；§七 配置键列表补 `marks/marksMaxBytes/lineNumbers` 并说明默认值即所求所以行配置里没写。
- `dsh-plugin-toolkit/README.zh.md`：版本 → 1.0.2；dist 清单 → 1.0.2 两项含哈希；新增「1.0.2 加了什么」引用块（28→33、5→9）；「改了代码没生效」行 5/5 → 9/9；新增两条坑（见 §5）。

### 3.5 open-in-app 深度分析（② 已交付，未落地改动）

- 控件 = 平台自带 `dsh-client-ui-open-in-app` + `dsh-host-open-in-app`，**行不接受任何配置**；文件打开器来自**操作系统文件关联**（目录打开器才是编译期白名单）。
- 主按钮规则（官方原话）：识别出默认应用 → 标「（默认）」并由主按钮打开；**否则第一个关联应用占据该位置**；子弹头里选应用只生效一次、不改系统默认。
- 用 DSH 自带 C# 适配器 `WINDOWS_ASSOCIATIONS`（`dsh-native-command/lib/types/file-applications-windows.js`）在本机复现 `SHAssocEnumHandlers`：`.yml/.yaml/.json` → ★Trae CN + 记事本/Bandizip/Word/旧版 WMP（共用「推荐的应用」尾巴，这就是"离谱"的来源）；`.txt` ★记事本；`.html` ★Edge；`.zip` ★Bandizip；`.md/.py/.png` **无默认** → 主按钮落到第一个（得到大脑 / py.exe / 得到大脑）。`.yml` 默认来自 `HKCR\.yml\OpenWithProgids = Trae CN.yml`，用户从未设置。
- 现成插件（都**不能**直接修这个控件）：[dsh-open-in-editor](https://dsh.fish/a/dsh-open-in-editor)（仅 macOS，只换产出文件回合尾，默认 IDE 在「设置 → Open in IDE」）、[dsh-open-in-app-base](https://dsh.pub/zh/plugins/dsh-open-in-app-base/)（会话头 "Open In…" 按钮组底座，架构最值得参考）、[dsh-open-with](https://ai-develop.top/blog/1789512689769)、[dsh-file-opener](https://findharness.com/plugins/sailoumili-dsh-file-opener)、[dsh-plugin-open-app](https://deepseekharness.io/plugins/dsh-plugin-open-app)（无关，跑 MCP 应用）。
- 第三方索引源（可填「插件 → 实验性插件 → 添加索引源」）：[dshindex.com](https://dshindex.com/zh)、[dshget.com](https://dshget.com/plugins)、[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)、[dsh.pub](https://dsh.pub/zh/)、[dsh.fish](https://dsh.fish/)、[dshpluginhub.ai](https://dshpluginhub.ai/en/plugins)、[deepseekharness.io/plugins](https://deepseekharness.io/plugins/)。
- 给用户的建议排序：① 在 Windows 改该扩展名默认应用（推荐、零代码，顺带给 `.md/.py/.png` 也设，否则主按钮永远列表第一个）；② 一次性用子弹头；③ 写插件覆盖控件；④ 向上游提需求。

---

## 4. 历次任务状态
## 4. 任务状态（2026-11-09 10:50 第二轮完成）

### 全部可由 Agent 独立完成的任务 —— 已全部做完 ✅

| # | 任务 | 结果 |
|---|---|---|
| P0-1 | `cordis.patch.yml` 注释 | ✅ 已重写：「编辑器」→ `Edit`、补全 `lineNumbers`/`marks`/`marksMaxBytes` 说明、明确「默认值即所求故不写进 config」、写清改配置需重启 / 改 client.js 只需刷新 |
| P0-2 | 技能文件 | ✅ 已确认落盘于 `C:\Users\franc\.dsh\skill-manager\library\dsh-preview-editor\SKILL.md`（内容本就是最新），并把打包件版本同步为 **1.0.3**（用 pwsh 字符串替换，工作区外） |
| P1-7 | 文档一致性 | ✅ `README.md` 第 11 行「编辑器 renderer」→ `Edit` 并补行号/标记；Verify 章节补 33 项 + 9 标记位；`INSTALL.zh.md` 两处 1.0.1 路径 → 1.0.3、技能路径 → skill-manager 库、26 项 → 33 项、写死端口 →「每次启动都变」；`verify-live.mjs` 用法注释改提示端口 |
| — | **升级 1.0.3 并重打包** | ✅ `package.json` 1.0.2→1.0.3；产物收敛到**根 `dist\`**（与 rag 1.1.0 并列），删掉插件目录内的 `dist\`；旧 1.0.1/1.0.2 产物已清 |
| — | **修打包脚本缺陷** | ✅ `pack-plugin.ps1` 把 `dist` 加进 zip 排除清单——否则新包会把上次产物递归打进去（168KB → 51KB，嵌套 dist 条目 0） |
| — | **文档哈希/版本同步** | ✅ `dsh-plugin-toolkit/README.zh.md`：版本沿革、dist 清单（新哈希）、6.1 的 26→33 项、1.0.3 修订说明；技能文件打包件路径 |
| — | **最终验证** | ✅ `node --check` ×3 全 exit 0；`verify.mjs` **33/33**；`verify-live.mjs http://127.0.0.1:64874` **9/9 markers / 200 / 56157 bytes**；tarball 内含最新 README/INSTALL/补丁/1.0.3；MANIFEST 哈希与实际一致 |

**1.0.3 最终产物（根 `dist\`）**：
- `local-dsh-preview-editor-1.0.3.tgz` 33171 B · sha256 `466EEBFBBC46794BB0663022524B1AA4D386F3AFC4FB4FA491C8387316702281`
- `local-dsh-preview-editor-1.0.3.zip` 51910 B · sha256 `E27CF34E2FEE809B5635E7B6C01FD358034CC7849FD6E74A2A8E5DF30CAA352C`
- `local-dsh-preview-editor-1.0.3.MANIFEST.txt`

> **client.js 自 1.0.2 起未改动**（56074 B，功能已完整）；1.0.3 只是把注释/文档/打包收敛补齐。所以预览编辑器功能**刷新页面即可**（client 代码现取），但 1.0.3 的 `cordis.patch.yml` 是配置层，若要让 profile 认到新版本还是按官方规则**重启应用**更稳妥。

### 仍需用户参与 / 决定（Agent 无法独立完成，留待“全部完成后再讨论”）

3. **截图从未到达**：`imageRef:"list"` → 无图。需重发，才能逐条确认「很离谱」具体是哪条（推测 Word/Bandizip/旧版 WMP 出现在 `.yml`，或默认竟是 Trae CN）。
4. **open-in-app 优化**：分析已交付，未落地改动。等用户选方案（① 改 Windows 默认应用【推荐、零代码】② 一次性子弹头 ③ 我写插件 ④ 提上游需求）。若选③，形态已定，坑：`POST /open-in-app/open` 只收目录路径、文件要用 `dsh-apiproxy` 的 `openPath`。
5. **视觉验证**：无浏览器控制，行号/标记的实际对齐要用户刷新页面看一眼；诚实表述只能是「已注册、已提供」。
6. **重启应用**：dsh-rag 1.1.0 的右侧栏面板需重启装配；重启后复核三处（侧栏插件两卡 / 设置→内置插件→插件列表→展开全局 / 功能面）。
8. **根目录 `dsh-preview-editor-1.0.0.zip`**：用户文件，未删（已被 1.0.3 取代，可删）。

---

## 5. 关键设计决策与坑（别重新推导）

- **locale 字典必须扁平点号 key**：运行时 `dict[key]` 一次取值，嵌套对象 → 整个界面显示原始 key（1.0.0 的 `viewer.label` 事故，1.0.1 修）。测试里不能用 `t: (key) => key` 假翻译器。
- **跨 realm 断言**：`verify.mjs` 用 `vm.createContext` + `runInContext` 加载 bundle，模块产出的数组/对象带自己 realm 的原型，`node:assert/strict` 的 `deepEqual` 会报 "same structure but are not reference-equal"。字符串/数字不受影响。修法：`plain(v) = JSON.parse(JSON.stringify(v))` 过一道再比（已加在 verify.mjs）。
- **标记不替换字符**：只在字符自身盒子里加底色/轮廓，否则字形宽度变化会把光标推歪。行内普通空格不标记，只标记行尾空格。
- **gutter 是 textarea 的兄弟节点**：不进滚动区、不参与复制、不吃点击。位置来自绘制层实测而非假设计算；`reactShim` 的 `useEffect` 是 no-op，所以离线测试里 `tops` 恒为空、行号走 fallback（断言的正是 `8px / 26.6px / 45.2px`、`18.6px`）。
- **config 行激活时读 → 改配置必须重启应用；client 代码每次请求现取 → 改代码刷新页面即可**。
- **不要**把 Markdown 优先级改回 `builtin` 并列（那是"md 永远不可编辑"的历史原因）；**不要**改 Windows 文件关联；`~/.dsh/skills` 不是插件安装位置。
- open-in-app 图标 = 系统默认应用；箭头里选应用一次性、不改默认；菜单长且杂源自 Windows 未过滤的 `SHAssocEnumHandlers` + 共用「推荐的应用」尾巴；失败只给短暂 Toast。
- 两个插件在 profile 的登记：`dependencies` 两条 `link:` + `dsh.profile.bundles` 末尾两条；profile 的 `cordis.patch.yml` **不含**这两个插件的行（它们各自用 bundle patch 插行）。

---

## 6. 复核命令（用上面那个绝对路径的 node）

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd dsh-preview-editor
& $node --check client.js
& $node verify.mjs                                   # 期望 33/33
& $node verify-live.mjs http://127.0.0.1:<当前端口>   # 期望 9/9 markers, 200（端口每次启动变化，见 GUI URL）
pwsh -File ..\dsh-plugin-toolkit\pack-plugin.ps1 -PluginDir . -DistDir ..\dist
```

打包后必须同步 `dsh-plugin-toolkit/README.zh.md` 里的版本号/大小/SHA256 和 `dsh-preview-editor/INSTALL.zh.md` 里的打包件路径。
