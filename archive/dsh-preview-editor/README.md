# dsh-preview-editor · 开发归档

一个 DSH 侧边栏「文档预览编辑器」插件从 0 到 1.0.5 的完整开发记录。
**归档时间**：2026-11-12 · **最终版本**：1.0.5 · **状态**：功能完成；profile 里该行现为 `disabled: true`（已停用），源码仍以 `link:` 登记在 desktop profile 的 dependencies

> 这个目录的用途：如果将来要**继续开发**、**重做**、或者**回忆当初为什么这么做**，
> 只看这一个目录就够。代码、产物、决策理由、平台机制证据全部在内。

---

## 1. 这是什么插件

DSH 右侧栏打开文本文件时，默认只有「代码 / 纯文本 / Markdown」等**只读**查看器。
本插件在「打开方式」菜单里加一个 **`Edit`**，选中后把同一份文件变成**可编辑的 textarea**，
支持行号栏、不可见字符标记（回车/行尾）、Markdown 源码编辑，并能保存回磁盘。

| 项 | 值 |
|---|---|
| 包名 | `@local/dsh-preview-editor` |
| 版本 | 1.0.5 |
| 入口 | `index.js`（宿主半）+ `client.js`（浏览器半） |
| 浏览器路由 | `/api/dsh-preview-editor` |
| 依赖注入 | `documentPreviews` / `slots` / `locale` |
| 许可 | MIT |

---

## 2. 目录结构

```
archive\dsh-preview-editor\
├─ README.md                  ← 本文件（索引 + 决策记录 + 规则）
├─ DEVELOPMENT-LOG.md         ← 四轮开发的完整复盘（原始交接记录，含全部细节）
├─ source\                    ← 1.0.5 源码快照，可直接放回插件目录继续开发
│  ├─ client.js               ← 主体：编辑器渲染层、行号、标记、保存逻辑
│  ├─ index.js                ← 宿主半：文件读写路由
│  ├─ cordis.patch.yml        ← 插件行的配置说明（全部配置键都注释在这里）
│  ├─ package.json
│  ├─ README.md               ← 用户向文档（安装、配置、机制解释）
│  ├─ INSTALL.zh.md           ← 中文安装说明
│  ├─ verify.mjs              ← 离线自检 36 项（不需要跑 App）
│  ├─ verify-live.mjs         ← 在线自检 11 个标记位（需要 App 在跑）
│  ├─ icon.svg
│  └─ locale\{en,zh}.json
├─ packages\                  ← 可安装产物，解压即用
│  ├─ local-dsh-preview-editor-1.0.5.tgz      ← npm 包（推荐）
│  ├─ local-dsh-preview-editor-1.0.5.zip      ← 免 npm 的整包
│  ├─ local-dsh-preview-editor-1.0.5.MANIFEST.txt
│  └─ dsh-preview-editor-1.0.0.zip            ← 最早的 1.0.0 包，留作对比
├─ tools\                     ← 与本案绑定的三个诊断/打包脚本
│  ├─ pack-plugin.ps1         ← 打包（排除 node_modules/.git/dist）
│  ├─ verify-viewer-order.mjs ← 复现平台「查看器菜单排序」算法
│  └─ asar-slice.cjs          ← 从 app.asar 里按字符串切片读平台源码
└─ reference\                 ← 预留：放平台相关源码摘录
```

---

## 3. 决策记录（ADR）

只记**做了选择**且**将来可能想推翻**的事。每条给：结论 → 理由 → 反面代价。

### ADR-001 · 用 `documentPreviews` 加菜单项，而不是接管整个预览面板

- **结论**：注册一个 `ctx.documentPreviews.register()` 的 renderer，在「打开方式」菜单里加 `Edit`。
- **理由**：这是平台唯一的官方扩展点；接管整个 tab 要重写所有查看器。
- **代价**：菜单顺序受平台算法支配（见 ADR-002），无法自由控制。

### ADR-002 · 接受「`Edit` 不能排在纯文本之后」

- **结论**：`Edit` 排在「除纯文本外」的查看器最后一位；**纯文本永远垫底，改不了**。
- **理由**：平台 `TextPreview` 里是 `candidates = [...matched, plainText]`——纯文本查看器的
  `extensions` 是**空数组**，永不参与排序，被**无条件追加**到列表末尾。菜单直接
  `items: candidates.map(...)`。这不是配置问题，是平台硬编码。
- **反面代价**：用户会以为「插件没把顺序改对」。所以 README / INSTALL / 技能文件里
  都必须写明这一点，避免下次又去改一遍。
