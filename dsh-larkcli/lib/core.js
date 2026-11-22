/**
 * dsh-larkcli · 纯核心（无 Host 依赖、可单测）
 *
 * 这里只放「不需要 Host 服务、不启动子进程」的纯逻辑：
 *   路径推导、账户登记表、任务匹配、config.json 生成、CLI 信封解析、
 *   schema 摘要、脱敏与截断。
 *
 * 为什么单独分一层：test/run.mjs 要能在不起 DSH、不装插件的前提下直接跑，
 * 覆盖「初始态 / 失败态」而不只是成功态。业务逻辑在 service.js，Host 接线在 index.js。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 账户 id 会变成目录名，必须白名单：挡住 `..`、绝对路径、盘符与中文空格等。 */
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** 数据目录默认名：C:\dsh\data-larkcli（与 data-getbrain 同一约定，仓库外）。 */
export const DATA_DIRNAME = 'data-larkcli'

/** 旧（迁移前）凭据目录，相对插件根。 */
export const LEGACY_REL = path.join('lark-cli-win', '_native-config')

/** 截断/脱敏默认值。 */
export const DEFAULT_MAX_CHARS = 24000

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** CLI 的 appSecret.id 要正斜杠绝对路径（实测反斜杠/相对路径都会读不到文件）。 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/**
 * 推导数据目录。约定：仓库同级 data-<短名>，不写死绝对路径。
 *
 *   <插件目录>   C:\dsh\dshplug\dsh-larkcli\lib        ← libDir（本文件所在）
 *   <插件根>     C:\dsh\dshplug\dsh-larkcli
 *   <仓库根>     C:\dsh\dshplug
 *   数据目录     C:\dsh\data-larkcli                    ← 仓库的**同级**
 *
 * 被装进 profile 后 Node 默认会 realpath（link: 是 Junction），所以 libDir 仍是源码位置。
 * 万一拿到的是 profile 里的 node_modules 路径，就退回 ~/.dsh/data-larkcli，
 * 避免把数据写进 DSH 安装目录。
 */
export function derivePaths(libDir) {
  const pluginDir = path.dirname(libDir)
  const repoRoot = path.dirname(pluginDir)
  if (path.basename(repoRoot).toLowerCase() === 'node_modules') {
    return { pluginDir, repoRoot, dataDir: path.join(os.homedir(), '.dsh', DATA_DIRNAME) }
  }
  return { pluginDir, repoRoot, dataDir: path.join(path.dirname(repoRoot), DATA_DIRNAME) }
}

/** 某账户在这台机器上的三个路径。 */
export function accountPaths(dataDir, id) {
  const dir = path.join(dataDir, 'accounts', id)
  return { dir, configFile: path.join(dir, 'config.json'), secretFile: path.join(dir, 'appsecret.txt') }
}

export function accountsFile(dataDir) {
  return path.join(dataDir, 'accounts.json')
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 原子写：先写 .tmp 再 rename，避免半截 JSON 把账户表写坏。 */
export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function mask(value) {
  const s = String(value ?? '')
  if (!s) return ''
  if (s.length <= 8) return '…'
  return `${s.slice(0, 4)}…(${s.length})`
}

/**
 * 脱敏：出错信息、原始输出里可能带 token。
 * 注意 device_code 也算凭据（10 分钟内可直接完成授权），一律打掉。
 */
const SECRET_KEY_RE = /^(appsecret|app_secret|access_?token|refresh_?token|tenant_access_?token|user_access_?token|device_?code|password|secret|token|api_?key)$/i

export function redactDeep(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1))
  if (typeof value === 'string') {
    // 兜底：飞书 token 常见前缀形式
    return value.replace(/\b(?:t|u|a)-[A-Za-z0-9._-]{20,}/g, '***')
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' ? mask(v) : redactDeep(v, depth + 1)
    }
    return out
  }
  return value
}

/** 截断过长结果，并明确告诉模型「该怎么拿全」。 */
export function truncate(text, maxChars = DEFAULT_MAX_CHARS) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return { text: s, truncated: false }
  return {
    text:
      `${s.slice(0, maxChars)}\n\n…（已截断，共 ${s.length} 字符，只显示前 ${maxChars} 字符）\n` +
      '要拿全：加 --page-limit / --page-size 分页，或把 maxChars 调大。',
    truncated: true,
  }
}

/** CLI 的 `--notice` 升级提示等内容占 token 却与任务无关。 */
export function stripNotice(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  if (!('_notice' in obj)) return obj
  const { _notice, ...rest } = obj
  return rest
}

