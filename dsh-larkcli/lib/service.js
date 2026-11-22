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
        '修复：调工具 lark_install（action="install"），或设置面板「lark-cli 本体 → 安装」（镜像下载 + SHA256 校验）',
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
          // cwd 默认是账户配置目录（CLI 需要它找 config.json）；
          // 只有 auth qrcode 这种“输出路径不能在配置目录里”的命令才需要换。
          cwd: opts.cwd || ap.dir,
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
      // timedOut 单独给：调用方（loginFinish）靠它区分“超时等确认”与“真的报错”
      return { ok: false, timedOut: true, exitCode: -1, kind: 'timeout', error: { type: 'timeout', message: `超过 ${timeoutMs}ms 未完成（可用 timeoutMs 调整；分页用 --page-limit）` }, stdout, stderr: stderrClean, meta }
    }

    const parsed = parseCliOutput({ stdout, stderr: stderrClean, exitCode: result.exitCode })
    return { ...parsed, stderr: stderrClean, meta }
  }

  // -- 常用查询 -----------------------------------------------------------

  /**
   * auth status：brief 模式只留关键字段，full 模式给全部。带 TTL 缓存。
   *
   * `verify=true` 走 `--verify`（一次网络往返，实测 ~1.1s）：这是**唯一**能拿到
   * “token 到底还有没有效”的方式，也是唯一会返回 bot openId / appName 的模式。
   * 默认不开（每个账户多 1 秒），由调用方显式要。
   */
  async status({ account, detail = 'brief', refresh = false, verify = false } = {}) {
    const acc = account ? this.resolveAccount(account) : this.resolveAccount()
    if (!acc) return { ok: false, error: '尚未配置任何账户', accounts: [] }
    const key = acc.id
    const c = this.cache.status.get(key)
    const now = Date.now()
    const ttl = Number(this.statusTtlMs)
    // verify 必须绕缓存：否则“上次验过且有效”会把现在已经过期的结论当成新鲜的。
    const useCache = !refresh && !verify && c && ttl > 0 && now - c.at < ttl
    if (useCache) {
      return this.composeStatus(c.value, detail, true, now - c.at)
    }
    const args = verify ? ['auth', 'status', '--json', '--verify'] : ['auth', 'status']
    const r = await this.run(args, { accountId: acc.id, timeoutMs: verify ? 45000 : 30000 })
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
        bot: {
          available: !!identities.bot?.available,
          status: identities.bot?.status,
          message: identities.bot?.message,
          // --verify 才有：真实 open_id 与 app 名（不验就是 undefined，不能当“没有”）
          verified: identities.bot?.verified,
          openId: identities.bot?.openId,
          appName: identities.bot?.appName,
        },
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
    /*
     * 清掉上一轮遗留的二维码目录。
     * 工具路径（lark_login_start qrcode=true）不像 HTTP 路由那样“读完就删”，
     * 每次授权都会在 temp 里留一个 lark-qr-*，反复发起就反复积。
     * 旧码本来就扫不出（flow_id 已换），所以可以回收。
     * 只删**过期**的（>15 分钟）：device_code 本身 10 分钟就废了，旧码扫不出来；
     * 而不分新旧全删会和并发请求撞车 —— 另一个账户刚生成一张、还没被路由读完就被删。
     */
    try {
      const now = Date.now()
      for (const name of fs.readdirSync(os.tmpdir())) {
        if (!name.startsWith('lark-qr-')) continue
        const dir = path.join(os.tmpdir(), name)
        try {
          if (now - fs.statSync(dir).mtimeMs > 15 * 60 * 1000) {
            fs.rmSync(dir, { recursive: true, force: true })
          }
        } catch {
          /* 单个删不掉不影响其他 */
        }
      }
    } catch {
      /* 清不掉不影响授权 */
    }
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
  /*
   * 设备流第二步：拿 device_code 换 token。
   *
   * 关键：`auth login --device-code` 是**长轮询** —— 用户还没在手机/浏览器上点确认时，
   * 它不会立刻报错，而是挂在那里等。曾经用 180s，结果面板点一下「我已完成授权」就卡三分钟，
   * 用户以为死了。所以默认只等 30s，超时就直接说「还没确认，请重新发起」。
   * device_code 在 expires_in（通常 10 分钟）内仍然有效，被中途 kill 不影响后面兑换。
   */
  async loginFinish({ account, deviceCode, timeoutMs = 30000 } = {}) {
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
    /*
     * 过期的 pending 必须当成“没有”。
     * 实测踩坑：账户目录里留着一份过期 6 分钟的 login-pending.json，
     * 面板轮询就一直在用一个死掉（已被服务端消费）的 device_code 去兑换：
     *   ① 每次只能拿到“还没确认”，看起来永远没反应；
     *   ② 用户根本不知道真正要做的是重新发起授权。
     * 所以过期就直说“需要重新拿链接”，并把死文件清掉，不继续拿它空转。
     */
    if (pending?.expiresAt) {
      const exp = Date.parse(pending.expiresAt)
      if (Number.isFinite(exp) && Date.now() > exp && !deviceCode) {
        try {
          fs.unlinkSync(pendingFile)
        } catch {
          /* ignore */
        }
        throw new Error('上次的授权链接已过期，请重新点「授权 user 身份」拿一条新的。')
      }
    }
    const r = await this.run(['auth', 'login', '--device-code', code], {
      accountId: acc.id,
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000,
    })
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
      message: r.ok
        ? '授权完成，user 身份应已可用'
        : // 长轮询超时 = 用户还没点确认，这不是错误，是“还没好”
          r.timedOut
          ? '还没检测到你确认授权：请先在手机飞书/浏览器里点「同意」，再点一次「我已完成授权」。'
          : r.error?.message || r.stderr,
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
    /*
     * 输出路径的坑（v0.2.0 实测）：CLI 对 --output 有两条硬规矩——
     *   ① 必须在 cwd / 账户 temp / 账户 files 之内；
     *   ② **不能落在 LARKSUITE_CLI_CONFIG_DIR 里**（配置目录是受保护禁区）。
     * 而本插件的 cwd 恰恰就是那个配置目录，所以原先写到 ap.dir/login-qr.png
     * **必定失败**（这条链路以前从来没被真正跑通过）。
     * 修法：cwd 改成系统 temp 的独立子目录，输出也写在同一个目录里。
     */
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-qr-'))
    const out = path.join(saveDir, 'login-qr.png')
    try {
      const r = await this.run(['auth', 'qrcode', String(target), '--output', out], {
        accountId: acc.id,
        timeoutMs: 30000,
        cwd: saveDir,
      })
      if (!r.ok) {
        const msg = r.error?.message || r.stderr || '未知原因'
        throw new Error(`生成二维码失败：${msg}`)
      }
      if (!fs.existsSync(out)) throw new Error('二维码命令返回成功，但文件不存在')
      return { ascii: false, file: out, exists: true }
    } catch (e) {
      // 失败时把临时目录收掉，不留垃圾（成功则留给 HTTP 路由读，读完由调用方清）
      try {
        fs.rmSync(saveDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      throw e
    }
  }

  /** 账户是否已授权 user 身份（轻量：只读缓存/一次 status）。 */
  async identityUsable(accountId) {
    const st = await this.status({ account: accountId })
    return { bot: !!st.identities?.bot?.available, user: !!st.identities?.user?.available }
  }

  /**
   * 给状态面板用的完整快照。
   *
   * v0.2.0 起每个账户除了「bot/user 可用」还带上**可展示的身份信息**
   * （应用名/头像/描述、用户姓名/邮箱）。这些是慢信息（每个账户 2-3 次 API），
   * 所以很关键：**默认不拉**，只有面板传 withIdentity=1 才拉，且失败不影响行。
   * 理由：面板首帧必须快，用户点「详情」时才愿意等 1 秒。
   */
  async snapshot({ refresh = false, withIdentity = false } = {}) {
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
      const row = {
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
        identity: null,
      }
      if (withIdentity && row.bot) {
        try {
          // 动态 import：identity.js 依赖 scopes.js，避免 loader 阶段的循环依赖
          const { describeAccount } = await import('./identity.js')
          row.identity = await describeAccount({ service: this, account: a, status: st, withApp: true })
        } catch (e) {
          row.identity = { error: String(e.message || e) }
        }
      }
      rows.push(row)
    }
    return {
      dataDir: this.dataDir,
      accounts: rows,
      defaultId,
      binary: { path: this.exePath(), exists: this.hasBinary(), version: this.versionCache || '' },
    }
  }

  // -- 二进制 / 更新 -------------------------------------------------------

  /** 版本体检（本机 vs 镜像最新）。网络不通只报 reachable=false。 */
  async checkUpdate({ timeoutMs = 20000 } = {}) {
    const { updateStatus } = await import('./install.js')
    const st = await updateStatus({ exePath: this.exePath(), timeoutMs })
    if (st.installed && st.installed !== 'unknown') this.versionCache = st.installed
    return st
  }

  /**
   * 安装/升级二进制。安装后清掉版本缓存与 schema 缓存
   * （新版本可能带新命令，旧 schema 索引必须作废）。
   */
  async installCli({ version = '', force = false, onLog = null } = {}) {
    const { installBinary } = await import('./install.js')
    const r = await installBinary({
      targetExe: this.exePath(),
      stagingDir: path.join(this.dataDir, 'staging'),
      version,
      force,
      log: onLog || (() => {}),
    })
    if (r.ok) {
      this.versionCache = ''
      this.cache.schema = { at: 0, list: null }
      try {
        fs.rmSync(path.join(this.dataDir, 'cache', 'schema.json'), { force: true })
      } catch {
        /* 删不掉不影响功能 */
      }
    }
    return r
  }
}

export { toPosix }
