# lark.ps1 — 纯 Windows 原生调用飞书官方 lark-cli（不依赖 WSL / 不依赖系统 Node）。
#
# 二进制：本目录下 lark-cli-win\lark-cli.exe（官方 v1.0.99 windows-amd64，
#         从 npmmirror 镜像下载并用官方 checksums.txt 校验过 SHA256）。
# 配置：  lark-cli-win\_native-config\config.json
#         LARKSUITE_CLI_CONFIG_DIR 指向它；appSecret 用 {source:file,id:绝对路径}
#         引用同目录的 appsecret.txt，绕开 Windows 上不可用的 keychain。
#
# 用法（参数原样透传；带逗号的整段加引号）：
#   .\lark.ps1 auth status
#   .\lark.ps1 "im +chat-list --page-size 10 --as bot"
#   .\lark.ps1 "im +messages-search --query 周报 --page-size 5"
#   .\lark.ps1 "docs +fetch --doc <token>"
#   .\lark.ps1 "auth login --no-wait --json --recommend"   # 新机器自助授权
#
# 身份：--as bot 用应用身份（无需登录，立即可用）；
#       --as user 用本人身份（首次需扫码授权一次，见 lark-native-setup.md）。

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $CliArgs
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $root 'lark-cli-win\lark-cli.exe'
$cfg  = Join-Path $root 'lark-cli-win\_native-config'

if (-not (Test-Path -LiteralPath $exe)) {
    Write-Error "找不到原生 lark-cli：$exe`n请按 lark-native-setup.md 第 1 步放置二进制。"
    exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $cfg 'config.json'))) {
    Write-Error "找不到配置：$cfg\config.json`n请按 lark-native-setup.md 第 2 步初始化。"
    exit 2
}

$env:LARKSUITE_CLI_CONFIG_DIR = $cfg
if (-not $CliArgs -or $CliArgs.Count -eq 0) { $CliArgs = @('--help') }

# 兼容两种写法：
#   .\lark.ps1 auth status                          -> 多个参数，原样透传
#   .\lark.ps1 "im +chat-list --page-size 10"      -> 单个含空格的字符串，按空白拆词
# 只在「恰好一个参数且含空格」时拆分，避免把 --query "周报 汇总" 这类带空格的值拆坏。
$argv = @()
if ($CliArgs.Count -eq 1 -and $CliArgs[0] -match '\s') {
    foreach ($m in [regex]::Matches($CliArgs[0], '"[^"]*"|''[^'']*''|\S+')) {
        $t = $m.Value
        if ($t.Length -ge 2 -and (($t[0] -eq '"' -and $t[-1] -eq '"') -or ($t[0] -eq "'" -and $t[-1] -eq "'"))) {
            $t = $t.Substring(1, $t.Length - 2)
        }
        $argv += $t
    }
} else {
    $argv = $CliArgs
}

& $exe @argv
exit $LASTEXITCODE
