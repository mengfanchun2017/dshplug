/**
 * dsh-gitok —— Git 认证一站式管理（Cordis 插件）
 *
 * 设计目标（对应用户四条硬要求）：
 *   1. 一台终端一个 git 认证、永久有效、随时可查可删
 *   2. 多种认证方式可对比、可区分
 *   3. 把「检查 / 建议 / 配置 / 更新」收进一个插件
 *   4. 加密、密钥出机器不可用、不落明文
 *
 * 核心机制（已在本机实测通过）：
 *   WSL 里的 git 可以通过 WSL interop 直接调用 Windows 的 git-credential-manager.exe。
 *   于是 WSL 完全不用自己存密钥 —— 只借用 Windows 凭据管理器里那一份 DPAPI 密文。
 *   → 一处登录、一处撤销、拷走机器解不开。
 *
 * 三层能力（对应 docs/plugin-roadmap.md）：
 *   Init    gitok_bootstrap  S0 环境自检 → S1 幂等配置 → S2 登录 → S3 验收 → S4 收尾
 *   Manage  gitok_list / adopt(dryRun) / rotate / revoke(影响面) / verify
 *   Monitor gitok_doctor / gitok_monitor 四态 ok|warn|error|unknown + 六项持续监控
 *
 * 决策 D（ADR-008）：默认用 GCM OAuth（gho_）作为内核，不引入每机命名细粒度 PAT。
 *   理由：零手工 token、插件现有 gitok_login 直接支持、轮换只需重新登录。
 *   反面代价：GitHub 侧只显示「Git Credential Manager」授权，无法按机器命名/单独吊销；
 *            权限为 gist+repo+workflow 全宽，不是最小权限。要这两点必须走方案 E（ADR 里留档）。
 *
 * 安全铁律（本文件严格遵守）：
 *   - 绝不接收 token 参数，绝不写任何密钥到磁盘
 *   - 需要密钥进出的动作一律委托给 GCM 的 get/store/erase 子命令
 *   - 所有输出里出现 password 一律脱敏，只报「有没有、多长、什么前缀类型」
 *
 * @module @local/dsh-gitok
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// schemastery 由 DSH 宿主提供。本 bundle 若是 link: 安装的本地目录，
// 静态 import 可能解析不到，所以从几个已知位置动态取；全都失败就退化成「无 Config」
// （插件仍可用，只是设置面板不出现表单）。
async function loadSchemastery() {
  const req = createRequire(import.meta.url)
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const candidates = []

  try { candidates.push(req.resolve('@deepseek-ai/schemastery')) } catch { /* not linked here */ }

  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const profileName = process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME || ''

  const dirs = []
  if (profileName) dirs.push(path.join(dshHome, 'profiles', profileName, 'node_modules', '@deepseek-ai', 'schemastery'))
  dirs.push(path.join(here, 'node_modules', '@deepseek-ai', 'schemastery'))
  dirs.push(path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'schemastery'))
  for (const p of dirs) if (existsSync(p)) candidates.push(p)

  for (const c of candidates) {
    try {
      // 候选两种形态：
      //   a) 已解析的文件路径（.js/.cjs/.mjs）——直接 import
      //   b) 包目录——用「以该目录为根的 require」去 resolve 包名，
      //      这样走的是 package.json 的 exports 字段（例如 schemastery 实际入口是 lib/index.cjs）
      let entry
      if (/\.(c|m)?js$/.test(c)) {
        entry = c
      } else {
        const rootReq = createRequire(path.join(c, 'package.json'))
        entry = rootReq.resolve('@deepseek-ai/schemastery')
      }
      const mod = await import(pathToFileURL(entry).href)
      const zmod = mod?.default ?? mod
      if (typeof zmod?.object === 'function') return zmod
    } catch { /* try next */ }
  }
  return undefined
}

const z = await loadSchemastery()

export const name = 'gitok'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// 配置
//
// 【多机可移植性】本插件的 config 属于 profileConfig 同步面，任何机器间不同的值
// 都不能写死在提交里，否则 A 机的值同步到 B 机会指到不存在的代理/发行版。
// 因此：proxy 默认空（自动读系统代理）、gcmPath 默认空（自动探测）、
//       targets 默认 ['windows'] 且支持 'auto' 在运行时展开。
// ---------------------------------------------------------------------------

const ConfigShape = !z ? undefined : z.object({
  gcmPath: z.string().default('').description('Windows GCM 可执行文件绝对路径。留空自动探测 MinGit/Git for Windows 常见位置。').volatile(),
  targets: z.array(z.string()).default(['windows'])
    .description('要管理的端点：windows 表示本机；其余字符串视为 WSL 发行版名；填 auto 表示运行时自动发现本机全部 WSL 发行版。')
    .volatile(),
  proxy: z.string().default('').description('git 走的 HTTP 代理。留空则从 Windows 系统代理读取（多机可移植的默认）。').volatile(),
  useHttpPath: z.boolean().default(false)
    .description('按 host+仓库路径区分凭据条目。注意：它只把凭据分成不同存储条目，不会让 GCM 返回不同 token，单独做不到「一仓一权限」。走方案 E（每机独立细粒度 PAT）时才需要 true。')
    .volatile(),
  probeTimeoutMs: z.number().default(20000).description('每条探测命令的超时毫秒数。').volatile(),
  heartbeatUrl: z.string().default('')
    .description('监控项 a（端到端通路心跳）用的仓库 URL。留空则该项报「未配置」而不是假装健康。')
    .volatile(),
  // 上下界不是装饰：setInterval 的延时是 32 位有符号整数，
  // 超过 2147483647ms（约 24.8 天）会溢出成 1ms，巡检变成高频空转；
  // 负数同理。所以先限在 [0, 10080]（一周）再乘 60000，乘积最大 604800000，安全。
  autoCheckMinutes: z.number().min(0).max(10080).default(0)
    .description('周期巡检间隔（分钟）。0 = 关闭（默认），最大 10080（一周）。只做本地只读检查，绝不自动 erase / login。')
    .volatile(),
})
export const Config = ConfigShape

/** volatile 字段在运行时是包装对象，必须解包后才能当普通值用。 */
function unwrap(v) {
  let cur = v
  for (let i = 0; i < 4 && cur !== null && cur !== undefined; i++) {
    if (typeof cur === 'object' && typeof cur.get === 'function') {
      try { cur = cur.get() } catch { break }
    } else break
  }
  return cur
}

function cfg(config, key, fallback) {
  try {
    const v = unwrap(config?.[key])
    if (v === undefined || v === null || v === '') return fallback
    return v
  } catch { return fallback }
}

// ---------------------------------------------------------------------------
// 进程执行
// ---------------------------------------------------------------------------

/**
 * 执行一条命令并收集输出。
 * stdio 用 pipe：本插件运行在 Host 进程里（不是 pwsh 沙箱），可以正常捕获。
 */
function exec(cmd, args, opts = {}) {
  const { cwd, timeoutMs = 20000, input, env } = opts
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let finished = false
    let child
    const finish = (payload) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      resolve(payload)
    }
    const timer = timeoutMs > 0 ? setTimeout(() => {
      try { child?.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, code: 'TIMEOUT', stdout, stderr: stderr || `超时 ${timeoutMs}ms`, exitCode: null })
    }, timeoutMs) : null

    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      return finish({ ok: false, code: 'SPAWN_FAILED', stdout: '', stderr: String(error?.message ?? error), exitCode: null })
    }

    child.stdout.on('data', (b) => { stdout += b.toString('utf8') })
    child.stderr.on('data', (b) => { stderr += b.toString('utf8') })
    child.on('error', (error) => finish({ ok: false, code: 'SPAWN_FAILED', stdout, stderr: String(error?.message ?? error), exitCode: null }))
    child.on('close', (code) => finish({
      ok: code === 0,
      code: code === 0 ? 'OK' : `EXIT_${code}`,
      stdout,
      stderr: stderr.trim(),
      exitCode: code,
    }))

    if (input !== undefined) {
      try { child.stdin.write(input) } catch { /* ignore */ }
    }
    try { child.stdin.end() } catch { /* ignore */ }
  })
}

/** 统一文本输出契约（与内置工具一致）。 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) { return [{ type: 'text', text: String(value) }] },
  }
}

/** 探测一个 TCP 端口是否可连（用于代理可达性，1.2s 超时，失败不抛）。 */
function probeTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => { if (!done) { done = true; try { sock.destroy() } catch { /* ignore */ } resolve(ok) } }
    const sock = net.connect({ host, port })
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

// ---------------------------------------------------------------------------
// GCM 定位与命令封装
// ---------------------------------------------------------------------------

const GCM_CANDIDATES = [
  'C:\\Users\\franc\\AppData\\Local\\Programs\\MinGit\\ucrt64\\bin\\git-credential-manager.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe',
  'C:\\Program Files (x86)\\Git\\mingw64\\bin\\git-credential-manager.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager-core.exe',
]

function resolveGcm(config) {
  const explicit = cfg(config, 'gcmPath', '')
  if (explicit && existsSync(explicit)) return explicit
  for (const p of GCM_CANDIDATES) if (existsSync(p)) return p
  return ''
}

/** 把 Windows 绝对路径转成 WSL 里的 /mnt/c/... 形式。 */
function toWslPath(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (!m) return winPath
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/**
 * 在指定端点上运行一条命令。
 * target === 'windows' → 直接用本机；否则经 wsl.exe -d <name> -e bash -lc '...'
 */
function runOn(target, command, opts = {}) {
  if (target === 'windows') {
    return exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], opts)
  }
  return exec('wsl.exe', ['-d', target, '-e', 'bash', '-lc', command], {
    ...opts,
    env: { WSL_UTF8: '1', ...(opts.env ?? {}) },
  })
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/**
 * 把任何形如 password=xxx / oauth_token: xxx / github_pat_xxx 的内容脱敏。
 * 只保留「有值、长度、类型前缀」，这是用户要的「知道有什么」但「不泄露」。
 */
