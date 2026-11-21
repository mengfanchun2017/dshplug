/**
 * dsh-larkcli · 文档链接自动路由（「给你链接，你就去查，不用说明是哪个账号」）
 *
 * 目标：用户丢一个飞书链接过来，插件自己决定用哪个账户、哪种身份、哪条命令，
 * 失败就换下一个，最后只回一份「查到了，用 X 账户」的结果。
 *
 * 三步：
 *   1) **解析链接**（纯字符串，零网络）：域 + 类型 + token。
 *      飞书的 URL 形态很杂（/docx/ /docs/ /wiki/ /sheets/ /base/ /app/ /slides/
 *      /mindnotes/ /file/ /minutes/，还有 ?from= 之类参数），先分清类型才知道该跑哪条命令。
 *   2) **判定要用哪种身份**：wiki 链接要先解 node 才知行不行；
 *      文档读默认 user 优先（能读到自己私有的），失败退 bot（共享文档）。
 *   3) **按账户池依次试**：默认账户优先，其余按登记顺序。
 *      只有「这次失败换个人可能成功」的错误才继续，
 *      「链接本身不对」立刻停 —— 否则会把一个错链接在 5 个账户上各跑一遍。
 */

/**
 * 从任意飞书链接里解析出 { brand, kind, token, url, wiki }。
 *
 * kind 取值：docx | doc | sheet | base | wiki | slides | mindnotes | file | minutes | folder | unknown
 */
export function parseDocUrl(input) {
  const raw = String(input ?? '').trim()
  const out = { ok: false, brand: 'feishu', kind: 'unknown', token: '', url: raw, wiki: false, error: '' }
  if (!raw) {
    out.error = '链接为空'
    return out
  }
  let u
  try {
    u = new URL(raw)
  } catch {
    // 不是 URL：当成裸 token，类型未知，交给调用方指定
    if (/^[A-Za-z0-9_-]{6,}$/.test(raw)) {
      out.ok = true
      out.token = raw
      out.kind = 'unknown'
      out.error = '裸 token，无法判断类型；请用 type 参数指定'
      return out
    }
    out.error = '不是合法链接，也不是裸 token'
    return out
  }

  out.brand = /larksuite\.com$|larkoffice\.com$/.test(u.hostname) ? 'lark' : 'feishu'

  // 路径形如 /docx/<token> 或 /wiki/<node_token>?...
  const segs = u.pathname.split('/').filter(Boolean)
  const head = (segs[0] || '').toLowerCase()
  const token = segs[1] || ''

  const KNOWN = {
    docx: 'docx',
    docs: 'docx', // 老链接 /docs/<token> 实际是 docx
    doc: 'doc',
    wiki: 'wiki',
    sheets: 'sheet',
    sheet: 'sheet',
    base: 'base',
    bitable: 'base',
    app: 'base', // 妙搭/BaseApp 的 /app/<token>，先按 base 试
    slides: 'slides',
    mindnotes: 'mindnotes',
    file: 'file',
    drive: 'file',
    minutes: 'minutes',
    folder: 'folder',
  }

  if (KNOWN[head] && token) {
    out.ok = true
    out.kind = KNOWN[head]
    out.token = token
    out.wiki = out.kind === 'wiki'
    return out
  }

  // 有些链接把 token 放查询参数里（?docToken= / ?obj_token=）
  for (const key of ['docToken', 'doc_token', 'obj_token', 'objToken', 'token', 'fileToken', 'node_token']) {
    const v = u.searchParams.get(key)
    if (v) {
      out.ok = true
      out.token = v
      out.kind = head && KNOWN[head] ? KNOWN[head] : 'unknown'
      return out
    }
  }

  out.error = `认不出这个链接的类型（path=/${head}/）。支持 /docx/ /docs/ /wiki/ /sheets/ /base/ /app/ /slides/ /mindnotes/ /file/ /minutes/`
  return out
}

