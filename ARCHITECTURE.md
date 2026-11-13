# ARCHITECTURE · DSH 的三类可扩展对象：skill / MCP / AGENTS.md

> 写死快照：**2026-11-12**，本机 `FRANCIS-HOME-I7`，DSH `0.2.2-rc.1`，profile = `desktop`。
> 证据来源：`app.asar` 内各包 `README.md` 原文、`~/.dsh` 实测目录、`plugin_manager` 返回的 bundle 清单。
> 本文回答的是「这些东西到底存在哪、谁管、界面在哪」，不回答「怎么写一个插件」——
> 那看 `~/.dsh/skills/cordis-plugin-development/SKILL.md` 与 `BOOTSTRAP.md`。

---

## 0. 一句话对照

| 对象 | 本质 | 物理位置 | 管理入口 |
|---|---|---|---|
| **skill** | 一个带 YAML 头的 `SKILL.md`（+ 可选附件目录） | 5 个扫描根，见 §1 | 输入框 `/`，或 `skill` 工具 |
| **MCP server** | **一条 Cordis 配置行** | bundle 的 `cordis.patch.yml` | `plugin_manager` / 设置→插件 |
| **AGENTS.md** | 纯文本规则文件 | 用户全局 + 项目各级 | 自动注入，直接编辑 |

三者**都没有**独立的「设置页」。这是设计取向，不是缺失：
DSH 把可扩展性统一收敛到「文件 + Cordis 行」两层，界面只提供**调用**入口（斜杠命令）
和**插件**入口（插件管理页），不为每种扩展对象单独造 CRUD 界面。

---

## 1. skill：文件即配置，无注册表

### 1.1 扫描根与优先级

来自 `dsh-skill-filesystem` README 的原文表格：

| Rank | source | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | (`bundledSkillDir`) | `$DSH_BUNDLED_SKILL_DIR` |

- `projectRoot` = 最近一个含 `.git` 的祖先目录；**没有 `.git` 就用 cwd**。
- `dshHome` = `$DSH_HOME` 或 `~/.dsh`；其 `.system` 子目录被跳过。
- `agentsHome` = `$DSH_AGENTS_HOME` 或 `~/.agents`（本机不存在）。
- 本机 `$DSH_HOME=C:\Users\franc\.dsh`、`$DSH_PROFILE=desktop`（由 shell 环境实测）。

`watch: true`（默认）：目录变化会让 catalog 失效重建，**无需重启**。

### 1.2 只有 name + description 进上下文

`<available_skills>` 目录里每个技能只占一行。正文由 `skill` 工具按需加载，
返回 `{name, provider, resourceBase, content}`——`resourceBase` 决定附件（`references/`、
`templates/`）用什么路径去读。

> **重要区分**：技能目录**不是**插件目录。`~/.dsh/skills/<名>/` 里的
> `cordis-plugin-development`、`dsh-preview-editor`、`dsh-rag` 看着像插件名，
> 但它们只是**同名技能文档**（`SKILL.md` + `references/` + `templates/`），
> 和插件包本身是两份独立的东西。插件包在 `~/.dsh/profiles/desktop/node_modules/`
> 或 `link:` 指向的源码目录；技能是给模型看的说明文档。
> 同名不是冗余，是因为「这个插件的用法」本身值得写成可加载的技能。

### 1.3 本机实测：技能是从哪来的

2026-11-12 16:15 实测 `~/.dsh/skills/`：

| 技能 | 创建时间 | 判定来源 |
|---|---|---|
| `cordis-plugin-development` | 2026-10-27 15:39 | 外部 `skill-manager` 复制投放 |
| `dsh-rag` | 2026-10-27 15:33 | 同上；**插件包内没有 SKILL.md**，是独立文档 |
| `dsh-preview-editor` | 2026-10-27 15:33 | 同上；`SKILL.md` 于 11-12 15:40 重写过 |
| `office` 系 7 个 | 安装目录固定 | **bundled**，来自 `resources/runtime/office-skills/` |
| `diagnose-windows-sandbox-acl` | 安装目录固定 | bundled |

**关于「刚开会话看不到技能」**：那不是投影延迟。这三个目录从 2026-10-27 就在，
是 `skill-manager` 当时**一次性复制**进来的（见 §1.4，该工具已于 11-12 移除）。
当前它们已经是独立文件，归 DSH 原生扫描管，watch 只负责目录变化后重建 catalog。

### 1.4 已移除：`skill-manager`（2026-11-12）

