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
              /*
               * CLI 原话：生成文件只是第一步，必须把图真的显示出来，否则等于没做。
               * 工具只能返回文本，所以直接返回 Markdown 图片语法 —— 调用方原样转发即可，
               * 比自己再拼一遍路径可靠。
               */
              if (!q.ascii) {
                // Windows 反斜杠会把 Markdown 图片语法打断（\U 之类会被当转义），统一成正斜杠
                const shown = String(q.file).replace(/\\/g, '/')
                lines.push('', '手机飞书扫这个码：', '', `![登录二维码](${shown})`, '', `（图在 ${q.file}）`)
              }
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
          lines.push('修复：调 lark_install（action="install"）—— 从镜像下载 + SHA256 校验 + 原子替换，自动就位')
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

  // ---------------------------------------------------------------------------
  // 10) lark_install —— 安装 / 升级 lark-cli（换镜像、离线、幂等）
  // ---------------------------------------------------------------------------
  register(
    {
      name: 'lark_install',
      description:
        '安装或升级插件自带的 lark-cli.exe（从 npmmirror 镜像下载，官方 SHA256 校验，原子替换，失败自动回滚）。' +
        'action="check" 只看本机与最新版（快速，不发命令）；action="install" 升到最新（已是新版则跳过）；' +
        'version="1.0.100" 指定版本（也可降级）；force=true 强制重装。' +
        'GitHub 在本机不通，所以只走 npmmirror；镜像不可达会如实报 reachable=false。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['check', 'install'], description: 'check（默认，只体检）或 install（下载并替换）。' },
          version: { type: 'string', description: '目标版本，如 "1.0.100"。省略 = 最新。' },
          force: { type: 'boolean', description: '版本相同也重新下载安装。' },
        },
      },
      output: textOutput(),
      timeoutMs: 600000,
      async execute(args) {
        try {
          const action = args?.action === 'install' ? 'install' : 'check'
          if (action === 'check') {
            const st = await service.checkUpdate()
            const lines = ['# lark-cli 安装体检', '']
            lines.push(`本机   ${st.installed || '(未知)'}  ${st.installed ? '✅' : '❌ 未安装'}`)
            lines.push(`最新   ${st.latest || '(查询失败)'}`)
            lines.push(`镜像   ${st.reachable ? '✅ 可达（registry.npmmirror.com）' : '❌ 不可达'}`)
            if (st.error) lines.push(`原因   ${st.error}`)
            lines.push('')
            lines.push(st.updateAvailable ? `可升级到 ${st.latest}：lark_install  action="install"` : st.installed ? '已是最新，无需操作。' : '尚未安装：lark_install  action="install"')
            return lines.join('\n')
          }
          const logs = []
          const r = await service.installCli({
            version: args?.version ? String(args.version) : '',
            force: args?.force === true,
            onLog: (m) => logs.push(String(m)),
          })
          const lines = [`${r.ok ? '✅' : '❌'} ${r.changed ? '已安装' : '无需变更'}${r.version ? ` → ${r.version}` : ''}`, '']
          for (const m of logs) lines.push(`  ${m}`)
          if (r.ok) {
            lines.push('', `exe      ${r.exe}`)
            if (r.sha256) lines.push(`SHA256   ${r.sha256}`)
            if (r.previousVersion && r.changed) lines.push(`原版本   ${r.previousVersion}`)
            lines.push('', '下一步：lark_status 确认新版本可用；改了 index.js 需重启 App，仅改 client.js 刷页面即可。')
          } else {
            lines.push('', `失败原因：${r.error || '未知'}`)
            lines.push('旧版本仍在原位（原子替换 + 回滚），不影响现有功能。')
          }
          return lines.join('\n')
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'install',
  )

  // ---------------------------------------------------------------------------
  // 11) lark_identity —— 这个账户到底是哪个应用、哪个人
  // ---------------------------------------------------------------------------
  register(
    {
      name: 'lark_identity',
      description:
        '查账户的真实身份：应用名 / 头像 / 描述 / owner / 发版状态，以及已授权的用户姓名、邮箱、工号。' +
        '不传 account 且 all=true 时列出**所有**账户的身份（多账号对照用）。' +
        '这些信息比 lark_status 详细得多（要额外 2-3 次 API），所以单独成一个工具。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: '账户 id。省略 = 默认账户。' },
          all: { type: 'boolean', description: '列出所有账户（忽略 account）。' },
          verify: {
            type: 'boolean',
            description: '向服务端验证 token 真的还有效（每账户 +1.1s）。不传只报「存在」而不报「有效」。',
          },
        },
      },
      output: textOutput(),
      timeoutMs: 180000,
      async execute(args) {
        try {
          const { describeAccount, identityLine } = await import('./identity.js')
          const accounts = service.store.list()
          if (!accounts.length) return '还没有任何账户。先 lark_account_upsert + lark_account_set_secret。'
          // resolveAccount 处理「显式 id > 默认账户」；不能用 store.get() —— 它不传 id 直接返回 undefined
          let targets
          try {
            targets = args?.all === true ? accounts : [service.resolveAccount(args?.account ? String(args.account) : undefined)].filter(Boolean)
          } catch (e) {
            return `❌ ${e.message}`
          }
          if (!targets.length) return '没有可用账户（账户表为空，或默认账户指向了不存在的 id）。先 lark_account_upsert。'
          const lines = []
          for (const a of targets) {
            if (!a) continue
            const info = await describeAccount({ service, account: a, verify: args?.verify === true })
            lines.push(`## ${a.id}${a.id === service.store.defaultId() ? ' ★默认' : ''}（${a.label}）`)
            lines.push(`   ${identityLine(info)}`)
            if (info.app) {
              if (info.app.appId) lines.push(`   appId    ${info.app.appId}`)
              if (info.app.botOpenId) lines.push(`   bot      ${info.app.botOpenId}`)
              if (info.app.ownerId) lines.push(`   owner    ${info.app.ownerId}`)
              if (info.app.onlineVersionId) lines.push(`   线上版本 ${info.app.onlineVersionId}`)
              if (info.app.callbackType) lines.push(`   回调      ${info.app.callbackType}`)
            }
            const scopeN = Object.keys(info.appScopes || {}).length
            if (scopeN) lines.push(`   应用已开通权限 ${scopeN} 条`)
            if (info.userProfile) {
              const u = info.userProfile
              const bits = [u.name, u.email, u.jobTitle, u.employeeNo].filter(Boolean)
              lines.push(`   用户     ${bits.join(' / ') || '(无字段)'}`)
            } else {
              lines.push(`   用户     未授权 user 身份 → lark_login_start account="${a.id}"`)
            }
            for (const err of info.errors || []) lines.push(`   ⚠️ ${err}`)
            lines.push('')
          }
          return lines.join('\n').trim()
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'identity',
  )

  // ---------------------------------------------------------------------------
  // 12) lark_scopes —— 权限清单 + 一条预填好的申请链接
  // ---------------------------------------------------------------------------
  register(
    {
      name: 'lark_scopes',
      description:
        '列权限清单并算差集：哪些应用侧已开通、哪些用户侧已授权、还缺什么，并直接给出**已预填 scope 的申请链接**（用户点开只需确认）。' +
        'profile 可选 read / standard / full（默认 standard）。' +
        'grant=true 会顺手发起设备流授权，返回 verification_url（一条链接，用户点确认即可）。' +
        '不传 domains 时用 profile 预置的域。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: '账户 id。省略 = 默认账户。' },
          profile: { type: 'string', enum: ['read', 'standard', 'full'], description: '能力档位，默认 standard。' },
          domains: { type: 'array', items: { type: 'string' }, description: '自定义域列表，覆盖 profile。' },
          grant: { type: 'boolean', description: '同时发起 user 设备流授权（返回一条链接）。' },
          detail: { type: 'boolean', description: '逐条列出 scope（默认只按域汇总）。' },
        },
      },
      output: textOutput(),
      timeoutMs: 180000,
      async execute(args) {
        try {
          // 同 lark_identity：store.get() 不传 id 返回 undefined，必须走 resolveAccount
          let acc
          try {
            acc = service.resolveAccount(args?.account ? String(args.account) : undefined)
          } catch (e) {
            return `❌ ${e.message}`
          }
          if (!acc) return '还没有任何账户。先 lark_account_upsert + lark_account_set_secret。'
          const S = await import('./scopes.js')
          const profileName = ['read', 'standard', 'full'].includes(String(args?.profile)) ? String(args.profile) : 'standard'
          const profile = S.PROFILES[profileName]
          const domains = Array.isArray(args?.domains) && args.domains.length ? args.domains.map(String) : profile.domains
          const { list } = await service.schemaList()
          const want = S.scopesForDomains({ domains, methods: list, readOnly: profileName === 'read' })

          // 应用侧已开通（application v6）；拿不到就退化为「未知」，不编造
          const ident = await import('./identity.js')
          const ai = acc.appId ? await ident.appInfo(service, acc.id, acc.appId, acc.brand || 'feishu') : { scopes: {}, error: '账户没登记 appId' }
          const granted = ai.scopes || {}
          const userScopes = await service.run(['auth', 'scopes', '--json'], { accountId: acc.id, timeoutMs: 20000 }).then((r) => (r.ok ? r.json?.userScopes || r.json?.data?.userScopes || [] : [])).catch(() => [])
          // 未开通的 scope 在开放平台返回里没有 token_types，靠 schema 补上，否则用户侧缺口会虚报
          const schemaTokens = S.tokenTypesFromSchema(list)
          const g = S.groupForDisplay({ wanted: want.scopes, appGranted: granted, userGranted: userScopes, schemaTokens })
          const lines = [`# 权限清单（账户 ${acc.id}｜档位 ${profileName}）`, '']

          for (const grp of g.groups) {
            const flag = grp.missingTenant || grp.missingUser ? '⚠️' : '✅'
            lines.push(`${flag} ${grp.label}（${grp.domain}）  ${grp.rows.length} 条${grp.missingTenant ? `｜应用缺 ${grp.missingTenant}` : ''}${grp.missingUser ? `｜用户缺 ${grp.missingUser}` : ''}`)
            if (args?.detail === true) {
              for (const row of grp.rows) {
                const st = row.appGranted ? (row.userGranted ? '✅' : 'app✅ user❌') : '❌ 未开通'
                lines.push(`    ${st}  ${row.scope}${row.description ? `  — ${row.description}` : ''}`)
              }
            }
          }

          lines.push('')
          if (g.tenantMissing.length) {
            lines.push(`应用侧缺 ${g.tenantMissing.length} 条 → 打开这条链接，权限已勾好，按「确认」即可：`)
            lines.push(S.consoleApplyUrl({ appId: acc.appId, scopes: g.tenantMissing, brand: acc.brand || 'feishu' }))
            lines.push('（申请后要在开放平台「创建版本并发布」，权限才生效。）')
          } else {
            lines.push('应用侧：该档位所需权限已全部开通 ✅')
          }
          if (!Object.keys(granted).length) lines.push(`⚠️ 读不到应用已开通的权限清单：${ai.error || '未知'}——上面「应用缺」的数字可能不准。`)

          lines.push('')
          if (g.userMissing.length) {
            lines.push(`用户侧缺 ${g.userMissing.length} 条（user 身份才需要；bot 身份不受影响）`)
            lines.push(`  一条命令授权：lark_login_start account="${acc.id}"${profileName === 'full' ? '（--recommend 全量）' : ` domains=${JSON.stringify(domains)}`}`)
          } else {
            lines.push('用户侧：已授权 ✅')
          }

          if (args?.grant === true) {
            const r = await service.loginStart({
              account: acc.id,
              domains: profileName === 'full' ? undefined : domains,
              recommend: true,
            })
            lines.push('', '## 已发起用户授权（打开链接按确认）', r.verificationUrl, `有效期 ${Math.round((Number(r.expiresIn) || 600) / 60)} 分钟；完成后调 lark_login_finish（device_code 已存本地）。`)
          }

          return lines.join('\n')
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'scopes',
  )

  // ---------------------------------------------------------------------------
  // 13) lark_read_doc —— 给个链接就去查（自动选账户/身份）
  // ---------------------------------------------------------------------------
  register(
    {
      name: 'lark_read_doc',
      description:
        '给一个飞书链接就去读，**不用说明是哪个账户**：自动识别链接类型（docx/docs/wiki/sheets/base/slides/file），' +
        '在账户池里依次尝试（默认账户优先），user 身份不行自动退 bot，最后返回内容和「实际用了哪个账户」。' +
        '支持 8 种链接形态；链接本身就是错的（如 token 不存在）会立刻停，不会在所有账户上白跑。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: '飞书链接（也接受裸 token，配合 type 使用）。' },
          type: { type: 'string', enum: ['docx', 'doc', 'sheet', 'base', 'wiki', 'slides', 'mindnotes', 'file', 'minutes', 'unknown'], description: '覆盖自动识别的类型。' },
          account: { type: 'string', description: '只试这个账户（默认按池化依次尝试）。' },
          identity: { type: 'string', enum: ['auto', 'user', 'bot'], description: '身份偏好，默认 auto（user 先、bot 后）。' },
        },
      },
      output: textOutput(),
      timeoutMs: 300000,
      async execute(args) {
        try {
          const url = String(args?.url || '').trim()
          if (!url) return '❌ 需要 url'
          const { readDocByUrl } = await import('./resolver.js')
          const pref = String(args?.identity || 'auto')
          const asOrder = pref === 'user' ? ['user'] : pref === 'bot' ? ['bot'] : ['user', 'bot']
          const trace = []
          const r = await readDocByUrl({
            service,
            url,
            type: args?.type ? String(args.type) : '',
            account: args?.account ? String(args.account) : '',
            as: asOrder,
            log: (line) => trace.push(line),
          })
          const lines = []
          if (r.ok) {
            lines.push(`✅ ${r.kindLabel}｜账户 ${r.account}（${r.accountLabel || ''}）｜身份 ${r.identity}`)
            lines.push(`${r.label}`)
            lines.push(`尝试 ${r.attempts.length} 次（前面失败的是权限/身份问题，已自动绕过）`)
            lines.push('')
            const text = typeof r.json === 'string' ? r.json : JSON.stringify(redactDeep(r.json ?? r.raw), null, 2)
            const t = truncate(text, maxChars())
            lines.push(t.text)
            if (t.truncated) lines.push('（已截断；需要全文用 lark_call args=[...] 自己加 --output）')
          } else {
            lines.push(`❌ 读不到：${r.error}`)
            if (r.hint) lines.push(`提示：${r.hint}`)
            lines.push('')
            lines.push('尝试记录：')
            for (const line of trace.slice(-12)) lines.push(`  ${line}`)
          }
          return lines.join('\n')
        } catch (e) {
          return `❌ ${e.message}`
        }
      },
    },
    'read doc',
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
    /*
     * login-finish：面板的「我已完成授权」按钮打这里。
     * 为什么必须有这条：设备流本身是两步（发码 / 用 device_code 兑换 token），
     * 原先第二步只能靠会话里的 lark_login_finish 工具 —— 用户刚在浏览器/手机上点完，
     * 还要回聊天窗说一句“我授权完了”才能生效，这是目标④里最膈应人的一跳。
     */
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/login-finish',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = await readBody(req)
              const r = await service.loginFinish({ account: body.account ? String(body.account) : undefined })
              json(res, 200, { ok: !!r.ok, ...r })
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: login-finish route',
    )

    /*
     * HTTP 路由的设计约束（与工具层不同）：
     *   - 路由只能做“面板需要的事”，不能变成绕过 guard 的通用 lark-cli 网关。
     *     所以这里没有 /call 路由：任意子命令必须走工具（有沙箱与审批）。
     *   - 每个写操作都可能触发子进程，统一给 120s；超时在 service 里收。
     *   - 返回值一律是给人看的结构化数据，不需要面板再拼字符串。
     */

    // 读：安装体检（本机/最新/镜像可达）
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/check-update',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const layout = service.layout()
              const st = await service.checkUpdate({})
              json(res, 200, { ok: true, ...st, exe: layout.binary || '' })
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: check-update route',
    )

    // 写：安装/升级 lark-cli（下载 + SHA256 校验 + 原子替换）
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/install',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = await readBody(req)
              const r = await service.installCli({
                version: body.version ? String(body.version) : undefined,
                force: body.force === true,
                // 不接日志：这份上下文里没有 logger，引用它会抛 ReferenceError，
                // 而那会让整个 install 路由 500 —— 面板上就变成「按钮点了没反应」。
                // 进度信息已经在返回值 log 数组里，前端直接展示。
              })
              json(res, r.ok ? 200 : 500, r)
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: install route',
    )

    // 读：账户身份（应用名/描述/头像、bot、user、已开通权限数）
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/identity',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const url = new URL(req.url || '/', 'http://127.0.0.1')
              const only = url.searchParams.get('account') || ''
              // verify=1 才打服务端（每账户 +1.1s，默认关）
              const verify = url.searchParams.get('verify') === '1'
              const I = await import('./identity.js')
              const accounts = only ? service.store.list().filter((a) => a.id === only) : service.store.list()
              const out = []
              for (const acc of accounts) {
                try {
                  out.push(await I.describeAccount({ service, account: acc, withApp: true, verify }))
                } catch (e) {
                  out.push({ id: acc.id, errors: [String((e && e.message) || e)] })
                }
              }
              json(res, 200, { ok: true, accounts: out })
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: identity route',
    )

    // 读：权限清单（应用缺 / 用户缺，带一键申请链接）
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/scopes',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const url = new URL(req.url || '/', 'http://127.0.0.1')
              const only = url.searchParams.get('account') || ''
              const profile = ['read', 'standard', 'full'].includes(url.searchParams.get('profile') || '')
                ? url.searchParams.get('profile')
                : 'read'
              const S = await import('./scopes.js')
              const I = await import('./identity.js')
              const accounts = only ? service.store.list().filter((a) => a.id === only) : service.store.list()
              const out = []
              for (const acc of accounts) {
                try {
                  const { list } = await service.schemaList()
                  // PROFILES[x] 是对象（{label,domains,note}），不是数组 —— 直接传会变成 domains=undefined
                  // 而 scopesForDomains 对 undefined 返回空集，面板就静默显示「零缺口」（最坏的假绿）。
                  const domains = S.PROFILES[profile].domains
                  const want = S.scopesForDomains({ domains, methods: list, readOnly: profile === 'read' })
                  const info = await I.describeAccount({ service, account: acc, withApp: true })
                  const granted = info.appScopes || {}
                  const userScopes = await service
                    .run(['auth', 'scopes', '--json'], { accountId: acc.id, timeoutMs: 20000 })
                    .then((r) => (r.ok ? r.json?.userScopes || r.json?.data?.userScopes || [] : []))
                    .catch(() => [])
                  const schemaTokens = S.tokenTypesFromSchema(list)
                  const g = S.groupForDisplay({ wanted: want.scopes, appGranted: granted, userGranted: userScopes, schemaTokens })
                  out.push({
                    id: acc.id,
                    profile,
                    groups: g.groups,
                    tenantMissing: want.scopes.filter((s) => g.tenantMissing.includes(s)),
                    userMissingCount: g.userMissing.length,
                    applyUrl: g.tenantMissing.length ? S.consoleApplyUrl({ appId: acc.appId, scopes: g.tenantMissing, brand: acc.brand }) : '',
                    consoleUrl: S.appConsoleUrl({ appId: acc.appId, brand: acc.brand }),
                  })
                } catch (e) {
                  out.push({ id: acc.id, error: String((e && e.message) || e) })
                }
              }
              json(res, 200, { ok: true, accounts: out })
            } catch (err) {
              json(res, 500, { ok: false, error: String((err && err.message) || err) })
            }
          },
        }),
      'larkcli: scopes route',
    )

    /*
     * 二维码：直接回 PNG 字节，不回 JSON。
     * 为什么不出 base64 让面板拼 data: URL：v3 的 data: 图没有 CORS 问题，
     * 但二维码 PNG 每次刷新都变（CLI 现画），走真实 URL 才能用浏览器缓存语义与 304。
     */
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/larkcli/qrcode',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const url = new URL(req.url || '/', 'http://127.0.0.1')
              const account = url.searchParams.get('account') || undefined
              const q = await service.loginQrcode({ account })
              if (!q.exists || !q.file) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                return res.end(JSON.stringify({ ok: false, error: '二维码没生成出来' }))
              }
              const png = await fs.promises.readFile(q.file)
              res.writeHead(200, {
                'content-type': 'image/png',
                'content-length': png.length,
                'cache-control': 'no-store',
              })
              res.end(png)
              /*
               * 二维码 PNG 是一次性的：每次 auth login 的 flow_id 都不同，旧码扫了只会报错。
               * 所以回完立刻删，不留在 temp 里慢慢积（面板每 30 秒刷新一次就会再画一张）。
               */
              try {
                fs.rmSync(path.dirname(q.file), { recursive: true, force: true })
              } catch {
                /* ignore */
              }
            } catch (err) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
            }
          },
        }),
      'larkcli: qrcode route',
    )
  })

  // 注意：不要在这里调用 ctx.set()/ctx.provide() 之类未验证的 API。
  // 早先写过 `ctx.set?.('larkcli', service)`：本版本 Cordis 上下文没有这个方法，
  // 而 apply 里抛出的异常会让**整个插件静默失效**（工具不注册、路由不存在、界面不出现），
  // 排查成本极高。跨插件共享不是需求，所以直接去掉。
}

export { DERIVED }
