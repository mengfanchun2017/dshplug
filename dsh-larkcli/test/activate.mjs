// 用真实 Cordis 运行时验证 apply()：模拟未加载 webServer 与已加载两种情形，
// 并把 apply 抛出的任何异常显式打印出来（而不是让它静默吞掉整个插件）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { apply, name, inject } = await import('../lib/index.js')

// 插件根目录：用来检查「垃圾 config 会不会在仓库里建出目录」
const pluginRoot = path.resolve(import.meta.dirname, '..')

console.log('name =', name, '| inject =', JSON.stringify(inject))

// 场景 1：最小 ctx（只有 tools，没有 webServer）—— 插件必须仍能注册工具
const tools1 = []
const effects1 = []
const ctxMinimal = {
  effect(fn, label) {
    effects1.push(label)
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  tools: { register(def) { tools1.push(def.name); return () => {} } },
  inject(names, fn) { effects1.push('inject:' + names.join(',')) /* 故意不调用：模拟服务缺失 */ },
}

let err1 = null
try {
  apply(ctxMinimal, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lark-min-')), autoMigrate: false })
} catch (e) {
  err1 = e
}
console.log('\n[最小 ctx] 异常 =', err1 ? err1.constructor.name + ': ' + err1.message : '无')
console.log('[最小 ctx] 工具数 =', tools1.length)
console.log('[最小 ctx] effects =', effects1.length)
assert.equal(err1, null, '没有 webServer 时 apply 不应抛异常')
assert.equal(tools1.length, 9, '工具仍应全部注册')

// 场景 2：完整 ctx（含 webServer）—— 应额外注册 HTTP 路由
const tools2 = []
const routes = []
const ctxFull = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  tools: { register(def) { tools2.push(def.name); return () => {} } },
  inject(_n, fn) {
    fn({
      effect: ctxFull.effect,
      webServer: { register(route) { routes.push(route.path); return () => {} } },
    })
  },
}

let err2 = null
try {
  apply(ctxFull, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lark-full-')), autoMigrate: false })
} catch (e) {
  err2 = e
}
console.log('\n[完整 ctx] 异常 =', err2 ? err2.constructor.name + ': ' + err2.message : '无')
console.log('[完整 ctx] 工具数 =', tools2.length)
console.log('[完整 ctx] 路由 =', JSON.stringify(routes))
assert.equal(err2, null, '完整 ctx 下 apply 不应抛异常')
assert.equal(tools2.length, 9)
assert.equal(routes.length, 4, '应注册 4 条路由')

// 场景 3：config 为 undefined（行里没写 config）—— 不能崩
let err3 = null
try {
  apply(ctxMinimal, undefined)
} catch (e) {
  err3 = e
}
console.log('\n[config=undefined] 异常 =', err3 ? err3.constructor.name + ': ' + err3.message : '无')
assert.equal(err3, null, 'config 缺失不应崩')

// 场景 4：config 里全是垃圾值 —— 不能崩、要回落默认
// 场景 4：config 里全是垃圾值 —— 不能崩、要回落默认，且在仓库里**不能建出目录**
const beforeDirs = new Set(fs.readdirSync(pluginRoot).filter((n) => fs.statSync(path.join(pluginRoot, n)).isDirectory()))
let err4 = null
const realCwd = process.cwd()
try {
  process.chdir(pluginRoot)
  apply(ctxMinimal, { dataDir: 123, timeoutMs: 'abc', maxChars: null, autoMigrate: 'yes', statusTtlMs: 0 })
} catch (e) {
  err4 = e
} finally {
  process.chdir(realCwd)
}
console.log('[垃圾 config] 异常 =', err4 ? err4.constructor.name + ': ' + err4.message : '无')
assert.equal(err4, null, '垃圾 config 不应崩')

// 关键回归：早先 dataDir:123 会在插件目录里建出 `123\`（相对 cwd 当作目录名）
for (const junk of ['123', 'null', 'undefined', 'true']) {
  assert.ok(!fs.existsSync(path.join(pluginRoot, junk)), `不得在插件目录建出 ${junk}/`)
}
const afterDirs = new Set(fs.readdirSync(pluginRoot).filter((n) => fs.statSync(path.join(pluginRoot, n)).isDirectory()))
const added = [...afterDirs].filter((n) => !beforeDirs.has(n))
assert.deepEqual(added, [], `垃圾 config 不得新建任何目录，实际新增：${added.join(',')}`)

// 场景 5：相对路径的 dataDir 也必须拒绝（会落到 cwd，违反「数据在仓库外」）
process.chdir(pluginRoot)
try {
  apply(ctxMinimal, { dataDir: 'relative-dir' })
} finally {
  process.chdir(realCwd)
}
assert.ok(!fs.existsSync(path.join(pluginRoot, 'relative-dir')), '相对 dataDir 不得被采用')
console.log('[相对 dataDir] 已拒绝，未建目录')

console.log('\n✅ apply() 在 5 种上下文下均正常，且未污染仓库目录')
