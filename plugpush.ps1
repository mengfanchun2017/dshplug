# plugpush · 把「指定的插件」从本地改动提交并推送到私有 Git 远端
#
# 为什么需要它：插件用 link:（目录 Junction）装进 profile，你改源码即时生效，
# 但**不会自动产生 git commit**。默认一切留在本机；只有你跑这条命令才上行。
#
# 用法：
#   & C:\dsh\dshplug\plugpush.ps1 dsh-synchub "增加设置面板"
#   & C:\dsh\dshplug\plugpush.ps1 dsh-synchub "修红点逻辑" -Tag       # 同时打版本 tag
#   & C:\dsh\dshplug\plugpush.ps1 -All "统一整理"                    # 清单里所有插件 + 根级文件
#   & C:\dsh\dshplug\plugpush.ps1 -List                              # 看有哪些可推
#   & C:\dsh\dshplug\plugpush.ps1 -All "msg" -DryRun                 # 只看会提交什么
#
# 第一次用之前（只做一次）：填好 -Remote 或先手动 git remote add origin <你的私有仓库 URL>
#   & C:\dsh\dshplug\plugpush.ps1 dsh-synchub "init" -Remote "https://github.com/<you>/dsh-plugins.git"
param(
  [string]$Name = '',
  [string]$Message = '',
  [string]$Remote = '',
  [string]$RepoRoot = '',
  [string]$Branch = 'main',
  [switch]$Tag,
  [switch]$All,
  [switch]$List,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# RepoRoot 默认取脚本自身所在目录（仓库根），避免写死路径与实际克隆位置不一致。
if (-not $RepoRoot) { $RepoRoot = $PSScriptRoot }
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

# ---- 1. 找要推的插件目录 ----
# 注意：这里【不看 status】。list.json 里登记过的目录（含 dev）都要能推，
# 否则开发中插件的源码改动永远同步不出去。
# status 只由 install.ps1 用来决定「装不装」，不该决定「推不推」。
$entries = @($manifest.plugins | Where-Object { $All -or $_.name -eq $Name })
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
# 根级文件：仓库自己的脚本与配置，不属于任何插件目录，但必须能一起推。
# 例：改了根 .gitignore / install.ps1 / README.md / BOOTSTRAP.md 时。
$rootPaths = @('list.json','install.ps1','plugpush.ps1','.gitignore','.gitattributes','README.md','BOOTSTRAP.md')
foreach ($rp in $rootPaths) {
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $rp))) { continue }
  if (& git -C $RepoRoot status --porcelain -- $rp) {
    Write-Host "`n[$rp] 根级文件有变更，一并提交"
    if ($staged -notcontains $rp) { $staged += $rp }
  }
}
# 兜底：先把【根目录下每一个直接子项】都扫一遍，不管它是文件还是目录。
# 历史教训（2026-11-13）：早期这里写了 `$rel -match '[\\/]' { continue }`，
# 结果所有目录（尤其 archive/）被静默跳过——“仓库里的东西按 git 走”这个期待就落空了。
# 现在改成：直接子项全收，子目录内部由 git add 递归（仍然会尊重 .gitignore）。
$rootChildren = @(Get-ChildItem -LiteralPath $RepoRoot -Force | Where-Object { $_.Name -ne '.git' })
foreach ($child in $rootChildren) {
  $rel = $child.Name
  # 已作为插件目录收过的（例如 dsh-synchub）不重复收；但已收的目录下若有新文件，
  # git add <目录> 本来就是整目录，所以这里跳过是安全的。
  if ($staged -contains $rel) { continue }
  if ($paths -contains $rel) { continue }
  $st = & git -C $RepoRoot status --porcelain -- $rel
  if (-not $st) { continue }
  $staged += $rel
  Write-Host "`n[$rel] 根级改动，一并提交"
  $st | Select-Object -First 8 | ForEach-Object { Write-Host "  $_" }
}
if ($staged.Count -eq 0) {
  # 没有「未提交」的改动，不代表没有「未推送」的提交。以前的版本在这里直接 return，
  # 于是「先 git commit 过、再跑 plugpush」永远推不上去（远端一直空）。
  $originProbe = & git -C $RepoRoot remote get-url origin 2>$null
  $aheadCount = 0
  if ($originProbe) {
    $ahead = & git -C $RepoRoot rev-list --count '@{u}..HEAD' 2>$null
    if ($LASTEXITCODE -eq 0 -and $ahead) { $aheadCount = [int]$ahead }
    else {
      # 还没有上游跟踪分支（远端一次都没推过）→ 本地所有提交都算待推送
      $aheadCount = [int](& git -C $RepoRoot rev-list --count HEAD 2>$null)
    }
  }
  if ($aheadCount -gt 0 -and $originProbe) {
    Write-Host "`n没有未提交的改动，但有 $aheadCount 个提交还没推送到远端 —— 继续推送。"
  } else {
    Write-Host "`n没有需要提交或推送的内容。什么都没做。"
    return
  }
}

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
if (-not $origin) { throw '还没配远端。先跑一次带 -Remote 的命令，或手动：git -C C:\dsh\dshplug remote add origin <私有仓库 URL>' }
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
# 分支自动跟随本地当前分支：仓库初始化时是 master，凭 -Branch 猜 main 会直接失败
# （"src refspec main does not match any"）。显式传 -Branch 仍然优先。
if (-not $PSBoundParameters.ContainsKey('Branch')) {
  $current = (& git -C $RepoRoot branch --show-current 2>$null)
  if ($current) { $Branch = $current.Trim() }
}
Write-Host "`n推送到 $origin ($Branch) ..."
& git -C $RepoRoot push -u origin $Branch
if ($LASTEXITCODE -ne 0) { throw "push 失败（exit $LASTEXITCODE）。commit 已在本机，可稍后重试：git -C $RepoRoot push" }

Write-Host "`n完成。另一台机器执行："
Write-Host "  git -C C:\dsh\dshplug pull"
Write-Host "  （改源码无需重装——link: Junction 即时生效；仅新增/删除插件时才需要 install.ps1）"