/** 链接类型 → 给人看的名字。 */
export const KIND_LABELS = {
  docx: '云文档（Docx）',
  doc: '旧版文档（Doc）',
  sheet: '电子表格',
  base: '多维表格',
  wiki: '知识库节点',
  slides: '幻灯片',
  mindnotes: '思维笔记',
  file: '云空间文件',
  minutes: '妙记',
  folder: '文件夹',
  unknown: '未知类型',
}

/**
 * 读类命令表：每种链接类型 → 一串候选命令（前面的先用）。
 *
 * 为什么每类给多个：同一个 token 在 bot 身份下可能因权限失败，
 * 换 user 身份就成功；有的类型（base）没有统一「读正文」命令，
 * 只能退到「列表 + 元信息」这种能证明「我有权限、且这文档是什么」的最小查询。
 */
export const READ_COMMANDS = {
  docx: [
    { args: (t) => ['docs', '+fetch', '--doc', t, '--doc-format', 'markdown'], label: 'docs +fetch（markdown）' },
    { args: (t) => ['docs', '+fetch', '--doc', t, '--scope', 'outline'], label: 'docs +fetch（仅大纲）' },
  ],
  doc: [{ args: (t) => ['drive', '+inspect', '--url', t], label: 'drive +inspect' }],
  sheet: [
    { args: (t) => ['sheets', '+workbook-info', '--spreadsheet-token', t], label: 'sheets +workbook-info' },
  ],
  base: [
    { args: (t) => ['base', '+base-get', '--base-token', t], label: 'base +base-get' },
    { args: (t) => ['base', '+table-list', '--base-token', t], label: 'base +table-list' },
  ],
  wiki: [{ args: (t) => ['wiki', '+node-get', '--node-token', t], label: 'wiki +node-get' }],
  slides: [{ args: (t) => ['slides', '+xml-get', '--presentation', t], label: 'slides +xml-get' }],
  mindnotes: [{ args: (t) => ['drive', '+inspect', '--url', t], label: 'drive +inspect' }],
  file: [{ args: (t) => ['drive', '+inspect', '--url', t], label: 'drive +inspect' }],
  minutes: [{ args: (t) => ['drive', '+inspect', '--url', t], label: 'drive +inspect' }],
  folder: [{ args: (t) => ['drive', '+inspect', '--url', t], label: 'drive +inspect' }],
  unknown: [{ args: (t) => ['drive', '+inspect', '--url', t], label: 'drive +inspect（自动识别类型）' }],
}

/**
 * 这个错误值不值得换下一个账户再试？
 *
 * 判「值得」的（换人可能行）：
 *   - 权限/范围类：99991672 / 99991679 / 131006 / 403 / permission denied
 *   - 需要 user 身份（token_missing）：换个已授权的账户可能就有
 *   - 该账户没配 secret / 没授权
 * 判「不值得」的（链接或参数本身不对）：
 *   - 3380002 Invalid document_id or document not found
 *   - validation / invalid_argument / unknown flag
 */
export function isRetryableError(r) {
  if (!r) return false
  if (r.ok) return false
  const e = r.error || {}
  const msg = String(e.message || r.stderr || '')
  const code = Number(e.code || 0)
  const type = String(e.type || '')
  const sub = String(e.subtype || '')

  // 参数/命令写错了：换账户没意义
  if (type === 'validation' || sub === 'invalid_argument') return false
  if (/unknown flag|invalid format|expected JSON object/i.test(msg)) return false
  // 文档真的不存在：换账户也没用（除非是权限伪装成 404，见下）
  if (code === 3380002) return false

  // 明确的权限/身份类
  if (code === 99991672 || code === 99991679 || code === 131006) return true
  if (type === 'authorization' || type === 'authentication') return true
  if (sub === 'token_missing' || sub === 'app_scope_not_applied') return true
  if (/permission|denied|no user authority|not applied|forbidden|access denied/i.test(msg)) return true
  if (/超过.*ms|timeout/i.test(msg)) return true
  return false
}

/** 账户尝试顺序：默认账户最前，其余保持登记顺序（稳定的可预测性）。 */
export function orderAccounts(accounts, defaultId) {
  const list = Array.isArray(accounts) ? accounts.slice() : []
  const idx = list.findIndex((a) => a.id === defaultId)
  if (idx > 0) {
    const [d] = list.splice(idx, 1)
    list.unshift(d)
  }
  return list
}

