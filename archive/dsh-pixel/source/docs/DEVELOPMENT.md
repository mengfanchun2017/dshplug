# 开发指南

## 环境

不需要装任何东西。本机 DSH 自带 Node 与 Python：

| 用途 | 路径 |
|---|---|
| Node（跑测试） | `C:\Users\franc\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| Python（跑 `tools/`） | `...\dependencies\python\python.exe`（已带 Pillow） |

`node` **不在 PATH 上**，用完整路径或先把它加进去。

---

## 改完代码怎么生效

插件是 `link:`（目录 Junction）装进 profile 的，**改完即时生效**：

```
改 lib/*.js  →  浏览器刷新（Client 半）  /  完全退出重开 DSH（宿主半）
```

只有这三种情况要重新跑 `install.ps1`：新机器第一次装、增删插件、`list.json` 变了。

---

## 跑测试

```powershell
node test/run.mjs
```

| 套件 | 盯什么 |
|---|---|
| `host.test.mjs` | 档位数学、RGBA 块是否均匀、PNG 字节结构、三处名字一致、`list.json` 版本同步、资产尺寸合规 |
| `client.test.mjs` | 用替身 Context 跑一遍 `apply`，断言两个席位注册上去、组件渲染、启动时无副作用 |

两套都是零依赖的 Node 脚本，没有测试框架。这是刻意的：插件必须在**解析不到任何额外依赖**的 profile 里加载，测试环境也不该比生产环境宽松。

---

## 加一个档位

1. `lib/index.js` 的 `LADDER` 加数字（比如 `24` → 1152 px）
2. `lib/client.js` 的 `SCALES` 加同一个数字
3. `test/host.test.mjs` 的 `assert.deepEqual(LADDER, [...])` 同步
4. `docs/CONTRACT.md` 的表里补一行

`LADDER` 和 `SCALES` 是两份独立定义（宿主半和浏览器半不能互相 import），改一处漏一处会让导出按钮报「档位不合法」。测试里断言的是 `LADDER`，所以至少宿主半漏不了。

---

## 换一个 IP

插件里没有写死品牌，只有两处：

**1. `lib/client.js` 的 `BRAND`**

```js
var BRAND = {
	app: 'MANTA Studio',        // 界面标题、guide 卡片
	short: 'MANTA',             // 左侧图标 label、标签页标题
	assistant: 'MANTA 助手',    // 指令框提示、状态提示
	slug: 'manta-mark',         // 导出文件名前缀
	requestTag: '[MANTA Studio]',  // 送进对话的请求前缀
};
```

**2. `assets/`**：换成新 IP 的网格、调色板、整档产物。

几何逻辑（档位、PNG 编码、导出路由）不含品牌，不用动。

---

## 重新生成示例资产

两个脚本的职责不同，别混用：

```powershell
python tools\exports.py         # ← 日常用这个：从当前 48 主标记派生整档
python tools\asset_build.py     # ← 只在要换掉画本身时才用
```

| 脚本 | 做什么 | 什么时候用 |
|---|---|---|
| `exports.py` | 读现有 `manta-mark-48.png`，最近邻生成 96…1008，再加 512 社交画布 | 主标记改过（编辑器里改的也算），要刷新整档 |
| `asset_build.py` | 用脚本里那段绘制代码**重画**全部产物 | 只有当你就是要用脚本里的画替换掉现在这张 |

> **注意**：`asset_build.py` 会用脚本里的绘制覆盖 `manta-mark-48.png`。当前的正式主标记是在像素编辑器里定稿的，和脚本里的画**不是同一张**——误跑会把定稿冲掉。日常刷新一律用 `exports.py`，它是字节级无损的（实测导出后 16 个文件 SHA256 全不变）。

```powershell
# 校验导出是否无损：hash 前后应当完全相同
python tools\exports.py
node test\run.mjs
```

`tools/bridge.py` 用来和像素编辑器的作品库互推（`push` / `pull`），只在需要把示例作品导进编辑器时用。

---

## 提交与发版

本仓库**不自动提交**，一律显式推：

```powershell
& C:\dsh\dshplug\plugpush.ps1 dsh-pixel "改了什么"
& C:\dsh\dshplug\plugpush.ps1 dsh-pixel "v0.2.0" -Tag    # 打 <包名>-v<版本> 标签
```

`-Tag` 从 `package.json` 读版本号。版本号要改三处并保持一致：`package.json`、`lib/index.js` 的 `VERSION`、`list.json`。`host.test.mjs` 断言前两者相等，`list.json` 那条是断言 `entry.version === pkg.version`。

---

## 踩过的坑

| 现象 | 原因 | 修法 |
|---|---|---|
| 改了代码没生效 | 曾经用 `file:` 安装，pnpm 按文件硬链接，删了重建就断链 | 一律 `link:`，见 `install.ps1` 顶部注释 |
| 插件静默不加载 | `package.json` / `cordis.patch.yml` / `export const name` 三处名字不一致 | 测试里断言三处相等 |
| 对话改没反应 | `selectPanel` 中止了 `startSession` 注册的导航 | 先 `openConversation()` 再 `startSession()` |
| `ctx.inject is not a function` | 客户端 context 没有 `inject` 方法 | 用静态 `inject: [...]` 数组声明 |
| 读服务抛异常 | Cordis context 对未声明键抛错，不返回 undefined | 全部走 `guardedService` |
| CRLF 的 patch 被跳过 | `.gitattributes` 强制 LF | 别手改行尾 |
