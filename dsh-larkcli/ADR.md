# dsh-larkcli · ADR（为什么）

| 文档 | 回答什么 | 什么时候读 |
|---|---|---|
| [README.md](README.md) | **怎么用**：工具、面板、多账户、例子 | 想用它做点什么 |
| [BOOTSTRAP.md](BOOTSTRAP.md) | **怎么做**：安装、验证、排错、换机、升级 | 装不上 / 坏了 / 换机器 |
| **ADR.md**（本文） | **为什么**：决策 + 反面代价 + 已否决方案 | 想改设计、或质疑某个选择 |

日期：2026-11-21 ｜ 版本：0.2.0

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

## ADR-006：工具数控制在 13 个，而不是 200 个命令

**结论**：只注册 13 个工具；命令空间靠 `lark_call`（通用执行）+ `lark_schema`（自省）覆盖。
v0.2.0 从 9 个加到 13 个（`lark_install` / `lark_identity` / `lark_scopes` / `lark_read_doc`），
因为它们回答的是**四个无法用 lark_call 表达的问题**（见下）。

**理由**：工具 schema **每轮都进上下文**。把 256 个 API 方法各注册一个工具，等于每轮白烧
几十 k token，且模型选工具的准确率会下降。通用执行 + 按需自省是两头省。

**反面代价**：
- 模型必须知道参数才能调 `lark_call`，比「点一个工具」多一步；靠 `lark_schema` 补，
  但那本身也是一次调用。
- `lark_call` 的入参是自由数组，**没有 schema 级校验**，只能靠运行时报错（已加两条守卫：
  拒绝交互式 `auth login` 与 `config init`）。
- 不如专用工具「顺手」：以后若发现某类调用高频且参数固定，值得升级成专用工具。

**为什么这 4 个不能归给 `lark_call`**（否则就是「为什么不把它们也合成一个工具」的反质疑）：

| 新工具 | 它做的事 | `lark_call` 为什么做不了 |
|---|---|---|
| `lark_install` | HTTP 下载 + SHA256 + 原子替换 | 不是 CLI 命令，是**管理 CLI 本体** |
| `lark_identity` | 三个 API 拼出「这个 app 叫什么、谁建的、什么用户」 | 调 CLI 能拿到原始 JSON，但“拼成人看得懂的”是逻辑 |
| `lark_scopes` | 本地比对 256 个方法的 scope 与已给权限 | 纯本地计算 + schema 缓存，**零 API** |
| `lark_read_doc` | 解析链接 → 多账户依次试 → 逐步降级 | 需循环、重试判定与降级策略，多步编排 |

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

## ADR-010：自己实现装/升级，不用 fetch 脚本也不用 npm 包

**结论**：`lib/install.js` 自己完成「查版本 → 下载 → 校 SHA256 → 解压探活 → 原子替换 → 同步文档」，
对外只暴露两个动作：`lark_install action="check"` 与 `action="install"`；面板上对应「检查更新」/「升级」。

**理由**：

1. v0.1.0 的 `fetch-lark-cli.ps1` 把版本 `1.0.99` 和 SHA256 **写死**在脚本里。
   每出新版都要改代码 + 提交 + 重启，而且忘了改就会「显示最新、实际旧版」——比没有升级功能更危险。
2. 官方没有 npm 包，只能下载 zip。那就必须在代码里做焦校验，不能靠人。
3. **SHA256 拿不到就拒装**。`checksumFor()` 返回空字符串时直接报错，不“没校验也装”。
   宁可装不上，也不要静静地装一个未校验的 15 MB 二进制。
4. **原子替换**。新 exe 先落到 staging 目录并探活 `--version` 对得上，才 rename 就位；
   旧 exe rename 成 `.old-<ts>` 而不是删，失败可回滚。
5. **只走 npmmirror**。本机 GitHub 直连 `ECONNRESET` / `CRYPT_E_REVOCATION_OFFLINE`，
   走 GitHub 的升级链路在目标环境里本就不成立。

**反面代价**：

