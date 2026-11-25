/**
 * stateInfo（真实状态目录接入）离线 smoke。
 *  - 初始态：目录不存在 → initialized=false、hint 明确、不抛错、不创建目录
 *  - 已初始化：config.json 存在 + 两通道仓库 .git/.git/HEAD + backups 计数
 *  - 部分初始化：只有 config，没有 repos → 正确反映「仓库未建」
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function load(dsh) {
  process.env.DSH_HOME = dsh;
  process.env.DSH_SESSION_ID = 'session-current';
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href + '?s=' + Date.now() + Math.random());
  return mod.__test.stateInfo;
}

(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'synchub-state-'));

  // 初始态
  const empty = path.join(tmp, 'empty');
  await fsp.mkdir(empty, { recursive: true });
  const f1 = await load(empty);
  const s1 = await f1();
  assert.equal(s1.initialized, false);
  assert.equal(s1.rootExists, false);
  assert.equal(s1.config.exists, false);
  assert.match(s1.hint, /尚未初始化/);
  assert.equal(fs.existsSync(path.join(empty, 'dsh-synchub')), false, '只读接口不能创建状态目录');

  // 部分初始化：只有 config.json
  const partial = path.join(tmp, 'partial');
  await fsp.mkdir(path.join(partial, 'dsh-synchub'), { recursive: true });
  await fsp.writeFile(path.join(partial, 'dsh-synchub', 'config.json'), '{"machine":"T"}');
  const f2 = await load(partial);
  const s2 = await f2();
  assert.equal(s2.initialized, true);
  assert.equal(s2.config.exists, true);
  assert.ok(s2.config.modifiedAt);
  assert.equal(s2.repos.all.hasGit, false);

  // 完整：两通道仓库 + backups
  const full = path.join(tmp, 'full');
  for (const ch of ['all']) {
    await fsp.mkdir(path.join(full, 'dsh-synchub', 'repos', ch, '.git'), { recursive: true });
    await fsp.writeFile(path.join(full, 'dsh-synchub', 'repos', ch, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fsp.mkdir(path.join(full, 'dsh-synchub', 'repos', ch, 'dsh-home'), { recursive: true });
  }
  await fsp.writeFile(path.join(full, 'dsh-synchub', 'config.json'), '{"machine":"T"}');
  await fsp.mkdir(path.join(full, 'dsh-synchub', 'backups', '2026-01-01'), { recursive: true });
  await fsp.mkdir(path.join(full, 'dsh-synchub', 'backups', '2026-01-02'), { recursive: true });
  const f3 = await load(full);
  const s3 = await f3();
  assert.equal(s3.initialized, true);
  assert.equal(s3.repos.all.hasGit, true);
  assert.equal(s3.repos.all.hasHead, true);
  assert.equal(s3.repos.all.hasPayload, true);
  assert.equal(s3.backupCount, 2);
  assert.match(s3.hint, /已就绪|修改于/);

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log('STATE_SMOKE_OK');
})().catch(e => { console.error(e); process.exit(1); });
