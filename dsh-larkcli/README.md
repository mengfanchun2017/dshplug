# dsh-larkcli

> 版本 **0.2.2** ｜ 状态 active ｜ 2026-11-22
> Windows 原生飞书/Lark 驱动：直连官方 `lark-cli.exe`，**不靠 WSL、不装系统 Node、不用 MCP**。
> 一键安装/升级 CLI、多账户（每账户独立 App + 独立 user 授权）、展示接入的应用与用户名、权限清单一键申请。
| 文档 | 回答什么 | 什么时候读 |
|---|---|---|
| **README.md**（本文） | **怎么用**：工具清单、面板长什么样、多账户模型、日常例子 | 想用它做点什么 |
| [BOOTSTRAP.md](BOOTSTRAP.md) | **怎么做**：安装、验证、排错、换机、升级、改哪要重启 | 装不上 / 坏了 / 换机器 |
| [ADR.md](ADR.md) | **为什么**：19 条决策 + 反面代价 + 已否决方案 | 想改设计、或质疑某个选择 |

---

## 0. 一句话定位

让 DSH Agent 在**纯 Windows** 上读写飞书线上内容：群消息、文档、多维表格、日历、邮件、云盘……
底层是飞书官方 CLI 的 Windows 原生二进制（本机实测 v1.0.100，22 个业务域 / 256 个 API 方法 / 大量 `+` 快捷键）。
**自己管版本**：从 npmmirror 查最新版 → 下载 → 比对官方 SHA256 → 原子替换，不经过 GitHub。

**边界**：只管「Agent 读/写飞书内容」。飞书**聊天通道**（长连接收消息、审批卡片）是另一回事，
仍在 `default-workspace\feishu-bridge`，两者不合并（ADR-001）。

---

## 1. 15 个工具

装好后模型直接能看到这些工具。**工具数量刻意压在 15 个**：工具 schema 每轮都进上下文，
注册 200 个命令等于每轮白烧 token。v0.2.3 新增 2 个（浏览器新建应用、查其进度）。

| 工具 | 干什么 | 调 CLI？ |
|---|---|---|
| `lark_call` | **主力**。执行任意 lark-cli 命令，透传 JSON | 是 |
| `lark_status` | bot/user 身份是否可用；`detail="full"` 展开完整 auth status | 是（带缓存） |
| `lark_schema` | 查命令与参数；留空给索引，`method=` 给精确参数，`service=` 给该域 help | 是（本地缓存） |
| `lark_doctor` | 自检：二进制/数据目录/账户/凭据/授权，并直说下一步调什么 | 是 |
| `lark_account_search` | **按任务本地找账户**（零 CLI 调用、零配额） | **否** |
| `lark_account_upsert` | 建/改账户：描述、标签、appId、默认 | 否 |
| `lark_account_set_secret` | 写 App Secret（唯一收密钥的入口，**永不回显**） | 否 |
| `lark_app_init` | **浏览器新建应用**：不用手填 appId/secret，给一条链接让用户点 | 是（后台跑） |
| `lark_app_init_status` | 查上面那步的进度：appId/secret/user token 是否已就位 | 否 |
| `lark_login_start` | 发起 user 设备流授权，给链接 | 是 |
| `lark_login_finish` | 用户确认后完成授权 | 是 |
| `lark_install` | **装/升级 CLI**：`action="check"` 只查，`action="install"` 下载+校验+替换 | 否（自己下载） |
| `lark_identity` | 展示接入的飞书应用（名/描述/头像/owner/版本）与用户名 | 是（2-3 次 API） |
| `lark_scopes` | 权限清单：应用缺 / 用户缺分开算，给预填好的申请链接 | 是 |
| `lark_read_doc` | **给个链接就读**：自动识别文档/表格/多维表格/幻灯片/知识库，从认证池依次尝试 | 是 |

### 常用调用

```
# 最常用：不走 PowerShell，直接 spawn exe
lark_call  args=["im","+chat-list","--page-size","10","--as","bot"]
lark_call  args=["im","+messages-search","--query","周报","--page-size","5"]
lark_call  args=["docs","+fetch","--doc","<token>"]
lark_call  args=["base","+records-search","--app-token","<t>","--table-id","<id>"]   # 多维表格

# 不确定参数先查，别靠猜
lark_schema                                # 256 方法的索引（几百字）
lark_schema  method="im.messages.delete"   # 单方法精确参数（约 2KB）
lark_schema  service="im"                  # 该域快捷键 + 风险等级

# 写操作先干跑
lark_call  args=["im","+messages-send","--chat-id","oc_xxx","--text","hi","--dry-run"]
```

