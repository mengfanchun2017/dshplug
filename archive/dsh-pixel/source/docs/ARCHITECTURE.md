# 架构

## 三个半，各管一段

```
浏览器半 (lib/client.js)          宿主半 (lib/index.js)          示例资产 (assets/)
  · 左侧小应用外壳                  · POST /dsh-pixel               · 48px 原生网格
  · 画布 / 调色板 / 指令框    →     · 整数档光栅化            →     · 16…1008 整档
  · 把 slug 附到文档上              · 零依赖 PNG 编码                · favicon / 头像 / 组合
        ↑                                                          
        └──────────── 读写作品库 ──────── 像素编辑器插件的 /dsh-pixel-studio
```

划界线只有一条：**谁能保证契约，谁就负责那一段**。

| 职责 | 归属 | 理由 |
|---|---|---|
| 作品存储、画布渲染、历史 | 像素编辑器插件 | 通用能力，与 IP 无关 |
| 档位几何、文件名、PNG 编码 | 本插件宿主半 | IP 契约，改档位只该改一处 |
| 品牌名、颜色语义、示例作品 | 本插件 | 换 IP 时唯一需要动的地方 |

宿主半**不读写**像素编辑器的存储。写入走它的 `save` op，读列表走它的 `list` op——两个插件不共享内存，只共享 HTTP 契约。

---

## 为什么是左侧小应用，不是右侧标签页

第一版做成了右侧侧栏的一个标签页。三个具体问题：

1. 画布被侧栏宽度裁死，像素在 300px 宽里根本看不清；
2. 它是个工具，不是当前对话的附属品，塞在对话旁边语义不对；
3. 换个对话就要重开一次，作品库的上下文随之丢失。

改成一个 `main` 席位的全宽面板后，这些问题一起消失：画布有整个宽度，左侧图标一点就回到上次的状态。右栏保留了一个快捷卡片，只是入口，不是主界面。

注册方式（`ctx.slots.inject` + `ctx.slots.register`）走的是核心 slots 注册表，不依赖任何第三方侧栏封装。这一点重要——本机装的某个第三方侧栏插件是坏的，依赖它的插件会连带失效。

---

## 左右两半怎么对上

三处必须同名：

```
package.json        name:            'dsh-pixel'
cordis.patch.yml    - id:            dsh-pixel
lib/index.js        export const name = 'dsh-pixel'
```

任何一处对不上，插件**静默不加载**——没有报错，只是没出现。`test/host.test.mjs` 专门断言这三处一致，就是为了让这种失败模式在提交前暴露。

Client 半的模块 id（`window.__ModuleLoader__.load({ id })`）是另一个字符串，应为包名；它是模块注册键，不参与上面那条规则。

---

## 两个客户端服务，一个顺序陷阱

工作台需要两件事：选中央面板、开一轮对话。它们分属两个服务：

| 需求 | 服务 | 调用 |
|---|---|---|
| 切到工作台 | `layout` | `selectPanel('dsh-pixel')` |
| 回到对话 | `layout` | `selectPanel(null)` |
| 带内容开一轮 | `uiWorkspace` | `startSession(undefined, { prompt, whenDraftExists: 'append' })` |

`startSession` 在 `uiWorkspace` 上，不在 `layout` 上——这是第一次实现时踩的坑。

**顺序不能反**：`selectPanel` 会中止 `startSession` 注册的待处理导航。先切面板再开会话，提示词会静默丢失（composer 是空的，控制台无错）。正确顺序是：

```js
openConversation();          // selectPanel(null) —— 先回到对话
workspace.startSession(...)  // 再开一轮，提示词才留得住
```

`test/client.test.mjs` 断言启动时 `selected` 与 `started` 都为空：注册本身不该有副作用，只有点击才该有。

---

## 服务读取要加护栏

Cordis 的 context 是代理：读未在 `inject` 里声明的服务键会**抛异常**，不是返回 undefined。而版本漂移（用户的 DSH 比插件新/旧）是常态。

所以每个服务读取都经过 `guardedService`：

```js
function guardedService(ctx, name) {
  try { return ctx.get(name) || null; } catch { return null; }
}
```

读不到就降级——对话改的那条路径会提示「已复制到剪贴板」而不是整个工作台白屏。一个可选服务的缺失不该毁掉主功能。

---

## 宿主半的零依赖 PNG 编码

`lib/index.js` 不 import 任何三方便宜库，PNG 是用 `node:zlib` + 手写 CRC32 编出来的。原因很实际：插件从 profile 的 `node_modules` 解析依赖，凭空多一个依赖就多一个装不上就整个插件不加载的风险。

编码器只做一件事：把 RGBA 字节按 filter 0 写成一帧 PNG。够用，且字节级可测（`test/host.test.mjs` 会走完 IHDR/IDAT/IEND 并 inflate 回去校验）。

---

## 状态放在哪

| 状态 | 位置 | 生命周期 |
|---|---|---|
| 作品（图层、调色板、行字符串） | 像素编辑器的存储 | 跨会话 |
| 当前选中的作品 / 颜色 / 缩放 | 组件内 `useState` | 页面存活期 |
| 导出产物 | `<工作区>/assets/mark/` | 落盘，可再生成 |

没有任何状态存在插件自己的模块作用域里，除了 `PIXEL_HOST`——那两个服务引用在 `apply` 时捕获一次，之后只读。
