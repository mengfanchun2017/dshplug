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
  - 新增 `lib/client.js`，在 `settings.section` 注册顶层分区（`id: gitok`, `order: 65`）。
    显示名初版为「Git 认证」，2026-11-16 起按统一规范改为 **`Mgitok`**（见 ADR-012）。
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
- **状态**：⚠ **部分已被取代** —— 「路由只能只读」这一点已于 v0.3.2 推翻（新增 4 条受控写路由）。
  本 ADR 的其余结论（数据通路走 Host、5 秒缓存、优雅降级）仍然有效。
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
  - ~~路由是**只读**的，写操作故意没做~~ —— **已于 v0.3.2 推翻**。
    现在有 4 条受控写路由（`login` / `revoke` / `rotate` / `bootstrap`），
    必须同时满足：三道守卫（`remoteAddress` / `Host` / `Origin`）+ `POST only` +
    请求体无 token 字段 + 破坏性操作 `requiresConfirm`。
    为何推翻：只读路由让「面板里的按钮」形同虚设，用户必须找 AI 代调工具，
    反而更容易出错（AI 看不到用户本机的实际状态）。
    **读路由仍然不加守卫**（只读 + 同源 SOP），它返回的字段属于主机指纹级
    （helper 路径、代理地址、私钥**文件名**、凭据 target 名单），可接受。
    新代价（v0.3.8 血的教训）：**写路由一旦漏了 `requiresConfirm`，
    一个合法 POST 就真的会删凭据**。`rotate` 当初就漏了，本插件的 smoke 测试
    因此在作者本机上真实 erase 过一次 github 凭据。现已补上并加断言。

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

## ADR-008 · 决策 D：默认用 GCM OAuth 作为认证内核，不做「每机命名细粒度 PAT」

- **日期**：2026-11-13
- **状态**：已采纳（决策编号来自 `docs/plugin-roadmap.md` §3.2 的 D/E 对照表）
- **背景**：需要回答一个具体问题 —— 「多台机器上，git 认证到底用哪种方式？」
  当时摆着三条路：
  1. **A：SSH 双轨** —— 已否决。主要理由是【**该理由后来被实测推翻，见下方更正**】：
     原记录称「本机出站 22 端口被拦」，但 2026-11-13 实测 Windows / claude / u26claude4
     三处的 22 端口**均可达**，且 `u26claude4` 的 `aiagt` 仓库正走 SSH 且可用。
     否决 A 的**真正仍成立的理由**是：要重写所有仓库的 remote URL，
     且密钥一旦在多台机器/多个发行版间复制，就失去「按机器区分」的意义。
  2. **B：`GH_TOKEN` 写进 `.env`** —— 已否决。明文落盘，违背根本目标。
  3. **C：每台机器 `gh auth login` + `~/.config/gh/hosts.yml`** —— 已否决。
     它正是 `u26claude4` 上「token 已失效」那个故障的根因：明文 PAT + 手工维护。
- **决策**：默认（**方案 D**）= **GCM OAuth 浏览器/设备码登录，每台机器一次**，
  凭据存 `wincredman`（DPAPI，绑当前用户 SID + 本机）。
  明确**不**采用方案 E（每机一个命名细粒度 PAT）。
- **理由**：
  - 零手工 token：不需要人工去 GitHub 页面创建、复制、粘贴、保管任何密钥。
  - 轮换 = 重新登录一次，不需要回头改任何配置文件。
  - 授权范围由 GCM 自己维护（`gho_`，scope 含 `gist` / `repo` / `workflow`），
    不用人肉记住该勾哪几项。
  - 插件现有 `gitok_login` 就是 GCM 的包装，方案 D 不需要新增任何密钥通路。
- **反面代价（重要，不能略）**：
  - GitHub 的「Settings → Applications → Authorized OAuth Apps」里**只显示一条**
    「Git Credential Manager」，**无法按机器命名**，也**无法单独吊销某一台机器**。
    要单独吊销只能全局撤销，然后每台机器重新登录。
    → 这意味着 Claude 报告 §9.1 提的「凭据名里带机器标识」这个要求在 D 下**做不到**。
  - 权限是 `gist + repo + workflow` **全宽**，不是最小权限。
  - DPAPI 只能防「拷走磁盘 / 备份 / 别的用户账号」，
    **不能防同身份本地进程**（任何以当前用户跑的 agent、脚本都能问 GCM 要出明文）。
  - 换机器必须重新登录一次，这是设计特性而不是缺陷 —— 它正是「密钥出机器不可用」的实现方式。
- **何时重新考虑 E**：若确实需要「按机器单独吊销」或「最小权限」，则必须转 E，
  但那会引入「每机一个命名 PAT」的人工管理成本（创建/分发/设期/轮换/吊销）。
  届时需新增一条 ADR，不修改本条。
- **已否决的替代方案**：A（SSH 双轨）、B（`GH_TOKEN` 明文环境变量）、C（`gh` + `hosts.yml` 明文 PAT）。
  否决理由见上「背景」。
### ADR-008 的实测补记（2026-11-13，决策 D 落地到两个 WSL 发行版）

这条不是新决策，是对 ADR-008 的**执行结果与两个事实纠正**。决策本身（选 D）不变。

**执行结果**：`claude` 与 `u26claude4` 均已接管到 Windows GCM，`hosts.yml` 已清空。
两个发行版各自 3 个仓库拉取通过，SHA 完全一致（`ccprivate` 均为 `38e1b73f88be`），
说明它们确实共用同一份 Windows 凭据。