- npmmirror 挂了就升不了。没有官方 CDN 备用（GitHub 不可达），只能等。
- 依赖 npmmirror 的目录 JSON 格式与 checksums 文件布局；对方改格式就要跟版。
- 「拿不到 SHA256 就拒装」意味着镜像同步滞后时（有 zip 没 checksum）会装不上——这是故意的。
- 升级后宿主半缓存了版本号，**必须重启 DSH**，不是刷页面。

**已否决**：

- 继续用写死版本号的 PS 脚本（两个数字要人跟，必错）。
- 走 GitHub Releases（本机网络不可达）。
- 把 exe 提交进 git（15 MB 二进制入库，每次升级一个 commit）。
- “先装再校”的宽松模式（宁可装不上，也不要未校验）。

---

## ADR-011：权限清单拆「应用侧 / 用户侧」，且默认只读

**结论**：`lib/scopes.js` 把权限需求分成三个档位（`read` 21 条 / `standard` 123 条 / `full` 145 条），
默认展示 `read`；每条 scope 同时算「租户侧需不需要」与「用户侧需不需要」，两边分别给行动。

**理由**：

1. 用户原话：「权限要清晰全面，直接弹出只用点确认」。
   所以应用侧给一条**预填好的** `https://open.feishu.cn/page/scope-apply?clientID=<appId>&scopes=...`，
   打开就是勾好的状态（实测 200，`%2C` 与 `%20` 分隔符都行）。
2. **应用侧与用户侧不是同一件事**：租户级（`tenant`）权限去开放平台申请 + 发布版本才生效，
   用户授权（设备流）对它没用；用户级（`user`）权限又必须走设备流。
   混在一起曾导致 `userMissing` 虚高约 2 倍（把只需要 tenant 的也归给用户）。
3. **默认只读**：一上来列 145 条会把人吓退，而查文档/表格/消息只需要 `read` 那 21 条。
4. **平台数据优先于 schema**：先看应用实际已给什么（`appScopes`），schema 只用来补漏；
   纯靠 schema 推断会把“平台本来就给了”的算成缺。

**反面代价**：

- 域词表（`--domain`）与 scope 前缀**是两套不相交的词汇**（`docs` vs `docs:`/`docx:`/`space:`），
  当下游再增加域时，`SCOPE_PREFIX_LABELS` 得手工跟。
- 改完权限还得去开放平台「创建版本并发布」，插件无法代劳，只能提醒。
- 档位是一刀切的域名组合，个人想「只要文档不要通讯录」时没有粒度控件（只能自己传 `domains`）。

**已否决**：

- 只列 scope 字符串不给链接（用户还得自己逐条勾，正是用户不想干的事）。
- 一个「全部权限」按钮（默认点了就多要 124 条，过度授权）。
- 用 `auth login --recommend` 自动决定（它按域名推，与本插件的档位概念对不上）。

---

## ADR-012：给链接就读，账户由 resolver 自动选

**结论**：`lark_read_doc url="<链接>"` 不要求指定账户。`lib/resolver.js` 解析链接类型，
然后从「有 secret 的账户」池里依次试，遇到不可重试错误就停。

**理由**：

1. 用户原话：「认证后查询飞书文档从认证池中依次进行（给你链接，你就去查，不用说明是哪个账号）」。
   让模型先问“哪个账户”再读，等于把多账户的复杂度推给用户。
2. **可用性判定用 `identities.user.available`，不是 `tokenStatus`**。
   这是 ccconfig 的结论：`tokenStatus` 会在未授权时显示看似正常的值。
3. **区分可重试与不可重试**：`3380002 Invalid document_id` 这种重试 10 次也没用，必须停；
   而「该账户没权限 / 网络抖」换下一个账户可能就成。不分就会白发 N 次请求。
4. 链接种类自动识别（docx / wiki / sheets / base / slides），不让人先告诉模型「这是知识库链接」。

**反面代价**：

- 试错成本：N 个账户都无权限时会跑 N 次请求才报错。
- 链接里的 token 在 wiki 场景下是 `wiki` 节点，需要额外一次解析才能拿到真实 obj_token；多一跳。
- 不指定账户就无法保证用「哪个身份」读，审计上不如显式指定清楚。

