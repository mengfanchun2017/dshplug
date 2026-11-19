/**
 * dsh-larkcli · 服务层（起进程、缓存、账户准备）
 *
 * 这一层负责「真的把 lark-cli 跑起来」，但仍然不依赖任何 Host 服务，
 * 只是普通 Node：spawn + 文件读写。index.js 只做工具接线，方便单测与复用。
 *
 * 三个刻意的设计：
 *   1) 不走 PowerShell。lark.ps1 是给人手用的；工具层直接 spawn exe，
 *      省掉 ~200-400ms 的 pwsh 启动，这才是「快速调用」。
 *   2) 不用管道捕获输出。用「重定向到临时文件再读」：
 *      Windows 沙箱里 Node 开命名管道会被拒（EPERM），而文件描述符重定向可以；
 *      真实 Host 进程两者都行。一套代码两边都对。
 *   3) 每次调用前同步该账户的 config.json。凭据绝对路径由**本机**现算，
 *      所以仓库搬到任何目录、换任何机器都不会再断（这正是迁移踩的坑）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AccountsStore,
  accountPaths,
  cleanStderr,
  ensureDir,
  parseCliOutput,
  readJson,
  redactDeep,
  syncCliConfig,
  toPosix,
} from './core.js'

export const CLI_REL = path.join('lark-cli-win', 'lark-cli.exe')

/** 找不到 exe 时的提示：给可执行的下一步，而不是一句「失败」。 */
export class CliMissingError extends Error {
  constructor(exePath) {
    super(
      `找不到 lark-cli.exe：${exePath}\n` +
        '修复：在插件目录跑一次  .\\scripts\\fetch-lark-cli.ps1  （官方 SHA256 校验后自动补齐）',
    )
    this.name = 'CliMissingError'
  }
}

export class LarkService {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir      数据目录（仓库外）
   * @param {string} opts.pluginDir    插件目录（找 exe 与旧凭据）
   * @param {string} [opts.binaryPath] 手动指定 exe
   * @param {number} [opts.timeoutMs]  默认超时
   * @param {number} [opts.statusTtlMs] status 缓存时长
   * @param {number} [opts.schemaTtlMs] schema 索引缓存时长
   */
  constructor(opts) {
    this.dataDir = opts.dataDir
    this.pluginDir = opts.pluginDir
    this.binaryPath = opts.binaryPath || ''
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000
    this.statusTtlMs = Number(opts.statusTtlMs) > 0 ? Number(opts.statusTtlMs) : 60000
    this.schemaTtlMs = Number(opts.schemaTtlMs) > 0 ? Number(opts.schemaTtlMs) : 6 * 3600 * 1000
    this.store = new AccountsStore(this.dataDir)
    this.cache = { status: new Map(), schema: { at: 0, list: null } }
  }

  // -- 路径 ---------------------------------------------------------------

  exePath() {
    const p = this.binaryPath ? this.binaryPath : path.join(this.pluginDir, CLI_REL)
    return p
  }

  hasBinary() {
    try {
      return fs.statSync(this.exePath()).isFile()
    } catch {
      return false
    }
  }

  ensureBinary() {
    const p = this.exePath()
    if (!this.hasBinary()) throw new CliMissingError(p)
    return p
  }

  /** 数据目录布局（不含密钥值）。 */
  layout() {
    return {
      dataDir: this.dataDir,
      accountsFile: path.join(this.dataDir, 'accounts.json'),
      accountsDir: path.join(this.dataDir, 'accounts'),
      binary: this.exePath(),
      binaryExists: this.hasBinary(),
      legacyDir: path.join(this.pluginDir, 'lark-cli-win', '_native-config'),
    }
  }

  // -- 账户 ---------------------------------------------------------------

  /** 解析要用的账户：显式 id > 默认账户。返回 null 表示一个都没配。 */
  resolveAccount(id) {
    if (id) {
      const acc = this.store.get(String(id))
      if (!acc) throw new Error(`账户不存在：${id}（用 lark_account_search 或 lark_account_upsert 管理）`)
      return acc
    }
    const def = this.store.defaultId()
    if (!def) return null
    return this.store.get(def) ?? null
  }