function redact(text) {
  if (!text) return ''
  return String(text)
    .replace(/(password\s*[=:]\s*)(\S+)/gi, (_m, p, v) => `${p}${maskValue(v)}`)
    .replace(/(oauth_token\s*:\s*)(\S+)/gi, (_m, p, v) => `${p}${maskValue(v)}`)
    .replace(/(gh[opusr]_[A-Za-z0-9]{6})[A-Za-z0-9_\-]+/g, '$1' + '***')
    .replace(/(github_pat_[A-Za-z0-9]{8})[A-Za-z0-9_\-]+/g, '$1' + '***')
}

function maskValue(v) {
  const s = String(v)
  const kind = /^gho_/i.test(s) ? 'oauth'
    : /^ghp_/i.test(s) ? 'classic-pat'
      : /^github_pat_/i.test(s) ? 'fine-grained-pat'
        : /^gh[us]_/i.test(s) ? 'user/server-token'
          : /^-----BEGIN/.test(s) ? 'pem'
            : 'opaque'
  return `<${kind}, len=${s.length}>`
}

// ---------------------------------------------------------------------------
// 探测：只读体检的各个探针
// ---------------------------------------------------------------------------

/**
 * Windows：git 版本、helper（含来源与条数）、store、代理、SSH 私钥口令、WSL 发行版、内网互通。
 * 注意 ssh 私钥口令检测用 `ssh-keygen -y -P "" -f <key>`：能导出公钥即为空口令（高危）。
 */
