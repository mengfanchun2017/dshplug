# 安装 / 卸载（中文速查）

这个包是**本机插件**（`@local/dsh-preview-editor`），不发布到任何注册表。它的作用是在右侧栏文档预览里**就地编辑并保存**工作区文本文件（代码、纯文本、配置、Markdown）。

**默认行为**：文件仍由平台自带的**代码 / 纯文本 / Markdown 查看器**打开，查看器菜单**最后一项**才是 `Edit`；选中 `Edit` 才进入编辑器。想让 `Edit` 恢复成默认查看器，在配置里写 `editableAsDefault: true`。编辑器自带行号栏、不可见字符标记（Tab、不断行空格、零宽字符、行尾多余空格等）和行尾标记（LF `↵` / CRLF `⏎`），并复用平台的语法高亮与 Markdown 渲染。

## 前提

- 目标机器上的 DeepSeek Harness 需要与验证过的版本结构一致（本包在 **0.2.1-rc.3** 上验证）。它依赖三件随 dsh 一起发布的东西：
  - 客户端包 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（提供文档预览的查看器注册与 slot）
  - 客户端包 `@deepseek-ai/dsh-client-ui-primitives`（提供语法高亮与 Markdown 渲染组件；缺失时插件仍可用，只是不高亮）
  - 主机侧服务 `connection` / `sandboxPolicy` / `sessions`（提供写入路由与沙箱策略）
  这些在 Desktop 版里都有；如果目标 dsh 缺了其中任何一项，插件会自己降级或拒绝写入，不会静默毁数据。

## 一、把包放到目标机器

从这台机器把整个目录复制过去（不要只复制 `client.js`；`cordis.patch.yml`、`package.json`、`locale/`、`icon.svg` 都要）：

```
源目录：C:\Users\franc\Documents\deepseek-harness\default-workspace\dsh-preview-editor\
打包件：C:\Users\franc\Documents\deepseek-harness\default-workspace\dist\local-dsh-preview-editor-1.0.5.zip
        （同目录的 `.tgz` 才是 `install_bundle` / `pnpm add` 直接吃的那一个）
```

解压到任意位置都可以，例如 `C:\dsh-plugins\dsh-preview-editor`。**路径不要放在要编辑的 workspace 里面也无所谓**，但建议放在一个稳定、不会被清理的位置——它会被 profile 以 `link:` 方式长期引用（指向这个目录，不是复制品）。

> 用 `link:` 安装时，`package.json` 的 `files` 字段不生效（链接的是整个目录）；只有打包分发时才靠 `files` 过滤。

## 二、安装（推荐：官方通道）

在**目标机器**的 DSH 会话里，让 agent 用插件管理工具安装这个目录：

```
plugin_manager  action: install_bundle
                target: C:\dsh-plugins\dsh-preview-editor     ← 包目录的绝对路径
```

`install_bundle` 会**自己完成**包安装和 bundle 选择（也就是写 profile 的依赖与 `dsh.profile.bundles`），不需要你手写 profile 文件、也不要在 profile 目录里跑 pnpm。返回结果里的 `application` / `warnings` 才算数：`applied` = 已生效，`restart-required` = 需要重启应用，`overridden` = 被更高优先级的层盖掉了。

> **替换一个已安装的包必须重启应用**（浏览器里的旧 JS 模块不会自动换）。新装一个 bundle 可能通过 HMR 直接生效，但页面通常仍需刷新一次。

## 三、安装（手动，等价做法）

如果目标环境没有 `plugin_manager`，手动做同样三件事（这台机器上就是这么装的）：

