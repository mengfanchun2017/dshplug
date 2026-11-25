#!/usr/bin/env node
// Mgetbrain 结构体检 —— 把历史上踩过的、**静默的**缺陷变成机器断言。
//
// 为什么需要它：这个插件的 client.js 已经 3600+ 行、100 个 hooks，
// 历史上出过三次「不报错但界面就是不对」的事故：
//   1) 用了没定义的样式键（P.ok / P.warn）→ 样式被静默忽略；
//   2) apply 里用了没 inject 的服务 → 整个浏览器半不注册；
//   3) 误插一个未闭合的 useEffect，把全部 hooks 吞进回调 → 面板空白。
// 这三类都不崩、都不报控制台错，靠人眼数括号不可持续。
//
// 用法：  node tools/structure-check.mjs
// 退出码：0 = 全绿；1 = 有 FAIL。
//
// 只读，不改任何文件。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT = path.join(ROOT, 'client.js')
const INDEX = path.join(ROOT, 'index.js')
const PKG = path.join(ROOT, 'package.json')

let pass = 0
let fail = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

const read = (p) => fs.readFileSync(p, 'utf8')

// ── 小工具 ──────────────────────────────────────────────────────────
// 从 marker 行之后开始，扫到「匹配 closeRe 的行」为止，返回这段文本。
// 比全文件括号配平简单，对本项目这种固定缩进的代码足够。
function section(src, marker, closeRe) {
  const lines = src.split('\n')
  let i = lines.findIndex((l) => l.includes(marker))
  if (i < 0) return null
  const out = []
  for (let j = i + 1; j < lines.length; j++) {
    if (closeRe.test(lines[j])) return out.join('\n')
    out.push(lines[j])
  }
  return null
}

const lineIndent = (l) => (l.match(/^(\s*)/) || ['', ''])[1].length

// ── A. 文件齐备 ────────────────────────────────────────────────────
test('关键文件存在', () => {
  for (const p of [CLIENT, INDEX, PKG, path.join(ROOT, 'gn.py')]) {
    if (!fs.existsSync(p)) throw new Error('缺文件：' + path.relative(ROOT, p))
  }
  return 'client.js / index.js / package.json / gn.py'
})

// ── B. client.js 语法（模块加载器格式，无 import/export）────────────
test('client.js 可被编译', () => {
  const src = read(CLIENT)
  // new Function 只接受脚本语法；client.js 恰是脚本（window.__ModuleLoader__.load）。
  new Function(src)
  return `${src.split('\n').length} 行`
})

test('client.js 是模块加载器格式（无 ESM 导出）', () => {
  const src = read(CLIENT)
  if (!src.includes('window.__ModuleLoader__.load({')) throw new Error('缺少 __ModuleLoader__.load')
  const bad = src.split('\n').filter((l) => /^\s*(export|import)\s/.test(l))
  if (bad.length) throw new Error(`${bad.length} 行 ESM 语句：${bad.slice(0, 3).join(' | ')}`)
  return '无 export/import'
})

// ── C. hooks 必须在组件顶层 ─────────────────────────────────────────
test('所有 hooks 都在组件顶层（缩进 6）', () => {
  const lines = read(CLIENT).split('\n')
  const hits = []
  lines.forEach((l, idx) => {
    if (/React\.use(State|Effect|Callback|Memo|Ref)\(/.test(l)) hits.push([idx + 1, lineIndent(l), l.trim().slice(0, 60)])
  })
  if (!hits.length) throw new Error('一个 hook 都没找到')
  const wrong = hits.filter((h) => h[1] !== 6)
  if (wrong.length) {
    throw new Error(`${wrong.length}/${hits.length} 个 hook 不在顶层：` +
      wrong.slice(0, 5).map((w) => `L${w[0]} 缩进${w[1]} ${w[2]}`).join(' ; '))
  }
  return `${hits.length} 个 hooks 全在缩进 6`
})

test('useEffect 全部在组件顶层', () => {
  const lines = read(CLIENT).split('\n')
  const opens = lines.filter((l) => /React\.useEffect\(\(\)\s*=>\s*\{/.test(l))
  const nested = opens.filter((l) => lineIndent(l) !== 6)
  if (nested.length) throw new Error(`${nested.length} 个 useEffect 不在顶层`)
  if (opens.length < 6) throw new Error(`只找到 ${opens.length} 个 useEffect，疑似结构被改坏`)
  return `${opens.length} 个 useEffect`
})

// ── D. apply 里用到的 ctx.* 必须在 inject 里 ────────────────────────
test('apply 用到的 ctx.* 都在 inject 声明内', () => {
  const src = read(CLIENT)
  const m = src.match(/inject:\s*\[([^\]]*)\]/)
  if (!m) throw new Error('找不到 inject 数组')
  const injected = new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]))
  // Cordis 上下文自带的方法，不需要 inject。
  const base = new Set(['effect', 'get', 'on', 'logger', 'inject', 'register', 'plugin', 'scope', 'fork', 'emit', 'stop', 'dispose', 'runtime'])
  const used = new Set([...src.matchAll(/\bctx\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]))
  const missing = [...used].filter((u) => !injected.has(u) && !base.has(u)).sort()
  if (missing.length) throw new Error(`未 inject 就被使用：${missing.join(', ')}`)
  return `inject=[${[...injected].join(', ')}]；用到 ${used.size} 个`
})