function probeWindows() {
  // 关键：先强制 UTF-8 输出，否则 cmdkey 等外部程序在 OEM 码页下会把中文输出成乱码。
  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Continue'
"git:             " + ((git --version) -join '')
"exec-path:       " + ((git --exec-path) -join '')
$h = @(git config --show-origin --get-all credential.helper 2>$null | Where-Object { $_.Trim() -ne '' })
"helper:          " + ($h -join ' | ')
// helper(scoped) 输出全部按 URL 作用域的 helper 原始行，用 ~ 分隔；
// 叠加判定统一在 JS 里做（见 parseStatus），不在这里算。
"helper(scoped):  " + ((git config --global --get-regexp '^credential\..*\.helper$' 2>$null) -join '~')
"credentialStore: " + $(if (git config --get credential.credentialStore) { git config --get credential.credentialStore } else { '(default = wincredman)' })
"sslBackend:      " + $(if (git config --get http.sslBackend) { git config --get http.sslBackend } else { '(default)' })
"http.proxy:      " + $(if (git config --global --get http.proxy) { git config --global --get http.proxy } else { '(unset)' })
"env HTTPS_PROXY: " + $(if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { '(unset)' })
"sys proxy:       " + ((Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer)
$sshDir = "$env:USERPROFILE\\.ssh"
$keys = @(Get-ChildItem $sshDir -Filter 'id_*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*.pub' })
"ssh keys:        " + $(if ($keys.Count) { ($keys.Name -join ',') } else { 'none' })
$np = @()
if ($keys.Count -gt 0) {
  if (Get-Command ssh-keygen -ErrorAction SilentlyContinue) {
    foreach ($k in $keys) { & ssh-keygen -y -P '' -f $k.FullName *> $null; if ($LASTEXITCODE -eq 0) { $np += $k.Name } }
    "ssh nopass:      " + $(if ($np.Count) { $np -join ',' } else { 'none' })
  } else { "ssh nopass:      could-not-check" }
} else { "ssh nopass:      no-keys" }
"ssh-agent:       " + ((Get-Service ssh-agent -ErrorAction SilentlyContinue).Status)
$env:WSL_UTF8='1'
"wsl distros:     " + ((@(wsl.exe -l -q 2>$null) | Where-Object { $_.Trim() -ne '' }) -join ',')
"gh:              " + $(if (Get-Command gh -ErrorAction SilentlyContinue) { 'installed' } else { 'not installed' })
"---- windows credential manager: git entries ----"
(cmdkey /list) | Select-String 'git:' | ForEach-Object { $_.Line.Trim() }`
}

/**
 * WSL：git 版本、helper、store、代理、SSH 私钥口令、明文凭据、gh 状态。
 *
 * 用 JS 单引号字符串数组拼接（而不是模板字符串）：bash 里 ${VAR:-x} 会被 JS
 * 模板字符串当成插值，必须逐个转义，极易漏。普通字符串不插值，最稳。
 */
function probeWsl() {
  // 注意：WSL 上的 helper 大多按 URL 作用域存（credential.https://host.helper），
  // 直接 --get-all credential.helper 会什么都不返回。必须 --get-regexp 全扫。
  const lines = [
    'echo "git:             $(git --version 2>&1)"',
    // helper(scoped)：输出全部按 URL 作用域的 helper 原始行，用 ` ~~ ` 分隔。
    // 用 sed 把换行换成分隔符（而不是 tr 成 | ），避免和 helper 值里的 | 混淆。
    // 叠加判定统一在 JS 的 parseStatus 里做。
    // 把多行输出合并成一行用 `paste -sd`（不用 sed ':a;N;$!ba'：
    // 那种写法在末行无换行时会把最后一个字段和下一条 echo 粘在一起，
    // 实测导致 ssh nopass / plaintext 等字段整体错位）。
    'echo "helper(scoped):  $(git config --global --get-regexp \"^credential\\..*\\.helper$\" 2>/dev/null | paste -sd \"~\" -)"',
    'echo "helper(bare):    $(git config --global --get-all credential.helper 2>/dev/null | paste -sd \"~\" -)"',
    'echo "credentialStore: $(git config --get credential.credentialStore 2>/dev/null || echo "(unset)")"',
    'echo "sslBackend:      $(git config --get http.sslBackend 2>/dev/null || echo "(default)")"',
    'echo "http.proxy:      $(git config --global --get http.proxy 2>/dev/null || echo "(unset)")"',
    'echo "env HTTPS_PROXY: ${HTTPS_PROXY:-(unset)}"',
    'echo "ssh keys:        $(ls ~/.ssh/id_* 2>/dev/null | grep -v "\\.pub$" | xargs -r -n1 basename | tr "\\n" ",")"',
    '_np=""; for k in ~/.ssh/id_*; do case "$k" in *.pub) continue;; esac; [ -f "$k" ] || continue; if command -v ssh-keygen >/dev/null 2>&1; then ssh-keygen -y -P "" -f "$k" >/dev/null 2>&1 && _np="$_np$(basename "$k"),"; else _np="could-not-check"; fi; done; echo "ssh nopass:      ${_np:-none}"',
    'echo "ssh-agent:       ${SSH_AUTH_SOCK:-(unset)}"',
    'echo "plaintext creds: $(ls ~/.git-credentials 2>/dev/null || echo none)"',
    // 【坑】只看文件是否存在会长期假报警：`gh auth logout` 只把内容清成 `{}`，文件本身还在。
    // 实测：注销后 hosts.yml 仍然存在（3 字节），旧写法会一直报「有明文凭据」。
    // 所以这里必须看里面到底还有没有 token。
    'echo "gh hosts file:   $(f=~/.config/gh/hosts.yml; if [ -f "$f" ]; then if grep -q "oauth_token" "$f" 2>/dev/null; then echo "has-token($(stat -c %a "$f"))"; else echo "empty-file"; fi; else echo none; fi)"',
    'echo "gh status:       $(command -v gh >/dev/null 2>&1 && (gh auth status 2>&1 | head -4 | tr "\\n" "|") || echo "not installed")"',
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 端点发现
// ---------------------------------------------------------------------------

/** 列出本机所有 WSL 发行版名（失败返回空数组，不抛）。 */
async function listWslDistros() {
  const r = await exec('wsl.exe', ['-l', '-q'], { timeoutMs: 8000, env: { WSL_UTF8: '1' } })
  if (!r.ok) return []
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// 体检逻辑（工具与设置面板共用）
// ---------------------------------------------------------------------------

/**
 * 跑完整体检，返回纯文本报告。
 * 抽成独立函数是为了让 gitok_doctor 工具和设置面板的 /status 路由共用同一份逻辑，
 * 避免两边行为漂移。
 */
async function runDoctor(api, listArg) {
  const list = Array.isArray(listArg) && listArg.length ? listArg.map(String) : await api.resolveTargets()
  const g = api.gcm()
  const lines = []

  lines.push('# git 认证体检')
  lines.push('')
  lines.push(`- GCM 路径：${g || '❌ 未找到（请设置 gcmPath）'}`)
  if (g) {
    const ver = await exec(g, ['--version'], { timeoutMs: api.probeTimeout() })
    lines.push(`- GCM 版本：${(ver.stdout || ver.stderr || '').trim() || '(未知)'}`)
  }
  lines.push('')

  for (const target of list) {
    lines.push(`## 端点：${target}`)
    const cmd = target === 'windows' ? probeWindows() : probeWsl()
    const r = await runOn(target, cmd, { timeoutMs: api.probeTimeout() })
    const body = redact((r.stdout || '').trim())
    if (r.code === 'TIMEOUT') {
      lines.push(`> ⏱ 超时（${api.probeTimeout()}ms），该端点可能未启动或 WSL 未运行。`)
    } else if (!r.ok && !body) {
      lines.push(`> ❌ 探测失败 [${r.code}] ${redact(r.stderr) || '(无输出)'}`)
    } else {
      lines.push('```')
      lines.push(body || '(无输出)')
      lines.push('```')
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('**判读要点**')
  lines.push('- `helper` 为空且无 `credentialStore` → 该终端不会持久化任何凭据。')
  lines.push('- `plaintext creds` 有值，或 `gh hosts file` 显示 `has-token(...)` → 明文落盘，违背「不落明文」。')
  lines.push('  （显示 `empty-file` 是正常的：`gh auth logout` 会把内容清成 `{}` 但保留文件。）')
  lines.push('- `env HTTPS_PROXY` 为空但需要代理 → git 直连会超时。')
  lines.push('- `ssh nopass` 列出私钥名 → **空口令私钥，拷走即等于账号被盗**（P0）。')
  lines.push('- `helper.stack` 里某 host 的值 > 1 → helper 叠加，多个代答器同时生效，行为不可预期。')
  return lines.join('\n')
}

/**
 * 把体检文本解析成结构化状态，给设置面板画卡片用。
 * 解析失败一律降级为 unknown，不让面板崩。
 *
 * 返回 level ∈ ok | warn | error | unknown，并附带六项持续监控的逐项结果。
 */
function parseStatus(text, gcmPath, extra = {}) {
  // 【坑】这里必须用 [ \t]* 而不是 \s*：\s 包含换行符，
  // 目标行值为空时 \s* 会吃掉换行，.+ 转而抓到下一行内容。
  // 实测：helper(scoped): 为空时，regex 抓到了 "credentialStore: (default = wincredman)"。
  const pick = (src, re) => { const m = src.match(re); return m && m[1] ? m[1].trim() : '' }
  const helper = pick(text, /^helper:[ \t]*(.*)$/m)
  const scoped = pick(text, /^helper\(scoped\):[ \t]*(.*)$/m)
  const store = pick(text, /^credentialStore:[ \t]*(.*)$/m)
  const proxy = pick(text, /^http\.proxy:[ \t]*(.*)$/m)
  const sysProxy = pick(text, /^sys proxy:[ \t]*(.*)$/m)
  const sshKeys = pick(text, /^ssh keys:[ \t]*(.*)$/m)
  const sshAgent = pick(text, /^ssh-agent:[ \t]*(.*)$/m)
  const gh = pick(text, /^gh:[ \t]*(.*)$/m)
  const credTargets = [...text.matchAll(/Target:\s*(\S+)/g)].map((m) => m[1])

  // 按端点切段，逐端点判读
  const sections = []
  const markRe = /^## 端点：(.+)$/gm
  const marks = []
  let mm
  while ((mm = markRe.exec(text))) marks.push({ name: mm[1].trim(), start: mm.index })
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length
    sections.push({ name: marks[i].name, body: text.slice(marks[i].start, end) })
  }

  const checks = []
  const add = (id, label, level, detail) => checks.push({ id, label, level, detail })

  // ---- a：端到端通路心跳（可选，需 heartbeatUrl） ----
  if (extra.heartbeat) {
    add('heartbeat', '端到端通路', extra.heartbeat.level, extra.heartbeat.detail)
  } else {
    add('heartbeat', '端到端通路', 'unknown', '未配置 heartbeatUrl 或本次未跑（不假装健康）')
  }

  // ---- 逐端点检查 ----
  let hasPlaintext = false
  let hasEmptySshKey = false
  let sshUnknown = false
  let helperStacked = false
  const stackedAt = []
  let endpointTimeout = false

  // 面板上的 WSL 说明区要用到：每个非 windows 端点当前指向哪个 helper。
  // 目的不是重现完整诊断，而是让用户一眼看出「这台到底接管了没」。
  const wslEndpoints = []
  for (const sec of sections) {
    if (/⏱ 超时|❌ 探测失败/.test(sec.body)) endpointTimeout = true
    const body = sec.body

    const pc = pick(body, /^plaintext creds:[ \t]*(.*)$/m)
    if (pc && pc !== 'none') hasPlaintext = true
    const ghHosts = pick(body, /^gh hosts file:[ \t]*(.*)$/m)
    // empty-file = 文件在但里面没有 token（gh auth logout 后的状态），不算明文泄露。
    if (ghHosts && ghHosts !== 'none' && ghHosts !== 'empty-file') hasPlaintext = true

    const np = pick(body, /^ssh nopass:[ \t]*(.*)$/m)
    if (np && np !== 'none' && np !== 'no-keys') {
      if (np === 'could-not-check') sshUnknown = true
      else hasEmptySshKey = true
    }

    // helper 叠加：只看「同一 host 下有几个非空 helper」。
    // 不能看总行数：gist / 飞书 各有自己的 host 是正常的。
    // 空值条目也是正常的：`git config key ""` 后跟一个真值是常见的「先清空再设值」。
    //
    // 解析格式（git config --get-regexp 的真实输出）：
    //   credential.https://github.com.helper            ← 空值行（key 后有空格）
    //   credential.https://github.com.helper !path/gcm  ← 真值行
    const scopedRaw = pick(body, /^helper\(scoped\):[ \t]*(.*)$/m)
    if (scopedRaw) {
      const counts = new Map()
      for (const raw of scopedRaw.split('~')) {
        const entry = raw.trim()
        if (!entry) continue
        // key 与值之间是「一个或多个空白」，且值可能包含空格（路径）
        const sp = entry.search(/[ \t]/)
        const key = sp === -1 ? entry : entry.slice(0, sp)
        const value = sp === -1 ? '' : entry.slice(sp).trim()
        if (!value) continue                 // 空值行：正常的清空占位，不计数
        counts.set(key, (counts.get(key) || 0) + 1)
      }
      for (const [key, n] of counts) {
        if (n > 1) {
          helperStacked = true
          stackedAt.push(key.replace(/^credential\./, '').replace(/\.helper$/, '') + '=' + n)
        }
      }
    }

    // 收集 WSL 端点状态（windows 本机不算，它就是「源头」）
    if (sec.name && sec.name !== 'windows') {
      const raw = pick(body, /^helper\(scoped\):[ \t]*(.*)$/m)
      // 只看 github 相关的 helper，飞书那条不相关
      const ghHelpers = (raw || '')
        .split('~')
        .map((x) => x.trim())
        .filter((x) => /github\.com|gist\.github\.com/.test(x))
        .map((x) => {
          const sp = x.search(/[ \t]/)
          return sp === -1 ? '' : x.slice(sp).trim()
        })
        .filter(Boolean)
      // adopted = 只指向 GCM（路径里含 git-credential-manager），且没有其他代答器叠加
      const adopted = ghHelpers.length === 1 && /git-credential-manager/i.test(ghHelpers[0])
      wslEndpoints.push({
        name: sec.name,
        adopted,
        helper: ghHelpers.length ? ghHelpers.join(' + ') : '',
      })
    }
  }

  // ---- b：明文凭据 ----
  if (hasPlaintext) {
    add('plaintext', '明文凭据', 'warn', '存在 hosts.yml 或 ~/.git-credentials —— 可被同用户任意进程读取')
  } else {
    add('plaintext', '明文凭据', 'ok', '未发现明文凭据落盘')
  }

  // ---- c：SSH 私钥口令（P0） ----
  if (hasEmptySshKey) {
    add('sshkey', 'SSH 私钥口令', 'error', '存在空口令私钥：拷走即等于账号被盗（P0）')
  } else if (sshUnknown) {
    add('sshkey', 'SSH 私钥口令', 'unknown', '本机无 ssh-keygen，无法判断私钥是否带口令')
  } else {
    add('sshkey', 'SSH 私钥口令', 'ok', sshKeys && sshKeys !== 'none' ? '私钥均已设口令' : '无私钥')
  }

  // ---- d：helper 叠加 ----
  add('helper', 'helper 叠加',
    helperStacked ? 'warn' : 'ok',
    helperStacked ? `同一 host 下有多个 helper 叠加：${stackedAt.join(', ')}` : '每个 host 单一 helper')

  // ---- e：凭据条目异常 ----
  const hosts = new Set()
  for (const t of credTargets) {
    const h = /https?:\/\/([^/]+)/.exec(t)
    if (h) hosts.add(h[1])
  }
  // 注意：credTargets 只来自 Windows 凭据管理器。
  // 若本次只探了 WSL 端点，Windows 侧本来就没扫，此时报「尚无凭据」是错的。
  const onlyWsl = sections.length > 0 && sections.every((s) => s.name !== 'windows')
  if (onlyWsl) {
    add('creds', '凭据条目', 'unknown', '本次只探了 WSL 端点；WSL 不存凭据，它是借 Windows 的那一份')
  } else {
    add('creds', '凭据条目',
      credTargets.length === 0 ? 'warn' : 'ok',
      credTargets.length === 0
        ? '尚无已存凭据（需要登录一次）'
        : `${credTargets.length} 条${hosts.size > 1 ? `，跨 ${hosts.size} 个 host` : ''}`)
  }

  // ---- f：依赖漂移（GCM / 代理 / 端点可达） ----
  const gcmMissing = !gcmPath
  const proxyStr = extra.proxyReachable
  let depLevel = 'ok'
  let depDetail = 'GCM 就位，端点探测正常'
  if (gcmMissing) { depLevel = 'error'; depDetail = '未找到 GCM，无法管理凭据' }
  else if (endpointTimeout) { depLevel = 'error'; depDetail = '有端点探测超时或失败（WSL 可能未启动）' }
  else if (proxyStr === false) { depLevel = 'warn'; depDetail = '代理端口连不上，git 可能超时' }
  add('deps', '依赖与网络', depLevel, depDetail)

  // ---- 汇总 ----
  const rank = { error: 3, warn: 2, unknown: 1, ok: 0 }
  let level = 'ok'
  for (const c of checks) if (rank[c.level] > rank[level]) level = c.level
  if (gcmMissing) level = 'error'

  const summary =
    level === 'error' ? (checks.find((c) => c.level === 'error')?.detail || '存在必须处理的问题')
      : level === 'warn' ? (checks.find((c) => c.level === 'warn')?.detail || '可用，但有需要注意的项')
        : level === 'unknown' ? '状态未知（部分探测未完成）'
          : '已配置，认证可用'

  // 兼容旧字段：hasHelper 判断用于「未挂载 GCM」提示
  const hasHelper = /manager|credential-manager/i.test(helper) || /credential-manager/i.test(scoped)

  return {
    level, summary, checks, gcmPath: gcmPath || '',
    helper: helper || '(未配置)',
    scoped: scoped || '(无)',
    store: store || '(默认 wincredman)',
    proxy: proxy && proxy !== '(unset)' ? proxy : '',
    sysProxy: sysProxy || '',
    sshKeys: sshKeys && sshKeys !== 'none' ? sshKeys : '',
    sshAgent: sshAgent || '',
    gh: gh || '',
    credTargets,
    hasHelper,
    wslEndpoints,
    checkedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// 工具实现（抽成函数，工具与面板写路由共用同一份逻辑）
// ---------------------------------------------------------------------------

async function toolDoctor(api, args) {
  return runDoctor(api, args?.targets)
}

async function toolVerify(api, args) {
  const url = String(args?.url ?? '').trim()
  if (!url) return '❌ 必须提供 url'
  const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : await api.resolveTargets()
  const useProxy = args?.useProxy !== false
  const p = api.proxy()
  const lines = [`# 验证 ${url}`, '']
  const results = []

  for (const target of list) {
    const proxyArg = useProxy && p ? ` -c http.proxy=${p}` : ''
    const cmd = `git${proxyArg} ls-remote ${url} HEAD`
    const r = await runOn(target, cmd, { timeoutMs: api.probeTimeout() })
    const okMark = r.ok ? '✅' : '❌'
    results.push({ target, ok: r.ok, code: r.code })
    lines.push(`- ${okMark} **${target}** [${r.code}]`)
    const out = redact((r.stdout || '').trim())
    const err = redact((r.stderr || '').trim())
    if (out) lines.push('  ```\n  ' + out.split('\n').join('\n  ') + '\n  ```')
    if (err) lines.push('  ```\n  ' + err.split('\n').join('\n  ') + '\n  ```')
  }

  lines.push('')
  lines.push('> 全 ✅ = 该端点的 git 认证通路完整（凭据 + 网络）。')
  lines.push('> 若 `Failed to connect` = 网络/代理问题，不是认证问题。')
  return { text: lines.join('\n'), results }
}

async function toolList(api, args) {
  const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : await api.resolveTargets()
  const g = api.gcm()
  const lines = ['# 已存 git 凭据', '']

  lines.push('## Windows 凭据管理器')
  const cmdkey = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (cmdkey /list) | Select-String "git:" | ForEach-Object { $_.Line.Trim() }'],
    { timeoutMs: api.probeTimeout() })
  lines.push(cmdkey.stdout.trim() ? '```\n' + redact(cmdkey.stdout.trim()) + '\n```' : '_(没有 git: 开头的条目)_')

  if (g) {
    lines.push('')
    lines.push('## GCM 已知账号')
    const accts = await exec(g, ['github', 'list'], { timeoutMs: api.probeTimeout() })
    lines.push(accts.stdout.trim() ? '```\n' + redact(accts.stdout.trim()) + '\n```' : '_(GCM 未记录 GitHub 账号)_')
  }

  for (const target of list) {
    if (target === 'windows') continue
    lines.push('')
    lines.push(`## 端点：${target}`)
    const r = await runOn(target,
      `echo "helper(scoped): $(git config --global --get-regexp '^credential\\..*\\.helper$' 2>/dev/null | tr '\\n' '|')"
echo "gh hosts:       $(stat -c '%a %U' ~/.config/gh/hosts.yml 2>/dev/null || echo none)"
echo "store file:     $(ls ~/.git-credentials 2>/dev/null || echo none)"
echo "ssh keys:       $(ls ~/.ssh/id_* 2>/dev/null | xargs -r -n1 basename | tr '\\n' ',' || echo none)"`,
      { timeoutMs: api.probeTimeout() })
    lines.push(r.stdout.trim() ? '```\n' + redact(r.stdout.trim()) + '\n```' : `_(无输出: ${r.code})_`)
  }

  lines.push('')
  lines.push('> 删除方式见 `gitok_revoke`。')
  return lines.join('\n')
}

/** 触发 GCM 登录。密钥由 GCM 直接写入 Windows 凭据管理器，本插件不接触。 */
async function doLogin(api, host, username) {
  const g = api.gcm()
  if (!g) return { ok: false, text: '❌ 未找到 git-credential-manager，请先在设置里配置 gcmPath。' }

  // 用 GCM 的 get 触发一次交互：仓库没凭据时它会弹浏览器/设备码。
  // 我们只关心「它是否成功返回」，绝不读取或输出 password 值。
  const input = `protocol=https\nhost=${host}\n${username ? `username=${username}\n` : ''}\n`
  const r = await exec(g, ['get'], { timeoutMs: 300000, input })

  const lines = [`# 登录 ${host}`, '']
  if (r.ok) {
    const userLine = (r.stdout || '').split(/\r?\n/).find((l) => /^username=/.test(l))
    const pwLine = (r.stdout || '').split(/\r?\n/).find((l) => /^password=/.test(l))
    lines.push('- ✅ GCM 返回了可用凭据')
    if (userLine) lines.push(`- 用户名：${redact(userLine)}`)
    if (pwLine) {
      const pw = pwLine.slice('password='.length)
      lines.push(`- 密钥：${maskValue(pw)}（值不显示、不落盘、不写入本插件）`)
    }
    lines.push('')
    lines.push('凭据已由 GCM 存入 Windows 凭据管理器（DPAPI，绑定当前用户+本机）。')
    lines.push('建议接着执行 `gitok_verify` 做端到端确认。')
  } else {
    lines.push(`- ❌ 失败 [${r.code}]`)
    if (r.stderr) lines.push('```\n' + redact(r.stderr) + '\n```')
    lines.push('')
    lines.push('常见原因：代理不通（GCM 需要能访问 github.com）、系统未弹窗、或 GCM 未配置 GitHub host provider。')
  }
  return { ok: r.ok, text: lines.join('\n') }
}

async function toolLogin(api, args) {
  const host = String(args?.host ?? 'github.com').trim() || 'github.com'
  const username = args?.username ? String(args.username) : ''
  return (await doLogin(api, host, username)).text
}

/** 列出某 host 的凭据被哪些仓库用到（revoke 前的影响面提示）。 */
async function revokeImpact(api, host) {
  const list = await api.resolveTargets()
  const rows = []
  for (const target of list) {
    const cmd = target === 'windows'
      ? `$ErrorActionPreference='SilentlyContinue'
$dirs = @("$env:USERPROFILE\\git","$env:USERPROFILE\\Documents","C:\\dsh")
foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem $d -Directory -Depth 2 | ForEach-Object { $g = Join-Path $_.FullName '.git'; if (Test-Path $g) { $u = git -C $_.FullName remote get-url origin 2>$null; if ($u -like "*${host}*") { "$($_.FullName) => $u" } } } } }`
      : `for d in ~/git ~/Documents /mnt/c/dsh; do [ -d "$d" ] || continue; find "$d" -maxdepth 3 -name .git -type d 2>/dev/null | while read g; do r=$(dirname "$g"); u=$(git -C "$r" remote get-url origin 2>/dev/null); case "$u" in *${host}*) echo "$r => $u";; esac; done; done`
    const r = await runOn(target, cmd, { timeoutMs: api.probeTimeout() })
    const out = redact((r.stdout || '').trim())
    if (out) rows.push({ target, repos: out.split(/\r?\n/).filter(Boolean) })
  }
  return rows
}

async function toolRevoke(api, args) {
  if (args?.confirm !== true) {
    const host = String(args?.host ?? 'github.com').trim() || 'github.com'
    const impact = await revokeImpact(api, host)
    const lines = [
      '⚠️ 这是删除操作，需要显式传 `confirm: true` 才会执行。',
      '',
      `## 将要删除的凭据`,
      `- host: \`${host}\`${args?.path ? `\n- path: \`${args.path}\`` : ''}`,
      '',
      '## 影响面（这些仓库的 git 操作在删除后会重新要求认证）',
    ]
    if (!impact.length) lines.push('_(未在本机常见目录找到使用该 host 的仓库；不代表没有，只代表没扫到)_')
    for (const it of impact) {
      lines.push(`### 端点：${it.target}`)
      lines.push('```')
      for (const repo of it.repos) lines.push(repo)
      lines.push('```')
    }
    lines.push('')
    lines.push('确认无误后，带 `confirm: true` 再调用一次。')
    return lines.join('\n')
  }

  const host = String(args?.host ?? 'github.com').trim() || 'github.com'
  const repoPath = args?.path ? String(args.path) : ''
  const g = api.gcm()
  if (!g) return '❌ 未找到 git-credential-manager。'

  const input = `protocol=https\nhost=${host}\n${repoPath ? `path=${repoPath}\n` : ''}\n`
  const r = await exec(g, ['erase'], { timeoutMs: api.probeTimeout(), input })
  const lines = [`# 撤销 ${host}${repoPath ? '/' + repoPath : ''}`, '']
  lines.push(r.ok ? '- ✅ GCM erase 成功（Windows 凭据管理器条目已删除）' : `- ❌ erase 失败 [${r.code}]：${redact(r.stderr)}`)
  if (r.stderr) lines.push('```\n' + redact(r.stderr) + '\n```')

  const wsls = Array.isArray(args?.alsoWsl) ? args.alsoWsl.map(String) : []
  for (const t of wsls) {
    lines.push('')
    lines.push(`## 清理 WSL 端点：${t}`)
    const cmd = `git config --global --unset-all "credential.https://${host}.helper" 2>/dev/null; echo "unset done"`
    const w = await runOn(t, cmd, { timeoutMs: api.probeTimeout() })
    lines.push(w.ok ? '- ✅ 已移除该 host 的 helper 配置' : `- ⚠️ [${w.code}] ${redact(w.stderr)}`)
  }

  lines.push('')
  lines.push('> 建议再跑 `gitok_list` 确认条目已消失。')
  return lines.join('\n')
}

