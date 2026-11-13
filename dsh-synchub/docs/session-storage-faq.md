# DSH 存储位置 / 未分组 / 合并行为 FAQ（实测）

> 2026-11-12 只读调研，未修改任何数据。证据来自本机文件与 `app.asar` 内实现源码。

---

## 1. 装在哪、数据在哪、是否只有当前用户

### 程序（安装）

```
C:\Users\franc\AppData\Local\Programs\DeepSeek Harness\
    DeepSeek Harness.exe        ← 246 MB，per-user 安装（LOCALAPPDATA，非 Program Files）
    resources\app.asar          ← 213 MB，全部实现代码
    resources\app.asar.unpacked\
    resources\runtime\          ← Node/Python/pnpm 运行时
```

**本机实测：这是「当前用户安装」，不是全局安装。**
`HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` 里有卸载项：

```text
DisplayName     : DeepSeek Harness
InstallLocation : C:\Users\franc\AppData\Local\Programs\DeepSeek Harness
DisplayVersion  : 0.2.2-rc.1
Publisher       : Hangzhou DeepSeek Artificial Intelligence Co., Ltd.
```

注意在 **HKCU**（当前用户），HKLM / WOW6432Node 下没有对应项。

**Q：如果是全局安装，就装在 `Program Files` 下么？**
是。Windows 的惯例是「per-machine 安装」→ `C:\Program Files\DeepSeek Harness`（或
`C:\Program Files (x86)\...`），卸载项写进 **HKLM**，安装时需要管理员权限。
但**安装目录与数据目录是两件独立的事**：即使程序装到 `Program Files`，
`DSH_HOME` 仍然默认落在 `%USERPROFILE%\.dsh`（每个用户各自一份），
不会因为「全局安装」就变成 `C:\ProgramData\...` 或所有用户共用一份会话。
想让多用户/多实例共用同一份数据，只能靠 `DSH_HOME`（或显式配置）指到共享目录，
并自行保证该目录对所有相关账户可写。


### 数据（DSH_HOME）

**优先级（源码 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`）：**

```
显式配置路径  >  $DSH_HOME  >  join(homedir(), ".dsh")
```

**「显式配置路径」具体是哪里？** 不是某个配置文件，而是**代码调用时传入的参数**
`resolveDshHome(configured, env)` 的第一个实参。源码里所有调用点都是各插件把自己的
`config.dshHome` 传进去（实测 13 处）：

```js
// @deepseek-ai/dsh-home-paths
function resolveDshHome(configured, env = process.env) {
  return resolveRoot(configured, env, "DSH_HOME", defaultDshHome); // → homedir()/.dsh
}
function resolveRoot(configured, env, envName, fallback) {
  const fromEnv = env[envName];
  return resolve(expandHomePath(
    configured ?? (fromEnv?.trim() ? fromEnv : fallback())   // 显式 > 环境变量 > 默认
  ));
}
```

| 优先级 | 来源 | 本机实际情况 |
|---|---|---|
| 1 显式配置路径 | 插件配置项 `dshHome`（如 `dsh-attachment-local` / `dsh-credentials-local` / `dsh-shell-env` / `dsh-skill-filesystem` / `dsh-agent-instructions` 的 `config.dshHome`），由 profile 的 `cordis.patch.yml` 等配置层注入 | 未设置（各调用点传 `config.dshHome`，本机为空） |
| 2 `$DSH_HOME` | 进程环境变量（桌面端启动时注入给子进程） | `C:\Users\franc\.dsh` |
| 3 默认 | `join(homedir(), ".dsh")` | 同样是 `C:\Users\franc\.dsh` |

即：**本机三处收敛到同一个目录**。另外 `expandHomePath` 支持 `~` / `~/` / `~\` 前缀，
空字符串或全空白的 `$DSH_HOME` 视为未设置（防止误把家目录解析成当前工作目录）。
还有个独立的 `DSH_AGENTS_HOME` → 默认 `~/.agents`，与 DSH_HOME 无关，别混。


本机环境变量实测：

| 变量 | 值 |
|---|---|
| `DSH_HOME` | `C:\Users\franc\.dsh` |
| `DSH_PROFILE` | `desktop` |
| `DSH_PROFILE_DIR` | `C:\Users\franc\.dsh\profiles\desktop` |
| `DSH_SESSION_ID` | `session-55539f32-...`（当前会话） |
| `DSH_WEB_URL` | `http://127.0.0.1:57960` |

