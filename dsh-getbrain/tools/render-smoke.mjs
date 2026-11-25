#!/usr/bin/env node
// Mgetbrain 渲染冒烟 —— 用假 React 把每个页签渲一遍，抓「语法合法但运行时报错」。
//
// 为什么需要它：`node --check` 只证明语法合法。本插件的 client.js 是 4000 行、
// 109 个 hooks 的手写 createElement 树，历史上出过「误插一个未闭合 useEffect
// 把 17 个 hooks 吞进回调 → 面板空白」这类事故 —— 语法完全合法，只有真渲一遍才暴露。
// 结构体检（structure-check.mjs）管「结构对不对」，这个管「渲不渲得出来」。
//
// 用法：  node tools/render-smoke.mjs
// 退出码：0 = 全部渲染通过；1 = 有失败。
//
// 只读，不改任何文件。它不连网、不发请求（fetch 被替换成 404 stub），
// 所以可以在任何机器上跑，不会影响真实数据。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

globalThis.window = globalThis
// node 24 的 navigator 是只读 getter，直接赋值会抛，用 defineProperty。
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } }, configurable: true,
  })
} catch { /* 已存在就不动 */ }
globalThis.document = {
  createElement: () => ({ style: {}, select() {}, value: '' }),
  body: { appendChild() {}, removeChild() {} },
}
globalThis.fetch = async () => ({ status: 0, json: async () => ({ ok: false, error: 'stub' }) })
globalThis.alert = () => {}
globalThis.setTimeout = () => 0

let factory = null
globalThis.__ModuleLoader__ = { load: (o) => { factory = o.factory } }

// ── 伪 React ────────────────────────────────────────────────────────
// useState 按调用顺序取槽位；每次渲染前把游标归零（组件里 hooks 顺序固定）。
const state = []
let cursor = 0
const h = (type, props, ...children) => ({
  type,
  props: Object.assign({}, props || {}, {
    children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
  }),
})
const React = {
  createElement: h,
  useState: (init) => {
    const i = cursor++
    if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
    return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  Component: class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
  },
}

// ── 伪 Cordis ctx：只接住注册，不真渲 ──────────────────────────────
let mainSafe = null
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => fn(),
    register: (opts, comp) => { if (opts && opts.name === 'main') mainSafe = comp },
    entriesOfSlot: () => [],
    entries: () => [],
    spec: () => null,
  },
  locale: { register() {}, bind: () => (k) => k },
  configForms: { get: () => null },
  remote: { credentials: {} },
  tools: { register() {} },
  webServer: { register() {} },
  logger: { info() {}, warn() {}, error() {} },
}

// 源码里的 require 是自由变量，用 new Function 的参数注进去。
new Function('require', src)((name) => React)
const plugin = factory((name) => React)
plugin.apply(ctx)

// mainSafe = h(GetnoteErrorBoundary, null, h(GetnoteWorkbench, props))
const inner = mainSafe({ t: (k) => k }).props.children
const Comp = inner.type
const props = inner.props

// 一棵真实的树（含书/讲），用来真正走到 renderStructure 的讲行分支。
const TREE = {
  dir: 'C:/x', total: 3, untopiced: 0, no_source: 0,
  knowledge_bases: [
    {
      name: '我的库', id: 'kb1', count: 3, kind: 'kb', scope: 'DEFAULT', book_author: '',
      courses: [{
        name: '课程A', count: 3, books: [
          { name: '书1', count: 3, lectures: [{ name: '讲1', count: 2 }, { name: '讲2', count: 1 }] },
          { name: '', count: 0, flat: true, lectures: [{ name: '散篇', count: 0 }] },
        ],
      }],
    },
    { name: '(未归知识库)', id: '', count: 0, kind: 'untopiced', courses: [] },
  ],
  own_kb_count: 1, shelf_count: 0, untupiced_count: 1, unknown_count: 0,
}

// useState 槽位下标（顺序 = client.js 里的书写顺序，改代码后这里可能要跟着调）
const SLOT = {
  view: 0, sum: 1, inv: 2, plan: 3, autoPlan: 13, pkm: 14, srch: 15, pub: 16,
  openKb: 5, openCourse: 6, openBook: 7,
  lecOpen: 42, lecNotes: 43, aiPick: 54,
}

