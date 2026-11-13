# chatsync 深度剖析与自研可行性评估

> 目的：判断「直接开发整合、不用它的代码」是否可行。
> 所有结论均来自本机实装源码（`chatsync@0.21.2`，约 1.9 万行 / 70 个文件）与真实运行数据，非文档摘抄。

---

## 一、这插件到底有多少人在用

先说结论：**小众但真实在用，作者活跃且专业，不是玩具项目。**

| 指标 | 实测值 | 判读 |
|---|---|---|
| GitHub stars | **22** | 小众。但 DSH 本身是新产品，这个量级正常 |
| forks | 3 | 几乎没人二次开发 |
| npm 近 7 天下载 | **1402** | 真实用户量远大于 stars |
| npm 近 30 天下载 | **3352** | 月活约千人级 |
| npm 版本数 | 7（0.20.2 → 0.21.2） | 迭代很快 |
| 首次发布 | 2026-10-23 | **仅 3 周前** |
| 最后发布 | 2026-11-06 | 5 天前，活跃 |
| 开放 issue | 4 | 数量少 |
| 已关闭 issue | **22** | 关闭率 85%，响应积极 |
| License | MIT | **可自由借鉴/改写** |

**关键判断**：

- 下载量 3352 vs stars 22 → **140:1 的比例**说明用的人多但不 star。这是典型的「工具型插件」，用户装完就用。
- issue 质量极高（见下），用户会读源码分析，说明用户群体技术水平不低。
- **MIT 协议**意味着：可以合法复制、修改、商用。

### 作者的坦诚度（这是个正面信号）

issue #21 里作者自己写：

> 我们找到并修复了一个符合这个现象的 bug，已合并到 main，但**还没有发布**……
> **工作区映射还没有做。** 你提到的这个功能本次没有实现。项目目录不在本机时，会话能归到项目，但打开继续仍受 #10 的限制。

愿意公开承认「功能没做」，说明维护是认真的。

### 但这个项目有个致命的时间属性

**3 周前才发布第一版。** 意味着：

- 没有经过长期生产验证
- API 可能还在变
- 你会持续遇到 bug（你已经遇到了）

---

## 二、多工作区跨机的历史 bug：已修，但 issue 还开着

这一节我最初写错了，读源码后**推翻了结论**，记录于此以免误导决策。

### issue #10（open）— 跨机工作区归并 + cwd 绝对路径

报告者（fengq33）读源码后的分析：

> `sync.js` 的 `unionMergeWorkspaceJson()` 用 `normPath(w.path) === normPath(tw.path)` 做同路径去重，比较的是**原始绝对路径**；而 `workspacePathOf()` 里那套跨机重映射并不参与这个比较。两台机器用户名不同，就永远匹配不上。

症状：会话显示「未分组」、打开报 `working-directory: directory does not exist`、需反复手工搬迁、两机都改过时另存同标题副本。

### issue #21（open）— 第二台接入后项目分组丢失

作者定位的原因：第二台首次接入时覆盖了共享登记表、第一台的项目被当成删除、cwd 不在本机的会话不触发自动重启。

### ⚠️ 但实测源码：这两个问题的修复**已在 0.21.2 里**

我核对了本机安装的 `engine/registry.js`，关键代码是：

```js
const projectedPath = w =>
  normPath(
    // An unmapped path from another OS stays its own key, never "null" shared by all.
    this.localWorkspacePathOverride(w.id) ||   // ← 本机路径覆盖优先
    this.workspacePathOf(w.path, cfg) || …,    // ← 跨机重映射参与比较
  );
```

这正是 issue #10 建议的「并集合并前先应用 remap」。

删除判定也不是「远端没有就当删除」了：

