# dsh-larkcli · ADR（为什么）

| 文档 | 回答什么 | 什么时候读 |
|---|---|---|
| [README.md](README.md) | **怎么用**：工具、面板、多账户、例子 | 想用它做点什么 |
| [BOOTSTRAP.md](BOOTSTRAP.md) | **怎么做**：安装、验证、排错、换机、升级 | 装不上 / 坏了 / 换机器 |
| **ADR.md**（本文） | **为什么**：决策 + 反面代价 + 已否决方案 | 想改设计、或质疑某个选择 |

日期：2026-11-16 ｜ 版本：0.1.0

> 每条都写四段：**结论 → 理由 → 反面代价 → 已否决的替代方案**。
> 「反面代价」不是免责声明，是让你知道将来什么地方会疼。

---

## ADR-001：不并入 `feishu-bridge`，只做「读/写内容」

**结论**：`default-workspace\feishu-bridge` 原样保留，`DSH-Feishu-Bridge` 计划任务不动。
本插件只管 Agent 读写飞书线上内容。

**理由**：两者是不同东西 —— 一个是**聊天通道**（长连接收消息、审批卡片、机器人对话），
一个是**内容访问**（拉群历史、读文档、写多维表格）。把长连接塞进插件会让工具层启动即依赖网络与常驻进程，
失败面完全不同。

**反面代价**：用户要装两套、配两处。而且「Agent 收到飞书消息」和「Agent 去查飞书消息」
在体验上会显得割裂。将来若要统一，得先决定谁吞谁。

**已否决**：把 bridge 的能力并进来（否决原因：范围爆炸，且 bridge 已有的稳定形态会被打断）；
或用本插件替代 bridge（否决原因：lark-cli 是请求-响应模型，不是长连接订阅模型）。

---

## ADR-002：只支持 Windows，不抽象跨平台

**结论**：二进制固定取 `windows-amd64`，路径按 Windows 处理，不做 macOS/Linux 分支。

**理由**：用户明确「这个只解决 Windows 下 DSH 工作需要的能力」。跨平台抽象会让每个路径/进程细节
都多一个分支，而现在一个都用不上。

**反面代价**：换 Mac 就完全不能用（连 `toPosix` 之外的部分都不是为 POSIX 写的）。
官方 CLI 本身跨平台，所以将来真要移植，**上层 `core.js` 还能用，`service.js` 的 spawn 部分要改**。

**已否决**：用 `process.platform` 分流（否决原因：没有第二个平台可测，等于写不可验证的代码）。

---

## ADR-003：多账户 = 每账户独立 App + 独立 configDir

**结论**：一个「账户」= 一份 appId/secret + 一个独立 `LARKSUITE_CLI_CONFIG_DIR` + 独立 user 授权。
描述/标签/是否默认挂在账户上。

**理由**：用户确认过「每账户独立 App + 独立 user 登录」。这也是唯一能真正隔离的方式 ——
`lark-cli` 的配置目录里既有 app 凭据又有用户 token，共用目录就必然互相覆盖。

**反面代价**：
- 一个飞书工作区要读，就得在开放平台建/复用一个应用并拿它的 secret；多账户 = 多份 secret 要维护。
- 磁盘上 N 份 `appsecret.txt`，泄露面乘以 N（都是明文，靠「仓库外 + 不进 git」兜）。
- 同一台机器上 token 刷新互不影响，但也意味着**授权要逐个做**，不能一次搞定。

**已否决**：
- 同一 App 下多 user 授权（否决原因：描述只能描述「人」，无法描述应用/权限范围，
  而用户要的正是「按任务搜某个授权」）。
- 两层模型（账户下再分身份）（否决原因：工具参数与登记表复杂度翻倍，当前没有这个需求）。

---

## ADR-004：账户匹配在本地做，不调飞书、不喂全量描述给模型

**结论**：`lark_account_search` 读本地 `accounts.json`，按「标签 6 / 名称 4 / id 3 / 描述 1」
加权打分，返回 top 1–3 + 命中理由。中文额外生成 CJK bigram。