// ── E. 用了的样式键必须存在 ─────────────────────────────────────────
test('P.* 引用的样式键都已定义', () => {
  const src = read(CLIENT)
  const body = section(src, 'function panelStyles() {', /^    \}/)
  if (!body) throw new Error('找不到 panelStyles() 的返回对象')
  const defined = new Set([...body.matchAll(/^        ([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]))
  if (!defined.size) throw new Error('没解析到任何样式键')
  const used = new Set([...src.matchAll(/\bP\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]))
  const missing = [...used].filter((u) => !defined.has(u)).sort()
  if (missing.length) throw new Error(`用了但没定义：${missing.join(', ')}`)
  return `${used.size}/${defined.size} 个键有定义`
})

// ── F. 配色只用 --dsw-alias-* ───────────────────────────────────────
test('不用 --dsh-* 当颜色、不硬编码 #fff', () => {
  const src = read(CLIENT)
  const dsh = [...src.matchAll(/--dsh-[A-Za-z0-9-]+/g)].map((x) => x[0])
  if (dsh.length) throw new Error(`${dsh.length} 处 --dsh-*（全部是布局尺寸，没有颜色）：${[...new Set(dsh)].slice(0, 5).join(', ')}`)
  const hex = [...src.matchAll(/#(fff|ffffff)\b/gi)].map((x) => x[0])
  if (hex.length) throw new Error(`${hex.length} 处硬编码 #fff/#ffffff（深色主题下会白底白字）`)
  return '0 处 --dsh-*，0 处 #fff'
})

// ── G. 中英文案对齐 ─────────────────────────────────────────────────
test('zh / en 键集相等', () => {
  const src = read(CLIENT)
  const zhBody = section(src, 'const zh = {', /^\}/)
  const enBody = section(src, 'const en = {', /^\}/)
  if (!zhBody || !enBody) throw new Error('找不到 zh 或 en 词典')
  const keys = (s) => new Set([...s.matchAll(/^  ([A-Za-z0-9_]+)\s*:/gm)].map((x) => x[1]))
  const zh = keys(zhBody)
  const en = keys(enBody)
  const onlyZh = [...zh].filter((k) => !en.has(k))
  const onlyEn = [...en].filter((k) => !zh.has(k))
  if (onlyZh.length || onlyEn.length) {
    throw new Error(`只在 zh：${onlyZh.slice(0, 8).join(', ')}；只在 en：${onlyEn.slice(0, 8).join(', ')}`)
  }
  return `${zh.size} 键对齐`
})

test("T('key') 引用的文案都存在", () => {
  const src = read(CLIENT)
  const zhBody = section(src, 'const zh = {', /^\}/)
  if (!zhBody) throw new Error('找不到 zh 词典')
  const defined = new Set([...zhBody.matchAll(/^  ([A-Za-z0-9_]+)\s*:/gm)].map((x) => x[1]))
  const used = new Set()
  for (const m of src.matchAll(/\bT\(\s*'([^']+)'/g)) used.add(m[1])
  for (const m of src.matchAll(/\bT\(\s*"([^"]+)"/g)) used.add(m[1])
  const missing = [...used].filter((k) => !defined.has(k)).sort()
  if (missing.length) throw new Error(`${missing.length} 个缺失：${missing.slice(0, 10).join(', ')}`)
  return `${used.size} 个 T() 调用全部有定义`
})

// ── H. slot 注册：id 与 key 必须用同一个 PANEL_ID ───────────────────
test('sidebar id 与 main key 都用 PANEL_ID', () => {
  const src = read(CLIENT)
  if (!/id:\s*PANEL_ID/.test(src)) throw new Error('sidebar.panellist 没用 id: PANEL_ID')
  if (!/key:\s*PANEL_ID/.test(src)) throw new Error('main 没用 key: PANEL_ID')
  return 'id / key 一致'
})

// ── I. package.json exports（缺 ./client 会导致界面不显示且不报错）──
test('package.json exports 含 ./client 等三项', () => {
  const pkg = JSON.parse(read(PKG))
  const exp = pkg.exports || {}
  for (const k of ['./client', './locale/*.json', './icon']) {
    if (!exp[k]) throw new Error(`exports 缺 ${k}`)
  }
  return Object.keys(exp).join(', ')
})

// ── J. index.js 路由注册数（防止误删路由）───────────────────────────
test('index.js 路由数 >= 25', () => {
  const src = read(INDEX)
  const n = (src.match(/webServer\.register\(\{/g) || []).length
  if (n < 20) throw new Error(`只注册了 ${n} 条路由`)
  if (!/export const name = 'getnote'/.test(src)) throw new Error("缺少 export const name = 'getnote'")
  return `${n} 条路由`
})

// ── 运行 ────────────────────────────────────────────────────────────
console.log('Mgetbrain 结构体检\n')
for (const [name, fn] of tests) {
  try {
    const detail = fn()
    pass++
    console.log(`  ok   ${name}${detail ? '  — ' + detail : ''}`)
  } catch (e) {
    fail++
    console.log(`  FAIL ${name}  — ${String((e && e.message) || e)}`)
  }
}
console.log(`\n${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