**纠正 1（推翻原件理由）**：「本机出站 22 端口被拦」不成立。
实测 Windows / `claude` / `u26claude4` 三处 22 端口均可达，`u26claude4` 的 `aiagt` 正走 SSH 且可用。
否决 A 仍成立，但理由得换成「要重写 remote URL」+「密钥跨机复制就失去按机区分意义」。

**纠正 2（我自己的误判）**：曾把「GCM 在 claude 上不通」写进排查中间结论，错了。
真正原因是 VPN 未开导致 DNS 被污染（解析到 `57.155.223.240`），
连 `curl` 不经任何 helper 都要 13–15 秒、5 次中 2 次超时。
交错 A/B 实测（同一时刻交替跑 gh 与 GCM helper）两边都会超时，才排除了 GCM 特有故障。
VPN 开后直连降至 1 秒、两个 helper 各 4/4 通过。

**教训（已写进 BOOTSTRAP §10.3.4 坑 2 / 坑 3）**：
- `git ... | head; echo exit=$?` 拿到的是 `head` 的退出码，永远 0，会把超时伪装成成功。
- 怀疑凭据时先跑不经 helper 的 `curl`，区分「网络」与「凭据」。

**反面代价（本条新增的）**：`gh auth logout` 不删文件，只把 `hosts.yml` 清成 `{}`。
若监控只看文件是否存在，会长期假报「有明文凭据」。
已改为检测文件内是否真有 `oauth_token`，`{}` 状态报 `empty-file` 判为 `ok`。

## ADR-009 · `inject` 按「`apply` 里真实访问过谁」逐项声明，不按「大概需要谁」猜

**日期**：2026-11-16 ｜ **状态**：已采纳

### 结论

浏览器半的 `inject` 必须把 `apply` 里出现过的每个 `ctx.xxx` 都列进去。
v0.3.2 起 `client.js` 写 `['slots', 'locale']`。

### 背景

v0.2.0 写了 `const inject = ['slots']`，但 `apply` 里调用了 `ctx.locale.register(...)`。
Cordis 只注入声明过的服务，`ctx.locale` 是 `undefined`，`apply` 第一行就抛
`Cannot read properties of undefined (reading 'register')`。

宿主加载浏览器半的方式是「调一次 `apply`」——它抛错就等于**整个半区没注册**，
而且**不弹错误、不写日志**。表现与 `exports` 缺 `./client` 完全一样：装了、工具能用、
路由也通，界面上就是没有它。

### 理由

1. `inject` 是依赖声明，漏一项不是「少个功能」，而是**整块崩掉**。
2. 崩在 `apply` 第一行，比崩在深处更难查 —— 没有任何中间状态可观察。
3. `apply` 里每出现一次 `ctx.xxx` 就回去核对 `inject`，是可以机械执行的检查，
   不依赖记性。

### 反面代价

- `inject` 变长，多一个服务就多一次注入，启动略慢（可忽略）。
- 声明了却没用到的服务不会报错，所以「多列」是安全的，「少列」是致命的 ——
  这意味着一律多列反而更安全，与「最小依赖」的直觉相反。
- 对照陷阱：`dsh-synchub` 写 `['slots']` 是**对的**（它真的没碰 `locale`），
  不能因为「synchub 这么写能跑」就照抄 —— 要照抄的是它的**方法**，不是它的**值**。

### 已否决的替代方案

- **改用 `ctx.inject(['locale'], ...)` 动态注入**：能工作，但会让 `apply` 变成异步分段结构，
  可读性明显变差；本插件只需要在启动时注册插槽，没有「服务晚到」的需求。
- **在每个 `ctx.locale` 前加 `if (ctx.locale)` 判空**：只是把崩溃变成静默不生效 ——
  导航文字不翻译，反而更难发现。
- **靠 try/catch 包住 `apply` 兜底**：能防止整体崩，但会掩盖真实错误，
  且捕获后没有任何可用降级（没有 locale 就没有标签）。

---

## ADR-010 · 侧边栏与设置面板并列提供，两个插槽分开注册

**日期**：2026-11-16 ｜ **状态**：⚠ **已被 ADR-011 取代**（保留原文作历史，别再照它实现）

> 本 ADR 的结论是「两个入口都做」。一天后用户明确否掉了：
> 「gitok 在设置就看就可以了 不用侧边栏」。改为只保留设置入口，见 **ADR-011**。
> 正文保留原样，因为**«两个插槽怎么分开注册»这部分技术细节仍然有效** ——
> 将来任何插件要加侧栏图标都用得上，只是 gitok 自己不再用。

### 结论

`sidebar.panellist`（图标）与 `main`（点开后的面板）**各自独立** `ctx.slots.inject(...)` 注册，
不复用同一个回调；`main` 的面板组件直接复用 `GitokSection`。

### 背景

v0.2.0 只注册了 `settings.section` —— 侧边栏里根本没有入口，这是**没写**，不是 bug。
v0.3.2 补上时，最初把 `main` 塞进了 `sidebar.panellist` 的回调里。

### 理由

1. 两者语义独立：设置分区是「配置」，侧栏面板是「日常查看」。
   用户不该为了看一眼认证状态去翻设置。
2. 宿主可能没有某个插槽（不同 DSH 版本、或精简构建）。
   分开注册时，缺 sidebar 不影响面板本体能打开；合并注册则一损俱损。
3. 复用同一个 `GitokSection` 组件，避免两处 UI 逻辑漂移。

### 反面代价

- 同一份 UI 在设置和侧栏出现两次，用户可能疑惑「这两个是同一个吗」——
  靠一致的标题与内容消解。
- `GitokSection` 被挂载两处时各自独立请求 `/status`，多一次 HTTP 往返；
  已用 5s 缓存（Host 侧）吸收，第二次基本命中缓存。