**已否决**：

- 要求必须传 `account`（把选择成本推回给用户）。
- 全账户并发试（对飞书 API 不友好，而且 90% 情况第一个就成）。
- 用 `tokenStatus` 判可用性（会误报）。

---

## ADR-013：二维码写到 temp，不写账户目录

**结论**：`loginQrcode()` 用 `fs.mkdtempSync(os.tmpdir())` 建一次性目录，`--output` 与 `cwd` **同时**指向它，
`run()` 新增 `cwd` 覆盖项。HTTP 路由把 PNG 回了之后立即 `rm -rf` 那个目录。

**理由**：

1. **原实现必定 100% 失败**。它把 PNG 写到 `ap.dir`，而 `ap.dir` 就是 `LARKSUITE_CLI_CONFIG_DIR`，
   CLI 对 `--output` 有两条硬规矩，第二条是「不能落在配置目录里（受保护 denylist）」。
   实测报错原文：`unsafe output path ... is inside the CLI config directory, which is protected`。
2. 而 `run()` 的 `cwd` 也硬编码为 `ap.dir`——这条同样被禁区限制，光改 `--output` 不够，两个都得换。
3. 二维码是**一次性**的：每次 `auth login` 的 `flow_id` 不同，旧码扫了只会报错。留在 temp 里只会积垃圾。

**反面代价**：

- 多一次 `mkdtemp` / 删目录的开销（毫秒级，可忽略）。
- 二维码生成失败时临时目录得手动收（已加 `catch` 里 `rmSync`）。
- 换了 cwd 后 CLI 靠 `LARKSUITE_CLI_CONFIG_DIR` 环境变量找配置，而不是相对 cwd —— 这是**隐式依赖**，
  以后若有命令改成“相对 cwd 找 config”，这条会碎。

**已否决**：

- 把二维码写成 base64 内联回面板（省一个路由，但每次都重新生成、无法用 304，且面板代码变肥）。
- 写到 `ap.files/` 子目录（CLI 说是允许根之一，但仍在配置目录之下，实测依旧被拒）。
- ASCII 二维码（`--ascii`）：在会话里能看，但在设置面板的 `<pre>` 里字宽不对齐，扫不出来。

---

## ADR-014：token 状态默认报「存在」，要「有效」得显式验

**结论**：`status()` 新增 `verify` 参数，走 `auth status --verify`；
`verify=true` **绕过 TTL 缓存**，且不进缓存。面板默认只显示「存在（未验证）」，
点「验证 token」/ `lark_identity verify=true` 才打服务端（实测 ~1.1s/账户）。

**理由**：

1. 用户要求「token 状态」，但 `auth status` 不带 `--verify` 时**根本没验过**，
   它说的 `available: true` 只是“本地有份 token 文件”。把它展示成“有效”就是假绿。
2. `--verify` 是唯一会真的访问服务端、并在返回体里多给 `verified/openId/appName` 的模式。
3. 缓存与验真天然矛盾：把“刚才验过有效”缓存 60 秒，就会把刚过期的 token 报成有效。

**反面代价**：

- 不验时面板文字比“已连接”丑一点（「存在（未验证）」），但这是诚实的价格。
- 验一次多 1.1 秒，多账户时是线性叠加，所以默认关。

**已否决**：

- 每次 `status` 都带 `--verify`（面板首帧 +1.1s×N，体验崩）。
- 把 `--verify` 的结果也缓存（会把过期结论当新鲜的）。
- 不展示 token 状态（不满足目标②）。

---

## ADR-015：设备流第二步必须在面板里完成（时延模型已被 ADR-017 修订）

> **状态：部分被 ADR-017 取代**。仍然成立：必须有面板内路由与按钮、`timedOut` 必须与真错误分开、
> 超时文案必须是「还没检测到你确认」而不是报错。被取代：默认 30s 与「不许轮询」。


