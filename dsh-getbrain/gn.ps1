# gn.ps1 — 在 Windows GBK 控制台里正确运行 gn.py 的包装器（可移植版）
# 用法（在工作区根目录执行）：
#        .\getnote\gn.ps1 doctor --live
#        .\getnote\gn.ps1 backup
#        .\getnote\gn.ps1 apply --plan getnote\state\plan.json --confirm CONFIRM
# 所有参数原样透传给 gn.py；相对路径均相对当前工作目录。
#
# Python 查找顺序（把 getnote\ 整体拷到别的机器 / 别的 DSH 后仍可运行）：
#   1. 环境变量 GETNOTE_PYTHON 指向的解释器（可选，最高优先）
#   2. PATH 上的 python / py
#   3. DSH 自带 Python（$DSH_HOME 推导，兼容不同用户名 / 版本）
#   4. 旧版硬编码路径兜底（仅为兼容本机历史安装）
# 目标机只需有 Python 3.9+；gn.py 只用标准库，不需要装任何东西。

$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "gn.py"

function Test-Python($exe) {
    try {
        $ok = & $exe -c "import sys; print(sys.version_info >= (3, 9))" 2>$null
        return ($LASTEXITCODE -eq 0 -and "$ok" -match "True")
    } catch {
        return $false
    }
}

function Resolve-Python {
    $candidates = @()
    if ($env:GETNOTE_PYTHON) { $candidates += $env:GETNOTE_PYTHON }
    foreach ($name in @("python", "py")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { $candidates += $cmd.Source }
    }
    if ($env:DSH_HOME) {
        $candidates += (Join-Path $env:DSH_HOME "dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe")
    }
    # 旧版硬编码路径兜底，仅在本机历史环境有效
    $candidates += "C:\Users\franc\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

    foreach ($exe in ($candidates | Select-Object -Unique)) {
        if ($exe -and (Test-Path $exe) -and (Test-Python $exe)) { return $exe }
    }
    throw "找不到可用的 Python 3.9+。请把 python 加入 PATH，或设置环境变量 GETNOTE_PYTHON 指向 python.exe。"
}

$py = Resolve-Python

# 让 PowerShell 以 UTF-8 解码子进程输出，避免中文乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

& $py $script @args
exit $LASTEXITCODE
