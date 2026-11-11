# plugpush · 把「指定的插件」从本地改动提交并推送到私有 Git 远端
#
# 为什么需要它：插件用 link:（目录 Junction）装进 profile，你改源码即时生效，
# 但**不会自动产生 git commit**。默认一切留在本机；只有你跑这条命令才上行。
#
# 用法：
#   & C:\dsh\dsh-plugins\plugpush.ps1 dsh-synchub "增加设置面板"
#   & C:\dsh\dsh-plugins\plugpush.ps1 dsh-synchub "修红点逻辑" -Tag       # 同时打版本 tag
#   & C:\dsh\dsh-plugins\plugpush.ps1 -List                              # 看有哪些可推
#   & C:\dsh\dsh-plugins\plugpush.ps1 dsh-synchub "msg" -DryRun          # 只看会提交什么
#
# 第一次用之前（只做一次）：填好 -Remote 或先手动 git remote add origin <你的私有仓库 URL>
#   & C:\dsh\dsh-plugins\plugpush.ps1 dsh-synchub "init" -Remote "https://github.com/<you>/dsh-plugins.git"
param(
  [string]$Name = '',
  [string]$Message = '',
  [string]$Remote = '',
  [string]$RepoRoot = 'C:\dsh\dsh-plugins',
  [string]$Branch = 'main',
  [switch]$Tag,
  [switch]$All,
  [switch]$List,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$listFile = Join-Path $RepoRoot 'list.json'
# 变量名不能叫 $list —— 与 -List 开关同名会冲突
$manifest = Get-Content -LiteralPath $listFile -Raw -Encoding utf8 | ConvertFrom-Json

if ($List) {
  Write-Host "list.json 中的插件："
  foreach ($p in $manifest.plugins) { Write-Host ("  {0,-24} v{1,-10} {2}" -f $p.name, $p.version, $p.description) }
  return
}
if (-not $Name -and -not $All) { throw '用法：plugpush <包名> "<提交说明>"，或 -All。可用 -List 查看包名。' }
if (-not $Message) { $Message = "update $Name" }

# ---- 1. 找要推的插件目录（只认 list.json 里登记的） ----
$entries = @($manifest.plugins | Where-Object { $_.status -eq 'active' -and ($All -or $_.name -eq $Name) })
if ($entries.Count -eq 0) { throw "list.json 里没有这个插件：$Name（先加一条，或跑 -List）" }
$paths = @()
foreach ($e in $entries) {
  $dir = Join-Path $RepoRoot $e.dir
  if (-not (Test-Path -LiteralPath $dir)) { throw "插件目录不存在：$dir" }
  $paths += $e.dir
  Write-Host "目标插件：$($e.name)@$($e.version)  →  $($e.dir)\"
}

# ---- 2. 看这个插件有没有本地改动（DryRun 只需要这一步，不需要远端） ----
$staged = @()
foreach ($p in $paths) {
  $changes = & git -C $RepoRoot status --porcelain -- "$p"
  if ($changes) { $staged += $p; Write-Host "`n[$p] 本地改动："; $changes | ForEach-Object { Write-Host "  $_" } }
  else { Write-Host "`n[$p] 没有本地改动（跳过）" }
}
# list.json 自身有变更也要一起带（新增插件/改版本时）
if (& git -C $RepoRoot status --porcelain -- 'list.json') {
  Write-Host "`n[list.json] 清单有变更，一并提交"
  $staged += 'list.json'
}
if ($staged.Count -eq 0) { Write-Host "`n没有需要提交的内容。什么都没做。"; return }

if ($DryRun) {
  Write-Host "`n[DryRun] 会 stage 这些路径：$($staged -join ', ')"
  Write-Host "[DryRun] 到此为止：未 commit、未 push、不需要远端。真正推送时再配 -Remote。"
  return
}

# ---- 3. 远端（第一次可通过 -Remote 一次性配好；只有真推时才需要） ----
if ($Remote) {
  $existing = & git -C $RepoRoot remote get-url origin 2>$null
  if ($existing) { Write-Host "origin 已是 $existing，忽略 -Remote" }
  else { & git -C $RepoRoot remote add origin $Remote; Write-Host "已设置 origin = $Remote" }
}
$origin = & git -C $RepoRoot remote get-url origin 2>$null
if (-not $origin) { throw '还没配远端。先跑一次带 -Remote 的命令，或手动：git -C C:\dsh\dsh-plugins remote add origin <私有仓库 URL>' }
Write-Host "远端：$origin"

# ---- 4. 只暂存这个插件，不碰别的插件 / 不碰 DSH 配置 ----
foreach ($p in $staged) { & git -C $RepoRoot add -- "$p" }
$diff = & git -C $RepoRoot diff --cached --name-only
if (-not $diff) { Write-Host '暂存区为空（改动可能已被 .gitignore 排除）。'; return }
Write-Host "`n将提交："
$diff | ForEach-Object { Write-Host "  $_" }

# ---- 5. commit（一次，带明确说明） ----
& git -C $RepoRoot -c user.name="Francis Meng" -c user.email="31639417+mengfanchun2017@users.noreply.github.com" `
  commit -m "$Message"
if ($LASTEXITCODE -ne 0) { throw 'commit 失败' }

# ---- 6. 可选：打版本 tag（用 package.json 里的 version） ----
if ($Tag -and -not $All) {
  $pj = Join-Path $RepoRoot (Join-Path $entries[0].dir 'package.json')
  $v = (Get-Content -LiteralPath $pj -Raw -Encoding utf8 | ConvertFrom-Json).version
  $tag = "$($entries[0].name)-v$v"
  $exists = & git -C $RepoRoot tag -l $tag
  if ($exists) { Write-Host "tag $tag 已存在，跳过" }
  else { & git -C $RepoRoot tag -a $tag -m "$Message"; Write-Host "已打 tag：$tag" }
}

# ---- 7. push（首次自动带 -u 建立跟踪） ----
Write-Host "`n推送到 $origin ($Branch) ..."
& git -C $RepoRoot push -u origin $Branch
if ($LASTEXITCODE -ne 0) { throw "push 失败（exit $LASTEXITCODE）。commit 已在本机，可稍后重试：git -C $RepoRoot push" }

Write-Host "`n完成。另一台机器执行："
Write-Host "  git -C C:\dsh\dsh-plugins pull"
Write-Host "  （改源码无需重装——link: Junction 即时生效；仅新增/删除插件时才需要 install.ps1）"
