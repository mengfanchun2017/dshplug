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
 * 安全铁律（本文件严格遵守）：
 *   - 绝不接收 token 参数，绝不写任何密钥到磁盘
 *   - 需要密钥进出的动作一律委托给 GCM 的 get/store/erase 子命令
 *   - 所有输出里出现 password 一律脱敏，只报「有没有、多长、什么前缀类型」
 *
 * @module @local/dsh-gitok
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
// ---------------------------------------------------------------------------

const ConfigShape = !z ? undefined : z.object({
  gcmPath: z.string().default('').description('Windows GCM 可执行文件绝对路径。留空自动探测 MinGit/Git for Windows 常见位置。').volatile(),
  targets: z.array(z.string()).default(['windows']).description('要管理的端点：windows 表示本机；其余字符串视为 WSL 发行版名。').volatile(),
  proxy: z.string().default('').description('git 走的 HTTP 代理。留空则从 Windows 系统代理读取。').volatile(),
  useHttpPath: z.boolean().default(false).description('是否按 host+仓库路径区分凭据。开启后同一 host 的不同仓库可各用各的认证。').volatile(),
  probeTimeoutMs: z.number().default(20000).description('每条探测命令的超时毫秒数。').volatile(),
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

/** Windows：git 版本、helper、store、代理、凭据条目。 */
function probeWindows() {
  // 关键：先强制 UTF-8 输出，否则 cmdkey 等外部程序在 OEM 码页下会把中文输出成乱码。
  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Continue'
"git:             " + ((git --version) -join '')
"exec-path:       " + ((git --exec-path) -join '')
"helper:          " + ((git config --show-origin --get-all credential.helper) -join ' | ')
"helper(scoped):  " + ((git config --global --get-regexp '^credential\\..*\\.helper$') -join ' | ')
"credentialStore: " + $(if (git config --get credential.credentialStore) { git config --get credential.credentialStore } else { '(default = wincredman)' })
"http.proxy:      " + $(if (git config --global --get http.proxy) { git config --global --get http.proxy } else { '(unset)' })
"env HTTPS_PROXY: " + $(if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { '(unset)' })
"sys proxy:       " + ((Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer)
"ssh keys:        " + $(if (Test-Path "$env:USERPROFILE\\.ssh\\id_*") { (Get-ChildItem "$env:USERPROFILE\\.ssh" -Filter 'id_*').Name -join ',' } else { 'none' })
"ssh-agent:       " + ((Get-Service ssh-agent -ErrorAction SilentlyContinue).Status)
"gh:              " + $(if (Get-Command gh -ErrorAction SilentlyContinue) { 'installed' } else { 'not installed' })
"---- windows credential manager: git entries ----"
(cmdkey /list) | Select-String 'git:' | ForEach-Object { $_.Line.Trim() }`
}

/** WSL：git 版本、helper、store、代理、SSH、gh 状态。 */
function probeWsl() {
  // 注意：WSL 上的 helper 大多按 URL 作用域存（credential.https://host.helper），
  // 直接 --get-all credential.helper 会什么都不返回。必须 --get-regexp 全扫。
  return `echo "git:             $(git --version 2>&1)"
echo "helper(scoped):  $(git config --global --get-regexp '^credential\\..*\\.helper$' 2>/dev/null | tr '\\n' '|')"
echo "helper(bare):    $(git config --global --get-all credential.helper 2>/dev/null | tr '\\n' '|')"
echo "credentialStore: $(git config --get credential.credentialStore 2>/dev/null || echo '(unset)')"
echo "http.proxy:      $(git config --global --get http.proxy 2>/dev/null || echo '(unset)')"
echo "env HTTPS_PROXY: \${HTTPS_PROXY:-(unset)}"
echo "ssh keys:        $(ls ~/.ssh/id_* 2>/dev/null | xargs -r -n1 basename | tr '\\n' ',' || true)$(ls ~/.ssh/id_* >/dev/null 2>&1 || echo none)"
echo "ssh-agent:       \${SSH_AUTH_SOCK:-(unset)}"
echo "plaintext creds: $(ls ~/.git-credentials 2>/dev/null || echo none)"
echo "gh hosts file:   $(stat -c '%a' ~/.config/gh/hosts.yml 2>/dev/null || echo none)"
echo "gh status:       $(command -v gh >/dev/null 2>&1 && (gh auth status 2>&1 | head -4 | tr '\\n' '|') || echo 'not installed')"`
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const register = (definition, label) =>
    ctx.effect(() => ctx.tools.register(definition), `gitok: ${label}`)

  const targets = () => {
    const raw = cfg(config, 'targets', ['windows'])
    const list = Array.isArray(raw) ? raw : [raw]
    return list.map((x) => String(x)).filter(Boolean)
  }
  const gcm = () => resolveGcm(config)
  const proxy = () => cfg(config, 'proxy', '')
  const probeTimeout = () => Number(cfg(config, 'probeTimeoutMs', 20000)) || 20000

  // -------------------------------------------------------------------------
  // 1) gitok_doctor —— 只读体检
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_doctor',
    description:
      '只读体检 git 认证环境：逐个端点（Windows / 各 WSL 发行版）报告 git 版本、credential helper、凭据存储后端、' +
      '代理、SSH 私钥与 ssh-agent、明文凭据文件、gh 登录状态。令牌只报类型与长度，绝不输出明文。' +
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
      const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : targets()
      const g = gcm()
      const lines = []

      lines.push('# git 认证体检')
      lines.push('')
      lines.push(`- GCM 路径：${g || '❌ 未找到（请设置 gcmPath）'}`)
      if (g) {
        const ver = await exec(g, ['--version'], { timeoutMs: probeTimeout() })
        lines.push(`- GCM 版本：${(ver.stdout || ver.stderr || '').trim() || '(未知)'}`)
      }
      lines.push('')

      for (const target of list) {
        lines.push(`## 端点：${target}`)
        const cmd = target === 'windows' ? probeWindows() : probeWsl()
        const r = await runOn(target, cmd, { timeoutMs: probeTimeout() })
        const body = redact((r.stdout || '').trim())
        if (r.code === 'TIMEOUT') {
          lines.push(`> ⏱ 超时（${probeTimeout()}ms），该端点可能未启动或 WSL 未运行。`)
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
      lines.push('- `plaintext creds` 或 `~/.config/gh/hosts.yml` 有值 → 明文落盘，违背「不落明文」。')
      lines.push('- `env HTTPS_PROXY` 为空但需要代理 → git 直连会超时（本机 Windows 侧当前就是这种情况）。')
      lines.push('- `ssh keys` 有 `id_*` 时，请另外确认是否设了口令：`ssh-keygen -y -P "" -f <key>` 能成功即为空口令。')
      return lines.join('\n')
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
      const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : targets()
      const g = gcm()
      const lines = ['# 已存 git 凭据', '']

      lines.push('## Windows 凭据管理器')
      const cmdkey = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (cmdkey /list) | Select-String "git:" | ForEach-Object { $_.Line.Trim() }'],
        { timeoutMs: probeTimeout() })
      lines.push(cmdkey.stdout.trim() ? '```\n' + redact(cmdkey.stdout.trim()) + '\n```' : '_(没有 git: 开头的条目)_')

      if (g) {
        lines.push('')
        lines.push('## GCM 已知账号')
        const accts = await exec(g, ['github', 'list'], { timeoutMs: probeTimeout() })
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
          { timeoutMs: probeTimeout() })
        lines.push(r.stdout.trim() ? '```\n' + redact(r.stdout.trim()) + '\n```' : `_(无输出: ${r.code})_`)
      }


      lines.push('')
      lines.push('> 删除方式见 `gitok_revoke`。')
      return lines.join('\n')
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
      const url = String(args?.url ?? '').trim()
      if (!url) return '❌ 必须提供 url'
      const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : targets()
      const useProxy = args?.useProxy !== false
      const p = proxy()
      const lines = [`# 验证 ${url}`, '']

      for (const target of list) {
        let cmd
        if (target === 'windows') {
          const proxyArg = useProxy && p ? ` -c http.proxy=${p}` : ''
          cmd = `git${proxyArg} ls-remote ${url} HEAD`
        } else {
          const proxyArg = useProxy && p ? ` -c http.proxy=${p}` : ''
          // WSL 里 127.0.0.1 在 mirrored 网络模式下可直通 Windows 代理；
          // 若不通，env HTTPS_PROXY 通常已由 autoProxy 注入，无需额外处理。
          cmd = `git${proxyArg} ls-remote ${url} HEAD`
        }
        const r = await runOn(target, cmd, { timeoutMs: probeTimeout() })
        const okMark = r.ok ? '✅' : '❌'
        lines.push(`- ${okMark} **${target}** [${r.code}]`)
        const out = redact((r.stdout || '').trim())
        const err = redact((r.stderr || '').trim())
        if (out) lines.push('  ```\n  ' + out.split('\n').join('\n  ') + '\n  ```')
        if (err) lines.push('  ```\n  ' + err.split('\n').join('\n  ') + '\n  ```')
      }

      lines.push('')
      lines.push('> 全 ✅ = 该端点的 git 认证通路完整（凭据 + 网络）。')
      lines.push('> 若 `Failed to connect` = 网络/代理问题，不是认证问题。')
      return lines.join('\n')
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
      const host = String(args?.host ?? 'github.com').trim() || 'github.com'
      const username = args?.username ? String(args.username) : ''
      const g = gcm()
      if (!g) return '❌ 未找到 git-credential-manager，请先在设置里配置 gcmPath。'

      // 用 GCM 的 get 触发一次交互：仓库没凭据时它会弹浏览器/设备码。
      // 我们只关心「它是否成功返回」，绝不读取或输出 password 值。
      const input = `protocol=https\nhost=${host}\n${username ? `username=${username}\n` : ''}\n`
      const r = await exec(g, ['get'], { timeoutMs: 300000, input })

      const lines = [`# 登录 ${host}`, '']
      if (r.ok) {
        // 只解析 username，password 一律丢弃
        const userLine = (r.stdout || '').split(/\r?\n/).find((l) => /^username=/.test(l))
        const pwLine = (r.stdout || '').split(/\r?\n/).find((l) => /^password=/.test(l))
        lines.push(`- ✅ GCM 返回了可用凭据`)
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
      return lines.join('\n')
    },
  }, 'login')

  // -------------------------------------------------------------------------
  // 5) gitok_revoke —— 撤销
  // -------------------------------------------------------------------------
  register({
    name: 'gitok_revoke',
    description:
      '撤销某 host 的 git 凭据：调用 GCM 的 erase（从 Windows 凭据管理器删除），可选同时清理 WSL 端点的 helper 配置。' +
      '这是「随时删除」的入口。删除后该 host 的 git 操作会重新要求认证。',
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
    timeoutMs: 120000,
    async execute(args) {
      if (args?.confirm !== true) {
        return '⚠️ 这是删除操作，需要显式传 `confirm: true` 才会执行。\n\n将删除的凭据：host=' +
          String(args?.host ?? 'github.com') + '。'
      }
      const host = String(args?.host ?? 'github.com').trim() || 'github.com'
      const repoPath = args?.path ? String(args.path) : ''
      const g = gcm()
      if (!g) return '❌ 未找到 git-credential-manager。'

      const input = `protocol=https\nhost=${host}\n${repoPath ? `path=${repoPath}\n` : ''}\n`
      const r = await exec(g, ['erase'], { timeoutMs: probeTimeout(), input })
      const lines = [`# 撤销 ${host}${repoPath ? '/' + repoPath : ''}`, '']
      lines.push(r.ok ? '- ✅ GCM erase 成功（Windows 凭据管理器条目已删除）' : `- ❌ erase 失败 [${r.code}]：${redact(r.stderr)}`)
      if (r.stderr) lines.push('```\n' + redact(r.stderr) + '\n```')

      const wsls = Array.isArray(args?.alsoWsl) ? args.alsoWsl.map(String) : []
      for (const t of wsls) {
        lines.push('')
        lines.push(`## 清理 WSL 端点：${t}`)
        const cmd = `git config --global --unset-all "credential.https://${host}.helper" 2>/dev/null; echo "unset done"`
        const w = await runOn(t, cmd, { timeoutMs: probeTimeout() })
        lines.push(w.ok ? '- ✅ 已移除该 host 的 helper 配置' : `- ⚠️ [${w.code}] ${redact(w.stderr)}`)
      }

      lines.push('')
      lines.push('> 建议再跑 `gitok_list` 确认条目已消失。')
      return lines.join('\n')
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
      '一处登录、一处撤销、密钥出机器不可用。会先备份原配置再修改。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targets: { type: 'array', items: { type: 'string' }, description: '要接管的端点（WSL 发行版名），留空用配置里除 windows 外的全部。' },
        hosts: { type: 'array', items: { type: 'string' }, description: '为哪些 host 配置借用，默认 ["github.com"]。' },
        useHttpPath: { type: 'boolean', description: '是否按仓库路径区分凭据。默认读配置。' },
      },
    },
    output: textOutput(),
    timeoutMs: 180000,
    async execute(args) {
      const g = gcm()
      if (!g) return '❌ 未找到 git-credential-manager，无法接管。'
      const gWsl = toWslPath(g)

      const allTargets = targets().filter((t) => t !== 'windows')
      const list = Array.isArray(args?.targets) && args.targets.length ? args.targets.map(String) : allTargets
      const hosts = Array.isArray(args?.hosts) && args.hosts.length ? args.hosts.map(String) : ['github.com']
      const uhp = args?.useHttpPath !== undefined ? Boolean(args.useHttpPath) : Boolean(cfg(config, 'useHttpPath', false))

      const lines = ['# 接管 git 认证', '', `- Windows GCM：\`${g}\``, `- WSL 路径：\`${gWsl}\``, '']

      for (const target of list) {
        lines.push(`## 端点：${target}`)
        // 先确认 WSL 侧能看到这个 exe
        const probe = await runOn(target, `test -x ${JSON.stringify(gWsl)} && echo OK || echo MISSING`, { timeoutMs: probeTimeout() })
        if (!probe.stdout.includes('OK')) {
          lines.push(`- ❌ 该端点访问不到 \`${gWsl}\`（interop 关闭或路径不对），跳过。`)
          lines.push('')
          continue
        }

        // 备份
        const backup = await runOn(target,
          `cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S) 2>/dev/null && echo backed-up || echo no-file`,
          { timeoutMs: probeTimeout() })
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
        const w = await runOn(target, cmds.join('; '), { timeoutMs: probeTimeout() })
        lines.push(w.ok ? '- ✅ helper 已指向 Windows GCM' : `- ❌ 写入失败 [${w.code}]：${redact(w.stderr)}`)

        // 复查：应当只剩一条 GCM
        const chk = await runOn(target, `git config --global --get-all "credential.https://${hosts[0]}.helper"`, { timeoutMs: probeTimeout() })
        const got = chk.stdout.trim()
        lines.push(`- 复查 helper：\`${redact(got) || '(空)'}\``)
        if (got && !got.includes(gWsl)) lines.push('  ⚠️ 未生效，请检查 git 版本是否支持 `--unset-all`。')
        if (got.split('\n').filter(Boolean).length > 1) lines.push('  ⚠️ 仍有多条 helper 叠加，请手动清理。')
        lines.push('')
      }

      lines.push('---')
      lines.push('下一步：跑 `gitok_verify` 确认端到端可用；确认无误后再考虑 `gh auth logout` 清掉明文 PAT。')
      return lines.join('\n')
    },
  }, 'adopt')
}