```js
// A missing registry membership alone is not a deletion. Only an explicit
// archive, a move to another project, or missing content removes a member.
const hasContent = id => localFiles.has(id) || remoteFiles.has(id);
const removedIds = new Set(
  previous.filter(id =>
    (!local.includes(id) || !remote.includes(id)) &&
    (wid === null ||
      !hasContent(id) ||                        // ← 内容还在就保留
      (!local.includes(id) && explicitlyMoved(ours, wid, id)) ||
      (!remote.includes(id) && explicitlyMoved(theirs, wid, id))),
  ),
);
```

这与 issue #10 的第 2 条建议完全对应：「登记缺失但会话文件仍存在时保留登记」。

**所以：issue 是开着的，但修复已进代码。** 作者在 #21 里说的「已合并到 main 但未发布」，实际上 0.21.2 就带上了。

### 修正后的判断

**多工作区的登记表合并，风险比我最初判断的低。** 你开到第 2、第 3 个工作区，大概率不会撞上「工作区被互相删掉」。

**但仍有真实限制**（作者原话）：

> **工作区映射还没有做。** 项目目录不在本机时，会话能归到项目，但打开继续仍受 #10 的限制。

区分清楚两件事：

| 能力 | 状态 |
|---|---|
| 工作区**登记**跨机合并（列表里能看到对方的工作区） | ✅ 已修 |
| 会话**归组**到正确工作区 | ✅ 已修（含路径投影） |
| 工作区目录**不存在时自动投影/迁移** | ❌ 未做 |
| 会话 `cwd` 在本机不存在时打开 | ❌ 仍报错，需手工处理 |

**结论**：如果你两台电脑把工作区放在**相同路径**（都 `C:\dsh\workspace1`），几乎不会遇到问题。如果路径不同，登记能对上，但**打开旧会话仍可能因为 `cwd` 不存在而报错** —— 这时用「项目文件保存位置」把路径映射对，或者手动迁移。

### 这同时说明一件事

我在上一版文档里断言「这些 bug 至今未修，你会撞上」是**错的**。教训：issue 的 open 状态不等于代码没修，必须核对实际安装的源码。

---

## 三、架构深度拆解

### 3.1 分层结构

```
lib/
├── index.js              # 插件入口，注册 21 个 HTTP 路由
├── client.js             # 前端 UI（4893 行，占全项目 26%）
├── sync.js               # 门面，转调 engine
├── engine/               # 同步引擎（核心）
│   ├── run.js            #   主流程编排（450 行）
│   ├── main-sync.js      #   主仓库同步
│   ├── workspace-sync.js #   工作区同步（702 行，最复杂）
│   ├── remote-repo.js    #   远端仓库创建/校验
│   ├── git-runner.js     #   git 子进程封装
│   ├── registry.js       #   工作区登记表合并
│   └── conflicts.js      #   冲突处理
├── merge.js              # 三方合并引擎（457 行，vmap 版本向量）
├── privacy.js            # 隐私扫描
├── scope.js              # 同步范围判定（974 行）
└── http/                 # HTTP 路由层
```

**代码分布说明问题**：`client.js` 占 26%，纯 UI。真正的同步逻辑在 `engine/` 下约 3500 行。**核心复杂度不高，但周边处理（冲突、隐私、修复、迁移）占了 80%。**

### 3.2 核心机制一：影子仓库（Shadow Repo）

这是最巧妙的设计，也是理解全局的钥匙。

**问题**：用户的工作区 `C:\dsh\workspace1` 可能自己就是个 git 仓库，有自己的 `.git`、自己的 remote、自己的历史。

**如果直接在里面操作**，会污染用户的仓库，会冲突，会误提交。

**解决方案**：在 `.dsh` 下建一个独立的 git 目录，用 `core.worktree` 指向真实文件夹。

实测本机：

```
C:\Users\mengf\.dsh\workspace-repos\ea25cbf4-...-7c5c23dac638.git\
    config:
        bare = false
        worktree = C:\Users\mengf\.dsh\.chatsync-local\project-views\74f96...\tree
        url = https://github.com/mengfanchun2017/dsh-chatsync
```

关键代码（`engine/workspace-sync.js` L112-150）：

