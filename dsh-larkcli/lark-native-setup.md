# 全新 Windows 机器接入飞书（不用 WSL、不用预装 Node）

这套文件是自包含的：把整个 `dsh-larkcli` 目录（本插件工作区）拷到新机器即可。
唯一前提：**Windows 10/11 x64 + PowerShell + 网络能到 open.feishu.cn**。
不需要 WSL、不需要系统 Node.js、不需要 Claude Code。

## 目录里有什么

| 文件 | 作用 |
|---|---|
| `lark-cli-win/lark-cli.exe` | 飞书官方 CLI v1.0.99 的 **Windows 原生二进制**（50 MB，自带 Go runtime） |
| `lark-cli-win/_native-config/config.json` | 应用凭证配置（App ID + 指向 secret 文件） |
| `lark-cli-win/_native-config/appsecret.txt` | App Secret 明文（仅本机可读） |
| `lark.ps1` | 封装好环境变量的调用入口，纯 Windows |
| 本文 | 换机 / 重装步骤 |

二进制来源与校验（下载时已验证）：
- 官方发布：`lark-cli-1.0.99-windows-amd64.zip`
- 下载：`https://registry.npmmirror.com/-/binary/lark-cli/v1.0.99/lark-cli-1.0.99-windows-amd64.zip`
- SHA256：`1b43cb63ff533ee067db45d93a862074d147df5a0d05f95c2d2a7c70c3f97375`（与官方 `checksums.txt` 一致）

## 最小使用（拷过去就能跑）

```powershell
cd <拷过去的目录>
.\lark.ps1 auth status
.\lark.ps1 "im +chat-list --page-size 10 --as bot"
.\lark.ps1 "im +messages-search --query 周报 --page-size 5"
```

`--as bot` 是应用身份：不需要任何登录/扫码，配置好 secret 后立即可读机器人所在会话、发消息等。
实测已通过：`api GET /open-apis/bot/v3/info`、`im +chat-list --as bot` 都返回 `ok: true`。

## 想读「你本人」的私有资源？授权一次

应用身份读不到你的个人日历、私人文档、邮件、你与别人的私聊历史。
这些要 user 身份，首次在新机器上做一次设备流授权（约 1 分钟）：

```powershell
# 1) 生成授权链接 + 二维码（后台运行，输出 verification_url）
.\lark.ps1 "auth login --no-wait --json --recommend"

# 2) 用浏览器打开输出的 verification_url，或：
.\lark.ps1 "auth qrcode --output qr.png"        # 生成二维码图片，手机飞书扫

# 3) 授权完成后，把上一步给的 device_code 回填：
.\lark.ps1 "auth login --device-code <device_code>"

# 4) 验证
.\lark.ps1 auth status        # user.available = true
.\lark.ps1 "im +messages-search --query 周报 --page-size 5"   # 不带 --as bot 即 user
```

user token 约 2 小时过期，CLI 会自动用 refresh token 续（refresh 约 7 天）。
过期太久就重跑一次第 1–3 步。

## 换飞书应用 / 换 App Secret

1. 编辑 `lark-cli-win/_native-config/appsecret.txt`，只放 secret 本身，无换行。
2. 编辑 `config.json` 里的 `appId`；`appSecret.id` 用**正斜杠绝对路径**指向该文件：

```json
{
  "apps": [{
    "appId": "cli_你的ID",
    "appSecret": { "source": "file", "id": "C:/dsh/dsh-larkcli/lark-cli-win/_native-config/appsecret.txt" },
    "brand": "feishu"
  }]
}
```

⚠️ 为什么不用 `lark-cli config init`：它在 Windows 上默认写系统 keychain，沙箱/服务账户下会报
`keychain unavailable ... Access is denied`。`{source:file,id:绝对路径}` 是官方支持的绕法（相对路径不行，会报找不到文件）。
另外 `lark-cli config set dpop disabled` 可消除 Windows 上的 DPoP key 锁警告（功能不受影响）。

## 升级二进制

```powershell
# 到 https://github.com/larksuite/cli/releases 查最新版本 vX.Y.Z，改下面三处：
$ver='1.0.99'
curl.exe --ssl-revoke-best-effort -fL -o lark-cli-win\lark-cli.zip "https://registry.npmmirror.com/-/binary/lark-cli/v$ver/lark-cli-$ver-windows-amd64.zip"
# 用官方 checksums.txt 核对 SHA256 后再 Expand-Archive 覆盖 lark-cli.exe
```
GitHub 直连在国内常超时；上面用的是 npmmirror 官方二进制镜像（下载时已实测 15 MB / 秒级完成）。

## 在 DSH 里做成原生工具（可选）

上面是「agent 用 pwsh 调 CLI」。想让模型直接看到 `mcp__feishu__*` 工具：

本仓库的 `package.json` 已放好 `@local/dsh-larkcli` 骨架；正式做成 DSH 插件的路线见 [README.md](<README.md>) 的「插件化路线」。

参考实现（都是第三方，安装前请自行审阅源码）：

- [dsh-feishu-mcp](https://dshmp.com/en/plugins/dsh-feishu-mcp)（v0.1.3）：驱动官方 `@larksuiteoapi/lark-mcp` stdio 服务器，把 IM / 多维表格 / 文档 / 日历 API 暴露成 `mcp__feishu__*`，带 Web 设置面板与 OAuth。工具面比 lark-cli 窄，且需要 `npx`（新机器要先装 Node.js）。
- [dsh-plugin-lark](https://www.npmjs.com/package/dsh-plugin-lark)：飞书「通道」插件（扫码建机器人 + 监听器 + 审批卡片），不是读取线上内容的工具，且依赖 macOS/网关 Python 进程。

注意：DSH 自带的 `@deepseek-ai/dsh-mcp-client` 在当前 desktop profile 的 `cordis.patch.yml` 里**没有挂载**，所以裸装 MCP server 不会自动出现工具。
## 安全

- `appsecret.txt` 是明文，目录权限仅当前用户可读；别提交进 git、别发聊天。
- `--as bot` 的权限 = 该应用在开放平台勾选并发布的权限；目前这个应用只有 IM 相关 scope。
- user 身份授权后，agent 以你的身份操作，范围以授权 scope 为准；lark-cli 默认开启输入防注入与输出净化，别主动关。
