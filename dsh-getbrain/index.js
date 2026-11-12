/**
 * getnote-organize —— DeepSeek Harness Host 插件（纯 Node，零第三方依赖）
 *
 * 把 getnote/gn.py 的官方 OpenAPI 受控能力注册成模型工具，让任何会话都能：
 *   - 读整理纪律（getnote_guide，内容来自同包 SKILL.md）
 *   - 自检 / 下载全文字 / 全量只读快照 / 列表 / 语义搜索 / 知识库
 *   - 执行人工确认过的整理计划（getnote_apply；写闸门仍在 gn.py 里，绕不过）
 *
 * 凭据解析顺序（从安全到便利）：
 *   1) DSH 凭据库 `$DSH_HOME/.credentials.yaml`（推荐）—— 面板输入的密钥写这里，
 *      只有本机该用户可读，**不进组合树**；
 *   2) 环境变量 GETNOTE_API_KEY / GETNOTE_CLIENT_ID；
 *   3) apiKeyFile 指向的本地 json；
 *   4) 插件 config 里的明文（不推荐，仅兼容旧配置）。
 * 解析后通过环境变量注入 gn.py 进程，gn.py 自己再按「env > settings.json > config.local.json」解析。
 *
 * 生效时机（已实测）：所有 Config 字段都是 .volatile()，loader 的 _commitVolatile() 会
 * 通过 updateVolatile() 就地把新值写回运行中的 fiber——所以设置面板保存后不用重启，
 * 下一次工具调用就读到新值。只有改本文件（Host ESM 模块已 import 进内存）或改
 * package.json 的 dsh.client 才需重启。
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// schemastery 由 DSH 提供。本 bundle 是 link: 安装的本地目录（真实路径在工作区里，
// 没有自己的 node_modules），裸名 import 会解析失败。因此按 profile 的 node_modules
// 用 createRequire 定位并 import 绝对文件路径；找不到时降级为 Config=undefined，
// 不让插件整体失活（headless 等无该依赖的部署仍能注册工具）。
// 探测策略（2026-11-10 实测修正）：
//
// 上一版只信 DSH_PROFILE_DIR，结果在生产环境里直接失效：
// Host 进程（Electron 以 ELECTRON_RUN_AS_NODE 跑）里 DSH_* 只有：
//     DSH_CLIENT_VERSION, ELECTRON_RUN_AS_NODE
// **DSH_PROFILE_DIR 根本不存在**，于是 createRequire 锚点退回到插件自己的
// index.js（它是 link: 安装的真实目录，没有 node_modules）→ resolve 失败 →
// z = null → Config = undefined → settings.describe() 跳过本行 →
// configForms.get('getnote') 拿不到 → 面板除凭据框外全部禁用。
//
// 可靠锚点是 process.cwd()（实测 = C:\Users\franc\.dsh\profiles\desktop）。
// 因此按「价值从高到低」依次尝试多个锚点/路径，任一成功即止。
let z = null
{
  const here = fileURLToPath(import.meta.url)
  const profileDir = process.env.DSH_PROFILE_DIR
  const dshHome = process.env.DSH_HOME
  const profileName = process.env.DSH_PROFILE

  // 候选锚点（createRequire 的解析起点）：
  const anchors = []
  if (profileDir) anchors.push(path.join(profileDir, 'package.json'))
  // cwd 就是 profile 目录（实测），最可靠
  anchors.push(path.join(process.cwd(), 'package.json'))
  if (dshHome && profileName) anchors.push(path.join(dshHome, 'profiles', profileName, 'package.json'))
  anchors.push(here)

  // 候选绝对路径（直接 import，不靠解析）：
  const directs = []
  if (profileDir) directs.push(path.join(profileDir, 'node_modules', '@deepseek-ai', 'schemastery'))
  directs.push(path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'schemastery'))
  if (dshHome && profileName) directs.push(path.join(dshHome, 'profiles', profileName, 'node_modules', '@deepseek-ai', 'schemastery'))
  directs.push(path.join(path.dirname(here), 'node_modules', '@deepseek-ai', 'schemastery'))

  const tryLoad = async (spec) => {
    const m = await import(spec)
    let cand = m && m.default !== undefined ? m.default : m
    if (cand && typeof cand.object !== 'function' && cand.default) cand = cand.default
    return cand && typeof cand.object === 'function' ? cand : null
  }

  // 1) 按锚点解析裸名
  for (const a of anchors) {
    if (z) break
    try { z = await tryLoad(pathToFileURL(createRequire(a).resolve('@deepseek-ai/schemastery')).href) } catch { /* 下一个 */ }
  }
  // 2) 直接 import 已知绝对路径（用 package.json 的 main/exports 入口）
  if (!z) {
    for (const dir of directs) {
      if (z) break
      try {
        if (!existsSync(dir)) continue
        // 指向目录时 Node 会读 package.json；ESM 下改指向具体文件更稳
        const pkgPath = path.join(dir, 'package.json')
        let entry = null
        try {
          const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
          const ex = pkg.exports && pkg.exports['.']
          const rel = typeof ex === 'string' ? ex
            : ex && typeof ex === 'object' ? (ex.import || ex.require || ex.default)
            : (pkg.module || pkg.main)
          if (rel) entry = path.join(dir, rel)
        } catch { /* 没有 package.json 就直接试目录 */ }
        z = await tryLoad(pathToFileURL(entry || dir).href)
      } catch { /* 下一个 */ }
    }
  }
}