- 侧栏图标组件需要自己探一次状态（`GitokIcon` 里 `fetchStatus(false, 8000)`），
  多一个常驻请求。已限定**只在挂载时探一次、不轮询**，避免常驻刷 pwsh 子进程。

### 已否决的替代方案

- **只做设置、不做侧栏**：省事，但「认证是否正常」是每天都可能瞟一眼的信息，
  藏在两级设置里等于不看。
- **只做侧栏、不做设置**：侧栏面板通常较窄，放不下 `checks` 六项明细与原始报告。
- **把 `main` 塞进 sidebar 回调**：宿主缺 sidebar 插槽时，面板本体也打不开。

### 侧栏 UI 的两条硬约束（来自 `dsh-synchub` 的踩坑）

1. **组件里不写插件名字** —— 文字由插槽元数据的 `label` 渲染，组件里再写会重复两遍。
2. **状态小点放图标左上角**（`top:-1, left:-2`）—— 放右上角会跟宿主自己的角标撞位置。

---

## 附：当前版本与状态快照（2026-11-16）

| 项 | 值 |
|---|---|
| 版本 | **0.3.10** |
| 历史版本 | 0.3.5（2026-11-16 之前的快照） |
| 状态 | `active` |
| 安装形态 | `link-junction` → `<仓库根>\dsh-gitok`（本机当前为 `C:\dsh\dw-plugin\dsh-gitok`；路径可变） |
| 安装 profile | `desktop` |
| 宿主机 | `REDMIPRO` |
| 宿主半 | 9 个工具 + 5 条路由 |
| 浏览器半 | **一处入口**：设置 → Mgitok（`settings.section`, order 65）；四态 + 六项监控（带 `?` 就地说明）+ 受控写按钮 + WSL 分步命令区。侧边栏与 `main` 已于 v0.3.5 移除（ADR-011） |
| `inject` | `['slots', 'locale']`（ADR-009） |
| 已验证 | mock-ctx 注册 9 工具/5 路由；三端点四态实测（windows=unknown / claude=warn / u26claude4=error）；面板组件渲染实测 |
| WSL 端点 | 默认不动（ADR-006），参数可临时指定 |

---

## ADR-011 · gitok 只保留设置入口，移除侧边栏与 main 面板

**日期**：2026-11-16 ｜ **状态**：已采纳（取代 ADR-010）

### 结论

浏览器半**只注册 `settings.section` 一个插槽**（`id: gitok`, `order: 65`）。
删掉 `sidebar.panellist` 注册、`main` 面板注册，以及只为侧栏存在的 `GitokIcon` 组件。

```js
// apply() 里现在只有这一个注册
ctx.effect(
  () => ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'gitok', order: 65, label: () => t('nav'), locale: NS },
      GitokSection,
    )),
  'gitok: settings section',
);
```

### 理由

1. **功能完全重复**。`main` 面板注册的就是 `GitokSection` 本身，和设置里那个是**同一个组件**。
   用户原话：「gitok 在设置就看就可以了 不用侧边栏（功能类似）」。

2. **gitok 不是「日常瞟一眼」型插件**。ADR-010 当时的判断是
   「认证是否正常是每天都想看的信息，藏在两级设置里等于不看」。
   实际使用后这个前提不成立 —— 凭据配好之后长期不变，
   真正需要看的时候是**出问题时**，而那时用户会主动去设置找。
   反而是侧栏多一个常驻图标更打扰。

3. **省掉一个常驻请求**。`GitokIcon` 挂载时要 `fetchStatus(false, 8000)` 探一次状态。
   删掉图标后，浏览器半只在用户真正打开设置面板时才请求 `/status`。

### 反面代价

- **侧栏少一个入口**：想快速看状态必须先进设置。这是用户明确接受的代价。
- **`GitokIcon` 被删掉**（连同状态小点逻辑约 60 行）。
  将来若要恢复侧栏，这段要重写 —— 可参考 `dsh-synchub/lib/client.js` 的同名组件。
- **与 `dsh-getbrain` / `dsh-synchub` 的形态不一致**：那两个都是「设置 + 侧栏」双入口。
  这不违反约定 —— 双入口是**可选**的，取决于插件是否需要常驻可见；
  `inject` 列表也跟着变短（仍为 `['slots', 'locale']`，因为 `settings.section` 也在 `slots` 里）。

### 已否决的替代方案

- **保留侧栏但隐藏图标**：`sidebar.panellist` 不注册、只留 `main`。
  否决 —— `main` 面板没有入口就永远打不开，是死代码。
- **侧栏保留但点击后跳转设置**：需要在组件里操作宿主路由，宿主没提供稳定接口，且属于 hack。
- **两处都留、靠文案区分**（ADR-010 的做法）：已证伪，用户看到的就是「重复」。

### 恢复方法（如果将来要重新加回侧栏）

三步，缺一不可（细节见 ADR-010 正文与 README §8.13）：

1. 恢复 `GitokIcon` 组件（图标 + 左上角状态小点，`top:-1, left:-2`）。
2. 注册 `sidebar.panellist`（`id: gitok`, `order: 465`, `label: () => t('panelName')`），
   同时把 `panelName` 键加回 locale 字典。
3. **独立**注册 `main`（`key: 'gitok'`），**不要**塞进 sidebar 的回调里。

> `inject` 写 `['slots', 'locale']` 两个都要，因为 `apply` 里 `ctx.slots` 和 `ctx.locale` 都会用到
> （ADR-009 的铁律：`apply` 里每出现一次 `ctx.xxx`，`inject` 就必须有 `xxx`）。

---

## ADR-012 · 界面显示名统一为「`M` + 技能名」，全小写

**日期**：2026-11-16 ｜ **状态**：已采纳