本机 `homedir() = C:\Users\franc`，所以默认就是 `C:\Users\franc\.dsh`——`DSH_HOME` 只是显式写成了同一个值。

```
C:\Users\franc\.dsh\
    sessions\                 ← 会话正文（按工作区路径编码分目录）
    storages\workspace.json   ← 工作区 / 会话归属 / 归档 / 置顶登记表
    storages\session_projcache\sessions\  ← 每会话投影缓存（标题、cwd 等）
    storages\dsh-context\overview-cache.v1.json
    attachments\v1\objects\<前2位>\<sha256>   ← 全局内容寻址附件池
    profiles\desktop\         ← 当前 profile 的插件依赖
    plugins\ skills\ dsh-market\ dsh-runtimes\ mobile-access\
    .credentials.yaml  .trae-auth.*.json  .workbuddy-*.json   ← 凭据
    .anonymous-user-id
```

### 是的：只有当前用户，不是全部用户

- 安装目录在 `%LOCALAPPDATA%\Programs\`（per-user，不是 `C:\Program Files`）。
- 数据目录在 `%USERPROFILE%\.dsh`（homedir），不是 `C:\ProgramData`，也不是 `C:\Users\Public`。
- `C:\Users\` 下只有 `franc` 一个真实用户，`C:\ProgramData` 里没有任何 dsh 目录。
- GUI 的 Electron 临时状态在 `%APPDATA%\@deepseek-ai\dsh-desktop\`（同样 per-user）。

**含义：换 Windows 账户登录，就是一套全新的空数据；`DSH_HOME` 可以让多个账户/多份实例共用同一数据目录。**

### `DSH_PROFILE=desktop` 要不要管？备份时怎么办？

**结论：不用手工管理，不用新建，一直用 `desktop` 就对；但备份时建议一起带上。**

实测与源码依据：

- `DSH_PROFILE` / `DSH_PROFILE_DIR` 是桌面端启动时自己注入的（本机 = `desktop`），
  `resolveProfileDir(name, home = resolveDshHome())` → `$DSH_HOME/profiles/<name>`。
- `profiles\` 下已有 `desktop`、`ragui`、`sdk`、`web` 四个；`desktop` 是桌面端默认那一个。
- `initProfile()` 的语义是「**仅当 `package.json` 不存在时**才按模板创建，已存在的文件一律不碰」
  （源码注释：*Existing files are never touched, so re-running is a no-op on an initialized profile.*）。
  所以 DSH 每次启动都复用同一个 `desktop`，**不会重建、不需要你新建**。
- 它装的是「插件清单 + 配置层」，不是会话数据：

```text
profiles\desktop\
    package.json          ← dsh.profile.bundles（装了哪些插件）+ dependencies
    cordis.patch.yml      ← 55 KB 的实际配置层（含大量 .bak-* 备份）
    pnpm-lock.yaml / pnpm-workspace.yaml
    node_modules\         ← 插件本体（billion-context、dsh-better-sidebar、dsh-context…）
    .dsh-market\ .plugin-manager\ pixel-studio\