// ---------------------------------------------------------------------------
// CLI 输出信封
// ---------------------------------------------------------------------------

/**
 * 解析 lark-cli 的输出。
 *
 * 实测契约（v1.0.99）：
 *   成功 → stdout 是 JSON，exit 0，形如 { ok:true, identity, data, meta }
 *   失败 → **stderr** 是 JSON，非零退出，形如 { ok:false, identity, error:{type,subtype,code,message,hint} }
 *   少数命令（auth status / config show）直接输出裸 JSON，没有 ok 字段。
 *
 * 判定成功一律看 ok !== false && exitCode === 0，绝不看 error.code == 0。
 */
export function parseCliOutput({ stdout, stderr, exitCode }) {
  const out = String(stdout ?? '').trim()
  const err = String(stderr ?? '').trim()
  const tryJson = (s) => {
    if (!s) return undefined
    const head = s[0]
    if (head !== '{' && head !== '[') return undefined
    try { return JSON.parse(s) } catch { return undefined }
  }

  const errJson = tryJson(err)
  const outJson = tryJson(out)

  if (errJson && errJson.ok === false && errJson.error) {
    return { ok: false, kind: 'error-envelope', identity: errJson.identity, error: errJson.error, json: errJson, raw: err, exitCode }
  }
  if (outJson !== undefined) {
    const isEnvelope = outJson && typeof outJson === 'object' && !Array.isArray(outJson) && 'ok' in outJson
    if (isEnvelope && outJson.ok === false) {
      return { ok: false, kind: 'error-envelope', identity: outJson.identity, error: outJson.error, json: stripNotice(outJson), raw: out, exitCode }
    }
    return { ok: exitCode === 0, kind: isEnvelope ? 'envelope' : 'json', identity: outJson?.identity, json: stripNotice(outJson), raw: out, error: undefined, exitCode }
  }
  // 非 JSON：help / table / 纯文本
  return {
    ok: exitCode === 0,
    kind: 'text',
    json: undefined,
    raw: out || err,
    error: exitCode === 0 ? undefined : { type: 'cli', message: err || out || `exit ${exitCode}` },
    exitCode,
  }
}

/** 已知无害的 stderr 噪声（DPoP key 锁在 Windows 上必然出现，不影响功能）。 */
const BENIGN_STDERR_RE = /^\[lark-cli\]\s*\[WARN\]\s*local DPoP setup failed/i

export function cleanStderr(stderr) {
  return String(stderr ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !BENIGN_STDERR_RE.test(line.trim()))
    .join('\n')
    .trim()
}

// ---------------------------------------------------------------------------
// 参数切词（模型常把整条命令塞成一个字符串）
// ---------------------------------------------------------------------------

/**
 * 按 shell 规则切词，支持单双引号与反斜杠转义。
 * 为什么不用 split(' ')：`--query "周报 汇总"` 和 `--data '{"a":"b c"}'` 会被切坏，
 * 而 lark.ps1 里那套正则对嵌套引号也不可靠。
 */
export function tokenize(input) {
  const s = String(input ?? '')
  const out = []
  let cur = ''
  let quote = ''
  let has = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) {
        cur += s[++i]
        continue
      }
      if (c === quote) { quote = ''; continue }
      cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue }
    if (/\s/.test(c)) {
      if (cur || has) { out.push(cur); cur = ''; has = false }
      continue
    }
    cur += c
    has = true
  }
  if (cur || has) out.push(cur)
  return out
}

// ---------------------------------------------------------------------------
// 账户登记表
// ---------------------------------------------------------------------------

const EMPTY_REGISTRY = { version: 1, default: '', accounts: [] }

export function validateAccountInput(input) {
  const errors = []
  const id = String(input?.id ?? '').trim()
  if (!ACCOUNT_ID_RE.test(id)) errors.push('id 必须匹配 ^[a-z0-9][a-z0-9_-]{0,31}$（会变成目录名）')
  const appId = String(input?.appId ?? '').trim()
  if (appId && !/^cli_[A-Za-z0-9]{6,}$/.test(appId)) errors.push('appId 形如 cli_xxxxxxxx')
  const brand = input?.brand ? String(input.brand) : ''
  if (brand && !['feishu', 'lark'].includes(brand)) errors.push("brand 只能是 feishu 或 lark")
  const tags = input?.tags
  if (tags !== undefined && !Array.isArray(tags)) errors.push('tags 必须是字符串数组')
  return { ok: errors.length === 0, errors }
}

