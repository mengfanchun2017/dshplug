/**
 * dsh-larkcli · 权限清单（scope manifest）
 *
 * 要解决的问题：飞书权限有**两套**，混在一起讲永远讲不清：
 *
 *   ① 应用侧（tenant / bot token）—— 权限由**开发者**在开放平台申请，申请完还要发版；
 *      用户点一次「确认」是把这些权限**批量勾选提交**，之后不需要再给。
 *   ② 用户侧（user token）—— 权限由**用户本人**在设备流页面授权，可以随时撤销。
 *
 * 所以这里不做「一句话告诉你缺权限」，而是：
 *   列清单（哪条、属于哪套、干什么用）→ 算差集（已有哪些 / 还缺哪些）
 *   → 生成**一条预填好的链接**（应用侧走 scope-apply，用户侧走设备流），
 *     用户点开只需按「确认」。
 *
 * 数据来源，优先级从高到低：
 *   1) `lark-cli schema` 的 `_meta.scopes` / `_meta.access_tokens` —— 随 CLI 版本走，最准
 *   2) 开放平台 `application/v6/applications/<appId>` —— 带中文描述 + 等级 + 令牌类型
 *   3) SUPPLEMENT —— 只补 schema 里没有的域（docs / base / markdown / event / apps / note），
 *      这六个域走的是 `+快捷键` 而不是 typed method，所以不进 schema
 */

/**
 * schema 没覆盖的域。这里的 scope 名取自开放平台文档与 lark-cli 报错时的
 * `console_url`，不是猜的：凡是本文件里写下的，都能在飞书权限列表里搜到。
 */
export const SUPPLEMENT = {
  docs: {
    label: '云文档（Docx）',
    why: '读/写新版文档正文、评论',
    read: ['docx:document:readonly', 'docs:document.comment:read'],
    write: ['docx:document:write_only', 'docx:document.block:convert', 'docs:document.comment:write_only'],
    tenantOnly: false,
  },
  base: {
    label: '多维表格（Base）',
    why: '读/写多维表格的表、字段、记录、视图',
    read: ['bitable:app:readonly'],
    write: ['bitable:app', 'base:app:update'],
    tenantOnly: false,
  },
  markdown: {
    label: 'Markdown 文件',
    why: '飞书原生 Markdown 文件的读写',
    read: ['docx:document:readonly'],
    write: ['docx:document:write_only'],
    tenantOnly: false,
  },
  event: {
    label: '事件订阅',
    why: '实时接收消息/审批/任务等事件（长跑订阅用）',
    read: [],
    write: [],
    tenantOnly: true,
  },
  apps: {
    label: '妙搭应用',
    why: '妙搭（Spark/Miaoda）应用的创建与托管',
    read: [],
    write: [],
    tenantOnly: true,
  },
  note: {
    label: '会议纪要',
    why: '妙记/纪要读取（走 lark-meeting）',
    read: ['minutes:minutes:readonly'],
    write: [],
    tenantOnly: false,
  },
}

/**
 * 开箱可选的「能力档位」。
 *
 * `domains` 直接喂给 `lark-cli auth login --domain a,b,c`；
 * `readOnly` 只影响清单展示的口径说明，不改变 CLI 行为
 * （CLI 的 --domain 是把该域**全部** scope 一起要，粒度到域，不到 read/write）。
 */
export const PROFILES = {
  read: {
    label: '只读（最省事，够查文档/表格/消息）',
    domains: ['docs', 'drive', 'sheets', 'base', 'wiki', 'contact'],
    note: '只申请读类权限。够「给我个链接我读一下」这类用法。',
  },
  standard: {
    label: '标准（推荐：读 + 发消息 + 日历 + 任务）',
    domains: ['docs', 'drive', 'sheets', 'base', 'wiki', 'contact', 'im', 'calendar', 'task'],
    note: '日常工作最常用的一组。不含邮件与审批的写入。',
  },
  full: {
    label: '全部（--recommend，一次授权到底）',
    domains: ['all'],
    note: '等价 lark-cli auth login --recommend。一次点确认，之后不用再补。',
  },
}

/** 域 → 中文名（--domain 的取值就是这些 key）。 */
export const DOMAIN_LABELS = {
  application: '应用信息',
  approval: '审批',
  apps: '妙搭应用',
  attendance: '考勤',
  base: '多维表格',
  calendar: '日历',
  contact: '通讯录',
  docs: '云文档',
  drive: '云空间',
  event: '事件订阅',
  im: '即时消息',
  markdown: 'Markdown 文件',
  mindnotes: '思维笔记',
  minutes: '会议纪要',
  note: '妙记',
  okr: 'OKR 目标',
  sheets: '电子表格',
  slides: '幻灯片',
  task: '任务',
  vc: '视频会议',
  wiki: '知识库',
  all: '全部',
}

/**
 * 从 schema 方法表里抽出「域 → scope → 令牌类型」。
 *
 * @param {Array} methods `lark-cli schema` 的返回（数组）
 * @returns {Record<string, {scopes: Record<string, Set<string>>}>}
 */
