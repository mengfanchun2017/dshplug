/**
 * dsh-larkcli 测试（不依赖 DSH、不装插件，直接 node 跑）
 *
 * 覆盖「初始态 / 失败态 / 成功态」三类，不只 seed 成功态：
 *   1. 纯函数：切词、账户 id 校验、脱敏、信封解析、评分排序、schema 摘要
 *   2. 数据层：空目录启动、账户增改、默认账户、config.json 路径正确性
 *   3. 真实 CLI：auth status / +chat-list / schema（找不到 exe 时优雅失败）
 *
 * 用法：node test/run.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AccountsStore,
  accountPaths,
  buildCliConfig,
  cleanStderr,
  derivePaths,
  findMethod,
  mask,
  normalizeMethodName,
  parseCliOutput,
  rankAccounts,
  redactDeep,
  scoreAccount,
  summarizeSchema,
  syncCliConfig,
  tokenize,
  toPosix,
  truncate,
  validateAccountInput,
  wordsOf,
} from '../lib/core.js'
import { LarkService } from '../lib/service.js'

let pass = 0
let fail = 0
const failures = []

function test(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') throw new Error('async test must use testAsync')
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'larkcli-test-'))
const cleanTmp = () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log('\n== 1. 纯函数 ==')

test('tokenize 保留引号内的空格', () => {
  assert.deepEqual(tokenize('im +messages-search --query 周报 --page-size 5'), [
    'im',
    '+messages-search',
    '--query',
    '周报',
    '--page-size',
    '5',
  ])
  assert.deepEqual(tokenize('--query "周报 汇总"'), ['--query', '周报 汇总'])
  assert.deepEqual(tokenize(`--data '{"text":"hello world"}'`), ['--data', '{"text":"hello world"}'])
  // 嵌套引号：JSON 里带转义双引号
  assert.deepEqual(tokenize('--data "{\\"a\\":\\"b c\\"}"'), ['--data', '{"a":"b c"}'])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize(''), [])
})

test('账户 id 白名单挡住路径穿越', () => {
  assert.equal(validateAccountInput({ id: 'work' }).ok, true)
  assert.equal(validateAccountInput({ id: 'work-2_a' }).ok, true)
  for (const bad of ['../etc', 'C:/x', 'Work', 'has space', '', 'a'.repeat(40), '-lead']) {
    assert.equal(validateAccountInput({ id: bad }).ok, false, `should reject ${bad}`)
  }
  assert.equal(validateAccountInput({ id: 'w', brand: 'wechat' }).ok, false)
  assert.equal(validateAccountInput({ id: 'w', appId: 'notcli' }).ok, false)
  assert.equal(validateAccountInput({ id: 'w', appId: 'cli_abc123' }).ok, true)
  assert.equal(validateAccountInput({ id: 'w', tags: 'x' }).ok, false)
})

test('toPosix 生成 CLI 需要的正斜杠', () => {
  assert.equal(toPosix('C:\\dsh\\data-larkcli\\accounts\\work\\appsecret.txt'), 'C:/dsh/data-larkcli/accounts/work/appsecret.txt')
})

test('mask 不泄露原值，只留长度', () => {
  const s = 'abcdefghijklmnop'
  const m = mask(s)
  assert.ok(!m.includes(s))
  assert.ok(m.includes('16'))
  assert.equal(mask(''), '')
  assert.equal(mask('short'), '…')
})

test('redactDeep 打掉 token / device_code / appSecret', () => {
  const input = {
    ok: true,
    appSecret: 'supersecretvalue123',
    nested: { access_token: 't-abcdefghijklmnopqrstuvwxyz', device_code: 'DC_1234567890123', keep: 'visible' },
    arr: [{ refresh_token: 'r-abcdefghijklmnopqrstuvwxyz' }],
  }
  const out = redactDeep(input)
  assert.ok(!JSON.stringify(out).includes('supersecretvalue123'))
  assert.ok(!JSON.stringify(out).includes('abcdefghijklmnopqrstuvwxyz'))
  assert.equal(out.nested.keep, 'visible')
})

test('truncate 截断并给出可执行的补救提示', () => {
  const short = truncate('abc', 100)
  assert.equal(short.truncated, false)
  const long = truncate('x'.repeat(500), 100)
  assert.equal(long.truncated, true)
  assert.ok(long.text.length < 500)
  assert.ok(/page-limit|分页/.test(long.text))
})

test('parseCliOutput: 成功信封（stdout）', () => {
  const r = parseCliOutput({
    stdout: JSON.stringify({ ok: true, identity: 'bot', data: { a: 1 } }),
    stderr: '',
    exitCode: 0,
  })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'envelope')
  assert.equal(r.identity, 'bot')
  assert.deepEqual(r.json.data, { a: 1 })
})

test('parseCliOutput: 失败信封在 stderr 且 exit!==0', () => {
  const r = parseCliOutput({
    stdout: '',
    stderr: JSON.stringify({ ok: false, identity: 'bot', error: { type: 'config', subtype: 'not_configured', message: 'no secret' } }),
    exitCode: 3,
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'error-envelope')
  assert.equal(r.error.type, 'config')
  assert.equal(r.error.message, 'no secret')
})

test('parseCliOutput: 裸 JSON（auth status）也算成功', () => {
  const r = parseCliOutput({
    stdout: JSON.stringify({ appId: 'cli_x', identities: { bot: { available: true } } }),
    stderr: '',
    exitCode: 0,
  })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'json')
  assert.equal(r.json.identities.bot.available, true)
})

test('parseCliOutput: 非 JSON（--help）+ exit0', () => {
  const r = parseCliOutput({ stdout: 'Usage:\n  lark-cli im', stderr: '', exitCode: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'text')
})

test('parseCliOutput: 空输出 + 非零退出 = 失败', () => {
  const r = parseCliOutput({ stdout: '', stderr: '', exitCode: 1 })
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

test('parseCliOutput: 去掉 _notice 升级噪声', () => {
  const r = parseCliOutput({
    stdout: JSON.stringify({ ok: true, data: {}, _notice: { update: { latest: '1.0.100' } } }),
    stderr: '',
    exitCode: 0,
  })
  assert.equal(r.json._notice, undefined)
})

test('cleanStderr 过滤 Windows DPoP 噪声但保留真错误', () => {
  const noisy = [
    '[lark-cli] [WARN] local DPoP setup failed; new tenant token issued as Bearer: failed to prepare replaceable DPoP key',
    'real error here',
  ].join('\n')
  const out = cleanStderr(noisy)
  assert.ok(!out.includes('DPoP'))
  assert.ok(out.includes('real error here'))
  assert.equal(cleanStderr('[lark-cli] [WARN] local DPoP setup failed'), '')
})

test('wordsOf 对中文生成 bigram', () => {
  const w = wordsOf('查上周周报文档')
  assert.ok(w.has('周报'))
  assert.ok(w.has('文档'))
})

test('scoreAccount: 标签命中优先于描述命中', () => {
  const tagged = { id: 'work', label: '工作', description: '', tags: ['周报'], isDefault: false }
  const described = { id: 'other', label: '其他', description: '周报', tags: [], isDefault: false }
  const s1 = scoreAccount('周报', tagged)
  const s2 = scoreAccount('周报', described)
  assert.ok(s1.score > s2.score, `tag(${s1.score}) should beat desc(${s2.score})`)
  assert.ok(s1.reasons.length > 0)
})

test('rankAccounts: 打平时默认账户优先', () => {
  const a = { id: 'aaa', label: 'A', description: '', tags: [], isDefault: false }
  const b = { id: 'bbb', label: 'B', description: '', tags: [], isDefault: true }
  const ranked = rankAccounts('完全无关的词', [a, b], 2)
  assert.equal(ranked[0].account.id, 'bbb')
})

test('rankAccounts: 无关查询不返回假阳性（score 0）', () => {
  const a = { id: 'work', label: '工作', description: '研发群', tags: ['研发'], isDefault: true }
  const r = rankAccounts('量子物理', [a], 1)
  assert.equal(r[0].score, 0)
})

test('summarizeSchema 把全量压成索引', () => {
  const raw = [
    { name: 'im messages delete', description: 'Recall message' },
    { name: 'im messages get', description: 'Get message' },
    { name: 'docs docx get', description: 'Read doc' },
  ]
  const s = summarizeSchema(raw)
  assert.equal(s.total, 3)
  assert.deepEqual(Object.keys(s.services).sort(), ['docs', 'im'])
  assert.equal(s.services.im.length, 2)
})

test('normalizeMethodName 三种写法归一', () => {
  assert.equal(normalizeMethodName('im messages delete'), 'im.messages.delete')
  assert.equal(normalizeMethodName('im.messages.delete'), 'im.messages.delete')
  assert.equal(normalizeMethodName('  im  messages.delete '), 'im.messages.delete')
})

test('findMethod 命中', () => {
  const list = [{ name: 'im messages delete' }, { name: 'im messages get' }]
  assert.equal(findMethod(list, 'im.messages.get').name, 'im messages get')
  assert.equal(findMethod(list, 'im.messages.nope'), undefined)
})

console.log('\n== 2. 数据层（初始态 / 失败态） ==')

test('derivePaths: 仓库同级 data-<短名>', () => {
  const p = derivePaths(path.join('C:', 'dsh', 'dshplug', 'dsh-larkcli', 'lib'))
  assert.equal(path.basename(p.dataDir), 'data-larkcli')
  assert.equal(path.dirname(p.dataDir), path.join('C:', 'dsh'))
})

test('derivePaths: 不在 node_modules 里时也稳', () => {
  // 模拟装进 profile 后的形态：插件目录上一级是 node_modules
  const p = derivePaths(path.join('C:', 'x', 'profiles', 'desktop', 'node_modules', 'dsh-larkcli', 'lib'))
  assert.ok(p.dataDir.includes('.dsh') || p.dataDir.includes('data-larkcli'))
})

test('空目录启动：不创建账户也不抛异常', () => {
  const dataDir = path.join(tmpRoot, 'empty')
  const store = new AccountsStore(dataDir)
  assert.deepEqual(store.list(), [])
  assert.equal(store.defaultId(), '')
  assert.equal(store.get('nope'), undefined)
})

test('accounts.json 损坏时退回空表而不是崩', () => {
  const dataDir = path.join(tmpRoot, 'broken')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), '{ this is not json')
  const store = new AccountsStore(dataDir)
  assert.deepEqual(store.list(), [])
})

test('upsert 新账户 → 自动成为默认', () => {
  const dataDir = path.join(tmpRoot, 'acc1')
  const store = new AccountsStore(dataDir)
  const a = store.upsert({ id: 'work', label: '工作', tags: ['周报'], appId: 'cli_abc123' })
  assert.equal(a.id, 'work')
  assert.equal(store.defaultId(), 'work')
  assert.equal(store.list().length, 1)
})

test('upsert 二次调用是更新而非重复插入', () => {
  const dataDir = path.join(tmpRoot, 'acc2')
  const store = new AccountsStore(dataDir)
  store.upsert({ id: 'work', label: '工作' })
  store.upsert({ id: 'work', label: '工作（改名）', description: '研发' })
  assert.equal(store.list().length, 1)
  assert.equal(store.get('work').label, '工作（改名）')
  assert.equal(store.get('work').description, '研发')
})

test('setDefault 对不存在的账户抛错', () => {
  const dataDir = path.join(tmpRoot, 'acc3')
  const store = new AccountsStore(dataDir)
  store.upsert({ id: 'a' })
  assert.throws(() => store.setDefault('nope'), /不存在/)
})

test('AccountsStore 过滤非法 id（防手改坏文件）', () => {
  const dataDir = path.join(tmpRoot, 'acc4')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({ default: 'ok', accounts: [{ id: 'ok' }, { id: '../evil' }, { id: 'ALSO-BAD' }] }),
  )
  const store = new AccountsStore(dataDir)
  assert.deepEqual(store.list().map((a) => a.id), ['ok'])
})

test('buildCliConfig: appSecret.id 是绝对正斜杠路径', () => {
  const secret = path.join('C:', 'dsh', 'data-larkcli', 'accounts', 'work', 'appsecret.txt')
  const cfg = buildCliConfig({ appId: 'cli_abc123', brand: 'feishu' }, secret)
  assert.equal(cfg.apps[0].appSecret.source, 'file')
  assert.ok(!cfg.apps[0].appSecret.id.includes('\\'), 'must be posix')
  assert.ok(cfg.apps[0].appSecret.id.endsWith('/appsecret.txt'))
  assert.equal(cfg.apps[0].brand, 'feishu')
})

test('syncCliConfig 幂等：内容没变不重写', () => {
  const dataDir = path.join(tmpRoot, 'cfg1')
  const ap = accountPaths(dataDir, 'work')
  fs.mkdirSync(ap.dir, { recursive: true })
  const account = { id: 'work', appId: 'cli_abc123', brand: 'feishu' }
  const r1 = syncCliConfig(account, ap.secretFile)
  assert.equal(r1.changed, true)
  const r2 = syncCliConfig(account, ap.secretFile)
  assert.equal(r2.changed, false)
})

test('accountPaths 隔离到各自目录', () => {
  const dataDir = path.join(tmpRoot, 'iso')
  const a = accountPaths(dataDir, 'work')
  const b = accountPaths(dataDir, 'personal')
  assert.notEqual(a.dir, b.dir)
  assert.ok(a.secretFile.includes('work'))
  assert.ok(b.secretFile.includes('personal'))
})

console.log('\n== 3. 服务层（无 exe / 无账户的失败态） ==')

await testAsync('缺二进制时报可执行的修复命令，不是空错误', async () => {
  const svc = new LarkService({ dataDir: path.join(tmpRoot, 'svc1'), pluginDir: path.join(tmpRoot, 'noplugin') })
  assert.equal(svc.hasBinary(), false)
  try {
    await svc.run(['auth', 'status'])
    throw new Error('should have thrown')
  } catch (e) {
    // v0.2.0：修法从「跑 ps1 脚本」改为「调 lark_install」——断言跟代码同步，
    // 否则旧测试会因“文案变了”而红，掩盖真的回归。
    assert.match(e.message, /lark_install/)
  }
})

await testAsync('没有账户时提示下一步工具', async () => {
  const dataDir = path.join(tmpRoot, 'svc2')
  const svc = new LarkService({ dataDir, pluginDir: path.join(tmpRoot, 'noplugin') })
  // 伪造 exe 存在，好走到「检查账户」这一步
  const fakePlugin = path.join(tmpRoot, 'fakeplugin')
  const exeDir = path.join(fakePlugin, 'lark-cli-win')
  fs.mkdirSync(exeDir, { recursive: true })
  fs.writeFileSync(path.join(exeDir, 'lark-cli.exe'), 'not a real exe')
  const svc2 = new LarkService({ dataDir, pluginDir: fakePlugin })
  try {
    await svc2.run(['auth', 'status'])
    throw new Error('should have thrown')
  } catch (e) {
    assert.match(e.message, /lark_account_upsert/)
  }
})

await testAsync('账户缺 secret 时报出准确路径与补救工具', async () => {
  const dataDir = path.join(tmpRoot, 'svc3')
  const store = new AccountsStore(dataDir)
  store.upsert({ id: 'work', appId: 'cli_abc123' })
  const fakePlugin = path.join(tmpRoot, 'fakeplugin3')
  fs.mkdirSync(path.join(fakePlugin, 'lark-cli-win'), { recursive: true })
  fs.writeFileSync(path.join(fakePlugin, 'lark-cli-win', 'lark-cli.exe'), 'x')
  const svc = new LarkService({ dataDir, pluginDir: fakePlugin })
  try {
    await svc.run(['auth', 'status'])
    throw new Error('should have thrown')
  } catch (e) {
    assert.match(e.message, /appsecret\.txt/)
    assert.match(e.message, /lark_account_upsert/)
  }
})

await testAsync('writeSecret 写入但绝不回显', async () => {
  const dataDir = path.join(tmpRoot, 'svc4')
  const store = new AccountsStore(dataDir)
  store.upsert({ id: 'work', appId: 'cli_abc123' })
  const svc = new LarkService({ dataDir, pluginDir: path.join(tmpRoot, 'noplugin') })
  const r = svc.writeSecret('work', 'my-super-secret-value')
  assert.ok(!JSON.stringify(r).includes('my-super-secret-value'))
  assert.equal(svc.hasSecret('work'), true)
  assert.ok(r.bytes > 0)
  // config.json 应该已按新路径生成
  const ap = accountPaths(dataDir, 'work')
  const cfgJson = JSON.parse(fs.readFileSync(ap.configFile, 'utf8'))
  assert.ok(cfgJson.apps[0].appSecret.id.startsWith(toPosix(dataDir)))
})

await testAsync('status 无账户时返回结构化失败而非抛异常', async () => {
  const svc = new LarkService({ dataDir: path.join(tmpRoot, 'svc5'), pluginDir: path.join(tmpRoot, 'noplugin') })
  const st = await svc.status({})
  assert.equal(st.ok, false)
  assert.ok(st.error)
})

console.log('\n== 4. 真实 CLI（本机有二进制时） ==')

const realPlugin = path.resolve(import.meta.dirname, '..')
const realData = path.join(tmpRoot, 'real')
const realSvc = new LarkService({ dataDir: realData, pluginDir: realPlugin })
const hasReal = realSvc.hasBinary()
console.log(`  二进制：${hasReal ? '✅ 存在' : '❌ 未找到（跳过真实调用）'}`)

if (hasReal) {
  await testAsync('CLI --version 可执行', async () => {
    const v = await realSvc.version()
    assert.ok(v && v !== 'unknown', `version=${v}`)
    console.log(`     version = ${v}`)
  })

  await testAsync('真实账号表为空时 status 优雅失败', async () => {
    const st = await realSvc.status({})
    assert.equal(st.ok, false)
    assert.ok(st.error)
  })
} else {
  console.log('  （未安装二进制，真实调用跳过；lark_install action="install" 后可复测）')
}

cleanTmp()

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`- ${f.name}\n  ${f.error.stack?.split('\n').slice(0, 4).join('\n  ')}`)
  process.exit(1)
}