// 凭据库里的引用名（shell 变量风格，符合 credentialRef 约束）
const REF_API_KEY = 'GETNOTE_API_KEY'
const REF_CLIENT_ID = 'GETNOTE_CLIENT_ID'
export const name = 'getnote'
export const inject = ['tools', 'settings']

/** 凭据库是可选依赖：不声明在 inject 里，缺了也能跑（回退到环境变量）。
 * 但拉取时必须用 ctx.inject 确保服务已就绪，否则可能拿到 undefined。
 */

const BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url))
// 工作区根 = 插件目录的上一级。迁移到 C:\dsh\dsh-getbrain 后即 C:\dsh。
const WORKSPACE = path.dirname(BUNDLE_DIR)
// 默认数据目录：<工作区>/getbraindata（= C:\dsh\getbraindata）。
// 用具名常量而不是到处写字符串，避免以后又改漏一处。
const DEFAULT_DATA_DIR = 'getbraindata'
const GN_PY = path.join(BUNDLE_DIR, 'gn.py')
const SKILL_MD = path.join(BUNDLE_DIR, 'SKILL.md')

// Config：DSH 设置服务只会把「volatile」字段投影成可编辑表单
// （dsh-settings/lib/types/schema.js: volatileForm）。因此每个字段都 .volatile() ——
// 这正是之前「插件配置界面里找不到输入框」的根因。
// apiKey / clientId 额外标记 role('secret')：settings.describe 会对其脱敏，
// 且表单不会把默认值里的明文回显。
const field = (schema, description, secret = false) => {
  let s = schema.description(description)
  if (secret) s = s.role('secret')
  return s.volatile()
}

const ConfigShape = z ? z.object({
  apiKey: field(z.string().default(''), '【已弃用明文槽】请用面板顶部的「API Key」安全输入框（写入凭据库）。此处仅兼容旧配置，留空即可。', true),
  clientId: field(z.string().default(''), '【已弃用明文槽】请用面板顶部的「Client ID」安全输入框（写入凭据库）。此处仅兼容旧配置，留空即可。', true),
  apiKeyFile: field(z.string().default('getnote/config.local.json'), '本地 json 路径，含 {"api_key","client_id"}。相对路径相对工作区根。优先用它而非明文。'),
  apiBase: field(z.string().default('https://openapi.biji.com'), 'OpenAPI Base URL。官方地址固定，面板不暴露；改错只会搞坏。要覆盖请改 cordis.patch.yml 或 GETNOTE_API_URL。'),
  dataDir: field(z.string().default(DEFAULT_DATA_DIR), '统一数据目录：下载/中间产物/快照/日志/审计/计划全归它。相对路径相对工作区根。'),
  // 注意：外层 object 不能再加 .volatile()。schemastery 会报
  // “volatile fields require a fixed object path without an enclosing volatile field”。
  // 只让叶子字段 images 自己 volatile，volatileForm 会递归找到它。
  media: z.object({
    images: field(z.boolean().default(false), '是否下载图片二进制。默认 false；音频/视频为硬约束永不下载。'),
  }).default({}),
  // 下面三个有安全默认值，面板不暴露，只在 cordis.patch.yml 里可调。
  minInterval: field(z.number().default(0.55), '每次请求最小间隔秒数。默认 0.55s ≈ 1.8 req/s，低于官方 read 5/s，余量充足。'),
  pythonPath: field(z.string().default(''), 'python 解释器绝对路径。留空则自动查找 PATH / $DSH_HOME 自带 Python（推荐留空）。'),
  pythonTimeoutMs: field(z.number().default(600000), '单次工具调用超时（毫秒），全量下载可能较久。面板自检另有 20/45s 独立超时。'),
}) : undefined

