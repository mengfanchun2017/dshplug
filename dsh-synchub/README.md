# dsh-synchub · 同步中心

把 DSH 的**会话、工作区、附件、技能、配置层**同步到你自己的私有 Git 仓库，
并用一个侧边栏面板把「现在能不能开工 / 该先拉还是先推 / 哪些目录动不得」讲清楚。

0.3 是一次**架构换代**：0.2 只是个「聚合别的插件状态」的转发层，
0.3 自己就是同步引擎——不再依赖 `chatsync` 和 `dsh-config-manager`。

> 源码由仓库 `C:\dsh\dshplug` 的 `list.json` 管理；安装用 `install.ps1`，
> 上线给另一台用 `plugpush.ps1`。详见仓库根 README。

---

## 1. 为什么换成「自己同步」

0.2 的做法是转发：会话交给 `chatsync`、配置交给 `dsh-config-manager`。
实际用下来有两个绕不过去的问题：

1. **两个插件各自实现了一遍搬运逻辑**，冲突裁决、快照回滚、跳过活会话……
   规则不一致，出问题时不知道是谁的锅。
2. `dsh-config-manager` 的 `localPluginPack` 会把 `link:` 插件 `npm pack` 成 tarball，
   导入时**重写 spec 为导入机的绝对路径**——它同步的配置和本仓库管理的插件清单会互相打架。

0.3 的答案：**插件源码仍归 `dsh-market` / 本仓库**，
**其余所有 DSH 状态由 `dsh-synchub` 用一个引擎同步**。
只有一套规则、一份历史、一个面板。

`chatsync` 已废弃，可以卸掉。

---

## 2. 两个通道，各自一个私有仓库

| 通道 | 装什么 | 为什么分开 |
|---|---|---|
| `config` | 技能文件、`profiles/<p>/cordis*.yml` 配置层 | 体积小、改动少、冲突要人看 |
| `sessions` | 会话日志、`storages`（工作区登记表）、`attachments` | 体积大、写入频繁，独立历史才不会把配置提交冲爆 |

两个通道**互相独立**：一个落后不影响另一个推送，一个坏了另一个照样能救。

### 为什么不放一个仓库

会话日志每次对话都在长，如果和配置同仓，
「我就想改个设置」也会连带产生一条几十 MB 的提交，
`git log` 变得不可读，回滚配置时还得挑拣。

### 为什么用 Git 而不是自己写 manifest

- `HEAD` 的树**就是**权威文件清单——不存在「清单与实际不同步」这种 bug
- 内容寻址自动去重（同一份附件、同一版技能不会存两遍）
- `--ff-only` 天然提供「落后就拒绝」的冲突检测
- 任何时刻可回滚到任意历史点
- 断网也只是推送失败，本地历史照常积累

---

## 3. 同步面分级：safe / caution / danger

不是所有东西都该同步，而且**「危险」是硬约束，不是一个可以勾掉的建议**。

```js
surfaceEnabled(surface, cfg) => Boolean(cfg.surfaces[surface.id]) && surface.tier !== 'danger'
```

### safe（默认开）

| id | 内容 | 说明 |
|---|---|---|
| `sessions` | `sessions/**` | zstd 多帧压缩的会话日志，目录名是工作区绝对路径的编码 |
| `storages` | `storages/**` | `workspace.json` 决定会话归属哪个工作区；`session_projcache` 存 `cwd` |
| `attachments` | `attachments/**` | sha256 内容寻址，与路径无关，跨工作区共享 |
| `skills` | `skills/**`、`skill-manager/**` | 技能文件本体；技能的**安装**仍走 dsh-market |

### caution（默认开，但要看一眼再开）

| id | 内容 | 为什么只是 caution |
|---|---|---|
| `profileConfig` | `profiles/<p>/cordis.patch.yml`、`cordis.yml` | 本机实测只含 `apiKeyEnv` 的**变量名**（`OFFICE_API_KEY` 等）和 baseURL，不含密钥。但 baseURL 是环境特有的，换网络可能连不上 |

### danger（**永远不同步**，不可开启）

