# dsh-larkcli

> DeepSeek Harness 插件（开发中）· **已并入 dshplug 仓库**：`C:\dsh\dshplug\dsh-larkcli`
> 2026-11-11 从 `default-workspace` 迁入 `C:\dsh`，2026-11-12 并入 dshplug。
## 这个插件要解决什么

让 DSH Agent 在**纯 Windows 环境**下读取 / 操作飞书（Lark）线上内容：

- 不依赖 **WSL**（用户明确要求）
- 不依赖用户预装 **Node.js / Go / Python**
- 不依赖 Claude Code 或任何既有 lark-cli 授权
- 换一台只装了 DSH 的 Windows 机器，把这个目录拷过去就能用

底层是飞书官方 [lark-cli](https://github.com/larksuite/cli) 的 **Windows 原生二进制**
（v1.0.99，18 个业务域 / 200+ 命令 / 26 个 Agent Skills），而不是
`@larksuiteoapi/lark-mcp`——后者是 Beta、工具面更窄、且需要 `npx`。

## 当前状态：可用，尚未插件化

| 层 | 状态 |
|---|---|
| 原生二进制 + 校验下载脚本 | ✅ [scripts/fetch-lark-cli.ps1](<scripts/fetch-lark-cli.ps1>) |
| 绕过 Windows keychain 的凭据配置 | ✅ `lark-cli-win/_native-config/`（**不进 git**） |
| 纯 PowerShell 入口 | ✅ [lark.ps1](<lark.ps1>) |
| 换机 / 授权 / 升级文档 | ✅ [lark-native-setup.md](<lark-native-setup.md>) |
| DSH 插件骨架（package.json / .gitignore / README） | ✅ 本次建立 |
| Cordis 插件入口、工具注册、设置面板 | ⬜ 待开发 |
| git 仓库初始化 | ✅ 2026-11-11 已 `git init`（未 commit，留待审阅） |

**实测**（2026-11-11，迁移后复测）：
`auth status` → `Bot identity: ready`；`im +chat-list --page-size 2 --as bot` → `ok: true`。

## 快速用

```powershell
cd C:\dsh\dshplug\dsh-larkcli
.\lark.ps1 auth status
.\lark.ps1 "im +chat-list --page-size 10 --as bot"
.\lark.ps1 "im +messages-search --query 周报 --page-size 5 --as user"   # 需先授权一次
```

`--as bot`：应用身份，配置好 secret 立即可用，范围 = 应用在开放平台发布的权限。
`--as user`：本人身份，首次需设备流授权（链接/二维码），可读私人文档、日历、邮件、私聊历史。
授权步骤见 [lark-native-setup.md](<lark-native-setup.md>)。

## 插件化路线（建议顺序）

1. **工具层**：写 `src/index.js`（Cordis 插件），注册一组 DSH 工具：
   `lark_status` / `lark_call` / `lark_login_start` / `lark_login_finish`。
   `lark_call` 内部用 `child_process.spawn` 调 `lark-cli.exe`，
   用 `LARKSUITE_CLI_CONFIG_DIR` 指向本仓库的配置目录，透传 JSON 输出。
   参考 DSH 自带 `@deepseek-ai/dsh-mcp-client` 的 `mcp-client` 配置方式
   （当前 desktop profile 的 `cordis.patch.yml` 未挂载它，插件自带 bundle patch 解决）。
2. **配置层**：Web 设置面板填 App ID / Secret、显示 `auth status`、发起设备流授权并展示二维码。
   凭据写 `lark-cli-win/_native-config/`，不要写系统 keychain（Windows 下会 Access denied）。
3. **打包层**：`cordis.patch.yml` bundle patch + `dsh.bundle.patch` 声明；
   `lark-cli.exe` 不入 git，靠 `postinstall`/首次启动调 [fetch-lark-cli.ps1](<scripts/fetch-lark-cli.ps1>) 补齐。
4. **发布**：去 `private: true`、补 `dsh.engines.dsh` 与实际测试过的版本范围、写 CHANGELOG。

## 目录约定

```
dsh-larkcli/
├── README.md                     ← 本文件（插件总览）
├── package.json                  ← 插件骨架
├── .gitignore                    ← 凭据 / 大二进制 / test 产物 都不进 git
├── lark.ps1                      ← 纯 Windows 调用入口
├── lark-native-setup.md          ← 换机 / 授权 / 升级
├── scripts/
│   └── fetch-lark-cli.ps1        ← 官方二进制下载 + SHA256 校验
├── lark-cli-win/
│   ├── lark-cli.exe              ← 原生二进制（gitignore，脚本补）
│   ├── CHANGELOG.md / LICENSE / README.md
│   └── _native-config/           ← 凭据（gitignore，绝对不提交）
│       ├── config.json
│       └── appsecret.txt
└── test/                         ← 临时测试产物，用完即删
```

## 纪律

- **所有临时测试放 `test/`，用完删除**。已在 [default-workspace/test/README.md](<C:/Users/franc/Documents/deepseek-harness/default-workspace/test/README.md>) 立过规矩；本仓库同样执行。
- `lark-cli-win/_native-config/` 含明文 App Secret，**绝不进 git**。
- 二进制升级必须校验官方 SHA256 后再覆盖。

## 相关背景

- 官方 CLI：[larksuite/cli README.zh](https://raw.githubusercontent.com/larksuite/cli/HEAD/README.zh.md)
- 官方 MCP（备选）：[lark-openapi-mcp](https://raw.githubusercontent.com/larksuite/lark-openapi-mcp/main/README.md)
- 社区参考：[dsh-feishu-mcp](https://dshmp.com/en/plugins/dsh-feishu-mcp)、[dsh-plugin-lark](https://www.npmjs.com/package/dsh-plugin-lark)
- 旧的自建通道 `feishu-bridge` 仍在 `default-workspace\feishu-bridge`（已确认不迁移，见下方「已确认的决策」）

## 已确认的决策（2026-11-11）

- **旧 `feishu-bridge` 不迁移**，继续留在 `default-workspace\feishu-bridge`，`DSH-Feishu-Bridge` 计划任务不动。
  它是飞书长连接聊天通道，与本插件用途不同，保持两处分离。
- **已并入 dshplug**：原先 `C:\dsh\dsh-larkcli\.git` 那个空仓库（无任何提交）已弃用，
  历史从现在开始由 `C:\dsh\dshplug` 统一管理（分支 `master`）。
  `.gitignore` 已验证挡住 `_native-config/`（明文 App Secret）、`lark-cli.exe`、`*.zip`、`test/*`。
- 临时测试产物纪律：`test/` 下用完即删；根目录那 41 个 `t_*` 旧探针已删除。