### 结论

侧边栏与设置里出现的**显示名**一律为「`M` + 技能名」，全小写：`Mgitok` / `Mlarkcli` / `Mgetbrain` / `Msynchub`。
`M` 是 Manta 品牌标识，固定大写前缀；技能名部分全小写。

**只动显示名，不动身份名**：仓库目录仍是 `dsh-gitok`，包名仍是 `dsh-gitok`，
`package.json` 的 `name` 与 `__ModuleLoader__.load({ id })` 的 `id` 都保持原样。

在 dsh-gitok 内部，显示名收敛到 `lib/client.js` 的一个模块级常量：

```js
const DISPLAY_NAME = 'Mgitok';
```

设置分区的 `nav` 与面板 `<h2>` 标题都从它取，只有一处真值。

### 理由

1. **多插件在同一列表里必须可区分且成体系**。混着「Git 认证」「飞书」「同步中心」时，
   用户看到的是三个不同风格的名字，无法一眼判断它们同属 Manta 系列。
   统一前缀让「这批是我的插件」在视觉上直接成立。
2. **全小写避免排序与搜索分裂**。`Mgitok` 与 `Mgitok` 只有一种写法，
   Linux/macOS 上大小写敏感的文件名、URL 与搜索结果不会出现两份。
3. **显示名与身份名分离是必须的**。目录名被 `install.ps1` 的 `link:` Junction 引用，
   也是 `~/.dsh` 里配置与凭据的归属键（见 ADR-007）。改目录名会断 Junction、
   让已保存的 `dataDir`、`targets`、凭据全部失联。
   所以**改名只能改表现层**（`locale.register` 的 `nav` + 面板标题）。
4. **常量优于两处各写一份**。v0.3.5 收尾时真实踩到：`nav` 已改 `Mgitok`，
   面板 `<h2>` 还写着「Git 认证」，界面上标题与分区名不一致。两处各写一份字符串就必然走样。

### 反面代价

- **`M` 前缀在中文语境下不直观**：不看文档的用户不知道 `Mgitok` 是 git 认证。
  靠 locale 的 `meta.description` 与面板副标题补足，名称本身不承担解释职责。
- **改了显示名，旧文档与旧截图会失配**。本次同步改了 README/BOOTSTRAP/ADR/cordis.patch.yml/roadmap
  五份文档里指代**界面名**的地方；指代**技术主题**的「git 认证」（如「本机存在三套 git 认证」）保持不变。
  这个区分要人工判断，无法机械替换 —— 是全小写前缀方案唯一的长期维护成本。
- **插件间形态仍可能不一致**：`dsh-synchub` / `dsh-getbrain` 是「设置 + 侧栏」双入口，
  gitok 是单入口（ADR-011）。命名统一**不**意味着入口必须一致。

### 已否决的替代方案

- **连目录名一起改成 `Mgitok`**：否决。断 `link:` Junction，且 Windows 路径大小写不敏感、
  Linux 敏感，跨机同步会分裂成两个目录。身份层必须稳定。
- **用中文显示名**（「Git 认证」「飞书」）：已证伪。多插件列表里无法成体系，
  且这些名字里没有一个共同的品牌来源。
- **每个插件各定风格**：这就是改名前的状态，用户明确提出要统一，故否决。
- **在 `package.json` 里加 `displayName` 字段**：平台不读这个字段（无源码级依据），
  显示名实际由 locale 的 `nav` 决定。加一个没人读的字段只会误导后来的人。

### 影响范围与落点

| 位置 | 是否改 | 说明 |
|---|---|---|
| `lib/client.js` 的 `DISPLAY_NAME` | ✅ | 唯一真值 |
| `locale/*.json` 的 `nav` | ✅ | 静态声明也须一致 |
| `package.json` 的 `name` | ❌ | 身份层，改了断 Junction |
| 目录名 `dsh-gitok/` | ❌ | 同上 |
| `__ModuleLoader__.load({ id })` | ❌ | 必须等于包名 |
| 文档里指代界面名的「Git 认证」 | ✅ | 本次已改 |
| 文档里指代技术主题的「git 认证」 | ❌ | 如「三套互不相通的 git 认证」 |

规范已写入 `<仓库根>\BOOTSTRAP.md` §5.1 与 `~/.dsh/AGENTS.md` 开发约定，后续新插件照此执行。

---

## ADR-013 · 路由冒烟测试必须真调 handler，`node --check` 不能作为验证依据

**日期**：2026-11-16 ｜ **状态**：已采纳 ｜ **触发版本**：v0.3.7

### 结论

`node --check` 通过 **不等于** 插件能用。改完 `lib/index.js`，在重启 DSH 之前
必须跑一次 `tools/smoke-route.mjs`，它会真调 `apply()` 并真调 status 路由的 handler。

### 背景：一次潜伏了三个版本的 500

用户报告 `/plugins/gitok/status` 返回 **HTTP 500**，且「开不开 VPN 都一样」。

错误正文：

```json
{ "ok": false, "error": "DOCS_WSL is not defined" }
```

根因：`e77a680`（v0.3.4）把常量定义误粘进了 `loadSchemastery()` 的**函数体内**：

```js
async function loadSchemastery() {
  const req = createRequire(import.meta.url)
  const here = path.dirname(...)
  /** WSL 接入说明的绝对路径… */          // ← 注释和常量都在函数里
  const DOCS_WSL = path.join(here, 'docs', 'WSL-GIT-AUTH.md')
  ...
}

// 路由处理函数在模块作用域，取不到函数内的 DOCS_WSL
json(res, 200, { ok: true, status, report: cache.text, docsPath: DOCS_WSL })
```