| id | 内容 | 后果 |
|---|---|---|
| `profileManifest` | `profiles/<p>/package.json`、`pnpm-workspace.yaml` | 含 `link:C:/dsh/...` 绝对路径。另一台没有同一路径 → **DSH 启动失败** |
| `credentials` | `.credentials.yaml` | API key，进仓库即泄露 |
| `traeAuth` | `.trae-auth.*.json` | 设备令牌 |
| `workbuddy` | `.workbuddy-*.json` | 设备身份，应各机各自登录 |
| `mobileKeys` | `mobile-access/**` | iroh TLS 私钥，泄露即中间人 |
| `runtimes` | `dsh-runtimes`、`node_modules`、`.pnpm` | 可重建，数百 MB，跨平台失效 |
| `caches` | `plugins`、`pixel-studio`、`workbuddy-vault`、`dsh-market` | 本地缓存，重建即可 |
| `quarantine` | `_sessions-quarantine-*` | 疑似损坏的历史会话，留档用 |

插件清单不同步是刻意的：**插件由 `dsh-market` 管**，
而 `link:` 规格里的绝对路径本来就不能跨机搬运。

---

## 4. 三条硬规则

### 规则一：绝不「落后还写」

推之前先 `fetch`，落后就**拒绝**而不是强行合并：

```js
// ⚠ 顺序故意是「先 fetch 判落后 → 再 commit → 再 push」。
// 早先版本先 commit 再检查，落后时会先在本地凭空造一个分叉提交，
// 之后 ff-only 永远拉不下来 —— 只能人工 reset。
```

这是 0.3 开发中**真实踩到并修掉**的 bug：早期实现先 `commit` 再检查落后，
两台机器交替使用后 `HEAD` 与 `origin/main` 永久分叉，怎么拉都拉不动。

拉取用 `merge --ff-only`，永不 `rebase`、永不 `force`。
非快进时明确报「需要人工处理」，把选择权交给你。

### 规则二：覆盖和删除前一律备份

任何写回本机的动作，先把原文件复制到
`$DSH_HOME/dsh-synchub/backups/<timestamp>/<原相对路径>`。

删除（`prune`）同样备份——否则 prune 就是不可逆操作
（这也是开发中修掉的一个 bug：早期 prune 分支漏了 `backedUp += 1`，删了却不留底）。

**`prune` 默认关闭**，必须显式传才删。默认行为是「只增不删」：

> 在 B 上 pull 时如果远端删掉了一个会话，B 本地会保留它——
> 因为「远端没有」既可能是「A 删了」，也可能是「A 还没推」。
> 只有你确认后才用 `prune`。

### 规则三：绝不覆盖正在写的会话

`DSH_SESSION_ID` 指向的那个会话文件会被跳过（`skipActive`），
否则会把当前正在对话的日志覆盖坏。

---

## 5. 环境切换检测：知道「现在是谁的主场」

这是「过一段时间没操作就自动上传」和「切环境先拉一把」两个需求的落点。

### 机器身份怎么传播

**不用共享文件**。早期版本把 `synchub/machine.json` 提交进仓库，
结果两台机器每次都改同一个文件 → 每次推送都制造一个真分叉（正是规则一要防的东西）。

改用**提交消息尾注**：

```
synchub: FRANCIS-HOME-I7 @ 2026-11-12T04:35:20.468Z

Synchub-Machine: FRANCIS-HOME-I7
Synchub-At: 2026-11-12T04:35:20.468Z
```

各机器只写自己的提交，读时从 `origin/main` 的 `log` 里解析。
两个通道都查，取时间戳更新的那个——可能只有会话通道被推过。

### 状态机

```
statusPayload():
  stamp.machine === cfg.machine ?
    ├─ 是  → switched: false，正常待办
    └─ 否  → switched: true
              → 面板提示「远端最近由 <机器> 推送」
              → verdict 变成「先拉取远端」
```

`preflight()` 把它翻译成一句人话，五种结局：

| verdict | 触发 |
|---|---|
| 尚未配置 | 通道没配远端，或仓库没初始化 |
| 环境未就绪 | `DSH_HOME` 不存在 / git 不可用 |
| 先拉取远端 | 任一通道 `behind > 0`（**包括别人刚推过**） |
| 待推送 | 本地有未推的提交或未暂存的改动 |
| 可以开始工作 | 全部通道既不落后也没有待推 |

**「查过了没事」和「根本没查」必须分开**——这是贯穿全插件的原则。
`fetch` 失败时 `behind` 会保持旧值，所以 `channelState` 显式带一个
`fetched: false` 标记，界面显示「状态未知」而不是绿色勾。

> 开发中修掉的第三个 bug：早期 `channelState` 不 `fetch` 就读 `origin/main`，
> 看到的永远是上次 fetch 的旧快照，把「另一台刚推过」误报成「与远端一致」。
> 现在 `status` / `preflight` / `check` 全部传 `fetch: true`。

