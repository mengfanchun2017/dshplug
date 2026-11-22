// 临时渲染检查：把 client.js 里的 CredAccountCard 抽出来，用最小 React 桩跑一遍。
//
// 为什么需要这个：node --check 只验语法，不验「C.xxx / S.xxx 拼错」「渲染时取 undefined 字段」
// 这类静默失败。上一版就是靠这个发现 --dsw-font-mono 从未定义。
//
// 用法：node tools/_render-check.mjs
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

// ---- 1. 从源码里定位 CredAccountCard 与其依赖，拼成一个可执行片段 ----
const startMark = 'function CredAccountCard(props) {'
const i = src.indexOf(startMark)
if (i < 0) throw new Error('找不到 CredAccountCard')
// 组件到下一个顶层函数注释为止
const endMark = '\n    // 单行检查项'
const j = src.indexOf(endMark, i)
if (j < 0) throw new Error('找不到组件结尾标记')
const compSrc = src.slice(i, j)

// StatusRows：GCM 路径/来源/找过哪里这一组行。
// 【为什么要在这里也验】0.4.5 起面板会把 gcmHow / gcmTried / gcmHint 画出来，
// 而这三项是宿主新增字段 —— 渲染时取 undefined 不会报错，只会静默变空。
const srStart = src.indexOf('function StatusRows(props) {')
if (srStart < 0) throw new Error('找不到 StatusRows')
const srEnd = src.indexOf('// 六项持续监控', srStart)
if (srEnd < 0) throw new Error('找不到 StatusRows 结尾标记')
const statusSrc = src.slice(srStart, srEnd)

// Row 是 StatusRows 的依赖，单独抽出来
const rowStart = src.indexOf('const Row = ({ k, v, mono = true }) =>')
const rowEnd = src.indexOf('const LEVEL_TEXT', rowStart)
if (rowStart < 0 || rowEnd < 0) throw new Error('找不到 Row')
const rowSrc = src.slice(rowStart, rowEnd)
// C 对象
const cStart = src.indexOf('const C = {')
const cEnd = src.indexOf('\n    };', cStart)
const cSrc = src.slice(cStart, cEnd + '\n    };'.length)

// S 对象（只取 S.card / S.hint / S.inlineCode 用到的部分：整块取）
const sStart = src.indexOf('const S = {')
const sEnd = src.indexOf('\n    };', sStart)
const sSrc = src.slice(sStart, sEnd + '\n    };'.length)

// ---- 2. 最小 React 桩：createElement 生成普通对象树，useState 用槽位 ----
let hookSlots = []
let hookIdx = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState: (init) => {
    const k = hookIdx++
    if (!(k in hookSlots)) hookSlots[k] = typeof init === 'function' ? init() : init
    return [hookSlots[k], (v) => { hookSlots[k] = v }]
  },
  useEffect: () => {},
}
function useState(init) { return react.useState(init) }

const factory = new Function('react', 'useState', `
${cSrc}
${sSrc}
${rowSrc}
${statusSrc}
${compSrc}
return { CredAccountCard, StatusRows }
`)
const { CredAccountCard, StatusRows } = factory(react, useState)

// StatusRows 只读字段、无 hook，直接当函数调即可（无需 createElement）
function renderStatus(st) {
  return textOf(StatusRows({ st }))
}

// ---- 3. 渲染成纯文本，便于断言 ----
function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  // 【坑】createElement(Row, { k, v }) 生成的是「待渲染的函数组件」节点，
  // children 为空、文本全在 props 里。不在这里展开就会把 Row 的内容当成空 ——
  // 表象是断言「缺少 GCM 路径」，而组件其实渲染得完全正确。
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  const own = node.children.map(textOf).join('')
  return own
}
function render(st, opened) {
  hookSlots = [];
  hookIdx = 0;
  // useState(false) 是展开开关：先占位成 opened，模拟用户点开「+」后的那一帧。
  if (opened) hookSlots[0] = true;
  return textOf(CredAccountCard({ st }));
}