`args` 用数组最稳；传 `command` 整条字符串也行（按引号切词，`--query "周报 汇总"` 不会被切坏）。

**两个内置守卫**：`auth login`（交互式，会卡住整步）和 `config init`（交互式向导）会被拒绝，
并提示改用 `lark_login_start` / 账户工具。

---

## 2. 多账户模型

**每账户 = 独立 App（appId + secret）+ 独立 configDir + 独立 user 授权。**
描述/标签/是否默认挂在账户上。

```
C:\dsh\data-larkcli\                 ← 仓库外，不进 Git、不进插件包、不进同步
├─ accounts.json                      ← 登记表：id / label / description / tags / appId / default
├─ accounts\
│  ├─ work\
│  │  ├─ appsecret.txt                ← 明文，仅本机；永不回显
│  │  ├─ config.json                  ← 由代码按本机路径**现算生成**，别手改
│  │  └─ login-pending.json           ← 设备流 device_code（也是凭据），完成即删
│  └─ personal\ ...
└─ cache\schema.json                  ← 256 方法索引，省一次 ~1s 进程
```

### 为什么「按任务搜账户」是本地算的

`lark_account_search` 读 `accounts.json` 做加权匹配，**不调飞书、不花配额、不多一次模型往返**：

| 命中位置 | 权重 |
|---|---|
| 标签 | 6（整体包含 +8） |
| 名称 | 4 |
| 账户 id | 3 |
| 描述 | 1 |

中文没有空格，所以除了拉丁词还额外生成 **CJK bigram**，否则「周报」这种两字词永远匹配不上。
返回 top 1–3 且**带命中理由**，模型据此判断，不是黑箱。无明显匹配时明确说「没有明显匹配」，
不给假建议（有测试守着）。

### 什么时候可以完全不用搜

**只有一个账户、或任务明显属于默认账户时，直接省略 `account`** —— 这就是最常见的省调用路径。
跨账户任务才值得一次 `lark_account_search`：

```
用户：把这个季度的周报汇总一下
→ lark_account_search  query="周报"        # 本地，~1ms
→ lark_call  account="work" args=[...]     # 一次到位，不用挨个试
```

---

## 3. 设置面板

**设置 → Mlarkcli**。给人看的，不用记工具名。

> **只注册了设置分区，没有注册侧边栏**（2026-11-22 确认设计如此，不是 bug）。
> 插件功能全在设置里，再给侧栏就是同一个组件的第二个入口 = 重复。
> 所以「侧边栏里找不到 Mlarkcli」是正常现象，去 **设置** 里找。
> 若设置里也找不到，那才是问题 → 见 [BOOTSTRAP.md](BOOTSTRAP.md) §3 排错表里「设置里完全找不到 Mlarkcli」那一行
> （最常见原因是浏览器半 `inject` 漏声明，整半不注册且不报错）。

> 显示名约定：`M` + 技能名全小写（本插件 = **`Mlarkcli`**），与仓库目录 `dsh-larkcli` 不同。
> 规则见 [`../BOOTSTRAP.md` §5.1](../BOOTSTRAP.md)。改显示名只动 `client.js` 的 `nav` 与 `locale/*.json`，不碰目录名。

```
┌─ Mlarkcli ──────────────────────────────────┐
│ 共 2 个账户    不指定账户时用 work  [刷新全部状态] │
│ 二进制   ✅ ...\lark-cli.exe                 │
│ 版本     1.0.100                            │
│ 数据目录 C:\dsh\data-larkcli                │
│ 账户表   ...\accounts.json                   │
│                                              │
│ ┌ lark-cli 本体 ──────────────────────┐    │
│ │ [v1.0.100]  [已是最新]               │    │
│ │ 从 registry.npmmirror.com 下载官方包… │    │
│ │              [检查更新] [升级]         │    │
│ └──────────────────────────────────────┘    │
│                                              │
│ ┌ 公司主账号 ───────────────────────┐    │
│ │ [默认] [bot 可用] [user 未授权]       │    │
│ │ id work  ·  cli_aa540f3569fadcfb     │    │
│ │ █ DSH Agent  [应用已发布]            │    │
│ │    Redmi DeepSeek Harness 的飞书入口   │    │
│ │    用户：未知（user 尚未授权）        │    │
│ │ 应用名   DSH Agent                    │    │
│ │ 应用已开通权限 38 条                  │    │
│ │ (研发) (周报) (项目A)                 │    │
│ │ [改名/描述/标签] [授权 user 身份]     │    │
│ │ [权限清单] [刷新状态] [我已完成授权]  │    │
│ └──────────────────────────────────────┘    │
│                                              │
│ 新增账户                                     │
│ id [work      ]  App ID [cli_xxxxxxxx   ]   │
│ 描述（AI 按任务选账户时靠它）…                │
│ [创建]   App Secret 不在面板填写              │
└─────────────────────────────────────────────┘
```

