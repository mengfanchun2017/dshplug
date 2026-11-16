# 让 WSL 里的 git 用上 Windows 的凭据

> **两种用法**
> - **想自己看懂 / 自己动手** → 读[第一部分](#第一部分原理与手工配置)，有完整解释。
> - **想让 AI 帮你配** → 直接跳到[第二部分](#第二部分粘给-ai-的指令)，复制那段话贴给任意 Vibe Coding Agent（Claude Code / Codex / Cursor / Trae 等）即可。
>
> 相关：`ADR-006`（WSL 功能默认冻结）、`README.md` §5（面板里的 WSL 折叠区）。
>
> **本文件绝对路径**（直接复制给 agent，让它自己读）：
>
> ```text
> C:\dsh\dshplug\dsh-gitok\docs\WSL-GIT-AUTH.md
> ```
>
> 面板里也显示这个路径并带一键复制：侧边栏 Mgitok → 持续监控下方「WSL 里怎么用」展开。

---

## 第一部分：原理与手工配置

### 1. 一句话原理

**WSL 里不存任何密钥。** 它的 git 需要凭据时，通过 WSL interop 直接执行 Windows 的
`git-credential-manager.exe`，由 GCM 从 Windows 凭据管理器（DPAPI 加密）取出后回给 git。

```
WSL 的 git  ──fork──►  /mnt/c/.../git-credential-manager.exe  ──►  Windows 凭据管理器
   (只管问)                 (经 WSL interop 执行)                    (DPAPI，密钥出不了这台机器)
```

由此得到三个好处：

| 好处 | 说明 |
|---|---|
| WSL 磁盘上零密钥 | `~/.git-credentials`、`~/.config/gh/hosts.yml` 都可以是空的 |
| 只在 Windows 登录一次 | 所有发行版跟着变，不用每个 distro 各配一遍 |
| 轮换只做一次 | 换 token / 换账号只在 Windows 重登，WSL 侧无需动作 |

### 2. 为什么不用「在每个 WSL 里各存一份 PAT」

能跑，但代价是：每个发行版一份明文（或 gh 的 hosts.yml）、轮换要挨个改、
一旦某个 distro 被备份/上传/打进镜像，密钥就跟着出去了。
本插件的立场是**只保留 Windows 那唯一一份**，其余全部借用。

### 3. 三条命令的手工版

先在 Windows 侧确认 GCM 存在（`gitok_doctor` 的 `gcmPath` 字段就是这个路径）：

```powershell
# Windows PowerShell 里
where.exe git-credential-manager.exe
# 典型输出：C:\Users\<你>\AppData\Local\Programs\MinGit\ucrt64\bin\git-credential-manager.exe
```

把它换算成 WSL 路径：`C:\Users\franc\...` → `/mnt/c/Users/franc/...`
（盘符小写，反斜杠变正斜杠）。然后**在 WSL 里**执行：

```bash
# ⚠️ 把 <distro> 换成你的发行版名；GCM 换成上一步的真实路径
GCM=/mnt/c/Users/franc/AppData/Local/Programs/MinGit/ucrt64/bin/git-credential-manager.exe

# ① interop 通不通（最容易出错的一步）
test -x "$GCM" && echo OK || echo MISSING

# ② 先备份，改坏了能退
cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S)

# ③ 按 host 精确接管（不是 --global helper，别一把梭）
for h in github.com gist.github.com; do
  git config --global --unset-all "credential.https://$h.helper" 2>/dev/null || true
  # 注意内层双引号要转义写成 \" ：外层 shell 会剥掉最外层引号，
  # 只有转义的内层引号才能让 git 存下 !"<路径>"。
  # 不转义 → 存储值无引号 → 路径带空格时 sh 按空格拆开报 not found。
  git config --global --add "credential.https://$h.helper" "!\"$GCM\""
done

# ④ 复查：每个 host 只应剩一条
git config --global --get-all "credential.https://github.com.helper"
```

**验证（必须看到 40 位 SHA）：**

```bash
# ⚠️ 不要接管道！`| head` 会把超时伪装成 exit=0
cd ~/git/<某个仓库>
timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"
```

**验证通过之后**才删明文：

```bash
gh auth logout -h github.com 2>&1 || true
rm -f ~/.git-credentials

# 删完立刻再验一次（此时完全依赖 interop）
cd ~/git/<某个仓库> && timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"
```

### 4. 四个必踩的坑

| 坑 | 现象 | 怎么避 |
|---|---|---|
| **先删明文再接管** | 顺序反了直接丢认证，只能重新登录 | 严格按 ①→④ 走：先接管、验证通过、再删 |
| **接管道看结果** | `git ls-remote \| head` 超时也显示 exit=0，误判成功 | 用 `timeout 40 ...; echo $?` 看真实退出码 |
| **VPN 没开** | 任何 helper 都超时，看着像 GCM 坏了 | 先 `curl -sS -o /dev/null https://github.com`，它也慢就是网络问题 |
| **`/mnt/c` 没挂 / interop 关闭** | `test -x` 报 MISSING | 检查 `/etc/wsl.conf` 里 `interop.enabled` 没被关；`wsl -l -v` 看发行版状态 |

**Windows 侧也要留意**：如果 Windows 上 GCM 的 store 是 `wincredman`（默认），
在网络登录 / SSH 会话里可能取不到；那种情况改用 `dpapi` store。

### 5. 回滚

```bash
# 找到备份（按时间戳命名）
ls -t ~/.gitconfig.bak.gitok-* | head -1
cp "$(ls -t ~/.gitconfig.bak.gitok-* | head -1)" ~/.gitconfig
```

---

## 第二部分：粘给 AI 的指令

> 用法：**把下面整段（从「你是」到最后一个 ``` 结束）原样粘给任意 Vibe Coding Agent**（Claude Code / Codex / Cursor / Trae 都行），
> 它会自己探测、自己配置、自己验证。不需要你补任何信息。

````text
你是我的操作系统助手，现在要帮我配置一个 WSL 发行版里的 git 凭据，让它借用 Windows 的
Git Credential Manager（GCM），从而不在 WSL 磁盘上保存任何密钥。

## 背景（已确定的事实，不要推翻）

- 我的 Windows 已经装好 GCM，并且 git 已配好 `credential.helper = manager`。
- 凭据存在 Windows 凭据管理器里，DPAPI 加密，换台机器解不开。这是我要的效果。
- 目标是：WSL 里的 git 需要凭据时，经 WSL interop 执行 Windows 的
  `git-credential-manager.exe`，不落盘任何明文。
- 我可能有多个 WSL 发行版，但**这次只处理我指定的那一个**，其它不要碰。

## 你的任务，按顺序做，每步都要有输出

### 第 1 步：探测（只读，不要改任何东西）

请报告：
1. `wsl.exe -l -v` 的输出 —— 有哪些发行版、哪个是默认、版本号。
2. 在目标发行版里执行：`uname -a`、`git --version`。
3. 找到 Windows 侧 GCM 的**真实路径**。可以从这些地方找：
   - Windows 上 `where.exe git-credential-manager.exe`
   - 或 Common Files 下的 Git Credential Manager
   - 或 MinGit 的 `ucrt64\bin\`
4. 把该路径换算成 WSL 路径（`C:\a\b` → `/mnt/c/a/b`），然后
   `test -x "<路径>" && echo OK || echo MISSING`。
5. 目标发行版当前的 git 凭据相关配置，**原样贴出来**：
   `git config --list --show-origin | grep -i credential`
6. 是否存在明文凭据文件：`ls -l ~/.git-credentials ~/.config/gh/hosts.yml 2>&1`

如果第 4 步是 MISSING，**停下来**告诉我，不要继续 —— 说明 interop 或路径有问题，
先解决它。

### 第 2 步：备份

    cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S)

报告备份文件的完整路径。

### 第 3 步：配置（按 host 精确接管）

⚠️ 不要用 `git config --global credential.helper` 一把梭 —— 那会覆盖掉我可能已有的
其它 host 的 helper（比如飞书的），把别的东西弄坏。

只对 github.com 和 gist.github.com 设置：

    for h in github.com gist.github.com; do
      git config --global --unset-all "credential.https://$h.helper" 2>/dev/null || true
      git config --global --add "credential.https://$h.helper" "!<第1步的真实GCM路径>"
    done

注意：
- 前面的 `!` 是 git 的 shell 命令前缀，不能省，也不能加多余空格。
- 路径里有空格时要正确引号处理。
- 如果我的 git 版本低于 2.26，`credential.<url>.helper` 可能不生效 ——
  这种情况告诉我，我们再商量。

### 第 4 步：验证（这一步不能省，也不能糊弄）

    cd ~   # 或任意一个已存在的 git 仓库
    timeout 40 git ls-remote https://github.com/<任意公开仓库>.git HEAD; echo "REAL_EXIT=$?"

要求：
- **不要接管道**（`| head`、`| cat`）—— 管道会把超时伪装成成功。
- 必须看到真实的 40 位 SHA 和 `REAL_EXIT=0`。
- 首次可能弹浏览器让我登录，这是预期的，告诉我一声。
- 如果超时：先让我确认 VPN / 代理是否开着，再排查 GCM 本身。
  在 WSL 里 `curl -sS -o /dev/null -w '%{http_code}\n' https://github.com` 也慢的话，
  那是网络问题，不是配置问题。

### 第 5 步：清理明文（只有第 4 步通过才做）

先告诉我你打算删哪些文件，**等我确认后**再执行：

    gh auth logout -h github.com 2>&1 || true
    rm -f ~/.git-credentials

删完立刻再验证一次（此时完全依赖 interop）：

    cd ~/git/<仓库> && timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"

### 第 6 步：总结

给我一份清单：
- 改了哪个文件的哪几行（`~/.gitconfig` 的具体内容）
- 备份文件在哪、怎么回滚
- 最终每个 host 的 helper 是什么（贴 `git config --list | grep credential`）
- 还有哪些明文凭据文件**没有**删、为什么

## 硬性约束

- **不要**在 WSL 里写任何长期有效的 token / PAT 到磁盘。
- **不要**动我其它 WSL 发行版的配置。
- **不要**动 Windows 侧的配置（那是已经好的，由另一个工具管理）。
- 每一步的命令和真实输出都要贴给我，不要只说「已完成」。
- 遇到需要我确认的破坏性操作（删除文件），必须先问。
````

---

## 附：为什么不用「在 WSL 装 GCM」

`GCM` 有 Linux 版，理论上可以直接装在 WSL 里。但那样它会用 Linux 侧的密钥后端
（`secretservice` / `gpg` / `pass` / `cache`），密钥就落到 WSL 里了 ——
和「密钥出不了这台 Windows 机器」的目标相反，而且每个发行版要各配一遍。

本插件选的是「借用 Windows 那唯一一份」，代价是依赖 WSL interop
（`/mnt/c` 必须挂载、interop 不能关），收益是**密钥只有一处**。
这是一个明确的取舍，记录在 `ADR-006`。
