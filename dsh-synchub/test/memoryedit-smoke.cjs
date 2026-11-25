/**
 * 记忆编辑白名单 smoke（阶段④）。
 *
 * 只测 resolveMemoryEditPath 这一个安全收口：
 *  - 允许：用户级 ~/.dsh/memory/USER.md、某工作区 <path>/memory/PROJECT.md
 *  - 拒绝：相对路径、工作区外的绝对路径、非 .md、凭据文件
 *  - 失败态：路径为空、workspace.json 损坏
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-edit-'));
  process.env.DSH_HOME = home;
  process.env.DSH_AGENTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-edit-a-'));

  const ws = path.join(home, 'ws-one');
  fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { w1: { title: 'ws-one', path: ws, sessionIds: [] } } },
  }));
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'token: xxx');

  const idx = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href + '?a=' + Date.now());
  const { resolveMemoryEditPath } = idx.__test;

  // 允许
  const a1 = await resolveMemoryEditPath(path.join(home, 'memory', 'USER.md'));
  assert.equal(a1.ok, true, a1.error || '');
  assert.equal(a1.path, path.join(home, 'memory', 'USER.md'));
  const a2 = await resolveMemoryEditPath(path.join(ws, 'memory', 'PROJECT.md'));
  assert.equal(a2.ok, true, a2.error || '');

  // 拒绝：相对路径
  assert.equal((await resolveMemoryEditPath('memory/USER.md')).ok, false);
  // 拒绝：非 md
  assert.equal((await resolveMemoryEditPath(path.join(ws, 'memory', 'data.json'))).ok, false);
  // 拒绝：工作区外的绝对路径
  assert.equal((await resolveMemoryEditPath(path.join(home, 'other', 'X.md'))).ok, false);
  // 拒绝：凭据文件
  assert.equal((await resolveMemoryEditPath(path.join(home, '.credentials.yaml'))).ok, false);
  // 拒绝：目录穿越
  assert.equal((await resolveMemoryEditPath(path.join(ws, 'memory', '..', '..', '.credentials.yaml'))).ok, false);
  // 拒绝：空
  assert.equal((await resolveMemoryEditPath('')).ok, false);

  // 失败态：workspace.json 损坏 → 只剩用户级允许，工作区拒绝
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), '{ bad');
  const b1 = await resolveMemoryEditPath(path.join(home, 'memory', 'USER.md'));
  assert.equal(b1.ok, true, '损坏登记表不应影响用户级');
  const b2 = await resolveMemoryEditPath(path.join(ws, 'memory', 'PROJECT.md'));
  assert.equal(b2.ok, false, '登记读不到时工作区级应拒绝（不给写未知目录）');

  console.log('memoryedit-smoke: ok');
})().catch(e => { console.error('memoryedit-smoke: FAIL', e); process.exit(1); });