```

  注意 `package.json` 里有几条 `link:C:/dsh/...` 和
  `link:C:/Users/franc/Documents/deepseek-harness/default-workspace/...` 的**本地绝对路径插件**，
  换机到不同路径时会失效——这属于插件配置问题，与会话/cwd 是同一类「绝对路径」坑。

| 问题 | 答案 |
|---|---|
| 要手工管理吗 | 不需要。别手动改 `DSH_PROFILE`，也别新建 profile |
| 一直用 `desktop` 对吗 | 对。保持默认即可，DSH 自动复用 |
| 备份时要带过去吗 | **建议带**（连同 `plugins\`、`skills\`）：B 机才能有同样的插件与设置。但它**不是会话数据**，不带也不会丢任何一条聊天记录 |
| 能直接整目录覆盖 B 机的 `desktop` 吗 | 谨慎。B 机若已有自己的插件配置，整目录覆盖会丢；且上面那些 `link:` 绝对路径在 B 机上可能不存在。新机器若是干净的，直接拷过去最省事 |
| 最简备份清单 | `sessions\` + `storages\` + `attachments\`（会话必需）＋ `profiles\desktop\` + `plugins\` + `skills\`（环境可选）＋ 排除 `.credentials.yaml` 等凭据 |

> 补充：`$DSH_HOME/cordis.patch.yml`（家目录级的全局 patch 层）如果存在也会生效，
> 它在 `profiles\` 之外，别漏。本机未发现该文件。

---

## 2. "未分组" 是什么、存在哪里、是不是你自己改的

### 结论：不是真实工作区，是 UI 动态算出来的桶，没有独立存储

源码 `dsh-client-ui-workspace/lib/client.js`：

```js
function groupingGroupKey(workspaces, sessionId) {
  return workspaces.find(w => w.sessionIds.includes(sessionId))?.workspaceId ?? "";
}
// groupByWorkspace():
// 遍历所有 workspace 的 sessionIds -> accounted
const stray = list.ids
  .map(id => list.byId[id])
  .filter(s => s && !accounted.has(s.id) && sessionVisible(...));
if (stray.length > 0)
  groups.push(buildGroup("", void 0, void 0, void 0, "", orderedUngrouped(stray, ...)));
