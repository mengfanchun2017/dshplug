# dsh-gitok 插件开发方案 · 初始化 / 管理 / 监控

> **修正说明**：本文件取代上一版 `docs/git-auth-multimachine-plan.md`（已删除）。
> 上一版把「多台机器 / 工作 session / 配置 / 环境的可靠同步」误读成了 `dsh-synchub` 的数据同步任务。
> **正解**：这是 `dsh-gitok` **插件本身的开发** —— 目标是把 git 认证的
> **① 初始化 ② 管理 ③ 监控** 做全做稳，并让同一份插件在每台机器上都表现一致。
> 工作 session / 配置 / 环境的同步归 `dsh-synchub`，本插件不碰；
> 它在这里只作为两条**约束**出现（§4）：`profileConfig` 会被同步 ⇒ 插件配置里不能写本机特有值；
> 以及「查过了没事 ≠ 根本没查」的状态建模思想可借鉴（不是做同步）。
>
> 输入：Claude 调研 `ccconfig-git授权全景与终端隔离方案-20261118.md`（2026-11-18）
> ＋ `dsh-gitok/{README,BOOTSTRAP,ADR}.md` 与 `docs/git-auth-audit-2026-11-12.md`（2026-11-12）
> ＋ `dsh-synchub/README.md`（仅取约束与设计思想）
> ＋ **本次会话实测**：`gitok_doctor` / `gitok_list` / `gitok_verify`（全程只读，未改任何配置）
>
> 本文是**开发方案**，不改代码、不改线上配置、不安装 bundle。

---

## 0. 结论先行

把插件从「6 个零散工具 + 一个只读面板」升级成一条闭环：

```
Init  从零到可用   →   Manage  查 / 切 / 换 / 删   →   Monitor  持续可观测
  gitok_bootstrap        adopt/rotate/revoke            doctor 升级为 4 态监控
  （建议新增）           （补齐 dry-run 与编排）        （面板徽标 + 周期巡检）
        └────────────────── 同一套判据、每台机各自跑 ──────────────────┘
                                    │
                          凭据 DPAPI 天然每机独立
                          ⇒ 每机一次 login，绝不共享
```

**四句话版**：

1. **初始化**：新增 `gitok_bootstrap` 一键入口 —— 先自检环境、再幂等配置、再登录、再验收；可重入、有 dry-run、失败能诊断。
2. **管理**：补齐 `adopt` 的 dry-run、新增 `rotate` 编排（含失败回滚）、`revoke` 影响面提示、面板两个受控写按钮。
3. **监控**：把「点一下看一眼」升级为 `ok / warn / error / unknown` 四态；把本次实测已经发生、插件却没报出来的失效项纳入持续监控。
4. **多机**：只做**插件自身的一致性** —— 配置可移植（`proxy=''` / `targets` 运行时发现 / `gcmPath` 留空）、装机步骤统一、文档与代码同批更新。凭据带不走是设计特性，不是待解决问题。

**对 Claude 三套方案（A SSH 双轨 / B GH_TOKEN 写 .env / C 每机装 gh 存 hosts.yml）**：全部**不作实现方向**，理由见 §1.2。但它的**脚本链设计**和 **§9 管理层**是本方案的重要输入（§1.3）。

---

## 1. 从 Claude 反馈里吸收什么

### 1.1 一条关键修正 → 直接变成插件需求

Claude 报告 §4 依据 `C:\Users\franc\.gitconfig` 只有 `safe.directory` / `user.*`，判定「Windows 没有 credential helper，所以 DSH 才弹浏览器」。**这是误判**：`docs/git-auth-audit-2026-11-12.md` §1.1 与本次 `gitok_doctor` 都确认

```
helper:          file:C:/Users/franc/.../MinGit/etc/gitconfig    manager   ← 系统级
credentialStore: (default = wincredman)
http.proxy:      http://127.0.0.1:7897
```

`credential.helper=manager` 配在 **MinGit 的系统级 gitconfig**，用户级本来就不该有；报告只查了用户级。`gitok_verify` 实测 Windows 端点 `https://github.com/mengfanchun2017/dshplug.git` → `1e31aed3...` ✅。