`~/.dsh/skill-manager/`（`library/` + `workspaces.json` + `.skm-backups/`）
曾经存在，但用户已卸载，**已清理**：

- 目录已删（20 文件 / 41.8 KB），备份到 `C:\dsh\_trash-20261112-162348\skill-manager\`
- `dsh-synchub` 的 `skills` 同步面改为只扫 `skills`，去掉了 `skill-manager` 根与 `.skm-backups` 排除
- 四个 profile 的 `package.json` 本来就没有引用它，无插件依赖需剥离

**历史教训**：它当初把 `cordis-plugin-development` / `dsh-rag` / `dsh-preview-editor`
三个技能复制进 `~/.dsh/skills/`（复制，不是链接）。这些副本**独立存在**，
删除 skill-manager 后仍可正常工作，归 DSH 原生扫描管。
它在 `app.asar` 里搜 `skill-manager` / `SkillManager` / `skillManager` **全部零命中**——
从来就不是 DSH 核心组件。

---

## 2. MCP：一个 server = 一条 Cordis 行

### 2.1 没有全局 `mcp.json`

`dsh-mcp-client` README 原文：*"No server is enabled by default."*

不存在 Claude Desktop 那种集中式 `mcp.json`。全盘搜索 `.dsh` 后唯一的 `mcp`
命中是技能模板与备份。**这是设计，不是丢失。**

### 2.2 两种 transport

```yaml
# 纯配置 bundle：不需要 Host/Client 代码，只要 manifest + patch
- insert:
    - id: demo-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: demo                     # 必须唯一
        transport: streamable-http           # 或 stdio
        url: http://127.0.0.1:3000/mcp       # http 专用
        # headers: { Authorization: !!js "..." }   # 可选，见 §2.4
        failOnStartupError: true             # 别吞启动失败
```

stdio 用 `transport: stdio` + `command`（必须绝对路径）+ 可选 `args` / `env` / `cwd`。
协议版本由官方 SDK 协商（首选 `2026-07-28`，回退到受支持的旧修订）。

工具进入模型工具表时命名为 **`mcp__<serverName>__<tool>`**。
`dsh-mcp-resources` 行（在 `dsh-base` 里）负责共享的 resources 发现与读取。
MCP **prompt templates 不支持**。

### 2.3 另一条路：ACP / SDK 按会话传入

外部客户端走 `session/new` 请求的 `mcpServers[]`：

```js
ctx.buildSession({ cwd, mcpServers: [...] })   // 或 .withMcpServer(server)
```

ACP 侧只接受 stdio 与 http 两种 type，其余一律拒绝；`serverName` 会做规范化，
**规范化后重名直接报错**。

### 2.4 key 放哪：凭据库，不是配置文件

这是最容易踩的坑。`dsh-credentials-local` README 原文要点：

- 密钥存在 **`~/.dsh/.credentials.yaml`**，也可通过**配置 UI** 保存。
- 查找优先级（固定）：**存储文件 > 启动环境变量 > 项目 `.env` > harness-home `.env`**。
  新保存的值立刻覆盖旧的环境变量值。
- 改完**自动重载**，无需重启。
- 边界：文件只有本 OS 用户可读，但**agent 工具进程以同一用户运行，所以它挡不住 agent**。
  别把「加个 key」当成隔离手段。

因此 MCP 的 key 有两种写法，都不写进聊天或明文配置文件：

```yaml
# 写法 A：引用已有凭据名（凭据库 / 环境变量 / .env 都按上面的优先级解析）
headers:
  Authorization: !!js "`Bearer ${ctx.get('credentials').values['GITHUB_TOKEN']}`"