  /**
   * 保证账户目录里有一份「本机正确」的 secret + config.json。
   * secret 只从数据目录读；不复制、不回显。
   */
  prepareAccount(account) {
    const ap = accountPaths(this.dataDir, account.id)
    ensureDir(ap.dir)
    if (!fs.existsSync(ap.secretFile)) {
      throw new Error(
        `账户 ${account.id} 缺少 appsecret.txt：${ap.secretFile}\n` +
          '用 lark_account_upsert 传 appSecret 写入（值不会回显），或手动放置该文件。',
      )
    }
    const secret = fs.readFileSync(ap.secretFile, 'utf8').trim()
    if (!secret) throw new Error(`账户 ${account.id} 的 appsecret.txt 是空的：${ap.secretFile}`)
    const { changed } = syncCliConfig(account, ap.secretFile)
    return { ...ap, configChanged: changed }
  }

  /**
   * 写入某账户的 secret。这是唯一接收密钥的入口，且**永不回显**。
   * 调用方（工具）负责要求用户显式提供；插件侧不写日志、不缓存。
   */
  writeSecret(id, secret) {
    const s = String(secret ?? '').trim()
    if (!s) throw new Error('appSecret 为空')
    const ap = accountPaths(this.dataDir, id)
    ensureDir(ap.dir)
    // 先落盘再收紧权限（Windows ACL 收紧需要 icacls，这里只做「至少不是全用户可读」的尽力而为）
    fs.writeFileSync(ap.secretFile, s, { encoding: 'utf8', mode: 0o600 })
    const account = this.store.get(id)
    if (account) syncCliConfig(account, ap.secretFile)
    return { file: ap.secretFile, bytes: Buffer.byteLength(s) }
  }

  hasSecret(id) {
    try {
      const ap = accountPaths(this.dataDir, id)
      return fs.readFileSync(ap.secretFile, 'utf8').trim().length > 0
    } catch {
      return false
    }
  }

  // -- 执行 ---------------------------------------------------------------

  /**
   * 跑一条 lark-cli 命令。
   *
   * @param {string[]} args   参数数组（调用方负责切片，绝不拼成一整行再交给 shell）
   * @param {object}   opts
   * @param {string}  [opts.accountId]
   * @param {number}  [opts.timeoutMs]
   * @returns {Promise<{ok:boolean, exitCode:number, ...}>}
   */
  async run(args, opts = {}) {
    const exe = this.ensureBinary()
    const account = this.resolveAccount(opts.accountId)
    if (!account) {
      throw new Error(
        '还没有任何飞书账户。先做一次：lark_account_upsert（id/appId/描述/标签）→ lark_account_set_secret → lark_login_start。',
      )
    }
    const ap = this.prepareAccount(account)
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.timeoutMs

    const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const outFile = path.join(os.tmpdir(), `lark-${tag}.out`)
    const errFile = path.join(os.tmpdir(), `lark-${tag}.err`)
    let outFd
    let errFd
    try {
      outFd = fs.openSync(outFile, 'w')
      errFd = fs.openSync(errFile, 'w')
    } catch (e) {
      throw new Error(`无法创建临时输出文件：${e.message}`)
    }

    const env = {
      ...process.env,
      LARKSUITE_CLI_CONFIG_DIR: ap.dir,
      // 关掉「自动升级提示」等交互性输出；CLI 尊重非交互环境
      LARKSUITE_CLI_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    }

    const result = await new Promise((resolve) => {
      let child
      let timer
      const done = (payload) => {
        if (timer) clearTimeout(timer)
        resolve(payload)
      }
      try {
        child = spawn(exe, args, {
          env,
          cwd: ap.dir,
          windowsHide: true,
          stdio: ['ignore', outFd, errFd],
        })
      } catch (e) {
        return done({ spawnError: e, exitCode: -1 })
      }
      timer =
        timeoutMs > 0
          ? setTimeout(() => {
              try {
                child.kill('SIGKILL')
              } catch {
                /* already gone */
              }
              done({ timeout: true, exitCode: -1 })
            }, timeoutMs)
          : null
      child.on('error', (e) => done({ spawnError: e, exitCode: -1 }))
      child.on('close', (code) => done({ exitCode: code ?? -1 }))
    })

    try {
      fs.closeSync(outFd)
      fs.closeSync(errFd)
    } catch {
      /* ignore */
    }

    let stdout = ''
    let stderr = ''
    try {
      stdout = fs.readFileSync(outFile, 'utf8')
    } catch {
      /* ignore */
    }
    try {
      stderr = fs.readFileSync(errFile, 'utf8')
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outFile)
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(errFile)
    } catch {
      /* ignore */
    }

