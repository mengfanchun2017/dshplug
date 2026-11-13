# DSH 会话（Session）存储与迁移手册

> 本机实测于 2026-11-12，DSH 0.2.x（Desktop / Windows）。
> 本文只说明机制与操作步骤，**没有对任何 session 数据做过修改**。执行前请先完整退出 DSH 并备份。

---

## 一、结论先行

**是的，session 和 workspace 存储在完全不同的位置，而且不止「位置不同」这么简单。**

| 内容 | 位置 | 是否在你解压的包里 |
|---|---|---|
| 工作区文件（`3d-forge/`、`docs/`、`.git/`） | `C:\dsh\workspace1` | ✅ 是 |
| 会话日志 | `C:\Users\franc\.dsh\sessions\` | ❌ **否** |
| 工作区 / 会话登记表 | `C:\Users\franc\.dsh\storages\workspace.json` | ❌ 否 |
| 会话标题、cwd 等投影缓存 | `C:\Users\franc\.dsh\storages\session_projcache\sessions\` | ❌ 否 |
| 附件 | `C:\Users\franc\.dsh\attachments\v1\` | ❌ 否 |
| 插件配置、技能 | `C:\Users\franc\.dsh\profiles\`、`plugins\`、`skills\` | ❌ 否 |
| GUI 临时状态（选中哪个工作区等） | `C:\Users\franc\AppData\Roaming\@deepseek-ai\dsh-desktop\Local Storage\leveldb\` | ❌ 否（一般也不用同步） |

**关键：压缩 / 解压一个工作区，只会带来文件，不会带来任何一条历史会话。**
这就是「之前很多 session 看不到」的第一位原因 —— 另一台 DSH 的会话数据留在那台机器的
`%USERPROFILE%\.dsh\` 里，没有跟着压缩包过来。

---

## 二、DSH 的存储模型（三层绑定）

### 第 1 层：物理文件

```
%USERPROFILE%\.dsh\sessions\
    <工作区路径编码>\
        <sessionId>\
            session.v4.jsonl.zstd      ← 会话正文，zstd 多帧压缩的 JSONL
```

`<工作区路径编码>` 由**工作区的绝对路径**生成，规则已实测验证：
把 `:`、`\`、`/` 全部换成 `-`，首尾各加 `--`。

| 工作区路径 | session 目录名 |
|---|---|
| `C:\dsh\workspace1` | `--C-dsh-workspace1--` |
| `C:\dsh\agent` | `--C-dsh-agent--` |
| `C:\Users\franc\Documents\deepseek-harness\default-workspace` | `--C-Users-franc-Documents-deepseek-harness-default-workspace--` |

实现侧（`dsh-workspace/src/paths.js`）也印证了这一点：工作区的唯一性 canon 是
**规范化后的绝对路径字符串**，attach 时还会拿 session 的 `cwd` 走同一套规范化做校验。

### 第 2 层：登记表 `storages\workspace.json`

```jsonc
{
  "global": {
    "defaultWorkspaceId": "...",
    "workspaceIds": [ ... ],
    "archivedSessionIds": [ ... ],   // 归档 = 默认视图隐藏
    "pinnedSessionIds": [ ... ]
  },
  "tables": {
    "workspaces": {
      "<workspaceId>": {
        "path": "C:\\dsh\\workspace1",
        "title": "workspace1",
        "sessionIds": [ "session-55539f32-..." ]   // ← 归属决定「在哪个工作区里能看到」
      }
    }
  }
}
```

**GUI 的会话列表是按「当前工作区」过滤的**，而归属关系来自这张表，不是来自文件在哪个目录。

### 第 3 层：会话内部记录的绝对路径

`session.v4.jsonl` 顶部记录创建时的 `cwd`；投影缓存（纯文本 JSON）里也能直接读到：

```json
"cwd": "C:\\Users\\franc\\Documents\\deepseek-harness\\default-workspace",
"workingDirectory": { "val": "C:\\Users\\franc\\Documents\\deepseek-harness\\default-workspace" }
```

跨机路径不一致时，打开旧会话可能报
`working-directory: directory does not exist`（这一点在
[chatsync-architecture.md](<./chatsync-architecture.md>) 第 3.8 节也有记录）。

> 会话正文是 **zstd 多帧压缩**，不要试图用文本编辑器改里面的路径；
> 单次解压只出第一帧，必须逐帧解码。因此改 cwd 不现实，见下面「路径不一致」的绕法。

---

## 三、本机当前的实际情况（为什么「很多看不到」）

实测数据：

- 注册表共 6 个工作区、35 个已登记 session；`archivedSessionIds` 有 39 条。
- `default` 工作区（`C:\Users\franc\Documents\deepseek-harness\default-workspace`）
  登记 29 个 session，其中 **20 个已归档 → 默认视图只剩 9 个**。
- `workspace1` 是 2026-11-12 01:49 新建的，**只登记了 1 个 session**（就是当前这个
  `session-55539f32-b9cd-4016-be1f-0932d5a60d4b`）。
- 磁盘上物理存在 **70 个** session 目录，其中 **35 个根本没有登记到任何工作区**（孤儿，UI 永不显示）。
- 另有 1 个被隔离：`_sessions-quarantine-20261112\session-3da41871-caef-440a-97f0-52888f661408`
  （8.9 MB）。
- 存在 `workspace.json.bak-fix-20261112` 等备份，说明此前有过一次修复 / 同步操作。

所以「看不到」是四件事叠加：

1. **跨机只搬了工作区文件夹，没搬 `.dsh` 数据目录**（根因）。
2. 切到 `workspace1` 这个新工作区后，列表按归属过滤，历史上那些会话都归在 `default` 下。
3. 20 个会话被 `archivedSessionIds` 归档，默认不显示。
4. 35 个会话是未登记的孤儿；还有 1 个在隔离区。

---

## 四、要同步 session，应该做什么

### 场景 A：从另一台 DSH 把会话带过来（你的情况）

**在旧机器上，要复制的不是工作区文件夹，而是整个数据目录：**

```
%USERPROFILE%\.dsh\
    sessions\                        ← 必需：全部会话正文
    storages\workspace.json          ← 必需：工作区 / 归属 / 归档登记表
    storages\session_projcache\      ← 强烈建议：标题、摘要、cwd 缓存（缺失会重建，可能丢标题）
    attachments\                     ← 建议：会话里的附件
    profiles\ plugins\ skills\       ← 可选：插件与技能配置