**结论**：新增 `POST /plugins/larkcli/login-finish` 路由，面板加「我已完成授权」按钮；
`loginFinish()` 默认 `timeoutMs = 30000`，`run()` 超时时透出 `timedOut: true`，
超时的文案是「还没检测到你确认授权」而不是报错。

**理由**：

1. 原先第二步只能调会话里的 `lark_login_finish` 工具 —— 用户刚在手机/浏览器点完同意，
   还得切回聊天窗敲一句“我授权完了”，这是目标④「尽量零点击」里最膈应人的一跳。
2. 更糟的是 `auth login --device-code` 是**长轮询**：用户还没点确认时它不报错，而是挂在那里等。
   原先 180s 超时，意味着面板点一下「我已完成授权」就卡三分钟，用户以为死机。
   实测：30s 超时后返回「还没检测到你确认授权」，重叠后重试即可。
3. `timedOut` 必须与真错误分开：长轮询超时是“还没好”，不是“坏了”，两者给用户的下一步完全不同。

**反面代价**：

- 30s 对一些慢一点的手机会不够，用户得点第二次（device_code 在 10 分钟内仍有效，无副作用）。
- 多一条路由就多一个攻击面：已纳入 `guard()`（loopback + 同源）与 POST-only 约束。

**已否决**：

- 保留 180s（面板卡三分钟，体验崩）。
- ~~面板轮询 `login-finish`（会把 device_code 反复拿去兑换，而兑换是**一次性**的，第二次必败）~~
  —— **这条否决理由已被实测推翻**，见 ADR-017。「一次性」只对**兑换成功之后**成立；
  未确认状态下的重复兑换是幂等的（实测连试 3 次，都是同样的超时，`pending` 均保留）。
- 只靠工具、不给按钮（不满足目标④的“零点击”）。
---
## ADR-016：浏览器半的 `inject` 必须穷举 `apply` 里用到的服务

**结论**：`lib/client.js` 的 `inject` 从 `['slots']` 改为 `['slots', 'locale']`；
`test/client.mjs` 增加一条**静态守卫**：从源码剔掉注释与字符串字面量后，
把所有 `ctx.xxx` 抽出来逐个比对 `inject`，缺一个就红。

**理由**：

1. 0.2.0 发布后现象是「**设置里完全没有 Mlarkcli**，但工具能用、HTTP 路由全部 200」。
   这组现象极易被误判成「没重启」或「缓存」，实际是浏览器半**根本没注册**。
2. 根因是 Cordis 的依赖注入语义：`ctx` 上只有 `inject` 声明过的服务。
   `apply` 里写了 `ctx.locale.register(...)`，而 `inject` 只有 `['slots']`
   → `ctx.locale` 是 `undefined` → 首行抛 `TypeError: Cannot read properties of undefined (reading 'register')`。
3. 这个错误**不会让任何东西变红**：宿主半照常工作、控制台干净、无 toast。
   打桩复现（只把已声明的服务放上 ctx）：
   `漏声明 locale: TypeError: Cannot read properties of undefined (reading 'register')` / `声明 [slots,locale]: apply 正常完成`。
4. 原测试没抓到，是因为 `test/client.mjs` 手搓的 `fakeCtx` **无条件带了 locale**，
   等于把被验证的约束自己给放宽了。守卫改成从源码抽真用法，不依赖测试作者的记忆。

**反面代价**：

- 静态守卫会误判 —— 注释/字符串里出现的 `ctx.xxx` 会被当成真用法，
  所以必须先剥注释与字符串字面量（初版就是被自己注释里的 `ctx.xxx` 扫红的）。
- 守卫只能查「声明了没用」，查不了「用了但拼错服务名」（拼错时两边都不匹配，仍需打桩跑真 apply）。

**已否决**：

- 只把 `['slots']` 改成 `['slots','locale']` 了事：同一类错误下次换个服务还会再犯，且依旧静默。
- 改成 `inject: ['*']` 全量注入：Cordis 不支持通配，且就算支持也丢掉了「依赖即声明」的可见性。
- 让 `apply` 里 `ctx.locale?.register` 可选链兜底：会让面板静默失去翻译（导航栏显示 key 而非名字），把错误变成更难查的半坏状态。

