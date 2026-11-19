/**
 * dsh-larkcli · 宿主半（Cordis 插件）
 *
 * 目标（用户三条硬要求）：
 *   1) 只解决 Windows 下 DSH 读/写飞书的能力 —— 不靠 WSL、不装系统 Node、不用 MCP。
 *   2) 能看到详细信息 —— 工具默认精简，detail=full 展开；设置面板另有一份给人看的。
 *   3) DSH 能快速调用 —— 直接 spawn exe（不经 pwsh），通用工具 + 本地索引，不注册 200 个工具。
 *
 * 多账户模型（已确认）：
 *   每账户 = 独立 App(appId/secret) + 独立 configDir + 独立 user 授权，描述/标签/默认挂在账户上。
 *   任务 → 账户 走**纯本地**加权匹配（零 CLI 调用、零额外模型往返），默认账户存在时可直接省略 account。
 *
 * 为什么要「每次调用现算 config.json」：
 *   迁移到 dshplug 后 config.json 里那条 C:/dsh/dsh-larkcli/... 绝对路径直接断了（旧目录已删），
 *   CLI 报 failed to read secret file。根治办法不是再改一次字符串，而是让路径由代码推导，
 *   凭据与 config.json 全放仓库外的数据目录，换机器/换目录自动正确。
 *
 * 安全铁律：
 *   - appSecret / device_code 只写不读、永不回显、不进日志、不进返回文本。
 *   - 写操作默认建议 --dry-run；高危动作（--yes）不代用户点。
 *   - HTTP 路由只接受 loopback + 同源。
 *
 * @module dsh-larkcli
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCOUNT_ID_RE,
  DEFAULT_MAX_CHARS,
  derivePaths,
  findMethod,
  migrateLegacy,
  mask,
  normalizeMethodName,
  rankAccounts,
  redactDeep,
  statusLine,
  summarizeSchema,
  tokenize,
  truncate,
  validateAccountInput,
} from './core.js'
import { CliMissingError, LarkService } from './service.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DERIVED = derivePaths(HERE)

export const name = 'dsh-larkcli'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// 配置（schemastery 由宿主提供；拿不到就退化成无表单，功能照常）
// ---------------------------------------------------------------------------

async function loadSchemastery() {
  const candidates = []
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const profile = process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME || ''
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    candidates.push(req.resolve('@deepseek-ai/schemastery'))
  } catch {
    /* not linked here */
  }
  if (profile) candidates.push(path.join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai', 'schemastery'))
  candidates.push(path.join(DERIVED.repoRoot, 'node_modules', '@deepseek-ai', 'schemastery'))
  for (const c of candidates) {
    try {
      const entry = /\.(c|m)?js$/.test(c) ? c : path.join(c, 'lib', 'index.cjs')
      if (!fs.existsSync(entry)) continue
      const mod = await import(new URL(`file://${entry.replace(/\\/g, '/')}`).href)
      const z = mod?.default ?? mod
      if (typeof z?.object === 'function') return z
    } catch {
      /* try next */
    }
  }
  return undefined
}

const z = await loadSchemastery()

const ConfigShape = !z
  ? undefined
  : z.object({
      dataDir: z
        .string()
        .default('')
        .description('账户与凭据目录。留空 = 仓库同级 data-larkcli（本机 C:\\dsh\\data-larkcli），自动创建、不进 Git。')
        .volatile(),
      binaryPath: z.string().default('').description('lark-cli.exe 路径。留空 = 插件目录下 lark-cli-win\\lark-cli.exe。').volatile(),
      timeoutMs: z.number().min(1000).max(600000).default(120000).description('单次调用超时毫秒数。').volatile(),
      statusTtlMs: z.number().min(0).max(600000).default(60000).description('auth status 缓存时长，减少重复调用。').volatile(),
      maxChars: z.number().min(2000).max(400000).default(DEFAULT_MAX_CHARS).description('单次结果最大字符数，超出截断并提示分页。').volatile(),
      autoMigrate: z
        .boolean()
        .default(true)
        .description('首次启动时把插件目录 lark-cli-win\\_native-config 的旧凭据导入为 default 账户。')
        .volatile(),
    })
