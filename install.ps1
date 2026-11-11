# dsh-plugins · 一次性把 plugins/ 下所有插件注册进 DSH desktop profile
#
# 用法（两台机器都跑一次，路径必须一致）：
#   & "C:\dsh\dsh-plugins\install.ps1"
#   & "C:\dsh\dsh-plugins\install.ps1" -Profile desktop -Only dsh-synchub
#
# 前提：本仓库已克隆到两台机器**同一个绝对路径** C:\dsh\dsh-plugins。
#       file: 规格记录绝对路径，换路径会让 DSH 启动时找不到依赖。
param(
  [string]$Profile = 'desktop',
  [string]$Only = '',
  [string]$RepoRoot = 'C:\dsh\dsh-plugins'
)

$ErrorActionPreference = 'Stop'

$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path -LiteralPath $dsh)) { throw "找不到 dsh.cmd：$dsh" }

$pluginsDir = Join-Path $RepoRoot 'plugins'
if (-not (Test-Path -LiteralPath $pluginsDir)) { throw "找不到插件目录：$pluginsDir（仓库是否克隆到了 $RepoRoot？）" }

# 只收集带 package.json 且声明了 dsh.bundle.patch 的目录 —— 这才是真正的 DSH bundle。
$specs = @()
foreach ($dir in (Get-ChildItem -LiteralPath $pluginsDir -Directory | Sort-Object Name)) {
  if ($Only -and $dir.Name -ne $Only) { continue }
  $pj = Join-Path $dir.FullName 'package.json'
  if (-not (Test-Path -LiteralPath $pj)) { Write-Host "跳过 $($dir.Name)：没有 package.json"; continue }
  try { $j = Get-Content -LiteralPath $pj -Raw -Encoding utf8 | ConvertFrom-Json } catch { Write-Host "跳过 $($dir.Name)：package.json 无法解析"; continue }
  if (-not $j.dsh -or -not $j.dsh.bundle -or -not $j.dsh.bundle.patch) {
    Write-Host "跳过 $($dir.Name)：缺少 dsh.bundle.patch（只是普通依赖，不是 bundle）"; continue
  }
  $specs += "file:$($dir.FullName)"
  Write-Host "发现插件 $($dir.Name)@$($j.version)"
}

if ($specs.Count -eq 0) { throw "没有找到可安装的插件（检查 -Only 参数）" }

Write-Host "`n注册 $($specs.Count) 个插件到 profile '$Profile' ..."
& $dsh plugin --profile $Profile add @specs
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit $LASTEXITCODE）" }

Write-Host "`n完成。当前 profile 插件清单："
& $dsh plugin --profile $Profile list
Write-Host "`n请【完全退出 DSH 再重新打开】（不是刷新页面）：新 bundle 要进程重启才会加载。"