面板**不接收密钥**（请求体里出现 `secret` 字段会被 Host 直接 400 拒掉）——密钥只走工具。

### 点「权限清单」展开后

```
┌ 要申请的权限范围： [只读（推荐）] [标准] [全部] ┐
│ 知识库   6 条｜用户缺 5                        │
│ 云空间   4 条｜用户缺 3                        │
│ 多维表格 1 条｜应用缺 1｜用户缺 1              │
│ 新版文档 1 条｜✅ 已齐                          │
│                                                │
│ 应用侧缺 1 条 —— 点链接，权限已勾好，按「确认」  │
│              [打开权限申请页] [复制]            │
│ 用户侧缺 17 条（仅 user 需要，bot 不受影响）     │
│              [复制]                             │
└──────────────────────────────────────────────┘
```

两个关键设计：

1. **默认选「只读」档位**。全部权限 145 条，一上来就列完会把人吓跑；只读包 21 条就够查文档/表格/消息。
2. **应用缺与用户缺分开算**。租户级权限（`tenant`）用户授权也没用，必须去开放平台申请；
   用户级权限（`user`）走设备流即可。混在一起会让人重复劳动。
   申请链接是**预填好的**：`https://open.feishu.cn/page/scope-apply?clientID=<appId>&scopes=<编码后清单>`，
   打开就是勾好的状态，只用点「确认」（这是用户原话要求的「直接弹出只用点确认」）。

> 申请完还要在开放平台「**创建版本并发布**」，租户级权限才真正生效。这一点容易漏，所以面板上直说了。

面板**不接收密钥**（请求体里出现 `secret` 字段会被 Host 直接 400 拒掉）——密钥只走工具。

### 三个容易搞混的东西

| 名字 | 是什么 | 在哪改 |
|---|---|---|
| **显示名**（大字） | 面板标题那行字，给人看的 | 卡片上「改名 / 描述 / 标签」 |
| **id**（小字，如 `default`） | 账户目录名、`LARKSUITE_CLI_CONFIG_DIR` 的最后一段，也是 `lark_account_search` 的键 | 创建后**不可改**（改了等于换目录，已有凭据全部失效） |
| **「默认」徒标** | 不传 `account` 时用哪个；**不是用户名** | 卡片上「设为默认」 |

> 所以 `default` 不是「某个叫 default 的人」，它只是一个叫 `default` 的**配置目录编号**。
> 看着别扭就点「改名 / 描述 / 标签」，把大字改成「公司主账号」这类。

### 多飞书账户：一个账户 = 一个飞书应用

一个 DSH 终端可以同时接多个飞书应用（例：一个看本公司、一个看客户公司），
**各自有自己的 appSecret 与 user 授权，互不影响**。

### 新增一个账户：不用手填 appId / secret

**这是一个账户 = 一个飞书应用。** 新建只要一步：

1. 面板「新增账户」里只填一个名字（id，小写，会变成目录名），点「建账户并接飞书应用」。
2. 面板给你一条链接。**先在浏览器里登录到你要接入的那个飞书账号**，再打开它。
3. 在网页上点几下（建应用 / 确认）。
4. 回到面板点「刷新状态」—— appId 与 secret **已经自动就位**，不用去开放平台后台抄任何东西。

背后发生的事（想对账时看）：`config init --new` 把 appId + secret 写进该账户目录的
`config.json`，插件在下次用到这个账户时自动把它们接管：appId 回填到账户表、
secret 抄成标准的 `appsecret.txt`。所以即便你从没手输过，面板上也能看到 appId。

> 已经存在的账户如果缺 appId 或 secret，卡片上会出现「用浏览器新建应用」，走的是同一条路。

### 账户怎么被选中、怎么“激活”

AI 按**描述与标签**选账户（本地加权，不把全量描述塞给模型）；
不指定就用「默认」那个。

**激活模型：全部长期有效、可同时使用，不做全局单选。**

这一点专门实测过，不是选型偏好：

- `config.json` 里 `users[]` 挂在**每个 app 下面**（不是顶层），所以 A 应用与 B 应用
  可以**同时各自持有有效的 user 授权**，互不覆盖 —— 这是「全激活」能成立的结构前提。
