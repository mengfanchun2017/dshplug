# dsh-gitok 架构决策记录（ADR）

> 本文件是 `dsh-gitok` 的**设计决策总账**：记录「为什么这样设计」、不可从代码反推的约束、
> 实测发现，以及明确暂缓/否决的方案。
> 决策按时间正序编号，不删改旧条目；要推翻旧决策就新增一条并标注「取代 ADR-XXX」。
>
> 三份文档的分工：
>
> | 文件 | 讲什么 | 什么时候读 |
> |---|---|---|
> | [`README.md`](./README.md) | **现在怎么用**：面板长什么样、工具干什么、认证方式怎么选 | 第一次接触、要决定用哪种认证 |
> | [`BOOTSTRAP.md`](./BOOTSTRAP.md) | **怎么做**：安装、验证、迁移、排错的命令行手册 | 装机、换机器、出事排障 |
> | `ADR.md`（本文件） | **为什么这么定**：选型理由、安全边界、否决了什么 | 要改设计、要反驳某个约束 |
>
> 原始审计数据： [`docs/git-auth-audit-2026-11-12.md`](./docs/git-auth-audit-2026-11-12.md)

---

## ADR-001 · 凭据统一收敛到 Windows 凭据管理器，WSL 借用而不落盘

- **日期**：2026-11-12
- **状态**：已采纳
- **背景**：本机存在**三套互不相通的 git 认证**：
  1. Windows：GCM 2.9.1 + `wincredman`（DPAPI），`gho_` OAuth token，不过期
  2. WSL `claude`：`gh auth git-credential` 读 `~/.config/gh/hosts.yml` 里的 `github_pat_`（**明文**，93 字符）
  3. WSL `u26claude4`：同款 gh helper，另有**空口令** SSH 私钥
  三处密码轮换要改三次，且有两处是明文落盘。
- **决策**：把 Windows 凭据管理器定为**唯一凭据存放点**；WSL 端点的 helper 改为
  `!/mnt/c/.../git-credential-manager.exe`，通过 WSL interop 直接调用 Windows 的 GCM。
  WSL **一个字节的密钥都不存**。
- **理由**：
  - WSL 里 `secret-tool` / `gnome-keyring` / `pass` **全都没有**（只有 gpg），
    想做「加密存储」只能自己拿 gpg 搓一套，可靠性远不如 DPAPI。
  - DPAPI 绑定「用户 SID + 机器」，密文拷走也用不了 —— 正好命中「密钥出了机器不能用」。
  - 实测可行：`printf "protocol=https\nhost=github.com\n\n" | /mnt/c/.../git-credential-manager.exe get`
    能返回 username + password；`git -c credential.helper=<该路径> ls-remote <私有库> HEAD`
    返回 `38e1b73f...`，exit=0。
- **反面代价**：
  - **WSL 从此依赖 Windows 在跑**。WSL 单独启动、interop 被关、或 GCM 路径变了，git 认证就断。
  - 跨机器迁移时，凭据带不走，每台机要重新登录一次（这是特性不是缺陷，但用户要知道）。
  - `wincredman` 在**网络登录 / SSH 会话**下不可用（Windows 凭据管理器固有限制）。
    远程会话场景得改用 `dpapi` store。
- **已否决的替代方案**：
  - 统一用 WSL 的 `gh` + 明文 PAT → 违背「不明文保存」。
  - 用 SSH 密钥 → 本机 Windows 侧根本没有私钥，`u26claude4` 那把还是空口令，等于没保护。
  - 三端各存各的 + 脚本轮换 → 轮换脚本本身就是又一个要保管的明文凭据。

---

## ADR-002 · 不接收 token：插件全程不接触密钥

- **日期**：2026-11-12
- **状态**：已采纳（**硬约束，不可协商**）
- **背景**：一个「管理凭据」的工具天然有诱惑去读一读 token 来「验证是否有效」。
  那会让插件自己变成凭据泄露的新入口 —— 日志、错误信息、`gitok_doctor` 的输出、
  甚至写进 git 提交，任何一处漏出去都是灾难。
- **决策**：
  1. **没有任何工具参数叫 `token` / `password` / `secret`**。
  2. 登录走 `gitok_login` → GCM 自己的浏览器/设备码流程，凭据由 GCM **直接**写进凭据管理器。
     本插件只负责「启动 GCM」，不参与密钥流转。
  3. 所有输出过 `redact()`：`password=`、`oauth_token:`、`gho_*`、`github_pat_*`
     统一替换成 `<类型, len=N>`，只保留「有没有值 / 多长 / 什么类型」。
  4. 插件的任何文件都不写凭据。
