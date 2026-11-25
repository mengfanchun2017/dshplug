/**
 * dsh-synchub · 会话日志 apply 守卫 smoke（ADR-043）
 *
 * 覆盖 2026-11-25 的真实故障：`/sync` 的 apply 把停滞 payload 盖到正在写的本机日志上，
 * DSH 继续追加后磁盘出现 seq 断口，历史打不开。守卫必须在「本机更新」时跳过，
 * 且不能把坏 payload 传下去，也不能挡住正常应用。
 *
 * 全程用临时 DSH_HOME，不碰真实数据，不发网络。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const idxPath = path.join(ROOT, 'lib', 'index.js');

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

function frame(lines) {
  return zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), CHECKSUM);
}

/** 造一份合法的会话日志：第一帧 header，第二帧事件。 */
function makeLog(seqs) {
  const header = JSON.stringify({
    type: 'session', version: 4, id: 'session-test', createdAt: 1,
    cwd: 'C:\\tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  });
  const events = seqs.map((seq, i) => JSON.stringify({
    type: 'step/start', seq, time: 1000 + i, data: { turn: 1, step: i },
  }));
  return Buffer.concat([frame([header]), frame(events)]);
}

async function writeFile(p, buf) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, buf);
}

(async () => {
  /* ---------------- A. sessionlog.js 纯逻辑 ---------------- */
  console.log('A. sessionlog.js');
  const logMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'sessionlog.js')).href + '?a=' + Date.now());
  const good = makeLog([0, 1, 2]);
  const scanned = logMod.scanZstdFrames(good);
  assert.equal(scanned.frames.length, 2, '两帧应扫出两个 frame');
  assert.equal(scanned.tornStart, undefined, '完整文件没有 torn 尾帧');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-guard-'));
  const goodFile = path.join(tmp, 'good.zstd');
  fs.writeFileSync(goodFile, good);
  const d1 = logMod.decodeSessionLog(goodFile);
  assert.equal(d1.ok, true, '合法日志应解开');
  assert.equal(d1.frames, 2);
  const g1 = logMod.sessionLogSeqGaps(d1.plaintext);
  assert.equal(g1.events, 3);
  assert.equal(g1.gaps.length, 0, '连续 seq 不该报断口');

  const gappedFile = path.join(tmp, 'gapped.zstd');
  fs.writeFileSync(gappedFile, makeLog([0, 1, 3]));
  const g2 = logMod.sessionLogSeqGaps(logMod.decodeSessionLog(gappedFile).plaintext);
  assert.equal(g2.gaps.length, 1, 'seq 0,1,3 应报 1 处断口');
  assert.equal(g2.gaps[0].expected, 2);
  assert.equal(g2.gaps[0].got, 3);

  const badFile = path.join(tmp, 'bad.zstd');
  fs.writeFileSync(badFile, Buffer.from('not a zstd file'));
  assert.equal(logMod.decodeSessionLog(badFile).ok, false, '非 zstd 应返回 ok:false');
  assert.equal(logMod.decodeSessionLog(path.join(tmp, 'missing.zstd')).ok, false, '缺文件应返回 ok:false');

  /* ---------------- B. applyPayload 守卫 ---------------- */
  console.log('B. applyPayload 守卫');
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-guard-home-'));
  const idx = await import(pathToFileURL(idxPath).href + '?a=' + Date.now());
  const payloadRoot = path.join(process.env.DSH_HOME, 'dsh-synchub', 'repos', 'all', 'dsh-home');
  const sessRel = 'sessions/--C-tmp--/session-test/session.v4.jsonl.zstd';
  const payloadFile = path.join(payloadRoot, sessRel);
  const localFile = path.join(process.env.DSH_HOME, sessRel);
  const cfg = { surfaces: { sessions: true, skills: true } };

  // 1. 本机更新（payload 是本机前缀）→ 跳过，本机字节不变
  await writeFile(localFile, makeLog([0, 1, 2, 3]));
  await writeFile(payloadFile, makeLog([0, 1, 2]));
  let r = await idx.__test.applyPayload(cfg, {});
  assert.equal(r.ok, true);
  assert.equal(r.written, 0, '本机更新时不应写');
  assert.equal(r.skipped, 1, '应记 1 条跳过');
  assert.ok(r.guarded && r.guarded.length === 1, '应给出 guarded 明细');
  assert.match(r.guarded[0].reason, /本机日志更新/);
  assert.deepEqual(fs.readFileSync(localFile), makeLog([0, 1, 2, 3]), '本机文件必须原样保留');
  console.log('  ok - 本机更新（payload 是前缀）跳过');

  // 2. payload 更新（本机是 payload 前缀）→ 应用
  await writeFile(localFile, makeLog([0, 1, 2]));
  await writeFile(payloadFile, makeLog([0, 1, 2, 3]));
  r = await idx.__test.applyPayload(cfg, {});
  assert.equal(r.written, 1, 'payload 更新应写本机');
  assert.equal(r.skipped, 0);
  assert.deepEqual(fs.readFileSync(localFile), makeLog([0, 1, 2, 3]), '本机应变成 payload 内容');
  console.log('  ok - payload 更新（本机是前缀）应用');

  // 3. payload 有 seq 断口 → 跳过，不把坏数据盖下去
  await writeFile(localFile, makeLog([0, 1, 2]));
  await writeFile(payloadFile, makeLog([0, 1, 3]));
  r = await idx.__test.applyPayload(cfg, {});
  assert.equal(r.written, 0, '坏 payload 不应写');
  assert.equal(r.skipped, 1);
  assert.match(r.guarded[0].reason, /seq 断口/);
  assert.deepEqual(fs.readFileSync(localFile), makeLog([0, 1, 2]));
  console.log('  ok - payload 有 seq 断口跳过');

  // 4. force（keep-remote 用）→ 即使本机更新也覆盖
  await writeFile(localFile, makeLog([0, 1, 2, 3]));
  await writeFile(payloadFile, makeLog([0, 1, 2]));
  r = await idx.__test.applyPayload(cfg, { force: true });
  assert.equal(r.written, 1, 'force 应放行覆盖');
  assert.equal(r.skipped, 0);
  assert.deepEqual(fs.readFileSync(localFile), makeLog([0, 1, 2]));
  console.log('  ok - force 放行覆盖（keep-remote 语义）');

  // 5. 初始态：本机没有该文件 → 应用
  await fsp.rm(localFile, { force: true });
  await writeFile(payloadFile, makeLog([0, 1]));
  r = await idx.__test.applyPayload(cfg, {});
  assert.equal(r.written, 1, '本机缺文件应从 payload 建');
  assert.deepEqual(fs.readFileSync(localFile), makeLog([0, 1]));
  console.log('  ok - 初始态（本机缺文件）应用');

  // 6. 非会话文件不受守卫影响（skills 正常覆盖）
  const skillRel = 'skills/a.md';
  await writeFile(path.join(payloadRoot, skillRel), Buffer.from('new'));
  await writeFile(path.join(process.env.DSH_HOME, skillRel), Buffer.from('old'));
  r = await idx.__test.applyPayload(cfg, {});
  assert.equal(fs.readFileSync(path.join(process.env.DSH_HOME, skillRel), 'utf8'), 'new', 'skills 应正常覆盖');
  console.log('  ok - 非会话文件不受守卫影响');

  console.log('\nsessionlog-guard-smoke: 全绿');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