> **⇒ 插件需求（Init 层）**：`gitok_bootstrap` 的环境自检**必须同时读系统级与用户级 gitconfig**
> （`git config --list --show-origin`），不能只看 `~/.gitconfig`；否则会在一台其实已经配好的机器上
> 误判为「未初始化」，进而重复登录、甚至覆盖正确配置。这一条是 Claude 反馈带来的最有价值的新增项。

同理，报告 §7 说「点网页授权生成了份额外的 credential」也不准确 —— 那正是 **GCM 自己的登录流程**（`gitok_login` 触发的就是它），凭据由 GCM 直接写进 wincredman，是这台机**唯一该有**的凭据，不是意外产物。

### 1.2 三套方案为什么都不作实现方向

| Claude 方案 | 否决理由 |
|---|---|
| **A. SSH key 双轨制（其推荐）** | `dsh-synchub/README.md` §11 本机实测「GitHub 只接受 HTTPS + PAT，SSH 全被墙」；要改全部 remote（ccconfig 四仓 + dshplug + 两同步仓）；私钥跨机复制违背每机独立，各机自生成又多一类凭据；报告自己 §9.2 也写「走 HTTPS 时用不到」 |
| **B. GH_TOKEN 写 `.env`** | `.env` / `.credentials.yaml` 均为明文，DSH 文档明说「文件权限挡不住 agent」。直接违背硬要求「不明文保存」 |
| **C. 每台机装 gh + 各存 `hosts.yml`** | `hosts.yml` 存的是**明文 PAT**，审计列为 🔴 高危；只是把明文 PAT 从一台机扩散到每台机 |

保留 A 中有价值的部分：`useHttpPath` / per-repo 隔离的思路（§3.2）、私钥加口令的纪律（§3.3）、§9 管理规范（§3.4）。

### 1.3 真正该抄的是「脚本链形态」，不是「方案选型」

Claude 报告里最有价值的是 `ccconfig` 那套**初始化/监控的工程形态**，把内核从 `gh + 明文 PAT` 换成 `GCM + DPAPI` 即可：

| ccconfig 脚本 | 形态价值 | 插件对应层 | 换成 GCM 内核后 |
|---|---|---|---|
| `bootstrap-gh-auth.sh` | 一行式新机入口、职责单一 | Init | `gitok_bootstrap` |
| `init-bootstrap.sh` `gh_auth()` | 状态机：已登录→跳过 / `GH_TOKEN`→自动 / SSH key→跳过 / 交互兜底 | Init | 已就绪→跳过 / 非交互→明确报错 / GCM 设备码兜底 |
| `gh auth setup-git` | 幂等配 helper | Init | `--unset-all` + `--add`（§8.1 的坑） |
| `GIT_TERMINAL_PROMPT=0` | 防非交互卡死 | Init / Monitor | 所有探测带超时 + 非交互标志 |
| `maintain.sh status` / `lib/status.sh` `check_pat_expiry` | 有效性巡检 | Monitor | 不读 token（ADR-002）→ 改判「通路是否通」+ 周期提醒 |
| `monitor.sh` 的 401 检测 | push 失败归因 | Monitor | `gitok_verify` 失败即告警，不解析响应体 |
| `maintain.sh pat` / `refresh-gh-auth.sh` | 交互式续期闭环 | Manage | `gitok_rotate`：备份→erase→login→verify→失败回滚 |

### 1.4 Claude 自己列出的「缺失能力」→ 正好是插件该补的

报告 §9.5 列了三条缺失：**SSH key 巡检**、**跨主机 PAT 冲突检测**、**gh 安装检测跨平台**。前两条直接进 Monitor（§3.3），第三条在插件语境下变成「环境自检不假定 gh 存在，改查 GCM」。

---

## 2. 现状：6 个工具落在哪一层（本次实测）