/**
 * 接管端点：把 helper 指向 Windows GCM。
 * dryRun=true 时只报「将执行什么」，不改任何文件。
 */
async function toolAdopt(api, args) {
  const g = api.gcm()
  if (!g) return '❌ 未找到 git-credential-manager，无法接管。'
  const gWsl = toWslPath(g)
  const dryRun = args?.dryRun === true

  const allTargets = (await api.resolveTargets()).filter((t) => t !== 'windows')
  const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : allTargets
  const hosts = Array.isArray(args?.hosts) && args.hosts.length ? args.hosts.map(String) : ['github.com']
  const uhp = args?.useHttpPath !== undefined ? Boolean(args.useHttpPath) : Boolean(cfg(api.config, 'useHttpPath', false))

  const lines = ['# 接管 git 认证' + (dryRun ? '（预演，不写入）' : ''), '', `- Windows GCM：\`${g}\``, `- WSL 路径：\`${gWsl}\``, '']
  if (!list.length) lines.push('_(没有可接管的 WSL 端点。用 targets 指定发行版名，或把配置 targets 设为 auto)_')

  for (const target of list) {
    lines.push(`## 端点：${target}`)
    const probe = await runOn(target, `test -x ${JSON.stringify(gWsl)} && echo OK || echo MISSING`, { timeoutMs: api.probeTimeout() })
    if (!probe.stdout.includes('OK')) {
      lines.push(`- ❌ 该端点访问不到 \`${gWsl}\`（interop 关闭或路径不对），跳过。`)
      lines.push('')
      continue
    }

    if (dryRun) {
      lines.push('- 计划动作：')
      lines.push(`  1. 备份 \`~/.gitconfig\` → \`~/.gitconfig.bak.gitok-<时间戳>\``)
      for (const h of hosts) {
        lines.push(`  2. \`git config --global --unset-all credential.https://${h}.helper\``)
        lines.push(`  3. \`git config --global --add credential.https://${h}.helper "!${gWsl}"\``)
        if (uhp) lines.push(`  4. \`git config --global credential.https://${h}.useHttpPath true\``)
      }
      lines.push('')
      continue
    }

    const backup = await runOn(target,
      `cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S) 2>/dev/null && echo backed-up || echo no-file`,
      { timeoutMs: api.probeTimeout() })
    lines.push(`- 备份：${backup.stdout.trim() || '(无原文件)'}`)

    // 写入 helper。
    // 【坑】`git config key ""` 并不是「清空」，它会在多值里再追加一个空值，
    // 旧 helper 仍然保留。真正的清空必须用 --unset-all。
    // 否则会出现「gh helper 和 GCM 同时生效」的叠加状态。
    const cmds = []
    for (const h of hosts) {
      cmds.push(`git config --global --unset-all "credential.https://${h}.helper" 2>/dev/null || true`)
      cmds.push(`git config --global --add "credential.https://${h}.helper" "!${gWsl}"`)
      if (uhp) cmds.push(`git config --global "credential.https://${h}.useHttpPath" true`)
    }
    const w = await runOn(target, cmds.join('; '), { timeoutMs: api.probeTimeout() })
    lines.push(w.ok ? '- ✅ helper 已指向 Windows GCM' : `- ❌ 写入失败 [${w.code}]：${redact(w.stderr)}`)

    // 复查：应当只剩一条 GCM
    const chk = await runOn(target, `git config --global --get-all "credential.https://${hosts[0]}.helper"`, { timeoutMs: api.probeTimeout() })
    const got = chk.stdout.trim()
    lines.push(`- 复查 helper：\`${redact(got) || '(空)'}\``)
    if (got && !got.includes(gWsl)) lines.push('  ⚠️ 未生效，请检查 git 版本是否支持 `--unset-all`。')
    if (got.split('\n').filter(Boolean).length > 1) lines.push('  ⚠️ 仍有多条 helper 叠加，请手动清理。')
    lines.push('')
  }

  lines.push('---')
  lines.push('下一步：跑 `gitok_verify` 确认端到端可用；确认无误后再考虑 `gh auth logout` 清掉明文 PAT。')
  return lines.join('\n')
}

