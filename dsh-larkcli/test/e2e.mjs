// 人工诊断脚本（**不是**自动化测试，没断言，不进 test:all）：用真实 CLI + 真实凭据跑一遍
// status / +chat-list / schema，把原始输出打出来给人看。查“为什么调不通”时用它，
// 而不是把它当回归测试 —— 它不检查任何预期值。自动化回归看 run/tools/client/smoke/v2/activate。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountsStore, migrateLegacy } from '../lib/core.js'
import { LarkService } from '../lib/service.js'

const pluginDir = path.resolve(import.meta.dirname, '..')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'larkcli-e2e-'))
const store = new AccountsStore(dataDir)

const mig = migrateLegacy({ store, pluginDir, legacyId: 'default' })
console.log('migrateLegacy:', mig ? `导入 ${mig.account.id} (appId=${mig.account.appId})` : '无可迁移（跳过）')

const svc = new LarkService({ dataDir, pluginDir })

console.log('\n--- lark_doctor 等价 ---')
console.log(JSON.stringify(svc.layout(), null, 2))
console.log('version:', await svc.version())

console.log('\n--- status ---')
const st = await svc.status({ refresh: true })
console.log(JSON.stringify({ ok: st.ok, account: st.account, appId: st.appId, identities: st.identities, error: st.error }, null, 2))

console.log('\n--- im +chat-list --as bot ---')
const r1 = await svc.run(['im', '+chat-list', '--page-size', '2', '--as', 'bot'])
console.log('ok=' + r1.ok, 'exit=' + r1.exitCode, 'kind=' + r1.kind)
if (r1.ok) {
  const chats = r1.json?.data?.chats || []
  console.log('chats=' + chats.length, chats.map((c) => c.name).join(' | '))
} else console.log('err:', JSON.stringify(r1.error))

console.log('\n--- api GET /open-apis/bot/v3/info ---')
const r2 = await svc.run(['api', 'GET', '/open-apis/bot/v3/info'])
console.log('ok=' + r2.ok, 'app_name=' + (r2.json?.data?.app_name || '?'))

console.log('\n--- schema 索引（前 5 个域）---')
const { list, cached } = await svc.schemaList()
console.log('cached=' + cached, 'methods=' + list.length)
const names = list.slice(0, 1).map((x) => x.name)
console.log('sample=' + names.join(','))

console.log('\n--- 缓存命中（第二次应 cached=true）---')
const s2 = await svc.status({})
console.log('cached=' + s2.cached)

console.log('\n--- config.json 内容（确认路径指向本次 dataDir）---')
const cfgFile = path.join(dataDir, 'accounts', 'default', 'config.json')
console.log(fs.readFileSync(cfgFile, 'utf8'))

fs.rmSync(dataDir, { recursive: true, force: true })
