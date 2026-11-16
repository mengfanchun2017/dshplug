#!/usr/bin/env node
/**
 * 路由冒烟测试 —— 专治「node --check 通过，但运行时 ReferenceError」。
 *
 * 为什么需要它：
 *   `node --check` 只验语法、不验作用域。常量若被误粘进函数体内，
 *   语法检查照样通过、模块 import 也照样成功（只有函数被调用才抛），
 *   直到浏览器请求路由才暴露成 HTTP 500。
 *   dsh-gitok v0.3.4 的 DOCS_WSL 就是这么漏的，潜伏三个版本才被发现。
 *
 * 它做什么：
 *   用打桩 ctx 真调一次 apply()，再真调 status 路由的 handler，
 *   不等 DSH 重启就能看到真实结果。
 *
 * 用法：
 *   $node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
 *   & $node C:\dsh\dshplug\dsh-gitok\tools\smoke-route.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败（含 FAIL 行）。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// tools/ 的上一级 = 插件根
const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(pluginRoot, 'lib', 'index.js')

const failures = []
const noop = () => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop }

// 收集 apply() 期间注册的路由
const routes = new Map()
const webServer = {
  register: (opts) => {
    if (opts && opts.path) routes.set(opts.path, opts)
    return () => {}
  },
}

/**
 * 打桩 ctx。要点：
 *  - inject(names, fn) 直接以自身调用 fn —— 插件用 ctx.inject(['webServer'], ...) 取 webCtx
 *  - effect(fn) 立即执行一次 —— 路由注册包在 webCtx.effect 里
 *  - 其余未知属性一律返回「能继续链式调用」的空函数，避免桩本身干扰被测代码
 */
function makeCtx() {
  const base = {
    inject: (names, fn) => fn(base),
    effect: (fn) => {
      if (typeof fn === 'function') fn()
      return noop
    },
    on: noop,
    emit: noop,
    set: noop,
    get: () => undefined,
    webServer,
    logger,
    tools: { register: () => noop },
  }
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key]
      // 未知服务：直接抛。
      // 【坑】旧写法返回可调用空壳，于是「ctx.inject 拼错服务名」「宿主把 webServer
      // 改名」这类错误全部静默通过 —— 假绿比没有测试更危险（见 ADR-013）。
      // 真需要新服务时把键加到 base 里，强制维护这个桩。
      throw new Error(`smoke: ctx.${String(key)} 未在白名单内 —— 桩与真实 ctx 不一致`) 
    },
  })
}

const line = (k, v) => console.log(`${k.padEnd(10)}= ${v}`)

/**
 * 写路由只验「注册上了」是不够的 —— 守卫、POST-only、token 黑名单、
 * requiresConfirm 被误删都不会被发现。这里不发真请求、不碰 GCM，
 * 只打到校验层，确认四道门还在。
 */