- **替代方案（已评估并否决）**：
  - 注册 `PLAIN_BODY_ID` 抢占 → 重复 id 直接抛错。
  - `priority: 'fallback'` → rank 1，反而更靠前。
  - `loading: 'text-pages'` 假装成纯文本 → 平台自己分页，全量编辑会丢内容。
  - 头部独立「Edit」按钮 → `sidebar.right.tab.document.actions` 的 owner prop 只有
    `absolutePath`，拿不到 `actions.selected(tabId, rendererId)`；`openResource(address, {params})`
    也只支持 `line`，**没有 renderer 参数**。唯一能切 renderer 的 `actions` 是组件私有。

### ADR-003 · 默认用 `builtin` 档（不抢默认查看器）

- **结论**：两个 renderer 默认注册在 `builtin` 档，平台自带查看器仍是默认。
- **理由**：插件定位是「需要时才编辑」，不是「所有文件都用编辑器打开」。
- **逃生门**：配置 `editableAsDefault: true` 切到 `extension` 档，`Edit` 成为默认查看器。
  若用户真实诉求是「打开就能编辑」，**应该用这个开关，而不是去改菜单顺序**。

### ADR-004 · 渲染失败必须让「加载态」可见

- **结论**：`draft.status !== 'ready'` 时提前 return 一个带 `data-preview-editor="loading"` 的可见占位。
- **理由**：1.0.2 的事故——`rowCount(draft.text)` 在 return tree 之前无条件执行，
  首帧 `draft.text` 是 `undefined`，`undefined.split('\n')` 抛 TypeError → React 不提交 effect
  → 读取永不启动 → **面板永久空白**，且没有任何错误提示。
- **永久规则**：**任何时候都不许在 `status === 'ready'` 之外对 `draft.text` 调字符串方法。**
  测试必须覆盖「无 seed 的初始加载态」，不能只 seed ready 态（这是当初 33 项全绿却漏掉该 bug 的原因）。

### ADR-005 · 文档与代码必须同批更新

- **结论**：每次改行为，README / INSTALL.zh.md / cordis.patch.yml 注释 / toolkit README / 技能文件
  全部同步，版本号同步 bump，`verify.mjs` 项数与 `verify-live.mjs` 标记数同步改。
- **理由**：这套文档曾经出现「README 说 Edit 在最后、实际不是」的漂移，导致错误结论被反复复用。

---

## 4. 平台机制备忘（省得下次再挖）

| 问题 | 答案 | 证据位置 |
|---|---|---|
| 查看器菜单怎么排序？ | `rank = (priority === 'builtin' ? 0 : 1)`，排序 `b.rank - a.rank \|\| b.len - a.len \|\| a.i - b.i`；先档位、再最长后缀、再注册顺序 | `verify-viewer-order.mjs` 复现 |
| 为什么纯文本总在最后？ | `candidates = [...matched, plainText]`，纯文本 `extensions: []` 永不匹配、无条件追加 | 平台 `TextPreview` |
| 能加「头部 Edit 按钮」吗？ | 不能切换 renderer。`.actions` 只给 `absolutePath`；`openResource` 只支持 `line` | ADR-002 |
| 改配置要重启吗？ | 要。配置在**行激活**时读取 | — |
| 改 `client.js` 要重启吗？ | 不要，刷新页面即可（每次请求现取） | — |
| 怎么在不启 App 的情况下自检？ | `node verify.mjs` → 36/36 | `source\verify.mjs` |
| 怎么验证线上真的生效？ | `node verify-live.mjs http://127.0.0.1:<端口>` → 11/11 | `source\verify-live.mjs` |
| 端口每次都变怎么办？ | 从运行时上下文取当前 `DSH Web GUI URL`，作为 argv 传进去 | — |

