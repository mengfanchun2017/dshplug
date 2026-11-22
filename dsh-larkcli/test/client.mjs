// 浏览器半的静态检查：不启浏览器，只验证模块形态与 apply 的 slot 注册行为。
// 这是「初始态 / 失败态」覆盖的关键：
//   1) factory 能被调用、导出 name/inject/apply
//   2) apply 用 ctx.locale.bind 而不是直接返回字符（否则导航栏不翻译）
//   3) slots.register 收到 settings.section + order + label 回调
//   4) 渲染函数不抛（用极简 fake react 走一遍主组件树）
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve(import.meta.dirname, '..', 'lib', 'client.js')
const src = fs.readFileSync(file, 'utf8')

console.log('== 浏览器半静态检查 ==')
console.log(`文件大小：${(src.length / 1024).toFixed(1)} KB`)

// 1) 必须是 ModuleLoader 形态
assert.ok(src.includes('window.__ModuleLoader__.load('), '必须是 __ModuleLoader__.load 形态')
assert.ok(src.includes("id: 'dsh-larkcli'"), 'id 必须存在')
assert.ok(src.includes('module.exports = { name:'), '必须导出 Cordis 模块')

// 2) 不 import primitives（官方 UI 规则）
assert.ok(!/require\(['"]@deepseek-ai\/dsh-client-ui-primitives/.test(src), '不得 import UI primitives')

// 3) 面板只发意图，不发密钥
assert.ok(!/secret\s*:/i.test(src.replace(/\/\/[^\n]*/g, '')), '请求体里不应出现 secret 字段')

// ── 用假 window + 假 react 真正执行一次 factory ──────────────────────────────
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loaded = def
    },
  },
}

// 极简 fake react：createElement 返回树，hooks 用内存实现
const hookState = []
let hookIdx = 0
const fakeReact = {
  useState(init) {
    const i = hookIdx++
    if (hookState[i] === undefined) hookState[i] = init
    return [hookState[i], (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }]
  },
  useEffect(fn) { hookIdx++ }, // 测试里不跑 effect（避免 fetch）
  useCallback(fn) { hookIdx++; return fn },
  useRef(init) { hookIdx++; return { current: init } },
  createElement(type, props, ...children) {
    return { type, props, children }
  },
}

const fakeRequire = (mod) => {
  if (mod === 'react') return fakeReact
  throw new Error(`unexpected require: ${mod}`)
}

// 执行文件（把 window 当全局）
new Function('window', 'fetch', src)(globalThis.window, async () => ({ ok: true, json: async () => ({ ok: true, snapshot: { accounts: [], defaultId: '' }, layout: { binaryExists: true, binary: 'x', dataDir: 'y', accountsFile: 'z' }, version: '1.0.99' }) }))

assert.ok(loaded, 'factory 应已注册')
const mod = loaded.factory(fakeRequire)
console.log('name   =', mod.name)
console.log('inject =', JSON.stringify(mod.inject))
assert.equal(mod.name, 'dsh-larkcli')
assert.deepEqual(mod.inject, ['slots', 'locale'])