- CLI 原生支持全局 `--profile <name>`，`whoami --profile beta` 实测返回对应的 appId，
  所以「多应用并发使用」不需要本插件发明任何机制。

为什么不做「同一时刻只有一个激活」：真实场景是「研发群用 A、客户群用 B」，两者要能在
同一轮对话里先后被用到。强制单选就多一次状态、多一处能忘；而忘了切的表现是
**读到了错误租户的数据** —— 静默且危险。

> 卡片上那个「默认」徒标只影响**省略 `account` 参数时选谁**，不影响其他账户可用性。

- 为什么不做「同一个应用下多个用户」：两条理由 ——
  ① CLI 虽然支持 `apps[].users` 数组，但**没有提供“指定用哪个已登录用户”的命令/参数**；
  ② 即便能选，一个账户的「描述/标签」也无法同时描述“这是谁”和“这能看什么”，
  按任务选账户就失效了（ADR-003）。
### 授权 user 身份（一次开全）

1. **先确认浏览器里登的是哪个飞书账号** —— 授权是发给「当前浏览器/手机飞书里登着的那个他」的，登错了会落到别人身上。
2. 点「授权 user 身份」。默认就是 `--domain all`：**一次申请全部业务域权限**，不用分几次点。
3. 点「1. 打开授权页」→ 在页面上点同意。
4. **回到面板不用做任何事**：面板已经开始自动轮询（每 4s 一次，最多 10 分钟），
   检测到确认就自动兑换、自动刷新成「user 已授权」。
5. 如果自动轮询超时，或你是在另一台机器上点的，点一下「2. 我已完成授权」或工具栏的「刷新状态」。

> 关于 bot 与 user 两边：**bot 侧权限靠开发者后台**（面板「权限清单」会给预填好的申请链接），
> **user 侧靠这次 `auth login`**。两边都要的就按上面一次开全，不用分两轮。


---

## 4. 首次上手（5 步）

全在会话里说就行，不用开终端。或者打开 **设置 → Mlarkcli**，里面每步都有按钮。

然后**在会话里**（不是 PowerShell）：

```
0) lark_install action="install"        # 没装过才需要；升级用 action="check" 看有没有新版
1) lark_doctor               # 先看缺什么

# —— 建账户（推荐路线：浏览器里点几下，不用手填 appId/secret）——
2) lark_account_upsert      id="work" label="公司主账号"
                            description="研发群、周报文档、项目A 多维表格" tags=["研发","周报","项目A"]
3) lark_app_init            account="work"     # 拿到链接 / 二维码，去浏览器里完成
4) lark_app_init_status     account="work"     # 看 appId 与 secret 是否已自动就位

# —— 授权 user 身份（要读“你自己的”文档/邮件时必须）——
5) lark_login_start qrcode=true   # 一次申请全部业务域权限
6) lark_login_finish              # 网页上同意后完成兑换

7) lark_identity             # 确认：接入的是哪个应用、登的是谁
8) lark_status               # bot ✅ 就能干活了
9) lark_scopes profile="read"   # 缺哪些权限？给一条预填好的申请链接
```

> 也有手填路线（已有 appId/secret，不想走浏览器）：
> `lark_account_upsert appId="cli_xxx"` → `lark_account_set_secret account="work" appSecret="..."`。
> 两条路线最后落到的磁盘布局完全一样。

装完之后**不用记账户**：把文档链接丢给它就行。

```
lark_read_doc url="https://xxx.feishu.cn/docx/xxxxxxxx"
# → 自动识别 docx/wiki/sheets/base/slides，从认证池里依次试，读到就返回正文
```

