// 工具级集成测试：用真实 ctx 契约执行 9 个工具。
//
// 分两段，避免「拿假 secret 去调真 API」：
//   A. 账户管理 / 匹配 / 校验 / 密钥不回显 —— 用独立临时 dataDir，不触网
//   B. 真实调用（status / call / schema）—— 用迁移来的**真实**凭据，单独 dataDir
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pluginDir = path.resolve(import.meta.dirname, '..')
const { AccountsStore, migrateLegacy } = await import('../lib/core.js')
const { apply } = await import('../lib/index.js')

let pass = 0
let fail = 0
function check(label, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${label}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${label}\n     ${e.message}`)
  }
}

function makeCtx() {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    tools: { register(def) { tools.set(def.name, def); return () => {} } },
    inject(_n, fn) { fn({ effect: ctx.effect, webServer: { register: () => () => {} } }) },
    set() {},
  }
  return { ctx, tools }
}

async function runTool(tools, name, args) {
  const t = tools.get(name)
  assert.ok(t, `工具不存在：${name}`)
  return String(await t.execute(args ?? {}))
}

// ===========================================================================
// A. 账户管理（不触网）
// ===========================================================================
const dataA = fs.mkdtempSync(path.join(os.tmpdir(), 'larkcli-tools-a-'))
const { ctx: ctxA, tools: toolsA } = makeCtx()
apply(ctxA, { dataDir: dataA, autoMigrate: false, statusTtlMs: 0 })
console.log('注册工具：', [...toolsA.keys()].join(', '))
assert.equal(toolsA.size, 13)

console.log('\n== A1. 初始态：无账户 ==')
const docEmpty = await runTool(toolsA, 'lark_doctor')
console.log(docEmpty.split('\n').map((l) => '   ' + l).join('\n'))
check('空数据目录时给出建账户的三步指引', () => {
  assert.ok(docEmpty.includes('还没有账户'))
  assert.ok(docEmpty.includes('lark_account_upsert'))
  assert.ok(docEmpty.includes('lark_account_set_secret'))
  assert.ok(docEmpty.includes('lark_login_start'))
})

console.log('\n== A2. lark_account_upsert 建两个账户 ==')
const up1 = await runTool(toolsA, 'lark_account_upsert', {
  id: 'work',
  label: '公司主账号',
  description: '研发群、周报文档、项目A 多维表格',
  tags: ['研发', '周报', '项目A'],
  appId: 'cli_aaaaaaaaaaaa',
})
console.log(up1.split('\n').map((l) => '   ' + l).join('\n'))
check('第一个账户自动成为默认', () => assert.ok(up1.includes('默认：是')))
const up2 = await runTool(toolsA, 'lark_account_upsert', {
  id: 'personal',
  label: '个人账号',
  description: '私人日历、邮件',
  tags: ['日历', '邮件'],
  appId: 'cli_bbbbbbbbbbbb',
})
check('第二个账户不是默认', () => assert.ok(up2.includes('默认：否')))

console.log('\n== A3. lark_account_search 本地加权匹配 ==')
const s1 = await runTool(toolsA, 'lark_account_search', { query: '查上周周报文档' })
console.log(s1.split('\n').map((l) => '   ' + l).join('\n'))
check('「周报」→ 建议 work', () => assert.ok(s1.includes('account="work"'), s1.slice(-160)))
const s2 = await runTool(toolsA, 'lark_account_search', { query: '私人邮件' })
check('「私人邮件」→ 建议 personal', () => assert.ok(s2.includes('account="personal"'), s2.slice(-160)))
const s3 = await runTool(toolsA, 'lark_account_search', { query: '量子引力波' })
check('无关查询不给假建议', () => assert.ok(s3.includes('没有明显匹配')))
const s4 = await runTool(toolsA, 'lark_account_search', { query: '项目A 多维表格' })
check('「项目A」→ work', () => assert.ok(s4.includes('account="work"')))

console.log('\n== A4. 参数校验 ==')
const badId = await runTool(toolsA, 'lark_account_upsert', { id: '../evil' })
check('非法 id 被拒', () => assert.ok(badId.includes('❌') && badId.includes('不合法')))
const badBrand = await runTool(toolsA, 'lark_account_upsert', { id: 'x', brand: 'wechat' })
check('非法 brand 被拒', () => assert.ok(badBrand.includes('不合法')))

console.log('\n== A5. secret 只写不回显 ==')
const secretVal = 'SUPER-SECRET-VALUE-1234567890'
const secOut = await runTool(toolsA, 'lark_account_set_secret', { account: 'work', appSecret: secretVal })
console.log(secOut.split('\n').map((l) => '   ' + l).join('\n'))
check('输出不含密钥原文', () => assert.ok(!secOut.includes(secretVal)))
check('密钥落盘到 work 目录', () => {
  const p = path.join(dataA, 'accounts', 'work', 'appsecret.txt')
  assert.ok(fs.existsSync(p))
  assert.equal(fs.readFileSync(p, 'utf8'), secretVal)
})

console.log('\n== A6. 多账户 config.json 隔离 ==')
await runTool(toolsA, 'lark_account_set_secret', { account: 'personal', appSecret: 'second-secret-value-x' })
check('两账户 config 各指各的、且为正斜杠绝对路径', () => {
  const w = JSON.parse(fs.readFileSync(path.join(dataA, 'accounts', 'work', 'config.json'), 'utf8'))
  const p = JSON.parse(fs.readFileSync(path.join(dataA, 'accounts', 'personal', 'config.json'), 'utf8'))
  assert.ok(w.apps[0].appSecret.id.includes('/work/'))
  assert.ok(p.apps[0].appSecret.id.includes('/personal/'))
  assert.ok(!w.apps[0].appSecret.id.includes('\\'))
  assert.ok(w.apps[0].appSecret.id.startsWith('C:/') || w.apps[0].appSecret.id.startsWith('/'))
  assert.equal(w.apps[0].appId, 'cli_aaaaaaaaaaaa')
  assert.equal(p.apps[0].appId, 'cli_bbbbbbbbbbbb')
})

console.log('\n== A7. 不存在的账户 ==')
const ghost = await runTool(toolsA, 'lark_status', { account: 'ghost' })
check('报「不存在」而不是崩栈', () => assert.ok(ghost.includes('❌') && ghost.includes('ghost')))

// ===========================================================================
// B. 真实调用（迁移真实凭据，触网）
// ===========================================================================
console.log('\n== B. 真实 CLI 调用 ==')
const dataB = fs.mkdtempSync(path.join(os.tmpdir(), 'larkcli-tools-b-'))
const storeB = new AccountsStore(dataB)
const mig = migrateLegacy({ store: storeB, pluginDir, legacyId: 'default' })
console.log(`迁移真实凭据：${mig ? '✅ ' + mig.account.appId : '❌ 无（旧的 _native-config 不可用）'}`)

if (mig) {
  const { ctx: ctxB, tools: toolsB } = makeCtx()
  apply(ctxB, { dataDir: dataB, autoMigrate: false, statusTtlMs: 0 })

  const docReal = await runTool(toolsB, 'lark_doctor')
  console.log(docReal.split('\n').map((l) => '   ' + l).join('\n'))
  check('doctor 报告二进制 ✅ 与 bot 可用', () => {
    assert.ok(docReal.includes('✅'))
    assert.ok(docReal.includes('bot✅') || docReal.includes('bot ✅'))
  })

  const st = await runTool(toolsB, 'lark_status', {})
  console.log(st.split('\n').map((l) => '   ' + l).join('\n'))
  check('status 报 bot 可用且 brief 精简', () => {
    assert.ok(/bot\s+✅/.test(st) || st.includes('✅ ready'))
    assert.ok(!st.includes('"identities"'), 'brief 不该吐整个 JSON')
  })
  const stFull = await runTool(toolsB, 'lark_status', { detail: 'full' })
  check('detail=full 更详细', () => assert.ok(stFull.length > st.length))

  const call1 = await runTool(toolsB, 'lark_call', { args: ['im', '+chat-list', '--page-size', '2', '--as', 'bot'] })
  console.log(call1.split('\n').slice(0, 10).map((l) => '   ' + l).join('\n'))
  check('lark_call 拿到真实 chat 列表', () => {
    assert.ok(call1.includes('✅'))
    assert.ok(call1.includes('chat_id') || call1.includes('chats'))
  })

  const call2 = await runTool(toolsB, 'lark_call', { command: 'api GET /open-apis/bot/v3/info' })
  check('command 字符串形式可用，app_name = DSH Agent', () => assert.ok(call2.includes('DSH Agent')))

  const guarded = await runTool(toolsB, 'lark_call', { args: ['auth', 'login', '--recommend'] })
  check('拦截交互式 auth login，指向 lark_login_start', () => assert.ok(guarded.includes('lark_login_start')))

  const bad = await runTool(toolsB, 'lark_call', { args: ['nope-command-xyz'] })
  check('坏命令如实报错不崩', () => assert.ok(bad.includes('❌')))

  const idx = await runTool(toolsB, 'lark_schema', {})
  console.log(idx.split('\n').slice(0, 6).map((l) => '   ' + l).join('\n'))
  check('schema 索引报 256 方法且远小于 1.5MB', () => {
    assert.ok(idx.includes('256'))
    assert.ok(idx.length < 20000, `实际 ${idx.length}`)
  })
  check('索引含 im 域', () => assert.ok(/^im（/m.test(idx)))

  const one = await runTool(toolsB, 'lark_schema', { method: 'im.messages.delete' })
  check('单方法查询返回参数且 < 12KB', () => {
    assert.ok(one.includes('message_id'))
    assert.ok(one.length < 12000)
  })
  const miss = await runTool(toolsB, 'lark_schema', { method: 'im.nope.nothing' })
  check('不存在的方法给出索引提示', () => assert.ok(miss.includes('❌') && miss.includes('lark_schema')))

  // 登录：只验证「发起」能拿到链接、且 device_code 不外泄
  const login = await runTool(toolsB, 'lark_login_start', {})
  console.log(login.split('\n').map((l) => '   ' + l).join('\n'))
  check('login_start 返回 verification_url', () => assert.ok(/https:\/\//.test(login)))
  check('login_start 不回显 device_code 本体', () => {
    assert.ok(!/device_code["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{40,}/i.test(login))
    assert.ok(login.includes('不回显') || login.includes('已保存'))
  })
  check('pending 文件落盘供 finish 使用', () => {
    const p = path.join(dataB, 'accounts', 'default', 'login-pending.json')
    assert.ok(fs.existsSync(p))
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    assert.ok(j.deviceCode && j.deviceCode.length > 40)
    assert.ok(j.verificationUrl.includes('http'))
  })
}

fs.rmSync(dataA, { recursive: true, force: true })
fs.rmSync(dataB, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