// ── inject 完整性守卫（回归：0.2.0 设置"里";什么都没有） ──
// 真实事故：apply 里用了 ctx.locale，inject 却只写 ['slots']。
// Cordis 只注入声明过的服务，没列就是 undefined，apply 首行抛 TypeError，
// 整个浏览器半不注册——控制台干净、不报错、设置里凭空蒸发。
// 这里不针对 locale 写死，而是把源码里所有 ctx.xxx 抽出来逐个核。
// 先剥注释与字符串字面量，否则注释里的 "ctx.xxx" 这类示例文字会被当成真用法扫进来。
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
const ctxServices = [...new Set(
  [...codeOnly.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
)].filter((s) => !['effect'].includes(s)); // effect 是 ctx 自带方法，不是注入的服务
for (const svc of ctxServices) {
  assert.ok(
    mod.inject.includes(svc),
    `apply 用了 ctx.${svc}，但 inject 里没有 '${svc}' —— Cordis 会传 undefined，整个浏览器半会静默不注册`,
  )
}
assert.ok(
  ctxServices.includes('locale') && ctxServices.includes('slots'),
  `取样失败：应从源码里找到 ctx.locale 与 ctx.slots，实际得到 ${JSON.stringify(ctxServices)}`,
)
assert.equal(typeof mod.apply, 'function')

// ── 跑 apply，检查 slot 注册 ────────────────────────────────────────────────
const registered = []
const dicts = []
const fakeCtx = {
  effect(fn) { return fn() },
  locale: {
    register(ns, d) { dicts.push({ ns, d }) },
    // 关键：必须真的提供 bind（写 const t = s => s 会拿不到翻译）
    bind(ns) { return (k) => `${ns}:${k}` },
  },
  slots: {
    inject(owner, fn) { assert.equal(owner, 'settings.section'); return fn() },
    register(decl, comp) { registered.push({ decl, comp }); return () => {} },
  },
}
mod.apply(fakeCtx)

assert.ok(dicts.length === 1, '应注册一份 locale 字典')
assert.equal(dicts[0].d.zh.nav, 'Mlarkcli', 'zh.nav 必须是 M+技能名 全小写')
assert.equal(dicts[0].d.en.nav, 'Mlarkcli', 'en.nav 应同名（品牌标识不翻译）')
// 仓库约定：显示名必须是 /^M[a-z0-9]+$/，不是旧的中文「飞书」
assert.match(dicts[0].d.zh.nav, /^M[a-z0-9]+$/, '显示名必须是 M+小写技能名')
// locale 文件与 client.js 必须写同一个名字，否则界面两处会不一致
const zhFile = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'locale', 'zh.json'), 'utf8'))
const enFile = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'locale', 'en.json'), 'utf8'))
assert.equal(zhFile.nav, dicts[0].d.zh.nav, 'locale/zh.json 的 nav 与 client.js 不一致')
assert.equal(enFile.nav, dicts[0].d.en.nav, 'locale/en.json 的 nav 与 client.js 不一致')
assert.equal(zhFile.meta.title, 'Mlarkcli', 'meta.title 也要用同一个显示名')
console.log('字典  =', JSON.stringify(dicts[0].d))

assert.equal(registered.length, 1, '应注册 1 个 settings.section')
const { decl, comp } = registered[0]
console.log('slot  =', JSON.stringify({ id: decl.id, name: decl.name, order: decl.order }))
assert.equal(decl.name, 'settings.section')
assert.equal(decl.id, 'larkcli')
assert.equal(typeof decl.order, 'number')
assert.equal(typeof decl.label, 'function')
assert.ok(decl.label().includes('nav'), 'label 必须走 locale.bind（返回值应含绑定痕迹）')
assert.equal(typeof comp, 'function', '组件必须是函数组件')

// 4) 渲染一次主组件（hooks 走 fake，effect 不执行 → 走 loading 初始态）
hookIdx = 0
hookState.length = 0
const tree = comp({})
assert.ok(tree && tree.type === 'div', '初始态必须能渲染出根节点')
console.log('初始态渲染：OK（无异常，loading 分支）')

// ── 5) 渲染新增的子组件 ────────────────────────────────────────────────────
// 这些是 v0.2.0 加的：身份块、权限清单、安装卡。
// 它们引用了一堆新变量（C、ident、mono 等），漏一个就是「点开就白屏」——
// 而 createElement 的参数是**先求值再传**的，所以只要组件函数跑一遍，
// 未定义变量就会当场抛 ReferenceError，不用启浏览器。

// 主面板带真实数据（有账户）也要能渲染
const fullAcc = {
  id: 'default',
  label: '默认账户',
  description: '测试账户',
  tags: ['研发'],
  appId: 'cli_x',
  brand: 'feishu',
  isDefault: true,
  bot: true,
  user: false,
  hasSecret: true,
  dir: 'C:/x',
}

// 用带账户的 /status 响应重跑一次（模拟真实宿主返回）
globalThis.window.__ModuleLoader__ = { load: (d) => { loaded = d } }
let loaded2 = null
globalThis.window = { __ModuleLoader__: { load: (d) => { loaded2 = d } } }
new Function('window', 'fetch', src)(
  globalThis.window,
  async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      snapshot: { accounts: [fullAcc], defaultId: 'default' },
      layout: { binaryExists: true, binary: 'C:/x/lark-cli.exe', dataDir: 'C:/d', accountsFile: 'C:/d/a.json' },
      version: '1.0.100',
    }),
  }),
)
assert.ok(loaded2, '第二次加载应成功')
const mod2 = loaded2.factory(fakeRequire)
const reg2 = []
mod2.apply({
  effect(fn) { return fn() },
  locale: { register() {}, bind: () => (k) => k },
  slots: { inject(o, fn) { return fn() }, register(decl, c) { reg2.push(c); return () => {} } },
})
const mainWithData = reg2[0]
hookIdx = 0
hookState.length = 0
/*
 * 假 react 的 useEffect 不执行，所以 fetch 永远不会回来，
 * 首帧的 data 永远是 null → 一个账户卡片也不会渲染。
 * 想测「有账户时」的样子，必须直接把状态种进去（这是上一版只测初始态漏掉的点）。
 */