async function checkWriteRoutes(routes) {
  const WRITES = ['login', 'revoke', 'rotate', 'bootstrap']
  const call = async (path, req) => {
    const route = routes.get(`/plugins/gitok/${path}`)
    if (!route) return { missing: true }
    let code = null
    let payload = null
    // 超时兜底：若守卫/校验被误删，请求会真的走到 run（弹 OAuth / erase 凭据），
    // 测试就挂死了。超时必须报 FAIL，不能将死。
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ code: 'TIMEOUT' }), 4000)
    })
    const res = {
      setHeader: noop,
      writeHead(c) { code = c },
      end(b) { payload = b },
    }
    const outcome = await Promise.race([
      (async () => {
        try {
          await route.handler(req, res)
        } catch (err) {
          return { threw: err.message }
        }
        let json = null
        try { json = JSON.parse(payload) } catch { /* 非 JSON */ }
        return { code, json }
      })(),
      timeout,
    ])
    clearTimeout(timer)
    if (outcome.code === 'TIMEOUT') {
      return { code: 'TIMEOUT', hint: '请求未被守卫/校验拦住，已走进真实 run —— 检查 guard 与字段黑名单' }
    }
    return outcome
  }

  const bodyReq = (path, obj, over = {}) => {
    const chunks = [Buffer.from(JSON.stringify(obj))]
    return {
      url: `/plugins/gitok/${path}`,
      method: 'POST',
      headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', ...(over.headers || {}) },
      socket: { remoteAddress: over.remote ?? '127.0.0.1' },
      on(ev, cb) {
        if (ev === 'data') for (const c of chunks) cb(c)
        if (ev === 'end') cb()
      },
    }
  }

  for (const p of WRITES) {
    // 只测拒绝路径。**绝不要**用合法 loopback 请求去打 —— 那会真的执行 run：
    // login 会弹浏览器做 OAuth、revoke 会 erase 凭据、rotate 会轮换。
    // （写这个测试时真踩到了：合法请求让 smoke 挂住 120s 以上。）
    const route = routes.get(`/plugins/gitok/${p}`)
    if (!route) { failures.push(`缺写路由 /plugins/gitok/${p}`); continue }

    // ① 非 loopback 必须拒绝
    const alien = await call(p, bodyReq(p, {}, { remote: '10.0.0.9' }))
    if (alien.code !== 403) failures.push(`/plugins/gitok/${p} 未拦非 loopback（期望 403，实际 ${alien.code}）`)

    // ② 伪造 Host（DNS rebinding）必须拒绝
    const rebind = await call(p, bodyReq(p, {}, { headers: { host: 'attacker.example' } }))
    if (rebind.code !== 403) failures.push(`/plugins/gitok/${p} 未拦伪造 Host（期望 403，实际 ${rebind.code}）`)

    // ③ 跨站 Origin 必须拒绝
    const xorigin = await call(p, bodyReq(p, {}, { headers: { origin: 'https://evil.example' } }))
    if (xorigin.code !== 403) failures.push(`/plugins/gitok/${p} 未拦跨站 Origin（期望 403，实际 ${xorigin.code}）`)
  }

  // ② 请求体带 token 必须拒绝（ADR-002：插件永不接收凭据）
  const tok = await call('login', bodyReq('login', { token: 'ghp_should_be_rejected' }))
  if (tok.code !== 400) failures.push(`/plugins/gitok/login 未拒收 token 字段（期望 400，实际 ${tok.code}）`)

  // ④ 破坏性路由必须声明 requiresConfirm，且未带 confirm 时回 400。
  // 【注】这条是事故补丁：rotate 当初就漏了 requiresConfirm，
  // 一个合法 POST 直接把真实凭据 erase 了。
  for (const p of ['revoke', 'rotate']) {
    const route = routes.get(`/plugins/gitok/${p}`)
    if (!route) continue
    if (route.requiresConfirm !== true) {
      failures.push(`/plugins/gitok/${p} 未声明 requiresConfirm（破坏性操作不可无确认）`)
      continue
    }
    const noConfirm = await call(p, bodyReq(p, {}))
    if (noConfirm.code !== 400) {
      failures.push(`/plugins/gitok/${p} 未带 confirm 却未拒（期望 400，实际 ${noConfirm.code}）`)
    }
  }

  // ③ revoke 不带 confirm 必须拒绝（不可逆操作）
  const noconf = await call('revoke', bodyReq('revoke', { host: 'github.com' }))
  if (noconf.code !== 400) failures.push(`/plugins/gitok/revoke 未要求 confirm（期望 400，实际 ${noconf.code}）`)
}