```js
async ensureWorkspaceMirror(id, realPath, cfg) {
  const gitdir = this.workspaceGitDir(id);   // .dsh/workspace-repos/<id>.git
  const branch = this.workspaceBranchOf(cfg, id);

  if (!fs.existsSync(gitdir)) {
    await this.git(['init', '--bare', gitdir]);
    await checked(['symbolic-ref', 'HEAD', 'refs/heads/' + branch]);
  }

  const want = {
    'core.bare': 'false',
    'core.worktree': realPath,
    'core.autocrlf': 'false',
    'core.longpaths': 'true',      // ← Windows 长路径
    'core.safecrlf': 'false',
    'commit.gpgsign': 'false',     // ← 不触发 GPG 签名（无人值守）
    'user.name': cfg.gitUserName,
    'user.email': cfg.gitUserEmail,
  };
  // ...
  want['credential.helper'] =
    provider === 'github' && (await this.ghAvailable())
      ? '!gh auth git-credential'      // ← 复用 gh 登录态
      : nativeCredentialHelper();
  want['remote.origin.fetch'] =
    '+refs/heads/' + branch + ':refs/remotes/origin/' + branch;  // ← 只 fetch 自己那条分支
}
```

**逐行解读**：

| 配置 | 为什么必须这么设 |
|---|---|
| `init --bare` 然后 `core.bare=false` | 先建裸库拿到干净结构，再改回非裸模式 |
| `core.worktree = realPath` | **核心**：让 git 认为工作区在真实目录 |
| `core.autocrlf=false` | 禁用换行转换。否则 Windows↔mac 会全文件「脏」 |
| `core.longpaths=true` | Windows 260 字符路径限制 |
| `commit.gpgsign=false` | 无人值守提交绝不能等密码输入 |
| `credential.helper = gh auth git-credential` | **复用 gh CLI 的登录**，不自己管 token |
| `remote.origin.fetch` 限定单分支 | 一个仓库几十个工作区分支，全 fetch 会很慢 |

**对我设计新插件的启示**：这套「影子仓库 + worktree + 只 fetch 单分支」的做法**必须抄**。它解决了「不能污染用户仓库」和「无人值守」两个硬问题。

### 3.3 核心机制二：多工作区 = 多分支

```js
workspaceBranchOf(cfg, id) {
  return (cfg.workspaceBranchPrefix || 'ws') + '/' + id;
}
```

**硬编码：一工作区一分支。** 无法改成子目录。

仓库实际布局（实测）：

```
main                                  ← 会话 + 配置 + 工作区登记表
ws/ea25cbf4-a5c7-4446-abb0-7c5c23dac638  ← workspace1 的文件（3d-forge/）
chatsync-device/fdab9463-082c-4efc-ac43-65424ac7a22f  ← 设备回执
```

**设计意图（合理之处）**：
- 工作区之间隔离。A 工作区冲突不影响 B
- 每条分支只 fetch 自己，快
- 单工作区出错不会拖垮整体

**设计缺陷（你的痛点）**：
- 分支名是 UUID，**光看分支认不出是哪个工作区**
- 必须去 `main:storages/workspace.json` 对照
- GitHub 上无法一眼看全所有工作区
- 无法跨工作区搜索

**这是我认同你的地方：确实不好检查。**

### 3.4 核心机制三：vmap 版本向量三方合并

这是整个项目技术含量最高的部分，`merge.js` 457 行。

**为什么不能直接用 git merge**：`settings.json`、`workspace.json` 是 JSON，两个变化可能在不同字段。git 按行合并，会把整个文件当冲突（同一行被两边改）。

**方案**：给每个字段记录逻辑时钟（Lamport clock 风格），做字段级合并。