export const Config = ConfigShape
// 读一个配置值。
//
// 【坑】Config 里每个标了 .volatile() 的字段，运行时拿到的是**包装对象**，
// 不是普通值：
//     cfg(config, 'apiBase')          -> { get: [Function], Symbol(cosmokit.volatile.write): ... }
//     config.media.images             -> 同样是包装对象
// 只有 media 容器本身是普通对象（它的叶子 images 是 volatile）。
//
// 不拆包就会把对象当成字符串用，例如 resolvePython 返回包装对象后
// spawn(exe, ...) 报 “The "file" argument must be of type string. Received an instance of Object”，
// 并导致 doctor / download 所有工具全部失败。
//
// 因此：先解 volatile 包装，再走默认值判断。
function unwrap(v) {
  // cosmokit 的 volatile 包装：可调用 get()，并带 Symbol(cosmokit.volatile.write)
  let cur = v
  // 最多剥 4 层，防止异常情况下死循环
  for (let i = 0; i < 4 && cur !== null && cur !== undefined; i++) {
    if (typeof cur === 'object' && typeof cur.get === 'function') {
      try { cur = cur.get() } catch { break }
    } else break
  }
  return cur
}

function cfg(config, key, fallback) {
  const v = unwrap(config && config[key])
  if (v === undefined || v === null || v === '') return fallback
  return v
}

function truthy(v) {
  return v === true || v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

/** 与 gn.ps1 相同的查找顺序：显式 > $DSH_HOME 自带 > PATH 名兜底。 */
function resolvePython(config) {
  const explicit = cfg(config, 'pythonPath', '') || process.env.GETNOTE_PYTHON || ''
  if (explicit) return explicit
  const home = process.env.DSH_HOME || ''
  // DSH 自带 Python，任一安装都保证存在，最稳
  const bundled = home
    ? path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
        process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    : ''
  if (bundled && existsSync(bundled)) return bundled
  // 兜底：交给 spawn 用 PATH 解析
  return process.platform === 'win32' ? 'python.exe' : 'python3'
}

/** 把插件 config + 凭据库映射成 gn.py 认识的环境变量。
 *
 * 优先级（后者被前者覆盖）：config 明文 < apiKeyFile < 环境变量 < 凭据库。
 * 凭据库最高，因为那是用户在面板里显式输入并安全存储的值。
 *
 * @param config - 插件行配置（volatile，实时值）。
 * @param creds - 可选的凭据库句柄，形状 { resolve(ref) => Promise<{value}|undefined> }。
 */
async function buildEnv(config, creds) {
  const env = { ...process.env }
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') env[k] = String(v) }

  put('GETNOTE_API_KEY', cfg(config, 'apiKey', ''))
  put('GETNOTE_CLIENT_ID', cfg(config, 'clientId', ''))
  put('GETNOTE_API_URL', cfg(config, 'apiBase', 'https://openapi.biji.com'))
  put('GETNOTE_DATA_DIR', cfg(config, 'dataDir', DEFAULT_DATA_DIR))
  put('GETNOTE_MIN_INTERVAL', cfg(config, 'minInterval', 0.55))
  const media = unwrap(config && config.media) || {}
  // media.images 同样是 volatile 包装，必须解包后才能当真布尔用。
  put('GETNOTE_MEDIA_IMAGES', truthy(unwrap(media.images)) ? 'true' : 'false')

  // 凭据库最高优先：面板输入的密钥存在 $DSH_HOME/.credentials.yaml，不进组合树。
  // 同时告诉 gn.py 真实来源，避免它把安全存储误报成 "env"（看起来像明文配置）。
  if (creds) {
    try {
      const apiKey = await creds.resolve(REF_API_KEY)
      if (apiKey && apiKey.value) {
        env.GETNOTE_API_KEY = apiKey.value
        env.GETNOTE_CRED_SOURCE = 'credentials'
      }
      const clientId = await creds.resolve(REF_CLIENT_ID)
      if (clientId && clientId.value) {
        env.GETNOTE_CLIENT_ID = clientId.value
        if (!env.GETNOTE_CRED_SOURCE) env.GETNOTE_CRED_SOURCE = 'credentials'
      }
    } catch { /* 凭据库不可用不阻断工具调用，回退到上面的来源 */ }
  }

  // apiKeyFile：只在「两个密钥都没拿到」时才作为兼容后备传给 gn.py。
  // 注意：若凭据库或 env 已经给了完整的 key+cid，就无需再读文件（此时传了也会被忽略）。
  const keyFile = cfg(config, 'apiKeyFile', '')
  const haveBoth = !!(env.GETNOTE_API_KEY && env.GETNOTE_CLIENT_ID)
  if (keyFile && !haveBoth) put('GETNOTE_CONFIG_FILE', keyFile)
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  return env
}

/** 运行 gn.py 并捕获输出。Host 插件在应用进程内，不受 pwsh 工具沙箱限制。 */
async function runGn(config, creds, args, signal, timeoutOverrideMs) {
  const env = await buildEnv(config, creds)
  return new Promise((resolve) => {
    const exe = resolvePython(config)
    // 面板路径传入更短的超时（默认 pythonTimeoutMs 是 600s，对「测试连接」太长）
    const rawT = timeoutOverrideMs != null ? timeoutOverrideMs : cfg(config, 'pythonTimeoutMs', 600000)
    const timeout = Number(rawT)
    let child
    try {
      child = spawn(exe, [GN_PY, ...args], {
        cwd: WORKSPACE,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, code: 'SPAWN_FAILED', output: '', error: String(error && error.message || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* noop */ }
      resolve({ ok: false, code: 'TIMEOUT', output: stdout, error: `超时 ${timeout}ms，已终止。` })
    }, timeout)
    const onAbort = () => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* noop */ }
      clearTimeout(timer)
      resolve({ ok: false, code: 'ABORTED', output: stdout, error: '调用被中止。' })
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: 'SPAWN_ERROR', output: stdout,
        error: `${String(error && error.message || error)}。可设 pythonPath 指向 python.exe。` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ ok: code === 0, code: code === 0 ? 'OK' : `EXIT_${code}`,
        output: stdout, error: stderr.trim(), exitCode: code })
    })
  })
}