export function scopesFromSchema(methods) {
  const out = {}
  for (const m of Array.isArray(methods) ? methods : []) {
    const name = String(m?.name || '')
    const domain = name.split(/\s+/)[0]
    if (!domain) continue
    if (!out[domain]) out[domain] = {}
    const toks = Array.isArray(m?._meta?.access_tokens) ? m._meta.access_tokens : []
    for (const sc of Array.isArray(m?._meta?.scopes) ? m._meta.scopes : []) {
      if (!out[domain][sc]) out[domain][sc] = new Set()
      for (const t of toks) out[domain][sc].add(t)
    }
  }
  return out
}

/**
 * 某档位要申请的全部 scope。
 *
 * @param {object} opts
 * @param {string|string[]} opts.domains  域列表，或 'all'
 * @param {Array} [opts.methods]          schema 方法表（决定 schema 侧 scope）
 * @param {boolean} [opts.includeWrite]   是否带上写类（默认 true，因为 --domain 本身不带粒度）
 * @param {string[]} [opts.exclude]       显式排除
 * @returns {{scopes: string[], byDomain: Record<string,string[]>, unknownDomains: string[]}}
 */
export function scopesForDomains({ domains, methods = [], includeWrite = true, readOnly = false, exclude = [] } = {}) {
  const list = Array.isArray(domains) ? domains : String(domains || '').split(',').map((s) => s.trim()).filter(Boolean)
  const want = list.includes('all') ? Object.keys(DOMAIN_LABELS).filter((d) => d !== 'all') : list
  const fromSchema = scopesFromSchema(methods)
  const excluded = new Set(exclude.map((s) => String(s).trim()).filter(Boolean))
  const write = includeWrite && !readOnly

  const byDomain = {}
  const seen = new Set()
  const unknownDomains = []

  for (const domain of want) {
    const set = new Set()
    const schemaSide = fromSchema[domain]
    if (schemaSide) for (const sc of Object.keys(schemaSide)) set.add(sc)
    const sup = SUPPLEMENT[domain]
    if (sup) {
      for (const sc of sup.read || []) set.add(sc)
      if (write) for (const sc of sup.write || []) set.add(sc)
    }
    if (!schemaSide && !sup) unknownDomains.push(domain)

    let kept = [...set].filter((sc) => !excluded.has(sc))
    if (!write) kept = kept.filter(isReadScope)
    kept = kept.sort()
    byDomain[domain] = kept
    for (const sc of kept) seen.add(sc)
  }

  return { scopes: [...seen].sort(), byDomain, unknownDomains }
}

/**
 * 这条 scope 是不是读类。
 * 飞书命名不完全统一（`docs:doc` 就是读、`drive:drive` 读写都有），
 * 所以先看显式的写标记，再看显式的读标记，最后看「裸权限」——
 * 裸权限（`drive:drive`、`bitable:app`）实测**含写**，只读场景算作写类保守排除。
 */
export function isReadScope(scope) {
  const s = String(scope || '')
  if (/write_only|writeonly|:write$|:write|create|delete|update|upload|copy|transfer|move|import/i.test(s)) return false
  if (/readonly|:read$|\.read$|:read\b|retrieve|read_one|basic_info|list/i.test(s)) return true
  // 裸权限：保守当写类（只读档位里不申请）
  return false
}

/**
 * 应用侧已开通的 scope（来自开放平台 application v6）。
 * 返回 `{ scope → {description, level, tokenTypes} }`，用于「已开通」与中文说明。
 */
export function appScopesOf(appInfo) {
  const out = {}
  const arr = appInfo?.app?.scopes
  if (!Array.isArray(arr)) return out
  for (const s of arr) {
    const key = String(s?.scope || '').trim()
    if (!key) continue
    out[key] = {
      description: String(s.description || ''),
      level: Number(s.level) || 0,
      tokenTypes: Array.isArray(s.token_types) ? s.token_types : [],
    }
  }
  return out
}

/**
 * 差集：要申请的 vs 已开通/已授权的。
 *
 * 关键区分：
 *   - `tenant` 令牌的 scope 必须**应用先申请**，用户授权也没用 → 缺了只能去开放平台
 *   - `user` 令牌的 scope 用户授权即可，走设备流
 *   - 两边都要的，先看应用有没有，再让用户授权
 */