```

即：**`workspaceId = ""` 的虚拟分组**。会话只要"存在但不在任何 workspace 的 `sessionIds` 里"就落进这里。
它唯一的持久化痕迹只是浏览器本地的排序偏好 `ungroupedOrder` / `sessionOrderByAccount[""]`（`Local Storage`），**不是数据**。

中文文案也直说了（同文件 i18n）：

> `delete.desc`: 将把"{name}"从工作区列表中移除。文件夹与会话记录会保留，**其会话将显示在"未分组"下**。

所以：**删除/移除一个工作区 ≠ 删除会话**，会话全部掉进"未分组"。

### 是不是你自己改的 —— 是，有直接证据

从 `session_projcache` 里翻到你以前的会话记录：

| 会话 | 内容 |
|---|---|
| `session-921d1838-...` | 你的提问"我未分组是还有很多对话记录，不是应该默认在我**改过名字的 default** 么。删除未分组的所有内容没用了…"；回答里写"**未分组：148 条已分类处理，不是删，是搬走（可回滚）**"，分类为「A 测试产物（`test-*`、`session-multi-*`…）」等 |
| `session-81770930-...` | 同样这句提问 |

也就是说你（或让 AI）做过一次 148 条的大规模重分类，把会话从"未分组"搬到了具名工作区/归档。
本机现状也吻合：物理 70 个 session 目录，登记 35 个，**35 个未登记 → 仍会显示在"未分组"**；
另有 20 个在 `archivedSessionIds` 里被隐藏；1 个在 `_sessions-quarantine-20261112\`。

### 关于 "default 改名"

`workspace.json` 里 default 工作区：

```json
"6e69a14b-...": {
  "path": "C:\\Users\\franc\\Documents\\deepseek-harness\\default-workspace",
  "title": "default",              ← 显示名
  "sessionIds": [ 29 条 ]
}
```

- `title` 只是**显示名**，可以随便改，不影响 `path`。
- 从 10-26 的两份备份到 11-11 的 `bak-fix-20261112` 再到今天，`path` 一直是
  `C:\Users\franc\Documents\deepseek-harness\default-workspace`，`title` 一直是 `default`，`defaultWorkspaceId` 也一直是 `6e69a14b-...`。
- 所以"改过名字"指的就是改 `title`（或者指你在 UI 里看到的那个名字），**路径没动**。
  这也解释了为什么"应该有默认"和"实际在未分组"对不上：改名不会把已有会话重新归类；
  会话归属只看 `sessionIds`，不看名字。

> 附：`bootstrap()` 还有一段**自动归并**逻辑，会按每个 session 头部的 `cwd` 重新分组、把没登记的会话并回对应工作区，cwd 找不到对应工作区时甚至会自动新建一个工作区（`title = basename(cwd)`）。所以"未分组"在某些启动后会被自动消化一部分——但 cwd 不存在的会留在 `missingSessionPaths` 里。

---

## 3. A 的 default 导出 → B 的 default 导入：覆盖还是叠加？

**分两层，答案不同：文件层是"按 ID 叠加 + 同名冲突"，登记表层取决于你怎么导入。**

### 会话文件层：按 sessionId（UUID）寻址，天然是并集

- 每个会话是 `sessions\<编码目录>\<sessionId>\session.v4.jsonl.zstd`。
- `sessionId` 是随机 UUID（`session-xxxx` 或裸 UUID），两台机器独立生成，**碰撞概率可忽略**。
- 所以把 A 的 `sessions\` 拷进 B 的 `sessions\`，只要目录名（路径编码）对得上，**就是叠加**，不会覆盖 B 已有的任何会话。
- 只有当两台机器出现**同一个 sessionId**（例如之前同步过、或从同一份拷贝派生）时才有冲突：
  谁后写谁覆盖，或者按文件 mtime 取新的——这是文件复制语义，不是 DSH 的业务逻辑。

### 登记表层：这一步才决定"覆盖 or 叠加"

| 导入方式 | 结果 |
|---|---|
| **直接拿 A 的 `workspace.json` 覆盖 B 的** | ❌ **覆盖**：B 的其它工作区、`archivedSessionIds`、置顶、排序全丢，且 A 里记录的 `defaultWorkspaceId`/`path` 是 A 的路径，在 B 上可能不存在 |
| **手工合并（推荐）** | ✅ **叠加**：并集 `workspaceIds`、`workspaces` 各条 `sessionIds`、`archivedSessionIds`、`pinnedSessionIds`；并把 A 的 `path` 改写成 B 上的真实路径 |
| **什么都不改，只拷文件** | 文件在，但归属没登记 → 这些会话落到 **"未分组"**（`bootstrap()` 可能按 cwd 自动归一部分，见下） |

### 名字相同 ≠ 同一个工作区

工作区的身份是 **UUID（`workspaceId`）**，不是 `title="default"`，也不是"默认"这个语义。
A 的 default 是 `6e69a14b-...`，B 的 default 大概率是另一个 UUID。
`global.defaultWorkspaceId` 只是"新建会话时落到哪"的指针，不参与合并匹配。

**所以不要按"两个都叫 default 就合并"来想**，要按 UUID + 路径来判断。最稳的做法是：
在 B 上把 A 的会话并入 B 已有的那个 default 工作区（用 B 的 workspaceId），而不是再建一条 default。

---

## 4. 目录不同（A: `C:\default`，B: `D:\dsh\default`）合并后，B 在 A 的会话里继续对话有没有影响？

**有影响，而且不止一处。目录路径是"硬绑定"的，不是无关紧要的显示信息。**

源码里三道关卡都拿 `fs.realpath` 规范化后的绝对路径做比较：

1. **session 目录名**：由工作区绝对路径编码而来。
   A 的 `--C-default--` 拷到 B 必须改名成 `--D-dsh-default--`，否则 B 的 `sessionPersistence.list()` 扫不到（或归错组）。

2. **`workspace.json` 的 `path`**：必须改成 `D:\dsh\default`。
   源码 `workspaceDomainSpec` 的校验里明确：`path 'X' is claimed by both workspace A and B` 会直接抛错——同路径不能登记两次。

3. **会话头部的 `cwd`（最关键）**：`WorkspaceRegistry.attachSession()`：

   ```js
   cwd = await realpathNormalize(header.cwd);          // A 的 C:\default
   if (!(await stat(cwd)).isDirectory()) throw ...
   if (cwd !== this.record.path) throw new Error(     // 必须等于 B 工作区 path
     `cannot attach session ...: its cwd resolves to '${cwd}'`);
   ```

   以及 `indexHeader()`：cwd 是 `ENOENT` 就进 `missingSessionPaths`；
   `reportFilteredCandidates()` 会打日志 `canonical cwd '...' differs from workspace path '...'` 并把该会话**从成员里过滤掉**。

   同时 `WorkspaceEntity.sessionIds` getter 是
   `record.sessionIds.filter(id => candidateMatches(id, record.path))` —— 即使登记表里写了归属，
   cwd 对不上时 UI 也会把它滤掉（表现为"看不到 / 空白"）。

### 实际后果

| 场景 | 结果 |
|---|---|
| 只改登记表、不改目录编码 | 会话扫不到，或落到"未分组" |
| 只改目录编码、不改 `path` | 工作区指向 A 的路径（B 上不存在）→ 创建/打开报错 |
| 上面都改了，但 **cwd 仍是 `C:\default`** | 历史消息**能读**（日志是纯记录），但：① `bootstrap()` 按 cwd 分组会认为它属于 `C:\default`，可能**自动新建一个工作区**把会话归过去，或把它从你期望的 default 里过滤掉；② 一旦"继续对话"，所有相对路径/文件操作、`@file` 引用、工具的工作目录都按旧 cwd 解析 → 落到不存在的 `C:\default`，报 `working-directory: directory does not exist` |
| 把工作区文件也迁移到 B，但放在不同路径 | 文件内容没问题（git 照常），但 session 里记录的**历史工具调用路径、展示用的绝对路径**仍是 A 的，看起来"路径过期" |

### 怎么消除影响 —— **已选定：方案 1（相同绝对路径）**

> 决策（2026-11-12）：本次迁移**采用方案 1**，不再考虑 junction / 改写 cwd。
> 做法：让 A、B 两台机器上的工作区落在**完全相同的绝对路径**，
> 例如两边都是 `C:\dsh\workspace1`（或两边都是 `C:\default`）。
> 这样 session 目录编码、`workspace.json.path`、会话头部 `cwd` 三处天然一致，
> **零改造、零风险**，也不需要 `bootstrap()` 去补救。

方案 1 的具体要求：

| 项 | 要求 |
|---|---|
| 盘符与完整路径 | 必须逐字符相同（Windows 大小写不敏感，但建议连大小写都一致） |
| A 机工作区 | 例：`C:\dsh\workspace1` |
| B 机工作区 | **同名同路径**：先把 B 上现有目录挪走/改名，再把解压出来的文件夹放到 `C:\dsh\workspace1` |
| `.dsh\sessions\` 目录名 | 两边自动都是 `--C-dsh-workspace1--`，**不用重命名** |
| `workspace.json` 的 `path` | 两边都是 `C:\dsh\workspace1`，**不用改写** |
| 会话 `cwd` | 两边都能 `realpath` 成功且等于 `record.path`，**不会被 `candidateMatches` 过滤** |
| 附件池 | `attachments\v1` 整个拷过去即可（引用是 sha256，与路径无关） |

因此方案 1 下的导入清单可以简化为：

```text
A 机 %USERPROFILE%\.dsh\  →  B 机 %USERPROFILE%\.dsh\
    sessions\                 直接拷（目录编码已一致）
    storages\                  workspace.json 做「并集合并」，不是整文件覆盖
    attachments\v1\           整个拷
    profiles\desktop\ 等       可选（插件环境）
    排除 .credentials.yaml / .trae-auth.*.json 等凭据