**为什么整整三个版本没被发现**：

| 检查手段 | 结果 | 为什么漏了 |
|---|---|---|
| `node --check` | exit 0 | 只验**语法**，不验**作用域** |
| `import()` 模块 | 成功 | 函数没被调用，`ReferenceError` 不触发 |
| `exports` 子路径解析 | 全部可解析 | 与作用域无关 |
| 文件逐字节比对仓库/部署 | 完全一致 | 两边错得一模一样 |
| **唯一能抓到的** | — | 真调 handler |

第 3、4 项特别有欺骗性：它们都「通过」了，但通过的原因与 bug 无关。
**能通过检查 ≠ 检查覆盖了这个 bug。**

### 第二个 bug：`here` 的语义

修作用域时又发现 `here` 指向的是 `lib\` 而不是插件根，导致
`docsPath` 拼成 `lib\docs\WSL-GIT-AUTH.md`——**该文件不存在**。

正确写法：

```js
const libDir = path.dirname(fileURLToPath(import.meta.url))  // …/dsh-gitok/lib
const here   = path.dirname(libDir)                          // …/dsh-gitok
const DOCS_WSL = path.join(here, 'docs', 'WSL-GIT-AUTH.md')  // 真实存在
```

顺带把手写的 `new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')`
换成 `fileURLToPath`：前者不处理百分号编码，路径含空格或中文时会拿到
`%20`、`%E4%B8%AD` 这种未解码字符串，`existsSync` 直接为假。

### 冒烟测试的两个硬断言

单纯「跑完不报错」没有价值——上面的 bug 在 handler 被调用前都不会报错。所以断言必须打在执行结果上：

| 断言 | 抓什么 |
|---|---|
| `docsExists === true` | 路径类常量算错（`here` 语义错时拼出的路径不存在） |
| 六项 checks 齐全且无 FAIL | 路由体内的作用域错误（`X is not defined` 必然现形） |

### 已证明它能抓到这个 bug

不是「写了就算」。在隔离副本里把 `DOCS_WSL` 挪回函数内复现：

```
node --check        → exit 0        （查不出来）
smoke-route.mjs     → exit 1        （FAIL: 期望 200，实际 500）
                       服务端错误: DOCS_WSL is not defined
```

同一个 bug，一个漏、一个抓，这才证明这套验证有意义。

### 反面代价

1. **多维护一个脚本**：`tools/smoke-route.mjs` 里的 ctx 桩是手写的，
   宿主侧 API 变了（如 `ctx.inject` 签名改动）它自己会先坏。桩坏了是「假通过」，
   比没有更危险，所以桩要尽量薄、只依赖 `inject` / `effect` / `webServer` 三个。
2. **仍不是端到端**：打桩跑通不等于真实进程跑通（权限、编码、并发都没覆盖）。
   它只能替代「语法检查」，不能替代 §2.3 的真机验证。
3. **默认值陷阱**：`smoke-route.mjs` 用 `new Config({})` 默认配置跑，
   用户的实际配置（如 `heartbeatUrl`、`targets`）不参与，
   所以它验证的是「代码路径通」，不是「你的配置对」。
4. **测不到「代码已修但进程里仍是旧模块」**（v0.3.8 实际发生）：
   `smoke-route.mjs` `import` 的是磁盘上的新文件，所以它绿；
   而真正在跑的 DSH 进程里还是旧模块，路由 `500`。
   它只能证明「磁盘上的代码自洽」，不能证明「用户看到的是对的」。
   缓解：跑完比对 `lib/index.js` 的 mtime 与 DSH 进程启动时间；
   mtime 更新 → 必须先完全退出 DSH 再验面板。
5. **写路由只能测拒绝路径**（v0.3.8 血的教训）：
   一个「合法 loopback 请求 + 合法 body」会真的走到 `run`。
   给 `rotate` 加断言时没有 `requiresConfirm` 拦着，测试直接把作者本机的
   github 凭据 `GCM erase` 掉了（已重新 OAuth 恢复）。
   所以写路由断言**永远只打 403/400 分支**，并给每个调用加超时 ——
   否则「守卫被误删」不是报红，而是将死在那里并执行破坏性操作。
   教训：**破坏性路由的守卫，不能靠测试代码自觉，要靠路由自己声明
   `requiresConfirm` 并由测试断言它存在**。
### 已否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 只加 `node --check` | 已证明查不出此类 bug，是本次事故的直接原因 |
| 靠 lint（eslint `no-undef`） | 需要额外配置与依赖；`no-undef` 对 ESM 顶层常量误报多，且本仓库无 lint 流程 |
| 加个「重启后人工点一下页面」 | 靠人不靠机器，且 v0.3.4→v0.3.7 已证明人工验证会跳过 |
| 改成 CommonJS 避免 TDZ | 与 DSH 的 ESM 加载方式不符，成本远大于收益 |
## ADR-014 · 凭据「对账」只做到本机账号级，GitHub 侧的授权不由本插件管理

- **日期**：2026-11-16
- **状态**：已采纳
- **背景**：用户问「你刚给我新建了一个授权，旧的要我去 GitHub 页面删吗？
  插件能不能告诉我用的是哪个（名字 + key 后 4 位），这样我好去删残留」。
  这个诉求里有三个隐含前提，实测后发现**只有第三个成立**。
