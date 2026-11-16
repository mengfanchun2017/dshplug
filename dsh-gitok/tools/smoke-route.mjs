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
      // 未知服务：不抛错，返回可调用的空壳，让 apply 能跑完
      return () => noop
    },
  })
}

const line = (k, v) => console.log(`${k.padEnd(10)}= ${v}`)

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

  // Config 存在时按默认值实例化，否则给空对象
  let config = {}
  try {
    if (typeof mod.Config === 'function') config = new mod.Config({})
  } catch (err) {
    console.log(`WARN: Config 实例化失败（继续）—— ${err.message}`)
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