/**
 * 账户登记表的读写。刻意做成「每次读文件」而不是内存常驻：
 * 面板/工具/未来 CLI 可能同时改它，常驻缓存会互相覆盖。
 * 文件很小（几 KB），代价可以忽略。
 */
export class AccountsStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.file = accountsFile(dataDir)
  }

  read() {
    const raw = readJson(this.file, null)
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) return { ...EMPTY_REGISTRY, accounts: [] }
    return {
      version: raw.version ?? 1,
      default: String(raw.default ?? ''),
      accounts: raw.accounts.filter((a) => a && ACCOUNT_ID_RE.test(String(a.id ?? ''))),
    }
  }

  write(registry) {
    writeFileAtomic(this.file, JSON.stringify(registry, null, 2) + '\n')
    return registry
  }

  list() {
    return this.read().accounts
  }

  get(id) {
    if (!id) return undefined
    return this.read().accounts.find((a) => a.id === id)
  }

  defaultId() {
    const reg = this.read()
    if (reg.default && reg.accounts.some((a) => a.id === reg.default)) return reg.default
    return reg.accounts[0]?.id ?? ''
  }

  /** 没有 default 时自动补第一个，保证「不传 account 也能调」。 */
  setDefault(id) {
    const reg = this.read()
    if (!reg.accounts.some((a) => a.id === id)) throw new Error(`账户不存在：${id}`)
    reg.default = id
    this.write(reg)
    return id
  }

  upsert(patch) {
    const reg = this.read()
    const now = new Date().toISOString()
    const id = String(patch.id)
    const idx = reg.accounts.findIndex((a) => a.id === id)
    const base = idx >= 0 ? reg.accounts[idx] : { id, createdAt: now }
    const next = {
      ...base,
      ...('label' in patch && patch.label !== undefined ? { label: String(patch.label) } : {}),
      ...('description' in patch && patch.description !== undefined ? { description: String(patch.description) } : {}),
      ...('tags' in patch && patch.tags !== undefined ? { tags: (patch.tags || []).map(String).filter(Boolean) } : {}),
      ...('appId' in patch && patch.appId !== undefined ? { appId: String(patch.appId) } : {}),
      ...('brand' in patch && patch.brand !== undefined ? { brand: String(patch.brand) } : {}),
      updatedAt: now,
    }
    if (!next.brand) next.brand = 'feishu'
    if (!Array.isArray(next.tags)) next.tags = []
    if (next.label === undefined) next.label = id
    if (next.description === undefined) next.description = ''
    if (idx >= 0) reg.accounts[idx] = next
    else reg.accounts.push(next)
    if (!reg.default || patch.makeDefault) reg.default = id
    this.write(reg)
    return next
  }

  remove(id) {
    const reg = this.read()
    const before = reg.accounts.length
    reg.accounts = reg.accounts.filter((a) => a.id !== id)
    if (reg.accounts.length === before) throw new Error(`账户不存在：${id}`)
    if (reg.default === id) reg.default = reg.accounts[0]?.id ?? ''
    this.write(reg)
    // 目录不自动删（里面可能是唯一的 secret），只报告位置
    return accountPaths(this.dataDir, id)
  }
}

// ---------------------------------------------------------------------------
// config.json 生成（这才是「绝对路径」问题的根治点）
// ---------------------------------------------------------------------------

/**
 * 生成 lark-cli 要的 config.json 内容。
 * appSecret.id 必须是**绝对**正斜杠路径（相对路径实测报「找不到文件」），
 * 所以这里按本机实际数据目录现算 —— 文件落在仓库外，不进 git，换机器自动正确。
 */
export function buildCliConfig(account, secretFile) {
  return {
    apps: [
      {
        appId: account.appId,
        appSecret: { source: 'file', id: toPosix(secretFile) },
        brand: account.brand || 'feishu',
      },
    ],
  }
}

