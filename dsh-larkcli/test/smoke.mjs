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
const fakeCtx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  tools: { register(def) { tools.push(def); return () => {} } },
  inject(_names, fn) { fn({ effect: fakeCtx.effect, webServer: { register() { return () => {} } } }) },
  set() {},
}
mod.apply(fakeCtx, {})
console.log('\n注册工具数 =', tools.length)
for (const t of tools) console.log(' -', t.name)
assert.equal(tools.length, 9)

// 每个工具必须有 description / parameters / execute
for (const t of tools) {
  assert.ok(t.description && t.description.length > 10, `${t.name} 缺 description`)
  assert.equal(t.parameters?.type, 'object', `${t.name} parameters 不是 object`)
  assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`)
}
console.log('\neffects =', effects.length)
console.log('\n✅ index.js 结构与工具注册检查通过')
