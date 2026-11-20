# 提交到 awesome-dsh-plugin 的操作手册

> 目标：把 `dsh-gitok` 收录进 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>。
> 本文件是**给我（用户）照着做**的 checklist，不是给 AI 执行的脚本。
> 同目录的 `awesome-dsh-plugin-entry.yml` 就是**要提交的那个文件内容**，已按对方校验器逐条验过。

---

## 0. 先回答两个问题

### 它是官方的吗？——不是

| 事实 | 证据 |
|---|---|
| 它是**社区 awesome 列表**，不是 DeepSeek 官方 | 仓库 `license: CC0-1.0`，组织名 `awesome-dsh-plugin`，与 `deepseek-ai` 无关 |
| DSH 官方**不内置任何索引源** | 官方文档原文「DSH 不内置任何索引源」，插件市场是机制不是商店 |
| 官方 README 里**只提了 `dsh-plugin` topic**，没提这个列表 | [deepseek-ai/deepseek-harness README](https://github.com/deepseek-ai/deepseek-harness) 的 Community 段只说「给仓库加 `dsh-plugin` topic」和 Discord |

**但它不是没用的野榜**：它同时**就是**一份 `format 1` 插件市场索引，会被
`dsh plugin market add <url>` 直接消费，并且发布到 npm 的 `dsh-plugin-catalog` + `https://awesome-dsh-plugin.com/index.json`。
所以收录 = 同时进了「人看的列表」和「机器读的索引」。

### 上线推广还要去别的地方申请吗？——不用再「申请」，但值得做另外三件事

| 渠道 | 要不要申请 | 说明 |
|---|---|---|
| **awesome-dsh-plugin** | ✅ 要提 PR | 本文档讲的就是它 |
| **DSH 官方市场（Discover）** | ❌ 没有申请入口 | 官方只认 npm 包 + 索引源；你能做的是**发布到 npm** 后让用户 `dsh plugin add dsh-gitok` |
| **`dsh-plugin` GitHub topic** | ✅ 强烈建议，**不用申请** | 给仓库加上 `dsh-plugin` topic，官方 README 明说这是官方推荐的可发现性做法。5 秒，收益最高 |
| **`dshmarket` 插件市场** | 看它的规则 | 是另一个**第三方市场插件**，awesome 列表自己都推荐它。要不要单独提，看它仓库说明 |
| **自己发 npm** | 可选 | 当前 `"private": true`，发 npm 前要去掉；发了才能进 Discover 之外的 npm 生态 |

**结论**：把 awesome 收录 + `dsh-plugin` topic 这两件做完，公开推广的主要渠道就覆盖了。
不存在「官方插件中心申请」这个东西——DSH 的设计就是索引源自治。

---

## 1. 提交前的硬前提（对方 gate 会查，缺了必挂）

| 检查项 | 本插件状态 | 依据 |
|---|---|---|
| 仓库里某处有 `dsh.bundle` 的 `package.json` | ✅ `dsh-gitok/package.json` | gate 的 `hasBundle()` |
| 入口 URL **必须指向含 manifest 的子目录** | ✅ `/tree/master/dsh-gitok` | 指向仓库根会被要求改成子目录（gate 会给出正确路径） |
| 仓库不是 DSH 本体 | ✅ 不是 | |
| 仓库**公开** | ✅ HTTP 200 | |
| 仓库**存在 ≥1 天** | ✅ 2026-11-11 建，已 9 天 | `MIN_AGE_DAYS = 1` |
| **提交数门槛** | ✅ 无门槛 | 旧版有 `MIN_COMMITS = 10`，**现已删除**——别为凑数去灌提交 |
| 文件名 = slug | ✅ `mengfanchun2017__dshplug--dsh-gitok.yml` | `slugFor()`：`owner__repo--sub-路径` |
| `category` 在白名单内 | ✅ `security` | 23 个可选值之一 |
| `description.en` 必填且单行 | ✅ 500 字符单行 | 中文可选（本文件已带） |
| 描述里含 `: ` 必须加引号 | ✅ 已用单引号包裹 | 否则 YAML 解析失败 |
| `icon` 只收 GitHub 上的 **png/jpg/webp** | ⚠️ 本插件只有 `icon.svg`，**故意不填** | 填 svg 会被拒；不填就回退到 GitHub 头像，正常 |

> **不要**为凑「提交数」去灌 commit。gate 的注释明确说旧 commit 门槛导致大家刷 commit，
> 所以那个规则被删了。仓库里本来就有 40 个提交，够用。

---

## 2. 具体操作（网页版，最省事）

### 2.1 Fork + 建分支

1. 打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>，点 **Fork**
2. 在你 fork 出来的仓库里，分支保持 `main`

### 2.2 建文件（只需一个文件）

在**你 fork 的仓库**里点 `Add file` → `Create new file`，路径填：

```
data/plugins/mengfanchun2017__dshplug--dsh-gitok.yml
```

内容 = 本目录 `awesome-dsh-plugin-entry.yml` 的内容：

```yaml
url: https://github.com/mengfanchun2017/dshplug/tree/master/dsh-gitok
name: mengfanchun2017/dshplug#dsh-gitok
category: security
description:
  en: '...上一步文件里的英文...'
  zh: '...上一步文件里的中文...'
```

**关键点**：
- 路径必须在 `data/plugins/` 下（放错目录 = 静默不生效，其他检查还全绿）
- 扩展名必须 `.yml`（`.yaml` 会被静默跳过）
- **不要动 README**，它由 `sync-readme.yml` 合并后自动重建

### 2.3 提 PR

标题建议：`Add mengfanchun2017/dshplug#dsh-gitok (git credential management)`

描述里写清三件事（提高过审率，审核者要看源码核对描述）：
1. 插件做什么 —— 把 git 凭据收敛到 Windows 凭据管理器，WSL 借 interop
2. 为什么是 `security` 分类 —— 它管理的是凭据与明文泄露面
3. 有没有破坏性行为 —— 无；不写凭据、不打印 token

---

## 3. 怎么知道结果 / 在哪看反馈

提交后会跑**两套**工作流，看三个地方：

| 看什么 | 在哪看 | 说明 |
|---|---|---|
| **① PR check** | PR 页面底部 Checks 区，名字 `PR check` | 立即跑。查文件名/目录/扩展名/YAML 能否解析/是否删了别人的条目 |
| **② Submission gate** | PR 页面 Checks 区，名字 `Submission gate` | 稍晚出现（`workflow_run` 触发）。**这个才是真正的审核门槛**：查仓库年龄、`dsh.bundle`、URL 指向对不对 |
| **③ 人工 review** | PR 的 Conversation，维护者留言 | gate 全绿不等于合并，最终由人合并 |

**反馈不是邮件、不是私信**——全部在 PR 页面上。你只需要**盯着那个 PR 页面**。

### 常见 gate 报错 → 怎么改

| Check 输出 | 含义 | 处理 |
|---|---|---|
| `the entry points at the repository root, but the root package.json declares no dsh.bundle` | URL 指错了 | 它会在正文里给出**确切的** `url:` / `name:` 改法，照抄 |
| `repository is N.N days old (needs 1)` | 仓库太新 | **什么都不用做**，它会自己重跑并变绿（原文：no need to resubmit） |
| `declares only dsh.client — that alone is not installable` | 缺 `dsh.bundle` | 本插件有 `bundle`，不会踩 |
| `filename must match the url — expected X.yml` | 文件名不对 | 改成它给的名字 |
| `N entry file(s) are not valid YAML` | 描述里有未加引号的 `: ` | 给描述加引号 |
| `This PR also rewrites N existing entries` | 你的 fork 是旧的 | 点 GitHub 的 **Sync fork**，重新推；一个提交应该只有 `+1/-0` |

---

## 4. 合并之后会自动发生什么（你什么都不用做）

1. `sync-readme.yml` 重新生成英/中两份 README —— **所以千万别手动改 README**
2. `build-site.yml`（每天 02:23 UTC）重建站点并发布到 npm 的 `dsh-plugin-catalog`
3. 站点会自动生成安装命令：
   `dsh plugin --profile web add github:mengfanchun2017/dshplug#path:/dsh-gitok`
   —— 这正好就是我 README §6.6 里写的命令，两边一致。

---

## 5. 我这边已经为这次提交做好的准备

- ✅ 修掉 0 字节的根 `package.json`（它会让从仓库根跑的 Node 工具报 `ERR_INVALID_PACKAGE_CONFIG`）
- ✅ `engines.dsh` 从 `<0.3.0-0` 放宽到 `<0.4.0-0`
- ✅ 实测 `github:...#path:/dsh-gitok` 能装成功：15 个文件、`dsh.bundle.patch` 在位、
      `evaluatePluginCompatibility()` 返回「无未满足要求」、**无构建步骤、无依赖、不需要 allowBuilds**
- ✅ README §6.6 补了「在新 DSH 上安装」，§6.7 补了「其他 Vibe Agent 怎么生效」
- ✅ BOOTSTRAP §1.1/§1.2 补了适用范围与公开仓库安装，§10.4.1–10.4.3 补了五步依赖链

---

## 6. 一句话总结

**提一个 PR、加一个 `dsh-plugin` topic、盯着 PR 页面看 Checks** —— 就这三步。
awesome-dsh-plugin 不是官方的，但它是目前最大的社区索引，且同时是机器可读的市场索引；
官方那边没有「申请入口」，只有 npm 与 topic 两条自助路径。