/**
 * 把「我们负责的那三个字段」合并进 config.json，而不是整份重写。
 *
 * **为什么不能整份覆盖**（0.2.3 修的真实事故）：
 * lark-cli 在浏览器授权成功后会往 `apps[i].users` 里写入 user token。
 * 早期实现是 `writeFileAtomic(file, buildCliConfig(...))` —— 整份覆盖，
 * 只写 appId/appSecret/brand，于是把用户刚授权拿到的 `users` 连同 token 一起抹掉。
 *
 * 症状极具误导性：浏览器里明明点了同意、服务端也返回了 200，
 * 面板却永远是「user 未授权」，`lark-cli auth list` 也查不到人 ——
 * 因为下一个 API 调用把 token 删了。实测证据：
 *   config.json mtime 16:54:25.782，紧跟 oauth/v3/token 200（16:54:25.458）之后，
 *   同目录还留下了 refresh_<appId>_ou_<openid>.lock —— token 确实写入过，随后被覆盖。
 *
 * 合并规则：
 *   1. 同 appId 的条目：只覆盖 appId / appSecret / brand，其余字段（含 users）原样保留
 *   2. 没有同 appId、且数组只有一条无 token 的旧条目：替换（账户换了 appId 的情形）
 *   3. 其余：追加，绝不动数组里别的 app（为多应用留路）
 *   4. 顶层未知字段一律保留
 */
export function syncCliConfig(account, secretFile) {
  const wantApp = buildCliConfig(account, secretFile).apps[0]
  const file = accountPathsFor(secretFile).configFile
  const have = readJson(file, null)

  let next
  if (!have || typeof have !== 'object' || !Array.isArray(have.apps)) {
    next = { apps: [wantApp] }
  } else {
    const apps = have.apps.slice()
    const idx = apps.findIndex((a) => a && a.appId === wantApp.appId)
    if (idx >= 0) {
      apps[idx] = { ...apps[idx], ...wantApp }
    } else {
      const stale = apps.findIndex((a) => a && !(Array.isArray(a.users) && a.users.length))
      if (stale >= 0 && apps.length === 1) apps[stale] = wantApp
      else apps.push(wantApp)
    }
    next = { ...have, apps }
  }

  if (have && JSON.stringify(have) === JSON.stringify(next)) return { file, changed: false }
  writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n')
  return { file, changed: true }
}

function accountPathsFor(secretFile) {
  const dir = path.dirname(secretFile)
  return { dir, configFile: path.join(dir, 'config.json'), secretFile }
}

// ---------------------------------------------------------------------------
// 旧凭据迁移
// ---------------------------------------------------------------------------

/**
 * 把迁移前的单账户凭据收进新登记表。
 * 返回 null 表示没有可迁移的东西（不是错误）。
 */
export function migrateLegacy({ store, pluginDir, legacyId = 'default' }) {
  const legacyDir = path.join(pluginDir, LEGACY_REL)
  const legacyConfig = readJson(path.join(legacyDir, 'config.json'), null)
  const legacySecretFile = path.join(legacyDir, 'appsecret.txt')
  if (!legacyConfig || !Array.isArray(legacyConfig.apps) || !legacyConfig.apps.length) return null
  if (!fs.existsSync(legacySecretFile)) return null

  const app = legacyConfig.apps[0]
  const secret = fs.readFileSync(legacySecretFile, 'utf8').trim()
  if (!secret) return null

  const ap = accountPaths(store.dataDir, legacyId)
  ensureDir(ap.dir)
  fs.writeFileSync(ap.secretFile, secret, 'utf8')
  const account = store.upsert({
    id: legacyId,
    label: '默认账户',
    description: '从迁移前的单账户凭据自动导入（原 _native-config）',
    tags: ['默认'],
    appId: app.appId,
    brand: app.brand || 'feishu',
    makeDefault: true,
  })
  syncCliConfig(account, ap.secretFile)
  return { account, secretFile: ap.secretFile, legacyDir }
}

// ---------------------------------------------------------------------------
// 任务 → 账户匹配
// ---------------------------------------------------------------------------

/**
 * 把文本切成可比较的「词」。
 * 中文没有空格，所以除了拉丁词还额外生成 CJK bigram —— 否则「周报」这种两字词永远匹配不上。
 */