function seed() {
  state.length = 0
  cursor = 0
  state[SLOT.view] = 'structure'
  state[SLOT.sum] = { phase: 'ready', data: { total: 3, noTopic: 0, noTag: 1, byType: {}, courses: [] } }
  state[SLOT.inv] = { phase: 'ready', data: TREE }
  state[SLOT.plan] = { data: null, phase: 'idle' }
  state[SLOT.autoPlan] = { phase: 'idle' }
  state[SLOT.pkm] = { phase: 'idle', brief: null, ids: null, personas: null }
  state[SLOT.srch] = { q: '', kb: '', owner: '', phase: 'idle', hits: [], count: 0, error: null, note: '' }
  state[SLOT.pub] = { phase: 'idle', dir: '', msg: '', error: null }
}

let pass = 0
let fail = 0
function run(label) {
  try {
    const tree = Comp(props)
    const s = JSON.stringify(tree, (k, val) => (typeof val === 'function' ? 'fn' : val))
    pass++
    console.log(`  ok   ${label}  ${s.length} bytes`)
  } catch (e) {
    fail++
    console.log(`  FAIL ${label}  ${String((e && e.message) || e)}`)
  }
}

console.log('Mgetbrain 渲染冒烟\n')

// 1) 六个页签 × 三种计划态
for (const v of ['structure', 'auto', 'apply', 'ai', 'overview', 'log']) {
  for (const ps of ['empty', 'data', 'autoSummary']) {
    seed()
    state[SLOT.view] = v
    state[SLOT.plan] = ps === 'empty' ? { data: null, phase: 'idle' }
      : ps === 'data'
        ? {
            data: { actions: [{ op: 'kb_batch_add', args: { topic_id: 't1', note_ids: ['1', '2'] } }] },
            planPath: '/tmp/plan.json', phase: 'ready', source: 'manual',
          }
        : {
            data: null, phase: 'ready', source: 'auto', planPath: '/tmp/plan.json',
            summary: { groups: 3, notes_to_move: 10, notes_untouched: 4, actions: 5 }, actions: 5,
          }
    state[SLOT.autoPlan] = ps === 'autoSummary'
      ? {
          phase: 'ready',
          data: {
            planPath: '/tmp/plan.json', actions: 5,
            summary: { groups: 3, notes_to_move: 10, notes_untouched: 4, actions: 5 },
            groups: [{ name: 'g', count: 10, courses: {} }],
          },
        }
      : { phase: 'idle' }
    run(`view=${v} plan=${ps}`)
  }
}

// 2) 分类调整：展开讲、且讲内笔记已就绪（走「复制 ID」分支）
seed()
state[SLOT.lecOpen] = new Set(['kb\u0000课程A\u0000书1\u0000讲1'])
state[SLOT.lecNotes] = {
  'kb\u0000课程A\u0000书1\u0000讲1': {
    phase: 'ready', notes: [{ note_id: '1234567890123456789', title: '一条笔记', type: 'ref' }],
  },
}
state[SLOT.openKb] = new Set(['我的库'])
state[SLOT.openCourse] = new Set(['我的库\u0000课程A'])
state[SLOT.openBook] = new Set(['我的库\u0000课程A\u0000书1'])
run('structure + 讲展开 + 笔记列表')

// 3) 分类调整：讲展开但接口失败
seed()
state[SLOT.lecOpen] = new Set(['kb\u0000课程A\u0000书1\u0000讲1'])
state[SLOT.lecNotes] = { 'kb\u0000课程A\u0000书1\u0000讲1': { phase: 'error', error: 'stub' } }
run('structure + 讲展开失败')

// 4) 分类调整：加载中 / 错误 / 空树
seed(); state[SLOT.inv] = { phase: 'loading' }; run('structure loading')
seed(); state[SLOT.inv] = { phase: 'error', error: 'x' }; run('structure error')
seed(); state[SLOT.inv] = { phase: 'ready', data: { knowledge_bases: [], dir: 'C:/x' } }
run('structure empty')

// 5) AI 页：带入结果 / 带入失败
seed(); state[SLOT.view] = 'ai'
state[SLOT.aiPick] = { phase: 'ready', notes: [{ note_id: '1', title: 'a' }] }
run('ai + picker ready')
seed(); state[SLOT.view] = 'ai'
state[SLOT.aiPick] = { phase: 'error', error: 'nope' }
run('ai + picker error')

console.log(`\n${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