/**
 * 在账户池里依次尝试读一个链接。
 *
 * @param {object} opts
 * @param {object} opts.service            LarkService
 * @param {string} opts.url                链接
 * @param {string} [opts.type]             覆盖解析出的类型（裸 token 时用）
 * @param {string} [opts.account]          指定账户则只试它（不做池化）
 * @param {string[]} [opts.as]             身份顺序，默认 ['user','bot']
 * @param {number} [opts.timeoutMs]
 * @param {(line:string)=>void} [opts.log] 过程回调（工具输出里逐条打印尝试记录）
 * @returns {Promise<object>} { ok, url, kind, account, identity, attempts, result, error }
 */
export async function readDocByUrl({
  service,
  url,
  type = '',
  account = '',
  as = ['user', 'bot'],
  timeoutMs = 60000,
  log = () => {},
  commands = null,
} = {}) {
  const parsed = parseDocUrl(url)
  const kind = String(type || parsed.kind || 'unknown').toLowerCase()
  const token = parsed.token || String(url || '').trim()
  if (!token) {
    return { ok: false, url, kind, attempts: [], error: parsed.error || '链接里没有 token' }
  }

  const candidates = commands || READ_COMMANDS[kind] || READ_COMMANDS.unknown
  const all = service.store.list()
  const defaultId = service.store.defaultId()
  const pool = account ? all.filter((a) => a.id === String(account)) : orderAccounts(all, defaultId)
  if (!pool.length) {
    return { ok: false, url, kind, attempts: [], error: '还没有任何账户，先 lark_account_upsert + lark_account_set_secret' }
  }

  const attempts = []
  for (const acc of pool) {
    // 没 secret 的账户直接跳过（省一次必然失败的进程）
    if (!service.hasSecret(acc.id)) {
      attempts.push({ account: acc.id, identity: '-', ok: false, skipped: true, reason: '没有 appsecret.txt' })
      log(`- ${acc.id}：跳过（未配置 secret）`)
      continue
    }
    for (const id of as) {
      for (const cmd of candidates) {
        const args = cmd.args(token)
        const full = [...args, '--as', id]
        const r = await service.run(full, { accountId: acc.id, timeoutMs })
        const rec = {
          account: acc.id,
          identity: id,
          command: `lark-cli ${full.join(' ')}`,
          label: cmd.label,
          ok: !!r.ok,
          code: r.error?.code,
          message: r.ok ? '' : String(r.error?.message || r.stderr || '').slice(0, 300),
        }
        attempts.push(rec)
        log(`${r.ok ? '✅' : '·'} ${acc.id} / ${id} / ${cmd.label}${r.ok ? '' : ` → ${rec.message.slice(0, 120)}`}`)
        if (r.ok) {
          return {
            ok: true,
            url: parsed.url || url,
            kind,
            kindLabel: KIND_LABELS[kind] || kind,
            token,
            account: acc.id,
            accountLabel: acc.label,
            identity: id,
            label: cmd.label,
            command: rec.command,
            attempts,
            json: r.json,
            raw: r.raw,
          }
        }
        if (!isRetryableError(r)) {
          // 链接/参数本身有问题：再试别的账户只是浪费
          return {
            ok: false,
            url: parsed.url || url,
            kind,
            kindLabel: KIND_LABELS[kind] || kind,
            token,
            account: acc.id,
            identity: id,
            attempts,
            fatal: true,
            error: rec.message,
            hint: r.error?.hint || '',
          }
        }
      }
    }
  }

  return {
    ok: false,
    url: parsed.url || url,
    kind,
    kindLabel: KIND_LABELS[kind] || kind,
    token,
    attempts,
    error: `账户池里 ${pool.length} 个账户都读不到这个链接（试了 ${attempts.length} 次）`,
    hint:
      '常见原因：① 该应用没被加为文档协作者；② 应用侧缺 scope（用 lark_scopes 看缺哪条、点链接申请）；' +
      '③ 需要 user 身份但还没授权（lark_login_start）。',
  }
}
