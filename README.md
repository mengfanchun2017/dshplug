# dsh-plugins · 自研 DSH 插件仓库

一个 Git 仓库，一个 `plugins/` 目录，每个子目录 = 一个独立可注册的 DSH 插件。
这是两台机器上的**第 3 个仓库**（另外两个是会话同步仓、配置同步仓）。

## 三个仓库各管什么（不要混）

| 仓库 | 内容 | 谁写 | 谁读 |
|---|---|---|---|
| `dsh-plugins`（本仓库） | **自研插件的源码** | 你 / 我（改代码） | 两台机 `git pull` 后跑 `install.ps1` |
| `dsh-config` | DSH 配置快照（设置/插件清单/MCP/技能，不含密钥） | `dsh-config-manager` 自动推 | 另一台自动拉 |
| `dsh-sessions` | 会话日志、附件、工作区映射 | `chatsync` 自动推 | 另一台自动拉 |

工作区源码（`3d-forge` 等）归各自项目仓库管，不进这三个仓。
**可再生成的 3D 产物 / 密钥都不进任何仓库。**

## 目录约定

```
C:\dsh\dsh-plugins\
├─ install.ps1              # 一条命令装好 plugins/ 下所有插件
├─ .gitignore
├─ README.md
└─ plugins\
   ├─ dsh-synchub\           # 插件 1：同步中心（状态聚合 + 一键同步 + 红点）
   │  ├─ package.json        # 必须有 dsh.bundle.patch + dsh.client
   │  ├─ cordis.patch.yml
   │  └─ lib\ {index.js, client.js}
   ├─ <第二个插件>\          # 单位电脑正在开发的，clone 过来直接放这里
   └─ <第三个插件>\          # 以后新增同理
```

**一个插件目录要能被注册，只需两个条件：**

1. 目录里有合法的 `package.json`，且带 `dsh.bundle.patch`（指向 `./cordis.patch.yml`）
2. `cordis.patch.yml` 里有一行 `- insert: - id: <name>`，`id` 等于宿主半 `export const name`

`install.ps1` 会自动扫描并过滤掉不满足条件的目录，所以放个草稿目录也不会出事。

## 两台机器的安装顺序（重要）

`file:` 规格会把**绝对路径**写进 `profile/package.json`，而后者会被
`dsh-config-manager` 同步到另一台机器。如果那边没有同一路径 → **DSH 启动失败**。

所以顺序必须是：

```
1. 两台机都把本仓库 clone 到同一个绝对路径 C:\dsh\dsh-plugins
2. 每台机各跑一次  & C:\dsh\dsh-plugins\install.ps1
3. 完全退出 DSH 再打开
4. 之后才让 dsh-config-manager 同步配置
```

> 好消息：`file:` 依赖是 **hardlink**（实测同一 inode），改源码会立刻反映到已安装副本，
> 开发时不用反复重装；只有**新增/删除插件**才需要重跑 `install.ps1`。

## 命令速查

```powershell
# 装全部（推荐）
& "C:\dsh\dsh-plugins\install.ps1"

# 只装一个
& "C:\dsh\dsh-plugins\install.ps1" -Only dsh-synchub

# 看当前 profile 装了什么
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop list

# 移除某个（用包名，不是路径）
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-synchub
```

## 新增一个插件的步骤

1. `plugins\<名字>\` 建目录，放 `package.json` + `cordis.patch.yml` + `lib\`
2. 本机跑 `& .\install.ps1 -Only <名字>`
3. 完全退出 DSH 再打开，确认侧边栏/设置页出现
4. `git add -A && git commit && git push`
5. 另一台机 `git pull` 后跑 `& .\install.ps1`

## 与 ccconfig 的对应关系

ccconfig 用「公开仓放脚本模板 + 私有仓 ccprivate 放密钥 + symlink 桥进 ~/.claude/」。
这里借了它的**「每机独立文件 + 公私分离」**思路，但：
- 自研插件本身是代码，没有密钥，可以放同一个仓；
- 密钥仍然只走 `dsh-config-manager` 的加密快照手动流程，或各机环境变量 / `$DSH_HOME\secrets\`；
- 用 `file:` 硬链接代替 symlink，避免 Windows 权限与跨盘问题。

## 已知限制

- 路径必须两台一致（`C:\dsh\dsh-plugins`）。若单位电脑的 DSH 工作区也在 `C:\dsh`，天然满足。
- 0.x 版本的 caret 不跨 minor：插件若锁 DSH peer，升级 DSH 后要同步更新 `engines.dsh`。
- `npm pack` 本地插件超过 100 MB 会被 `dsh-config-manager` 跳过并警告 —— 本仓库只放源码，不会到这个量级。