```js
export function mergeVmap(a, b) {
  const fields = {};
  const keys = new Set([...Object.keys(A.fields || {}), ...Object.keys(B.fields || {})]);
  for (const k of keys) {
    const ca = A.fields[k], cb = B.fields[k];
    if (ca && cb) fields[k] = cmpClock(ca, cb) >= 0 ? ca : cb;  // 谁新取谁
    else fields[k] = ca || cb;
  }
  return { format: 1, path: A.path || B.path || '', fields };
}
```

合并策略分四档（`mergeJsonByVmap`）：

```js
// 1. 标量叶子：两侧相同 → 直接返回（无变化）
if (deepEqual(ours, theirs)) return ours;

// 2. 都有版本图 → 比时钟（LWW：Last Write Wins）
if (cO && cT) return cmpClock(cO, cT) >= 0 ? ours : theirs;

// 3. 只有一侧改过 → 取改过的那侧
if (cO) return ours;
if (cT) return theirs;

// 4. 无版本图（引导期）→ base 感知三路合并
if (base !== undefined) {
  const oChanged = !deepEqual(ours, base);
  const tChanged = !deepEqual(theirs, base);
  if (oChanged && !tChanged) return ours;
  if (!oChanged && tChanged) return theirs;
}
return ours;   // 都改了 → 确定性取本侧
```

**关键细节**：`deepEqual` 是**顺序不敏感**的（map 忽略键序、数组保留项序）：

> 顺序不敏感深比较:map 忽略键序、数组保留项序(避免 key 重排导致假「已变更」)

这个细节很重要。JSON 序列化时键序可能变，如果不忽略，会误判「已修改」。

**对我设计新插件的启示**：**这套合并逻辑最值得借鉴，但也是最难自己实现的。** 如果自研，要么抄这段代码（MIT 允许），要么简化成「整文件 LWW」（会丢改动）。

### 3.5 核心机制四：会话日志的帧级合并

DSH 会话是 `session.v4.jsonl.zstd` —— **zstd 压缩的 JSONL**。

chatsync 不用解压整个文件，而是**按 zstd 帧切分并合并**：

```js
export function zstdFrameEnd(buf, offset)      // 定位帧边界
export function decodeZstdFrames(buf, maxOutputBytes)  // 逐帧解码
export function mergeSessionLog(oursBuf, theirsBuf)    // 帧级合并
```

**为什么这么做**：会话文件可能几十 MB。整文件解压再合并会爆内存。帧级处理是流式友好。

（我这次排查密钥时遇到的问题也印证了这点：单次 `zstdDecompressSync` 只解第一帧，得到 199 字符；必须逐帧解才有 1290 万字符。chatsync 早就处理了这个。）

### 3.6 核心机制五：隐私扫描（拦不住，只提示）

`privacy.js` 291 行，规则是正则匹配：

```js
const record = (reason, pattern, example) => {
  for (const match of text.matchAll(pattern)) { /* ... */ }
};
record('疑似明文凭据字段', ...);
```

**关键行为**：`lib/engine/run.js` 里有一行注释非常关键：

> `// Possible secrets are a notice only: the upload already went ahead.`

**即：检测到疑似密钥时，数据已经传上去了，只给你提示，不阻断。**

这解释了我们的遭遇：密钥被推上 GitHub，同步只返回 `ok:false` 加一句提示，**但数据已经在远端了**。

**这是个设计缺陷**（对安全敏感场景）。正确做法应该是「上传前扫描，命中则阻断」。

### 3.7 数据流全景

```
┌─────────────────────────────────────────────────────────┐
│ 用户触发同步                                              │
└───────────────────┬─────────────────────────────────────┘
                    ↓
        ┌───────────────────────┐
        │ engine/run.js 编排    │
        └───────────┬───────────┘
                    ↓
   ┌────────────────┴────────────────┐
   ↓                                 ↓
【主仓库流程】                    【工作区流程】
main-sync.js                     workspace-sync.js
   ↓                                 ↓
1. bootstrapRemote              1. 遍历 workspace.json
   (校验私有/权限)                 2. 每个工作区:
2. ensureRepo                     - ensureWorkspaceMirror
   (origin/ignore/配置)            - projectFiles(扫描+排除)
3. fetch                          - 写入影子仓库 tree
4. 三方合并 (merge.js)            - commit
   ├ settings.json (vmap)         - fetch origin ws/<id>
   ├ workspace.json (并集)        - push
   └ sessions/*.zstd (帧级)
5. commit + push
6. handoff (设备回执)
                    ↓
        ┌───────────┴───────────┐
        │ 同步后自查            │
        │ - 未分组会话补登记     │
        │ - 必要时重启宿主       │
        └───────────────────────┘
```

