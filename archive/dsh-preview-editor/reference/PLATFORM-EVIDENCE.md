# 平台侧证据摘录

这些不是本插件代码，是从 DSH 安装包（`app.asar`）里读出来的**平台源码/文档摘录**，
是 ADR-002 / ADR-003 的事实依据。**不要修改**，改了就没有证据价值了。

提取方法：`tools\asar-slice.cjs`

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$asar = "C:\Users\franc\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"
& $node tools\asar-slice.cjs $asar "<要找的字符串>" <前文字节> <后文字节> <最多几处>
```

---

## 1. 查看器候选列表：纯文本被无条件追加到末尾

包：`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` → `lib/client.js`

```js
// 纯文本兜底查看器的定义：注意 extensions 是空数组
const PLAIN_BODY_ID = '...';
function textBodyDefinition(title) {
  return {
    id: PLAIN_BODY_ID,
    extensions: [],        // ← 空数组：永不进入 matched
    ...
  };
}

// 候选列表的构造：matched 之后无条件接上纯文本
const candidates = [...matched, definitions.find((d) => d.id === PLAIN_BODY_ID)];
```

菜单渲染直接照抄这个顺序：

```js
candidates.length > 1 && jsx(Menu, {
  items: candidates.map((candidate) => ({ ... })),
})
```

**结论**：`纯文本` 永远是最后一项。插件无法越过它——这是 `ADR-002` 的全部依据。

---

## 2. 查看器排序算法：档位 → 后缀长度 → 注册顺序
```js
// 平台 matchingDocumentPreviews 的排序规则（伪代码，去掉不相关细节）
// rank: builtin = 0，其它档（extension / fallback）= 1
// 排序键：b.rank - a.rank || b.len - a.len || a.i - b.i
//   .rank ：档位（builtin 的 0 排在前）
//   .len  ：匹配到的扩展名后缀长度（更具体的后缀优先）
//   .i    ：注册顺序（先注册的在前）
```

**结论**：
- 想排到最后 → 用 `builtin` 档 + **最后注册**（本插件默认行为）。
- 想抢默认（排第一）→ 用 `extension` 档（`editableAsDefault: true`）。
- 没有 `order` 字段可以任意插入位置。

`tools\verify-viewer-order.mjs` 是这个算法的可执行复现，可以离线验证菜单顺序。

---

## 3. 头部动作插槽的能力边界

插件 `@deepseek-ai/dsh-client-ui-open-in-app` 的用法（`lib/client.js`）：

```js
ctx.slots.inject('sidebar.right.tab.document.actions', () =>
  ctx.slots.register({
    name: 'sidebar.right.tab.document.actions',
    ...
    inject: pathInjected,   // ← 只有 hooks / remote 回调
  })
);
```

平台向该插槽传的 owner props **只有 `absolutePath`**；`inject` face 只提供
hooks 与 remote 查询函数。**拿不到组件内部的 `actions.selected(tabId, rendererId)`**。

资源打开 API 的参数也只有行号：

```
ctx.sidebarRight.openResource(address, { params: { line } })
```

**结论**：无法用「头部按钮」切换 renderer。要做就得整套接管
`sidebar.right.pane.tab`（同 `key` + `priority: -10`），代价是失去平台全部查看器。
这就是 `ADR-002` 里「头部按钮」被否决的技术原因。

---

## 4. 配置读取时机

- `cordis.patch.yml` 的 `config:` 在**行激活（load）时**读取 → **改配置必须重启 App**。
- `client.js` 由浏览器每次请求现取 → **改代码只需刷新页面**。

---

## 5. 相关参考包位置

| 包 | 用途 |
|---|---|
| `dsh-client-ui-sidebar-documentpreview` | 本题主角：文档预览面板、查看器注册表、菜单 |
| `dsh-client-ui-open-in-app` | 「打开方式」的参考实现，`document.actions` 插槽的真实用法 |
| `dsh-document-preview` | `documentPreviews` 服务定义 |

源码在本机的工作区副本（可能已过期，以 `app.asar` 为准）：
`<工作区>\_tools\dshsrc\dsh-client-ui-sidebar-documentpreview\`