**验证命令（PATH 里没有 node）**：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd <解压后的 source 目录>
& $node --check client.js
& $node verify.mjs                                    # 期望 36/36
& $node verify-live.mjs http://127.0.0.1:<端口>        # 期望 11/11
```

**重新打包**：

```powershell
pwsh -File tools\pack-plugin.ps1 -PluginDir <source目录> -DistDir <输出目录>
```
`pack-plugin.ps1` 已把 `dist` 列进排除清单——否则会把上次的包又塞进新 zip（曾经 168KB → 修好后 51KB）。

---

## 5. 恢复/继续开发的步骤

1. 把 `source\` 拷成一个插件目录，例如 `C:\dsh\dshplug\dsh-preview-editor\`。
2. 在 profile 的 `package.json` 里加 `"@local/dsh-preview-editor": "link:<该目录>"`，
   并把包名加进 `dsh.profile.bundles`；或在 `cordis.patch.yml` 里 insert 一行。
3. **完全退出并重启 App**（配置在行激活时读取）。
4. 打开任意 `.txt` / `.ts` / `.md`，在「打开方式」里选 `Edit`。
5. 改完跑 `verify.mjs`；想要在线验证再跑 `verify-live.mjs`。

若只是想装来用、不打算改代码：直接 `packages\local-dsh-preview-editor-1.0.5.tgz`，

```powershell
dsh plugin --profile desktop add <绝对路径>\local-dsh-preview-editor-1.0.5.tgz
```

---

## 6. 本案立下的规则（写下来是为了下次不用重新想）

### 关于归档

1. **归档目录自包含**：源码 + 产物 + 工具 + 决策记录四件套齐全，不依赖外部路径也能复原。
2. **产物进归档、不进 git**：仓库 `.gitignore` 忽略 `*.zip` / `*.tgz` / `MANIFEST.txt`，
   所以 `packages\` 里的二进制**不会被提交**，只在本机存在。
   要跨机带走，用压缩包传，别指望 `git pull`。
3. **每个插件一个归档目录**：`archive\<插件名>\`，互不干扰；归档后原工作区目录可以清理，
   但**删之前先确认 `git status` 干净**。
4. **归档只写结论，不写流水账**：过程细节丢进 `DEVELOPMENT-LOG.md`，
   `README.md` 只留「结论 + 理由 + 代价」。
5. **归档日期与版本号写死**，不写「最新」这种会腐烂的词。

### 关于开发

6. **先证伪再动手**：遇到「平台做不到」的判断，必须拿出源码级证据（`asar-slice.cjs`），
   不能靠猜。（ADR-002 就是靠这条避免了一次白干。）
7. **测试要覆盖初始态**：只 seed 成功态的测试会漏掉「首帧崩溃」这类致命 bug。（ADR-004）
8. **文档与代码同批改**，版本号同步 bump。（ADR-005）
9. **不在 sandbox 边界上硬碰**：技能文件在 `~/.dsh` 外时可以走 `pwsh` + `[IO.File]` 直写，
   但**注意 PowerShell 替换会吃掉反引号**——用 `[char]96` 拼接，改完必须回读校验。

---

## 7. 遗留事项

| 项 | 状态 |
|---|---|
| 截图（`.yml` 菜单离谱的那个） | 用户从未送达，open-in-app 分析因此只有代码层结论 |
| open-in-app 方案选择 | 未决，等用户拍板 |
| 行号/标记的视觉对齐 | 需人眼确认（代码里是按实测像素顶对齐的） |
| `editableAsDefault: true` 是否启用 | 用户回复「这个不用了」，保持默认只读 |
| dsh-rag 1.1.0 面板装配 | 需重启 App 才可见 |
| 本插件行 `disabled: true` | 已停用；要恢复使用，把 profile 里该行改回 `name: '@local/dsh-preview-editor'` 后重启 |

---

## 8. 版本沿革

| 版本 | 变更 |
|---|---|
| 1.0.0 | 首个可用版本：菜单加 `Edit`、可保存 |
| 1.0.1 | 修 i18n：字典从嵌套改扁平点号 key（否则菜单显示原始 `viewer.label`） |
| 1.0.2 | 加**行号栏**与**不可见字符标记**（回车/行尾）—— 同时引入 `rowCount(undefined)` 回归 |
| 1.0.3 | 补注释/文档，产物收敛 |
| 1.0.4 | **修「选 Edit 一片空白」**（ADR-004）；默认查看器改回平台内置（`builtin` 档） |
| 1.0.5 | **认知修正**：确认「纯文本」是平台硬编码末项，`Edit` 只能保证在它之前（ADR-002）；加不变式测试；自检 35 → **36 项** |

---

## 9. 产物清单与校验（归档时实测）

| 文件 | 字节 | sha256 |
|---|---|---|
| `local-dsh-preview-editor-1.0.5.tgz` | 34,993 | `08FE261612B41659D080672603DF947513156DDD502112832CD66347B9FA631D` |
| `local-dsh-preview-editor-1.0.5.zip` | 54,598 | `6DA11A8C187375D24908D9C43F9B47877E37C7FE39537F12B55DCA534665AC72` |
| `dsh-preview-editor-1.0.0.zip` | 39,231 | `D82CA4B9C4C398AE324397D818178746EFE94E0D37BBEBDD52F2373FFADA3CCB` |

**归档时的验证状态**（2026-11-12）：

- `node --check` × 3 个文件 → exit 0
- `verify.mjs` → **36/36** 通过
- `verify-live.mjs` → 本次返回 **404 / 0 标记位**，因为归档时 profile 里这一行是
  `- id: preview-editor` + `disabled: true`（插件当时已停用）。这是**预期状态，不是缺陷**：
  在线校验只在插件被挂载时才有意义。最后一次挂载状态下的实测是 2026-11-10 的 **11/11 标记位 / HTTP 200**。
- `source\` 下 11 个文件与工作区 `dsh-preview-editor\` **逐字节一致**（SHA256 全等）
- `packages\` 下 1.0.5 的两个产物与 `dist\` 原件 **SHA256 全等**

> 这些二进制不进 git（见上级 `archive\README.md` 的说明）。要跨机使用请手动传。
