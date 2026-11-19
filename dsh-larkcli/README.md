# dsh-larkcli

> 版本 **0.1.0** ｜ 状态 active ｜ 2026-11-16
> Windows 原生飞书/Lark 驱动：直连官方 `lark-cli.exe`，**不靠 WSL、不装系统 Node、不用 MCP**。
> 多账户（每账户独立 App + 独立 user 授权，可写描述与标签），按任务本地搜索账户以降低消耗。

| 文档 | 回答什么 | 什么时候读 |
|---|---|---|
| **README.md**（本文） | **怎么用**：工具清单、面板长什么样、多账户模型、日常例子 | 想用它做点什么 |
| [BOOTSTRAP.md](BOOTSTRAP.md) | **怎么做**：安装、验证、排错、换机、升级、改哪要重启 | 装不上 / 坏了 / 换机器 |
| [ADR.md](ADR.md) | **为什么**：六条决策 + 反面代价 + 已否决方案 | 想改设计、或质疑某个选择 |

---

## 0. 一句话定位

让 DSH Agent 在**纯 Windows** 上读写飞书线上内容：群消息、文档、多维表格、日历、邮件、云盘……
底层是飞书官方 CLI 的 Windows 原生二进制（v1.0.99，18 个业务域 / 256 个 API 方法 / 大量 `+` 快捷键）。

**边界**：只管「Agent 读/写飞书内容」。飞书**聊天通道**（长连接收消息、审批卡片）是另一回事，
仍在 `default-workspace\feishu-bridge`，两者不合并（ADR-001）。

---

## 1. 9 个工具

装好后模型直接能看到这些工具。**工具数量刻意压在 9 个**：工具 schema 每轮都进上下文，
注册 200 个命令等于每轮白烧 token。

| 工具 | 干什么 | 调 CLI？ |
|---|---|---|
| `lark_call` | **主力**。执行任意 lark-cli 命令，透传 JSON | 是 |
| `lark_status` | bot/user 身份是否可用；`detail="full"` 展开完整 auth status | 是（带缓存） |
| `lark_schema` | 查命令与参数；留空给索引，`method=` 给精确参数，`service=` 给该域 help | 是（本地缓存） |
| `lark_doctor` | 自检：二进制/数据目录/账户/凭据/授权，并直说下一步调什么 | 是 |
| `lark_account_search` | **按任务本地找账户**（零 CLI 调用、零配额） | **否** |
| `lark_account_upsert` | 建/改账户：描述、标签、appId、默认 | 否 |
| `lark_account_set_secret` | 写 App Secret（唯一收密钥的入口，**永不回显**） | 否 |
| `lark_login_start` | 发起 user 设备流授权，给链接 | 是 |
| `lark_login_finish` | 用户确认后完成授权 | 是 |

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

**设置 → Mlarkcli**（侧边栏同名）。给人看的，不用记工具名。

> 显示名约定：`M` + 技能名全小写（本插件 = **`Mlarkcli`**），与仓库目录 `dsh-larkcli` 不同。
> 规则见 [`../BOOTSTRAP.md` §5.1](../BOOTSTRAP.md)。改显示名只动 `client.js` 的 `nav` 与 `locale/*.json`，不碰目录名。

```
┌─ Mlarkcli ─────────────────────────────────┐
│ 共 2 个账户            [默认 work]  [刷新状态] │
│ 二进制   ✅ ...\lark-cli.exe (v1.0.99)        │
│ 数据目录 C:\dsh\data-larkcli                  │
│ 账户表   ...\accounts.json                    │
│                                             │
│ ┌ work ────────────────────────────────┐    │
│ │ [默认] [bot 可用] [user 未授权]        │    │
│ │ 研发群、周报文档、项目A 多维表格         │    │
│ │ (研发) (周报) (项目A)                  │    │
│ │ [编辑描述/标签] [授权 user 身份]        │    │
│ └──────────────────────────────────────┘    │
│                                             │
│ 新增账户                                     │
│ id [work      ]  App ID [cli_xxxxxxxx   ]   │
│ 描述（AI 按任务选账户时靠它）…                │
│ [创建]   App Secret 不在面板填写              │
└─────────────────────────────────────────────┘
```

面板**不接收密钥**（请求体里出现 `secret` 字段会被 Host 直接 400 拒掉）——密钥只走工具。

---

## 4. 首次上手（5 步）

```powershell
# 0) 二进制。不入 git（50 MB），clone 后补一次，带官方 SHA256 校验
cd C:\dsh\dshplug\dsh-larkcli
.\scripts\fetch-lark-cli.ps1
```

然后**在会话里**（不是 PowerShell）：

```
1) lark_doctor             # 先看缺什么
2) lark_account_upsert     id="work" label="公司主账号" appId="cli_xxx"
                           description="研发群、周报文档、项目A 多维表格" tags=["研发","周报","项目A"]
3) lark_account_set_secret account="work" appSecret="..."      # 只回长度
4) lark_status             # bot ✅ 就能干活了
5) lark_login_start        # 只有要读私人文档/日历/邮件/私聊历史时才需要
   （浏览器打开链接 → 回来 lark_login_finish）
```

> 老机器升级：`lark-cli-win\_native-config\` 里的旧凭据会在**首次启动时自动导入**为 `default` 账户
> （`autoMigrate: true`）。导完那个目录就只剩纪念价值，可以删。

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

1. **9 个工具**，不是 200 个 —— 工具 schema 每轮都进上下文。
2. **`lark_schema` 全量 1.5 MB 只在本地**，进上下文的只有索引（几百字）或单方法（约 2 KB）。
3. **`lark_status` 默认 brief + 60s TTL 缓存**；`detail="full"` 才展开。
4. **账户选择纯本地**：`lark_account_search` 不调 CLI、不花配额。
5. **结果自动截断**（默认 24000 字符）并提示 `--page-limit` / `--page-size`，
   同时剥掉 CLI 的 `_notice` 升级提示。

实测：`lark_schema` 索引 ≈ 6 KB；单方法查询 ≈ 2 KB；原始全量 1,496,509 字节（**约 250 倍差**）。

---

## 7. 安全

- App Secret / device_code **只写不读**：工具只报「长度 N」，日志与返回值都不含原文。
- 数据目录在**仓库外**（`C:\dsh\data-larkcli`），不进 Git、不进插件包、不进同步。
- HTTP 路由只接受 **loopback + 同源**；写接口拒收任何 `secret`/`token` 字段。
- 高危命令（CLI 标 `high-risk-write`，需 `--yes`）**不代用户点**；写操作先 `--dry-run`。
- lark-cli 自带输入防注入与输出净化，别主动关。

---

## 8. 相关背景

- 官方 CLI：[larksuite/cli](https://github.com/larksuite/cli)（MIT，Windows 原生二进制）
- 二进制下载镜像与 SHA256 见 [lark-native-setup.md](lark-native-setup.md)
- 旧的飞书聊天通道：`default-workspace\feishu-bridge`（**不并入本插件**，ADR-001）