**理由**：这是「增加速度降低消耗」的核心。三种替代都更贵：调飞书（花配额、要网络）、
向量检索（要嵌入依赖，违背「不装系统 Node」）、把全部描述塞给模型（账户一多吃 token，
且与「降低消耗」直接矛盾）。

**反面代价**：
- **匹配质量取决于人写的描述与标签**。写得敷衍就会选错账户。缓解：面板里把「描述」标成必填语义、
  `lark_account_search` 无匹配时明说「没有明显匹配」而不是硬选一个。
- 关键词匹配不懂同义词：「周报」不会命中「weekly report」。缓解：同义词靠 tags 手工补。
- 打分是启发式的，阈值没有理论依据，是调出来的。

**已否决**：向量/语义检索（依赖重）；LLM 选账户（多一次往返，与目标相反）；
固定别名 + 默认账户（任务→账户映射要人肉记）。

---

## ADR-005：`config.json` 由代码按本机路径现算生成，绝不提交

**结论**：`lark-cli` 的 `config.json` 不放在插件目录里维护，而是每次调用前由
`syncCliConfig()` 按「本机数据目录 + 账户」生成；内容没变就不重写。

**理由**：这是**真实事故**的直接修复。迁移到 `dshplug` 后，旧 `config.json` 里写着
`C:/dsh/dsh-larkcli/.../appsecret.txt`，而那个目录已被删除，于是 `auth status` 直接报
`failed to read secret file ... The system cannot find the path specified`。
只改字符串是治标 —— 下次 clone 到 `D:\` 或换机器又会断。
`lark-cli` 的 `appSecret.id` **必须是绝对路径**（实测相对路径也报找不到文件），
所以只能由运行时代码推导。

**反面代价**：
- `config.json` 变成生成物，**手改会被覆盖**（面板里已明确写「不要手改」）。
- 「凭据在哪」不再是 `git clone` 后一眼可见的，要查数据目录（`lark_doctor` 会打出来）。
- 每账户一份 config，账户多时是 N 个小文件。

**已否决**：
- 继续在插件目录维护 `_native-config`（否决原因：就是这次事故的形态）。
- 用相对路径（否决原因：实测报 `open appsecret.txt: The system cannot find the file specified`）。
- 用系统 keychain（否决原因：Windows 沙箱/服务账户下报
  `keychain unavailable ... Access is denied`）。

---

## ADR-006：9 个工具，而不是 200 个命令

**结论**：只注册 9 个工具；命令空间靠 `lark_call`（通用执行）+ `lark_schema`（自省）覆盖。

**理由**：工具 schema **每轮都进上下文**。把 256 个 API 方法各注册一个工具，等于每轮白烧
几十 k token，且模型选工具的准确率会下降。通用执行 + 按需自省是两头省。

**反面代价**：
- 模型必须知道参数才能调 `lark_call`，比「点一个工具」多一步；靠 `lark_schema` 补，
  但那本身也是一次调用。
- `lark_call` 的入参是自由数组，**没有 schema 级校验**，只能靠运行时报错（已加两条守卫：
  拒绝交互式 `auth login` 与 `config init`）。
- 不如专用工具「顺手」：以后若发现某类调用高频且参数固定，值得升级成专用工具。

**已否决**：每命令一个工具（token 爆炸）；只给 CLI 让人手敲（模型用不了，且每次要过 PowerShell）。

---

## ADR-007：输出用「重定向到临时文件」而不是管道捕获

**结论**：`spawn` 的 stdout/stderr 指向临时文件描述符（`stdio: ['ignore', fd, fd]`），
结束后读文件、删文件。

**理由**：实测在 DSH 的受限执行环境里，**管道捕获会被拒**：

```
ResourceUnavailable: Access to the path '\\.\pipe\LOCAL\dotnet_...' is denied
```

而文件描述符重定向可以。真实 Host 进程两种都行 —— 所以选**两边都对**的那一种。
代价只是每个调用两次临时文件 IO（几 ms）。

**反面代价**：
- 需要 `os.tmpdir()` 可写（通常没问题）。
- 每个调用两个临时文件；异常路径若没清理会残留（已用 try/finally + 唯一 tag 命名降低风险）。
- 无法流式处理超大输出（但反正要截断）。

**已否决**：只用管道（在受限环境直接不可用）；把输出写进数据目录（会污染用户数据，
且并发时更难清理）。

---

## ADR-008：秘钥与 device_code 只写不读，永不回显

**结论**：`lark_account_set_secret` 是唯一接收 App Secret 的入口，返回值只报字节数与路径；
`device_code` 存进 `login-pending.json`，工具只报「长度 N」。所有返回文本过 `redactDeep()`。

**理由**：模型看到的东西会进会话日志。密钥一旦出现在工具输出里，就等于写进了历史记录。
`device_code` 同样是凭据 —— 10 分钟内可直接换成一个已授权的 user token。

**反面代价**：
- 用户没法在界面上「看一眼 secret 对不对」，只能靠 `lark_status` 间接验证。
- 排查「secret 是不是写错了」得重写一遍，而不是读出来比对。
- `redactDeep` 可能误伤正常字段（比如业务数据里叫 `token` 的计数字段），表现为值变成 `abcd…(20)`。

**已否决**：面板里填 secret（会让 secret 经过 HTTP 请求体与浏览器内存）；
返回时脱敏但保留前 6 位（泄漏面更大，收益很小）。

---

## ADR-009：`lark_status` 默认 brief + 60s TTL 缓存，detail 不进缓存

**结论**：缓存里只存**与 detail 无关的公共部分** + 原始 JSON；`detail` 在 `composeStatus()`
里按请求现拼。`statusTtlMs: 0` 表示**关缓存**（而不是永不过期）。

**理由**：这里踩过一个真实 bug（由 `test/tools.mjs` 抓出）：早先把「拼好的返回值」整个存进缓存，
于是先来一次 `brief` 就把缓存填成没有 `detail`，后来的 `full` 请求命中缓存**永远拿不到详细字段**。
另一个相关 bug：`statusTtlMs: 0` 被 `||` 当成假值而回落到 60000，与「0 = 不缓存」的文档矛盾。

**反面代价**：
- 缓存与 `detail` 解耦后，`raw` 一直留在缓存里（每账户几 KB），内存略多。
- 60s 内配置变更不会反映到 status（但 `auth login` 成功会 `invalidateStatus()`）。
- 用户可能对「为什么状态没变」困惑 —— 所以输出里明确写「（缓存，Ns 前取的；refresh=true 强制重取）」。

**已否决**：不缓存（每次 `lark_status` 都起进程，一轮对话里重复探测明显变慢）；
按 detail 分层建两个缓存条目（重复探测两次）。

---

## 附：实测数据（2026-11-16 本机）

| 项 | 值 |
|---|---|
| lark-cli 版本 | 1.0.99（官方 windows-amd64，SHA256 已校验） |
| `lark-cli schema` 全量 | 1,496,509 字节 / 256 方法 |
| `lark_schema` 索引（进上下文） | ≈ 6 KB（**约 250 倍压缩**） |
| `lark_schema method=` 单方法 | ≈ 2 KB |
| `auth status` | bot: ready / user: missing |
| `api GET /open-apis/bot/v3/info` | `app_name = DSH Agent` |
| `im +chat-list --as bot` | ok: true |
| 测试 | `run.mjs` 38 ✅ / `tools.mjs` 27 ✅ / client ✅ / smoke ✅ |

**已知平台事实**（实测，别再猜）：
- `lark-cli auth status --format json` 会报 `unknown flag`；该命令只认 `--json`。
- 直接写 `config.json` 的 `dpopMode` 不生效，必须 `lark-cli config set dpop disabled`。
- Windows 上每条命令 stderr 都有 DPoP key 锁警告，无害，已过滤。