export function diffScopes({ wanted = [], appGranted = {}, userGranted = [], schemaTokens = {} } = {}) {
  const userSet = new Set((userGranted || []).map(String))
  const tenantMissing = []
  const userMissing = []
  const rows = []

  for (const sc of wanted) {
    const inApp = !!appGranted[sc]
    const hasUser = userSet.has(sc)
    /*
     * 令牌类型从两处取，优先级：开放平台（已开通，带真实 token_types）> schema（未开通时也能知道）。
     * 只看 appGranted 有个致命缺口：**尚未开通的 scope 根本没有 token_types**，
     * 于是全被当成「两套都要」→ 用户侧缺口被虚报一倍，面板数字不可信。
     */
    const tokens = appGranted[sc]?.tokenTypes?.length ? appGranted[sc].tokenTypes : schemaTokens[sc] || []
    const needsTenant = tokens.length ? tokens.includes('tenant') : true
    const needsUser = tokens.length ? tokens.includes('user') : true
    if (needsTenant && !inApp) tenantMissing.push(sc)
    if (needsUser && !hasUser) userMissing.push(sc)
    rows.push({
      scope: sc,
      description: appGranted[sc]?.description || '',
      needsTenant,
      needsUser,
      appGranted: inApp,
      userGranted: hasUser,
    })
  }
  return { tenantMissing, userMissing, rows }
}

/**
 * 开放平台「申请权限」页：把缺的 scope 预填进去，用户打开就是勾好的。
 * 这是「不用一个个搜权限」的关键 —— 链接自己带 scopes 参数。
 */
export function consoleApplyUrl({ appId, scopes = [], brand = 'feishu' }) {
  const origin = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const base = `${origin}/page/scope-apply?clientID=${encodeURIComponent(appId)}`
  if (!scopes.length) return base
  // 飞书这个页面两种分隔符都能吃（%2C 与 %20 实测都返回 200），用逗号最省字符
  return `${base}&scopes=${encodeURIComponent(scopes.join(','))}`
}

/** 应用详情页（看已开通权限、发版状态）—— 拿不到 scope 参数时的兜底入口。 */
export function appConsoleUrl({ appId, brand = 'feishu', tab = 'auth' }) {
  const origin = brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  return `${origin}/app/${encodeURIComponent(appId)}/${tab}`
}

/**
 * 按域把清单排成人能读的块（面板与工具输出共用一份渲染逻辑）。
 * 每个 scope 带一句中文说明（有就用开放平台的，没有就留空）。
 */
export function groupForDisplay({ wanted = [], appGranted = {}, userGranted = [], schemaTokens = {} } = {}) {
  const d = diffScopes({ wanted, appGranted, userGranted, schemaTokens })
  const byDomain = new Map()
  for (const row of d.rows) {
    const domain = row.scope.split(':')[0]
    if (!byDomain.has(domain)) byDomain.set(domain, [])
    byDomain.get(domain).push(row)
  }
  const groups = [...byDomain.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, rows]) => ({
      domain,
      // 域前缀不等于 DOMAIN_LABELS 的键时（bitable / profile / space / docx），
      // 直接拿前缀当名字会出来一串英文；用组内第一条中文说明当可读标题。
      label: scopeGroupLabel(domain, rows),
      rows,
      missingTenant: rows.filter((r) => r.needsTenant && !r.appGranted).length,
      missingUser: rows.filter((r) => r.needsUser && !r.userGranted).length,
    }))
  return { ...d, groups }
}

/**
 * scope 前缀 → 中文名。
 *
 * **重要**：scope 前缀与 `--domain` 取值是两套词表，不能混用：
 *   --domain 用 `docs`（聚合），scope 前缀却分 `docs:` / `docx:` / `space:`
 *   --domain 用 `base`，scope 前缀却是 `bitable:`
 *   --domain 用 `contact`，用户信息却是 `profile:` 开头
 * 直接用 DOMAIN_LABELS 查会漏一半（bitable / docx / space / profile / mindnote 都没键），
 * 面板上就变成一串英文前缀。
 */
export const SCOPE_PREFIX_LABELS = {
  approval: '审批',
  attendance: '考勤',
  base: '多维表格',
  bitable: '多维表格',
  calendar: '日历',
  contact: '通讯录',
  docs: '云文档',
  docx: '新版文档',
  drive: '云空间',
  im: '即时消息',
  mail: '邮箱',
  mindnote: '思维笔记',
  minutes: '会议纪要',
  okr: 'OKR 目标',
  profile: '用户资料',
  sheets: '电子表格',
  slides: '幻灯片',
  space: '知识空间',
  task: '任务',
  vc: '视频会议',
  wiki: '知识库',
}

/** 分组标题：先查 scope 前缀表，再退域表，最后用组内第一条中文说明。 */
function scopeGroupLabel(domain, rows) {
  return SCOPE_PREFIX_LABELS[domain] || DOMAIN_LABELS[domain] || rows.find((r) => r.description)?.description || domain
}

/**
 * 从 schema 抽「scope → 令牌类型集合」，给 diffScopes 在**尚未开通**时判定用。
 * 与 scopesFromSchema 分开：这个只关心单条 scope 要哪种 token，不管它属于哪个域。
 */
export function tokenTypesFromSchema(methods) {
  const flat = {}
  for (const scopes of Object.values(scopesFromSchema(methods))) {
    for (const [sc, toks] of Object.entries(scopes)) {
      if (!flat[sc]) flat[sc] = new Set()
      for (const t of toks) flat[sc].add(t)
    }
  }
  for (const sc of Object.keys(flat)) flat[sc] = [...flat[sc]]
  return flat
}