const cases = [
  {
    name: '有凭据 + 有机器名',
    st: {
      credAccounts: { 'LegacyGeneric:target=git:https://github.com': 'mengfanchun2017' },
      credTargets: ['LegacyGeneric:target=git:https://github.com'],
      machine: 'REDMIPRO',
      proxy: 'http://127.0.0.1:7897',
    },
    must: [
      'GitHub 授权对账（账号：mengfanchun2017）',
      '/personal-access-tokens',
      '/tokens',
      '/security-log',
      '/applications',
    ],
    mustNot: ['方法 2：用「撤销 + 重登」反推'],
  },
  {
    name: '无凭据（降级）',
    st: { credAccounts: {}, credTargets: [], machine: '', proxy: '' },
    must: ['本机还没有存凭据', 'GitHub 授权对账'],
    mustNot: ['账号：undefined'],
  },
  {
    name: '展开说明（点开 + 号后）',
    st: {
      credAccounts: { 'LegacyGeneric:target=git:https://github.com': 'mengfanchun2017' },
      credTargets: ['LegacyGeneric:target=git:https://github.com'],
      machine: 'REDMIPRO',
      proxy: 'http://127.0.0.1:7897',
    },
    opened: true,
    must: [
      '方法 1（最准）：看安全日志的 IP/城市',
      '方法 2：为什么「撤销一个」会命中多台机器',
      '每台机器单独登录一次',
      '所有 token 一起作废',
      '方法 3：OAuth 授权不能加「-机器名」后缀',
      'App 发布方注册 App 时写死的',
      'REDMIPRO',
      'REDMIPRO-YYYYMMDD',
      '方法 4：不猜，直接分账号',
    ],
    mustNot: ['用「撤销 + 重登」反推'],
  },
  {
    name: '全空（首帧）',
    st: {},
    // “全空”要验的是降级不崩：连扩展到好用都不许出现 undefined。
    opened: true,
    must: ['GitHub 授权对账', '本机还没有存凭据', '(未探测到)'],
    mustNot: ['undefined'],
  },
]

// ---- StatusRows 的用例：GCM 路径三态 ----
// 这三个用例直接对应本次 bug：旧版只 push 一个 st.gcmPath，
// 找不到时既不说「找过哪里」也不说下一步做什么。
const statusCases = [
  {
    name: 'StatusRows：GCM 找到时带来源',
    st: {
      store: '(default = wincredman)', helper: 'manager', scoped: '(无)',
      gcmPath: 'C:\\Program Files\\Git\\ucrt64\\bin\\git-credential-manager.exe',
      gcmHow: 'git --exec-path',
    },
    must: ['GCM 路径', 'git-credential-manager.exe', 'git --exec-path'],
    mustNot: ['undefined', '已找过'],
  },
  {
    name: 'StatusRows：GCM 找不到时列出找过哪里',
    st: {
      store: 'wincredman', helper: 'manager-core', scoped: '(无)',
      gcmPath: '',
      gcmTried: ['PATH 逐目录（18 个目录）', 'git --exec-path = C:/Program Files/Git/ucrt64/libexec/git-core'],
      gcmHint: 'gitconfig 里 credential.helper 写的是 `manager-core`，GCM 2.3.0 起已删除该别名',
    },
    must: ['❌ 未找到', '已找过', 'PATH 逐目录', 'git --exec-path', '诊断', 'manager-core'],
    mustNot: ['undefined'],
  },
  {
    // 旧宿主（没重启）返回的 status 没有新字段：必须静默降级，不能报错也不能出 undefined
    name: 'StatusRows：旧宿主无新字段（降级）',
    st: { store: 'wincredman', helper: 'manager', scoped: '(无)', gcmPath: 'C:\\gcm.exe' },
    must: ['GCM 路径', 'C:\\gcm.exe'],
    mustNot: ['undefined', '（undefined）', '已找过', '诊断'],
  },
]

let bad = 0

// 统一跑法：renderer 决定这类用例调哪个组件
const suites = [
  { cases, render: (c) => render(c.st, c.opened) },
  { cases: statusCases, render: (c) => renderStatus(c.st) },
]

for (const suite of suites) {
  for (const c of suite.cases) {
    let out = ''
    try {
      out = suite.render(c)
    } catch (err) {
      console.log(`❌ ${c.name} —— 渲染抛错: ${err.message}`)
      bad++
      continue
    }
    const missing = c.must.filter((s) => !out.includes(s))
    const leaked = c.mustNot.filter((s) => out.includes(s))
    if (missing.length || leaked.length) {
      bad++
      console.log(`❌ ${c.name}`)
      if (missing.length) console.log('   缺少:', missing)
      if (leaked.length) console.log('   不该出现:', leaked)
    } else {
      console.log(`✅ ${c.name}`)
    }
  }
}

// ---- 4. 静态扫描：C.* / S.* 引用是否都有定义 ----
const cKeys = new Set([...cSrc.matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]))
const sKeys = new Set([...sSrc.matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]))
const usedC = new Set([...src.matchAll(/\bC\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
const usedS = new Set([...src.matchAll(/\bS\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
const badC = [...usedC].filter((k) => !cKeys.has(k))
const badS = [...usedS].filter((k) => !sKeys.has(k))
console.log(`\nC 定义 ${cKeys.size} / 引用 ${usedC.size}` + (badC.length ? ` ❌ 未定义: ${badC}` : ' ✅'))
console.log(`S 定义 ${sKeys.size} / 引用 ${usedS.size}` + (badS.length ? ` ❌ 未定义: ${badS}` : ' ✅'))
if (badC.length || badS.length) bad++

console.log(bad ? `\n失败 ${bad} 项` : '\n全部通过')
process.exit(bad ? 1 : 0)