---
## 附：实测数据（2026-11-21 本机）

| 项 | 值 |
|---|---|
| lark-cli 版本 | **1.0.100**（官方 windows-amd64，SHA256 已校验） |
| 升级实测 | `1.0.99 → 1.0.100` 成功，15,130,031 B，`93118ca1...1d8d`，原子替换 |
| `lark-cli schema` 全量 | **1,571,017** 字节 / 256 方法 |
| `lark_schema` 索引（进上下文） | ≈ 6 KB（**约 260 倍压缩**） |
| `lark_schema method=` 单方法 | ≈ 2 KB |
| `auth status` | bot: ready / user: missing |
| 应用名 | **DSH Agent**（appId `cli_aa540f3569fadcfb`，activateStatus=2 已发布） |
| 应用已开通权限 | 38 条 |
| 权限缺口（`read` 档） | 应用缺 1 / 用户缺 17（共 9 个域分组） |
| `api GET /open-apis/bot/v3/info` | `app_name = DSH Agent` |
| `im +chat-list --as bot` | ok: true |
| 测试 | `run.mjs` 38 ✅ / `tools.mjs` 27 ✅ / `client.mjs` ✅ / `smoke.mjs` ✅ / `v2.mjs` 76 ✅ / `activate.mjs` ✅ |
| HTTP 路由 | 10 条（2026-11-21 新增 `/qrcode`、`/login-finish`） |
| `auth status --verify` | 1137ms，多返回 `verified:true` + bot `openId` / `appName` |
| 二维码 PNG | 871 字节（真实 flow）| 416 字节（无效 URL 占位） |
| 浏览器半 `apply` 打桩（2026-11-22） | 只给 `inject` 声明的服务时：`['slots']` → `TypeError: Cannot read properties of undefined (reading 'register')`；`['slots','locale']` → 正常完成并注册 `settings.section` id=`larkcli` order=202 |
| 静态守卫扫到的 `ctx.*` | `locale` / `slots`（剥注释与字符串后），无杂音 |
| 工具数（从 `apply` 真实注册数出） | **13**（`lark_status` … `lark_read_doc`） |
| `install.ps1 -Check` | `dsh-larkcli v0.2.1 status=active link-junction`，全部为 link: 形态 |

**已知平台事实**（实测，别再猜）：
- `lark-cli auth status --format json` 会报 `unknown flag`；该命令只认 `--json`。
- 直接写 `config.json` 的 `dpopMode` 不生效，必须 `lark-cli config set dpop disabled`。
- Windows 上每条命令 stderr 都有 DPoP key 锁警告，无害，已过滤。
---
## ADR-017：授权一次开全、发起后自动轮询、面板标题用显示名

**结论**：三件一起改。

1. **一次开全**：`login` 默认传 `domains: 'all'`（CLI 的 `--domain all` = 全部已知业务域），
   不再只申请 docs/drive/sheets 这几个。
2. **发起后自动轮询**：`auth login` 成功后起一个 4s 间隔的轮询，每轮用 `timeoutMs=5000`
   调 `login-finish`；拿到 `ok` 就停轮询、自动拉身份、通知父级刷新；10 分钟硬上限。
3. **标题用显示名**：卡片大字显示 `acc.label`（没设则回退 `id`），技术 `id + appId`
   降为第二行小字；按钮文案从「编辑描述/标签」改为「改名 / 描述 / 标签」。

**理由**（全部来自用户原话）：

1. 「机器人的和用户的授权如果都需要你就一次都开开」
   —— bot 侧 scope 靠开发者后台，user 侧靠 `auth login`。分两次只会让人困惑该点哪个；
   `auth login` 的 scope 是**增量累积**的，一次 `--domain all` 就把 user 侧一次性铺满，
   以后再补也不需要重来。
