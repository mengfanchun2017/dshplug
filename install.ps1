# dsh-plugins · 按 list.json 注册插件到 DSH desktop profile
#
# 用法：
#   & "C:\dsh\dsh-plugins\install.ps1"                     # 装 list.json 里全部 status=active 的插件
#   & "C:\dsh\dsh-plugins\install.ps1" -Only dsh-synchub  # 只装一个
#   & "C:\dsh\dsh-plugins\install.ps1" -List              # 只看清单，不装
#   & "C:\dsh\dsh-plugins\install.ps1" -Check             # 检查目录/清单/已装状态
#
# 前提：两台机器都把本仓库放在**同一个绝对路径** C:\dsh\dsh-plugins。
#       file: 规格记录绝对路径，换路径会让 DSH 启动时找不到依赖。
param(
  [string]$Profile = 'desktop',
  [string]$Only = '',
  [string]$RepoRoot = 'C:\dsh\dsh-plugins',
  [switch]$List,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$listFile = Join-Path $RepoRoot 'list.json'

if (-not (Test-Path -LiteralPath $listFile)) { throw "找不到清单：$listFile" }
# 注意：变量名不能叫 $list —— 与 -List 开关同名（PowerShell 大小写不敏感）会冲突
$manifest = Get-Content -LiteralPath $listFile -Raw -Encoding utf8 | ConvertFrom-Json

function Get-PluginDir($entry) { return (Join-Path $RepoRoot $entry.dir) }

# 校验一个目录是不是可注册的 DSH bundle
function Test-Bundle($dir) {
  $pj = Join-Path $dir 'package.json'
  if (-not (Test-Path -LiteralPath $pj)) { return $false }
  try { $j = Get-Content -LiteralPath $pj -Raw -Encoding utf8 | ConvertFrom-Json } catch { return $false }
  return [bool]($j.dsh -and $j.dsh.bundle -and $j.dsh.bundle.patch)
}

$targets = @($manifest.plugins | Where-Object {
  $_.status -eq 'active' -and (-not $Only -or $_.name -eq $Only)
})

if ($List -or $Check) {
  Write-Host "清单 ($($manifest.updated))："
  foreach ($p in $manifest.plugins) {
    $dir = Get-PluginDir $p
    $exists = Test-Path -LiteralPath $dir
    $bundle = if ($exists) { Test-Bundle $dir } else { $false }
    $line = "  {0,-24} v{1,-10} status={2,-8} dir={3,-5} bundle={4}" -f `
      $p.name, $p.version, $p.status, $exists, $bundle
    Write-Host $line
    if ($Check -and $exists -and $bundle) {
      $inst = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\$($p.name)"
      Write-Host ("    已安装到 profile: {0}" -f (Test-Path -LiteralPath $inst))
    }
  }
  if ($List -or $Check) { return }
}

if ($targets.Count -eq 0) { throw "没有匹配的插件（检查 -Only 或 list.json 的 status）" }

$specs = @()
foreach ($p in $targets) {
  $dir = Get-PluginDir $p
  if (-not (Test-Path -LiteralPath $dir)) { Write-Host "跳过 $($p.name)：目录不存在 $dir" -ForegroundColor Yellow; continue }
  if (-not (Test-Bundle $dir)) { Write-Host "跳过 $($p.name)：不是 bundle（缺 dsh.bundle.patch）" -ForegroundColor Yellow; continue }
  $specs += "file:$dir"
  Write-Host "发现插件 $($p.name)@$($p.version)"
}

if ($specs.Count -eq 0) { throw '没有可安装的插件' }
if (-not (Test-Path -LiteralPath $dsh)) { throw "找不到 dsh.cmd：$dsh" }

Write-Host "`n注册 $($specs.Count) 个插件到 profile '$Profile' ..."
& $dsh plugin --profile $Profile add @specs
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit $LASTEXITCODE）" }

Write-Host "`n当前 profile 插件清单："
& $dsh plugin --profile $Profile list
Write-Host "`n请【完全退出 DSH 再重新打开】：新 bundle 要进程重启才会加载。"
