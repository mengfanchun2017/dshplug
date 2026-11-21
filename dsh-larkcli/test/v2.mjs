/**
 * dsh-larkcli v0.2.0 新增模块的单元测试（不触网、不碰真实凭据）
 *
 * 覆盖：
 *   - scopes.js  权限清单：域→scope 抽取、只读过滤、差集、申请链接
 *   - resolver.js 链接解析：10 种 URL 形态 + 裸 token + 非法输入 + 重试判定
 *   - install.js  版本比较（semver 而非字符串）、资产名、checksum 缺失必须拒绝
 *
 * 用法：node test/v2.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DOMAIN_LABELS,
  PROFILES,
  SCOPE_PREFIX_LABELS,
  SUPPLEMENT,
  tokenTypesFromSchema,
  appConsoleUrl,
  consoleApplyUrl,
  diffScopes,
  groupForDisplay,
  isReadScope,
  scopesForDomains,
  scopesFromSchema,
} from '../lib/scopes.js'
import { KIND_LABELS, READ_COMMANDS, isRetryableError, orderAccounts, parseDocUrl } from '../lib/resolver.js'
import { assetName, checksumFor, compareVersions, parseVersion, probeVersion } from '../lib/install.js'

let pass = 0
let fail = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

async function checkAsync(name, fn) {
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

// ===========================================================================
console.log('\n== 1. scopes：域 → scope 抽取 ==')

const METHODS = [
  { name: 'drive files list', _meta: { scopes: ['drive:drive:readonly'], access_tokens: ['user', 'tenant'] } },
  { name: 'drive files delete', _meta: { scopes: ['drive:drive'], access_tokens: ['tenant'] } },
  { name: 'im messages create', _meta: { scopes: ['im:message:send_as_bot'], access_tokens: ['tenant'] } },
  { name: 'wiki nodes get', _meta: { scopes: ['wiki:wiki:readonly'], access_tokens: ['user'] } },
  { name: 'no meta method' },
]

check('按首个单词分域；无 scope 的方法只留空域桶', () => {
  const m = scopesFromSchema(METHODS)
  // `no meta method` 没有 _meta.scopes，但域确实存在 —— 留一个空对象比丢掉这个域更诚实，
  // 下游把它当「已知域但零 scope」处理，不会去猜「拼错了」。
  assert.deepEqual(Object.keys(m).sort(), ['drive', 'im', 'no', 'wiki'])
  assert.deepEqual(m.no, {})
})

check('空域桶不会凭空产生 scope', () => {
  const m = scopesFromSchema(METHODS)
  assert.equal(Object.keys(m.no).length, 0)
  assert.ok(Object.keys(m.drive).length > 0)
})

check('同一 scope 在多方法里合并令牌类型', () => {
  const m = scopesFromSchema(METHODS)
  assert.deepEqual([...m.drive['drive:drive:readonly']].sort(), ['tenant', 'user'])
})

check('无 _meta 的方法被跳过而不是抛错', () => {
  const m = scopesFromSchema([{ name: 'x y' }, null, {}, { name: '' }])
  assert.deepEqual(Object.keys(m), ['x'])
})

check('非数组输入返回空对象（不崩）', () => {
  assert.deepEqual(scopesFromSchema(null), {})
  assert.deepEqual(scopesFromSchema(undefined), {})
  assert.deepEqual(scopesFromSchema('nope'), {})
})

// ===========================================================================
console.log('\n== 2. scopes：只读过滤 ==')

check('readonly 判为读', () => {
  assert.equal(isReadScope('drive:drive:readonly'), true)
  assert.equal(isReadScope('sheets:spreadsheet:read'), true)
  assert.equal(isReadScope('wiki:node:retrieve'), true)
})

check('write / create / delete / update 判为写', () => {
  assert.equal(isReadScope('docx:document:write_only'), false)
  assert.equal(isReadScope('im:chat:create'), false)
  assert.equal(isReadScope('task:task:delete'), false)
  assert.equal(isReadScope('wiki:member:update'), false)
})

check('裸权限（drive:drive）保守算写', () => {
  assert.equal(isReadScope('drive:drive'), false)
  assert.equal(isReadScope('bitable:app'), false)
})

// ===========================================================================
console.log('\n== 3. scopes：按档位取清单 ==')

check('read 档位严格是只读子集', () => {
  const all = scopesForDomains({ domains: ['drive'], methods: METHODS })
  const ro = scopesForDomains({ domains: ['drive'], methods: METHODS, readOnly: true })
  assert.ok(ro.scopes.includes('drive:drive:readonly'), '应含只读 scope')
  assert.ok(!ro.scopes.includes('drive:drive'), '不应含裸写 scope')
  assert.ok(all.scopes.length > ro.scopes.length, '全量应比只读多')
})

check('all 展开为所有域（不含 all 自身）', () => {
  const r = scopesForDomains({ domains: ['all'], methods: METHODS })
  assert.ok(Object.keys(r.byDomain).length > 5)
  assert.ok(!Object.keys(r.byDomain).includes('all'))
})

check('未知域单独列出来而不是静默丢弃', () => {
  const r = scopesForDomains({ domains: ['im', 'not_a_domain'], methods: METHODS })
  assert.deepEqual(r.unknownDomains, ['not_a_domain'])
})

check('exclude 能剔掉指定 scope', () => {
  const r = scopesForDomains({ domains: ['drive'], methods: METHODS, exclude: ['drive:drive'] })
  assert.ok(!r.scopes.includes('drive:drive'))
})

check('SUPPLEMENT 补的域即使 schema 没有也能出 scope', () => {
  const r = scopesForDomains({ domains: ['docs'], methods: [] })
  assert.ok(r.scopes.includes('docx:document:readonly'), 'docs 域应补上 docx scope')
  assert.deepEqual(r.unknownDomains, [])
})

check('三个档位都能算出非空清单', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    const r = scopesForDomains({ domains: p.domains, methods: METHODS, readOnly: name === 'read' })
    assert.ok(r.scopes.length > 0, `${name} 档位应非空`)
  }
})

check('每个档位都有 label 与说明', () => {
  for (const p of Object.values(PROFILES)) {
    assert.ok(p.label && p.label.length > 2)
    assert.ok(Array.isArray(p.domains) && p.domains.length > 0)
  }
})

check('DOMAIN_LABELS 全部是中文（不能漏翻）', () => {
  for (const [k, v] of Object.entries(DOMAIN_LABELS)) {
    assert.ok(/[\u4e00-\u9fa5]/.test(v), `${k} 缺中文名`)
  }
})

check('SCOPE_PREFIX_LABELS 覆盖 schema 里真实出现的所有前缀', () => {
  // 这些前缀是从真实 156 条 scope 里数出来的；漏一个就会在面板上显示英文
  for (const p of ['approval','attendance','base','bitable','calendar','contact','docs','docx','drive','im','mail','mindnote','minutes','okr','profile','sheets','slides','space','task','vc','wiki']) {
    assert.ok(SCOPE_PREFIX_LABELS[p], `${p} 缺中文名`)
  }
})

check('分组标题对未知前缀不会输出英文前缀名', () => {
  const g = groupForDisplay({
    wanted: ['bitable:app:readonly'],
    appGranted: { 'bitable:app:readonly': { description: '查看多维表格', tokenTypes: ['tenant'] } },
    userGranted: [],
  })
  assert.equal(g.groups[0].label, '多维表格')
})

check('没有任何描述时分组标题退回域前缀（不报错）', () => {
  const g = groupForDisplay({ wanted: ['zzz:yyy'], appGranted: {}, userGranted: [] })
  assert.equal(g.groups[0].label, 'zzz')
})

// ===========================================================================
console.log('\n== 4. scopes：差集与链接 ==')

const GRANTED = {
  'docx:document:readonly': { description: '查看新版文档', level: 2, tokenTypes: ['tenant'] },
  'drive:drive:readonly': { description: '查看云空间', level: 1, tokenTypes: ['tenant', 'user'] },
}

check('租户缺 / 用户缺分开算', () => {
  // sheets:spreadsheet:readonly 在 schema 里只支持 tenant → 应用缺，但用户侧不该报缺
  const schemaTokens = { 'sheets:spreadsheet:readonly': ['tenant'], 'docx:document:readonly': ['tenant'] }
  const d = diffScopes({
    wanted: ['docx:document:readonly', 'sheets:spreadsheet:readonly'],
    appGranted: GRANTED,
    userGranted: [],
    schemaTokens,
  })
  assert.deepEqual(d.tenantMissing, ['sheets:spreadsheet:readonly'])
  assert.deepEqual(d.userMissing, [], 'tenant-only 的 scope 不该要求用户授权')
})

check('schema 补令牌类型：未开通的 user scope 仍能算进用户缺口', () => {
  const d = diffScopes({
    wanted: ['profile:user_profile:read'],
    appGranted: {},
    userGranted: [],
    schemaTokens: { 'profile:user_profile:read': ['user'] },
  })
  assert.deepEqual(d.tenantMissing, [], 'user-only 的 scope 不该要求应用开通')
  assert.deepEqual(d.userMissing, ['profile:user_profile:read'])
})

check('schema 与开放平台都有时以开放平台为准', () => {
  const d = diffScopes({
    wanted: ['drive:drive:readonly'],
    appGranted: { 'drive:drive:readonly': { tokenTypes: ['tenant', 'user'], description: 'x' } },
    userGranted: [],
    schemaTokens: { 'drive:drive:readonly': ['tenant'] },
  })
  assert.deepEqual(d.userMissing, ['drive:drive:readonly'], '开放平台的 user 类型应生效')
})
check('已开通且已授权的 scope 两边都不缺', () => {
  const d = diffScopes({
    wanted: ['drive:drive:readonly'],
    appGranted: GRANTED,
    userGranted: ['drive:drive:readonly'],
  })
  assert.deepEqual(d.tenantMissing, [])
  // drive:drive:readonly 两套令牌都支持，用户已授权 → 不缺口
  assert.deepEqual(d.userMissing, [])
})

check('新接口默认参数向后兼容（不传 schemaTokens 也能跑）', () => {
  const d = diffScopes({ wanted: ['a:b'], appGranted: {}, userGranted: [] })
  assert.equal(d.rows.length, 1)
})

check('没有令牌类型信息时按两套都要保守处理', () => {
  const d = diffScopes({ wanted: ['mystery:scope'], appGranted: {}, userGranted: [] })
  assert.deepEqual(d.tenantMissing, ['mystery:scope'])
  assert.deepEqual(d.userMissing, ['mystery:scope'])
})

check('申请链接带上预填 scope', () => {
  const u = consoleApplyUrl({ appId: 'cli_x', scopes: ['a:b', 'c:d'] })
  assert.ok(u.includes('/page/scope-apply?clientID=cli_x'))
  assert.ok(u.includes('scopes=a%3Ab%2Cc%3Ad'), `实际：${u}`)
})

check('申请链接没有 scope 时也能用（不给空 scopes=）', () => {
  const u = consoleApplyUrl({ appId: 'cli_x', scopes: [] })
  assert.ok(!u.endsWith('scopes='))
})

check('lark 品牌走 larksuite 域名', () => {
  assert.ok(consoleApplyUrl({ appId: 'a', brand: 'lark' }).startsWith('https://open.larksuite.com/'))
  assert.ok(appConsoleUrl({ appId: 'a' }).includes('open.feishu.cn'))
})

check('groupForDisplay 按域聚合并统计缺口', () => {
  const g = groupForDisplay({ wanted: ['docx:document:readonly', 'im:message:readonly'], appGranted: GRANTED, userGranted: [] })
  const docs = g.groups.find((x) => x.domain === 'docx')
  assert.ok(docs, '应有 docx 组')
  assert.equal(docs.missingTenant, 0, 'docx 已开通')
  assert.ok(g.groups.find((x) => x.domain === 'im').missingTenant > 0)
})

check('groupForDisplay 组的行数加起来等于 wanted 数', () => {
  const wanted = ['docx:document:readonly', 'im:message:readonly', 'im:chat:read']
  const g = groupForDisplay({ wanted, appGranted: GRANTED, userGranted: [] })
  const total = g.groups.reduce((n, x) => n + x.rows.length, 0)
  assert.equal(total, wanted.length)
})

// ===========================================================================
console.log('\n== 5. resolver：链接解析 ==')

const cases = [
  ['https://abc.feishu.cn/docx/AbCdEf123', 'docx', 'AbCdEf123'],
  ['https://abc.feishu.cn/docs/AbCdEf123', 'docx', 'AbCdEf123'],
  ['https://abc.feishu.cn/wiki/Wk123456', 'wiki', 'Wk123456'],
  ['https://abc.feishu.cn/sheets/Sht12345', 'sheet', 'Sht12345'],
  ['https://abc.feishu.cn/base/Bas12345', 'base', 'Bas12345'],
  ['https://abc.feishu.cn/app/App12345', 'base', 'App12345'],
  ['https://abc.feishu.cn/slides/Sld12345', 'slides', 'Sld12345'],
  ['https://abc.feishu.cn/mindnotes/Min1234', 'mindnotes', 'Min1234'],
  ['https://abc.feishu.cn/file/Fil12345', 'file', 'Fil12345'],
  ['https://abc.feishu.cn/minutes/Mnu1234', 'minutes', 'Mnu1234'],
  ['https://abc.feishu.cn/docx/AbCdEf123?from=from_copylink', 'docx', 'AbCdEf123'],
  ['https://x.feishu.cn/drive/folder/Fld1234', 'file', 'folder'],
]

for (const [url, kind, token] of cases) {
  check(`解析 ${url.replace('https://abc.feishu.cn', '')} → ${kind}`, () => {
    const p = parseDocUrl(url)
    assert.equal(p.kind, kind)
    assert.equal(p.token, token)
  })
}

check('larksuite.com 判为 lark 品牌', () => {
  assert.equal(parseDocUrl('https://x.larksuite.com/docx/Ab1').brand, 'lark')
  assert.equal(parseDocUrl('https://x.feishu.cn/docx/Ab1').brand, 'feishu')
})

check('wiki 链接标记 wiki=true', () => {
  assert.equal(parseDocUrl('https://x.feishu.cn/wiki/Wk1').wiki, true)
  assert.equal(parseDocUrl('https://x.feishu.cn/docx/Dx1').wiki, false)
})

check('裸 token 认作 unknown 并给出说明', () => {
  const p = parseDocUrl('AbCdEf123456')
  assert.equal(p.ok, true)
  assert.equal(p.kind, 'unknown')
  assert.ok(p.error.includes('type'), '应提示用 type 参数')
})

check('空输入与乱码输入优雅失败', () => {
  assert.equal(parseDocUrl('').ok, false)
  assert.equal(parseDocUrl('   ').ok, false)
  assert.equal(parseDocUrl('这不是链接').ok, false)
  assert.equal(parseDocUrl('https://x.feishu.cn/unknownpath/x').ok, false)
})

check('未知路径的报错列出支持的类型', () => {
  const p = parseDocUrl('https://x.feishu.cn/whatever/x')
  assert.ok(p.error.includes('/docx/'), `实际：${p.error}`)
  assert.ok(p.error.includes('/wiki/'))
})

check('查询参数里的 token 也能认（docToken / obj_token）', () => {
  assert.equal(parseDocUrl('https://x.feishu.cn/x?docToken=Tk1').token, 'Tk1')
  assert.equal(parseDocUrl('https://x.feishu.cn/x?obj_token=Tk2').token, 'Tk2')
})

check('每种 kind 都有中文名与读命令', () => {
  for (const kind of ['docx', 'doc', 'sheet', 'base', 'wiki', 'slides', 'mindnotes', 'file', 'minutes', 'folder', 'unknown']) {
    assert.ok(KIND_LABELS[kind], `${kind} 缺中文名`)
    assert.ok(Array.isArray(READ_COMMANDS[kind]) && READ_COMMANDS[kind].length > 0, `${kind} 缺读命令`)
  }
})

check('读命令都是数组生成器，能生成非空 argv', () => {
  for (const [kind, cmds] of Object.entries(READ_COMMANDS)) {
    for (const c of cmds) {
      const argv = c.args('TOKEN')
      assert.ok(Array.isArray(argv) && argv.length >= 2, `${kind}/${c.label} 生成的 argv 不对`)
      assert.ok(argv.includes('TOKEN'), `${kind}/${c.label} 没带 token`)
      assert.ok(c.label, `${kind} 的候选命令缺 label`)
    }
  }
})

check('docx 至少两条候选（markdown 失败还能退大纲）', () => {
  assert.ok(READ_COMMANDS.docx.length >= 2)
})

// ===========================================================================
console.log('\n== 6. resolver：重试判定 ==')

check('权限类错误可重试（换账户可能成功）', () => {
  assert.equal(isRetryableError({ ok: false, error: { code: 99991672, message: 'app_scope_not_applied' } }), true)
  assert.equal(isRetryableError({ ok: false, error: { code: 131006, message: 'no permission' } }), true)
  assert.equal(isRetryableError({ ok: false, error: { type: 'authentication', subtype: 'token_missing' } }), true)
})

check('文档不存在不重试（换谁都没用）', () => {
  assert.equal(isRetryableError({ ok: false, error: { code: 3380002, message: 'Invalid document_id' } }), false)
})

check('参数写错不重试', () => {
  assert.equal(isRetryableError({ ok: false, error: { type: 'validation', message: 'bad' } }), false)
  assert.equal(isRetryableError({ ok: false, stderr: 'unknown flag "--url"' }), false)
  assert.equal(isRetryableError({ ok: false, stderr: '--params invalid format, expected JSON object' }), false)
})

check('成功的调用不需要重试', () => {
  assert.equal(isRetryableError({ ok: true }), false)
  assert.equal(isRetryableError(null), false)
})

check('账户排序：默认账户提到最前，其余保序', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(orderAccounts(list, 'c').map((x) => x.id), ['c', 'a', 'b'])
  assert.deepEqual(orderAccounts(list, 'a').map((x) => x.id), ['a', 'b', 'c'])
  assert.deepEqual(orderAccounts(list, 'zzz').map((x) => x.id), ['a', 'b', 'c'])
})

check('账户排序不修改入参', () => {
  const list = [{ id: 'a' }, { id: 'b' }]
  orderAccounts(list, 'b')
  assert.deepEqual(list.map((x) => x.id), ['a', 'b'])
})

check('空/非数组账户表返回空数组', () => {
  assert.deepEqual(orderAccounts([], 'a'), [])
  assert.deepEqual(orderAccounts(null, 'a'), [])
})

// ===========================================================================
console.log('\n== 7. install：版本比较与资产名 ==')

check('semver 比较而不是字符串比较（1.0.99 < 1.0.100）', () => {
  assert.ok(compareVersions('1.0.99', '1.0.100') < 0, '1.0.99 应小于 1.0.100')
  assert.ok(compareVersions('1.0.100', '1.0.99') > 0)
  assert.equal(compareVersions('1.0.100', '1.0.100'), 0)
})

check('前导 v 与预发布后缀都能处理', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('1.2.3-beta', '1.2.3') < 0, '预发布应小于正式')
})

check('位数不同也对（1.10 vs 1.9）', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0)
})

check('parseVersion 抽出三段数字', () => {
  assert.deepEqual(parseVersion('v1.0.100'), [1, 0, 100])
  assert.deepEqual(parseVersion('1.0.100'), [1, 0, 100])
})

check('资产名按平台拼', () => {
  assert.equal(assetName('1.0.100', 'x64'), 'lark-cli-1.0.100-windows-amd64.zip')
  assert.equal(assetName('1.0.100', 'arm64'), 'lark-cli-1.0.100-windows-arm64.zip')
})

await checkAsync('checksums 里没有该资产时必须返回空串（调用方据此拒绝安装）', async () => {
  const r = await checksumFor('1.0.100', 'lark-cli-0.0.0-nonexistent.zip')
  assert.equal(r, '')
})

await checkAsync('probeVersion 对不存在的 exe 返回 unknown 而不抛', async () => {
  const v = await probeVersion('C:/definitely/not/here.exe', 3000)
  assert.equal(v, 'unknown')
})

// ===========================================================================
console.log('\n== 8. 失败态：模块在缺依赖时也不崩 ==')

check('SUPPLEMENT 的域都不在 schema 之外的乱名', () => {
  for (const k of Object.keys(SUPPLEMENT)) {
    assert.ok(typeof SUPPLEMENT[k].label === 'string' && SUPPLEMENT[k].label)
  }
})

await checkAsync('resolver 在没有账户时返回结构化失败而不是抛', async () => {
  const { readDocByUrl } = await import('../lib/resolver.js')
  const fakeService = { store: { list: () => [], defaultId: () => '' }, hasSecret: () => false }
  const r = await readDocByUrl({ service: fakeService, url: 'https://x.feishu.cn/docx/Ab1' })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('账户'), `实际：${r.error}`)
})

await checkAsync('resolver 空链接直接失败', async () => {
  const { readDocByUrl } = await import('../lib/resolver.js')
  const r = await readDocByUrl({ service: { store: { list: () => [], defaultId: () => '' } }, url: '' })
  assert.equal(r.ok, false)
})

await checkAsync('resolver 跳过没有 secret 的账户并记录原因', async () => {
  const { readDocByUrl } = await import('../lib/resolver.js')
  const fake = {
    store: { list: () => [{ id: 'a', label: 'A' }], defaultId: () => 'a' },
    hasSecret: () => false,
    run: async () => {
      throw new Error('不该被调用：没 secret 的账户应直接跳过')
    },
  }
  const r = await readDocByUrl({ service: fake, url: 'https://x.feishu.cn/docx/Ab1' })
  assert.equal(r.ok, false)
  assert.equal(r.attempts[0].skipped, true)
})

await checkAsync('resolver 遇到不可重试错误立刻停（只试 1 次）', async () => {
  const { readDocByUrl } = await import('../lib/resolver.js')
  let calls = 0
  const fake = {
    store: { list: () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], defaultId: () => 'a' },
    hasSecret: () => true,
    run: async () => {
      calls++
      return { ok: false, error: { code: 3380002, message: 'Invalid document_id' } }
    },
  }
  const r = await readDocByUrl({ service: fake, url: 'https://x.feishu.cn/docx/Ab1' })
  assert.equal(r.ok, false)
  assert.equal(r.fatal, true)
  assert.equal(calls, 1, `应在第一次不可重试就停，实际调了 ${calls} 次`)
})

await checkAsync('resolver 失败可重试时换账户继续并最终成功', async () => {
  const { readDocByUrl } = await import('../lib/resolver.js')
  const tried = []
  const fake = {
    store: { list: () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], defaultId: () => 'a' },
    hasSecret: () => true,
    run: async (_argv, opts) => {
      tried.push(opts.accountId)
      if (opts.accountId === 'a') return { ok: false, error: { code: 99991672, message: 'app_scope_not_applied' } }
      return { ok: true, json: { ok: true, data: { title: 'T' } } }
    },
  }
  const r = await readDocByUrl({ service: fake, url: 'https://x.feishu.cn/docx/Ab1', as: ['bot'] })
  assert.equal(r.ok, true)
  assert.equal(r.account, 'b', '应落到第二个账户')
  assert.ok(tried.includes('a') && tried.includes('b'))
})

await checkAsync('resolver 指定 account 后只试那一个', async () => {
  const { readDocByUrl } = await import('../lib/resolver.js')
  const tried = []
  const fake = {
    store: { list: () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], defaultId: () => 'a' },
    hasSecret: () => true,
    run: async (_argv, opts) => {
      tried.push(opts.accountId)
      return { ok: false, error: { code: 99991672, message: 'app_scope_not_applied' } }
    },
  }
  const r = await readDocByUrl({ service: fake, url: 'https://x.feishu.cn/docx/Ab1', account: 'b', as: ['bot'] })
  assert.equal(r.ok, false)
  assert.deepEqual([...new Set(tried)], ['b'])
})
// ===========================================================================
// 回归：v0.2.0 修的两个真 bug，都不能再掍回去
// ===========================================================================
console.log('\n[回归] 二维码输出路径 / token 验证缓存')

await checkAsync('二维码输出不得落在 CLI 配置目录（曾必定 100% 失败）', async () => {
  const src = readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8')
  // 旧码：const out = path.join(ap.dir, 'login-qr.png') —— ap.dir 就是配置目录，必被 denylist 拒
  assert.ok(
    !/path\.join\(ap\.dir,\s*'login-qr\.png'\)/.test(src),
    '二维码又写回账户目录了：CLI 把配置目录列为保护区，--output 指向那里必失败',
  )
  assert.ok(/mkdtempSync/.test(src), '应该用 mkdtemp 建独立临时目录，而不是写配置目录')
  assert.ok(/cwd:\s*opts\.cwd/.test(src), 'run() 必须支持 cwd 覆盖，否则 cwd 永远是配置目录')
})

await checkAsync('status({verify:true}) 必须绕缓存', async () => {
  const src = readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8')
  // 若 useCache 不含 !verify，上一次验证结论会把现在已过期的 token 报成有效
  const m = /const useCache = ([^\n]+)/.exec(src)
  assert.ok(m, '找不到 useCache 定义')
  assert.ok(/!verify/.test(m[1]), `useCache 必须排除 verify（当前：${m[1].trim()}）`)
  assert.ok(/'--verify'/.test(src), '应当把 --verify 传给 CLI')
})

await checkAsync('identity 透出 verified/openId，否则面板分不清“存在”与“有效”', async () => {
  const src = readFileSync(new URL('../lib/identity.js', import.meta.url), 'utf8')
  assert.ok(/verified/.test(src), 'identity.js 必顶把 bot.verified 透出去')
  assert.ok(/openId/.test(src), 'identity.js 必顶把 bot.openId 透出去')
})

await checkAsync('loginFinish 不能挂 3 分钟（长轮询必须短超时）', async () => {
  const src = readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8')
  const m = /async loginFinish\(\{[^}]*\}[^)]*\)/.exec(src)
  assert.ok(m, '找不到 loginFinish 签名')
  assert.ok(/timeoutMs\s*=\s*30000/.test(m[0]), `loginFinish 默认超时应为 30000（当前：${m[0].slice(0, 90)}）`)
  assert.ok(!/loginFinish[\s\S]{0,400}180000/.test(src), 'loginFinish 不得再用 180s：面板点一下会卡三分钟')
  assert.ok(/timedOut/.test(src), 'run() 必须透出 timedOut，loginFinish 才能区分“还没确认”与“真报错”')
})


// ===========================================================================
console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) {
  for (const f of failures) console.log(`\n--- ${f.name} ---\n${f.error.stack}`)
  process.exit(1)
}
