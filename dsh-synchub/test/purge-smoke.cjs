/**
 * purgeSession 离线 smoke（node --check 查不出逻辑错，必须真跑）。
 *
 * 用临时目录伪造 DSH_HOME，绝不碰真实会话数据；覆盖：
 *  - 初始态：预览无副作用
 *  - sessionId 两种写法（session-<uuid> / 裸 uuid）都认
 *  - workspace.json 四处引用（sessionIds / archived / pinned / 另一 workspace）全部清掉
 *  - projcache 文件删除、回滚点生成、二次确认闸门
 *  - 未静止拒绝、confirm 不匹配拒绝、验收接口
 *  - 搜索索引「派生自愈」语义（不直接写活库）
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'synchub-purge-'));
  const dsh = path.join(tmp, 'dshhome');
  const sid = 'session-11111111-2222-4333-8444-555555555555';
  const bare = '11111111-2222-4333-8444-555555555555';
  await fsp.mkdir(path.join(dsh, 'sessions', '--C-dsh-test--', sid), { recursive: true });
  const logFile = path.join(dsh, 'sessions', '--C-dsh-test--', sid, 'session.v4.jsonl.zstd');
  await fsp.writeFile(logFile, Buffer.from('fake'));
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  await fsp.utimes(logFile, old, old); // 回拨 mtime，模拟静止会话
  await fsp.mkdir(path.join(dsh, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  await fsp.writeFile(path.join(dsh, 'storages', 'session_projcache', 'sessions', bare + '.json'), JSON.stringify({
    version: 7, record: { rows: { turnBoundary: { ver: 2, seq: 1, val: { openTurnStartSeq: null } }, sessionStats: { ver: 1, seq: 1, val: { openStep: null, pendingCalls: {} } } } },
  }));
  const ws = {
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: [sid], pinnedSessionIds: [sid], workspaceIds: ['w1', 'w2'], defaultWorkspaceId: 'w1' },
    tables: { workspaces: { w1: { path: 'C:\\dsh\\test', sessionIds: [sid] }, w2: { path: 'C:\\dsh\\other', sessionIds: [sid] } } },
  };
  await fsp.writeFile(path.join(dsh, 'storages', 'workspace.json'), JSON.stringify(ws, null, 2));

  process.env.DSH_HOME = dsh;
  process.env.DSH_SESSION_ID = 'session-different-current';
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href + '?t=' + Date.now());
  const { purgePreview, purgeExecute, purgeVerify, sessionIdForms } = mod.__test;

  // sessionId 两种写法都认
  assert.deepEqual([...sessionIdForms(sid)].sort(), [bare, sid].sort());
  assert.deepEqual([...sessionIdForms(bare)].sort(), [bare, sid].sort());

  // 初始态：预览不改任何东西
  const before = await fsp.readFile(path.join(dsh, 'storages', 'workspace.json'), 'utf8');
  const pre = await purgePreview(sid);
  assert.equal(pre.ok, true);
  assert.equal(pre.quiet, true);
  assert.equal(pre.physical.length, 1);
  assert.equal(pre.workspaceRefs.length, 4, '应识别 workspace.json 四处引用');
  assert.equal(pre.projcache, path.join(dsh, 'storages', 'session_projcache', 'sessions', bare + '.json'));
  assert.equal(await fsp.readFile(path.join(dsh, 'storages', 'workspace.json'), 'utf8'), before, '预览不能写文件');

  // confirm 不匹配 → 拒绝
  const bad = await purgeExecute(sid, 'wrong');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /二次确认/);
  assert.equal(fs.existsSync(path.join(dsh, 'sessions', '--C-dsh-test--', sid)), true, '拒绝时不能删');

  // 正确执行
  const res = await purgeExecute(sid, sid);
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(dsh, 'sessions', '--C-dsh-test--', sid)), false, '正文目录应删除');
  assert.equal(fs.existsSync(path.join(dsh, 'storages', 'session_projcache', 'sessions', bare + '.json')), false, 'projcache 应删除');
  assert.equal(res.removed.workspaceRefPaths.length, 4);
  assert.ok(res.rollbackDir && fs.existsSync(path.join(res.rollbackDir, 'RESTORE.md')), '回滚点应存在');

  // workspace.json 四处引用全清、其它字段保留
  const after = JSON.parse(await fsp.readFile(path.join(dsh, 'storages', 'workspace.json'), 'utf8'));
  assert.deepEqual(after.global.archivedSessionIds, []);
  assert.deepEqual(after.global.pinnedSessionIds, []);
  assert.deepEqual(after.tables.workspaces.w1.sessionIds, []);
  assert.deepEqual(after.tables.workspaces.w2.sessionIds, []);
  assert.equal(after.global.defaultWorkspaceId, 'w1', '不相关字段要保留');

  // 回滚点里能找回原文
  const wsBackup = JSON.parse(await fsp.readFile(path.join(res.rollbackDir, 'storages', 'workspace.json'), 'utf8'));
  assert.ok(wsBackup.global.archivedSessionIds.includes(sid), '回滚点应留原引用');

  // 验收接口
  const v = await purgeVerify(sid);
  assert.equal(v.clean, true);
  assert.equal(v.checks.physicalGone, true);
  assert.equal(v.checks.workspaceRefsGone, true);
  assert.equal(v.checks.projcacheGone, true);
  assert.match(v.checks.searchIndex, /self.healing/);

  // 未静止拒绝：另一个 fixture（openTurnStartSeq 非 null）
  const dsh2 = path.join(tmp, 'dshhome2');
  await fsp.mkdir(path.join(dsh2, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  await fsp.writeFile(path.join(dsh2, 'storages', 'session_projcache', 'sessions', bare + '.json'), JSON.stringify({
    version: 7, record: { rows: { turnBoundary: { val: { openTurnStartSeq: 5 } } } },
  }));
  await fsp.writeFile(path.join(dsh2, 'storages', 'workspace.json'), JSON.stringify(ws));
  process.env.DSH_HOME = dsh2;
  const mod2 = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href + '?t=' + (Date.now() + 1));
  const quietPre = await mod2.__test.purgePreview(sid);
  assert.equal(quietPre.quiet, false, '运行中的会话应判为未静止');
  const blocked = await mod2.__test.purgeExecute(sid, sid);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /未静止/);

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log('PURGE_SMOKE_OK');
})().catch(e => { console.error(e); process.exit(1); });