| 层 | 现有能力 | 落点 | 主要缺口 |
|---|---|---|---|
| **Init** | `gitok_login`（GCM 浏览器/设备码）、`gitok_adopt`（接管 WSL helper，先备份）、`gcmPath` 自动探测 | 部分 | **没有一键 bootstrap**；`gitok_login` **至今未做真实登录实测**（README §7.2）；没有环境自检（GCM/代理/sslBackend/interop）；没有可重入状态机；非交互场景会卡 |
| **Manage** | `gitok_list`（只显 host/用户名）、`gitok_revoke`（`confirm:true` 才删）、`gitok_verify`（端到端） | 部分 | `adopt` 无 dry-run；`revoke` 不提示影响面；**没有轮换编排**；面板「重新登录/撤销」按钮未做（ADR-005 只开只读路由）；没有凭据台账；`useHttpPath` 注释说「推荐 true」而配置是 `false`（自相矛盾） |
| **Monitor** | `gitok_doctor` 只读体检、`parseStatus()`、`/plugins/gitok/status`（5s 缓存）、面板状态卡 + 「重新检查」 | 部分 | 一次性、无状态；**面板尚未在界面确认渲染**（§7.2）；不区分「查过了没事 / 根本没查」；默认 `targets=[windows]` 看不到 WSL；不判 SSH 私钥口令；无周期巡检 |

### 2.1 三个端点正好演示三种状态（本次 `gitok_doctor` / `gitok_list` / `gitok_verify` 实测）

| 端点 | 实测 | 状态 |
|---|---|---|
| `windows` | `helper=manager` / `wincredman` / proxy `127.0.0.1:7897` / 凭据 1 条 `git:https://github.com` / `verify ✅ 1e31aed3` | **健康** |
| `claude` | `gh auth git-credential` + `~/.config/gh/hosts.yml`（600，**明文 PAT**）/ `✓ Logged in` / `verify ✅` | **有隐患**（能用，但明文落盘） |
| `u26claude4` | 同款 gh helper + `~/.ssh/id_ed25519` **空口令私钥** / `gh status: X The token ... is invalid` | **已失效，且插件没报出来** |

> `u26claude4` 的 token 已失效、空口令私钥是审计 P0（2026-11-12 定的），但默认配置下 `doctor` 只看 `windows`，
> **两条都没被告警**。这是 Monitor 层最直接的改进依据，也是「同一份明文 PAT 散落多个发行版、各自失效」的实证。

---

## 3. 三层能力设计（核心）

### 3.1 Init · 初始化

**目标**：新机器 / 新终端「一条入口 + 一次登录」到可用；可重入、可预演、失败可诊断。

**建议新增第 7 个工具 `gitok_bootstrap`**，阶段化状态机：

| 阶段 | 做什么 | 写操作 | 失败行为 |
|---|---|---|---|
| **S0 环境自检** | GCM 是否在（自动探测/读 `gcmPath`）、git 版本、**系统级+用户级** gitconfig（§1.1）、代理可达、MinGit schannel 是否需要 `sslBackend=openssl`、WSL interop 是否可用、本机有哪些 WSL 发行版 | 无 | 出结构化报告，标 `unknown` 项，不继续 |
| **S1 幂等配置** | 只补缺失项；helper 一律 `--unset-all` 再 `--add`（README §8.1）；飞书 `lark-cli` 那条 helper **保持不动** | 有（先备份 `~/.gitconfig.bak.gitok-<ts>`） | 校验回读行数 > 1 即告警 |
| **S2 登录** | 已就绪→**跳过**（借鉴 `gh_auth()` 第 1 步）；否则 `gitok_login` 触发 GCM | 有（GCM 自己写 wincredman，插件不接触密钥） | 非交互环境给明确错误 + 设备码指引，**不卡住**（等价 `GIT_TERMINAL_PROMPT=0`） |
| **S3 验收** | `gitok_verify` 端到端 + 回读 helper/凭据条目 | 无 | 不通就回到 S0 报告，不假装成功 |
| **S4 收尾（可选）** | 清理本机散落的明文 `hosts.yml` / `~/.git-credentials`、处理空口令私钥 | 有 | **必须 `confirm:true`**，默认只提示不删 |