export function wordsOf(text) {
  const out = new Set()
  const s = String(text ?? '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_+#.-]{2,}/g)) out.add(m[0])
  const cjk = s.replace(/[^\u4e00-\u9fff\u3400-\u4dbf]+/g, ' ')
  for (const chunk of cjk.split(/\s+/)) {
    if (!chunk) continue
    if (chunk.length === 1) out.add(chunk)
    for (let i = 0; i + 1 < chunk.length; i++) out.add(chunk.slice(i, i + 2))
  }
  return out
}

const W_TAG = 6
const W_LABEL = 4
const W_ID = 3
const W_DESC = 1

/** 给单个账户打分并给出可解释的原因（模型据此判断，不是黑箱）。 */
export function scoreAccount(query, account) {
  const q = wordsOf(query)
  if (!q.size) return { score: 0, confidence: 0, reasons: [] }

  const label = wordsOf(account.label)
  const idw = wordsOf(account.id)
  const desc = wordsOf(account.description)
  const tagWords = new Set()
  for (const t of account.tags || []) for (const w of wordsOf(t)) tagWords.add(w)

  let score = 0
  let tagHits = 0
  let labelHits = 0
  let descHits = 0
  const reasons = []

  for (const w of q) {
    if (tagWords.has(w)) { tagHits++; score += W_TAG }
    if (label.has(w)) { labelHits++; score += W_LABEL }
    if (idw.has(w)) score += W_ID
    if (desc.has(w)) { descHits++; score += W_DESC }
  }

  // 标签整体包含（「周报」命中标签「周报汇总」）给一次强加分
  const rawQ = String(query ?? '').trim().toLowerCase()
  if (rawQ) {
    for (const t of account.tags || []) {
      const tl = String(t).toLowerCase()
      if (tl && (tl === rawQ || tl.includes(rawQ) || rawQ.includes(tl))) {
        score += 8
        reasons.push(`标签「${t}」直接命中`)
        break
      }
    }
  }

  if (labelHits) reasons.push(`名称命中 ${labelHits} 词`)
  if (tagHits) reasons.push(`标签命中 ${tagHits} 词`)
  if (descHits) reasons.push(`描述命中 ${descHits} 词`)
  if (account.isDefault) reasons.push('是默认账户')

  const max = q.size * W_TAG + 8
  return { score, confidence: Math.min(1, score / Math.max(1, max)), reasons }
}

/** 排序并截断。默认账户在打平时优先。 */
export function rankAccounts(query, accounts, limit = 3) {
  const scored = accounts.map((a) => {
    const s = scoreAccount(query, a)
    return { account: a, ...s, tie: a.isDefault ? 1 : 0 }
  })
  scored.sort((x, y) => y.score - x.score || y.tie - x.tie || String(x.account.id).localeCompare(String(y.account.id)))
  return scored.slice(0, Math.max(1, limit))
}

// ---------------------------------------------------------------------------
// schema 摘要（1.5 MB → 几百字）
// ---------------------------------------------------------------------------

/**
 * 把 `lark-cli schema` 的 256 条方法压成「服务 → 命令名」的索引。
 * 全量 JSON 有 1.5 MB，直接进模型上下文会烧掉整个窗口，所以只留名字与短描述，
 * 需要细节时再按方法名单独查（单次约 2 KB）。
 */
export function summarizeSchema(rawList) {
  const list = Array.isArray(rawList) ? rawList : []
  const services = {}
  for (const item of list) {
    const name = String(item?.name ?? '').trim()
    if (!name) continue
    const parts = name.split(/\s+/)
    const service = parts[0]
    const cmd = parts.slice(1).join(' ')
    const desc = String(item?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
    ;(services[service] ||= []).push({ n: cmd, d: desc })
  }
  for (const k of Object.keys(services)) services[k].sort((a, b) => a.n.localeCompare(b.n))
  return { total: list.length, services }
}

/** `im messages delete` / `im.messages.delete` / `im messages.delete` 统一成点号形式。 */
export function normalizeMethodName(input) {
  return String(input ?? '')
    .trim()
    .replace(/\s+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
}

export function findMethod(rawList, method) {
  const want = normalizeMethodName(method)
  if (!want) return undefined
  const list = Array.isArray(rawList) ? rawList : []
  return list.find((it) => normalizeMethodName(it?.name) === want)
}

// ---------------------------------------------------------------------------
// 状态文本
// ---------------------------------------------------------------------------

/** brief：只回答「能不能用」。省 token，是默认值。 */
export function statusLine(accountId, account, statusJson) {
  const identities = statusJson?.identities || {}
  const bot = identities.bot || {}
  const user = identities.user || {}
  const mark = (available) => (available ? '✅' : '❌')
  return [
    `账户 ${accountId}${account?.label ? `（${account.label}）` : ''}`,
    `  bot  ${mark(bot.available)} ${bot.status || 'unknown'}`,
    `  user ${mark(user.available)} ${user.status || 'unknown'}${user.available ? '' : '（需授权）'}`,
    `  appId ${statusJson?.appId || account?.appId || '?'}`,
  ].join('\n')
}