/** 轮换：预检 → 备份 → erase → login → verify。删除的 DPAPI 凭据无法恢复（诚实说明）。 */
async function toolRotate(api, args) {
  const host = String(args?.host ?? 'github.com').trim() || 'github.com'
  const url = args?.url ? String(args.url).trim() : ''
  const username = args?.username ? String(args.username) : ''
  const dryRun = args?.dryRun === true
  const g = api.gcm()
  if (!g) return '❌ 未找到 git-credential-manager，无法轮换。'

  const lines = [`# 轮换凭据 ${host}` + (dryRun ? '（预演）' : ''), '']
  const steps = []

  // 1) 预检：先验证当前通路。网络坏的时候不要先把还能用的凭据删掉。
  if (url) {
    lines.push('## 1. 预检（避免在断网时把可用凭据删掉）')
    const pre = await toolVerify(api, { url, targets: ['windows'], useProxy: true })
    const preOk = pre.results.every((r) => r.ok)
    lines.push(preOk ? '- ✅ 当前通路可用，可以继续轮换' : '- ❌ 当前通路不通。轮换需要能访问远端，已中止（未删除任何凭据）')
    if (!preOk) {
      lines.push('')
      lines.push('```')
      lines.push(pre.text)
      lines.push('```')
      return lines.join('\n')
    }
    lines.push('')
  }

  steps.push(`备份 \`~/.gitconfig\`（不改也行，但删凭据前留个还原点）`)
  steps.push(`\`${path.basename(g)} erase protocol=https host=${host}\` —— 删除旧凭据`)
  steps.push(`\`${path.basename(g)} get\` —— 触发 GCM 浏览器/设备码重新登录`)
  if (url) steps.push(`\`git ls-remote ${url} HEAD\` —— 端到端验收`)

  if (dryRun) {
    lines.push('## 计划动作（预演，未执行）')
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
    return lines.join('\n')
  }

  lines.push('## 2. 执行')
  const mkdir = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    `$p="$env:USERPROFILE\\.gitconfig"; if (Test-Path $p) { Copy-Item $p "$p.bak.gitok-$(Get-Date -Format yyyyMMddHHmmss)" -Force; "backed-up" } else { "no-file" }`],
    { timeoutMs: api.probeTimeout() })
  lines.push(`- 备份 ~/.gitconfig：${mkdir.stdout.trim() || '(无原文件)'}`)

  const erase = await exec(g, ['erase'], {
    timeoutMs: api.probeTimeout(),
    input: `protocol=https\nhost=${host}\n\n`,
  })
  lines.push(erase.ok ? '- ✅ 旧凭据已删除' : `- ⚠️ erase 返回 [${erase.code}]（可能本来就没有凭据），继续登录`)

  const login = await doLogin(api, host, username)
  lines.push(login.ok ? '- ✅ 重新登录成功' : '- ❌ 重新登录失败')
  lines.push('')
  lines.push('```')
  lines.push(login.text)
  lines.push('```')

  if (url) {
    lines.push('')
    lines.push('## 3. 验收')
    const post = await toolVerify(api, { url, targets: ['windows'], useProxy: true })
    const postOk = post.results.every((r) => r.ok)
    lines.push(postOk ? '- ✅ 轮换后端到端可用' : '- ❌ 轮换后仍然不通')
    lines.push('')
    lines.push('```')
    lines.push(post.text)
    lines.push('```')
    if (!postOk) {
      lines.push('')
      lines.push('> ⚠️ **诚实说明**：DPAPI 凭据一旦 erase 就无法自动恢复，')
      lines.push('> 所以这里的「回滚」只能还原 gitconfig，**不能还原凭据本身**。')
      lines.push('> 请修复网络/代理后重试 `gitok_login`。')
    }
  }

  return lines.join('\n')
}

/**
 * 一键初始化：S0 环境自检 → S1 幂等配置 → S2 登录 → S3 验收 → S4 收尾建议。
 * 可重入：任何时候重跑都从 S0 开始，已满足的阶段自动跳过。
 */