1. 编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`，在 `dependencies` 里加一行：

   ```json
   "@local/dsh-preview-editor": "link:C:/dsh-plugins/dsh-preview-editor"
   ```

   （Windows 路径写成正斜杠最稳。）

2. 同一个文件里，把 `"@local/dsh-preview-editor"` 追加到 `dsh.profile.bundles` 的**末尾**：

   ```json
   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-preview-editor"] } }
   ```

   顺序有意义：这个包靠 patch 往组合里 `insert` 一行，必须排在它要插到其后的包（`dsh-web-app`）之后。

3. **重启** DeepSeek Harness，然后在页面按 F5。

想少写文件的话，也可以用 CLI 让它转给 pnpm：

```
dsh plugin --profile <profile> add "link:C:/dsh-plugins/dsh-preview-editor"
```

（`dsh plugin` 只是把参数转给 profile 目录里的 pnpm；bundle 选择这一步仍要按第 2 条确认。）

## 四、卸载

官方通道：`plugin_manager` `remove_bundle`（`list_bundles` 会给出准确标识符）。

手动卸载：删掉 `dependencies` 里那一行、把 bundles 数组里的条目删掉，然后重启。命令行等价：

```
dsh plugin --profile <profile> remove @local/dsh-preview-editor
```

删除包目录本身不会影响已装状态，但下次启动会因链接失效而报错——所以两步一起做。

## 五、这台机器上的实际位置

| 内容 | 位置 |
|---|---|
| 插件源码（唯一真源） | `C:\Users\franc\Documents\deepseek-harness\default-workspace\dsh-preview-editor\` |
| 打包件 | `C:\Users\franc\Documents\deepseek-harness\default-workspace\dist\local-dsh-preview-editor-1.0.5.{tgz,zip}` |
| profile 依赖与 bundle 选择 | `C:\Users\franc\.dsh\profiles\desktop\package.json` |
| 安装时留下的备份 | `C:\Users\franc\.dsh\profiles\desktop\package.json.bak-preview-editor-20261027-095733` |
| 本插件的用法/排障技能 | `C:\Users\franc\.dsh\skill-manager\library\dsh-preview-editor\SKILL.md`（技能库中，非 `~/.dsh/skills`） |
| 官方插件开发技能（从 asar 取出后安装） | `C:\Users\franc\.dsh\skills\cordis-plugin-development\` |
| 运行中的 Web GUI | 端口每次启动都变（本轮为 `http://127.0.0.1:64874`）；跑 `verify-live.mjs` 时显式传当前 URL 或设 `DSH_WEB_URL` |

> `C:\Users\franc\.dsh\skills` 是**技能根**（官方 `dsh-skill-filesystem` 的根目录表里它是 rank 400 `user-dsh`，会被监视、免重启），**不是插件安装位置**：把插件包放进去不会被任何东西加载。插件靠 profile 的 `link:` 依赖 + `dsh.profile.bundles` 激活。
>
> 技能形状：目录 bundle `<name>/SKILL.md` 或平铺 `<name>.md`，**只扫一层**（嵌套的 `**/SKILL.md` 不认）；frontmatter 必填 kebab-case 的 `name` 与非空 `description`，且**第一行必须正好是 `---`**——首行有空行、BOM 之类的文件会被静默跳过（只留一条日志警告）。

profile 里那两处改动就这两个字段：

```json
"dependencies": { "@local/dsh-preview-editor": "link:C:/Users/franc/Documents/deepseek-harness/default-workspace/dsh-preview-editor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-preview-editor"] } }
```

## 六、装完怎么自查

在插件目录里跑（用 dsh 自带的 node）：

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" verify.mjs        # 离线 33 项：主机路由 + 客户端注册 + 渲染
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" verify-live.mjs  # 问运行中的应用是否在提供这个包
```

`verify-live.mjs` 通过 = 运行中的组合已经在提供这个包；它还会确认 `/api/dsh-preview-editor` 对浏览器以外返回 401（写入只认浏览器 cookie）。这两项通过仍然不等于"你看到的样子是对的"——渲染效果要你自己看一眼。

## 七、改配置

配置写在包目录的 `cordis.patch.yml` 里（`markdown` / `editableAsDefault` / `maxBytes` / `highlight` / `highlightMaxBytes` / `marks` / `marksMaxBytes` / `lineNumbers` / `extensions`）。**配置是行激活时读的**，改完要重启应用；页面刷新换不掉。详见 `README.md`。

编辑器默认带**行号栏**和**不可见字符标记**，两者都可以单独关掉：`lineNumbers: false` 去掉行号栏，`marks: false` 停止给不可见字符加底色、也不再画行尾标记，`marksMaxBytes` 是标记的大小上限（超过就在工具条上显示「无标记」）。行尾标记 `↵`/`⏎` 分别表示这个文件用的是 LF 还是 CRLF，文件末尾没有换行时显示 `∅`。`editableAsDefault`（默认 false）控制的是**查看器优先级**：false = 平台自带查看器为默认、`Edit` 在菜单最后；true = `Edit` 抢回默认。这些键的默认值就是所求，所以包里的行配置没有写它们。

> **1.0.4 修掉「选了 Edit 一片空白」，1.0.5 修正默认查看器顺序**：`rowCount(draft.text)` 在首次渲染（`draft.text` 还是 undefined）时抛错，导致 React 不提交任何 effect、读取永远不启动。现在 `rowCount` 容错、加载态返回可见提示，并加了「无 seed 渲染初始态」的回归测试。

> **1.0.5 关于「Edit 排最后」**：平台把「纯文本」硬编码追加到查看器菜单末尾（`candidates = [...matched, 纯文本]`），所以**纯文本永远是最后一项、不可更改**。本插件能保证的是：`Edit` 在「除纯文本外」的查看器里排最后。若想让 `Edit` 成为默认（最常见的真实诉求），设 `editableAsDefault: true` 比追菜单顺序有效。自检现为 36 项。