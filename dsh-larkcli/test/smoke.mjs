// 语法/导出检查：确认 index.js 能被 import、导出 name / inject / apply / Config
import * as mod from '../lib/index.js'
import assert from 'node:assert/strict'

console.log('name    =', mod.name)
console.log('inject  =', JSON.stringify(mod.inject))
console.log('apply   =', typeof mod.apply)
console.log('Config  =', mod.Config ? 'schemastery present' : 'undefined（宿主未提供，功能不受影响）')
console.log('version =', (await import('../package.json', { with: { type: 'json' } })).default.version)

assert.equal(mod.name, 'dsh-larkcli')
assert.deepEqual(mod.inject, ['tools'])
assert.equal(typeof mod.apply, 'function')

// 用一个最小假 ctx 跑一遍 apply，确认注册了预期数量的工具且不抛异常
const tools = []
const effects = []
// 路由：只验「有没有真接上」，不验 handler 行为（那要真服务）
// 之前这里写的是 register(){ }——什么都不记，所以**新增路由漏接时测试仍然是绿的**。
const routes = []
const fakeCtx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  tools: { register(def) { tools.push(def); return () => {} } },
  inject(_names, fn) {
    fn({ effect: fakeCtx.effect, webServer: { register(decl) { routes.push(decl.path); return () => {} } } })
  },
  set() {},
}
mod.apply(fakeCtx, {})
console.log('\n注册工具数 =', tools.length)
for (const t of tools) console.log(' -', t.name)
assert.equal(tools.length, 15)

// 每个工具必须有 description / parameters / execute
for (const t of tools) {
  assert.ok(t.description && t.description.length > 10, `${t.name} 缺 description`)
  assert.equal(t.parameters?.type, 'object', `${t.name} parameters 不是 object`)
  assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`)
}
console.log('\n注册路由数 =', routes.length)
for (const p of routes) console.log(' -', p)

// 12 条路由一条都不能少：少了界面就 404，而界面上只是“按钮没反应”
const WANT_ROUTES = [
  '/plugins/larkcli/status',
  '/plugins/larkcli/account',
  '/plugins/larkcli/default',
  '/plugins/larkcli/login-start',
  '/plugins/larkcli/check-update',
  '/plugins/larkcli/install',
  '/plugins/larkcli/identity',
  '/plugins/larkcli/scopes',
  '/plugins/larkcli/qrcode',
  '/plugins/larkcli/login-finish',
  '/plugins/larkcli/app-init',
  '/plugins/larkcli/app-init-status',
]
for (const w of WANT_ROUTES) {
  assert.ok(routes.includes(w), `路由未注册：${w}`)
}
assert.equal(routes.length, WANT_ROUTES.length, '路由数与预期不符（新增/删除请同步改这里）')

console.log('\neffects =', effects.length)

/*
 * 文档一致性：文档里写死的数字必须与真实注册数一致。
 * 这类“文档说了 9 个工具、实际 13 个”的腐臭不会让任何测试变红，
 * 但会让读文档的人算错范围，所以在这里守住。
 */
import { readFileSync } from 'node:fs'
const docOf = (n) => readFileSync(new URL(`../${n}`, import.meta.url), 'utf8')
const readme = docOf('README.md')
const bootstrap = docOf('BOOTSTRAP.md')
const adr = docOf('ADR.md')

const toolCount = tools.length
const routeCount = routes.length

assert.ok(
  readme.includes(`## 1. ${toolCount} 个工具`),
  `README 的工具数字应与实际 ${toolCount} 一致`,
)
for (const [name, text] of [['README', readme], ['BOOTSTRAP', bootstrap], ['ADR', adr]]) {
  const m = /(\d+) 条路由/.exec(text)
  if (m) assert.equal(Number(m[1]), routeCount, `${name} 里的路由数应为 ${routeCount}，实际写 ${m[1]}`)
}

const adrCount = (adr.match(/^## ADR-/gm) || []).length
const adrInReadme = /(\d+) 条决策/.exec(readme)
assert.ok(adrInReadme, 'README 里应声明 ADR 条数')
assert.equal(Number(adrInReadme[1]), adrCount, `README 说 ${adrInReadme[1]} 条决策，实际有 ${adrCount} 条`)

console.log(`文档一致性：工具 ${toolCount} / 路由 ${routeCount} / ADR ${adrCount} 均与文档声明一致`)
console.log('\n✅ index.js 结构与工具注册检查通过（工具 + 路由 + 文档一致性）')