- `dryRun: true` ⇒ 只输出 S0 报告 + S1~S4 的**计划动作**，零写入；
- `recheck` 语义：任何时候重跑都从 S0 开始，已满足的阶段跳过 —— 这是「可重入」；
- 所有子进程带 `probeTimeoutMs`（现为 20000）与非交互标志；
- **不复制凭据**：S2 只在该机 wincredman 写一条，A 机的密文物理上到不了 B 机。

> **P0 前置**：`gitok_login` 未做真实登录实测（README §7.2 挂了很久）。Init 层全部建立在它之上，
> 必须先补这一条实测，否则 bootstrap 是空中楼阁。

### 3.2 Manage · 管理

**目标**：查得到、切得动、换得掉、删得准，**全程不接触密钥**（ADR-002 硬约束）。

| 改动 | 说明 |
|---|---|
| `gitok_adopt` 加 `dryRun` | 复用 bootstrap S0 报告；现在只能靠备份回滚（README §7.2 待办） |
| **新增 `gitok_rotate`** | 编排：备份 → `erase` → `login` → `verify` → **失败回滚备份**。**不接收任何 token 参数**；触发条件是「verify 失败 / 用户主动 / 周期提醒」，不解析 token 判过期（ADR-002 明确放弃该功能） |
| `gitok_revoke` 增强 | 删之前先列出「这条凭据被哪些仓库用」（从各端点 remote + `useHttpPath` 推），补上 README §7.2 缺的提示；仍必须 `confirm:true` |
| 面板两个写按钮 | 「重新登录」「撤销」——ADR-005 现在只开只读路由，写操作要扩成受控写：同源 loopback + origin guard + **二次确认 + 明确后果**，且按钮只传意图、绝不传 token |
| 凭据台账 | 本机记 `machine → 凭据类型 / 创建时间 / 作用域`，**只记元数据不记值**；每机一份，不进任何同步面 |
| `useHttpPath` 说清楚 | 它只把凭据按「host + 仓库路径」分成不同**存储条目**，**不会**让 GCM 返回不同 token，单独做不到「一仓一权限」。当前注释「推荐 true」与配置 `false` 必须统一；真正的 per-repo 最小权限要靠 §3.4 的方案 E |

**决策点 D / E（需要写进 ADR 新增一条）**：

| | **D 默认** GCM OAuth | **E 更严格** 每机命名细粒度 PAT + DPAPI 存储 |
|---|---|---|
| 做法 | 每机 `gitok_login` 一次 | GitHub 按机器建 `dsh-push-REDMIPRO` / `dsh-push-FRANCIS-HOME-I7`，只授需要的仓；用 `git-credential-manager store` 写进 wincredman（**不落 `hosts.yml`**） |
| 加密 / 不落明文 | ✅ | ✅ |
| 最小权限 | ❌ `gho_` 是 `gist, repo, workflow` 全宽 | ✅ 命中 Claude §9.1 |
| 可按机器命名 / 单独吊销 | ❌ GitHub 只显示「Git Credential Manager」 | ✅ |
| 插件现有支持 | ✅ `gitok_login` 直接支持 | ⚠️ 需新增 `store` 封装，当前 6 工具没有 |
| 轮换 | 重新 login，无需管 token | 人工 Regenerate + 重新 store |

> 两份材料**独立得出同一结论**：Claude §2/§9.1 与 `README.md` §3 都建议「靠向 fine-grained PAT」。
> 但**收敛 ≠ 接受宽权限**，且 E 绝不能退回 `hosts.yml`。建议先落 D 打通闭环，E 作为可选增强；
> 这也是本次合并后唯一没能两全的诉求（Claude §9.1「命名含主机标识」在 D 下无法满足）。

### 3.3 Monitor · 监控

**目标**：不是「点一下看一眼」，而是能区分 **健康 / 隐患 / 失效 / 状态未知** 的持续可观测。