hookState[0] = {
  ok: true,
  snapshot: { accounts: [fullAcc], defaultId: 'default' },
  layout: { binaryExists: true, binary: 'C:/x/lark-cli.exe', dataDir: 'C:/d', accountsFile: 'C:/d/a.json' },
  version: '1.0.100',
}
const treeWithData = mainWithData({})
assert.ok(treeWithData && treeWithData.type === 'div', '带账户数据的主面板必须能渲染')
console.log('带数据渲染：OK（每账户卡片 + 安装卡都在树里）')

// 确认安装卡与新按钮真的进了渲染树（防止“改了代码但没接上”）
const flat = (t, out = []) => {
  if (!t || typeof t !== 'object') return out
  if (Array.isArray(t)) { for (const x of t) flat(x, out); return out }
  out.push(t)
  for (const c of t.children || []) flat(c, out)
  return out
}
const nodes = flat(treeWithData)
/*
 * 注意：createElement(Component) 在假 react 里**不会展开**组件体，
 * 所以安装卡/权限清单在树里表现为 `type` 是个函数，而不是它渲染出的文字。
 * 要看「接没接上」就查组件名；要看「渲染得对不对」得单独调用组件（下面做）。
 */
const typeNames = nodes.map((n) => (typeof n.type === 'function' ? n.type.name : '')).filter(Boolean)
const texts = nodes
  .map((n) => (typeof n === 'string' ? n : n.children && n.children.filter((c) => typeof c === 'string').join('')))
  .filter(Boolean)
  .join(' | ')
assert.ok(texts.includes('飞书'), '标题丢失')
assert.ok(typeNames.includes('Installer'), '安装卡未接入主面板')
assert.ok(typeNames.includes('AccountCard'), '账户卡片未渲染')
// 再单独把两个子组件真跑一遍：createElement 的参数先求值，
// 未定义变量（mono/C/ident 之类）会当场抛。
const installerFn = nodes.find((n) => typeof n.type === 'function' && n.type.name === 'Installer').type
hookIdx = 0
hookState.length = 0
const instTree = installerFn({ version: '1.0.100' })
assert.ok(instTree && instTree.type === 'div', '安装卡初始态必须能渲染')
console.log('安装卡渲染：OK')

const cardFn = nodes.find((n) => typeof n.type === 'function' && n.type.name === 'AccountCard').type
hookIdx = 0
hookState.length = 0
const cardTree = cardFn({ acc: fullAcc, onChanged: () => {}, alive: { current: true } })
assert.ok(cardTree && cardTree.type === 'div', '账户卡片必须能渲染')
const cardNodes = flat(cardTree)
const cardText = cardNodes
  .map((n) => (typeof n === 'string' ? n : n.children && n.children.filter((c) => typeof c === 'string').join('')))
  .filter(Boolean)
  .join(' | ')
assert.ok(/权限清单/.test(cardText), '权限清单按钮未接入账户卡片')
assert.ok(/查看接入的飞书应用信息/.test(cardText), '身份入口未接入账户卡片')
/*
 * 身份块真正有数据时的渲染（目标②要求“用户姓名/头像/open_id/token 状态”）。
 * 上一轮 ident 是 null，只验到按钮；这里把 ident 直接 seed 进 hookState 再渲染，
 * 才能真验字段是否被引用到（typo 在 JS 里是 undefined 而不是报错，最隐蔽）。
 * 注意：ident 是 AccountCard 的第 7 个 useState（下标 6）：
 *   editing0 / label1 / desc2 / tags3 / busy4 / msg5 / **ident6** / showScopes7 / authUrl8
 */
const seededIdent = {
  id: 'default',
  appId: 'cli_x',
  bot: { available: true, status: 'ready', verified: true, openId: 'ou_bot', appName: 'DSH Agent' },
  user: { available: true, status: 'ready', verified: true },
  app: { appName: 'DSH Agent', avatarUrl: 'https://x/a.png', description: '测试应用', botOpenId: 'ou_bot', activateStatus: 2 },
  appScopes: { 'docs:read': 1, 'im:read': 1 },
  userProfile: { name: '张三', email: 'z@x.com', openId: 'ou_user', avatarUrl: 'https://x/u.png' },
  errors: [],
}
hookState.length = 0
hookIdx = 0
hookState[6] = seededIdent // ident（下标 6，不是 5：前面还有 msg）
const cardTree2 = cardFn({ acc: fullAcc, onChanged: () => {}, alive: { current: true } })
assert.ok(cardTree2 && cardTree2.type === 'div', '带 ident 的账户卡片必须能渲染')