export const Config = ConfigShape

function unwrap(v) {
  let cur = v
  for (let i = 0; i < 4 && cur != null; i++) {
    if (typeof cur === 'object' && typeof cur.get === 'function') {
      try {
        cur = cur.get()
      } catch {
        break
      }
    } else break
  }
  return cur
}

function cfg(config, key, fallback) {
  try {
    const v = unwrap(config?.[key])
    if (v === undefined || v === null || v === '') return fallback
    return v
  } catch {
    return fallback
  }
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  }
}

// ---------------------------------------------------------------------------
// 文本渲染：所有工具都返回「人能读 + 模型好解析」的稳定文本
// ---------------------------------------------------------------------------

function renderCall(r, { maxChars }) {
  const lines = []
  const mark = r.ok ? '✅' : '❌'
  lines.push(`${mark} lark-cli ${r.meta?.command?.replace(/^lark-cli /, '') || ''}`)
  lines.push(`账户 ${r.meta?.account || '?'}｜exit ${r.exitCode}`)
  if (r.identity) lines.push(`身份 ${r.identity}`)

  if (!r.ok) {
    const e = r.error || {}
    lines.push('')
    lines.push(`错误 ${e.type || 'unknown'}${e.subtype ? '/' + e.subtype : ''}${e.code ? ' code=' + e.code : ''}`)
    if (e.message) lines.push(`  ${e.message}`)
    if (e.hint) lines.push(`  提示：${e.hint}`)
    if (r.kind === 'timeout') lines.push('  可加大 timeoutMs，或用 --page-limit 分页')
  }

  const body = r.ok ? r.json ?? r.raw : r.stderr || r.raw
  if (body !== undefined && body !== '') {
    lines.push('')
    const text = typeof body === 'string' ? body : JSON.stringify(redactDeep(body), null, 2)
    const t = truncate(text, maxChars)
    lines.push(t.text)
    if (t.truncated) lines.push('（结果已截断）')
  }
  return lines.join('\n')
}