**① 状态模型升级为四态**：`ok / warn / error / unknown`。
`unknown` 是**独立态**：探测超时、GCM 找不到、WSL 起不来、fetch/命令失败时，显示「状态未知」而不是绿色勾。
（借鉴 `dsh-synchub` 的 `fetched:false` 设计思想 —— 只借状态建模，本插件不做同步。）
`parseStatus()` 扩展 `level`，Host 路由返回值与 `gitok_doctor` 继续共用 `runDoctor()`，避免两处漂移（ADR-004）。

**② 六项持续监控**（全部不读明文，符合 ADR-002）：

| # | 监控项 | 判据 | 来源 |
|---|---|---|---|
| a | 端点通路心跳 | `git ls-remote` 带超时/退避，失败即 `error` | 替代 Claude `monitor.sh` 的 401 检测 |
| b | 明文凭据再现 | `hosts.yml` / `~/.git-credentials` / remote URL 里带 token → `warn` | 审计 🔴 高危项 |
| c | **SSH 私钥口令** | `ssh-keygen -y -P "" -f <key>` 成功即空口令 → **P0 `error`** | Claude §9.5 点名缺失；本次 `u26claude4` 实证 |
| d | helper 叠加 | `credential.<url>.helper` 回读行数 > 1 → `warn` | README §8.1 真实踩过的坑 |
| e | 凭据条目异常 | 同 host 条目数变多 / 出现非预期 host → `warn` | 对应 Claude §9.5「跨主机 PAT 冲突检测」 |
| f | 依赖漂移 | GCM 路径变、代理不可达、WSL interop 关闭 → `error` | ADR-001 反面代价 |

**③ 覆盖面**：默认 `targets=[windows]`（ADR-006）导致 `u26claude4` 的失效完全不可见。
建议不改默认（避免 `adopt` 误改 WSL 配置），改为：bootstrap S0 **自动发现本机 WSL 发行版名并列出**，
`doctor` 用参数临时指定即可巡检；面板提供「本次体检包含这些端点」的明示，而不是悄悄只看 Windows。

**④ 周期巡检**：可选、默认关（与 `dsh-synchub` 的 `autoPush:false` 同样克制），
只做本地检查 + 面板徽标，不自动 `erase`、不自动 `login`。

**⑤ 不做的**：token 过期倒计时（ADR-002 读不到 token）。用「通路失败即告警 + 月/季人工巡检」替代（§3.4）。

### 3.4 运维闭环（吸收 Claude §9）

单一真相源：GitHub 授权页（D）/ PAT 页（E）；本机用 `gitok_list`。

| 事项 | 插件里的落点 |
|---|---|
| 每机一凭据、命名含主机 | 台账（§3.2）；E 方案下 PAT 名带机器标识 |
| 最小权限 / No expiration | E 方案；D 方案接受 `gho_` 全宽，写进 ADR 反面代价 |
| 轮换 | `gitok_rotate`（§3.2） |
| 退役吊销 | `gitok_revoke confirm=true`，单台机操作不影响其他机 |
| 每月巡检 | `gitok_list` + `gitok_doctor`（含 b/c/d/e 项）+ GitHub 最后使用时间 |
| 每季巡检 | `gitok_verify` 全端点 + 确认无跨机复制凭据 + 删退役机授权 + 核对 `proxy` / `targets` 未被别台机的值覆盖 |

**失败分支对照**：`Failed to connect` 是网络/代理不是认证；WSL 认证全断查 GCM 路径/interop；
网络登录 / SSH 会话下 `wincredman` 不可用改 `credential.credentialStore=dpapi`；
`SEC_E_NO_CREDENTIALS` → `http.sslBackend openssl`；helper 写了没生效 → `--unset-all` 再 `--add`。

---

## 4. 多机一致性（**插件自身**，不是数据同步）

再次明确边界：**工作 session、配置、环境的同步由 `dsh-synchub` 负责，本插件不做**。
本插件只保证「同一份代码在 N 台机上被正确安装、正确自检、状态判据一致」。

**① 凭据天然每机独立**：`wincredman` = DPAPI 绑「用户 SID + 机器」，密文出机器解不开 ⇒ 每机一次 `gitok_login`。
这从机制上强制执行了 Claude §9.1「❌ 同一份 PAT 复制到多台机」。**这是特性，写进装机手册，不是待修问题**。