- **理由**：把「凭据的存在性」和「凭据的值」彻底分开。
  插件只需要知道「有没有、能不能用」，这两件事都能在不读明文的情况下回答
  （`cmdkey /list` 看条目、`ls-remote` 看通不通）。
- **反面代价**：无法做「token 快过期了提醒你续」这类功能 —— 那必须读 token。
  接受这个损失。
- **验收方式**：`gitok_doctor` / `gitok_list` 的全部输出里不应出现任何 40+ 字符的连续高熵串。
  实测输出中凭据只显示为 `Target: LegacyGeneric:target=git:https://github.com`。

---

## ADR-003 · 端点抽象：`windows` 与「其余都当 WSL 发行版名」

- **日期**：2026-11-12
- **状态**：已采纳
- **背景**：要让 `doctor` / `list` / `verify` / `adopt` 四个工具都能作用于「Windows 本机」和
  「任意多个 WSL 发行版」，如果每个工具各写一遍循环，加一台发行版就要改四处。
- **决策**：把所有目标统一成字符串「端点」：
  - `target === 'windows'` → `pwsh -NoProfile -NonInteractive -Command <cmd>`
  - 其他任意字符串 → `wsl.exe -d <name> -e bash -lc <cmd>`，带 `WSL_UTF8=1`

  加一台 WSL 发行版只需在 `cordis.patch.yml` 的 `targets` 里加个名字，零代码改动。
- **理由**：端点集合是**配置**不是**代码**，符合「配置与逻辑分离」。
- **反面代价**：
  - 用字符串魔法区分执行环境，不像有类型的 adapter 那么清晰。
    `'windows'` 这个保留字永远不能被用作 WSL 发行版名（实践中不会撞）。
  - `WSL_UTF8=1` 是必需的：不设的话 `wsl.exe` 输出 UTF-16LE，Node 按 UTF-8 解会得到
    `\0\0` 交错的花屏。这个坑埋在 `runOn()` 里，改代码时别删。
- **当前状态**：`targets` 默认**只有 `windows`**。用户 2026-11-12 明确「WSL 的都先不动，
  后续再改，只改 Windows」。`claude` / `u26claude4` 以注释形式留在 patch 文件里。

---

## ADR-004 · 拆成宿主半 + 浏览器半，但两侧共用同一份探测逻辑

- **日期**：2026-11-12
- **状态**：已采纳（v0.2.0）
- **背景**：v0.1.0 只有 6 个模型工具。用户反馈：
  > 「gitok 我计划是在设置中添加项便于新手使用 Git 认证 显示为这个就好了」
  一堆 `gitok_*` 工具名对新手毫无意义 —— 他不知道有这些工具，也不知道怎么调。
- **决策**：
  - 新增 `lib/client.js`，在 `settings.section` 注册顶层分区 **Git 认证**（`id: gitok`, `order: 65`）。
  - `package.json` 加 `dsh.client`（`platform: web`）。
  - **`parseStatus()` 与 `gitok_doctor` 共用 `runDoctor()`**，不各写一份探测。
- **理由**：新手路径是「打开设置 → 看到状态 → 点按钮」，不是记住六个工具名。
  但**能力必须只有一份实现**，否则面板显示「正常」而工具说「失败」时无法解释。
- **反面代价**：
  - 安装变复杂：新增 `dsh.client` 后**必须重装**（`-Force`），只改代码不生效
    （Junction 只让代码即时生效，`dsh.client` 声明是安装时写进 profile 的）。
  - 面板引入一条新的失败路径：Host 路由没挂上时面板白屏/报错，而工具本身是好的。
    代码里已针对这点做了区分提示（「Host 半边可能未加载，需完全退出 DSH 再打开」）。
- **已否决的方案**：面板自己起子进程探测 → Client 半在浏览器里，**没有**子进程能力，
  技术上不可能。必须走 Host 路由。

---

## ADR-005 · 设置面板的数据通路必须走 Host 的 HTTP 路由

- **日期**：2026-11-12
- **状态**：已采纳
- **背景**：设置面板要知道「当前 git 认证通不通」，这件事只能通过跑 `pwsh` 探测得到。
  但 Client 插件运行在**浏览器**里，拿不到 Host 的 `ctx.tools`，也没有子进程能力。
