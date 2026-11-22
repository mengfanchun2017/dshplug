/**
 * 回归：`syncCliConfig` 绝不能抹掉 config.json 里已有的 user token。
 *
 * 这是 0.2.3 修掉的最严重 bug，也是用户反复「授权成功但面板还是 user 未授权」的唯一真凶：
 * 旧实现每次 prepareAccount 都用 buildCliConfig 的结果**整份覆盖**，
 * 而 buildCliConfig 只产出 {appId, appSecret, brand}，没有 users ——
 * 于是 CLI 刚写完的 token 在 300ms 后就被本插件删掉了。
 *
 * 这类 bug 的可怕之处：所有现有测试都是绿的（它们只验「文件被写对了」，
 * 不验「原有内容还在」），运行时也不报错，只是授权永远不生效。
 * 所以专门守这一条。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { syncCliConfig, accountPaths, AccountsStore } = await import('../lib/core.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'larkcli-sync-'))
const store = new AccountsStore(tmp)
store.upsert({ id: 'acct', label: '测试', appId: 'cli_aaMERGE0001', makeDefault: true })

const account = store.get('acct')
const ap = accountPaths(tmp, 'acct')
fs.mkdirSync(ap.dir, { recursive: true })
fs.writeFileSync(ap.secretFile, 'the-secret-value', 'utf8')

const USERS = [
  {
    openId: 'ou_2ff5e6bba17b1f3ab50c8be39c4841f4',
    name: '张三',
    accessToken: 'u-abc123',
    refreshToken: 'r-abc123',
    expiresAt: '2026-12-31T00:00:00Z',
  },
]

// 模拟 CLI 已经授权完成的状态：同 appId 条目里带 users
fs.writeFileSync(
  ap.configFile,
  JSON.stringify(
    {
      currentApp: 'cli_aaMERGE0001',
      apps: [
        {
          name: 'the-app',
          appId: 'cli_aaMERGE0001',
          appSecret: { source: 'file', id: 'old-path' },
          brand: 'feishu',
          users: USERS,
          futureField: 'keep-me-too',
        },
      ],
    },
    null,
    2,
  ),
)

// ---- 连续多次同步（模拟反复刷新面板 / 反复调工具）----
for (let i = 0; i < 5; i++) syncCliConfig(account, ap.secretFile)

const after = JSON.parse(fs.readFileSync(ap.configFile, 'utf8'))
const entry = after.apps.find((a) => a && a.appId === 'cli_aaMERGE0001')

console.log('=== 合并后 ===')
console.log('apps 数量        :', after.apps.length)
console.log('users 长度       :', Array.isArray(entry?.users) ? entry.users.length : '（没了！）')
console.log('open_id 保留     :', entry?.users?.[0]?.openId === USERS[0].openId)
console.log('access_token 保留:', entry?.users?.[0]?.accessToken === USERS[0].accessToken)
console.log('未知字段保留     :', entry?.futureField === 'keep-me-too')
console.log('currentApp 保留  :', after.currentApp === 'cli_aaMERGE0001')
console.log('secret 已指向本机:', entry?.appSecret?.id === ap.secretFile.split(path.sep).join('/'))

assert.equal(entry?.users?.length, 1, 'user token 被抹掉了 —— 这正是本测试要守的 bug')
assert.equal(entry.users[0].openId, USERS[0].openId, 'open_id 被改了')
assert.equal(entry.users[0].accessToken, USERS[0].accessToken, 'access_token 被改了')
assert.equal(entry.futureField, 'keep-me-too', 'CLI 新增的未知字段被抹掉了（未来版本的 users 同级字段）')
assert.equal(after.currentApp, 'cli_aaMERGE0001', 'currentApp 被抹掉了')
assert.equal(after.apps.length, 1, 'apps 数组长度被改动了')

// ---- 再验「内容未变不写盘」：不该无意义地刷新 mtime ----
const mtimeBefore = fs.statSync(ap.configFile).mtimeMs
const r = syncCliConfig(account, ap.secretFile)
const mtimeAfter = fs.statSync(ap.configFile).mtimeMs
console.log('\n重复同步 changed :', r.changed, '（应为 false）')
console.log('mtime 未变       :', mtimeBefore === mtimeAfter)
assert.equal(r.changed, false, '内容未变却报 changed=true')
assert.equal(mtimeBefore, mtimeAfter, '内容未变却写盘了')

// ---- 无 users 的旧条目 + 换了 appId：应替换，不留僵尸 ----
const store2 = new AccountsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'larkcli-sync2-')))
const tmp2 = store2.dataDir
store2.upsert({ id: 'swap', label: '换了应用', appId: 'cli_aaNEW0002', makeDefault: true })
const acct2 = store2.get('swap')
const ap2 = accountPaths(tmp2, 'swap')
fs.mkdirSync(ap2.dir, { recursive: true })
fs.writeFileSync(ap2.secretFile, 'new-secret', 'utf8')
fs.writeFileSync(
  ap2.configFile,
  JSON.stringify({ apps: [{ name: 'stale', appId: 'cli_aaOLD9999', appSecret: { source: 'file', id: 'x' }, users: [] }] }),
)
syncCliConfig(acct2, ap2.secretFile)
const after2 = JSON.parse(fs.readFileSync(ap2.configFile, 'utf8'))
console.log('\n换应用后 apps 数量:', after2.apps.length, '（应为 1，旧的无 token 条目被替换）')
console.log('新 appId          :', after2.apps[0].appId)
assert.equal(after2.apps.length, 1, '旧的无 token 条目没被替换，留下了僵尸应用')
assert.equal(after2.apps[0].appId, 'cli_aaNEW0002')

// ---- 全新配置（没有 config.json）：正常创建 ----
const store3 = new AccountsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'larkcli-sync3-')))
store3.upsert({ id: 'fresh', label: '全新', appId: 'cli_aaFRESH003', makeDefault: true })
const acct3 = store3.get('fresh')
const ap3 = accountPaths(store3.dataDir, 'fresh')
fs.mkdirSync(ap3.dir, { recursive: true })
fs.writeFileSync(ap3.secretFile, 'fresh-secret', 'utf8')
const r3 = syncCliConfig(acct3, ap3.secretFile)
const after3 = JSON.parse(fs.readFileSync(ap3.configFile, 'utf8'))
console.log('\n全新创建 changed  :', r3.changed, 'apps:', after3.apps.length)
assert.equal(r3.changed, true)
assert.equal(after3.apps.length, 1)
assert.equal(after3.apps[0].appId, 'cli_aaFRESH003')

for (const d of [tmp, tmp2, store3.dataDir]) {
  try {
    fs.rmSync(d, { recursive: true, force: true })
  } catch {}
}

console.log('\n✅ config.json 合并回归通过（user token / 未知字段 / currentApp 都不会被抹掉）')
