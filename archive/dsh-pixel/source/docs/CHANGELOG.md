# 版本记录

遵循 [语义化版本](https://semver.org/lang/zh-CN/)。0.x 阶段 minor 可以破坏兼容。

## 0.1.0

首个独立版本，从 `C:\dsh\mantaplugin` 迁入 `dshplug` 仓库并成为正式插件。

**加入**

- 左侧任务栏独立小应用（`main` 席位全宽面板 + `sidebar.panellist` 图标），取代原来的右侧标签页形态
- 作品库、8 色调色板、逐像素画布、指令框（`p` / `rect` / `fill` 三条坐标命令）
- 整数档导出：48 → 1008 px，最近邻，覆盖式重生成
- 对话框指令：自然语言请求经 `uiWorkspace.startSession` 送进当前会话，走正常工具链
- 宿主半零依赖 PNG 编码器（`node:zlib` + 手写 CRC32）
- 品牌外置为 `BRAND` 对象 + 文档 `slug`，插件本身不含 IP 硬编码
- 两套零依赖测试（宿主 + 客户端替身渲染）

**修正**

- 调色板选中态改为平面描边（`outline`），去掉立体阴影
- 对话改的调用顺序：`selectPanel(null)` 必须先于 `startSession`，否则提示词被静默丢弃
- 服务读取加护栏，缺失的服务降级而不是白屏

**迁移**

- 包名 `@local/dsh-manta-pixel` → `dsh-pixel`；目录名与包名一致，`list.json` 无需 `packageName` 桥接
- 宿主路由 `/dsh-manta` → `/dsh-pixel`
- 导出文件名前缀改为由文档 `slug` 决定，不再写死 `manta-mark`

**工具修正**

- `tools/exports.py` 改为从**当前** `manta-mark-48.png` 派生整档，实测导出前后 16 个文件哈希不变；此前它会先跑一遍 `asset_build.py` 的绘制，覆盖掉编辑器里定稿的主标记
- `tools/asset_build.py` 顶部标注：它是「重画」而不是「派生」，日常刷新不要用它；并去掉了会先生成再删除的 128/256/1024 尺寸
- 修掉 `slug` 声明在 `renderRgba` 里、`normalize` 读不到的 `slug is not defined`（导出必定 400）。这个 bug 是真实跑通线上路由时才暴露的，静态检查和单元测试都没抓到