- **决策**：Host 侧注册 `GET /plugins/gitok/status`：
  ```js
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/plugins/gitok/status', handler: async (req, res) => {...},
    }), 'gitok: status route')
  })
  ```
  返回 `{ ok, status:{level,summary,...}, report:"<原始体检文本>" }`。缓存 5 秒。
- **理由**：与 `dsh-getbrain` 的做法一致（它的 `/plugins/getnote/status`），
  路由挂在 `webServer` 的 prefix 下，与 `/plugins/` 同源，无需额外鉴权。
- **反面代价**：
  - **多了一层网络调用**，面板首次加载会比工具慢 2-5 秒（要起 pwsh 子进程）。
    用 5 秒缓存 + 「正在检查…」文案缓解。
  - `ctx.inject(['webServer'], fn)` 是**服务就绪才回调**。如果宿主没有 `webServer`
    （纯 CLI 模式），这段不执行，面板不可用但插件其余部分照常工作 —— 这是刻意的优雅降级。
  - 路由是**只读**的。面板里的「重新登录 / 撤销」按钮需要触发写操作，
    目前故意没做（写操作要 GCM 交互 + 二次确认，做错了会删掉用户凭据）。
    现在仍需 AI 代调 `gitok_login` / `gitok_revoke`。

---

## ADR-006 · WSL 功能默认关闭，配置里只留 `windows`

- **日期**：2026-11-12
- **状态**：已采纳
- **背景**：ADR-001 定的方向是「WSL 借用 Windows GCM」，且 `gitok_adopt` 已在 `claude` 上
  实测成功（helper 变成 `!/mnt/c/.../git-credential-manager.exe`，端到端仍可用），
  之后配置已从备份还原。
  但用户随后明确：
  > 「wsl的都先不动 后续再改 只改windows dsh」
- **决策**：`cordis.patch.yml` 的 `targets` **只保留 `windows`**，
  `claude` / `u26claude4` 以**注释形式**留档。仍然支持用工具参数临时指定
  （如 `gitok_doctor targets=["claude"]`）。
- **理由**：
  - 「只读体检」和「改配置」风险不同。`doctor` 只是看，`adopt` 会**真改** WSL 的 `.gitconfig`。
    留着默认端点 = 留着误改的机会。
  - 用户的工作流还在 Windows 侧，WSL 改造是后续独立任务。
- **反面代价**：
  - 默认体验看不到 WSL 状态，容易误以为「插件不支持 WSL」。
    README 里已显式说明「WSL 功能默认关闭」及开启方法。
  - `u26claude4` 的**空口令 SSH 私钥**这个高危项，在默认配置下不会被 `doctor` 报出来。
    这是已知的可观测性缺口，等 WSL 改造时一起处理。
- **恢复方法**：把 `cordis.patch.yml` 里 `targets` 下两行注释取消，重启 DSH。

---

## ADR-007 · 版本号与安装状态写死在文档里，不用「最新版」这类说法

- **日期**：2026-11-12
- **状态**：已采纳（沿用全局归档约定）
- **背景**：文档里写「当前最新版」会随时间腐烂，后来的读者无法判断看到的信息是否过期。
- **决策**：README / BOOTSTRAP / ADR 里的日期、版本号、机器名、路径全部**写死为具体值**，
  并标明快照时间（`2026-11-12`）。状态变化就新增一条记录，不改旧值。
- **理由**：这份文档的核心用途是**交接**（用户明确说要迁移到另一个工作区继续开发），
  读者需要知道「这是什么时候的事实」，而不是一个永远声称自己正确的文档。
- **反面代价**：文档会显得「过期」，需要人工维护。接受 —— 比悄悄腐烂好。

---

## 附：当前版本与状态快照（2026-11-12）

| 项 | 值 |
|---|---|
| 版本 | **0.2.0** |
| 状态 | `active` |
| 安装形态 | `link-junction` → `C:\dsh\dshplug\dsh-gitok` |
| 安装 profile | `desktop` |
| 宿主机 | `REDMIPRO` |
| 宿主半 | 6 个工具 + 1 条路由 |
| 浏览器半 | 设置 → Git 认证（`settings.section`, order 65） |
| 已验证 | 工具可用（16:37 实测）；路由/面板待重启验证 |
| WSL 端点 | 默认关闭 |