### 3.8 最脆弱的三处（按实测源码修正）

⚠️ 本节最初版本只看了 issue 描述就下结论，与实测代码不符，已改正。

**① 工作区登记表合并（`engine/registry.js`）— 已加固**

旧版的逻辑确实危险：

```js
const removedIds = previous.filter(id =>
  !local.includes(id) || !remote.includes(id));   // 远端没有就当删除
```

但 0.21.2 的实际代码已经改成「内容还在就保留 + 必须显式迁移才算删除」：

```js
const hasContent = id => localFiles.has(id) || remoteFiles.has(id);
// A missing registry membership alone is not a deletion.
const removedIds = new Set(previous.filter(id =>
  (!local.includes(id) || !remote.includes(id)) &&
  (wid === null || !hasContent(id) || …explicitlyMoved…)));
```

**风险等级：低。** 第一台的工作区不会因为第二台首次接入而被删掉了。

**② 路径比较 — 已改为投影后比较**

旧版用 `normPath(w.path)` 直接比原始绝对路径。现在比较的是 `projectedPath()`：

```js
const projectedPath = w =>
  normPath(this.localWorkspacePathOverride(w.id) || this.workspacePathOf(w.path, cfg) || …);
```

路径重映射、本机覆盖都参与去重。**风险等级：低。**

**③ 会话 cwd 是绝对路径 — 仍未解决**

`session.v4.jsonl` 顶部的 `cwd` 是创建时的绝对路径。同步到另一台，若该路径不存在 → `working-directory: directory does not exist` → 会话打不开。

**作者明确承认这个没做**（issue #21）：

> **工作区映射还没有做。** 项目目录不在本机时，会话能归到项目，但打开继续仍受 #10 的限制。

**风险等级：高（唯一真正遗留的）。**

**缓解办法**：两台电脑把工作区放在**相同路径**（都 `C:\dsh\workspace1`），此问题基本不触发。路径不同时，用「项目文件保存位置」显式映射，或手动迁移会话。

---

## 四、自研整合的可行性评估

### 4.1 如果完全自研，需要重写什么

| 模块 | 难度 | 说明 |
|---|---|---|
| 影子仓库管理 | ★★☆ | 已看清做法，可复现 |
| git 子进程封装 | ★★☆ | 常规 |
| vmap 三方合并 | ★★★★★ | **最难**。457 行，边界极多 |
| zstd 帧级会话合并 | ★★★★☆ | 需要理解 zstd 帧格式 |
| 工作区登记表合并 | ★★★★☆ | 正确性极难保证（首版确实出过 bug） |
| 隐私扫描 | ★★★☆☆ | 正则，可简化 |
| 冲突处理与恢复 | ★★★★☆ | 大量边界情况 |
| UI（4893 行） | ★★★☆☆ | 工作量大但机械 |
| **合计** | **约 1.5–2 万行** | |

**关键判断：为了「工作区用子目录」这一个需求，重写 1.5 万行不值得。**

### 4.2 三条可行路线

#### 路线 A：继续用 chatsync + 我加「工作区对照表」视图（推荐）

**做法**：在 `dsh-synchub` 里加一个只读视图，列出：

```
工作区        名字        ID 前缀    分支                                  本机路径
workspace1   workspace1  ea25cbf4   ws/ea25cbf4-...-7c5c23dac638        C:\dsh\workspace1
workspace2   3D项目      7f3a1b2c   ws/7f3a1b2c-...                     C:\dsh\workspace2
```