### 空闲自动上传

`idlePushMinutes`（默认 20 分钟）+ 5 分钟冷却。触发条件**全部**满足才动：

- 距上次本地改动超过阈值
- 有实际改动（不是空跑）
- **没有落后远端**
- 不在冷却期内

如果落后，它**刻意什么都不做**，只记录原因——
无人值守时最不该做的事就是替你制造分叉。

`autoPush` 默认关闭。

---

## 6. 目录一览（面板里能看到的就是这些）

`GET /api/dsh-synchub/map` 返回 13 行：6 个可同步面 + 7 个危险目录。
每行含 `paths / tier / syncOn / files / bytes / note / exists`。

危险目录默认**不统计大小**（`deep=1` 才算，且排除 `runtimes`/`caches` 这类几十万文件的目录）。
界面在未统计时显示 `—` 而不是 `0`——避免把「没数」看成「是空的」。

本机实测规模（`FRANCIS-HOME-I7`，2026-11-12）：

```
sessions         71 文件    52.8 MB
storages         73 文件     3.9 MB
attachments      45 文件     3.3 MB
skills           20 文件    47.3 KB
profileConfig     2 文件    55.7 KB
profileManifest   2 文件     1.4 KB   ← 不同步
```

---

## 7. 两台机器的前置条件

**工作区路径必须完全相同**（例如都在 `C:\dsh\workspace1`）。这不是洁癖，是三重依赖：

1. `sessions/<编码目录>/` 的目录名 = 工作区绝对路径的编码
   （`C:\dsh\workspace1` → `--C-dsh-workspace1--`）
2. `storages/workspace.json` 的 `tables.workspaces[id].path` 是绝对路径
3. 会话投影缓存里的 `cwd` / `identity.path` 是绝对路径

路径不同 → 会话能搬过去但**在界面上归不到任何工作区**，变成「未分组」孤儿。

> 「未分组」在 DSH 里不是独立存储，而是 `workspaceId === ""` 的 UI 派生桶，
> 所以它没有可同步的实体——只能靠路径一致来避免。

插件路径同样要一致：`link:` 规格把绝对路径写进 `profile/package.json`。

### 导入是**并集合并**，不是覆盖

这是 DSH 自己的语义，同步引擎必须顺着它：
所以 B 上多出来的会话不会因为 A 推了一版就消失，反之亦然。
也正因如此，`prune` 必须是显式动作。

---

## 8. API

全部挂在 `/api/dsh-synchub/*`，只监听 loopback，复用与 chatsync 同源的 origin/跨站 guard。

| 路由 | 作用 | 写本机？ |
|---|---|---|
| `GET /config` | 当前配置 | 否 |
| `GET /status` | 两通道 ahead/behind/dirty + 机器信标 | 否 |
| `GET /map?deep=1` | 目录一览 | 否 |
| `GET /preflight` | 开工检查（一句话结论 + 逐项） | 否 |
| `GET /check` | 全项体检 | 否 |
| `POST /scan` | 扫描本机改动、算差异（不落盘） | 否 |
| `POST /stage` | 把本机改动写进 payload | 是（仅 payload） |
| `POST /pull` | 拉取（`apply:true` 才写回本机，`prune:true` 才删） | 视参数 |
| `POST /push` | 提交 + 推送（落后则拒绝） | 是（仅 payload） |
| `POST /sync` | pull → 拉取不一致则停；否则 stage → push | 视情况 |
| `POST /auto` | 空闲自动上传的一次 tick | 视情况 |

`/sync` 的顺序是刻意的：**先 pull，拉下来还有问题就停下等人看**，
而不是闷头推上去把冲突藏起来。

---

## 9. 状态目录

```
$DSH_HOME/dsh-synchub/
├─ config.json          ← 本机设置（不进任何通道，两台各设各的）
├─ hash-cache.json      ← mtime/size 指纹缓存，避免每次全量哈希
├─ repos/
│  ├─ config/           ← 配置通道工作副本（payload/ 是镜像子树）
│  └─ sessions/         ← 会话通道工作副本
└─ backups/<ts>/        ← 每次覆盖/删除的原文件
```

payload 是镜像子树：`payload/sessions/...` 对应 `$DSH_HOME/sessions/...`。
这样仓库根还能放 `.gitattributes`、`README` 等仓库自身的东西，不会和同步内容混在一起。