```

**不要复制 / 不需要复制：**
Electron 的 `Local Storage`、`Session Storage`、`Cache`、`GPUCache`（GUI 临时状态，可重建）。

> ⚠️ **安全**：`.dsh\` 里有 `.credentials.yaml`、`.trae-auth.*.json`、`.workbuddy-*.json`
> 等凭据文件。用 git / 网盘同步整个 `.dsh` 前，务必先把这些排除掉
> （[chatsync-architecture.md](<./chatsync-architecture.md>) 附录 C 记录过密钥被推上远端的事故）。

**落位：** 放到新机器的 `%USERPROFILE%\.dsh\`（即 `C:\Users\franc\.dsh\`）。
如果新机器已有 `workspace.json`，不要整文件覆盖 —— 里面还有本机其它工作区；
应做**合并**（合并 `workspaceIds`、`workspaces` 各条目的 `sessionIds`、`archivedSessionIds`）。

**两台机器工作区路径不一致时**，三步配套（缺一不可）：

1. 重命名 `sessions\` 下按旧路径编码的目录 → 新路径编码
   （例：`--D-proj-ws--` → `--C-dsh-workspace1--`）。
2. 把 `workspace.json` 里该工作区的 `path` 改成新机器的绝对路径。
3. **会话内部的 cwd 仍是旧路径** —— 最优解是在旧路径处建一个目录联接，让旧路径「存在」：

   ```powershell
   # 以管理员身份或开发者模式执行；旧路径的父目录需先建好
   New-Item -ItemType Directory -Path 'D:\proj' -Force
   cmd /c mklink /J 'D:\proj\ws' 'C:\dsh\workspace1'
   ```

   这样不用改 zstd 日志里的绝对路径，旧会话能正常打开并继续工作。
   另一个等价做法（更省事）：**两台机器把工作区放在完全相同的绝对路径**，从源头避免问题。

### 场景 B：同一台机器，把一个工作区的 session 移到另一个工作区

**可以，但要同时改「物理目录 + 登记表」两处，并且必须在 DSH 完全退出时做**
（运行时改会被内存中的状态回写覆盖）。

给一个可直接改参数的模板（以「从 default 搬到 workspace1，只搬 1 个会话」为例）：

```powershell
# ---- 0. 先备份（务必） ----
$dsh  = "$env:USERPROFILE\.dsh"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$dsh\storages\workspace.json" "$dsh\storages\workspace.json.bak-$stamp"
Copy-Item "$dsh\sessions" "$dsh\sessions-backup-$stamp" -Recurse