/*
 * 注意：Row 是函数组件，它的 k/v 在 props 里，不在 children 里 ——
 * 只扫 children 会漏掉一切「行」文本，这正是上一轮只验按钮就够了的原因。
 * 所以这里把 props 里的字符串也收进来。
 */
const harvest = (tree) => {
  const out = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number') return out.push(String(n))
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n !== 'object') return
    const p = n.props || {}
    for (const key of ['k', 'v', 'text', 'title', 'alt', 'src']) {
      if (typeof p[key] === 'string') out.push(p[key])
    }
    ;(n.children || []).forEach(walk)
  }
  walk(tree)
  return out.join(' | ')
}
const text2 = harvest(cardTree2)

// 目标②要求的字段一个都不能少
assert.ok(text2.includes('DSH Agent'), '应用名未显示')
assert.ok(/用户 open_id/.test(text2) && text2.includes('ou_user'), '用户 open_id 未显示')
assert.ok(/张三/.test(text2), '用户姓名未显示')
assert.ok(/已验证|有效/.test(text2), 'token 状态文案未显示')
assert.ok(/应用已开通权限/.test(text2) && /2 条/.test(text2), '已开通权限数未显示')
console.log('账户卡片（含完整身份块）：OK（应用名 / 用户名 / open_id / token 状态 都在）')

// 头像：应用与用户两张都要在
const imgs = flat(cardTree2).filter((n) => n && n.type === 'img')
assert.ok(imgs.length >= 2, `头像应有应用+用户两张，实际 ${imgs.length}`)
console.log('头像：OK（应用 + 用户各一张）')

/*
 * 按钮与缺权限分支：“验证 token”/“我已完成授权”必须真的在树里。
 * 之前面板文案写了“点「验证 token」”但**根本没这个按钮** —— 纯字符串断言抓不到，
 * 只有真的去树里找按钮才算数。
 */
const btnLabels = flat(cardTree2)
  .filter((n) => n && n.type === 'button')
  .map((n) => (n.children || []).filter((c) => typeof c === 'string').join(''))
assert.ok(btnLabels.some((t) => /验证 token/.test(t)), `「验证 token」按钮不存在（现有：${btnLabels.join(' / ')}）`)
// 注意：seededIdent 的 user 已授权，所以「我已完成授权」**应该隐藏**（它只给未授权时用）
assert.ok(!btnLabels.some((t) => /我已完成授权/.test(t)), `user 已授权时不该再显示「我已完成授权」（现有：${btnLabels.join(' / ')}）`)
console.log('按钮：OK（验证 token 存在；user 已授权时「我已完成授权」正确隐藏）')

// 缺权限分支：user.missingScopes 有值时得把“缺什么 + 去哪点”摆出来
const identMissing = { ...seededIdent, user: { available: false, status: 'missing' }, userProfile: null }
identMissing.user.missingScopes = ['docs:read', 'drive:read', 'sheets:read']
identMissing.user.consoleUrl = 'https://open.feishu.cn/app/cli_x/auth'
hookState.length = 0
hookIdx = 0
hookState[6] = identMissing
const treeMissing = cardFn({ acc: fullAcc, onChanged: () => {}, alive: { current: true } })
const tMissing = harvest(treeMissing)
assert.ok(/缺 3 项权限/.test(tMissing), `缺权限数量未显示（实际：${tMissing.slice(0, 220)}）`)
assert.ok(/docs:read/.test(tMissing), '具体缺的 scope 未列出来')
const mBtns = flat(treeMissing)
  .filter((n) => n && n.type === 'button')
  .map((n) => (n.children || []).filter((c) => typeof c === 'string').join(''))
assert.ok(mBtns.some((t) => /开放平台权限页/.test(t)), '缺权限时没有「打开开放平台权限页」一键入口')
// user 未授权 → 「我已完成授权」必须出现（这才是它该出现的时候）
assert.ok(mBtns.some((t) => /我已完成授权/.test(t)), `user 未授权时必须给「我已完成授权」（现有：${mBtns.join(' / ')}）`)
console.log('缺权限分支：OK（数量 + 具体 scope + 一键入口都在）')

console.log('组件接线：OK（安装卡 / 身份 / 权限清单 都已在树里）')


console.log('\n✅ 浏览器半检查通过')
