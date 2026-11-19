# dsh-pixel · 开发归档（已退役）

**归档日 2026-11-16 · 版本 0.1.0 · 状态：退役，已由市场插件 `@muxiuesd/dsh-pixel-studio` 替代**

> 这个插件**已从 profile 卸载**，工作区源码目录 `C:\dsh\dshplug\dsh-pixel\` 已删除。
> 本目录是它唯一的留存。**归档 = 冻结**：要再改代码，先把 `source\` 放回 `C:\dsh\dshplug\dsh-pixel\`
> 并在本文件顶部标「已解冻」，不要直接在 `source\` 里改。

---

## 0. 三份文档分工

| 文件 | 回答什么 | 什么时候读 |
|---|---|---|
| **README.md**（本文件） | 为什么退、决策记录、平台机制备忘、怎么恢复、产物哈希 | 想复活它 / 想知道当初为什么那么做 |
| **DEVELOPMENT-LOG.md** | 从 `mantaplugin` 到并入 `dshplug` 到退役的全过程流水 | 要复盘细节、查某次改动的来龙去脉 |
| **reference\PLATFORM-EVIDENCE.md** | 相关平台机制的源码/实测证据摘录 | 怀疑某个结论时先看这里 |

---

## 1. 这是什么，为什么退役

### 是什么

把「像素 IP 标记」做成 DSH 左侧任务栏里的独立小应用：作品库、调色板、逐像素编辑、对话框指令，
以及按原生网格整数倍（48 → 1008 px）导出的整套品牌资产。

| 项 | 值 |
|---|---|
| 包名 | `dsh-pixel`（`private: true`，从未发布）。npm 上的 `dsh-pixel` 是**别人**（dushaobindoudao）的包，与本插件无关 |
| 版本 | 0.1.0 |
| 宿主半 | `lib/index.js`，路由 `POST /dsh-pixel` |
| 浏览器半 | `lib/client.js`，`sidebar.panellist` 图标 + `main` 全宽面板 + 右栏快捷卡片 |
| 依赖 | 零三方依赖（PNG 用 `node:zlib` + 手写 CRC32 编码） |
| 测试 | `test/run.mjs`（host + client 两套零依赖替身渲染） |
| 许可 | MIT |

### 为什么退役

**结论**：功能被市场插件 `@muxiuesd/dsh-pixel-studio@0.6.1` 覆盖，且市场版是通用像素编辑器
（三栏编辑、缩放、直线/矩形/椭圆、图层、选区、256 色调色板、2048×2048 画布、PNG/JSON 导出），
维护成本低于自研，所以卸载自研版、改用市场版。

**理由**：
1. 自研版的差异化只有「整数档资产导出契约」（48 的倍数阶梯 + 8 色板 + 小尺寸手绘）。
   这部分价值集中在**一次性产出一套 Manta 品牌资产**，不是日常使用。
2. 日常「画像素画」这件事，市场版做得更全，不需要自己维护。
3. 自研版要跟着 DSH 的 slots / 服务签名走，每轮平台升级都要重新验证，收益与成本不匹配。

**反面代价**（写下来是因为它真实存在）：
- **整数档导出契约随插件一起冻结**。市场版没有「48 倍数阶梯 + 最近邻重生成整档」的能力，
  以后要改 Manta 标记或产新版资产，得先解冻本归档、跑 `tools/exports.py`，或者手写脚本。
- 市场版与自研版**共用同一份数据目录** `~/.dsh/pixel-studio/works.json`（两边存的都是
  `{version:1, works:{...}}`，且都不校验作品对象里的私有字段）。所以作品（如 `mantamark48`）**不会丢**，
  但它从此归市场版所有——**清理自研插件时不能把那个目录当垃圾删掉**。
- 自研版的「对话框指令」（自然语言请求经 `uiWorkspace.startSession` 送进当前会话）在
  市场版里没有对应物，这条交互路径随之消失。

**已否决的替代方案**：
- *保留自研版、加个禁用开关*：`cordis.patch.yml` 里加 `disabled: true` 能停用，但源码目录、
  profile 的 `link:` 依赖、`node_modules` 软链接都得留着，属于「半退役」，日后排查插件冲突时会被误读。
- *只删目录、不做归档*：违反 AGENTS.md「归档=冻结 + 四件套」的约定，`tools/*.py` 里的资产派生逻辑
  会永久丢失（市场版没有这段逻辑）。
- *把整数档导出能力移植进市场版*：市场版是第三方 npm 包，移植等于 fork 维护上游，成本高于本归档。

---

## 2. 目录结构

```
archive\dsh-pixel\
├─ README.md                    ← 本文件（索引 + 决策 + 机制备忘 + 恢复步骤 + 哈希）
├─ DEVELOPMENT-LOG.md           ← 从 mantaplugin 到退役的全过程复盘
├─ source\                      ← 0.1.0 源码快照（49 个文件，与退役前工作区逐字节一致）
│  ├─ package.json              ← dsh.bundle.patch + dsh.client(platform: web)
│  ├─ cordis.patch.yml          ← 插件行：- insert: - id: dsh-pixel
│  ├─ README.md                 ← 原插件用户文档（安装/契约/用法）
│  ├─ lib\index.js              ← 宿主半：导出路由 + 零依赖 PNG 编码
│  ├─ lib\client.js             ← 浏览器半：左侧小应用 + 右栏快捷卡片
│  ├─ assets\                   ← 调色板 + Manta 示例资产（16…1008 px 全套）
│  ├─ docs\                     ← ARCHITECTURE / CONTRACT / CHANGELOG / DEVELOPMENT + 截图
│  ├─ test\                     ← run.mjs + host.test.mjs + client.test.mjs
│  └─ tools\                    ← asset_build.py（重画）/ exports.py（派生）/ bridge.py
├─ packages\
│  ├─ dsh-pixel-0.1.0.tgz            ← npm 包，按 package.json "files" 打包
│  ├─ dsh-pixel-0.1.0.zip            ← 整包源码（可直接解压继续开发）
│  └─ dsh-pixel-0.1.0.MANIFEST.txt   ← 版本、字节数、SHA256、包内容清单
├─ tools\
│  └─ pack-plugin.ps1          ← 重打包脚本（从 dsh-preview-editor 归档复制，通用）
├─ reference\            ← 本次退役涉及的平台机制证据（数据目录、路由、加载、Git 状态）
│  └─ PLATFORM-EVIDENCE.md
└─ legacy\
   └─ mantaplugin-old\   ← 2026-11-09 前身版本（43 个文件，含早期一轮资产）
                          从 C:\dsh\_trash-20261112\mantaplugin-old 逐字节拷入，原件已删
```

---

## 3. 决策记录（ADR）

> 格式：结论 → 理由 → 反面代价 → 已否决的替代方案。

### ADR-001 · 退役，而不是继续维护自研版

见上文「为什么退役」（同一份内容，此处只留索引，避免两处漂移）。

### ADR-002 · 归档时把 `~/.dsh/pixel-studio\` 留给市场版，不清空

- **结论**：`works.json`（含 `mantamark48` 等作品）**原样保留**，归 `@muxiuesd/dsh-pixel-studio` 使用。
- **理由**：市场版 `index.js` 的 `storeDirectory()` = `DSH_PROFILE_DIR/pixel-studio`，否则
  `DSH_HOME`（默认 `~/.dsh`）`/pixel-studio`，store 文件固定为 `works.json`；
  读取时只认 `{version:1, works:{...}}` 外壳，`works` 里每个作品对象内部的多余字段不参与校验。
  自研版写入的正是同一种外壳，因此**两边数据天然兼容**，删了就是真丢作品。
- **反面代价**：目录名 `pixel-studio` 看起来像自研插件的私有数据（自研包名 `dsh-pixel`），
  日后容易误判成残留再删一次。**本行就是防这件事的**。
- **已否决**：把 `works.json` 拷一份进归档再删目录——归档会变成作品数据的第二副本，
  两份都可能被改，反而制造分叉；且用户明确要求「清理插件痕迹」，作品数据不属于插件痕迹。

### ADR-003 · 不做 Git 层面的历史清理

- **结论**：**不做** `git filter-branch` / `git reset` 之类的历史改写。源码目录用普通删除（`git rm` 后的状态即可），历史里那份留着。
- **理由**（先更正一个错误结论）：早期判断过「从未进入 Git」，**那是错的**。后来用 `git ls-files -- dsh-pixel` 实测：**49 个文件已被追踪**；`git log` 显示两次提交——`3221bdf 新增 dsh-pixel：像素 IP 工作台插件` 与 `33f5b13 update 统一…`；且 `origin/master` 里也有它。
  当时之所以误判，是早期查询的输出被截断/掩盖导致读到了空结果。**教训：追踪状态必须用 `git ls-files` + `git log --all` 两个命令交叉确认，不能只看一次输出。**
  既然已推送过，改写历史就需要强推、会影响其他克隆，代价远大于收益；仓库历史里留着这份记录也不构成泄露（无凭据、无大二进制）。
- **反面代价**：`git pull` 到另一台仍会**创建** `dsh-pixel/` 目录（只是内容为旧版）。
  所以本次删除需要**提交并推送**才能真正同步到其他机器；未提交时那边仍会看到它。归档目录会作为新文件入库（期望行为），`packages\` 的 `.tgz` / `.zip` 按根 `.gitignore` 只留本机，`*.MANIFEST.txt` 会入库。
- **已否决**：
  - 改写 Git 历史（`filter-branch` / `filter-repo`）：已推送，要强推，收益为零。
  - 连工作区目录一起硬删、不归档：见 ADR-001 的「已否决」第二条。

### ADR-004 · 卸载要同时拆掉 profile 的 Junction 软链接

- **结论**：除了删 `dsh.profile.bundles` 里的名字和 `dependencies` 里的 `link:`，
  还必须删掉 `profiles\desktop\node_modules\dsh-pixel` 这个 **Junction**。
- **理由**：`link:` 依赖在 pnpm 下落实成 `node_modules\dsh-pixel` → `C:\dsh\dshplug\dsh-pixel` 的
  Junction。只改 `package.json` 不重装，Junction 会一直指着（之后会指着不存在的路径），
  宿主半的 `import` 报错会出现在日志里，属于「卸载不干净」。
- **反面代价**：删 Junction 必须用 `[System.IO.Directory]::Delete($p, $false)`；
  用 `Remove-Item -Recurse` 会**穿透进入目标目录**把 `C:\dsh\dshplug\dsh-pixel` 整棵删掉
  （Windows 上 Junction 的经典陷阱）。
- **已否决**：只把 profile 那一行改 `disabled: true`。那样插件文件仍在、路由仍被注册，
  只是不显示，等于没卸载。

---

## 4. 平台机制备忘（这次实测确认的）

| 问题 | 答案 | 证据 |
|---|---|---|
| 作品数据存在哪 | `$DSH_PROFILE_DIR/pixel-studio`，否则 `$DSH_HOME`（默认 `~/.dsh`）`/pixel-studio`；文件 `works.json` | `@muxiuesd/dsh-pixel-studio/index.js` `storeDirectory()` / `storeFile()` |
| 数据外壳格式 | `{"version":1,"works":{"<id>":{...}}}`；读取只校验 `works` 是对象 | 同上 `load()` |
| 自研版与市场版能共用数据吗 | 能。两边都只按 `works` 字典读写，未知字段被忽略 | 同上 |
| 卸载后路由还在吗 | 不在。实测 `GET /plugins/pixel/state` → **404** | 本机 HTTP 探测 |
| 卸载要动几处 | `package.json` 的 `dependencies` + `dsh.profile.bundles` + `cordis.patch.yml` 的 insert 行 + `node_modules` Junction | ADR-004 |
| 改 `client.js` 要重启吗 | 不要，刷新页面即可（浏览器每次请求现取） | AGENTS.md 平台机制要点 |
| 改 `package.json` / 插件行要重启吗 | 要（配置在行激活时读取） | 同上 |
| `list.json` 的 `entry.packageName` | 目录名 `===` 包名时**不写**，写了测试会失败 | `test/host.test.mjs` |

**离线自检命令**（PATH 里没有 `node`）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd <本目录>\source
& $node --check lib\index.js
& $node --check lib\client.js
```

> ⚠️ `node test/run.mjs` 需要 `..\list.json`（测试会读 `<插件目录>\..\list.json` 校验登记），
> 而归档里的源码在 `source\` 下、上一级是归档根，**没有** `list.json`。直接跑会 `ENOENT`。
> 正确复跑方式见 §6 恢复步骤（要先还原成插件目录名）。

---

## 5. 产物清单与校验（归档时实测）

| 文件 | 字节 | SHA256 |
|---|---|---|
| `dsh-pixel-0.1.0.tgz` | 20,991 | `0DBEEF444982563BFD7F400A55C2CBD1C9798BA272080F5C0A2E26009BFE04A2` |
| `dsh-pixel-0.1.0.zip` | 369,454 | `DC0EB4E2F2541DDFA4D41D1320BA7DB09CC6D03C961695A280C3FCEC93AC2706` |

**归档时的验证状态**（2026-11-16）：

- `node --check lib\index.js` / `lib\client.js` → exit 0
- `node test/run.mjs` → **all suites passed**（host + client 两套全绿）
- `source\` 下 **49 个文件**与退役前工作区 `C:\dsh\dshplug\dsh-pixel\` **逐字节一致**（SHA256 全等）
- 宿主半路由在卸载前已 404（插件已从运行时摘除），故无线上在线校验记录

> `packages\` 里的 `.tgz` / `.zip` 不进 git（根 `.gitignore` 忽略 `*.tgz` / `*.zip`），
> 只在本机存在。要跨机带走请手动传压缩包；`*.MANIFEST.txt` 会入库。

---

## 6. 恢复 / 继续开发

### 只想装来用（装回本机）

插件**不在 npm**，用归档里的包直接装进 profile：

```powershell
# 方式一：直接解压 zip 得到一个插件目录，再用 install.ps1（推荐，与其余自研插件一致）
Expand-Archive archive\dsh-pixel\packages\dsh-pixel-0.1.0.zip -DestinationPath C:\dsh\dshplug\
# 解压后目录名为 dsh-pixel\，正好是 install.ps1 期望的布局
& C:\dsh\dshplug\install.ps1 -Only dsh-pixel
```

装完**完全退出 DSH 再打开**（`link:` 与插件行都在启动时读取）。

### 想继续开发

1. 把 `source\` 整个目录拷成 `C:\dsh\dshplug\dsh-pixel\`（目录名必须等于包名，测试会断言这一点）。
2. 在仓库根 `list.json` 的 `plugins` 数组里加回一条：

   ```json
   {
     "name": "dsh-pixel",
     "dir": "dsh-pixel",
     "version": "0.1.0",
     "description": "像素 IP 工作台……",
     "installedOn": [],
     "status": "active"
   }
   ```

3. 在 profile 的 `package.json` 加 `"dsh-pixel": "link:C:/dsh/dshplug/dsh-pixel"`，
   并把 `dsh-pixel` 加进 `dsh.profile.bundles`。
4. **完全退出并重启 App**。
5. 复跑离线自检（此时 `..\list.json` 存在，测试能过）：

   ```powershell
   $node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
   cd C:\dsh\dshplug\dsh-pixel
   & $node test/run.mjs        # 期望 all suites passed
   ```

6. 在本文件顶部把状态改成「**已解冻**，继续开发见 `C:\dsh\dshplug\dsh-pixel\`」。

### 重新打包

```powershell
pwsh -File tools\pack-plugin.ps1 -PluginDir <插件目录> -DistDir <输出目录>
```

> 注意：`pack-plugin.ps1` 内部用 `|` 管道捕获 pnpm 输出。若在 DSH 沙箱内运行会报
> `pipe ... is denied`——这是沙箱限制，不是脚本坏了。在普通终端里跑即可。

---

## 7. 遗留事项

| 项 | 状态 |
|---|---|
| 整数档导出契约（48 的倍数阶梯 + 8 色板） | **随归档冻结**。市场版没有这个能力，需要时走 §6 |
| `~/.dsh/pixel-studio/works.json` | **保留**，归市场版；含 `mantamark48` 等作品。见 ADR-002 |
| 「对话框指令 → 当前会话」交互 | 市场版无对应物，随退役消失 |
| `dsh-synchub` 的 `caches` 同步面里含 `pixel-studio` | 仍有效（那是市场版的数据目录），**不要**因为自研插件退役就删掉 |
| 归档目录落位 | ✅ 已完成，见 §8 |

---

## 8. 归档落位记录（已完成）

本次退役时 `C:\dsh\dshplug\archive\` 曾出现**整个目录写入被拒**的异常
（连新建一个空子目录、往已存在的 `archive\dsh-preview-editor\` 里写一个文件都报
`Access to the path ... is denied`），确认与 DSH 沙箱对该子树的写入授与失效有关，
与插件本身无关（证据见 `reference\PLATFORM-EVIDENCE.md` E8）。

**处置**：先在 `C:\dsh\dshplug\_stage-pixel-archive\dsh-pixel\` 组装完整归档；
待会话文件策略放宽（沙箱阻塞解除）后执行：

```powershell
Move-Item C:\dsh\dshplug\_stage-pixel-archive\dsh-pixel C:\dsh\dshplug\archive\dsh-pixel
Remove-Item C:\dsh\dshplug\_stage-pixel-archive -Recurse
```

**结果**（2026-11-16 实测）：

- `archive\dsh-pixel\` ≡ 组装时的内容，`source\` 49 个文件、`legacy\` 43 个文件；
- 移动后重算两个产物的 SHA256，与 §5 一致：
  - `.tgz` `0DBEEF44…4A2` ✓
  - `.zip` `DC0EB4E2…706` ✓