async function toolBootstrap(api, args) {
  const dryRun = args?.dryRun === true
  const url = args?.url ? String(args.url).trim() : ''
  const cleanPlaintext = args?.cleanPlaintext === true
  const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : await api.resolveTargets()
  const g = api.gcm()

  const out = ['# 初始化 git 认证' + (dryRun ? '（预演，不写入）' : ''), '']

  // ── S0 环境自检 ────────────────────────────────────────────────
  out.push('## S0 环境自检')
  const envLines = []
  envLines.push(`- GCM：${g ? '✅ `' + g + '`' : '❌ 未找到（在配置里填 gcmPath）'}`)
  if (g) {
    const ver = await exec(g, ['--version'], { timeoutMs: api.probeTimeout() })
    envLines.push(`- GCM 版本：${(ver.stdout || ver.stderr || '').trim() || '(未知)'}`)
  }

  // 关键：必须同时看系统级与用户级 gitconfig。
  // 曾误判：只读 ~/.gitconfig 得出「没有 credential.helper」，其实 helper 在 MinGit 的系统级配置里。
  const sysCfg = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="SilentlyContinue"; git config --list --show-origin 2>$null | Select-String "credential\\.helper|http\\.sslbackend|http\\.proxy|user\\.(name|email)" | ForEach-Object { $_.Line.Trim() }'],
    { timeoutMs: api.probeTimeout() })
  const sysText = redact((sysCfg.stdout || '').trim())
  envLines.push(`- git 配置（含系统级来源）：${sysText ? '\n```\n' + sysText + '\n```' : '_(读不到)_'}`)

  const helperOkWin = /credential\.helper/.test(sysText)
  envLines.push(`- credential.helper：${helperOkWin ? '✅ 已在系统级或用户级配置' : '⚠️ 未读到（S1 会补）'}`)

  const distros = await listWslDistros()
  envLines.push(`- 本机 WSL 发行版：${distros.length ? distros.join(', ') : '(无 / 未安装)'}`)
  envLines.push(`- 本次将处理的端点：${list.join(', ')}`)

  // 代理：必须报「git 实际生效的值 + 来源」，而不是只听插件配置。
  // 曾误报：插件 proxy 为空却直接写「未配置」，而 git 其实配了 http.proxy，
  // 会让用户以为没配代理（进而误判「认证坏了」其实是网络）。
  const proxyInfo = await api.effectiveProxy(sysText)
  let proxyReachable
  if (proxyInfo.value) {
    const m = /^(?:https?:\/\/)?([^:/]+):(\d+)/.exec(proxyInfo.value)
    if (m) {
      proxyReachable = await probeTcp(m[1], Number(m[2]))
      envLines.push(`- 代理 ${proxyInfo.value}（来源：${proxyInfo.source}）：${proxyReachable ? '✅ 可连' : '❌ 连不上'}`)
    } else {
      envLines.push(`- 代理：\`${proxyInfo.value}\`（来源：${proxyInfo.source}，格式未识别，跳过连通性检查）`)
    }
  } else {
    envLines.push('- 代理：未配置（git 与系统均未设置，将直连）')
  }

  // MinGit 的 schannel 已知会报 SEC_E_NO_CREDENTIALS。
  // 注意区分全局与仓库本地：本地仓库的 http.sslbackend 不会出现在 --global 里。
  const ssl = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    '$g = git config --global --get http.sslBackend 2>$null; $l = git config --get http.sslBackend 2>$null;' +
    '"global=" + $(if ($g) { $g } else { "(unset)" }); "effective=" + $(if ($l) { $l } else { "(default=schannel)" })'],
    { timeoutMs: api.probeTimeout() })
  const sslLines = (ssl.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const sslGlobal = (sslLines.find((s) => s.startsWith('global=')) || '').slice('global='.length) || '(unset)'
  const sslEff = (sslLines.find((s) => s.startsWith('effective=')) || '').slice('effective='.length) || '(default=schannel)'
  envLines.push(`- http.sslBackend：全局 \`${sslGlobal}\`，当前生效 \`${sslEff}\`${sslEff === 'openssl' ? '（已规避 MinGit schannel 问题）' : ''}`)

  // 已存凭据
  const cmdkey = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (cmdkey /list) | Select-String "git:" | ForEach-Object { $_.Line.Trim() }'],
    { timeoutMs: api.probeTimeout() })
  const credCount = (cmdkey.stdout || '').split(/\r?\n/).filter(Boolean).length
  envLines.push(`- 已存凭据：${credCount ? credCount + ' 条' : '尚无（S2 会登录）'}`)

  out.push(envLines.join('\n'))
  out.push('')

  if (!g) {
    out.push('> ❌ 没有 GCM 就无法继续。请先装 Git for Windows / MinGit（自带 GCM），或在配置里指定 gcmPath。')
    return out.join('\n')
  }

  // ── S1 幂等配置 ────────────────────────────────────────────────
  out.push('## S1 幂等配置')
  if (helperOkWin) {
    out.push('- 跳过：Windows 侧 credential.helper 已配置')
  } else if (dryRun) {
    out.push('- 计划：`git config --global credential.helper manager`')
  } else {
    const r = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      'git config --global credential.helper manager; git config --global --get credential.helper'],
      { timeoutMs: api.probeTimeout() })
    out.push(r.ok ? `- ✅ 已补上 credential.helper：\`${(r.stdout || '').trim()}\`` : `- ❌ 写入失败 [${r.code}]`)
  }

  // useHttpPath 与 sslBackend 只在必要时提示，不擅自改
  if (sslEff !== 'openssl') {
    out.push('- 提示：若遇到 `SEC_E_NO_CREDENTIALS`，执行 `git config --global http.sslBackend openssl`')
  }

  // WSL 端点的 helper（若在本次端点里）
  for (const target of list) {
    if (target === 'windows') continue
    const gWsl = toWslPath(g)
    const probe = await runOn(target, `test -x ${JSON.stringify(gWsl)} && echo OK || echo MISSING`, { timeoutMs: api.probeTimeout() })
    if (!probe.stdout.includes('OK')) {
      out.push(`- ${target}：❌ 访问不到 \`${gWsl}\`（interop 关闭或该发行版未运行），跳过`)
      continue
    }
    const cur = await runOn(target, 'git config --global --get-all "credential.https://github.com.helper"', { timeoutMs: api.probeTimeout() })
    const curVal = (cur.stdout || '').trim()
    const already = curVal.split(/\r?\n/).filter(Boolean)
    if (already.length === 1 && already[0].includes('git-credential-manager')) {
      out.push(`- ${target}：跳过（helper 已指向 Windows GCM）`)
    } else if (dryRun) {
      out.push(`- ${target}：计划接管 helper → \`!${gWsl}\``)
    } else {
      const steps = [
        `cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S) 2>/dev/null || true`,
        `git config --global --unset-all "credential.https://github.com.helper" 2>/dev/null || true`,
        `git config --global --add "credential.https://github.com.helper" "!${gWsl}"`,
        `git config --global --get-all "credential.https://github.com.helper"`,
      ]
      const w = await runOn(target, steps.join('; '), { timeoutMs: api.probeTimeout() })
      out.push(w.ok
        ? `- ${target}：✅ helper 已指向 Windows GCM → \`${redact((w.stdout || '').trim())}\``
        : `- ${target}：❌ 写入失败 [${w.code}] ${redact(w.stderr)}`)
    }
  }
  out.push('')

  // ── S2 登录（已就绪则跳过） ────────────────────────────────────
  out.push('## S2 登录')
  if (credCount > 0) {
    out.push('- 跳过：本机已有凭据。需要换账号时用 `gitok_rotate`')
  } else if (dryRun) {
    out.push('- 计划：触发 GCM 浏览器/设备码登录一次（凭据直接进 Windows 凭据管理器）')
  } else {
    const login = await doLogin(api, 'github.com', '')
    out.push(login.ok ? '- ✅ 登录完成' : '- ❌ 登录失败')
    out.push('')
    out.push('```')
    out.push(login.text)
    out.push('```')
  }
  out.push('')

  // ── S3 验收 ───────────────────────────────────────────────────
  out.push('## S3 验收')
  const verifyUrl = url || cfg(api.config, 'heartbeatUrl', '')
  if (dryRun) {
    out.push(`- 计划：\`git ls-remote ${verifyUrl || '<url>'} HEAD\`（未提供 url 时用配置 heartbeatUrl）`)
  } else if (!verifyUrl) {
    out.push('- ⏭ 未提供 url 且未配置 heartbeatUrl，跳过端到端验收（这是「没查」，不是「通过」）')
  } else {
    const v = await toolVerify(api, { url: verifyUrl, targets: list.filter((t) => t === 'windows' || true), useProxy: true })
    out.push(v.results.every((r) => r.ok) ? '- ✅ 端到端通路可用' : '- ❌ 通路不通')
    out.push('')
    out.push('```')
    out.push(v.text)
    out.push('```')
  }
  out.push('')

  // ── S4 收尾（默认只提示） ──────────────────────────────────────
  out.push('## S4 收尾（清理明文 / 高危项）')
  const todo = []
  for (const target of list) {
    const cmd = target === 'windows'
      ? `$ErrorActionPreference='SilentlyContinue'
"gh hosts: " + $(if (Test-Path "$env:USERPROFILE\\.config\\gh\\hosts.yml") { 'present' } else { 'none' })
"git-credentials: " + $(if (Test-Path "$env:USERPROFILE\\.git-credentials") { 'present' } else { 'none' })`
      : `echo "gh hosts: $(if [ -f ~/.config/gh/hosts.yml ]; then echo present; else echo none; fi)"
echo "git-credentials: $(if [ -f ~/.git-credentials ]; then echo present; else echo none; fi)"`
    const r = await runOn(target, cmd, { timeoutMs: api.probeTimeout() })
    const body = (r.stdout || '').trim()
    if (/present/.test(body)) {
      todo.push(target)
      out.push(`- ${target}：⚠️ 存在明文凭据\n\`\`\`\n${redact(body)}\n\`\`\``)
    } else {
      out.push(`- ${target}：✅ 无明文凭据`)
    }
  }

  if (todo.length && cleanPlaintext && !dryRun) {
    for (const target of todo) {
      if (target === 'windows') {
        out.push(`- windows：跳过（不在插件里删用户家目录文件，请手动确认后删除）`)
        continue
      }
      const r = await runOn(target,
        'command -v gh >/dev/null 2>&1 && gh auth logout --hostname github.com 2>&1 | head -3 || echo "gh not installed"; rm -f ~/.git-credentials 2>/dev/null; echo done',
        { timeoutMs: api.probeTimeout() })
      out.push(`- ${target}：${r.ok ? '✅ 已登出 gh 并清理 ~/.git-credentials' : `⚠️ [${r.code}] ${redact(r.stderr)}`}`)
    }
    out.push('')
    out.push('> 清理后请再跑一次 `gitok_verify`，确认该端点仍借得到 Windows 凭据。')
  } else if (todo.length) {
    out.push('')
    out.push('> 确认 helper 已接管且 `gitok_verify` 通过后，带 `cleanPlaintext: true` 重跑本工具，')
    out.push('> 或在各端点手动 `gh auth logout`。**顺序不能反**：先接管、验证通过、再删明文。')
  }

  out.push('')
  out.push('---')
  out.push('> 凭据在 Windows 凭据管理器（DPAPI，绑用户+本机）。**换机器必须重新登录一次**，这是设计特性。')
  return out.join('\n')
}

