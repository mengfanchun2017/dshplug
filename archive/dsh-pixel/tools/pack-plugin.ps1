# pack-plugin.ps1 — build shareable artifacts for one DSH plugin package.
#
# Produces, in -DistDir:
#   <flattened-name>-<version>.tgz  npm/pnpm pack output: honors package.json "files".
#                                   Installable directly: plugin_manager install_bundle <path>
#                                   or: dsh plugin --profile <p> add <path>
#   <flattened-name>-<version>.zip  full source directory (minus node_modules/.git/.pnpm-store),
#                                   for reading, editing, and hand-copying.
#   MANIFEST.txt                    version, sizes, sha256, artifact contents.
#
# Usage:
#   pwsh -File pack-plugin.ps1 -PluginDir <dir> -DistDir <dir>
param(
  [Parameter(Mandatory = $true)][string]$PluginDir,
  [Parameter(Mandatory = $true)][string]$DistDir
)

$ErrorActionPreference = 'Stop'
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

$PluginDir = (Resolve-Path $PluginDir).Path
$manifestPath = Join-Path $PluginDir 'package.json'
if (-not (Test-Path $manifestPath)) { throw "no package.json in $PluginDir" }
$pkg = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $pkg.dsh.bundle.patch) { throw "$($pkg.name) does not declare dsh.bundle.patch; it is not a DSH bundle" }

$flat = ($pkg.name -replace '^@', '' -replace '/', '-')
$stem = "$flat-$($pkg.version)"
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$DistDir = (Resolve-Path $DistDir).Path

# 1. tarball via pnpm pack (honors "files")
$tgz = Get-ChildItem $DistDir -Filter "$flat-*.tgz" -ErrorAction SilentlyContinue
foreach ($old in $tgz) { Remove-Item $old.FullName -Force }
Push-Location $PluginDir
try {
  & $node $pnpm pack --pack-destination $DistDir 2>&1 | ForEach-Object { Write-Host "  pnpm: $_" }
} finally { Pop-Location }
$tgzPath = Join-Path $DistDir "$stem.tgz"
if (-not (Test-Path $tgzPath)) {
  $found = Get-ChildItem $DistDir -Filter "$flat-*.tgz" | Select-Object -First 1
  if (-not $found) { throw "pnpm pack produced no tarball for $($pkg.name)" }
  $tgzPath = $found.FullName
}

# 2. source zip (everything except build/install junk)
$zipPath = Join-Path $DistDir "$stem.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("packstage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $stage $flat) | Out-Null
Get-ChildItem $PluginDir -Force | Where-Object {
  $_.Name -notin @('node_modules', '.git', '.pnpm-store', 'dist')
} | ForEach-Object { Copy-Item $_.FullName -Destination (Join-Path $stage $flat) -Recurse -Force }
Compress-Archive -Path (Join-Path $stage $flat) -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

# 3. manifest
$sha = { param($p) (Get-FileHash $p -Algorithm SHA256).Hash }
$lines = @()
$lines += "package      : $($pkg.name)"
$lines += "version      : $($pkg.version)"
$lines += "description  : $($pkg.description)"
$lines += "source dir   : $PluginDir"
$lines += "patch        : $($pkg.dsh.bundle.patch)"
if ($pkg.dsh.client) { $lines += "client       : $($pkg.dsh.client.platform)" } else { $lines += "client       : (host-only)" }
$lines += "built        : $((Get-Date).ToString('s'))"
$lines += ""
foreach ($a in @($tgzPath, $zipPath)) {
  $i = Get-Item $a
  $lines += "$($i.Name)  $($i.Length) bytes  sha256=$(& $sha $a)"
}
$lines += ""
$lines += "--- tarball contents (what an install actually receives) ---"
# .tgz is gzip+tar, not zip: list names with the bundled Windows bsdtar.
# Names only: bsdtar's date column is localized and garbles under a CJK console code page.
$tarlist = & tar.exe -tzf $tgzPath 2>&1
if ($LASTEXITCODE -eq 0) { $lines += ($tarlist | ForEach-Object { "  $_" }) }
else { $lines += "  (tar.exe unavailable; see pnpm pack output above)" }
$lines += ""
$lines += "--- zip contents (full source) ---"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$arc = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$lines += $arc.Entries | ForEach-Object { "  {0,9}  {1}" -f $_.Length, $_.FullName }
$arc.Dispose()
$lines | Set-Content (Join-Path $DistDir "$stem.MANIFEST.txt") -Encoding utf8

Write-Host "packed $($pkg.name)@$($pkg.version) -> $DistDir"
Write-Host "  $([System.IO.Path]::GetFileName($tgzPath))"
Write-Host "  $([System.IO.Path]::GetFileName($zipPath))"
Write-Host "  $stem.MANIFEST.txt"