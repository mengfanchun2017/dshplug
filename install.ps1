# dsh-plugins · 按 list.json 注册自研插件到 DSH profile
#
# 用法：
#   & "C:\dsh\dsh-plugins\install.ps1"                     # 装全部 status=active 的插件
#   & "C:\dsh\dsh-plugins\install.ps1" -Only dsh-synchub   # 只装一个
#   & "C:\dsh\dsh-plugins\install.ps1" -List               # 只看清单
#   & "C:\dsh\dsh-plugins\install.ps1" -Check              # 体检（含链接形态与是否已断链）
#   & "C:\dsh\dsh-plugins\install.ps1" -Force              # 已是最新也强制重装
#
# 设计要点：用 `link:` 而不是 `file:`。
#   file: → pnpm 把每个文件**硬链接**进 node_modules。任何「删除+重建」的保存
#           （write/edit 工具、原子改名、git checkout、解压覆盖）都会换 inode → 断链，
#           已安装副本停留在旧代码。这正是上一版「改了没生效」的根因。
#   link: → pnpm 建一个**目录 Junction**，指向插件目录本身。文件怎么替换都透过
#           链接读，永远是最新内容。实测三种写法（原地写/删除重建/原子改名）全部即时生效。
#
# 因此本脚本不需要你「改完再跑一次」。只有三种情况需要重新运行：
#   ① 新机器第一次装　② 新增/删除插件　③ list.json 或插件清单变了
param(
  [string]$Profile = 'desktop',
  [string]$Only = '',
  [string]$RepoRoot = '',
  [switch]$List,
  [switch]$Check,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
# RepoRoot 默认取脚本自己所在目录（即 dshplug 仓库根），不要写死路径：
# 早先默认写死 C:\dsh\dsh-plugins，而仓库实际在 C:\dsh\dshplug，
# 结果开箱就报「找不到清单」，还得每次手动传 -RepoRoot。
if (-not $RepoRoot) { $RepoRoot = $PSScriptRoot }
$listFile = Join-Path $RepoRoot 'list.json'
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"

if (-not (Test-Path -LiteralPath $listFile)) { throw "找不到清单：$listFile" }
# 变量名不能叫 $list —— 与 -List 开关同名（PowerShell 大小写不敏感）会冲突
$manifest = Get-Content -LiteralPath $listFile -Raw -Encoding utf8 | ConvertFrom-Json

function Test-Bundle($dir) {
  $pj = Join-Path $dir 'package.json'
  if (-not (Test-Path -LiteralPath $pj)) { return $false }
  try { $j = Get-Content -LiteralPath $pj -Raw -Encoding utf8 | ConvertFrom-Json } catch { return $false }
  return [bool]($j.dsh -and $j.dsh.bundle -and $j.dsh.bundle.patch)
}

# 当前安装形态：'link-junction' | 'file-hardlink' | 'copy' | 'orphan' | 'missing'
# 关键：以 profile/package.json 的**依赖声明**为准，不以 node_modules 目录存在为准。
# dsh plugin remove 只删声明、常留下 node_modules 里的 Junction（孤儿），
# 那种状态 DSH 不会加载，必须视为待安装。
function Get-DeclaredSpec($name) {
  $pj = Join-Path $profileDir 'package.json'
  try {
    $j = Get-Content -LiteralPath $pj -Raw -Encoding utf8 | ConvertFrom-Json
    return $j.dependencies.$name
  } catch { return $null }
}

function Get-InstallState($name) {
  $inst = Join-Path $profileDir "node_modules\$name"
  $spec = Get-DeclaredSpec $name
  $hasDir = Test-Path -LiteralPath $inst

  if (-not $spec) {
    # 没有依赖声明：目录还在 = 孤儿（残骸），否则就是没装
    if ($hasDir) { return 'orphan' }
    return 'missing'
  }
  if (-not $hasDir) { return 'missing' }   # 声明了但没装出来

  $item = Get-Item -LiteralPath $inst -Force
  if ($item.LinkType) { return 'link-junction' }
  if ($spec -like 'link:*') { return 'link-junction' }
  if ($spec -like 'file:*') { return 'file-hardlink' }
  return 'copy'
}

# 探测是否已断链：源文件与安装副本不是同一 inode（仅 file: 形态有意义）
function Test-BrokenLink($name, $dir) {
  $inst = Join-Path $profileDir "node_modules\$name"
  foreach ($rel in @('package.json', 'lib\index.js')) {
    $s = Join-Path $dir $rel
    $d = Join-Path $inst $rel
    if ((Test-Path -LiteralPath $s) -and (Test-Path -LiteralPath $d)) {
      try {
        $hashS = (Get-FileHash -LiteralPath $s -Algorithm SHA256).Hash
        $hashD = (Get-FileHash -LiteralPath $d -Algorithm SHA256).Hash
        if ($hashS -ne $hashD) { return $true }
      } catch { }
    }
  }
  return $false
}

$targets = @($manifest.plugins | Where-Object {
  $_.status -eq 'active' -and (-not $Only -or $_.name -eq $Only)
})

if ($List -or $Check) {
  Write-Host "清单 ($($manifest.updated))  repo=$RepoRoot  profile=$Profile"
  $bad = 0
  foreach ($p in $manifest.plugins) {
    $dir = Join-Path $RepoRoot $p.dir
    $exists = Test-Path -LiteralPath $dir
    $bundle = if ($exists) { Test-Bundle $dir } else { $false }
    $ver = if ($exists) { try { (Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json).version } catch { '?' } } else { '-' }
    $state = Get-InstallState $p.name
    $broken = if ($exists -and $state -eq 'file-hardlink') { Test-BrokenLink $p.name $dir } else { $false }
    $flag = ''
    if ($state -eq 'file-hardlink') { $flag = '  ⚠ 用 file: 硬链接，可能断链' ; if ($broken) { $flag = '  ✗ 已断链，需修复'; $bad++ } }
    elseif ($state -eq 'missing') { $flag = '  · 未安装' }
    $verNote = if ($exists -and $ver -ne $p.version) { "  (list.json 记 $($p.version))" } else { '' }
    Write-Host ("  {0,-22} v{1,-8} status={2,-8} {3,-14}{4}{5}" -f $p.name, $ver, $p.status, $state, $verNote, $flag)
  }
  if ($Check) {
    Write-Host ''
    $active = @($manifest.plugins | Where-Object { $_.status -eq 'active' })
    $missing  = @($active | Where-Object { (Get-InstallState $_.name) -eq 'missing' }).Count
    $orphan   = @($active | Where-Object { (Get-InstallState $_.name) -eq 'orphan' }).Count
    $legacy   = @($active | Where-Object { (Get-InstallState $_.name) -in @('file-hardlink', 'copy') }).Count
    $problems = $bad + $missing + $orphan + $legacy
    if ($bad     -gt 0) { Write-Host "  ✗ $bad 个插件已断链（安装副本是旧代码）" -ForegroundColor Yellow }
    if ($legacy  -gt 0) { Write-Host "  ⚠ $legacy 个插件仍是 file:/copy 形态（可能断链，可升级）" -ForegroundColor Yellow }
    if ($orphan  -gt 0) { Write-Host "  ⚠ $orphan 个插件有残留链接但无依赖声明（DSH 不会加载）" -ForegroundColor Yellow }
    if ($missing -gt 0) { Write-Host "  · $missing 个插件尚未安装" -ForegroundColor Yellow }
    if ($problems -gt 0) {
      Write-Host "`n修复：& `"$RepoRoot\install.ps1`"" -ForegroundColor Yellow
    } else {
      Write-Host '全部为 link: 形态且已安装，改源码即时生效，无需操作。' -ForegroundColor Green
    }
  }
  return
}

if ($targets.Count -eq 0) { throw "没有匹配的插件（检查 -Only 或 list.json 的 status）" }
if (-not (Test-Path -LiteralPath $dsh)) { throw "找不到 dsh.cmd：$dsh" }

# ---- 决定哪些需要（重新）安装 ----
$install = @()
foreach ($p in $targets) {
  $dir = Join-Path $RepoRoot $p.dir
  if (-not (Test-Path -LiteralPath $dir)) { Write-Host "跳过 $($p.name)：目录不存在 $dir" -ForegroundColor Yellow; continue }
  if (-not (Test-Bundle $dir)) { Write-Host "跳过 $($p.name)：不是 bundle（缺 dsh.bundle.patch）" -ForegroundColor Yellow; continue }

  $state = Get-InstallState $p.name
  $need = $Force.IsPresent
  $reason = ''
  if (-not $need) {
    if ($state -eq 'missing') { $need = $true; $reason = '未安装' }
    elseif ($state -eq 'orphan') { $need = $true; $reason = 'node_modules 有残留链接但无依赖声明（DSH 不会加载），重装' }
    elseif ($state -eq 'file-hardlink') {
      if (Test-BrokenLink $p.name $dir) { $need = $true; $reason = '硬链接已断（旧代码）' }
      else { $need = $true; $reason = 'file: → 升级为 link:（永久免疫断链）' }
    } elseif ($state -eq 'copy') { $need = $true; $reason = '旧复制形态，改为 link:' }
  }

  if ($need) {
    $install += "link:$dir"
    Write-Host "需要安装 $($p.name)：$reason"
  } else {
    Write-Host "已是 link: 形态且最新：$($p.name)（无需操作）" -ForegroundColor DarkGray
  }
}

if ($install.Count -eq 0) {
  Write-Host "`n全部已是最新，无需重装。" -ForegroundColor Green
  return
}

# ---- 先移除旧的（file:/copy 形态必须删掉再装，才能换成 Junction） ----
foreach ($spec in $install) {
  $dir = $spec.Substring(5)
  $pj = Join-Path $dir 'package.json'
  $name = (Get-Content -LiteralPath $pj -Raw -Encoding utf8 | ConvertFrom-Json).name
  $state = Get-InstallState $name
  if ($state -ne 'missing') {
    Write-Host "移除旧安装：$name（$state）"
    & $dsh plugin --profile $Profile remove $name 2>&1 | Out-Null
  }
  # dsh remove 只删 package.json 声明，常把 Junction 留在 node_modules 里。
  # 残骸必须先清掉，否则 pnpm add 会认为「已存在」而不重建链接。
  $leftover = Join-Path $profileDir "node_modules\$name"
  if (Test-Path -LiteralPath $leftover) {
    try {
      # 删除 Junction 本身不会影响目标目录（已实测），但要避免 -Recurse 跟随
      (Get-Item -LiteralPath $leftover -Force).Delete()
      Write-Host "  清理残留链接：$name"
    } catch {
      Write-Host "  残留清理失败（继续）：$($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

Write-Host "`n注册 $($install.Count) 个插件到 profile '$Profile'（link: 形态）..."
& $dsh plugin --profile $Profile add @install
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit $LASTEXITCODE）" }

Write-Host "`n当前 profile 插件清单："
& $dsh plugin --profile $Profile list

Write-Host "`n完成。"
Write-Host "  之后改源码即时生效（Junction），不需要再跑本脚本。"
Write-Host "  若 DSH 正在运行且是首次装本插件，请【完全退出再打开】以加载新 bundle。"