- **实测事实**（2026-11-16，本机 GCM 登录取到的 token）：
  1. token 前缀 `gho_`、长度 40、scopes `gist, repo, workflow`
     → 这是 **GCM 自己那个 OAuth App 签发的 OAuth access token**，不是 PAT。
  2. `GET /applications/grants` → **404**（该 API 早已废弃）。
     `GET /user/installations` → **403**（需要 GitHub App 权限，与 OAuth token 无关）。
     `GET /user` 可以调到，响应头有 `X-OAuth-Scopes`，但**没有任何 token 标识**。
     → **GitHub 不提供「列出我签发的 OAuth token」的 API**。
  3. 网页端 `github.com/settings/applications` 只有「Git Credential Manager」
     这一个 App 条目：显示 App 名 + scopes + 最近使用时间，**无 token 名、无后 4 位**。
     撤销是**按 App 整体撤销**，会让**所有机器**的 GCM 同时失效。
  4. 网页端 `github.com/settings/tokens` 只有 PAT（`ghp_` / `github_pat_`），
     那里才有「名字 + 后 4 位」，可单条撤销。但**本插件不产生这类 token**。
- **决策**：
  - 插件只回答「**本机存的是哪个账号**」，字段 `credAccounts`（target → 账号名），
    来源是 `cmdkey /list` 的 `User:` 行。**不显示任何 token 片段**（ADR-002 仍然成立）。
  - 面板明确写出「本机凭据」与「GitHub 授权」是两个东西，并给出两个 GitHub 页面
    各自能做什么、撤销的代价是什么。
  - **不做** token 指纹 / 后 4 位展示：OAuth token 在 GitHub 侧本来就不按名字区分，
    显示一个对不上任何网页条目的「后 4 位」只会误导用户去找不存在的行。
- **理由**：把「我们能看到的」和「我们看不到的」在界面上划清楚，
  比给一个做不到的承诺更有用。用户真正要的是「我怎么知道本地有没有多余凭据」，
  这个用账号名 + 条数就能回答。
- **反面代价**：
  - 用户若真想清理 GitHub 侧的历史授权，仍必须自己去网页按 App 撤销，
    且要接受「所有机器一起失效」。插件帮不上，只能提示入口。
  - 同账号多台机器共用一条 OAuth 授权，**无法区分是哪台机器**。
  - 只显示账号名时，若同一账号在本机存了多条（不同 host），
    面板会显示 `N 条：账号名`，看不出具体是哪几个 host —— 已在 `credTargets` 里保留
    target 明细，需要时可展开（当前面板未展开）。
- **已否决的替代方案**：

  | 方案 | 否决理由 |
  |---|---|
  | 显示 token 后 4 位 | `gho_` OAuth token 在 GitHub 网页端没有对应条目，对不上；且违反 ADR-002 的最小披露 |
  | 建一个「每机命名细粒度 PAT」来做可区分授权 | 即 ADR-008 已否决的方案：要用户手动建 PAT、管过期、逐机配置，成本远高于收益 |
  | 用 GitHub API 枚举并展示授权列表 | API 不存在（404/403 实测），做不到 |
  | 插件代删 GitHub 侧授权 | 需要用户 token 且有 `delete_repo` 之类高危 scope，违反 ADR-002 |
### 2026-11-16 · v0.3.10 补遗：按账号给出链接 + 「哪台机器」的判断方法

用户反馈：**「如果做清理和 GitHub 上授权的检查，没有看到反馈；在设置中增加这块的描述最好
根据授权的用户给出链接，并写清楚如何判断这台机器的授权是哪个」**。

面板新增 `CredAccountCard`（放在状态卡之后、原始报告之前）：

1. **标题带账号名** —— 直接从 `credAccounts` 取，`GitHub 授权对账（账号：xxx）`。
   用户不用在多个账号之间猜该去哪个账号下检查。
2. **三个直达链接**（`target=_blank`）：
   - `settings/applications` → Authorized OAuth Apps（GCM 的 `gho_` 授权在这里）
   - `settings/tokens` → PAT（唯一能单条删、不影响其他机器的）
   - `settings/security-log` → 搜 `oauth_access`（**判断「哪台机器」的唯一依据**）
3. **可展开说明**「怎么判断这台机器对应哪个授权」，写四种按可靠度排序的方法：
   - 方法 1（最准）：安全日志里 `oauth_authorization.create` 的时间 + IP/城市，
     刚登录完刷新，时间最新且出口 IP 对得上的那条就是。**注意代理会改变 GitHub 看到的 IP**。
   - 方法 2：**为什么「撤销一个」会命中多台机器** —— v0.3.11 按用户质疑重写，见下节。
   - 方法 3：**OAuth 授权不能加「-机器名」后缀** —— App 名是发布方注册时写死的，见下节。
   - 方法 4：多账号不要在同一台机器反复换号（会覆盖同一 target 的凭据）。
4. **明确写「没有一步到位的对应关系」**，并解释为什么不给假指纹 ——
   这与 ADR-014 一致：OAuth token 网页端不显示名字/后 4 位，给了也对不上。

同时按用户要求把文案里的「发给 Claude」统一改成
「发给任意 Vibe Coding Agent（Claude Code / Codex / Cursor / Trae 都行）」，
涉及 `client.js`（两处 UI 文案 + aiPrompt 注释）、`BOOTSTRAP.md` §10.4、
`docs/WSL-GIT-AUTH.md` 开头与第二部分、`plugin-roadmap.md` §1.4 共 11 处。
`BOOTSTRAP.md` §10.4 额外标注：那里的 `claude` 是 **WSL 发行版名**，不是工具名，避免混淆。

**验证**：`node --check` 通过；用最小 React 桩把 `CredAccountCard` 真渲染了三种输入
（有凭据 / 无凭据 / 全空），标题与降级提示都正确分支；静态扫了 `C.*` / `S.*` 的
13 + 14 个引用，确认无未定义键（这是 `node --check` 查不出的一类错误）。

### 2026-11-16 · v0.3.11 补遗：三处纠正（用户提出，均经查证）