    // DPoP 的 key 锁警告在 Windows 上必然出现，与功能无关，不算失败
    const stderrClean = cleanStderr(stderr)
    const meta = {
      account: account.id,
      label: account.label,
      exe,
      configDir: ap.dir,
      durationMs: Number(timeoutMs),
      command: `lark-cli ${args.join(' ')}`,
    }

    if (result.spawnError) {
      return { ok: false, exitCode: -1, kind: 'spawn-failed', error: { type: 'spawn', message: String(result.spawnError.message || result.spawnError) }, stdout, stderr: stderrClean, meta }
    }
    if (result.timeout) {
      return { ok: false, exitCode: -1, kind: 'timeout', error: { type: 'timeout', message: `超过 ${timeoutMs}ms 未完成（可用 timeoutMs 调整；分页用 --page-limit）` }, stdout, stderr: stderrClean, meta }
    }

    const parsed = parseCliOutput({ stdout, stderr: stderrClean, exitCode: result.exitCode })
    return { ...parsed, stderr: stderrClean, meta }
  }

  // -- 常用查询 -----------------------------------------------------------

  /** auth status：brief 模式只留关键字段，full 模式给全部。带 TTL 缓存。 */
  async status({ account, detail = 'brief', refresh = false } = {}) {
    const acc = account ? this.resolveAccount(account) : this.resolveAccount()
    if (!acc) return { ok: false, error: '尚未配置任何账户', accounts: [] }
    const key = acc.id
    const c = this.cache.status.get(key)
    const now = Date.now()
    const ttl = Number(this.statusTtlMs)
    const useCache = !refresh && c && ttl > 0 && now - c.at < ttl
    if (useCache) {
      return this.composeStatus(c.value, detail, true, now - c.at)
    }
    const r = await this.run(['auth', 'status'], { accountId: acc.id, timeoutMs: 30000 })
    const identities = r.json?.identities || {}
    const value = {
      ok: r.ok,
      account: acc.id,
      label: acc.label,
      appId: r.json?.appId || acc.appId,
      brand: r.json?.brand || acc.brand,
      dpopMode: r.json?.dpopMode,
      credentialSource: r.json?.credentialSource,
      identities: {
        bot: { available: !!identities.bot?.available, status: identities.bot?.status, message: identities.bot?.message },
        user: {
          available: !!identities.user?.available,
          status: identities.user?.status,
          message: identities.user?.message,
          hint: identities.user?.hint,
        },
      },
      note: r.json?.note,
      raw: r.json,
      error: r.ok ? undefined : r.error,
      binary: { path: this.exePath(), version: this.versionCache || undefined },
    }
    this.cache.status.set(key, { at: now, value })
    return this.composeStatus(value, detail, false, 0)
  }

  /**
   * 把缓存的公共部分按请求的 detail 级别拼成返回值。
   * 关键：detail 只在这里决定，不进缓存 —— 否则 brief/full 会互相污染。
   * ttl=0（配置为 0，即不缓存）时也必须走完整探测，不能当成「永不过期」。
   */
  composeStatus(value, detail, cached, ageMs) {
    const out = { ...value }
    if (detail === 'full') out.detail = redactDeep(value.raw)
    delete out.raw
    if (cached) {
      out.cached = true
      out.ageMs = ageMs
    }
    return out
  }

  invalidateStatus(accountId) {
    if (accountId) this.cache.status.delete(accountId)
    else this.cache.status.clear()
  }

  /** exe 版本（一次进程，缓存）。 */
  async version() {
    if (this.versionCache) return this.versionCache
    try {
      const r = await this.runRaw(['--version'])
      const m = /version\s+([0-9][^\s]*)/i.exec(r || '')
      this.versionCache = m ? m[1] : (r || '').trim()
    } catch {
      this.versionCache = 'unknown'
    }
    return this.versionCache
  }

  /** 不准备账户、不注入配置的裸执行（只用于 --version 这类）。 */
  async runRaw(args, timeoutMs = 15000) {
    const exe = this.ensureBinary()
    const tag = `${process.pid}-${Date.now()}-r`
    const outFile = path.join(os.tmpdir(), `lark-${tag}.out`)
    const errFile = path.join(os.tmpdir(), `lark-${tag}.err`)
    const outFd = fs.openSync(outFile, 'w')
    const errFd = fs.openSync(errFile, 'w')
    await new Promise((resolve) => {
      let child
      let timer
      const done = () => {
        if (timer) clearTimeout(timer)
        resolve()
      }
      try {
        child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', outFd, errFd], env: { ...process.env, NO_COLOR: '1' } })
      } catch {
        return done()
      }
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        done()
      }, timeoutMs)
      child.on('error', done)
      child.on('close', done)
    })
    try {
      fs.closeSync(outFd)
      fs.closeSync(errFd)
    } catch {
      /* ignore */
    }
    let out = ''
    try {
      out = fs.readFileSync(outFile, 'utf8') + fs.readFileSync(errFile, 'utf8')
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outFile)
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(errFile)
    } catch {
      /* ignore */
    }
    return out
  }

  /**
   * schema 全量索引。1.5 MB 的 JSON 只在本地缓存里，绝不进上下文。
   * 落盘到数据目录，重启后仍可用（省一次 ~1s 的进程）。
   */
  async schemaList({ refresh = false } = {}) {
    const now = Date.now()
    if (!refresh && this.cache.schema.list && now - this.cache.schema.at < this.schemaTtlMs) {
      return { list: this.cache.schema.list, cached: true }
    }
    const cacheFile = path.join(this.dataDir, 'cache', 'schema.json')
    if (!refresh) {
      const disk = readJson(cacheFile, null)
      if (disk && Array.isArray(disk.methods) && now - Number(disk.at || 0) < this.schemaTtlMs) {
        this.cache.schema = { at: Number(disk.at), list: disk.methods }
        return { list: disk.methods, cached: true }
      }
    }
    const r = await this.run(['schema'], { timeoutMs: 60000 })
    if (!r.ok || !Array.isArray(r.json)) {
      throw new Error(`拉取 schema 失败：${r.error?.message || r.stderr || '未知原因'}`)
    }
    this.cache.schema = { at: now, list: r.json }
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ at: now, methods: r.json }), 'utf8')
    } catch {
      /* 缓存写不进去不影响功能 */
    }
    return { list: r.json, cached: false }
  }

  /** 单方法详情（约 2 KB），按需查。 */
  async schemaOne(method) {
    const r = await this.run(['schema', String(method)], { timeoutMs: 30000 })
    if (!r.ok) throw new Error(`查询 ${method} 失败：${r.error?.message || r.stderr || '未知原因'}`)
    return r.json
  }

  /** 某个域的 --help（含 +快捷键、风险等级）。 */
  async domainHelp(domain) {
    const r = await this.run([String(domain), '--help'], { timeoutMs: 30000 })
    return { ok: r.ok, text: r.raw || r.stderr, exitCode: r.exitCode }
  }

  // -- 登录（设备流） -----------------------------------------------------

  /**
   * 发起设备流授权，返回 verification_url。
   *
   * device_code 是**凭据**（10 分钟内可直接换取授权），所以存到数据目录，
   * 只在返回值里给出「长度/是否有」，绝不回显；后续用 lark_login_finish 按账户取回。
   */
  async loginStart({ account, domains, scope, recommend = true } = {}) {
    const acc = this.resolveAccount(account)
    if (!acc) throw new Error('尚未配置账户，先 lark_account_upsert')
    const args = ['auth', 'login', '--no-wait', '--json']
    if (scope) args.push('--scope', String(scope))
    else if (domains && (Array.isArray(domains) ? domains.length : String(domains))) {
      args.push('--domain', Array.isArray(domains) ? domains.join(',') : String(domains))
    } else if (recommend) args.push('--recommend')

    const r = await this.run(args, { accountId: acc.id, timeoutMs: 45000 })
    const j = r.json
    if (!r.ok || !j?.verification_url) {
      throw new Error(`发起授权失败：${r.error?.message || r.stderr || '未返回 verification_url'}`)
    }
    const ap = accountPaths(this.dataDir, acc.id)
    const pendingFile = path.join(ap.dir, 'login-pending.json')
    const pending = {
      deviceCode: j.device_code,
      verificationUrl: j.verification_url,
      expiresIn: j.expires_in,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (Number(j.expires_in) || 600) * 1000).toISOString(),
      scopes: scope || domains || 'recommend',
    }
    fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2), { encoding: 'utf8', mode: 0o600 })
    return {
      account: acc.id,
      verificationUrl: j.verification_url,
      expiresIn: j.expires_in,
      deviceCodeStored: true,
      deviceCodeLength: String(j.device_code || '').length,
      hint: j.hint,
      pendingFile,
    }
  }

  /** 用已保存的 device_code 完成授权。 */
  async loginFinish({ account, deviceCode } = {}) {
    const acc = this.resolveAccount(account)
    if (!acc) throw new Error('尚未配置账户')
    const ap = accountPaths(this.dataDir, acc.id)
    const pendingFile = path.join(ap.dir, 'login-pending.json')
    const pending = readJson(pendingFile, null)
    const code = String(deviceCode || pending?.deviceCode || '').trim()
    if (!code) {
      throw new Error(
        '没有可用的 device_code：先调 lark_login_start 拿授权链接，或在用户确认授权后用 deviceCode 参数传入。',
      )
    }
    const r = await this.run(['auth', 'login', '--device-code', code], { accountId: acc.id, timeoutMs: 180000 })
    if (r.ok) {
      try {
        fs.unlinkSync(pendingFile)
      } catch {
        /* ignore */
      }
      this.invalidateStatus(acc.id)
    }
    return {
      ok: r.ok,
      account: acc.id,
      identity: r.identity,
      message: r.ok ? '授权完成，user 身份应已可用' : r.error?.message || r.stderr,
      hint: r.error?.hint,
    }
  }

  /** 生成二维码 PNG（CLI 要求输出路径在 cwd/tmp/~/files 内，所以写进账户目录）。 */
  async loginQrcode({ account, url, ascii = false } = {}) {
    const acc = this.resolveAccount(account)
    if (!acc) throw new Error('尚未配置账户')
    const ap = accountPaths(this.dataDir, acc.id)
    let target = url
    if (!target) {
      const pending = readJson(path.join(ap.dir, 'login-pending.json'), null)
      target = pending?.verificationUrl
    }
    if (!target) throw new Error('没有 verification_url：先调 lark_login_start')
    if (ascii) {
      const r = await this.run(['auth', 'qrcode', String(target), '--ascii'], { accountId: acc.id, timeoutMs: 30000 })
      return { ascii: true, text: r.raw || r.stderr }
    }
    const out = path.join(ap.dir, 'login-qr.png')
    const r = await this.run(['auth', 'qrcode', String(target), '--output', out], { accountId: acc.id, timeoutMs: 30000 })
    if (!r.ok) throw new Error(`生成二维码失败：${r.error?.message || r.stderr || '未知原因'}`)
    return { ascii: false, file: out, exists: fs.existsSync(out) }
  }

  /** 账户是否已授权 user 身份（轻量：只读缓存/一次 status）。 */
  async identityUsable(accountId) {
    const st = await this.status({ account: accountId })
    return { bot: !!st.identities?.bot?.available, user: !!st.identities?.user?.available }
  }

  /** 给状态面板用的完整快照（含每个账户的位置与授权状态）。 */
  async snapshot({ refresh = false } = {}) {
    const accounts = this.store.read()
    const defaultId = accounts.default || accounts.accounts[0]?.id || ''
    const rows = []
    for (const a of accounts.accounts) {
      const ap = accountPaths(this.dataDir, a.id)
      let st = null
      let err = null
      try {
        st = await this.status({ account: a.id, refresh })
      } catch (e) {
        err = String(e.message || e)
      }
      rows.push({
        id: a.id,
        label: a.label,
        description: a.description,
        tags: a.tags,
        appId: a.appId,
        brand: a.brand,
        isDefault: a.id === defaultId,
        hasSecret: this.hasSecret(a.id),
        dir: ap.dir,
        bot: st?.identities?.bot?.available ?? false,
        user: st?.identities?.user?.available ?? false,
        identityStatus: st?.identities ?? null,
        error: err || (st && st.ok === false ? st.error?.message : null),
      })
    }
    return {
      dataDir: this.dataDir,
      accounts: rows,
      defaultId,
    }
  }
}

export { toPosix }