# ---- 1. 物理移动 ----
$srcDir = "$dsh\sessions\--C-Users-franc-Documents-deepseek-harness-default-workspace--"
$dstDir = "$dsh\sessions\--C-dsh-workspace1--"
$sid    = 'session-0409f04d-e01d-4866-8cd3-75cb6b1a39dc'   # 换成要搬的 sessionId
Move-Item "$srcDir\$sid" "$dstDir\$sid"

# ---- 2. 改登记表：换归属 + 解除归档 ----
$w = Get-Content "$dsh\storages\workspace.json" -Raw | ConvertFrom-Json
$fromId = '6e69a14b-93b0-4cdf-b5d4-f78f5b7c0ec6'   # default
$toId   = 'fca366c9-86f5-4048-a484-ae83cdd241f6'   # workspace1

$from = @($w.tables.workspaces.$fromId.sessionIds) | Where-Object { $_ -ne $sid }
$w.tables.workspaces.$fromId.sessionIds = @($from)
$to   = @($w.tables.workspaces.$toId.sessionIds) + $sid
$w.tables.workspaces.$toId.sessionIds = @($to | Select-Object -Unique)
$w.global.archivedSessionIds = @($w.global.archivedSessionIds | Where-Object { $_ -ne $sid })

$w | ConvertTo-Json -Depth 20 | Set-Content "$dsh\storages\workspace.json" -Encoding UTF8
```

3. **重启 DSH，刷新 GUI 页面**，检查会话是否出现在目标工作区且能打开。

4. 会话内部 `cwd` 仍指向旧工作区 —— 「继续工作」时文件操作会落在旧目录。
   按场景 A 的办法建 junction，或只把旧会话当作历史记录查看。

#### 两种搬法怎么选

| | 做法 | 适用 |
|---|---|---|
| **方案 1（推荐，一次性全搬）** | 直接把 `workspace.json` 里 **default 工作区的 `path` 改成 `C:\dsh\workspace1`**，把 `sessions\--C-Users-...-default-workspace--` **整体重命名**为 `--C-dsh-workspace1--`（与现有目录合并），并**删掉新建的空壳 workspace1 条目** `fca366c9-...`（先把它的 sessionIds 并进去） | 想让「以前所有会话」立刻出现在这个解压出来的工作区里 |
| **方案 2（挑着搬）** | 按上面的模板逐个移动 session 目录 + 改 `sessionIds` | 只想带过来其中几个会话 |

> 方案 1 注意：`workspace.json` 里不能留两个 `path` 都等于 `C:\dsh\workspace1` 的工作区
> （唯一性 canon 是规范化路径字符串相等，会冲突），所以必须删掉 / 合并那条空壳记录。

---

## 五、风险清单

- **必须先完全退出 DSH**（托盘 → 退出，确认进程结束），否则内存状态会覆盖你的修改。
- **只复制物理目录、不改 `workspace.json`** → 会话变成孤儿，UI 完全不显示（本机已有 35 个这样的例子）。
- **只改 `workspace.json`、不移动物理目录** → 列表里能看到，但打开是空白 / 报错。
- `workspace.json` 是 `unit.version = 2` 的结构化存储，改完必须仍是合法 JSON（用 `ConvertFrom-Json` / `ConvertTo-Json` 往返，别手改字符串）。
- 会话正文 `session.v4.jsonl.zstd` 是 zstd 多帧压缩，**不要**用编辑器或单次解压去改。
- `archivedSessionIds` 里的 ID 默认隐藏；搬完记得移除，否则还是看不到。
- `_sessions-quarantine-20261112\`、`*.bak-fix-*`、隔离区里的会话先**别删**，验收无误后再处理。
- 任何批量操作前先做第 0 步备份；改动是可逆的，删除不是。

---

## 六、验收

1. 重启 DSH 后，目标工作区下出现预期数量的会话（标题、时间正确）。
2. 逐个打开，历史消息完整、不是空白。
3. 发一条消息能正常继续，且 `working directory` 指向期望的目录。
4. 确认无误后，再考虑清理备份与隔离目录。