**② 配置可移植化（P1）** —— `cordis.patch.yml` 的 `config:` 属于会被同步的 `profileConfig`，当前却含本机特有值：

```yaml
proxy: 'http://127.0.0.1:7897'   # ← 本机端口，B 机不适用；应改 ''（代码已支持自动读系统代理）
targets: [ windows ]              # ← 各机 WSL 发行版名不同；提交里只留基线，运行时自动发现
gcmPath: ''                       # ← 已正确，保持自动探测
useHttpPath: false                # ← 注释「推荐 true」与值矛盾，统一
```

且 `config:` **在行激活时读取**（README §4.4 / BOOTSTRAP §0.2）⇒ 别台机的值被覆盖过来时，
要到**下次完全退出 DSH 再打开**才生效，验收时必须显式重启一次。

**③ 装机步骤统一**（BOOTSTRAP §1 / §8）：
`install.ps1 -Check` → `-Only dsh-gitok -Force` → **完全退出 DSH 再打开** → 三层验证（语法 / mock ctx 6 工具+1 路由 / `/plugins/gitok/status`）→ 面板验收清单。

**④ 改什么要重启 / 改什么刷页面**（BOOTSTRAP §0.2 四行表，多机部署最易误判）：
`lib/index.js` 与 `cordis.patch.yml` 的 `config:` → 完全退出重开；`lib/client.js` → 刷新页面；
`package.json` 的 `dsh.client` → `-Force` 重装 + 重启。

**⑤ 文档与代码同批更新**（AGENTS.md 全局规则）—— 本次检查发现 4 处不一致，应随本轮改动一起修：

| 位置 | 问题 |
|---|---|
| `cordis.patch.yml` 头注释 | 仍写「本插件没有浏览器半（无 dsh.client），全部能力在模型工具层」—— v0.1.0 残留；`package.json` v0.2.0 已声明 `dsh.client` |
| `list.json` 的 `dsh-gitok.note` | 同样写「无浏览器半，纯模型工具插件」，与同条 `description` 自相矛盾 |
| `cordis.patch.yml` `useHttpPath` | 注释「推荐 true」vs 值 `false` |
| `package.json` `files` | 只列 `lib/*`、`cordis.patch.yml`、`README.md`，漏 `BOOTSTRAP.md` / `ADR.md` / `docs/`；`plugpush.ps1` 走 `git add` 无碍，但改用 `install_bundle` 装 tarball 时三份交接文档会丢 |

---

## 5. 落地路线（按优先级，可直接开工）

