# fetch-lark-cli.ps1 — 重新拉取飞书官方 Windows 原生 lark-cli 二进制。
#
# .gitignore 不收录 50 MB 的 exe；clone 仓库后跑一次本脚本即可补齐。
# 下载源用官方 npmmirror 二进制镜像（GitHub 直连在国内常超时），
# 并用官方 checksums.txt 里的 SHA256 校验后才落盘。
#
# 用法：
#   .\scripts\fetch-lark-cli.ps1                # 默认 v1.0.99
#   .\scripts\fetch-lark-cli.ps1 -Version 1.0.100 -Sha256 <官方新哈希>

param(
    [string] $Version = '1.0.99',
    [string] $Sha256  = '1b43cb63ff533ee067db45d93a862074d147df5a0d05f95c2d2a7c70c3f97375'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$win  = Join-Path $root 'lark-cli-win'
$exe  = Join-Path $win 'lark-cli.exe'
$zip  = Join-Path $win "lark-cli-$Version-windows-amd64.zip"

if (Test-Path -LiteralPath $exe) {
    Write-Host "已存在：$exe（如需强制重下，先删除它）"
    exit 0
}
New-Item -ItemType Directory -Force -Path $win | Out-Null

$url = "https://registry.npmmirror.com/-/binary/lark-cli/v$Version/lark-cli-$Version-windows-amd64.zip"
Write-Host "下载：$url"
# Windows Schannel 在 CRL 服务器不可达时会报 CRYPT_E_REVOCATION_OFFLINE，
# 官方 install.js 也是用 --ssl-revoke-best-effort 绕过的。
& curl.exe --ssl-revoke-best-effort -fL --silent --show-error `
    --connect-timeout 10 --max-time 300 -o $zip $url
if ($LASTEXITCODE -ne 0) { throw "下载失败（curl exit $LASTEXITCODE）" }

$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
Write-Host "SHA256 = $actual"
if ($actual -ne $Sha256.ToLower()) {
    Remove-Item -LiteralPath $zip -Force
    throw "校验失败：期望 $Sha256，实际 $actual。请核对官方 checksums.txt 并显式传 -Sha256。"
}

Write-Host '校验通过，解压…'
Expand-Archive -LiteralPath $zip -DestinationPath $win -Force
Remove-Item -LiteralPath $zip -Force
if (-not (Test-Path -LiteralPath $exe)) { throw "解压后未找到 $exe" }
& $exe --version