**工作量**：半天。
**收益**：解决「看不懂」这个真实痛点。
**风险**：零（只读）。
**遗留**：多工作区跨机的 bug（issue #10/#21）仍存在，但那是 chatsync 的 bug，等作者修。

#### 路线 B：自研专用插件（用子目录布局）

**做法**：自己写一个插件，走 GitHub API 直接读写文件，布局用：

```
main
├── sessions/          ← 会话
├── config/            ← 配置
└── workspaces/
    ├── workspace1/    ← 工作区 1（名字可读）
    ├── workspace2/
    └── workspace3/
```

**工作量**：1.5–2 万行，数周。
**收益**：结构直观，完全可控。
**风险**：高。合并逻辑、冲突处理、会话格式解析都要自己踩坑。

**但有个大幅简化空间**：如果**放弃「同一工作区两台同时编辑」**（你实际不会这么做），就可以：
- 不用 vmap，不用帧级合并
- 用「最后同步的机器覆盖」策略（`--force` 式）
- 代码量降到 3000–4000 行

**这是关键洞察：你的实际需求不是「并发合并」，而是「接力」—— 在这台做完，去那台接着做。**

issue #10 报告者也提到这点：

> 同一会话两边都改过时会另存一份同标题、同轮数的副本

也就是说，**chatsync 为了处理「两边同时改」付出了巨大复杂度**，而你根本不需要这个能力。

#### 路线 C：混合（我认为最优）

1. **照片、文档、小文件**：继续 chatsync（成熟，别重造）
2. **工作区代码结构可视化**：我在 synchub 里加对照表（路线 A）
3. **如果 chatsync 的 bug 真的挡路**：我写一个**只做工作区**的轻量插件（约 3000 行），用子目录布局 + 接力式覆盖，**不碰会话品牌**（会话仍归 chatsync）

这样风险分散，每个模块都简单。

---

## 五、结论与建议

### 技术结论

1. **chatsync 架构是对的。** 多工作区跨机曾经是它最弱的部分，但 0.21.2 已包含关键修复（路径投影去重、内容存在性判定）。
2. **代码质量不差**：分层清晰，关键机制（影子仓库、vmap 合并、帧级合并）都有真实工程思考。
3. **MIT 协议**，可以合法借鉴任何部分。
4. **但只有 3 周历史**，仍有未覆盖的场景 —— 唯一确定遗留的是「cwd 不在本机时会话打不开」。
5. **多分支布局是你唯一真实的不满**，而它不是 bug，是设计选择，且有它的道理（工作区间隔离）。

### 关于「是否自研整合」

**我的建议：不要为了换布局而重写全部。**

理由：
- 你的核心需求是**接力式同步**（A 做完 B 接着做），不是**并发合并**
- chatsync 80% 的复杂度花在「并发合并」上，那部分你不需要
- 但它的「会话格式解析 + 冲突恢复 + 帧级解压」是硬骨头，重写会踩同样的坑（我这次排查密钥时就踩了 zstd 多帧的坑）

### 推荐路径

**第一步（今天就能做）**：我在 `dsh-synchub` 里加**工作区对照表**，解决「看不懂分支」的痛点。零风险，只读。

**第二步（实际开第 2 个工作区验证）**：现在不必猜，直接开一个 `workspace2` 让它同步一次，看真实行为。
- 登记表合并已加固，大概率正常
- 重点看：另一台电脑能否看到两个工作区、会话归组是否正确

**第三步（如果确实要自研）**：只写工作区同步，约 3000 行，用子目录布局，接力式覆盖。**抄 chatsync 的影子仓库机制**（那部分很成熟），**不抄 vmap 合并**（你不需要）。

### 如果要自研，关键简化点

**你的场景不需要「并发合并」，只需要「接力覆盖」。**