工作区文件夹  →  B 机放到与 A 完全相同的绝对路径
```

> 仅当未来确实无法让两台机器路径一致时，才回退到下面两个备选（本次不用）：

2. **（备选，不采用）在 B 上让 A 的路径「存在」**，用目录联接指向真实目录：

   ```powershell
   New-Item -ItemType Directory -Path 'C:\default' -Force     # 造出 A 的旧路径
   cmd /c mklink /J 'C:\default' 'D:\dsh\default'
   ```

   这样 `realpathNormalize('C:\default')` 能成功、且解析后与工作区 path 一致，旧 cwd 不用改。
   （注意：`realpath` 会把 junction 解析成目标真实路径，所以工作区 `path` 要和解析后的一致。）
3. **（备选，不采用）改 zstd 日志里的 cwd** —— 不推荐。`session.v4.jsonl.zstd` 是 zstd 多帧压缩，必须逐帧解码→改 JSONL→重新压缩，还要同步改 projcache 里的 `cwd`/`workingDirectory`/`identity.path`，风险高。

> 采用方案 1 后，上表「实际后果」里那些路径不一致的分支**全部不会触发**。

> 你已经验证过"工作区迁移"（文件搬过去了），但**目录路径不同这件事本身是有影响的**，影响不在文件内容，而在 session 头部的 cwd 与工作区唯一性 canon。这正是 chatsync issue #10/#21 里作者承认"工作区映射还没做"的那一项。

---

## 5. 附件是不是统一目录？怎么找到的

**是，一个全局、跨工作区共享的内容寻址池。**

### 定位过程

1. 先看 `.dsh` 根目录，发现 `attachments\v1\`，里面是 `objects\<2位十六进制>\<64位十六进制字符串>` 这样的文件，
   **无扩展名、只读属性 `-r--`、共 45 个**——典型的按哈希分片的对象存储，不像"每会话一个文件夹"。
2. 在 asar 里抽出 `@deepseek-ai/dsh-attachment-local/lib/index.js`，源码注释直接写
   `absolute DSH_HOME/attachments/v1 root`，并有：

   ```js
   const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
   function targetFor(root, ref) {
     const sha256 = ensureReference(ref);
     return join(root, "objects", sha256.slice(0, 2), sha256);
   }
   ```

   以及 `publishImmutableObject()` 写入前用 `digest(data) !== sha256` 校验完整性。

### 结论

| 项 | 值 |
|---|---|
| 根目录 | `$DSH_HOME\attachments\v1\` |
| 对象路径 | `objects\<sha256前2位>\<完整sha256>`（图片归一化后） |
| 文件附件 | `files\<前2位>\<sha256>\<name>` + `file-objects\<前2位>\<sha256>` |
| 引用方式 | 会话日志里存 `attachmentId = "sha256:<64hex>"`，**不含绝对路径** |
| 作用域 | **全局唯一池，与工作区/会话无关**；相同内容只存一份，天然去重 |
| 临时区 | `v1\tmp\` |

**对同步的含义（好消息）**：附件引用是内容哈希，不是绝对路径，所以把 `attachments\v1\` 整个拷过去，
A 的会话在 B 上照样能找到附件，**不受工作区目录不同的影响** —— 这跟 cwd 正好相反。
但必须整个 `v1` 一起搬（或至少搬 `objects`/`files`/`file-objects`），只搬会话日志会导致附件丢失。

---

## 6. 一句话总结

- 程序在 `%LOCALAPPDATA%\Programs\DeepSeek Harness`（per-user；若全局安装则 `C:\Program Files\...`，但数据目录不变），数据在 `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`），**都是当前用户级**。
- `DSH_HOME` 优先级：插件 `config.dshHome` 显式配置 > `$DSH_HOME` > `~/.dsh`；本机三者都收敛到 `C:\Users\franc\.dsh`。
- `DSH_PROFILE=desktop` **不用管、不用新建、一直复用**；它不是会话数据，但备份时建议连同 `plugins\`/`skills\` 一起带（注意里面有 `link:` 绝对路径插件）。
- "未分组" = `workspaceId === ""` 的 UI 虚拟桶，来源是「会话存在但没登记进任何 `sessionIds`」；你之前做过 148 条重分类，本机现状仍有 35 个孤儿。
- 导入：**文件按 UUID 天然叠加；`workspace.json` 直接覆盖会丢数据，必须并集合并**；同名 `default` 不是同一个工作区，按 UUID + 路径认。
- **本次已选方案 1：两台机器工作区放完全相同的绝对路径** → session 目录编码、`workspace.json.path`、会话 cwd 三处天然一致，目录不同带来的影响全部不触发，无需 junction / 改写 cwd。
- 附件是 `$DSH_HOME\attachments\v1` 下的全局 sha256 内容寻址池，引用与路径无关，整目录搬走即可。