/** 六项持续监控的显式入口（可选跑端到端心跳）。 */
async function toolMonitor(api, args) {
  const url = args?.url ? String(args.url).trim() : cfg(api.config, 'heartbeatUrl', '')
  const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : await api.resolveTargets()
  const text = await runDoctor(api, list)

  // 心跳（监控项 a）
  let heartbeat
  if (url) {
    const v = await toolVerify(api, { url, targets: list, useProxy: true })
    const okAll = v.results.every((r) => r.ok)
    heartbeat = {
      level: okAll ? 'ok' : 'error',
      detail: okAll ? `全部端点通路正常（${url}）` : `有端点不通（${url}）`,
    }
  }

  // 代理可达（监控项 f 的一部分）
  const p = api.proxy()
  let proxyReachable
  if (p) {
    const m = /^(?:https?:\/\/)?([^:/]+):(\d+)/.exec(p)
    if (m) proxyReachable = await probeTcp(m[1], Number(m[2]))
  }

  const st = parseStatus(text, api.gcm(), { heartbeat, proxyReachable })
  const lines = [`# 监控（${st.level}：${st.summary}）`, '']
  lines.push('| 项 | 状态 | 说明 |')
  lines.push('|---|---|---|')
  for (const c of st.checks) {
    const mark = c.level === 'ok' ? '✅' : c.level === 'warn' ? '⚠️' : c.level === 'error' ? '❌' : '❔'
    lines.push(`| ${c.label} | ${mark} ${c.level} | ${c.detail} |`)
  }
  lines.push('')
  lines.push('---')
  lines.push('## 原始体检')
  lines.push('')
  lines.push(text)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const register = (definition, label) =>
    ctx.effect(() => ctx.tools.register(definition), `gitok: ${label}`)

  const rawTargets = () => {
    const raw = cfg(config, 'targets', ['windows'])
    const list = Array.isArray(raw) ? raw : [raw]
    return list.map((x) => String(x)).filter(Boolean)
  }

  // targets 支持 'auto'：运行时展开为本机 Windows + 全部 WSL 发行版。
  // 默认仍是 ['windows']（ADR-006：留着默认端点 = 留着 adopt 误改 WSL 配置的机会）。
  let distroCache = { at: 0, list: [] }
  const resolveTargets = async () => {
    const raw = rawTargets()
    if (!raw.includes('auto')) return raw
    const now = Date.now()
    if (now - distroCache.at > 30000) {
      distroCache = { at: now, list: await listWslDistros() }
    }
    const fixed = raw.filter((t) => t !== 'auto')
    const merged = [...fixed, ...distroCache.list]
    return [...new Set(merged)]
  }

  const gcm = () => resolveGcm(config)
  const proxy = () => cfg(config, 'proxy', '')
  const probeTimeout = () => Number(cfg(config, 'probeTimeoutMs', 20000)) || 20000

  /**
   * 算出「git 实际会用的代理」及其来源，优先级与 git 自身一致：
   *   插件配置 proxy > git 全局 http.proxy > 系统代理 > 都没有
   *
   * 为什么不能只看插件配置：插件 proxy 默认为空（为了多机可移植），
   * 而 git 很可能自己配了 http.proxy。只看配置会误报「未配置」，
   * 让用户把网络问题误判成认证问题。
   */
  const effectiveProxy = async (sysText) => {
    const fromCfg = cfg(config, 'proxy', '')
    if (fromCfg) return { value: fromCfg, source: '插件配置' }

    const m = /https?:\/\/[^\s/]+/m.exec(sysText || '')
    if (m) return { value: m[0].trim(), source: 'git 全局 http.proxy' }

    const sys = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      '$s = (Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -ErrorAction SilentlyContinue).ProxyServer;' +
      'if ($s) { $s }'],
      { timeoutMs: 8000 })
    const sysProxy = (sys.stdout || '').trim()
    if (sysProxy) {
      // 系统代理可能是 "host:port" 或 "http=host:port;https=host:port"
      const hit = /(?:https?=)?([^;\s]+:\d+)/.exec(sysProxy)
      if (hit) return { value: hit[1], source: '系统代理' }
    }
    return { value: '', source: 'none' }
  }

  const api = { targets: rawTargets, resolveTargets, gcm, proxy, effectiveProxy, probeTimeout, config }

  // -------------------------------------------------------------------------
  // 1) gitok_doctor —— 只读体检
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_doctor',
    description:
      '只读体检 git 认证环境：逐个端点（Windows / 各 WSL 发行版）报告 git 版本、credential helper、凭据存储后端、' +
      '代理、SSH 私钥与 ssh-agent、SSH 私钥是否空口令、明文凭据文件、gh 登录状态。令牌只报类型与长度，绝不输出明文。' +
      '不会修改任何配置。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: '要体检的端点。留空用配置里的 targets；"windows" 表示本机，其余为 WSL 发行版名。',
        },
      },
    },
    output: textOutput(),
    timeoutMs: 180000,
    async execute(args) {
      return toolDoctor(api, args)
    },
  }, 'doctor')

  // -------------------------------------------------------------------------
  // 2) gitok_list —— 列出已存凭据（不含密钥）
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_list',
    description:
      '列出当前存了哪些 git 凭据：Windows 凭据管理器里的条目、GCM 已知账号、以及各 WSL 端点的凭据来源。' +
      '只显示 host / 用户名 / 存储位置，绝不显示密钥值。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targets: { type: 'array', items: { type: 'string' }, description: '要列的端点，留空用配置。' },
      },
    },
    output: textOutput(),
    timeoutMs: 120000,
    async execute(args) {
      return toolList(api, args)
    },
  }, 'list')

  // -------------------------------------------------------------------------
  // 3) gitok_verify —— 端到端验证
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_verify',
    description:
      '端到端验证 git 认证是否真的可用：对给定仓库 URL 在指定端点上跑 git ls-remote。' +
      '可选先用指定代理。不会泄露任何凭据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: '要验证的仓库 URL（https 形式）。' },
        targets: { type: 'array', items: { type: 'string' }, description: '在哪些端点上验证，留空用配置。' },
        useProxy: { type: 'boolean', description: '是否带上代理。默认 true（读配置或系统代理）。' },
      },
      required: ['url'],
    },
    output: textOutput(),
    timeoutMs: 180000,
    async execute(args) {
      return (await toolVerify(api, args)).text
    },
  }, 'verify')

  // -------------------------------------------------------------------------
  // 4) gitok_login —— 触发登录（密钥不经过本插件）
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_login',
    description:
      '为指定 host 触发 GCM 交互式登录（浏览器或设备码）。密钥由 GCM 直接写入 Windows 凭据管理器（DPAPI 加密），' +
      '本插件不接收、不接触、不保存任何 token。登录后建议接着跑 gitok_verify 确认。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: '要登录的 host，默认 github.com。' },
        username: { type: 'string', description: '可选：预填用户名（通常留空由 GCM 询问）。' },
      },
    },
    output: textOutput(),
    timeoutMs: 300000,
    async execute(args) {
      return toolLogin(api, args)
    },
  }, 'login')

  // -------------------------------------------------------------------------
  // 5) gitok_revoke —— 撤销（含影响面提示）
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_revoke',
    description:
      '撤销某 host 的 git 凭据：调用 GCM 的 erase（从 Windows 凭据管理器删除），可选同时清理 WSL 端点的 helper 配置。' +
      '不传 confirm 时**只列出影响面**（哪些仓库会失去认证）不执行删除。删除后该 host 的 git 操作会重新要求认证。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: '要撤销的 host，默认 github.com。' },
        path: { type: 'string', description: '可选：仅撤销某个仓库路径的凭据（需 useHttpPath=true 才有意义）。' },
        alsoWsl: { type: 'array', items: { type: 'string' }, description: '同时清理这些 WSL 端点的 helper 配置。' },
        confirm: { type: 'boolean', description: '必须显式传 true 才会执行删除。' },
      },
      required: ['confirm'],
    },
    output: textOutput(),
    timeoutMs: 180000,
    async execute(args) {
      return toolRevoke(api, args)
    },
  }, 'revoke')

  // -------------------------------------------------------------------------
  // 6) gitok_adopt —— 让端点借用 Windows GCM（核心：WSL 零密钥）
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_adopt',
    description:
      '把某个端点的 git credential helper 指向 Windows 的 GCM（WSL 经 /mnt/c 调用）。' +
      '执行后该端点不再自己保存任何密钥，全部借用 Windows 凭据管理器里那一份 DPAPI 密文 —— ' +
      '一处登录、一处撤销、密钥出机器不可用。会先备份原配置再修改。传 dryRun 可只预演不写入。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targets: { type: 'array', items: { type: 'string' }, description: '要接管的端点（WSL 发行版名），留空用配置里除 windows 外的全部。' },
        hosts: { type: 'array', items: { type: 'string' }, description: '为哪些 host 配置借用，默认 ["github.com"]。' },
        useHttpPath: { type: 'boolean', description: '是否按仓库路径区分凭据。默认读配置。' },
        dryRun: { type: 'boolean', description: '只预演、不写入任何配置。' },
      },
    },
    output: textOutput(),
    timeoutMs: 180000,
    async execute(args) {
      return toolAdopt(api, args)
    },
  }, 'adopt')

  // -------------------------------------------------------------------------
  // 7) gitok_bootstrap —— 一键初始化（S0~S4，可重入）
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_bootstrap',
    description:
      '一键初始化 git 认证，可重入（重复执行只会补缺失的部分）：S0 环境自检（GCM / 系统级+用户级 gitconfig / 代理 / WSL 发行版）' +
      '→ S1 幂等配置（只补缺失的 helper）→ S2 登录（已有凭据则跳过）→ S3 端到端验收 → S4 明文凭据收尾建议。' +
      '传 dryRun 可只预演。绝不接收 token，密钥全程只经 GCM。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'S3 验收用的仓库 URL。留空则用配置 heartbeatUrl；都没有就跳过（记为「没查」而不是「通过」）。' },
        targets: { type: 'array', items: { type: 'string' }, description: '要初始化的端点，留空用配置。' },
        dryRun: { type: 'boolean', description: '只预演，不写入任何配置、不触发登录。' },
        cleanPlaintext: { type: 'boolean', description: 'S4 是否真的执行清理（gh auth logout / 删 ~/.git-credentials）。必须确认接管已验证通过后再开。' },
      },
    },
    output: textOutput(),
    timeoutMs: 360000,
    async execute(args) {
      return toolBootstrap(api, args)
    },
  }, 'bootstrap')

  // -------------------------------------------------------------------------
  // 8) gitok_rotate —— 轮换（预检 → erase → login → verify）
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_rotate',
    description:
      '轮换某 host 的 git 凭据：先预检当前通路（断网时不会误删可用凭据），再备份 gitconfig、GCM erase、重新登录、端到端验收。' +
      '本插件不接收任何 token。注意：DPAPI 凭据 erase 后无法自动恢复，失败时只能重试登录。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string', description: '要轮换的 host，默认 github.com。' },
        url: { type: 'string', description: '预检与验收用。强烈建议传，否则无法判断轮换是否成功。' },
        username: { type: 'string', description: '可选：预填用户名。' },
        dryRun: { type: 'boolean', description: '只预演，只做预检、不删不登。' },
      },
    },
    output: textOutput(),
    timeoutMs: 360000,
    async execute(args) {
      return toolRotate(api, args)
    },
  }, 'rotate')

  // -------------------------------------------------------------------------
  // 9) gitok_monitor —— 六项持续监控的显式入口
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_monitor',
    description:
      '跑一次完整监控并给出 ok/warn/error/unknown 四态判定：端到端通路心跳、明文凭据、SSH 私钥口令、helper 叠加、' +
      '凭据条目、依赖与网络。未配置 heartbeatUrl 时心跳项记为 unknown（「没查」不等于「通过」）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: '心跳用的仓库 URL，留空用配置 heartbeatUrl。' },
        targets: { type: 'array', items: { type: 'string' }, description: '要检查的端点，留空用配置。' },
      },
    },
    output: textOutput(),
    timeoutMs: 240000,
    async execute(args) {
      return toolMonitor(api, args)
    },
  }, 'monitor')

  // -------------------------------------------------------------------------
  // 设置面板的数据通道
  //
  // 为什么需要它：Client 半边拿不到 Host 的工具与进程能力，
  // 而「当前 git 认证到底通不通」必须真跑一次探测。
  // 所以 Host 这边开路由，面板拉它画卡片。
  // 同 dsh-getbrain 的做法：路由挂在 webServer 的 prefix 下，与 /plugins/ 同源。
  //
  // 写路由（login / revoke / rotate / bootstrap）额外做三件事：
  //   1. 只接受 loopback 来源
  //   2. 只接受同源 Origin
  //   3. 只接受「意图」，请求体里没有任何 token 字段
  // -------------------------------------------------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    // 缓存 5 秒：面板一次渲染可能拉多次，别每次都起 pwsh 子进程。
    const cache = { at: 0, text: '', status: null }

    const build = async (force) => {
      const now = Date.now()
      if (!force && cache.status && now - cache.at < 5000) return cache.status

      // 心跳只在配置了 heartbeatUrl 时才跑（否则该项如实报 unknown）
      const hbUrl = cfg(config, 'heartbeatUrl', '')
      let heartbeat
      if (hbUrl) {
        const v = await toolVerify(api, { url: hbUrl, targets: await resolveTargets(), useProxy: true })
        const okAll = v.results.every((r) => r.ok)
        heartbeat = {
          level: okAll ? 'ok' : 'error',
          detail: okAll ? `通路正常（${hbUrl}）` : `有端点不通（${hbUrl}）`,
        }
      }

      const p = proxy()
      let proxyReachable
      if (p) {
        const m = /^(?:https?:\/\/)?([^:/]+):(\d+)/.exec(p)
        if (m) proxyReachable = await probeTcp(m[1], Number(m[2]))
      }

      const text = await runDoctor(api)
      const status = parseStatus(text, gcm(), { heartbeat, proxyReachable })
      cache.at = now
      cache.text = text
      cache.status = status
      return status
    }

    /**
     * 写路由守卫：只允许本机页面调用。
     *
     * 三道都要查，缺一不可：
     *   1. remoteAddress 是 loopback —— 挡外部直接连进来的请求
     *   2. Host 头是 loopback —— 挡 DNS rebinding（攻击者域名解析到 127.0.0.1）
     *   3. Origin（若有）是 loopback —— 挡「别的网站代用户浏览器发 POST」
     *
     * 只查第 1 条是不够的：用户浏览器里任何一个页面都能向 127.0.0.1 发 POST，
     * 那时 remoteAddress 就是 127.0.0.1。撤销凭据这种破坏性操作必须拦住。
     *
     * 注意 Host 比 Origin 更不能省：浏览器发跨站请求时可以不带 Origin，
     * 但 Host 一定带。
     */
    const isLoopbackHost = (h) => {
      if (!h) return false
      // 去掉端口。IPv6 字面量是 [::1]:port 形式，要单独处理。
      let hostname = String(h).trim().toLowerCase()
      if (hostname.startsWith('[')) {
        const close = hostname.indexOf(']')
        if (close > 0) hostname = hostname.slice(1, close)
      } else {
        const colon = hostname.lastIndexOf(':')
        if (colon > 0) hostname = hostname.slice(0, colon)
      }
      return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
    }

    const guard = (req, res) => {
      const deny = (why) => {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: why }))
        return false
      }

      const ra = req.socket?.remoteAddress || ''
      const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
      if (!local) return deny('forbidden: non-local origin')

      // Host 必须也是 loopback（防 DNS rebinding）
      if (!isLoopbackHost(req.headers?.host)) return deny('forbidden: non-loopback host')

      // Origin 存在时必须同源（防其他网站代发 POST）
      const origin = req.headers?.origin
      if (origin) {
        let oh = ''
        try { oh = new URL(origin).host } catch { return deny('forbidden: bad origin') }
        if (!isLoopbackHost(oh)) return deny('forbidden: cross-origin')
      }

      return true
    }

    const readBody = (req) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })

    const json = (res, code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload, null, 2))
    }

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/gitok/status',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const force = url.searchParams.get('refresh') === '1'
          const status = await build(force)
          json(res, 200, { ok: true, status, report: cache.text })
        } catch (err) {
          json(res, 500, { ok: false, error: String(err && err.message || err) })
        }
      },
    }), 'gitok: status route')

    // ── 受控写路由 ──────────────────────────────────────────────
    // 每个都只接受「意图」，并且在成功后让缓存失效，面板会自然重检。
    const writeRoutes = [
      {
        path: '/plugins/gitok/login',
        run: async (body) => toolLogin(api, { host: body.host, username: body.username }),
      },
      {
        path: '/plugins/gitok/revoke',
        // 破坏性操作：面板必须显式带 confirm: true。
        // 这里声明式声明，而不是写在 run 里返回提示字符串 ——
        // 否则未确认也会回 200，调用方无法区分「做成了」和「没做」。
        requiresConfirm: true,
        run: async (body) => toolRevoke(api, { host: body.host, confirm: true, alsoWsl: body.alsoWsl }),
      },
      {
        path: '/plugins/gitok/rotate',
        run: async (body) => toolRotate(api, { host: body.host, url: body.url, dryRun: body.dryRun === true }),
      },
      {
        path: '/plugins/gitok/bootstrap',
        run: async (body) => toolBootstrap(api, { url: body.url, dryRun: body.dryRun === true }),
      },
    ]

    for (const route of writeRoutes) {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
          try {
            const body = await readBody(req)
            // 防守：请求体里不允许出现任何疑似密钥字段（本插件从不接收 token）
            for (const k of Object.keys(body)) {
              if (/^(token|password|secret|pat)$/i.test(k)) {
                return json(res, 400, { ok: false, error: 'this plugin never accepts tokens' })
              }
            }
            // 破坏性路由必须先确认。未确认回 400，不用 200 —— 让调用方一定看得见。
            if (route.requiresConfirm && body.confirm !== true) {
              return json(res, 400, { ok: false, error: 'confirm: true required for this operation' })
            }
            const text = await route.run(body)
            cache.at = 0 // 让下一次 status 重新探测
            json(res, 200, { ok: true, text })
          } catch (err) {
            json(res, 500, { ok: false, error: String(err && err.message || err) })
          }
        },
      }), `gitok: ${route.path} route`)
    }

    // ── 周期巡检（默认关闭） ────────────────────────────────────
    // 只做本地只读检查 + 更新缓存；绝不自动 erase / login。
    // 不信任配置值：schema 已经限制过一次，但 cfg() 读的是裸配置，
    // 可能来自手改的 YAML 或旧版本同步。这里再夹一次，
    // 避免 setInterval 拿到负数或超过 2^31-1 的延时（后者会溢出成 1ms 高频空转）。
    const rawMin = Number(cfg(config, 'autoCheckMinutes', 0)) || 0
    const autoMin = Math.min(Math.max(rawMin, 0), 10080)
    if (autoMin > 0) {
      webCtx.effect(() => {
        const timer = setInterval(() => { build(true).catch(() => { /* 静默：巡检失败不打扰 */ }) }, autoMin * 60000)
        return () => clearInterval(timer)
      }, 'gitok: periodic check')
    }
  })
}
