# dsh-pixel · 开发与退役过程复盘

> 流水细节都在这里。结论性的东西在 `README.md`，不要在这份里找决策定论。

---

## 阶段 0 · 前身：`C:\dsh\mantaplugin`（约 2026-11-09 起）

插件最早不在 `dshplug` 仓库里，而是一个独立目录 `C:\dsh\mantaplugin`，包名
`@local/dsh-manta-pixel`，宿主路由 `/dsh-manta`。

当时形态是**右侧侧栏的一个标签页**。三个具体问题促成了后来的改版：

1. 画布被侧栏宽度裁死，像素在 300px 宽里根本看不清；
2. 它是个工具，不是当前对话的附属品，塞在对话旁边语义不对；
3. 换个对话就要重开一次，作品库的上下文随之丢失。

---

## 阶段 1 · 并入 `dshplug`，升到 0.1.0

**改了什么**

- 目录搬进 `C:\dsh\dshplug\dsh-pixel\`，包名 `@local/dsh-manta-pixel` → `dsh-pixel`，
  **目录名 == 包名**（因此 `list.json` 里不需要 `packageName` 桥接字段）。
- 宿主路由 `/dsh-manta` → `/dsh-pixel`。
- 形态从「右侧标签页」改成「**左侧任务栏小应用**」：`sidebar.panellist` 放图标，
  `main` 席位放全宽面板；右栏只保留一张快捷卡片当入口，不是主界面。
- 导出的文件名前缀不再写死 `manta-mark`，改成由文档上的 `slug`（`BRAND.slug`）决定，
  宿主半只负责拼名字。品牌信息外置成 `BRAND` 对象，插件本体不再硬编码 IP。

**注册方式**：直接走 `ctx.slots.inject` + `ctx.slots.register`（核心 slots 注册表），
不依赖任何第三方侧栏封装。原因很实在——本机装的某个第三方侧栏插件是坏的，
依赖它的插件会连带失效。

**左右两半必须同名的三处**（任何一处对不上 → 插件**静默不加载**，没有报错，只是没出现）：

```
package.json        name:            'dsh-pixel'
cordis.patch.yml    - id:            dsh-pixel
lib/index.js        export const name = 'dsh-pixel'
```

`test/host.test.mjs` 专门断言这三处一致，就是为了让这种静默失败在提交前暴露。

---

## 阶段 2 · 踩过的坑

### 坑 1 · `startSession` 不在 `layout` 上

工作台需要「切到面板」和「带内容开一轮对话」两件事，分别属于两个服务：

| 需求 | 服务 | 调用 |
|---|---|---|
| 切到工作台 | `layout` | `selectPanel('dsh-pixel')` |
| 回到对话 | `layout` | `selectPanel(null)` |
| 带内容开一轮 | `uiWorkspace` | `startSession(undefined, { prompt, whenDraftExists: 'append' })` |

第一次把 `startSession` 当成 `layout` 的方法写的，直接找不到。

### 坑 2 · 顺序反了会静默丢提示词

`selectPanel` 会中止 `startSession` 注册的**待处理导航**。
先切面板再开会话 → 提示词静默丢失（composer 是空的，控制台无错）。

正确顺序：

```js
openConversation();          // selectPanel(null) —— 先回到对话
workspace.startSession(...)  // 再开一轮，提示词才留得住
```

`test/client.test.mjs` 断言启动时 `selected` 与 `started` 都为空：注册本身不该有副作用，
只有点击才该有。

### 坑 3 · 读未声明的服务会抛异常，不是返回 undefined

Cordis 的 context 是代理：读未在 `inject` 里声明的服务键会**抛异常**。
而版本漂移（用户的 DSH 比插件新/旧）是常态。所以每个服务读取都过一层：

```js
function guardedService(ctx, name) {
  try { return ctx.get(name) || null; } catch { return null; }
}
```

读不到就降级——对话那条路径改成提示「已复制到剪贴板」，而不是整个工作台白屏。
**一个可选服务的缺失不该毁掉主功能。**

### 坑 4 · `slug is not defined`（导出必定 400）

`slug` 声明在 `renderRgba` 里，`normalize` 读不到。这个 bug 是**真实跑通线上路由时才暴露的**，
静态检查和单元测试都没抓到。

### 坑 5 · `tools/exports.py` 会覆盖定稿的主标记

早期 `exports.py` 会**先跑一遍 `asset_build.py` 的绘制**，把编辑器里定稿的主标记覆盖掉。
改成「从**当前** `manta-mark-48.png` 派生整档」后，实测导出前后 16 个文件哈希不变。

`tools/asset_build.py` 顶部已标注：它是「**重画**」而不是「派生」，日常刷新不要用它；
同时去掉了会先生成再删除的 128/256/1024 尺寸。

### 坑 6 · 调色板选中态

改成平面描边（`outline`），去掉立体阴影——像素画本身已经是视觉噪声，控件再加阴影会看不清选中区。

---

## 阶段 3 · 资产契约是怎么定下来的

见 `source\docs\CONTRACT.md`。要点与理由：

| 规则 | 值 | 为什么 |
|---|---|---|
| 原生网格 | 48 × 48 | 能整除 16 和 24（小尺寸图标族），四档整数放大后正好落在常用尺寸上，48 本身 100% 缩放下可读 |
| 放大档位 | ×1…×21，只允许整数倍 | 采样是最近邻，每个源像素变成一个 `scale × scale` 实心块；非整数倍会产生半透明边缘，那就不是像素画了 |
| 为什么没有 64 | 48 × 4/3 不是整数 | 要么按 64 网格重画一张，要么不提供——不能靠插值凑 |
| 小尺寸 16/24/32/64 | 各自网格**手绘** | 48 的细节缩到 16 会糊：1px 描边变 1/3 px，识别不出来 |
| 512 画布 | 480 居中 + 四周 16px 透明 | 满足社交平台/商店要求的正方形画布，不是为了放大 |
| 调色板 | 8 色固定 | 加色要同时改 `palette.json`、`palette.png` 和示例作品，否则再生成会漂移 |
| 留白 | 四周至少 1 个原生像素 | 贴边在深浅底上都会被裁，圆角容器还会啃掉角落 |
| 命名 | `<slug>-<边>px.png` | 导出**覆盖同名文件**，不产生 `-2` `-3` 变体；版本历史归 Git，不归文件名 |

---

## 阶段 4 · 状态放哪

| 状态 | 位置 | 生命周期 |
|---|---|---|
| 作品（图层、调色板、行字符串） | 像素编辑器的存储（`/dsh-pixel-studio` 路由） | 跨会话 |
| 当前选中的作品 / 颜色 / 缩放 | 组件内 `useState` | 页面存活期 |
| 导出产物 | `<工作区>/assets/mark/` | 落盘，可再生成 |

宿主半**不读写**像素编辑器的存储：写入走它的 `save` op，读列表走它的 `list` op——
两个插件不共享内存，只共享 HTTP 契约。
没有任何状态存在插件自己的模块作用域里，除了 `PIXEL_HOST`（两个服务引用在 `apply` 时捕获一次，之后只读）。

---

## 阶段 5 · 退役（2026-11-16）

### 背景

用户找到了市场替代：`@muxiuesd/dsh-pixel-studio@0.6.1`（通用像素编辑器：三栏编辑、连续缩放、
直线/矩形/椭圆可填充、图层、矩形选区、最多 256 色调色板可导入导出 JSON、2048×2048 画布、导出 PNG 与调色板 JSON）。
决定卸载自研 `dsh-pixel`，改用市场版，并要求「清理好所有痕迹」。

### 退役前的实际状态核查（重要：和预期不一样）

用户以为「已经从插件卸载了，也移到 archive 了」，实际核查结果是：

| 项 | 预期 | 实际 |
|---|---|---|
| profile 的 `dependencies` 里还有 `link:` 吗 | 没有 | **已经没有** ✓ |
| profile 的 `dsh.profile.bundles` 里还有 `dsh-pixel` 吗 | 没有 | **已经没有** ✓ |
| `cordis.patch.yml` 里还有 insert 行吗 | 没有 | **已经没有** ✓ |
| 宿主路由还活着吗 | 不该活 | `GET /plugins/pixel/state` → **404** ✓ |
| `node_modules\dsh-pixel` 软链接 | 应该没了 | **还在**，是个 Junction → `C:\dsh\dshplug\dsh-pixel` ✗ |
| `C:\dsh\dshplug\dsh-pixel\` 源码目录 | 应该移走了 | **还在原地** ✗ |
| `archive\dsh-pixel\` | 应该有四件套 | **不存在**（第一次核查时是我把 `Get-ChildItem` 的空行看错了） ✗ |
| `list.json` 里的条目 | 应该清掉 | **还在**，`status: active` ✗ |

所以「卸载」只完成了**运行时那一半**（插件行与 link 依赖已摘除、路由已 404），
**磁盘上那一半**（软链接、源码目录、清单登记）全是残留。

### 做了哪些清理

1. **归档**：先快照 `source\`（49 个文件），跑 `node --check` × 2 + `node test/run.mjs`
   → **all suites passed**；SHA256 逐文件比对，49/49 与工作区一致。
   然后用 `pack-plugin.ps1` 打 `.tgz` + `.zip` + `MANIFEST`，记录哈希写进 README §5。
2. **拆 Junction**：`[System.IO.Directory]::Delete($p, $false)`——**不能用 `Remove-Item -Recurse`**，
   那会穿透进目标目录把源码整棵删掉。
3. **清 `list.json`**：删掉 `dsh-pixel` 条目，`updated` 改成本日。
4. **清仓库文档**：`README.md` 的「目录名 = 包名 = 清单 name」列举、`BOOTSTRAP.md` 的
   「Mpixel 待改显示名」表格行与相关说明。
5. **清 `dsh-synchub` 的过期引用**：它的 ADR / README 里把 `dsh-pixel` 列为「本地源码 `link:`」、
   「并入 dshplug 的插件之一」、「锁了 `private` 未发布」，退役后这些话都不成立了。
   **只改这些过期描述，不动 `pixel-studio` 缓存目录那一行**——那是市场版的数据目录。
6. **删源码目录** `C:\dsh\dshplug\dsh-pixel\`（在归档校验通过之后，删除前又做了一遍 49 文件哈希全等确认）。
7. **收旧版进归档**：`C:\dsh\_trash-20261112\mantaplugin-old\`（43 个文件，插件前身，
   里面的资产是**早期一轮生成**——例如 `manta-mark-1008.png` 是 8,736 字节，
   定稿版是 6,714 字节，不是同一张图）。逐字节比对后整棵拷进
   `archive\dsh-pixel\legacy\mantaplugin-old\`（43/43 一致），再删回收站那份。
8. **归档落位**：`C:\dsh\dshplug\archive\` 的写入阻塞后来随会话文件策略放宽而消失；
   内容从暂存区 `Move-Item` 进 `archive\dsh-pixel\`，移动后重算产物 SHA256，与 README §5 一致。

> ⏶ **关于 Git 的一次自我纠错**：清理早期我写下了「`dsh-pixel` 从未进入 Git」，**那是错的**。
> 最终复核 `git ls-files -- dsh-pixel` → **49 条**，`git log --all` → 两次提交
> （`3221bdf` / `33f5b13`），`git ls-tree origin/master` → 也有。
> 所以本次删除在 `git status` 里表现为 49 条 `D`，**必须提交并推送**才能同步到其他机器。
> 详情与教训见 `reference/PLATFORM-EVIDENCE.md` E6。

### 一个不属于本插件、但必须留下的东西

`~/.dsh/pixel-studio/works.json`（4,722 字节，含 `mantamark48` 等作品）**不清**。
它看起来像自研 `dsh-pixel` 的私有数据，实际是市场插件 `@muxiuesd/dsh-pixel-studio` 的数据目录：

- 自研版 `lib/index.js` 注释写明「artwork storage ... stays in a pixel store plugin;
  this route never reads or writes that store」——**宿主半根本不碰它**；
- 市场版 `storeDirectory()` 返回 `DSH_PROFILE_DIR/pixel-studio` 或 `DSH_HOME/pixel-studio`
  （默认 `~/.dsh/pixel-studio`），`storeFile()` 是其中的 `works.json`。

删了 = 真丢作品。这条写进 README ADR-002。

### 遇到的问题：`archive\` 整个目录写不进去

清理过程中 `C:\dsh\dshplug\archive\` 突然拒绝一切写入，四项探测全失败：

| 探测 | 结果 |
|---|---|
| `New-Item archive\_probe-a` | denied |
| `New-Item archive\dsh-pixel\source` | denied |
| `Set-Content archive\_probe.txt` | denied |
| `Set-Content archive\dsh-preview-editor\_probe.txt`（往**已存在**的目录里写） | denied |
| `Rename-Item archive\dsh-preview-editor` | denied |

而同一时刻 `New-Item C:\dsh\dshplug\_probe-c`（仓库根）**OK**。
说明不是普通 NTFS 权限问题（`Get-Acl` 看 archive 的继承项是全的），而是 DSH 沙箱对
`archive\` 子树的授予失效。结论：与 dsh-pixel 退役无关，是并行的环境问题。

所以归档内容先组装在 `C:\dsh\dshplug\_stage-pixel-archive\dsh-pixel\`，
待权限恢复后整体 `Move-Item` 进 `archive\dsh-pixel\`（命令见 README §8）。

> 另记一条沙箱事实：在 workspace-write 模式下，`cmd | cmd` 形式的管道（`& $node x 2>&1 | Select-Object`）
> 会因为 `pipe ... is denied` 失败。跑 node/pnpm/tar 要用
> `Start-Process -RedirectStandardOutput <文件>` 再读文件，不要接管道。

---

## 附 · 文件清单（source 快照，49 个）

```
package.json  cordis.patch.yml  README.md
assets\palette.json  palette.pixel-studio.json  palette.png  presentation.png
assets\avatar\manta-{appicon-512,avatar-512}.png
assets\expression\manta-face-{blink,default,happy}[@48].png
assets\lockup\manta-lockup-horizontal[-light].png  manta-wordmark[-light].png
assets\mark\favicon.ico  manta-mark-{16,24,32,48,64,96,144,192,240,288,384,480,512,768,1008}.png
docs\ARCHITECTURE.md  CONTRACT.md  CHANGELOG.md  DEVELOPMENT.md  manta-chat-handoff.png  manta-studio.png
lib\index.js  client.js
test\run.mjs  host.test.mjs  client.test.mjs
tools\asset_build.py  bridge.py  exports.py
```