# 写法 B：让 dsh-mcp-client 直接读环境变量名
# 在 profile 的 cordis.patch.yml 里配 env 引用，真值仍留在凭据库里
```

模板 `references/mcp-bundle.md` 的原话是：
*"Ambient credentials are scrubbed; reference existing credentials with Loader `!!js`
rather than copying secrets into conversation text."*
——**环境里的键会被清洗掉**，必须显式用 `!!js` 引用。

### 2.5 在哪看当前连了哪些 MCP

没有任何列表页。三条路：

1. **`plugin_manager` → `list_plugins` / `list_bundles`**：看哪些 bundle 装了、
   哪一行是 `dsh-mcp-client`、它的 `config` 是什么。
2. **配置层直接读**：`~/.dsh/profiles/desktop/cordis.patch.yml`，
   搜 `mcp-client`。改动**必须重启 App**（`config:` 在行激活时读取）。
3. **模型侧**：工具表里出现 `mcp__*` 就说明连着；一个都没有就是空 caller scope。

**本机当前状态（2026-11-12 实测）**：`desktop` profile 的组合配置里
**没有任何 `mcp` 行** → 没连任何 MCP server。

---

## 3. AGENTS.md：注入式规则，平台不代写

### 3.1 文件名与位置

- 文件名是 **`AGENTS.md`**（复数、全大写），不是 `Agent.md`。
- 用户全局：`$DSH_HOME/AGENTS.md` 与 `<agentsHome>/AGENTS.md`。
- 项目链：**从项目根到 session cwd 的每一层**，只要存在候选文件就纳入，由宽到窄合并。
- 本机：[`~/.dsh/AGENTS.md`](../../Users/franc/.dsh/AGENTS.md) 存在（4061 字节）；
  `C:\dsh\base` 下**没有**（正常）；`C:\dsh\agent\AGENTS.md` 是那个 myagent 项目自带的。

### 3.2 加载时机

`dsh-agent-instructions` README：**首次请求**注入一条 durable baseline 消息，
包含用户全局链 + 项目链。**不持续监视外部编辑**——但成功的文件系统操作会
发现新出现的嵌套文件，让后续请求看到变化。

所以：改完 `AGENTS.md`，**新会话立即生效**；同一会话内改，可能要等一次文件操作才刷新
（本会话就观察到 `~/.dsh/AGENTS.md` 改动后被重新注入了一次）。

### 3.3 三条需记住的性质

1. **平台不会替你生成**。没有任何行/模板会写 `AGENTS.md`，它是纯用户资产。
2. **用户级 + 工作区级是串起来的**，不是二选一：先全局链，再项目链，逐层合并。
3. **工作区没有它完全正常**。想加就自己在项目根写一个，不需要登记到任何地方。

### 3.4 与 skill 的边界（别混）

| | AGENTS.md | skill |
|---|---|---|
| 加载 | 首轮**全文**注入 | 只目录里放 name+description，正文按需 |
| 粒度 | 会话级常驻规则 | 任务级流程 |
| 触发 | 自动 | `/` 或 `skill` 工具 |

两条都写才有意义：规则永远在场，流程按需取用，否则上下文会被流程文档撑爆。

---

## 4. 与本仓库（dshplug）的关系

| 东西 | 归谁 | 说明 |
|---|---|---|
| 插件源码 / 清单 | **本仓库**（`plugpush.ps1` 显式推） | 要版本、tag、可回滚 |
| 插件的**安装**（profile `package.json`） | `dsh-market` / `install.ps1` | `link:` 写死绝对路径 |
| 技能文件（`~/.dsh/skills/**`） | **`dsh-synchub`** | 一套引擎、一份历史 |
| 密钥 / 设备身份 / 运行时 / 缓存 | **谁都不管** | 泄露或失效风险，各机自造 |

> `dsh-synchub` **不同步** `profiles/desktop/package.json`——含 `link:C:/dsh/...`
> 绝对路径，跨机搬运会让 DSH 起不来。插件清单用 `install.ps1` 在每台机各自生成。

**MCP 配置的同步边界**：一条 MCP 行如果写在**本仓库某个插件的 `cordis.patch.yml`**里，
就会跟着 `plugpush` 走；如果直接手改 `profiles/desktop/cordis.patch.yml`，
它属于 `profileConfig` 同步面（caution 级）——**跨机前先看 baseURL/url 是不是环境特有的**。

---

## 5. 常见误解速查

| 你以为 | 实际 |
|---|---|
| 「skill 有个管理页」 | 没有。`/` 调用，文件管理 |
| 「MCP 有 mcp.json」 | 没有。一条 Cordis 行 |
| 「MCP key 填在设置里」 | 填凭据库 `~/.dsh/.credentials.yaml`，或 `!!js` 引用 |
| 「`.dsh` 在工作区下」 | 在 `$DSH_HOME`，本机 `C:\Users\franc\.dsh` |
| 「没有 Agent.md 是坏了」 | 文件名是 `AGENTS.md`，且在 `$DSH_HOME` 根 |
| 「skill 目录里有插件名 = 装了两次」 | 技能文档与插件包是两份东西 |
| 「刚开会话看不到技能 = 没装」 | 可能在 watch 投影中，稍等或刷新 |