function textResult(r) {
  const head = r.ok ? '' : `❌ [${r.code}] ${r.error || '执行失败'}\n\n`
  return head + (r.output || (r.ok ? '(无输出)' : ''))
}

/** 统一的文本输出契约（与内置工具一致）。 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) { return [{ type: 'text', text: String(value) }] },
  }
}

export function apply(ctx, config) {
  // 注意：所有配置字段都是 .volatile()，loader 的 _commitVolatile 会就地改写
  // 传入的 config 对象，所以 cfg(config, ...) 在 execute 里读到的是「实时值」，
  // 设置面板保存后无需重启。但工具注册时的 timeoutMs 是快照，故这里只给一个
  // 宽松的总额，真正的超时由 runGn 内部的 pythonTimeoutMs 实时控制。
  const TOOL_CEILING_MS = 3600000
  const register = (definition, label) =>
    ctx.effect(() => ctx.tools.register(definition), `getnote: ${label}`)

  // 凭据库句柄：ctx.credentials 由 @deepseek-ai/dsh-credentials-local 提供（dsh-base 已组合）。
  // 它为 undefined 时（headless 等未装该服务的部署）一切回退到环境变量 / config 明文。
  //
  // ⚠ 必须在每次调用时现取，不能在 apply() 里求值一次存起来：
  // credentials 不在 inject 里，apply() 跑的时候该服务可能尚未挂载，
  // 那时 ctx.get('credentials') 返回 undefined，存下来就是永久 undefined。
  // 实测（2026-11-10）：重启后 servicePresent:false、origin:none，就是这个原因。
  const resolveCreds = () => {
    try { const c = ctx.get ? ctx.get('credentials') : undefined; if (c) return c } catch { /* service absent */ }
    try { const r = ctx.get ? ctx.get('remote') : undefined; if (r && r.credentials) return r.credentials } catch { /* proxy refuses */ }
    return undefined
  }
  // 0) 纪律说明书：把同包 SKILL.md 的内容按需交给 agent
  register({
    name: 'getnote_guide',
    description:
      '读取「得到大脑/Get笔记」整理纪律（先全量备份、默认只读、写操作需确认、删除按不可逆、凭据不进聊天）。' +
      '在准备整理/分类/删除/合并笔记，或不确定 getnote 工具怎么用之前，先调用它。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput(),
    async execute() {
      try {
        return await readFile(SKILL_MD, 'utf8')
      } catch (error) {
        return 'SKILL.md 读取失败：' + String(error && error.message || error)
      }
    },
  }, 'getnote_guide')

  // 1) 自检
  register({
    name: 'getnote_doctor',
    description: '本地自检：显示统一数据目录、下载策略、凭据来源与限速。传 live=true 会做一次只读连通性测试（消耗 1 次读配额）。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { live: { type: 'boolean', description: '是否发一次只读 note/list 验证会员/Key/网络。' } },
    },
    output: textOutput(), timeoutMs: 60000,
    async execute(args, exec) {
      const a = ['doctor']
      if (args.live === true) a.push('--live')
      return textResult(await runGn(config, resolveCreds(), a, exec.signal))
    },
  }, 'getnote_doctor')

  // 1b) 接入信息：认证是否通过 + 具体配置现状（给人看，也给面板看）
  register({
    name: 'getnote_status',
    description:
      '显示接入信息：凭据是否已配置、来源（凭据库/环境变量/文件）、API 地址、' +
      '统一数据目录、下载策略、限速，以及可选的在线连通测试结果。' +
      '认证成功后用这个向用户说明「现在接到了什么」。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        live: { type: 'boolean', description: '是否真发一次请求验证凭据（消耗 1 次配额）。' },
      },
    },
    output: textOutput(), timeoutMs: 60000,
    async execute(args, exec) {
      // live 时只跑一次带 --live 的 doctor（它包含全部信息）；否则跑普通 doctor。
      // 注意：不能并发调两次 gn.py（runGn 同一时刻只一个子进程，且有锁），必须串行。
      const a = args.live === true ? ['doctor', '--live'] : ['doctor']
      const snapshot = await runGn(config, resolveCreds(), a, exec.signal)
      // 把凭据来源补上（gn.py 不知道 DSH 凭据库，只能看到最终环境变量）
      let origin = 'none'
      try {
        const _creds = resolveCreds()
        if (_creds) {
          const k = await _creds.resolve(REF_API_KEY)
          const c = await _creds.resolve(REF_CLIENT_ID)
          const sources = [k && k.source, c && c.source].filter(Boolean)
          if (sources.length) origin = [...new Set(sources)].join('+')
        }
        if (origin === 'none' && process.env.GETNOTE_API_KEY) origin = 'env'
      } catch { /* ignore */ }
      const label = { file: 'DSH 凭据库（推荐）', env: '环境变量', 'project-env': '.env 文件', 'user-env': '用户 .env' }
      // 不能把字符串丢给 textResult（它要的是 {ok,code,output} 结果对象）。
      const body = String(snapshot.output || snapshot.error || '')
      return textResult(
        snapshot.ok
          ? { ok: true, code: 'OK', output: body + `\n\n凭据来源      : ${label[origin] || origin}` }
          : { ok: false, code: snapshot.code, error: snapshot.error, output: body })
    },
  }, 'getnote_status')
  // 2) 下载全文字（默认不下载音频/视频；图片需显式开）
  register({
    name: 'getnote_download',
    description:
      '把全部笔记的「全文字」下载到统一数据目录 dataDir/downloads/，供人先分析决策再改线上。' +
      '默认只写 Markdown 全文（原文+AI 总结），音频/视频二进制永不下载；图片需 withImages=true。' +
      '这是只读操作，不改动线上任何笔记。' +
      '传 into 可增量刷新同一个目录（只重写 updated_at 变了的笔记，省配额）；不传则每次新建时间戳快照。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        max: { type: 'number', description: '最多下载条数，0/省略=全部。' },
        withImages: { type: 'boolean', description: '额外下载图片二进制（默认 false）。' },
        into: { type: 'string', description: '增量目录（如 getbraindata/current）。传了就写回同一目录、跳过未变化笔记；省略=新建快照目录。' },
        force: { type: 'boolean', description: '配合 into：忽略增量判断，全部重写。' },
      },
    },
    output: textOutput(), timeoutMs: TOOL_CEILING_MS,
    async execute(args, exec) {
      const a = ['download']
      if (Number(args.max) > 0) a.push('--max', String(Math.round(Number(args.max))))
      if (args.withImages === true) a.push('--with-images')
      if (typeof args.into === 'string' && args.into.trim()) a.push('--into', args.into.trim())
      if (args.force === true) a.push('--force')
      return textResult(await runGn(config, resolveCreds(), a, exec.signal))
    },
  }, 'getnote_download')

  // 3) 全量只读快照（Phase 0，兜底）
  register({
    name: 'getnote_backup',
    description: 'Phase 0：全量只读快照（列表+逐条详情）写入 dataDir/snapshots/。任何写操作前必须先做；验收前不要删。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        max: { type: 'number', description: '最多拉多少条，0/省略=全部。' },
        skipDetail: { type: 'boolean', description: '只拉列表不逐条拉详情（快）。' },
      },
    },
    output: textOutput(), timeoutMs: TOOL_CEILING_MS,
    async execute(args, exec) {
      const a = ['backup']
      if (Number(args.max) > 0) a.push('--max', String(Math.round(Number(args.max))))
      if (args.skipDetail === true) a.push('--skip-detail')
      return textResult(await runGn(config, resolveCreds(), a, exec.signal))
    },
  }, 'getnote_backup')

  // 4) 只读列表
  register({
    name: 'getnote_list',
    description: '只读列出笔记（返回 JSON）。all=true 自动翻完所有页；limit 限制返回条数。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        all: { type: 'boolean', description: '翻完所有页。' },
        limit: { type: 'number', description: '返回条数上限。' },
      },
    },
    output: textOutput(), timeoutMs: TOOL_CEILING_MS,
    async execute(args, exec) {
      const a = ['list', '--json']
      if (args.all === true) a.push('--all')
      if (Number(args.limit) > 0) a.push('--limit', String(Math.round(Number(args.limit))))
      return textResult(await runGn(config, resolveCreds(), a, exec.signal))
    },
  }, 'getnote_list')

  // 5) 只读语义搜索
  register({
    name: 'getnote_search',
    description: '只读语义搜索（Top-K，默认3最大10）。注意：空结果不证明没有重复笔记，判重请用全量快照。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: '自然语言检索词。' },
        topK: { type: 'number', description: '返回条数，默认 5，最大 10。' },
      },
      required: ['query'],
    },
    output: textOutput(), timeoutMs: 120000,
    async execute(args, exec) {
      const a = ['search', String(args.query || '')]
      if (Number(args.topK) > 0) a.push('--top-k', String(Math.min(10, Math.round(Number(args.topK)))))
      return textResult(await runGn(config, resolveCreds(), a, exec.signal))
    },
  }, 'getnote_search')

  // 6) 只读知识库列表
  register({
    name: 'getnote_topics',
    description: '只读列出知识库。includeSubscribed=true 一并列出订阅库（订阅库只读不可写）。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { includeSubscribed: { type: 'boolean', description: '包含订阅知识库。' } },
    },
    output: textOutput(), timeoutMs: 60000,
    async execute(args, exec) {
      const a = ['topics']
      if (args.includeSubscribed === true) a.push('--include-subscribed')
      return textResult(await runGn(config, resolveCreds(), a, exec.signal))
    },
  }, 'getnote_topics')

  // 7) 计划模板
  register({
    name: 'getnote_plan_template',
    description: '打印整理计划 plan.json 的 version 1 模板（op 白名单、示例动作、高危标记）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput(), timeoutMs: 60000,
    async execute(_args, exec) {
      return textResult(await runGn(config, resolveCreds(), ['plan-template'], exec.signal))
    },
  }, 'getnote_plan_template')

  // 8) 执行人工确认过的计划（写闸门在 gn.py：--confirm / --allow-high-risk 仍是硬约束）
  register({
    name: 'getnote_apply',
    description:
      '执行人工确认过的 plan.json。⚠️ 必须有用户明确确认后才调用。' +
      'dryRun=true 只预览不发包；计划含 note_update/note_delete 需 allowHighRisk=true。' +
      'gn.py 内部仍有 --confirm CONFIRM 与删除双重闸门，本工具不会绕过它们。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        plan: { type: 'string', description: 'plan.json 路径（相对工作区根或绝对路径）。' },
        dryRun: { type: 'boolean', description: '只预览计划动作，不发包。' },
        allowHighRisk: { type: 'boolean', description: '允许计划里的 note_update / note_delete。' },
        limit: { type: 'number', description: '最多执行前 N 个动作。' },
      },
      required: ['plan'],
    },
    output: textOutput(), timeoutMs: TOOL_CEILING_MS,
    async execute(args, exec) {
      const plan = String(args.plan || '')
      if (!plan) return '❌ 缺少 plan 参数。'
      const planPath = path.isAbsolute(plan) ? plan : path.join(WORKSPACE, plan)
      const a = ['apply', '--plan', planPath, '--confirm', 'CONFIRM']
      if (args.dryRun === true) a.push('--dry-run')
      if (args.allowHighRisk === true) a.push('--allow-high-risk')
      if (Number(args.limit) > 0) a.push('--limit', String(Math.round(Number(args.limit))))
      return textResult(await runGn(config, resolveCreds(), a, exec.signal))
    },
  }, 'getnote_apply')

  // 2) 面板用的接入信息端点：GET /plugins/getnote/status?live=1
  //
  // 为什么需要它：Client 半边拿不到 Host 的工具，而「认证是否成功」必须真跑一次
  // gn.py doctor（可选 --live）。这里把结果缓 5 秒，避开面板多次渲染时的重拉。
  // 路由挂在 webServer 的 prefix 下，与 /plugins/ 同源，无需额外鉴权（同现有 bundle 路由）。
  ctx.inject(['webServer'], (webCtx) => {
    const cache = { at: 0, live: false, text: '' }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/status',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const wantLive = url.searchParams.get('live') === '1'
        // 保存/清除凭据后带 refresh=1 来，绕过 5s 缓存。
        // 否则刚存完 Key 立刻拉，会拿到缓存里的旧结果（看起来像没生效）。
        const forceRefresh = url.searchParams.get('refresh') === '1'
        const now = Date.now()
        try {
          if (forceRefresh || wantLive || !cache.text || now - cache.at > 5000 || cache.live !== wantLive) {
            const args = wantLive ? ['doctor', '--live'] : ['doctor']
            // 面板超时：live 模式给 45s（网络往返 + gn.py 重试），本地 doctor 给 20s。
            // 避免 pythonTimeoutMs 默认 600s 让界面转圈 10 分钟。
            const panelTimeout = wantLive ? 45000 : 20000
            const out = await runGn(config, resolveCreds(), args, undefined, panelTimeout)
            cache.at = now
            cache.live = wantLive
            cache.text = String(out.output || out.error || '')
          }
          // 附带凭据来源信息（gn.py 看不到 DSH 凭据库）
          let origin = 'none'
          let apiKeySet = false
          let clientIdSet = false
          // 诊断：区分“服务没挂载”和“服务挂了但没配置”——两者都表现为 origin=none
          const _c0 = resolveCreds(); const credDiag = { servicePresent: !!_c0, error: null, canWrite: null }
          try {
            if (_c0) {
              const k = await _c0.resolve(REF_API_KEY)
              const c = await _c0.resolve(REF_CLIENT_ID)
              apiKeySet = !!(k && k.value)
              clientIdSet = !!(c && c.value)
              const sources = [k && k.source, c && c.source].filter(Boolean)
              if (sources.length) origin = [...new Set(sources)].join('+')
              // describe 能反映 provider 是否支持写入（writable）
              try {
                // 注意：Host 侧 describe(ref) 收单个字符串，返回 {configured,source?,writable}
                const d = await _c0.describe(REF_API_KEY)
                credDiag.canWrite = !!(d && d.writable === true)
              } catch (e) { credDiag.error = String(e && e.message || e) }
            }
          } catch (e) {
            credDiag.error = String(e && e.message || e)
          }
          // 从 doctor 原文里抽出结构化字段，供面板渲染（原文同时保留）
          const text = cache.text
          const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : null }
          const memberLine = grab(/会员状态\s*:\s*(.+)/)
          const memberOk = memberLine ? /✅/.test(memberLine) : null
          const quota = {}
          for (const line of text.split(/\r?\n/)) {
            const m = line.match(/配额\/([^:]+):\s*(.+)/)
            if (m) quota[m[1].trim()] = m[2].trim()
          }
          const dataDirLine = grab(/统一数据目录\s*:\s*(.+)/)
          const apiBaseLine = grab(/API base\s*:\s*(.+)/)
          const body = JSON.stringify({
            ok: wantLive ? /✅ 连通成功/.test(text) : true,
            live: wantLive,
            origin, apiKeySet, clientIdSet,
            credDiag,
            member: { reported: memberLine !== null, ok: memberOk, text: memberLine },
            quota,
            apiBase: apiBaseLine,
            dataDir: dataDirLine,
            text,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(body)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }))
        }
      },
    }), 'getnote: status route')

    // 3) 本地镜像统计：GET /plugins/getnote/summary
    //
    // 纯本地文件扫描，**不调 API、不耗配额**。面板用它填「笔记现状」页；
    // 也让我自己能用 HTTP 直接验证数据对不对，不用等界面上线。
    const summaryCache = { at: 0, data: null }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/summary',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const force = url.searchParams.get('refresh') === '1'
        const now = Date.now()
        try {
          if (force || !summaryCache.data || now - summaryCache.at > 30000) {
            summaryCache.data = await scanMirror(cfg(config, 'dataDir', DEFAULT_DATA_DIR))
            summaryCache.at = now
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, ...summaryCache.data }))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }))
        }
      },
    }), 'getnote: summary route')

    // 4) 客户端自报：POST /plugins/getnote/report
    //
    // 为什么需要：我（Agent）看不到浏览器 DOM，无法自己确认侧边栏图标真的渲染了。
    // 让 client.js 在注册完 slot 后向这里 post 一行“我注册了什么”，
    // 就能用 HTTP 拿到黑白分明的证据，不用靠用户肉眼看。
    // 内存里只留最后一份，重启即清；不落盘、不含任何凭据。
    const clientReport = { at: 0, data: null }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/report',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, report: clientReport.data, at: clientReport.at }))
          return
        }
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 16384) break
          }
          clientReport.data = JSON.parse(raw || '{}')
          clientReport.at = Date.now()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }))
        }
      },
    }), 'getnote: report route')
  })

  /**
   * 扫描本地镜像目录，算出「笔记现状」需要的那几个数。
   *
   * 只看 data/current（增量目录）里的 *.md，文件名形如 `<note_id>_<title>.md`。
   * 解析每个文件头部几行元数据（类型/知识库/标签），不做全文字解析——
   * 2000+ 篇也要控制在几百毫秒。
   *
   * @param {string} dataDir 配置里的 dataDir（相对路径按 workspace 解析）
   */

  /**
   * 判断一个标签是否「像课程名/书名/专栏名」——即值得单独拆成一个知识库的东西。
   *
   * 为什么需要：实测数据里，“得到”(2665) 和“录音笔记”(201) 这类
   * 平台名/形态名的量远远大于真正的课程，不滤掉的话排行榜前几名全是噪声。
   * 用黑名单而不是白名单：新课程不需要改代码就能自动识别。
   */
  const NON_TOPICAL = new Set([
    '得到', '录音笔记', '录音卡笔记', 'AI链接笔记', '图片笔记',
    '无标题', '未分类', '其他', '待整理', '默认',
  ])
  function isTopical(name) {
    if (!name) return false
    const s = String(name).trim()
    if (!s || s.length < 2) return false
    if (NON_TOPICAL.has(s)) return false
    // 纯形态描述（以“笔记”结尾）也不是课程名
    if (s.endsWith('笔记') || s.endsWith('记录')) return false
    return true
  }
  async function scanMirror(dataDir) {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // 相对路径的基准是 WORKSPACE（= 插件目录的上一级，即 default-workspace），
    // 不能用 process.cwd()：Host 进程的 cwd 是 profile 目录（C:\Users\franc\.dsh），
    // 不是工作区。这里与 gn.py 的 WORKSPACE = ROOT.parent 保持一致。
    const base = path.isAbsolute(dataDir) ? dataDir : path.resolve(WORKSPACE, dataDir)
    const dir = path.join(base, 'current')
    let names = []
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'))
    } catch {
      // 目录不存在是正常状态（刚装完、还没下载过）
      return { dir, total: 0, byType: {}, noTopic: 0, noTag: 0,
        topics: [], tags: [], courses: [], updatedAt: new Date().toISOString() }
    }
    const byType = {}
    let noTopic = 0
    let noTag = 0
    const topicCount = new Map()
    const tagCount = new Map()
    const courseCount = new Map()

    // 并发读，但要限一个温和的上限，避免一次性打开几千个句柄
    const LIMIT = 64
    for (let i = 0; i < names.length; i += LIMIT) {
      const chunk = names.slice(i, i + LIMIT)
      const texts = await Promise.all(chunk.map(async (n) => {
        try {
          const fh = await fs.open(path.join(dir, n), 'r')
          try {
            const buf = Buffer.alloc(2048)
            const { bytesRead } = await fh.read(buf, 0, 2048, 0)
            return buf.toString('utf8', 0, bytesRead)
          } finally { await fh.close() }
        } catch { return '' }
      }))
      for (const t of texts) {
        if (!t) continue
        const mType = /^- \u7c7b\u578b: (\S+)/m.exec(t)
        if (mType) byType[mType[1]] = (byType[mType[1]] || 0) + 1

        const mTopic = /^- \u77e5\u8bc6\u5e93: (.+)$/m.exec(t)
        const tval = mTopic ? mTopic[1].trim() : ''
        if (!tval || tval === 'None' || tval === '[]') noTopic++
        else for (const nm of tval.matchAll(/'name': '([^']+)'/g)) {
          const k = nm[1]
          topicCount.set(k, (topicCount.get(k) || 0) + 1)
          courseCount.set(k, (courseCount.get(k) || 0) + 1)
        }

        const mTag = /^- \u6807\u7b7e: (.+)$/m.exec(t)
        const gval = mTag ? mTag[1].trim() : ''
        if (!gval || gval === 'None' || gval === '[]') noTag++
        else for (const nm of gval.matchAll(/'name': '([^']+)'/g)) {
          tagCount.set(nm[1], (tagCount.get(nm[1]) || 0) + 1)
          // 只有「看起来像课程/书/专栏」的标签才计入可拆专题。
          // 否则像「得到」「录音笔记」这类平台名/形态名会排到最前面，
          // 把真正的课程盖掉（已实测：得到=2665 会稳居第一，毫无意义）。
          if (isTopical(nm[1])) courseCount.set(nm[1], (courseCount.get(nm[1]) || 0) + 1)
        }
      }
    }

    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([name, count]) => ({ name, count }))

    return {
      dir,
      total: names.length,
      byType,
      noTopic,
      noTag,
      topics: top(topicCount, 20),
      tags: top(tagCount, 20),
      // 课程/专题聚类：知识库和标签里数量大的，很可能就是该拆分的那几块
      courses: top(courseCount, 15),
      updatedAt: new Date().toISOString(),
    }
  }
}
