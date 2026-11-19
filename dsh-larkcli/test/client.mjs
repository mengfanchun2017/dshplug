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
assert.deepEqual(mod.inject, ['slots'])
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

console.log('\n✅ 浏览器半检查通过')
