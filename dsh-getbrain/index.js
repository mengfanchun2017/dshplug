/**
 * dsh-getbrain —— DeepSeek Harness Host 插件（纯 Node，零第三方依赖）
 *
 * 把 dsh-getbrain/gn.py 的官方 OpenAPI 受控能力注册成模型工具，让任何会话都能：
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
import { readFile, mkdir as fspMkdir, writeFile as fspWriteFile, readdir as fspReaddir } from 'node:fs/promises'
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
// 工作区根 = 插件目录的上一级。插件现在位于 C:\dsh\dw-plugin\dsh-getbrain，
// 所以 WORKSPACE = C:\dsh\dw-plugin（不是 C:\dsh）。改目录位置时这里的推算跟着变。
const WORKSPACE = path.dirname(BUNDLE_DIR)
// 默认数据目录：**仓库的同级目录** data-getbrain —— 本机即 C:\dsh\data-getbrain。
//
// 为什么是「同级」而不是「工作区内」：插件位于 C:\dsh\dw-plugin\dsh-getbrain，
// 它的「上一级」是工作区根 C:\dsh\dw-plugin（就是 Git 仓库本身）。旧版本默认写
// 'getbraindata' 相对工作区根 → 落到仓库里的 C:\dsh\dw-plugin\getbraindata，于是当初
// 只能靠 cordis.patch.yml 里写死绝对路径 C:\dsh\getbraindata 把数据拽出仓库。
// 现在默认值**由代码推导**（仓库同级 data-<名字>），patch 里留空即可，换机器不用改配置。
//
// 命名约定：C:\dsh\data-<插件名短名> 是本机所有技能的「默认数据位」，自动创建；
// 存在仓库之外 → 天然不进 Git、不进插件包；想换位置在设置面板改 dataDir。
const DEFAULT_DATA_DIR = path.join(path.dirname(WORKSPACE), 'data-getbrain')
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
  apiKeyFile: field(z.string().default('dsh-getbrain/config.local.json'), '本地 json 路径，含 {"api_key","client_id"}。相对路径相对工作区根。优先用它而非明文。'),
  apiBase: field(z.string().default('https://openapi.biji.com'), 'OpenAPI Base URL。官方地址固定，面板不暴露；改错只会搞坏。要覆盖请改 cordis.patch.yml 或 GETNOTE_API_URL。'),
  // 默认留空，让 cfg() 回退到代码推导的 DEFAULT_DATA_DIR（仓库同级 data-getbrain）。
  // 这样面板里看到的是「默认」而不是一串本机绝对路径，换机器不用改任何配置。
  dataDir: field(z.string().default(''), `统一数据目录：下载/中间产物/快照/日志/审计/计划全归它。留空 = 默认值 ${DEFAULT_DATA_DIR}（首次运行自动创建，不进 Git）；相对路径相对工作区根，绝对路径则直接用。`),
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
        into: { type: 'string', description: "增量目录。相对路径相对**数据目录**（如 'current' → <dataDir>/current）；传了就写回同一目录、跳过未变化笔记；省略=新建时间戳快照目录。" },
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

    // 3.5) 层级清单：GET /plugins/getnote/inventory
    //
    // 侧边栏「分类调整」页的数据来源。真正干活的是 gn.py inventory（纯本地扫描），
    // 这里只负责转发。为什么要经过 Host：浏览器半边拿不到 Node 的 fs，也无法
    // 启动 Python；而面板需要的是“知识库 → 目录 → 书 → 讲”这棵真实的树。
    //
    // 缓存 60s：扫 4000+ 个 Markdown 头部大约 1–3s，面板多次渲染不应反复扫。
    const invCache = { at: 0, data: null }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/inventory',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const force = url.searchParams.get('refresh') === '1'
        const now = Date.now()
        try {
          if (force || !invCache.data || now - invCache.at > 60000) {
            const out = await runGn(config, resolveCreds(), ['inventory', '--summary'], undefined, 60000)
            const txt = String(out.output || '')
            // 注意：jdump 输出的是**缩进美化**的 JSON（indent=2），不是单行。
            // 第一版的写法是「找第一个以 { 开头的行再 JSON.parse 它」，
            // 结果只拿得到 "{" 这一个字符，路由直接 500（已实测踩到）。
            // 正确做法：从第一个 { 开始截到最后一个 }，整体解析。
            const start = txt.indexOf('{')
            const end = txt.lastIndexOf('}')
            if (start < 0 || end <= start) {
              throw new Error(out.error || ('inventory 没有返回 JSON：' + txt.slice(0, 200)))
            }
            invCache.data = JSON.parse(txt.slice(start, end + 1))
            invCache.at = now
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, ...invCache.data }))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }))
        }
      },
    }), 'getnote: inventory route')

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
          const incoming = JSON.parse(raw || '{}')
          // 两次采样（atApply / at1500ms）都要留：后者覆盖前者就把「注册那一刻」
          // 的事实丢了，而这两次之差正是判断「注册没上」还是「时机太早」的唯一依据。
          if (clientReport.data && typeof clientReport.data === 'object'
              && clientReport.data.ts === incoming.ts) {
            clientReport.data = { ...clientReport.data, ...incoming }
          } else {
            clientReport.data = incoming
          }
          clientReport.at = Date.now()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }))
        }
      },
    }), 'getnote: report route')

    // 5) 分类调整：POST /plugins/getnote/plan
    //
    // 侧边栏勾选「讲」后，把选中的 note_id 提交到这里，Host 把它们转成
    // plan.json 里的动作，**先干跑**（不发写请求）返回给界面预览。
    //
    // 为什么不在浏览器里直接拼 plan：浏览器拿不到数据目录路径，也没法写文件；
    // 而 gn.py apply 需要读一个真实文件。所以统一走 Host。
    //
    // 安全：这个路由**只写计划文件、不执行**。真正执行必须另调 /apply 并带 confirm。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/plan',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 4 * 1024 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          // 树里的层级用 \u0000 分隔，gn.py 要 \x1f；不转就永远匹配不上。
          const paths = (Array.isArray(body.paths) ? body.paths.filter(Boolean) : [])
            .map((p) => String(p).split('\u0000')
              .filter((s) => s && s !== '\u0001flat').join('\u001f'))
          const target = body.target || {}
          if (!paths.length) return send(400, { ok: false, error: '没有收到任何选中项' })
          if (paths.length > 2000) return send(400, { ok: false, error: '单次超过 2000 个选中项，请分批' })

          // 把界面传的层级路径解析成真实 note_id（同一份镜像数据，不会错位）
          const rs = await runGn(config, resolveCreds(),
            ['resolve', '--paths', ...paths], undefined, 60000)
          const rsTxt = String(rs.output || '')
          const rsA = rsTxt.indexOf('{')
          const rsB = rsTxt.lastIndexOf('}')
          if (rsA < 0 || rsB <= rsA) {
            return send(400, { ok: false, error: rs.error || ('resolve 失败：' + rsTxt.slice(0, 200)) })
          }
          const resolved = JSON.parse(rsTxt.slice(rsA, rsB + 1))
          const noteIds = resolved.note_ids || []
          if (!noteIds.length) return send(400, { ok: false, error: '选中的层级下没有任何笔记' })

          // 根据目标类型生成动作：加标签 或 加入知识库
          const ops = []
          if (target.kind === 'kb' && target.topicId) {
            ops.push({ op: 'kb_batch_add', reason: '侧边栏分类调整',
              args: { topic_id: String(target.topicId), note_ids: noteIds } })
          } else if (target.kind === 'kb' && target.topicName) {
            // 按名字归库：不用先去翻 topic_id。kb_ensure 会复用同名库（幂等），
            // 侧栏里选「未归知识库 → 归到这个名字」时走这条。
            ops.push({ op: 'kb_ensure', reason: '按名字确保知识库存在',
              args: { name: String(target.topicName) } })
            ops.push({ op: 'kb_batch_add', reason: '侧边栏分类调整',
              args: { topic_name: String(target.topicName), note_ids: noteIds } })
          } else if (target.kind === 'tag' && target.tag) {
            // 标签是逐条加的（官方无批量接口），超过 200 条会很多请求，提醒一下
            for (const id of noteIds) {
              ops.push({ op: 'tag_add', reason: '侧边栏分类调整',
                args: { note_id: String(id), tags: [String(target.tag)] } })
            }
          } else {
            return send(400, { ok: false, error: '缺少目标：需要 target.kind = kb|tag 以及 topicId|topicName|tag' })
          }

          // 白名单校验：只允许分类相关的动作。删除必须走单独的 /apply 流程，
          // 不允许在这里混进删除动作（否则界面上勾选一下就可能删数据）。
          const ALLOWED = new Set(['tag_add', 'tag_delete', 'kb_batch_add', 'kb_remove', 'kb_ensure'])
          const bad = ops.find((o) => !ALLOWED.has(o && o.op))
          if (bad) {
            return send(400, { ok: false,
              error: '不允许的动作：' + String(bad.op) + '（分类调整只允许 tag_add / tag_delete / kb_batch_add / kb_remove）' })
          }


          const plan = {
            version: 1,
            generated_at: new Date().toISOString(),
            confirmed_by: 'PENDING_USER_CONFIRM',
            source_snapshot: '',
            actions: ops,
            _notes: ['由侧边栏 Mgetbrain 工作台的「分类调整」生成',
              'confirmed_by 在用户确认前保持 PENDING_USER_CONFIRM'],
          }
          invCache.plan = invCache.plan || {}
          invCache.plan = plan
          // 同时写一份到 state/plan.pending.json，便于终端里直接跑 gn.py apply
          let planPath = ''
          try {
            const dir = path.join(cfg(config, 'dataDir', DEFAULT_DATA_DIR), 'state')
            await fspMkdir(dir, { recursive: true })
            planPath = path.join(dir, 'plan.pending.json')
            await fspWriteFile(planPath, JSON.stringify(plan, null, 2), 'utf8')
          } catch (error) {
            // 写盘失败不影响返回：界面仍然可以预览，只是不能直接从终端 apply
            planPath = ''
          }
          send(200, { ok: true, plan, planPath, dryRun: true })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: plan route')

    // 5b) 自动归类：POST /plugins/getnote/auto-plan
    //
    // 与 /plan 的区别：/plan 是用户在树里手勾「讲」，一次几十条；
    // 这个是把 2055 条未归库的按规则成批分组，一次上千条。
    //
    // 但**仍然只生成计划**：跑 gn.py auto-classify 写一个 plan 文件，把分组摘要
    // 返回给界面。一条写请求也不发——自动化的危险不在算得快，而在没人看过就去写。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/auto-plan',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 64 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          const minGroup = Number.isFinite(body.minGroup) ? body.minGroup : 5
          const limitGroups = Number.isFinite(body.limitGroups) ? body.limitGroups : 0

          const dataDir = cfg(config, 'dataDir', DEFAULT_DATA_DIR)
          const planPath = path.join(dataDir, 'state', 'plan.classify.json')
          const args = ['auto-classify', '--min-group', String(minGroup),
            '--plan-out', planPath]
          if (limitGroups > 0) args.push('--limit-groups', String(limitGroups))

          // 60s：扫 4300 个文件头 + 分组，本机实测 ~2s，留大余量给慢盘。
          const r = await runGn(config, resolveCreds(), args, undefined, 60000)
          const txt = String(r.output || '')
          if (!r.ok) {
            return send(400, { ok: false,
              error: r.error || txt.slice(0, 400),
              output: txt.slice(0, 2000) })
          }

          let plan = null
          try {
            plan = JSON.parse(await readFile(planPath, 'utf8'))
          } catch (error) {
            return send(500, { ok: false,
              error: '计划文件写成功了但读不回来：' + String(error && error.message || error) })
          }

          send(200, {
            ok: true,
            planPath,
            summary: plan.summary,
            groups: plan.groups,
            skipped_sample: plan.skipped_sample,
            actions: (plan.actions || []).length,
            // 计划本体只在动作数可控时回传：界面要拿它渲染「确认执行」页的动作清单。
            // 超过 2000 条就不传（几十 KB 变几 MB，表格也渲不动），界面退回只显示摘要。
            ...(plan.actions.length <= 2000 ? { plan } : {}),
            note: '本接口只生成计划，不发写请求。真写走 /apply（confirm=APPLY）。',
          })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: auto-plan route')

    // 6) 执行计划：POST /plugins/getnote/apply
    //
    // 两道闸门，跟 CLI 保持一致：
    //   a) 必须显式传 confirm: "APPLY"；
    //   b) 体量超过 200 个动作时必须带 allowHighRisk: true（大批量写风险高）。
    // 且**先干跑**一次把摘要返回，真写要再带 dryRun: false 调一次。
    //
    // 为什么这么麻烦：这个面板能被鼠标误触，而写错分类可以事后改，
    // 但用户对“我点了一下就改了 900 条”零容忍。宁可多点一步。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/apply',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 1024 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          if (body.confirm !== 'APPLY') {
            return send(400, { ok: false, error: '缺少确认：需传 {"confirm":"APPLY"}' })
          }
          // 计划来源：默认用内存里那份（手工勾选生成的）。
          // 但「自动归类」生成的是另一份文件，如果这里不区分，在自动归类页点干跑
          // 会默默执行上一次的手工计划——那是最坏的一种错（看起来成功了，改的不是这个）。
          let plan = invCache.plan
          if (body.planPath) {
            // 只允许读 dataDir/state 下的文件：路径来自浏览器，必须限制范围。
            const stateDir = path.resolve(path.join(cfg(config, 'dataDir', DEFAULT_DATA_DIR), 'state'))
            const want = path.resolve(String(body.planPath))
            if (want !== stateDir && !want.startsWith(stateDir + path.sep)) {
              return send(400, { ok: false, error: 'planPath 必须在数据目录的 state/ 下' })
            }
            try {
              plan = JSON.parse(await readFile(want, 'utf8'))
            } catch (error) {
              return send(400, { ok: false,
                error: '读计划文件失败：' + String(error && error.message || error) })
            }
          }
          if (!plan || !Array.isArray(plan.actions) || !plan.actions.length) {
            return send(400, { ok: false, error: '没有待执行的计划，请先在「分类调整」生成计划' })
          }
          const n = plan.actions.length
          const dryRun = body.dryRun !== false
          if (!dryRun && n > 200 && body.allowHighRisk !== true) {
            return send(400, { ok: false,
              error: `这个计划有 ${n} 个动作，批量写需额外传 allowHighRisk:true` })
          }
          // 写计划文件（带 confirmed_by）后交给 gn.py apply
          const dir = path.join(cfg(config, 'dataDir', DEFAULT_DATA_DIR), 'state')
          await fspMkdir(dir, { recursive: true })
          const planPath = path.join(dir, 'plan.pending.json')
          const stamped = { ...plan, confirmed_by: 'USER_CONFIRMED',
            generated_at: plan.generated_at || new Date().toISOString() }
          await fspWriteFile(planPath, JSON.stringify(stamped, null, 2), 'utf8')
          // 真写前先拍「归属快照」，供撤销用。
          // 为何必须真写才拍：dry-run 没改任何东西，拍快照只会攒出一堆无用的 undo 文件。
          // 快照失败时的选择：**中止写入**。宁可这次不改，也不能改了之后无法回退。
          let undoPath = ''
          if (!dryRun) {
            const snap = await runGn(config, resolveCreds(),
              ['undo-snapshot', '--plan', planPath], undefined, 180000)
            if (!snap.ok) {
              return send(500, { ok: false,
                error: '写前快照失败，已中止（不能改了之后无法回退）：'
                  + (snap.error || String(snap.output || '').slice(0, 400)) })
            }
            const m = String(snap.output || '').match(/undo-(\d{8}-\d{6})\.json/)
            undoPath = m ? path.join(dir, 'undo-' + m[1] + '.json') : ''
          }

          const args = ['apply', '--plan', planPath, '--confirm', 'CONFIRM']
          if (dryRun) args.push('--dry-run')
          const highRisk = plan.actions.some((a) => a.op === 'note_update' || a.op === 'note_delete')
          if (highRisk) args.push('--allow-high-risk')
          const out = await runGn(config, resolveCreds(), args, undefined, 180000)
          send(out.ok ? 200 : 500, {
            ok: out.ok, dryRun, actionCount: n, planPath,
            // undoPath 只给界面用：真写成功后多出「可撤销」那一行。
            undoPath: undoPath || undefined,
            output: String(out.output || '').slice(0, 8000),
            error: out.ok ? undefined : (out.error || 'apply 失败'),
          })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: apply route')

    // 6b) 撤销：POST /plugins/getnote/undo
    //
    // 两道门与 apply 一致：confirm: 'UNDO' + 默认 dry-run。
    // 且**不传路径就不猜**：撤销必须指名哪个 undo 文件，不提供「撤上一笔」的隐式行为（见 docs/UNDO-DESIGN.md §5）。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/undo',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 64 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          if (body.confirm !== 'UNDO') {
            return send(400, { ok: false, error: '缺少确认：需传 {"confirm":"UNDO"}' })
          }
          const stateDir = path.resolve(path.join(cfg(config, 'dataDir', DEFAULT_DATA_DIR), 'state'))
          const want = path.resolve(String(body.undoPath || ''))
          if (!body.undoPath || (want !== stateDir && !want.startsWith(stateDir + path.sep))) {
            return send(400, { ok: false, error: 'undoPath 必须是数据目录 state/ 下的 undo-*.json' })
          }
          if (!/\.json$/.test(want)) {
            return send(400, { ok: false, error: 'undoPath 必须是 .json 文件' })
          }
          const dryRun = body.dryRun !== false
          const args = ['undo', '--plan', want, '--confirm', 'UNDO']
          if (dryRun) args.push('--dry-run')
          if (body.allowLarge === true) args.push('--allow-large')

          const out = await runGn(config, resolveCreds(), args, undefined, 180000)
          send(out.ok ? 200 : 500, {
            ok: out.ok, dryRun, undoPath: want,
            output: String(out.output || '').slice(0, 8000),
            error: out.ok ? undefined : (out.error || 'undo 失败'),
          })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: undo route')

    // 6c) 可撤销批次列表：GET /plugins/getnote/undos
    //
    // 为何要列出而不是只看最新：用户可能过了半小时才想回退，
    // 期间又改过别的。必须能把「哪一批」摆出来让他选，而不是默默拿最后一个。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/undos',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        try {
          const dir = path.join(cfg(config, 'dataDir', DEFAULT_DATA_DIR), 'state')
          const files = await fspReaddir(dir).catch(() => [])
          const list = []
          for (const f of files.filter((x) => /^undo-\d{8}-\d{6}\.json$/.test(x)).sort().reverse()) {
            try {
              const rec = JSON.parse(await readFile(path.join(dir, f), 'utf8'))
              list.push({
                file: f,
                path: path.join(dir, f),
                createdAt: rec.created_at,
                noteCount: Object.keys(rec.pre_state || {}).length,
                status: rec.status || 'open',
                undoneAt: rec.undone_at || null,
                stats: rec.undo_stats || null,
              })
            } catch { /* 单个文件坏了不影响其它 */ }
          }
          send(200, { ok: true, undos: list.slice(0, 50) })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: undos list route')
    // 8) AI 动作：GET /plugins/getnote/ai
    //
    // 返回三样：可用的按钮（来自 actions.json，用户可改）、
    // 每份提示词的正文（界面里可直接看/改）、以及每份文件的路径。
    // 为何把提示词正文也返回：用户要能看见「点这个按钮到底问了 AI 什么」。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/ai',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        try {
          const dir = cfg(config, 'dataDir', DEFAULT_DATA_DIR)
          const pdir = path.join(dir, 'prompts')
          await fspMkdir(pdir, { recursive: true })

          const actionsPath = path.join(pdir, 'actions.json')
          let actions = []
          try {
            actions = JSON.parse(await readFile(actionsPath, 'utf8'))
          } catch {
            actions = []
          }

          const prompts = {}
          for (const name of ['sprout', 'interrogate', 'link']) {
            const p = path.join(pdir, name + '.md')
            try {
              prompts[name] = await readFile(p, 'utf8')
            } catch {
              prompts[name] = ''
            }
          }

          send(200, { ok: true, actions, prompts, dir: pdir })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: ai prompts route')

    // 9) AI 素材包：POST /plugins/getnote/context-pack
    //
    // 跑 gn.py context-pack，把「一条笔记 + 同系列别的讲 + 跨系列相关」交给界面。
    // 界面拿去拼进提示词，再交给模型——但**不在这里调模型**：
    // 本插件是数据层，模型调用属于 DSH 会话侧。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/context-pack',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 64 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          const noteId = String(body.noteId || '').trim()
          if (!/^\d{6,}$/.test(noteId)) {
            return send(400, { ok: false, error: 'noteId 必须是数字 id' })
          }
          const limit = Number.isFinite(body.limit) ? body.limit : 6
          const out = await runGn(config, resolveCreds(),
            ['context-pack', '--note-id', noteId, '--limit', String(limit)], undefined, 120000)
          const txt = String(out.output || '')
          if (!out.ok) {
            return send(400, { ok: false, error: out.error || txt.slice(0, 400) })
          }
          const a = txt.indexOf('{')
          const b = txt.lastIndexOf('}')
          if (a < 0 || b <= a) return send(500, { ok: false, error: '素材包解析失败' })
          send(200, { ok: true, pack: JSON.parse(txt.slice(a, b + 1)) })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: context-pack route')

    // 10) 发芽查询：GET /plugins/getnote/sprout?noteId=
    //
    // 只读查平台侧是否已有发芽内容。注意：官方**没有**生成接口（POST 404），
    // 所以这个路由永远不会「帮用户生成」，只报现状。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/sprout',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const noteId = String(url.searchParams.get('noteId') || '').trim()
          if (!/^\d{6,}$/.test(noteId)) {
            return send(400, { ok: false, error: 'noteId 必须是数字 id' })
          }
          const out = await runGn(config, resolveCreds(),
            ['sprout', '--note-id', noteId, '--json'], undefined, 60000)
          const txt = String(out.output || '')
          if (!out.ok) return send(400, { ok: false, error: out.error || txt.slice(0, 400) })
          const a = txt.indexOf('{')
          const b = txt.lastIndexOf('}')
          const data = (a >= 0 && b > a) ? JSON.parse(txt.slice(a, b + 1)) : null
          send(200, { ok: true, sprout: data && data.sprout, hasSprout: !!(data && data.has_sprout) })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: sprout route')
    // 7b) 删除笔记：POST /plugins/getnote/delete
    //
    // 与其它写路由的区别：删除是**单程票**，所以门楷比 apply 更高：
    //   1) 必须显式 confirm: 'DELETE'（不是 APPLY）
    //   2) 必须二次确认 acknowledged:true —— 对应 gn.py 的 --i-understand-...
    //   3) 默认就要存本地副本（trash/），存不下就拒绝删，不给「反正有回收站」的幻觉
    // 为何不归到 /apply 的统一计划里：删除不该能混在批量分类里一键执行，
    // 一次只删一条，才能让人真的逐条想一下。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/delete',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 64 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          const noteId = String(body.noteId || '').trim()
          if (!/^\d{10,25}$/.test(noteId)) {
            return send(400, { ok: false, error: 'noteId 不合法（需纯数字）' })
          }
          if (body.confirm !== 'DELETE') {
            return send(400, { ok: false, error: '缺少确认：需传 {"confirm":"DELETE"}' })
          }
          if (body.acknowledged !== true) {
            return send(400, { ok: false,
              error: '需要先在界面上勾选「我知道删除可能不可恢复」' })
          }
          const dryRun = body.dryRun !== false
          const args = ['note-delete', '--note-id', noteId,
            '--i-understand-deletion-may-be-permanent']
          if (!dryRun) args.push('--apply')
          if (body.skipTrash === true) args.push('--skip-trash')
          const out = await runGn(config, resolveCreds(), args, undefined, 120000)
          const txt = String(out.output || '')
          // trash 路径从 stdout 里取，给界面显示「备份在哪」
          const tm = txt.match(/\[trash\] 已存本地副本：(.+)/)
          send(out.ok ? 200 : 500, {
            ok: out.ok, dryRun, noteId,
            trashPath: tm ? tm[1].trim() : '',
            output: txt.slice(0, 4000),
            error: out.ok ? undefined : (out.error || txt.slice(0, 400)),
          })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: delete route')
    // 7c) 把层级路径解析成 note_id：POST /plugins/getnote/resolve
    //
    // 为何需要：删除要的是 note_id，而人在树上勾的是「知识库/目录/书/讲」
    // 这种路径。没有这层，用户就只能自己去翻 19 位数字 —— 这正是
    // 「让填 id 根本做不到」的根因。只读、不联网（扫本地镜像）。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/resolve',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 256 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          const rawPaths = Array.isArray(body.paths) ? body.paths.filter(Boolean) : []
          if (!rawPaths.length) return send(400, { ok: false, error: '没有收到任何选中项' })
          if (rawPaths.length > 2000) return send(400, { ok: false, error: '单次超过 2000 项，请分批' })
          // 树里用 \u0000 当层级分隔（见 client.js 的 ck / bKey / lk），
          // gn.py 要的是 \x1f。不转就会把整串当成一个库名，永远匹配不上。
          // \u0001flat 是扁形书（无书名）的占位层：树里要占位才能对齐列，
          // 而 gn.py 的镜像里根本没有这一层，必须抹掉，否则永远 0 命中。
          const toGnPath = (p) => String(p).split('\u0000')
            .filter((s) => s && s !== '\u0001flat').join('\u001f')
          const paths = rawPaths.map(toGnPath)
          const out = await runGn(config, resolveCreds(),
            ['resolve', '--paths', ...paths], undefined, 60000)
          const txt = String(out.output || '')
          const a = txt.indexOf('{')
          const b = txt.lastIndexOf('}')
          if (a < 0 || b <= a) {
            return send(400, { ok: false, error: out.error || ('resolve 失败：' + txt.slice(0, 200)) })
          }
          const data = JSON.parse(txt.slice(a, b + 1))
          send(200, { ok: true, noteIds: data.note_ids || [], count: (data.note_ids || []).length,
            // 标题随 ID 一起给：界面要「看着标题挑一条」，只给数字没法选。
            titles: data.titles || {} })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: resolve route')

    // 12b) 讲内笔记清单：GET /plugins/getnote/lecture-notes
    //
    // 为何需要：「讲」下通常有多条划线（实测 660 个讲、4322 条笔记，平均 6.5 条），
    // 而 inventory --summary 只给条数。用户要复制某条笔记的 ID 去「AI 动作」用，
    // 光看「这一讲有 6 条」是拿不到 ID 的——这才是「填 ID 麻烦」的根。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/lecture-notes',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET') return send(405, { ok: false, error: 'GET only' })
        try {
          const u = new URL(req.url, 'http://localhost')
          const course = u.searchParams.get('course') || ''
          const lecture = u.searchParams.get('lecture') || ''
          if (!course || !lecture) {
            return send(400, { ok: false, error: '需要 course 与 lecture 两个参数' })
          }
          const out = await runGn(config, resolveCreds(),
            ['lecture-notes',
              '--kb', u.searchParams.get('kb') || '',
              '--course', course,
              '--book', u.searchParams.get('book') || '',
              '--lecture', lecture], undefined, 60000)
          const txt = String(out.output || '')
          const a = txt.indexOf('{')
          const b = txt.lastIndexOf('}')
          if (!out.ok || a < 0 || b <= a) {
            return send(400, { ok: false, error: out.error || txt.slice(0, 300) })
          }
          const data = JSON.parse(txt.slice(a, b + 1))
          send(200, { ok: true, notes: data.notes || [], count: data.count || 0 })
        } catch (error) {
          send(400, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: lecture-notes route')

    // 13) 合并：POST /plugins/getnote/merge
    //
    // 把多条笔记拼成一条新笔记。**不删任何东西**，删旧另走 /delete。
    // 为什么不做成一次调用：合并会创建全新 note_id，旧引用全断，
    // 这是不可逆的语义变化，必须让人先看到预览再确认。
    //
    // 闸门：confirm 必须是 MERGE；acknowledged 必须 true；dryRun 默认 true。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/merge',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: '只支持 POST' })
        try {
          let raw = ''
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 256 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          if (body.confirm !== 'MERGE') {
            return send(400, { ok: false, error: '需要 confirm: "MERGE"' })
          }
          if (body.acknowledged !== true) {
            return send(400, { ok: false, error: '需要先在界面上勾选「我知道合并会得到新 ID」' })
          }
          const ids = Array.isArray(body.noteIds)
            ? body.noteIds.map((x) => String(x).trim()).filter(Boolean) : []
          if (ids.length < 2) return send(400, { ok: false, error: '合并至少要两条笔记' })
          if (ids.length > 50) return send(400, { ok: false, error: '一次最多 50 条' })
          for (const id of ids) {
            if (!/^\d{10,25}$/.test(id)) return send(400, { ok: false, error: 'note_id 格式不对：' + id })
          }
          // 默认干跑：不显式传 false 就绝不写
          const dryRun = body.dryRun !== false
          const argv = ['merge', ...ids]
          if (body.title) argv.push('--title', String(body.title))
          if (body.style === 'divider') argv.push('--style', 'divider')
          if (body.show) argv.push('--show')
          if (!dryRun) {
            argv.push('--apply', '--i-understand-new-id')
          }
          const out = await runGn(config, resolveCreds(), argv, undefined, 180000)
          const txt = String(out.output || '')
          let newId = ''
          const m = txt.match(/已建新笔记：(\S+)/)
          if (m) newId = m[1]
          // runGn 的 code 是字符串（'OK' / 'EXIT_1'），判断成功要用 out.ok。
          // 写成 out.code === 0 会永远 false，把成功的合并报成失败。
          send(200, {
            ok: !!out.ok,
            dryRun,
            newNoteId: newId || null,
            noteIds: ids,
            code: out.code,
            output: txt.slice(0, 60000),
          })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: merge route')

    // 14) ID 表：GET /plugins/getnote/ids
    //
    // 纯本地扫描镜像，重建「名字 → id」表，并报名字/ID 错位。
    // 为何要做：插件里很多关联靠名字字符串，用户改个名字就静默失效且不报错。
    // 实测已抓到一组：标签「AI」对应两个 id。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/ids',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET') return send(405, { ok: false, error: '只支持 GET' })
        try {
          const out = await runGn(config, resolveCreds(), ['ids', '--json'], undefined, 120000)
          let data = null
          try { data = JSON.parse(String(out.output || '')) } catch { data = null }
          // gn.py ids --json 把结果包在 report 里（另外带 ok / path）。
          // 这里拆开：界面只关心表本身，不要让前端记住这层包装。
          const report = (data && data.report) || data || null
          send(200, { ok: !!out.ok, data: report,
            output: report ? '' : String(out.output || '').slice(0, 40000) })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: ids route')

    // 15) 工作内容提纯包：GET /plugins/getnote/brief?days=&top=
    //
    // 给 AI Agent 读的：待办、主要来源、自己记的主题、最近动态。
    // 纯本地不耗配额 —— 所以可以随时拉，不会因为限速/断网卡住。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/brief',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET') return send(405, { ok: false, error: '只支持 GET' })
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const argv = ['agent-brief', '--json']
          const days = parseInt(url.searchParams.get('days') || '0', 10)
          if (days > 0) argv.push('--days', String(days))
          const top = parseInt(url.searchParams.get('top') || '12', 10)
          if (top > 0) argv.push('--top', String(Math.min(top, 50)))
          const recent = parseInt(url.searchParams.get('recent') || '10', 10)
          if (recent > 0) argv.push('--recent', String(Math.min(recent, 50)))
          const out = await runGn(config, resolveCreds(), argv, undefined, 120000)
          let data = null
          try { data = JSON.parse(String(out.output || '')) } catch { data = null }
          send(200, { ok: !!out.ok, data, output: data ? '' : String(out.output || '').slice(0, 40000) })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: brief route')

    // 15.5) 账号归属盘点：GET /plugins/getnote/personas?into=current
    //
    // 纯本地统计，不调 API、不写平台。返回「我/孩子/老婆/共用/未知」各多少篇，
    // 以及判不出来的清单——那份清单要人看，所以不自动猜。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/personas',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET') return send(405, { ok: false, error: '只支持 GET' })
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const into = (url.searchParams.get('into') || 'current').trim() || 'current'
          // 扫 4321 个 md 实测 ~2 秒，给足余量
          const out = await runGn(config, resolveCreds(),
            ['personas', '--into', into, '--json'], undefined, 180000)
          let data = null
          try { data = JSON.parse(String(out.output || '')) } catch { data = null }
          if (!out.ok && !data) {
            return send(400, { ok: false,
              error: (String(out.output || '') + String(out.error || '')).slice(0, 400) })
          }
          send(200, { ok: !!out.ok, data })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: personas route')

    // 15.6) 镜像对账：GET /plugins/getnote/mirror-check?into=current
    //
    // 本地镜像 vs 线上 list 逐条对账（只读，耗读配额）。发现「本地有线上没有」
    // 与「线上有本地没有」两类偏差。写操作前跑一次，避免拿一份不完整的镜像做批量决策。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/mirror-check',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET') return send(405, { ok: false, error: '只支持 GET' })
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const into = (url.searchParams.get('into') || 'current').trim() || 'current'
          // 要翻完 4321 条（每页几十条），给足超时
          const out = await runGn(config, resolveCreds(),
            ['mirror-check', '--into', into, '--json'], undefined, 300000)
          let data = null
          try { data = JSON.parse(String(out.output || '')) } catch { data = null }
          if (!out.ok && !data) {
            return send(400, { ok: false,
              error: (String(out.output || '') + String(out.error || '')).slice(0, 400) })
          }
          send(200, { ok: !!out.ok, data })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: mirror-check route')

    // 16) 本地检索：GET /plugins/getnote/find?q=&kb=&type=&limit=
    //
    // 纯本地 sqlite 索引，不联网、不耗配额。检索是最频繁的动作，
    // 每次都走云端 recall 既慢又费钱，而且它上限 10 条、不能按库过滤。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/find',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET') return send(405, { ok: false, error: '只支持 GET' })
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const q = (url.searchParams.get('q') || '').trim()
          if (!q) return send(400, { ok: false, error: '要给查询词 q' })
          const argv = ['find', q, '--json']
          const kb = (url.searchParams.get('kb') || '').trim()
          if (kb) argv.push('--kb', kb)
          const type = (url.searchParams.get('type') || '').trim()
          if (type) argv.push('--type', type)
          // 按人过滤：一个账号里混着三个人，不分开搜出来的东西没法用。
          const owner = (url.searchParams.get('owner') || '').trim()
          if (owner) argv.push('--owner', owner)
          const limit = parseInt(url.searchParams.get('limit') || '10', 10)
          argv.push('--limit', String(Math.min(Math.max(limit, 1), 100)))

          const out = await runGn(config, resolveCreds(), argv, undefined, 60000)
          let data = null
          try { data = JSON.parse(String(out.output || '')) } catch { data = null }
          // 没建索引时 gn.py 返回退出码 2 并提示先跑 index —— 把它翻成人话
          if (!out.ok && !data) {
            const txt = String(out.output || '') + String(out.error || '')
            if (txt.includes('还没有索引')) {
              return send(409, { ok: false, error: '还没有建索引', needIndex: true,
                hint: '先点「建索引」，或跑 gn.py index' })
            }
            return send(400, { ok: false, error: txt.slice(0, 400) })
          }
          send(200, { ok: !!out.ok, data, output: data ? '' : String(out.output || '').slice(0, 20000) })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: find route')

    // 16.5) 向量检索：GET /plugins/getnote/vec-search?q=&limit=
    //
    // 本地稀疏向量（TF-IDF）余弦检索，不联网、不耗配额。与 /find 的字面检索互补：
    // 字面命中准确但要求词形一致；向量检索能拉开排序，但同义不同词仍会漏。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/vec-search',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET') return send(405, { ok: false, error: '只支持 GET' })
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const q = (url.searchParams.get('q') || '').trim()
          if (!q) return send(400, { ok: false, error: '要给查询词 q' })
          const limit = parseInt(url.searchParams.get('limit') || '10', 10)
          const argv = ['vec-search', '--q', q, '--limit', String(Math.min(Math.max(limit, 1), 100)), '--json']
          const out = await runGn(config, resolveCreds(), argv, undefined, 60000)
          let data = null
          try { data = JSON.parse(String(out.output || '')) } catch { data = null }
          if (!out.ok && !data) {
            const txt = String(out.output || '') + String(out.error || '')
            if (txt.includes('还没有向量索引')) {
              return send(409, { ok: false, error: '还没有向量索引', needIndex: true,
                hint: '先点「建向量索引」，或跑 gn.py vec-index' })
            }
            return send(400, { ok: false, error: txt.slice(0, 400) })
          }
          send(200, { ok: !!out.ok, data })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: vec-search route')

    // 16.6) 建向量索引：POST /plugins/getnote/vec-index
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/vec-index',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: '只支持 POST' })
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const into = (url.searchParams.get('into') || 'current').trim() || 'current'
          const out = await runGn(config, resolveCreds(), ['vec-index', '--into', into], undefined, 600000)
          send(200, { ok: !!out.ok, output: String(out.output || '').slice(0, 4000) })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: vec-index route')

    // 17) 建索引：POST /plugins/getnote/index
    //
    // 只写本地 dataDir/state/search.db，不发任何写请求到平台。
    // 所以不需要 confirm 闸门 —— 它不是「改线上数据」的操作。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/index',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: '只支持 POST' })
        try {
          // 建 4321 篇实测 39 秒，留足余量
          const out = await runGn(config, resolveCreds(), ['index'], undefined, 300000)
          send(200, { ok: !!out.ok, code: out.code,
            output: String(out.output || '').slice(0, 20000),
            error: out.ok ? '' : String(out.error || '').slice(0, 400) })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: index route')

    // 18) 按库发布：POST /plugins/getnote/publish
    //
    // 只写本地目录，不发写请求到平台，不需要 confirm。
    // 但会生成文件，所以要求显式传 kb（防止空参数建出一堆垃圾目录）。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/publish',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: '只支持 POST' })
        let raw = ''
        try {
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 32 * 1024) throw new Error('请求体太大')
          }
          const body = JSON.parse(raw || '{}')
          const kb = String(body.kb || '').trim()
          if (!kb) return send(400, { ok: false, error: '要给知识库名 kb' })
          const argv = ['publish', '--kb', kb]
          if (body.out) argv.push('--out', String(body.out))
          const out = await runGn(config, resolveCreds(), argv, undefined, 120000)
          send(200, { ok: !!out.ok, code: out.code,
            dir: path.join(cfg(config, 'dataDir', DEFAULT_DATA_DIR), 'publish',
              String(kb).replace(/[\\/:*?"<>|]/g, '_')),
            output: String(out.output || '').slice(0, 20000),
            error: out.ok ? '' : String(out.error || '').slice(0, 400) })
        } catch (error) {
          send(400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'getnote: publish route')
    // 7) 执行日志：GET /plugins/getnote/log?lines=200
    //
    // 读 dataGetbrain/logs/<YYYYMMDD>.jsonl 的最后 N 条（审计日志，一行一个请求）。
    // 为什么不在界面里直接拉文件：浏览器拿不到 fs；也不应该把整个目录暴露出去。
    //
    // 不缓存：日志随时在长，而读一个 jsonl 尾巴很快；缓存反而让用户以为没动。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/getnote/log',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const want = Math.min(Math.max(Number(url.searchParams.get('lines') || 200), 1), 2000)
          const dir = path.join(cfg(config, 'dataDir', DEFAULT_DATA_DIR), 'logs')
          if (!existsSync(dir)) return send(200, { ok: true, lines: [], file: '', note: '还没有日志目录' })
          // 取最新的一天。日期取自文件名 YYYYMMDD.jsonl。
          const files = await fspReaddir(dir).catch(() => [])
          const days = files.filter((f) => /^\d{8}\.jsonl$/.test(f)).sort()
          if (!days.length) return send(200, { ok: true, lines: [], file: '', note: '还没有日志文件' })
          const latest = path.join(dir, days[days.length - 1])
          const txt = await readFile(latest, 'utf8')
          const all = txt.split(/\r?\n/).filter(Boolean)
          const tail = all.slice(-want)
          // 每条压成一行人能读的摘要，不把整个 JSON 堆到界面上
          const lines = tail.map((raw) => {
            try {
              const o = JSON.parse(raw)
              const status = o.dry_run ? 'DRY-RUN' : (o.success === false ? 'FAIL' : 'OK')
              const code = o.code != null ? ` code=${o.code}` : ''
              const reason = o.reason ? ` ${o.reason}` : ''
              const dur = o.duration_ms != null ? ` ${o.duration_ms}ms` : ''
              return `${o.ts || ''}  ${status}  ${o.method || ''} ${o.path || ''}${code}${reason}${dur}  ${o.note || ''}`.trim()
            } catch {
              return raw.slice(0, 200)
            }
          })
          send(200, { ok: true, file: path.basename(latest), total: all.length, lines })
        } catch (error) {
          send(500, { ok: false, error: String(error && error.message || error) })
        }
      },
    }), 'getnote: log route')
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
    // 相对路径的基准是 WORKSPACE（= 插件目录的上一级，现在是 C:\dsh\dw-plugin），
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