async function main() {
  if (!existsSync(entry)) {
    console.log(`FAIL: 找不到 ${entry}`)
    process.exit(1)
  }

  let mod
  try {
    mod = await import(pathToFileURL(entry).href)
  } catch (err) {
    console.log(`FAIL: import 失败 —— ${err.constructor.name}: ${err.message}`)
    process.exit(1)
  }

  // Config 必须存在。
  // 【坑】旧写法是 `if (typeof mod.Config === 'function')`，而 undefined 不是 function，
  // 于是 schemastery 解析不到时整句被跳过、连 WARN 都不打，测试照样打印「全部通过」
  // 并 exit 0。而那种情况下 schema 校验、默认值、autoCheckMinutes 的 [0,10080]
  // 边界**全部失效**。实测：清空 DSH_HOME 后在 C:\Windows 下跑，确实假绿。
  if (typeof mod.Config !== 'function') {
    console.log('FAIL: mod.Config 未导出（schemastery 未解析到）—— 配置校验与边界全部失效')
    process.exit(1)
  }
  let config
  try {
    config = new mod.Config({})
  } catch (err) {
    console.log(`FAIL: Config 实例化失败 —— ${err.message}`)
    process.exit(1)
  }

  try {
    await mod.apply(makeCtx(), config)
  } catch (err) {
    console.log(`FAIL: apply 抛错 —— ${err.constructor.name}: ${err.message}`)
    process.exit(1)
  }

  const names = [...routes.keys()]
  line('routes', names.join(' ') || '(none)')
  if (!names.length) {
    console.log('FAIL: 没有注册任何路由')
    process.exit(1)
  }

  const statusRoute = routes.get('/plugins/gitok/status')
  if (!statusRoute) {
    console.log('FAIL: 缺 /plugins/gitok/status 路由')
    process.exit(1)
  }

  // 真调 handler
  let payload = null
  let httpCode = null
  const res = {
    setHeader: noop,
    writeHead(code) {
      httpCode = code
    },
    end(body) {
      payload = body
    },
  }
  const req = { url: '/plugins/gitok/status', method: 'GET', headers: {}, on: noop }

  try {
    await statusRoute.handler(req, res)
  } catch (err) {
    // 正常情况下 handler 内部已 try/catch 并转成 500 响应；
    // 能抛到这里说明连错误处理都没兜住
    console.log(`FAIL: handler 抛出未捕获异常 —— ${err.constructor.name}: ${err.message}`)
    process.exit(1)
  }

  line('http', httpCode)
  if (httpCode !== 200) {
    console.log(`FAIL: 期望 200，实际 ${httpCode}`)
    try {
      const o = JSON.parse(payload)
      if (o && o.error) console.log(`      服务端错误: ${o.error}`)
    } catch { /* body 不是 JSON */ }
    process.exit(1)
  }

  let body
  try {
    body = JSON.parse(payload)
  } catch (err) {
    console.log(`FAIL: 响应不是合法 JSON —— ${err.message}`)
    process.exit(1)
  }

  line('ok', body.ok)

  // 断言 1：docsPath 必须真实存在（专抓 here 语义算错）
  line('docsPath', body.docsPath || '(undefined)')
  const docsOk = Boolean(body.docsPath) && existsSync(body.docsPath)
  line('docsExists', docsOk)
  if (!docsOk) failures.push('docsPath 指向的文件不存在（检查 here 是否指向插件根而非 lib）')

  // 断言 2：六项检查齐全（专抓路由体内 ReferenceError / 字段缺失）
  const status = body.status || {}
  line('level', `${status.level} | summary = ${status.summary}`)
  const checks = status.checks || []
  const CHECKS = ['heartbeat', 'plaintext', 'sshkey', 'helper', 'creds', 'deps']
  const got = checks.map((c) => c.id || c.key)
  line('checks', checks.map((c) => `${c.id || c.key}:${c.level || c.state || '?'}`).join(' '))
  const missing = CHECKS.filter((id) => !got.includes(id))
  if (missing.length) failures.push(`缺少检查项: ${missing.join(', ')}`)

  if (!checks.length) failures.push('checks 为空 —— 路由可能中途抛错后降级返回')

  // 断言 3：结构性字段。
  // 这些旧版只打印不断言，于是「路由 200、六项齐全、但 level=undefined /
  // 所有 detail 为空」这种退化会报绿，而面板实际全空白。
  if (body.ok !== true) failures.push(`body.ok 不是 true（实际 ${body.ok}）`)
  if (!['ok', 'warn', 'error', 'unknown'].includes(status.level)) {
    failures.push(`status.level 非法: ${status.level}`)
  }
  if (!status.checkedAt || Number.isNaN(Date.parse(status.checkedAt))) {
    failures.push(`status.checkedAt 缺失或非法: ${status.checkedAt}`)
  }
  // 面板靠 label/detail 渲染，缺了界面就空白但路由仍然 200。
  for (const c of checks) {
    const id = c.id || c.key
    if (!c.label) failures.push(`检查项 ${id} 缺 label（面板会空白）`)
    if (!c.detail) failures.push(`检查项 ${id} 缺 detail（面板会空白）`)
  }
  if (!Array.isArray(status.wslEndpoints)) failures.push('status.wslEndpoints 不是数组')
  if (!Array.isArray(status.credTargets)) failures.push('status.credTargets 不是数组')

  // 断言 4：写路由的守卫。
  // 旧版只验「注册上了」，路由体一次都没跑 —— 守卫被误删也发现不了。
  await checkWriteRoutes(routes)

  if (failures.length) {
    console.log('\n失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }

  console.log('\n全部通过。')
}

main().catch((err) => {
  console.log(`FAIL: 未预期异常 —— ${err && err.stack || err}`)
  process.exit(1)
})