### 配置项

```json
{
  "machine": "FRANCIS-HOME-I7",
  "workspace": "C:\\dsh\\workspace1",
  "channels": {
    "config":   { "remote": "https://github.com/<you>/dsh-config.git",   "enabled": true },
    "sessions": { "remote": "https://github.com/<you>/dsh-sessions.git", "enabled": true }
  },
  "surfaces": { "sessions": true, "storages": true, "attachments": true,
                "skills": true, "profileConfig": true, "profileManifest": false },
  "idlePushMinutes": 20,
  "autoPush": false,
  "staleHours": 48
}
```

`machine` 默认取 `os.hostname()`。**两台务必不同名**，否则环境切换检测失效。

---

## 10. 面板

| 入口 | 用途 |
|---|---|
| 侧边栏「同步中心」（带红/橙点）+ 主面板 | 日常：待办提醒、开工检查、①②③ 三步操作卡、操作记录 |
| 设置 → 同步中心（设置与目录） | 配置：当前状态、通道地址、本机设置、同步面开关、目录清单（可展开统计）、检查结果 |

红点只由真实差异派生：落后、未推送、推送失败、环境已切换。

---

## 11. 首次配置

```powershell
# 1. 两个私有仓库（各建一个，都私有）
#    dsh-config   ← 配置通道
#    dsh-sessions ← 会话通道

# 2. 装插件
& "C:\dsh\dshplug\install.ps1" -Only dsh-synchub

# 3. 完全退出 DSH 再打开，进 设置 → 同步中心，填两个远端地址

# 4. 第一台：面板里「① 推送」建立基线
# 5. 第二台：克隆到同一路径后装插件，面板里「① 拉取」接收基线
```

### 认证

GitHub 只接受 HTTPS + PAT（本机实测 SSH 全被墙）。
凭据存进 Windows 凭据管理器，两台机各做一次。

> **本机注意**：MinGit 的 schannel 后端在这里会报
> `SEC_E_NO_CREDENTIALS (0x8009030e)`，必须改用 OpenSSL：
> ```powershell
> git -C C:\dsh\dshplug config http.sslBackend openssl
> ```
> **不要配代理**：仓库级 `http.proxy` 已清除。实测那个代理已失效，
> 反而把直连能通的连接搞成 `TLS connect error: unexpected eof while reading`。
> 直连正常；真被墙再加回来，但先用 `git ls-remote --heads origin` 测一下。

---

## 12. 已知限制

- **只面向 Windows**（`Windows\MinGit`、`$USERPROFILE\.dsh`）。
- 会话日志是 zstd 多帧，插件**不解压**——只按字节搬。解码仍由 DSH 自己做。
- 两台机器**不能同时**往同一通道推。落后的那台会拒绝推送并提示先拉，
  但「同时推」仍是真实的分叉，需要人工 `merge` 或 `reset`。
- `--ff-only` 意味着**永不自动合并**。这是刻意的：自动合并会话 JSONL 只会产生坏数据。
- 大文件没有 LFS：`MAX_FILE_BYTES` 200 MB，超过跳过并记入 `skipped`。
  本机最大会话 52 MB，够用。
- `dsh-market` 的插件同步与本插件**互相独立**，两者都在用不会有冲突（因为它们管的是不同目录）。

---

## 13. 0.2 → 0.3 迁移

1. 卸载 `chatsync`（已废弃）与 `dsh-config-manager`（若只用于同步）。
   **先确认** `dsh-config-manager` 里的加密备份还有用——那是独立的恢复手段。
2. 在 `dsh-config-manager` 里**取消勾选 `plugins` 分区**，
   避免它 `npm pack` 后重写 spec，和本仓库管理的插件清单打架。
3. 装 0.3，配好两个远端，第一台推一次基线。
4. 第二台拉取时，插件发现本地仓库已 `git init` 但还没有 `HEAD`，
   会自动走 **bootstrap**：把本地 `payload/`、`synchub/`、`.gitattributes`、
   `.gitignore` 移到 `backups/pre-bootstrap-<ts>/` 再对齐远端。

   > 这是开发中修掉的第四个 bug：早期只在「没有 `.git`」时才 bootstrap，
   > 于是「已 init 但空仓」的机器去 pull 会撞上
   > `untracked working tree files would be overwritten by checkout`。

0.2 的信标文件（`sync-beacon/<hostname>.json`）不再需要，可以删掉。