| # | 动作 | 层 | 改哪半 / 生效方式 | 状态 |
|---|---|---|---|---|
| 1 | **轮换 Claude 文档里泄露的明文 PAT**，确认 `C:\claudefiles\` 不在任何仓库/同步面 | 安全 | 人工，与本插件无关但最急 | ⬜ 待用户 |
| 2 | 处理 `u26claude4` **空口令 SSH 私钥**（删除或 `ssh-keygen -p` 加口令） | 安全 | 人工；已被监控项 c 自动报 `error` | ⬜ 待用户 |
| 3 | **`gitok_login` 真实登录实测** | Init | 无代码；解锁后续全部 | ✅ 已验（GCM 返回 `oauth, len=40`） |
| 4 | **面板在界面上实际确认渲染**（README §7.2） | Monitor | `client.js` 刷新页面即可 | ⬜ 待用户点一下（已用 mock ctx + 最小 hooks 运行时验证两个态都不报错，只差真人看一眼） |
| 4b | **面板内置 WSL 落地说明**（原理 + 实时端点状态 + 可复制命令） | Monitor | `lib/client.js` + `lib/index.js` → 刷新页面 | ✅ 完成（2026-11-13） |
| 5 | 新增 `gitok_bootstrap`（S0~S4、`dryRun`、可重入） | Init | `lib/index.js` → 重启 | ✅ 完成 |
| 6 | S0 环境自检项，含**系统级+用户级** gitconfig、GCM/代理/sslBackend/interop | Init | 同上 | ✅ 完成（含 `effectiveProxy()`） |
| 7 | `gitok_adopt` 加 `dryRun` | Manage | `lib/index.js` → 重启 | ✅ 完成 |
| 8 | 新增 `gitok_rotate`（备份→erase→login→verify→回滚） | Manage | `lib/index.js` → 重启 | ✅ 完成 |
| 9 | `gitok_revoke` 影响面提示 | Manage | `lib/index.js` → 重启 | ✅ 完成 |
| 10 | 面板「重新登录 / 撤销」按钮 + 受控写路由 + 二次确认 | Manage | `index.js` 重启 + `client.js` 刷新 | ✅ 完成（含 Host/Origin 守卫） |
| 11 | 四态状态模型 `ok/warn/error/unknown`，`parseStatus()` 与路由共用 `runDoctor()` | Monitor | `lib/index.js` → 重启 | ✅ 完成 |
| 12 | 六项持续监控（§3.3），含空口令私钥检测 | Monitor | `lib/index.js` → 重启 | ✅ 完成 |
| 13 | 可选周期巡检（默认关） | Monitor | `lib/index.js` → 重启 | ✅ 完成（`autoCheckMinutes`，已加 [0,10080] 夹紧） |
| 14 | `proxy:''` / `targets` 运行时发现 / `gcmPath` 留空 / `useHttpPath` 注释统一 | 多机 | `cordis.patch.yml` → **完全退出重开** | ✅ 完成 |
| 15 | 修 §4⑤ 四处文档不一致 | 多机 | 纯文档 | ✅ 完成 |
| 16 | D/E 方案择一，新增 ADR 条目（结论→理由→反面代价→已否决） | 决策 | `ADR.md` | ✅ 完成（ADR-008，已选 D） |

> 16 项中 14 项已落地；剩下 1、2、4 是**用户动作**（轮换 PAT / 给私钥设口令 / 看一眼面板）。
> 另：本批新增了 `BOOTSTRAP.md` §9~12（新机从零、三层更新边界、给 Claude 的自包含说明）。
>
> **复核轮（2026-11-13）额外修掉三处真缺陷：**
> 1. 写路由守卫原本只查 `remoteAddress`，注释却声称还查了 Host/Origin ——
>    等于撤销凭据的接口对「用户浏览器里任意网页」敞开（当时 `remoteAddress` 就是 127.0.0.1）。
>    已补 `Host`（防 DNS rebinding）+ `Origin` 校验，并实测 403。
> 2. `revoke` 未确认时返回 200 + 提示字符串，调用方无法区分「做成了」和「没做」。
>    改为声明式 `requiresConfirm`，未确认回 400。
> 3. `autoCheckMinutes` 无上下界：`setInterval` 延时超过 2^31-1 会溢出成 1ms 高频空转。
>    schema 与运行时各夹一次，钳到 [0, 10080]。

---

## 6. 反面代价与边界

1. **ADR-002 不读 token** ⇒ 做不了「token 快过期提醒」，只能通路失败告警 + 周期人工巡检。Claude `check_pat_expiry` 那类功能不移植。
2. **WSL 借 Windows GCM**（ADR-001）⇒ Windows 没跑、interop 关、GCM 路径变，WSL 认证即断。对 WSL 里的无人值守脚本（`maintain.sh` / cron）是真实风险，用 `credential.credentialStore=dpapi` 缓解。
3. **`wincredman` 在网络登录 / SSH 会话下不可用** ⇒ 远程/无头场景改 `dpapi` store。
4. **DPAPI 防不了本机同身份进程** —— 加密防的是硬盘被拿走、备份泄露、其他账户；这是 OS 边界不是缺陷（README §5.3）。
5. **面板引入写操作扩大攻击面** ⇒ 必须二次确认 + loopback/origin guard + 绝不接收 token；否则违背 ADR-002/005。
6. **`targets` 默认只 `windows`**（ADR-006）⇒ 想全覆盖 WSL 要显式开，但开了 `adopt` 会**真改** WSL 配置；用「自动发现 + 只读巡检」而不是改默认值来补可观测性。
7. **每机必须一次 login**，凭据永远带不走 —— 写进装机手册，否则新人会问「装好了怎么还要登录」。
8. **只覆盖 HTTPS**：`doctor` 能看到 SSH 私钥现状但不管理（README §7.3）。若将来用 SSH，按 Claude §9.2 命名 + **必须带口令** + 每机独立生成。
9. **Claude §9.1「命名含主机标识」在 D 方案下无法完全满足** —— 这是合并后唯一两全不了的诉求，走 E 才有，代价是手工轮换。

---

## 7. 已否决（ADR 风格留档）

| 方案 | 否决理由 |
|---|---|
| 把插件改成「同步工作 session / 配置 / 环境」 | 那是 `dsh-synchub` 的职责，不是本插件；上一版方案已因此作废 |
| 用 `gh` + `hosts.yml` 做初始化内核（Claude C） | 明文 PAT；本次实测 `u26claude4` 的 PAT 失效，正是该模式不可维护的证据 |
| `GH_TOKEN` 写 `.env` / 环境变量隔离（Claude B） | 明文、可被 git add 泄露、不 export 就回到无凭据 |
| SSH 双轨（Claude A） | 本机 SSH 被墙、要改全部 remote、新增一类要管的私钥 |
| 同一份 PAT 复制到多台机 | DPAPI 机制上禁止；吊销/轮换一台全断（Claude §9.1 明令） |
| 读 token 判过期 / 做过期倒计时 | 违反 ADR-002 硬约束 |
| 面板自己起子进程探测 | Client 半在浏览器里无子进程能力（ADR-005），必须走 Host 路由 |
| 改 `targets` 默认值来「顺便」监控 WSL | ADR-006：留着默认端点 = 留着 `adopt` 误改 WSL 配置的机会 |

---

## 8. 验收（三层各勾一遍）

```text
Init
[ ] gitok_login 真实登录实测通过（GCM 浏览器/设备码，凭据落 wincredman）
[ ] gitok_bootstrap dryRun 只出报告、零写入
[ ] 全新机 / 已就绪机各跑一次：前者到 S3，后者 S2 跳过（可重入）
[ ] S0 能读出 MinGit 系统级 credential.helper=manager（不误判未初始化）
[ ] 非交互环境下不卡死，给明确错误