2. 「我点击了 user 身份授权，到网页授权完成了，但是这里没有刷新，还是 user 未授权状态」
   —— 这是真 bug，不是缓存：光在浏览器点「同意」**不会**让 CLI 侧变成已授权，
   必须有人拿 `device_code` 去兑换。原先只能靠用户点按钮或回会话敲命令，
   所以「自动刷新」的真实含义是「自动**兑换**并刷新」，否则等到天荒地老也不会变。
3. 「是否应该加个自动刷新或者手动刷新按钮」
   —— 两者都要。自动轮询只在本次会话发起过授权时跑；跨机/隔天/改了后台权限这些场景
   只剩手动入口，所以再加一个常驻的「刷新状态」。
4. 「上面写的 default 是说 default 用户么，我没有看到有改名字的地方」
   —— `default` 是配置目录 id，不是人名。拿 id 当标题 + 改名藏在二级按钮里，
   两件事叠加就成了「这到底是啥、我在哪改名」。

**关键实测（这条决定了轮询能不能做）**：

- 同一个未确认的 `device_code` 连续兑换 3 次，3 次均返回同样的超时、`pending` 均保留；
  即**未确认时重复兑换是幂等的**。ADR-015 当初「第二次必败」的判断是错的。
- `loginFinish({timeoutMs:4000})` 实测 4027ms 返回 → 短超时可用，不会把面板卡住。
- **但 timeoutMs 是 0.2.2 新增的宿主参数**：宿主半没重启时它会忽略这个字段、仍按 30s 长轮询
  （实测传 3000 仍耗时 30021ms，就是因为运行中的主机进程还是旧代码）。
  所以轮询间隔做成**自适应**`max(4s, 本轮实际耗时)`，不写死 4s ——
  否则旧宿主下每个请求占 30s，4s 排程会让兑换请求不断堆积。
- 超时不会删 `pending`（`service` 只在 `r.ok` 时 unlink），所以短超时是安全的。

**反面代价**：

- 自适应间隔让旧宿主下自动退为约 34s 一轮（不报错、不堆积，但慢一点）。量上不是零成本：
  活跃授权窗口内每轮一个子进程，但总时长本就 10 分钟封顶。
- `--domain all` 会让授权页列出更多权限项，用户可能被吓到；但比“分几次点、每次都不知道还差什么”好。
- 标题改用 `label` 后，多个账户若都没设 `label` 会全显示成 `default` 一类 id；
  因此把技术 id 保留在小字第二行，并把按钮改名为「改名 / 描述 / 标签」引导去补。
- 过期 `pending` 现在会**抛错**而不是静默超时（见下），调 `login-finish` 的旧调用方
  要能接住这个错误；工具层已有 try/catch，面板已按「过期」终止轮询。

**顺带修的两个脏数据坑**：

① **CLI 的 scope 快照缓存永不回收**。每次 `auth login` 都会往
`<configDir>/cache/auth_login_scopes/` 写一份 ~5KB JSON（完整 `requested_scope` 字符串），
CLI 自己不删。实测两天积了 20 个文件 / 103KB，且随授权次数线性增长。
现在 `login-start` 顺手回收 24 小时前的快照（旧的对后续流程无用，留一天宽限避并发）。
实测：把 20 个文件 mtime 设为 2 天前，再发一次授权 → 剩 1 个（本次新建）。

② 账户目录里留着一份过期 6 分钟的 `login-pending.json` 时，
面板会一直拿死掉的 `device_code` 去兑换，表现就是「永远在等待确认」。
现在 `loginFinish` 先校验 `expiresAt`，过期就删文件并明确报「请重新拿一条新的」。

**已否决**：

- 只在 `onChanged` 里刷新而不兑换（用户看到的还是“未授权”，等于没修）。
- 用 30s 默认超时做轮询（实测每轮要等满 30s，10 分钟只能试 17 次，且全程转圈）。
- 自动 `window.open` 授权页（弹窗需要用户手势，`setTimeout` 里开会被浏览器拦）。
- 把 `default` 改名成中文（id 会变成目录名与 `configDir` 路径，改了对已装用户是破坏性变更）。
---