chatsync 用 vmap 版本向量解决「两台同时改同一字段」，代价是 457 行极难维护的代码。但你的实际用法是：家机做完 → 同步 → 工作机接着做。**任何时刻只有一台在写。**

这意味着自研可以：
- 用「远端时间戳 + 本机时间戳」决定谁新，整文件覆盖
- 不需要字段级版本图
- 不需要帧级合并（会话文件整取整放）
- 冲突时保留 `backup/<时间戳>` 分支（这条 chatsync 做得好，照抄）

**代码量能从 1.9 万行降到 3000–4000 行。**

风险是：万一你真的两台同时编辑了，会丢改动。但可以用「同步前检查远端 mtime，变了就提示」来兜底。

### 如果自研，我要抄的清单

| 抄 | 不抄 |
|---|---|
| ✅ 影子仓库 + `core.worktree` 机制 | ❌ vmap 字段级合并（不需要） |
| ✅ `credential.helper = gh auth git-credential` | ❌ zstd 帧级合并（如果需要会话同步） |
| ✅ 只 fetch 单分支的 refspec | ❌ 复杂的冲突恢复流程 |
| ✅ `core.autocrlf=false` 等 Windows 适配 | ❌ 4893 行的 UI（重写更简单） |
| ✅ 隐私扫描的正则（但要改成**上传前阻断**） | |
| ✅ `.gitignore` 自动维护策略 | |

---

## 附录 A：实测环境数据

```
chatsync 版本      0.21.2
作者仓库          https://github.com/dpskk2/dsh-chatsync
License           MIT
本机 DSH          0.2.2-rc.1 (Desktop)
影子仓库位置      %USERPROFILE%\.dsh\workspace-repos\<workspaceId>.git
隔离副本位置      %USERPROFILE%\.dsh\.chatsync-local\project-views\<digest>\tree
配置文件名        %USERPROFILE%\.dsh\dsh-sync.json
```

本机实测影子仓库配置：

```
bare          = false
worktree      = C:\Users\mengf\.dsh\.chatsync-local\project-views\74f965811c27e545478a2109\tree
url           = https://github.com/mengfanchun2017/dsh-chatsync
```

注意：`worktree` 指向的是**隔离副本**，不是真实工作区 `C:\dsh\workspace1`。真实工作区的写入是同步后「应用」阶段做的。这是「先隔离验证，再落地」的两段式设计。

## 附录 B：主要源文件职责表

| 文件 | 行数 | 职责 |
|---|---|---|
| `client.js` | 4893 | 前端 UI（占全项目 26%） |
| `scope.js` | 974 | 同步范围判定（哪些文件同步/不同步） |
| `engine/workspace-sync.js` | 702 | 工作区同步（最复杂模块） |
| `data-health.js` | 655 | 数据健康检查 |
| `local-storage.js` | 586 | 本机存储管理 |
| `engine/run.js` | 450 | 同步主流程编排 |
| `engine/main-sync.js` | 435 | 主仓库同步 |
| `merge.js` | 457 | 三方合并引擎（vmap） |
| `engine/remote-repo.js` | 424 | 远端仓库创建/校验 |
| `engine/git-runner.js` | 419 | git 子进程封装 |
| `engine/registry.js` | 426 | 工作区登记表合并 |
| `privacy.js` | 291 | 隐私扫描（仅提示，不阻断） |

## 附录 C：这次排查中我犯的错（供后续参考）

1. **备份文件被同步**：我为清理密钥而创建的 `xxx.json.bak-<时间戳>` 落在被同步目录下，导致密钥**二次上传**。教训：清理敏感数据时，备份必须放到同步范围外。

2. **误判 `workspaceRemote` 为错误**：我最初认为工作区必须有 origin，但 chatsync 用影子仓库，不碰工作区自身的 `.git`。已修正自检逻辑。

3. **`zstdDecompressSync` 只解第一帧**：导致一开始看到 199 字符以为文件很小。必须逐帧解码。