Manage
[ ] adopt dryRun 输出计划且不改 .gitconfig
[ ] rotate 全流程通过；中途失败能回滚到备份
[ ] revoke 删前列出受影响的仓库；不传 confirm 时拒绝执行
[ ] 面板两个写按钮有二次确认，且请求体不含任何 token 字段

Monitor
[ ] 面板「Git 认证」分区实际渲染，徽标与 /plugins/gitok/status 一致
[ ] 探测失败时徽标是 unknown（「状态未知」）而不是绿色勾
[ ] 指定 targets=["u26claude4"] 能报出：token invalid + 空口令私钥 P0
[ ] doctor 输出无任何 40+ 字符高熵串（ADR-002 脱敏验收）

多机
[ ] 两台机 clone 到同一路径 C:\dsh\dshplug，install -Check 均 active/link-junction
[ ] 提交里的 patch 不含硬编码代理端口 / 别的机器 WSL 名
[ ] 完全退出 DSH 重开后配置生效，三层验证 + 面板验收全绿
```

---

## 9. 相关文件

- 本方案： `dsh-gitok/docs/plugin-roadmap.md`（本文件）
- Claude 调研： `C:\claudefiles\ccconfig-git授权全景与终端隔离方案-20261118.md`
- 现有插件文档： `dsh-gitok/README.md`（怎么用）、`BOOTSTRAP.md`（怎么做）、`ADR.md`（为什么，新增决策写这里）
- 原始审计： `dsh-gitok/docs/git-auth-audit-2026-11-12.md`
- 配置与清单： `dsh-gitok/cordis.patch.yml`、`package.json`、`../list.json`
- 边界参考（仅约束，非本方案主体）： `dsh-synchub/README.md`
