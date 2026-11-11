# dsh-synchub · 同步中心

把两台 Windows 电脑上的 DSH 同步状态收进**一个侧边栏面板 + 一个设置面板**：看到状态、一键发起同步、改本机配置、逐项自检，并在「配置落后 / 插件过旧 / 忘了同步」时红点提醒。

> 本插件源码由仓库 `C:\dsh\dsh-plugins` 的 `list.json` 管理；安装用 `install.ps1`，
> 上线给另一台用 `plugpush.ps1`。详见仓库根目录 README。

## 两个界面

| 入口 | 用途 |
|---|---|
| 侧边栏「同步中心」（带红点）+ 主面板 | **日常**：看三路状态、一键拉取/推送、看另一台信标、版本比对 |
| **设置 → 同步中心** | **配置**：看状态与目录一览、修改 `workspace / machine / staleHours / beacon`、保存前逐项检查 |

设置面板的 4 个可改项：工作区路径、机器名、过期阈值（小时）、是否写本机信标。
「检查当前表单」是**只读预检**（草稿不落盘，逐项列出 OK/FAIL）；「保存」才写
`$DSH_HOME\dsh-synchub\config.json`，且该文件**不进任何同步通道**，两台各设各的。

## 它是什么 / 不是什么

**是**：一层薄的**聚合 + 转发**层。

- 状态来自三个既有来源，全部只读：
  - 本机工作区 Git 仓库（`git rev-parse` / `rev-list` / `status` / `log`）
  - `chatsync` 的 `/dsh-sync/api/status`
  - `dsh-config-manager` 的 `/api/dsh-config-manager/sync/status?detail=0`
  - 本机插件版本 vs npm `latest`
- 「发起同步」只转发到各插件**自己**的接口，复用它们原有的冲突裁决、加密、快照与回滚：
  - 工作区 → 本插件的 `git pull --ff-only` / `git push`
  - 会话 → `chatsync` 的 `/dsh-sync/api/run`
  - 配置 → `dsh-config-manager` 的 `/sync/push`（预览用 `preview:true`）、`/sync/pull`

**不是**：

- 不实现同步算法、不直写 `$DSH_HOME` 配置、不连私有同步仓库、不持有凭据、不读密钥文件。
- 不是第二数据源。红点只由「本机↔远端的版本/哈希差、插件新版本、上次同步时间」派生。
- 不加密、不搬运密钥。密钥仍按 `dsh-config-manager` 的「加密备份 + 导出密钥」手动流程处理。

## 红点规则

| 级别 | 触发 |
|---|---|
| 🔴 红 | 工作区落后/未推送、chatsync 从未同步或上次失败、配置同步工作副本落后 |
| 🟠 橙 | 工作区脏、超过阈值（默认 24h）没有新提交、插件有新版本、某状态源读不到、另一台机器信标缺失 |
| 🟢 绿 | 全部状态源都读到、且无漂移 |

刻意区分「查过了没事」和「根本没查」：状态接口读不到也算一条橙提醒，不会静默显示绿灯。

## 跨机版本比对（信标）

每台机器点一次「写本机信标」，插件会在**用户自己的工作区仓库**里提交
`sync-beacon/<hostname>.json`（机器名、时间、DSH/插件版本）。另一台 `git pull` 后，
面板「④ 版本与另一台机器」就能看到对方的版本与最后活动时间——这正是用来发现
「切到另一台终端，那边的插件/配置还是旧的」的信号。信标不含任何密钥。

## 安装

推荐用仓库根目录的 `install.ps1`（按 `list.json` 装全部 active 插件，或 `-Only` 装单个）：

```powershell
& "C:\dsh\dsh-plugins\install.ps1"
& "C:\dsh\dsh-plugins\install.ps1" -Only dsh-synchub
```

也可以直接用 dsh 命令装这一个（路径与两台机器必须一致）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "file:C:\dsh\dsh-plugins\dsh-synchub"
```

完全退出 DSH 再打开。侧边栏出现「同步中心」（带红点），点开是主面板。

**第二台机器（单位电脑）**：先把 `dsh-plugins` 仓库克隆到**同一路径**
`C:\dsh\dsh-plugins`，再跑 `install.ps1`。路径必须一致——`file:` 规格记录的是绝对路径，
换路径会让 DSH 启动时找不到依赖。

## 配置

`$DSH_HOME/dsh-synchub/config.json`（默认自动创建，也可在面板里改）：

```json
{
  "workspace": "C:\\dsh\\workspace1",
  "staleHours": 24,
  "beacon": true,
  "machine": "FRANCIS-HOME-I7"
}
```

`machine` 默认取 `os.hostname()`。两台机器务必不同名，否则信标互相覆盖。

## 可选依赖

`chatsync` 与 `dsh-config-manager` 都是 **optional peer**。任一未安装时对应卡片显示
「状态不可读（可能未安装）」，并给一条橙提醒；插件本身不会因此崩掉或阻止启动。

## 与 config.aiagt.dev / ccconfig 的关系

借了 ccconfig 的四个设计，但没抄它的技术栈：

| 借鉴 | 这里的实现 |
|---|---|
| 逐仓 `ahead / behind / dirty` + 最后推送时间 + 全绿兜底 | 面板①与「待办提醒」 |
| 「只读体检 / 一键动作」职责分离 | `refresh()` 全只读；动作都是独立按钮 |
| 内容水位判过期、区分「查过」与「没查」 | 红点状态机 |
| 冲突兜底（先 ff-only、不 force） | `git pull --ff-only`，push 不带 force |
| 公私仓 + 占位符模板 + 每机独立文件 | 信标每机一个文件；密钥不进任何通道 |

没抄：bash / systemd / inotify / WSL2（目标是两台原生 Windows 上的 DSH Desktop）、
「git tag 当唯一真相源不记版本号」（这里需要比较插件版本）、纯终端文字告警（这里要常驻红点）。

## 边界与已知限制

- 只在本机 loopback 提供 `/api/dsh-synchub/*` 路由，复用与 chatsync 同源的 origin/跨站 guard。
- `npm latest` 查询带 30 分钟缓存 + 5 秒超时；断网时版本比对降级为「读不到」，不影响其余状态。
- 工作区若不是 Git 仓库，① 卡片显示提示而不是报错崩溃。
- 面板每 60 秒自动刷新一次；动作执行后会立即刷新。
- 红点规则可在 `deriveAlerts()` 里按需要收窄，避免通知疲劳。