用户对 v0.3.10 的说明提出三条质疑，**三条都成立**，逐条纠正：

**① 「撤销一个为什么多台一起失效」—— v0.3.10 的描述不准确。**
用户原话：「我确定 git credential manager 是你刚开的，这里不是一台机器设置会新建一个么，
为什么删除一个多台会一起失效」。
查证结果：用户的观察是对的，**每台机器单独登录确实各自拿到一个独立 token**。
同一账号 + 同一 App + 同一 scope 最多 10 个 token 并存，超出后 GitHub 会顶掉最久未用的
（见 [docs](https://docs.github.com/en/apps/oauth-apps) 的 oauth-token-limit：
"There is a limit of ten tokens that are issued per user/application/scope combination"）。
但网页上那个「Revoke」是**按 App 撤销**，不是按 token 撤销；
官方 [Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)
原文：「Once an authorization is revoked, any tokens associated with the authorization will be revoked as well.」
→ 所以根因不是「只有一个凭据」，而是**可操作粒度止于 App，单个 token 网页上不给拆**。
面板文案已改成讲清这个区别，不再笼统写「所有机器一起失效」。

**② OAuth 授权能不能加「-机器名」后缀 —— 不能。**
用户问：「这个 git credential manager 如果我在另一个机器上做的，还是同一个名字么；
如果是的话无法区分，是否可以在申请时候后面加上 -xxx 把主机名放进去」。
查证：**Git Credential Manager 是 App 发布方（Git 项目）注册 OAuth App 时定下的名字**，
不是本机生成的；本机既改不了也加不了后缀，全球所有装了 GCM 的机器在网页上都是同一个名字。
（实测本机 GCM 2.9.1 的 `GitHub.dll` 里只有 `gitHubDevClientId` / `gitHubDevRedirectUri`
这两个仅开发模式生效的键，**没有**让终端用户改 App 名或 client id 的配置项；
`credential.gitHubAuthModes` 只控制认证方式 browser/device/pat，不涉及命名。）
→ 想要「按机器命名」，只能用 fine-grained PAT 自己起名。
为此宿主探针新增 `machine:` 行（`$env:COMPUTERNAME`），面板直接给出
`REDMIPRO-YYYYMMDD` 这样的命名示例，不用用户自己去查主机名。

**③ 链接缺 fine-grained tokens —— 补上，并提到 classic 前面。**
用户原话：「你给的是 classic，现在默认的用 /settings/personal-access-tokens，
把这个放在 */tokens 这个链接前面，比较完整」。
已改：② 区先列 `settings/personal-access-tokens`（Fine-grained，GitHub 现在默认推荐），
再列 `settings/tokens`（Tokens (classic)），两个都标明「有名字 + 后 4 位、能单条删」，
并指出「一台机器一个令牌、名字还认得出」只有这条路能做到。

**验证（v0.3.11）**：两个文件 `node --check` 通过；新增 `tools/_render-check.mjs`
把 `CredAccountCard` 抽出来用 React 桩真渲染 4 种输入（有凭据 / 无凭据 / 展开后 / 全空首帧），
断言新文案与降级分支均正确；`C.*` 13/13、`S.*` 40 定义 14 引用均无未定义；
`tools/smoke-route.mjs` 仍 `level=ok`，六项监控 `helper/creds/plaintext/sshkey/deps` 全 ok。
新增的 `machine` 行正则 `^machine:[ \t]*(.*)$` 已用真实 PowerShell 输出对拍通过。

---

## ADR-015 · 分发走「公开 git 直装 + 社区索引」，不发布到 npm

**结论（2026-11-20，v0.4.0）**：本插件的官方分发路径确定为
`dsh plugin add github:mengfanchun2017/dshplug#path:/dsh-gitok`，
并提 PR 收录进社区索引 `awesome-dsh-plugin`。**不**发布到 npm，`"private": true` 保留。

**理由**：

1. **git 路线在本插件上是零摩擦的**，因为三个前提天然成立：
   - 纯 ESM，`lib/index.js` / `lib/client.js` 就是最终产物 → **不需要 `prepare` 构建**；
   - 没有 `postinstall` → 不触发 pnpm 的脚本拦截，用户**不用改 `pnpm-workspace.yaml` 授权 `allowBuilds`**；
   - `dependencies` / `peerDependencies` 全空 → 装完没有依赖树。

   这是关键区别：**大多数插件不能 git 直装，就是因为要构建而用户默认拒绝跑脚本**。本插件不受此限。
   实测：从 git 装下来 15 个文件、`files` 白名单生效、`dsh.bundle.patch` 在位、
   `evaluatePluginCompatibility()` 返回「无未满足要求」。

2. **仓库是 monorepo**，`dsh-gitok` 在子目录。`#path:/dsh-gitok` 已被实测支持
   （`parseInstallSpec()` 解析为 `kind: git`，pnpm 真装成功）。

3. **索引源自治是 DSH 的设计**：官方"不内置任何索引源"，所以"上架官方商店"这个动作不存在，
   能做的只有（a）发布 npm、（b）加 `dsh-plugin` topic、（c）进社区 `format 1` 索引。
   awesome-dsh-plugin 同时是人和机器（`dsh plugin market add`）都能读的索引，性价比最高。

**反面代价（必须接受）**：

- **用户拿到的是"最新 HEAD"，不是锁定的发布版**。git 装不带版本号保证，
  上游一改（含破坏性改动）所有新装用户立即受影响。缓解：`engines.dsh` 卡住运行时不兼容。
- **无法用 `node_modules` 缓存/离线镜像**，每次装都要能连上 GitHub（本机代理一断就 `schannel` 失败，实测过）。
- **`"private": true` 留着**：不碍 git 装，但会把"将来发 npm"这条路堵上——这是有意的，避免误发。
- **并非所有用户都从 git 装**：本机开发仍走 `install.ps1`（`link:` 热更新）。
  **两套路径共存是长期维护成本**，必须把"适用范围"写清楚（已写入 BOOTSTRAP §1.1）。

**已否决的替代方案**：

| 方案 | 为何否决 |
|---|---|
| 发布到 npm（去掉 `private`） | 要处理 scope、版本发布流程、撤销记录；当前收益小（Discover 不是官方唯一入口） |
| 拆成独立仓库（一插件一仓） | 会丢掉 `install.ps1`/`plugpush.ps1`/`list.json` 的本机多插件协同；monorepo 的 `#path:` 已被验证可行 |
| 只靠 README 手装（`.tgz`） | 用户要自己解压放目录；无法随 DSH 的 `plugin add` 生态演进 |
| 等"官方商店开放申请" | 不存在这个机制（源码级确认），等下去等于不推广 |

**验收（v0.4.0）**：`node --check` 两文件通过；`tools/render-check.mjs` 全绿；
`tools/smoke-route.mjs` `level=ok`；git 子目录安装实测成功；
awesome 条目按对方 `validateEntries()` + `slugFor()` 逐条自检无 problem。
---

---

## ADR-016 · 路径一律运行时推导，文档不写死安装位置

**结论（2026-11-22，v0.4.1）**：插件不得假定「装在某一个固定目录」。所有路径运行时推导；
文档里的绝对路径一律标注为「本机示例」。

**背景（真实发生）**：仓库从 `C:\dsh\dw-plugin` 整体搬到 `C:\dsh\dw-plugin`。
搬到之后逐层查了一遍，结论分成两半：

| 层 | 是否硬编码 | 实测 |
|---|---|---|
| `lib/index.js` | **否** | `here = dirname(dirname(fileURLToPath(import.meta.url)))`；`DOCS_WSL = join(here,'docs',...)`。搬完 `smoke-route` 仍 `level=ok`，`docsPath` 自动变成新路径 |
| `lib/client.js` | **否** | 前端不拼绝对路径，路径由宿主经路由下发 |
| `install.ps1` | **否** | `RepoRoot` 默认 `$PSScriptRoot`；注释里还留着当初写死 `C:\dsh\dsh-plugins` 的教训 |
| `cordis.patch.yml` | **否** | `gcmPath` / `proxy` / `heartbeatUrl` 默认空 = 自动探测 |
| `lib/index.js` 的 `revokeImpact` | 部分 | 扫描目录含 `C:\dsh`（`$env:USERPROFILE\git` / `Documents` 是推导的）。**这是有意的**：只用于「撤销前提示影响面」，扫不到只会少列，不会误删 |
| **文档（77 处）** | **是** | 6 份 md 里全是旧的 `C:\dsh\dw-plugin\...`，其中 BOOTSTRAP 39 处、README 25 处 |

**为什么这次要动文档而不是只改代码**：代码本来就是对的，错的是文档把「本机当时的状态」
写成了「必须遵守的规则」——BOOTSTRAP 原来的标题直接是「路径**必须**固定在 `C:\dsh\dw-plugin\dsh-gitok`」，
还写了「不要在别的目录 clone 一份来开发」。这两条都是错的，会让人以为换目录是不可行的。

**顺带修掉一个真 bug（`install.ps1 -Check` 静默漏报）**：
Windows 的 Junction 在目标被移走/改名后，`Test-Path <链接>` **仍返回 True**、`LinkType` 仍是 `Junction`，
**只有访问子项才失败**（2026-11-22 实测）。而 `-Check` 原本只在 `file:` 硬链接形态下调 `Test-BrokenLink`，
`link:` 形态完全不查断链 → **仓库一搬，`-Check` 会把断掉的插件报成 green**。
已新增 `Test-BrokenJunction`：真去读链接下的 `package.json`，读不到就报「链接已断，需重装」。
实测：人为把 Junction 指向不存在的目标，旧逻辑 green、新逻辑正确报错并提示重装。

**反面代价**：
- 文档里仍会出现具体路径（示例、截图文字），不可能 100% 消除；只能保证**每个出现处都标明它是示例**。
- `revokeImpact` 的 `C:\dsh` 扫描面在别人机器上大概率扫不到东西，影响面会显示为空。
  已用「未扫到 ≠ 没有」的文案兜住，不假装完整。
- 搬仓后必须记得重装（`-Force`），否则断链。这个动作无法自动完成——
  但**现在至少会被 `-Check` 抓出来**，不再静默。

**已否决的替代方案**：

| 方案 | 为何否决 |
|---|---|
| 代码里读配置项 `installRoot` | 多一个用户必须理解的旋钮；而 `import.meta.url` 已经天然正确，不需要配置 |
| 搬仓后用脚本自动改 profile 的 `link:` | 需要 DSH 未运行时操作 profile，风险大于收益；`install.ps1 -Force` 已是一行命令 |
| 把绝对路径全删、只写相对路径 | 用户在 PowerShell 里执行需要完整命令；示例必须可复制执行 |
| 强制固定目录（现状） | 每条路径都是本机的偶然事实，不是约束。换机器就失效，且会阻止用户按自己习惯布局 |

**验收（v0.4.1）**：`smoke-route` `level=ok`（`docsPath` 跟随实际位置）；
`render-check` 全绿；`install.ps1 -Check` 对健康仓库全绿、对人为断链正确报错；
README/BOOTSTRAP 代码围栏配平（98 / 82，均偶数）；全库「必须固定」类错误陈述已清零。