> 老机器升级：`lark-cli-win\_native-config\` 里的旧凭据会在**首次启动时自动导入**为 `default` 账户
> （`autoMigrate: true`）。导完那个目录就只剩纪念价值，可以删。

### 4.1 设备流三种完成方式（目标：尽量零点击）

| 方式 | 操作 | 说明 |
|---|---|---|
| 桌面点开 | 面板点「打开授权页」 | `window.open` 带 `noopener`，不会把面板导航走 |
| 手机扫码 | 面板直接显示二维码 | 二维码由 `auth qrcode` 现画（≈0.9 KB PNG），指向同一个 flow_id |
| 纯文本 | 复制链接到任何浏览器 | 最低保底，也适合转给别人 |

三条路指向**同一个** `verification_url`，用哪条都行；二维码是一次性的，旧码扫了只会报错。

**第二步也在面板里**：确认完点「我已完成授权」（`POST /plugins/larkcli/login-finish`），不用回会话。
这一步是长轮询，所以**只等 30 秒**；没确认就提示你「还没检测到你确认授权」，再点一次即可
（device_code 在 10 分钟内仍然有效）。

`lark_identity verify=true` 或面板的「验证 token」会真的打一次服务端（`auth status --verify`，
实测 ~1.1s），这是**唯一**能区分「token 存在」与「token 真的还有效」的办法 ——
不验时面板只会写「存在（未验证）」，不假装健康。

---

## 5. 身份：bot 还是 user

| | `--as bot` | `--as user` |
|---|---|---|
| 需要授权 | 否，配好 secret 即可 | 是，设备流一次 |
| 能读 | 机器人所在会话、文档、表格 | 你本人的私人文档、日历、邮件、私聊历史 |
| 范围 | = 应用在开放平台勾选并发布的权限 | = 授权时给的 scope |

**默认建议先用 bot**。要 user 才授权，别提前开权限。

user token 约 2 小时过期，CLI 自动用 refresh token 续（refresh 约 7 天）；过期太久重跑一次授权。

---

## 6. 消耗控制

这是最初的三条要求之一（「增加速度降低消耗」），具体落在五处：

1. **15 个工具**，不是 200 个 —— 工具 schema 每轮都进上下文。
   v0.2.0 新增的 4 个都做了“零杂音”设计：`lark_scopes` 纯本地（零 API）、`lark_identity` 按需拉（不自动）、
   `lark_install` 只在你要拍的时候跑、`lark_read_doc` 一个参数就把多账户试完。
2. **`lark_schema` 全量 1.5 MB 只在本地**，进上下文的只有索引（几百字）或单方法（约 2 KB）。
3. **`lark_status` 默认 brief + 60s TTL 缓存**；`detail="full"` 才展开。
4. **账户选择纯本地**：`lark_account_search` 不调 CLI、不花配额。
5. **结果自动截断**（默认 24000 字符）并提示 `--page-limit` / `--page-size`，
   同时剥掉 CLI 的 `_notice` 升级提示。
实测：`lark_schema` 索引 ≈ 6 KB；单方法查询 ≈ 2 KB；原始全量 1,571,017 字节（**约 260 倍差**）。

---

## 7. 安全

- App Secret / device_code **只写不读**：工具只报「长度 N」，日志与返回值都不含原文。
- 数据目录在**仓库外**（`C:\dsh\data-larkcli`），不进 Git、不进插件包、不进同步。
- HTTP 路由只接受 **loopback + 同源**；写接口拒收任何 `secret`/`token` 字段。
- 高危命令（CLI 标 `high-risk-write`，需 `--yes`）**不代用户点**；写操作先 `--dry-run`。
- lark-cli 自带输入防注入与输出净化，别主动关。

### 7.1 验证（改完代码跑这一条）
**本机的 `node` 不在 PATH 里**（DSH 桌面版自带运行时），所以直接写 `node` 会报「找不到命令」。
用完整路径：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd C:\dsh\dw-plugin\dsh-larkcli
& $node test\run.mjs     # 38 项：核心逻辑与错误路径
& $node test\tools.mjs   # 27 项：15 个工具的注册与描述
& $node test\client.mjs  # 浏览器半：初始态 / 带数据 / 身份块 / 按钮 / 缺权限
& $node test\smoke.mjs   # 结构与 12 条路由（少一条界面就 404）
& $node test\v2.mjs      # 76 项：scopes / resolver / install + 回归
& $node test\activate.mjs # apply() 在 5 种 ctx 下都不崩（无 webServer / config 缺失 / 垃圾 config）
& $node test\sync-merge.mjs # config.json 只能合并 —— user token 不得被抹（变异测试已验证它真能抓 bug）
```

`test/e2e.mjs` **不在上面**：它是人工诊断脚本（真实凭据跑一遍并打印原始输出，无断言）。


`package.json` 里的 `test:all` 需要 `npm`，而本机运行时**不带 npm**；有 npm 的机器可以直接 `npm run test:all`。


或直接：`& C:\dsh\dw-plugin\install.ps1 -Only dsh-larkcli`

> 回归项里专门盯了两个曾真坏过的点：二维码不能写进 CLI 配置目录（必被 denylist 拒）、
> `loginFinish` 不能挂 180s（面板点一下卡三分钟）。改这两处代码会被测试即时发现。

---

## 8. 相关背景

- 官方 CLI：[larksuite/cli](https://github.com/larksuite/cli)（MIT，Windows 原生二进制）
- 二进制下载镜像与 SHA256 见 [lark-native-setup.md](lark-native-setup.md)
- 旧的飞书聊天通道：`default-workspace\feishu-bridge`（**不并入本插件**，ADR-001）