function renderStatus(st) {
  if (!st || st.ok === false) {
    return `❌ 状态不可用\n${typeof st?.error === 'string' ? st.error : JSON.stringify(st?.error || {}, null, 2)}`
  }
  const lines = [`# 飞书账户状态`, '']
  lines.push(statusLine(st.account, { label: st.label, appId: st.appId }, st.detail || { identities: st.identities }))
  lines.push('')
  if (st.brand) lines.push(`brand ${st.brand}`)
  if (st.dpopMode) lines.push(`DPoP ${st.dpopMode}`)
  if (st.credentialSource) lines.push(`凭据来源 ${st.credentialSource}`)
  if (st.binary?.path) lines.push(`二进制 ${st.binary.path}${st.binary.version ? `（v${st.binary.version}）` : ''}`)
  if (st.note) lines.push('', st.note)
  // detail=full：把 CLI 的完整 auth status 原样附上。
  // 为什么默认不给：这个 JSON 比 brief 大几倍，而多数任务只关心「bot 能不能用」。
  // 但「能看到详细信息」是用户的硬要求，所以 full 模式必须真的多出东西。
  if (st.detail) {
    lines.push('', '## 完整 auth status')
    lines.push(JSON.stringify(redactDeep(st.detail), null, 2))
  }
  if (st.cached) lines.push('', `（缓存，${Math.round((st.ageMs || 0) / 1000)}s 前取的；refresh=true 强制重取）`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  /**
   * 解析数据目录。绝不能“有什么就用什么”：
   * 手改的 YAML / 旧版本同步过来的垃圾值（比如 `dataDir: 123`）会让
   * fs.mkdirSync 在插件目录里建出 `123\`（相对路径 = 相对 cwd），
   * 污染仓库、而且与「数据必须在仓库外」的约定相反。
   * 所以：只接受**绝对路径**的字符串；其余一律回落推导默认值。
   */
  const resolveDataDir = () => {
    const raw = cfg(config, 'dataDir', '')
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (!s) return DERIVED.dataDir
    if (!path.isAbsolute(s)) return DERIVED.dataDir
    return s
  }
  const dataDir = resolveDataDir()
  const service = new LarkService({
    dataDir,
    pluginDir: DERIVED.pluginDir,
    binaryPath: String(cfg(config, 'binaryPath', '') || ''),
    timeoutMs: Number(cfg(config, 'timeoutMs', 120000)) || 120000,
    // 注意：不能写 `|| 60000`。配置里 0 的含义是「关缓存」，
    // 而 `0 || 60000` 会退成 60000，与文档相反（会被测试抓出）。
    statusTtlMs: Number.isFinite(Number(cfg(config, 'statusTtlMs', 60000))) ? Number(cfg(config, 'statusTtlMs', 60000)) : 60000,
  })
  const maxChars = () => {
    const n = Number(cfg(config, 'maxChars', DEFAULT_MAX_CHARS))
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHARS
  }

  // 首次启动做一次旧凭据迁移（幂等：账户已存在就跳过）
  ctx.effect(() => {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      if (cfg(config, 'autoMigrate', true) && service.store.list().length === 0) {
        migrateLegacy({ store: service.store, pluginDir: DERIVED.pluginDir })
      }
    } catch {
      /* 迁移失败不阻断插件加载；工具会如实报错 */
    }
  }, 'larkcli: bootstrap data dir')

  const register = (definition, label) => ctx.effect(() => ctx.tools.register(definition), `larkcli: ${label}`)

  // -------------------------------------------------------------------------
  // 1) lark_status —— 详细状态（brief / full）
  // -------------------------------------------------------------------------
  register(
    {
      name: 'lark_status',
      description:
        '查看飞书账户状态：bot/user 两种身份是否可用、appId、DPoP、二进制版本与路径。' +
        '默认精简（省 token）；需要全部字段用 detail="full"。结果有短 TTL 缓存，refresh=true 强制重取。' +
        '不传 account 时用默认账户。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: '账户 id。省略 = 默认账户。' },
          detail: { type: 'string', enum: ['brief', 'full'], description: 'brief（默认，精简）或 full（含完整 auth status JSON）。' },
          refresh: { type: 'boolean', description: '绕过缓存重新探测。' },
        },
      },
      output: textOutput(),
      timeoutMs: 60000,
      async execute(args) {
        try {
          const st = await service.status({
            account: args?.account ? String(args.account) : undefined,
            detail: args?.detail === 'full' ? 'full' : 'brief',
            refresh: args?.refresh === true,
          })
          return renderStatus(st)
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'status',
  )

  // -------------------------------------------------------------------------
  // 2) lark_account_search —— 本地按任务找账户（零 CLI 调用）
  // -------------------------------------------------------------------------
  register(
    {
      name: 'lark_account_search',
      description:
        '按任务描述在本地账户表里搜索最合适的账户（纯本地加权匹配，不调用飞书、不耗配额）。' +
        '返回 top 账户及命中理由。任务跨多个账户时才需要它；只有一个默认账户时可直接省略 account。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '任务描述或关键词，例如「查上周周报文档」「研发群消息」「多维表格 项目A」。' },
          limit: { type: 'number', description: '返回条数，默认 3，最多 10。' },
        },
        required: ['query'],
      },
      output: textOutput(),
      timeoutMs: 15000,
      async execute(args) {
        const query = String(args?.query ?? '').trim()
        if (!query) return '❌ 需要 query'
        const limit = Math.min(10, Math.max(1, Number(args?.limit) || 3))
        const accounts = service.store.list()
        if (!accounts.length) {
          return '还没有任何账户。先用 lark_account_upsert 建一个（id / appId / 描述 / 标签）。'
        }
        const defaultId = service.store.defaultId()
        const withDefault = accounts.map((a) => ({ ...a, isDefault: a.id === defaultId }))
        const ranked = rankAccounts(query, withDefault, limit)
        const lines = [`# 匹配「${query}」`, '']
        for (const r of ranked) {
          const a = r.account
          lines.push(`${r.account.id === defaultId ? '★ ' : ''}${a.id}（${a.label}）  score=${r.score.toFixed(0)}`)
          if (a.description) lines.push(`   ${a.description}`)
          if (a.tags?.length) lines.push(`   标签：${a.tags.join(' / ')}`)
          if (r.reasons.length) lines.push(`   命中：${r.reasons.join('；')}`)
          lines.push('')
        }
        const best = ranked[0]
        if (best && best.score > 0) {
          lines.push(`建议：account="${best.account.id}"`)
        } else {
          lines.push('没有明显匹配。可以直接省略 account 走默认账户，或先完善各账户的描述/标签。')
        }
        return lines.join('\n').trim()
      },
    },
    'account search',
  )

  // -------------------------------------------------------------------------
  // 3) lark_account_upsert —— 建/改账户（描述、标签、默认）
  // -------------------------------------------------------------------------
  register(
    {
      name: 'lark_account_upsert',
      description:
        '新增或修改一个飞书账户：id、显示名、描述、标签、appId、brand，可设为默认。' +
        '描述与标签决定 lark_account_search 的匹配质量，建议写清用途（群/文档/多维表格/日历）。' +
        'appSecret 不在这里传，用 lark_account_set_secret（值不回显）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '账户 id，小写字母数字-_，会变成目录名，例如 work / personal。' },
          label: { type: 'string', description: '显示名，例如「公司主账号」。' },
          description: { type: 'string', description: '这个账户覆盖什么：哪些群、文档、表格、日历、邮件。搜索靠它。' },
          tags: { type: 'array', items: { type: 'string' }, description: '关键词，例如 ["研发","周报","项目A","多维表格"]。' },
          appId: { type: 'string', description: '飞书应用 App ID，形如 cli_xxxx。' },
          brand: { type: 'string', enum: ['feishu', 'lark'], description: 'feishu（国内）或 lark（国际）。' },
          makeDefault: { type: 'boolean', description: '设为默认账户（不传 account 时用它）。' },
        },
        required: ['id'],
      },
      output: textOutput(),
      timeoutMs: 15000,
      async execute(args) {
        const input = {
          id: String(args?.id ?? ''),
          label: args?.label,
          description: args?.description,
          tags: args?.tags,
          appId: args?.appId,
          brand: args?.brand,
        }
        const v = validateAccountInput(input)
        if (!v.ok) return `❌ 参数不合法：\n- ${v.errors.join('\n- ')}`
        if (input.brand !== undefined && !input.brand) delete input.brand
        if (input.appId !== undefined && !input.appId) delete input.appId
        const existed = !!service.store.get(input.id)
        service.store.upsert({ ...input, makeDefault: args?.makeDefault === true })
        service.invalidateStatus(input.id)
        const a = service.store.get(input.id)
        const lines = [existed ? `✅ 已更新账户 ${a.id}` : `✅ 已新增账户 ${a.id}`]
        lines.push(`  名称：${a.label}`)
        if (a.description) lines.push(`  描述：${a.description}`)
        if (a.tags?.length) lines.push(`  标签：${a.tags.join(' / ')}`)
        if (a.appId) lines.push(`  appId：${a.appId}`)
        lines.push(`  默认：${service.store.defaultId() === a.id ? '是' : '否'}`)
        if (!service.hasSecret(a.id)) {
          lines.push('')
          lines.push(`下一步：lark_account_set_secret（account="${a.id}"），再 lark_login_start 做 user 授权。`)
        }
        return lines.join('\n')
      },
    },
    'account upsert',
  )

  // -------------------------------------------------------------------------
  // 4) lark_account_set_secret —— 唯一接收密钥的入口，永不回显
  // -------------------------------------------------------------------------
  register(
    {
      name: 'lark_account_set_secret',
      description:
        '写入某账户的 App Secret（唯一接收密钥的接口，写入后只报告长度，永不回显）。' +
        '密钥落在仓库外的数据目录 accounts/<id>/appsecret.txt，下次调用时自动生成该账户的 config.json。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: '账户 id。省略 = 默认账户。' },
          appSecret: { type: 'string', description: '飞书应用的 App Secret。只在本次调用中出现，不会被记录或回显。' },
        },
        required: ['appSecret'],
      },
      output: textOutput(),
      timeoutMs: 15000,
      async execute(args) {
        try {
          const role = String(args?.account ?? '').trim()
          const normalized = role ? role : service.store.defaultId()
          if (!normalized) return '❌ 还没有任何账户：先 lark_account_upsert（id / appId / 描述 / 标签）。'
          const acc = service.resolveAccount(normalized)
          if (!acc) return `❌ 账户不存在：${normalized}`
          const r = service.writeSecret(acc.id, args?.appSecret)
          service.invalidateStatus(acc.id)
          const lines = [
            `✅ 已写入账户 ${acc.id} 的 App Secret（${r.bytes} 字节，不回显）`,
            `  文件：${r.file}`,
            `  该文件在仓库外，不进 Git、不进插件包。`,
          ]
          return lines.join('\n')
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'account secret',
  )

  // -------------------------------------------------------------------------
  // 5) lark_login_start / 6) lark_login_finish —— 设备流授权
  // -------------------------------------------------------------------------
  register(
    {
      name: 'lark_login_start',
      description:
        '发起飞书 user 身份授权（设备流），返回 verification_url 让用户浏览器打开或扫码。' +
        'device_code 会存到本地（它是凭据，不回显），用户确认后用 lark_login_finish 完成。' +
        'bot 身份不需要授权，配好 secret 即可用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: '账户 id。省略 = 默认账户。' },
          domains: {
            type: 'array',
            items: { type: 'string' },
            description: '要授权的业务域，例如 ["im","docs","calendar"]。留空 = --recommend。',
          },
          scope: { type: 'string', description: '精确 scope（与 domains 二选一）。' },
          qrcode: { type: 'boolean', description: '同时生成二维码 PNG 到数据目录，便于手机扫。' },
        },
      },
      output: textOutput(),
      timeoutMs: 90000,
      async execute(args) {
        try {
          const r = await service.loginStart({
            account: args?.account ? String(args.account) : undefined,
            domains: args?.domains,
            scope: args?.scope,
            recommend: true,
          })
          const lines = [
            `✅ 已发起授权：账户 ${r.account}`,
            '',
            `授权链接（原样打开，不要改写）：`,
            r.verificationUrl,
            '',
            `有效期：${Math.round((Number(r.expiresIn) || 600) / 60)} 分钟`,
            `device_code 已保存（长度 ${r.deviceCodeLength}），不回显；完成后调 lark_login_finish。`,
          ]
          if (args?.qrcode === true) {
            try {
              const q = await service.loginQrcode({ account: r.account })
              if (!q.ascii) lines.push('', `二维码：${q.file}`)
            } catch (e) {
              lines.push('', `二维码生成失败（不影响授权）：${e.message}`)
            }
          }
          return lines.join('\n')
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'login start',
  )

  register(
    {
      name: 'lark_login_finish',
      description:
        '用户确认授权后完成设备流登录（用本地保存的 device_code；也可显式传 deviceCode）。' +
        '成功后 user 身份可用，能读私人文档/日历/邮件/私聊。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: '账户 id。省略 = 默认账户。' },
          deviceCode: { type: 'string', description: '可选：显式传入 device_code（默认用 lark_login_start 保存的那份）。' },
        },
      },
      output: textOutput(),
      timeoutMs: 200000,
      async execute(args) {
        try {
          const r = await service.loginFinish({
            account: args?.account ? String(args.account) : undefined,
            deviceCode: args?.deviceCode ? String(args.deviceCode) : undefined,
          })
          if (!r.ok) return `❌ 授权未完成\n${r.message || ''}${r.hint ? '\n提示：' + r.hint : ''}`
          return `✅ 授权完成（账户 ${r.account}）\n身份：${r.identity || 'user'}\n下一步：lark_status 确认 user.available=true。`
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'login finish',
  )

  // -------------------------------------------------------------------------
  // 7) lark_call —— 通用执行（快速调用的主力）
  // -------------------------------------------------------------------------
  register(
    {
      name: 'lark_call',
      description:
        '执行任意 lark-cli 命令并返回 JSON。args 用数组（推荐），也可传一整条字符串（自动按引号切词）。' +
        '例：args=["im","+chat-list","--page-size","10","--as","bot"]。' +
        '不传 account 用默认账户；任务跨账户时先 lark_account_search。' +
        '写操作建议先加 --dry-run；高危命令（--yes）需用户确认后才加。结果超长会截断并提示分页。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '命令参数数组（不含 lark-cli 本身）。例如 ["im","+chat-list","--as","bot"]。',
          },
          command: { type: 'string', description: '替代 args 的整条命令字符串，例如 "im +chat-list --page-size 5"。' },
          account: { type: 'string', description: '账户 id。省略 = 默认账户。' },
          timeoutMs: { type: 'number', description: '本次超时毫秒数（默认取配置）。' },
          maxChars: { type: 'number', description: '本次结果最大字符数。' },
        },
      },
      output: textOutput(),
      timeoutMs: 300000,
      async execute(args) {
        try {
          let argv = Array.isArray(args?.args) ? args.args.map(String).filter((s) => s !== '') : []
          if (!argv.length && args?.command) argv = tokenize(args.command)
          if (!argv.length) return '❌ 需要 args（数组）或 command（字符串），例如 ["im","+chat-list","--as","bot"]'
          if (argv[0] === 'lark-cli') argv = argv.slice(1)

          // 守卫：禁止在工具层做交互式/阻塞式登录，避免把整步卡死
          if (argv[0] === 'auth' && argv[1] === 'login' && !argv.includes('--no-wait') && !argv.includes('--device-code')) {
            return '❌ 交互式 auth login 会阻塞。请改用 lark_login_start / lark_login_finish。'
          }
          if (argv[0] === 'config' && argv[1] === 'init') {
            return '❌ config init 是交互式向导；账户已由 lark_account_upsert / lark_account_set_secret 管理。'
          }

          const r = await service.run(argv, {
            accountId: args?.account ? String(args.account) : undefined,
            timeoutMs: Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : undefined,
          })
          return renderCall(r, { maxChars: Number(args?.maxChars) > 0 ? Number(args.maxChars) : maxChars() })
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'call',
  )

  // -------------------------------------------------------------------------
  // 8) lark_schema —— 命令自省（全量索引本地缓存，避免模型瞎猜）
  // -------------------------------------------------------------------------
  register(
    {
      name: 'lark_schema',
      description:
        '查 lark-cli 的命令与参数，避免靠猜反复试错。' +
        'method 留空 → 返回「服务 → 命令」索引（本地缓存，几百字）；' +
        'method 指定（如 "im.messages.delete"）→ 返回该方法精确参数（约 2KB）；' +
        'service 指定（如 "im"）→ 返回该域的 --help（含 +快捷键与风险等级）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', description: '精确方法名，例如 "im.messages.delete" 或 "im messages delete"。' },
          service: { type: 'string', description: '业务域，例如 im / docs / base / calendar / sheets。' },
          refresh: { type: 'boolean', description: '强制刷新本地 schema 缓存。' },
        },
      },
      output: textOutput(),
      timeoutMs: 120000,
      async execute(args) {
        try {
          if (args?.method) {
            const want = normalizeMethodName(args.method)
            const { list, cached } = await service.schemaList({ refresh: args?.refresh === true })
            const hit = findMethod(list, want)
            if (!hit) return `❌ 没有方法 ${want}。先用 lark_schema（留空 method）看索引，或 lark_schema service="im" 看该域命令。`
            const text = JSON.stringify(redactDeep(hit), null, 2)
            return `${cached ? '（本地缓存）\n' : ''}${truncate(text, maxChars()).text}`
          }
          if (args?.service) {
            const h = await service.domainHelp(String(args.service))
            if (!h.ok) return `❌ ${String(args.service)} --help 失败（exit ${h.exitCode}）\n${truncate(h.text, maxChars()).text}`
            return truncate(h.text, maxChars()).text
          }
          const { list, cached } = await service.schemaList({ refresh: args?.refresh === true })
          const summary = summarizeSchema(list)
          const lines = [`# lark-cli 命令索引（共 ${summary.total} 个方法，${cached ? '本地缓存' : '刚拉取'}）`, '']
          for (const [service, items] of Object.entries(summary.services)) {
            lines.push(`${service}（${items.length}）`)
            lines.push('  ' + items.map((i) => i.n).join(' · '))
            lines.push('')
          }
          lines.push('用法：lark_schema method="im.messages.delete" 看精确参数；lark_schema service="im" 看该域快捷键与风险等级。')
          return truncate(lines.join('\n'), maxChars()).text
        } catch (e) {
          if (e instanceof CliMissingError) return `❌ ${e.message}`
          return `❌ ${e.message}`
        }
      },
    },
    'schema',
  )

  // -------------------------------------------------------------------------
  // 9) lark_doctor —— 自检（缺什么、下一步做什么）
  // -------------------------------------------------------------------------
  register(
    {
      name: 'lark_doctor',
      description:
        '本机自检：二进制在不在、数据目录在哪、有几个账户、凭据是否就绪、默认账户是谁、user 是否已授权。' +
        '换机器后先跑这个，它会直接告诉你缺什么、下一步该调哪个工具。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      timeoutMs: 120000,
      async execute() {
        const layout = service.layout()
        const accounts = service.store.list()
        const defaultId = service.store.defaultId()
        const lines = ['# lark-cli 自检', '']
        lines.push(`二进制  ${layout.binaryExists ? '✅' : '❌'} ${layout.binary}`)
        if (layout.binaryExists) {
          try {
            lines.push(`版本    ${await service.version()}`)
          } catch {
            lines.push('版本    ?')
          }
        } else {
          lines.push('修复：在插件目录运行 .\\scripts\\fetch-lark-cli.ps1（官方 SHA256 校验）')
        }
        lines.push(`数据目录 ${layout.dataDir}`)
        lines.push(`账户表   ${layout.accountsFile}${accounts.length ? `（${accounts.length} 个）` : '（空）'}`)
        lines.push('')

        if (!accounts.length) {
          lines.push('还没有账户。下一步：')
          lines.push('  1) lark_account_upsert  id="work" label="公司主账号" appId="cli_xxx" description="..." tags=[...]')
          lines.push('  2) lark_account_set_secret account="work" appSecret="..."')
          lines.push('  3) lark_login_start account="work"（bot 身份此时已可用）')
          if (fs.existsSync(layout.legacyDir)) {
            lines.push('')
            lines.push(`检测到旧凭据 ${layout.legacyDir}。autoMigrate 开启时会自动导入为 default；也可手动导入。`)
          }
          return lines.join('\n')
        }

        lines.push(`默认账户 ${defaultId || '(无)'}`)
        lines.push('')
        for (const a of accounts) {
          const hasSecret = service.hasSecret(a.id)
          let state = '未探测'
          try {
            const st = await service.status({ account: a.id })
            const b = st.identities?.bot?.available ? 'bot✅' : 'bot❌'
            const u = st.identities?.user?.available ? 'user✅' : 'user❌'
            state = `${b} ${u}`
          } catch (e) {
            state = `探测失败：${e.message}`
          }
          lines.push(`- ${a.id === defaultId ? '★ ' : ''}${a.id}（${a.label}）secret${hasSecret ? '✅' : '❌'} ${state}`)
          if (!hasSecret) lines.push(`    下一步：lark_account_set_secret account="${a.id}"`)
          else if (/user❌/.test(state)) lines.push(`    需要 user 身份时：lark_login_start account="${a.id}"`)
        }
        return lines.join('\n')
      },
    },
    'doctor',
  )

  // -------------------------------------------------------------------------
  // HTTP 路由（设置面板用）—— 只接受 loopback + 同源
  // -------------------------------------------------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    const isLoopbackHost = (host) => {
      if (!host) return false
      const h = String(host).split(':')[0].replace(/^\[|\]$/g, '')
      return h === '127.0.0.1' || h === '::1' || h === 'localhost'
    }
    const guard = (req, res) => {
      const deny = (why) => {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: why }))
        return false
      }
      const ra = req.socket?.remoteAddress || ''
      if (!(ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')) return deny('forbidden: non-local origin')
      if (!isLoopbackHost(req.headers?.host)) return deny('forbidden: non-loopback host')
      const origin = req.headers?.origin
      if (origin) {
        let oh = ''
        try {
          oh = new URL(origin).host
        } catch {
          return deny('forbidden: bad origin')
        }
        if (!isLoopbackHost(oh)) return deny('forbidden: cross-origin')
      }
      return true
    }
    const readBody = (req) =>
      new Promise((resolve) => {
        let raw = ''
        req.on('data', (c) => {
          raw += c
          if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000)
        })
        req.on('end', () => {
          try {
            resolve(raw ? JSON.parse(raw) : {})
          } catch {
            resolve({})
          }
        })
        req.on('error', () => resolve({}))
      })
    const json = (res, code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload, null, 2))
    }

    // 读：完整快照
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/status',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const url = new URL(req.url || '/', 'http://127.0.0.1')
              const refresh = url.searchParams.get('refresh') === '1'
              const snap = await service.snapshot({ refresh })
              const layout = service.layout()
              let version = ''
              try {
                version = layout.binaryExists ? await service.version() : ''
              } catch {
                /* ignore */
              }
              json(res, 200, { ok: true, snapshot: snap, layout, version })
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: status route',
    )

    // 写：账户增改（绝不接受 secret 字段）
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/account',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = await readBody(req)
              for (const k of Object.keys(body)) {
                if (/^(secret|appsecret|token|password|pat)$/i.test(k)) {
                  return json(res, 400, { ok: false, error: '这个接口不接受密钥；请用工具 lark_account_set_secret' })
                }
              }
              const v = validateAccountInput({ id: body.id, appId: body.appId, brand: body.brand, tags: body.tags })
              if (!v.ok) return json(res, 400, { ok: false, error: v.errors.join('; ') })
              const acc = service.store.upsert({
                id: body.id,
                label: body.label,
                description: body.description,
                tags: body.tags,
                appId: body.appId,
                brand: body.brand,
                makeDefault: body.makeDefault === true,
              })
              service.invalidateStatus(acc.id)
              json(res, 200, { ok: true, account: acc })
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: account route',
    )

    // 写：设默认
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/default',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = await readBody(req)
              if (!ACCOUNT_ID_RE.test(String(body.id || ''))) return json(res, 400, { ok: false, error: 'bad id' })
              const id = service.store.setDefault(String(body.id))
              service.invalidateStatus(id)
              json(res, 200, { ok: true, default: id })
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: default route',
    )

    // 写：发起授权（返回链接，供面板划出）
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/login-start',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = await readBody(req)
              const r = await service.loginStart({ account: body.account ? String(body.account) : undefined, domains: body.domains })
              json(res, 200, { ok: true, ...r })
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: login route',
    )
  })

  // 注意：不要在这里调用 ctx.set()/ctx.provide() 之类未验证的 API。
  // 早先写过 `ctx.set?.('larkcli', service)`：本版本 Cordis 上下文没有这个方法，
  // 而 apply 里抛出的异常会让**整个插件静默失效**（工具不注册、路由不存在、界面不出现），
  // 排查成本极高。跨插件共享不是需求，所以直接去掉。
}

export { DERIVED }
