/**
 * 归档记忆 smoke（阶段②：读会话 / 定位落点 / 写记忆）。
 *
 *  A. 完整现场：多帧 zstd 会话 → 提取 user/assistant 文本（滤掉 system-reminder）；
 *     archivePlan 定位工作区与 <workspace>/memory/PROJECT.md；appendMemory 备份后追加。
 *  B. 初始态：会话不存在 → ok:false（不抛）。
 *  C. 失败态：会话文件损坏 / 无对话文本 → ok:false。
 *  D. 边界：会话未登记到工作区 → archivePlan 明确报「未分组」。
 *
 * 全程只读/写临时目录，不碰真实 DSH_HOME。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const memPath = path.join(ROOT, 'lib', 'memory.js');

const stamp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-arch-'));

function frame(lines) {
  return zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
}

function writeSession(dshHome, group, sessionId, lines) {
  const dir = path.join(dshHome, 'sessions', group, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frame(lines));
  return dir;
}

(async () => {
  const mem = await import(pathToFileURL(memPath).href + '?a=' + Date.now());
  const { readSessionTranscript, archivePlan, appendMemory, encodeWorkspaceGroup } = mem;

  /* ---------------- A. 完整现场 ---------------- */
  const home = stamp();
  const ws = path.join(home, 'ws-one');
  fs.mkdirSync(ws, { recursive: true });

  const SID = 'session-abc-123';
  writeSession(home, '--C-dsh-ws-one--', SID, [
    JSON.stringify({ type: 'session', version: 4, id: SID, cwd: ws }),
    JSON.stringify({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '用户问题一' }], role: 'user' } }),
    JSON.stringify({ type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '<system-reminder>注入内容</system-reminder>' }], role: 'user' } }),
    JSON.stringify({ type: 'assistant/message', seq: 3, data: { content: [{ type: 'text', text: '助手回答一' }], role: 'assistant' } }),
    JSON.stringify({ type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '用户问题二' }], role: 'user' } }),
  ]);

  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { 'w1': { title: 'ws-one', path: ws, sessionIds: [SID] } } },
  }));

  const t = await readSessionTranscript(home, SID);
  assert.equal(t.ok, true, t.error || '');
  assert.equal(t.messages.length, 3, '应提取 3 条（滤掉 system-reminder）');
  assert.equal(t.messages[0].role, 'user');
  assert.equal(t.messages[0].text, '用户问题一');
  assert.ok(!t.messages.some(m => m.text.includes('system-reminder')), '注入内容必须滤掉');

  const plan = await archivePlan(home, SID);
  assert.equal(plan.ok, true, plan.error || '');
  assert.equal(plan.title, 'ws-one');
  assert.equal(plan.file, path.join(ws, 'memory', 'PROJECT.md'));
  assert.equal(plan.userFile, path.join(home, 'memory', 'USER.md'));

  const w1 = await appendMemory(plan.file, '## 2026-11-25 归档：会话 ' + SID + '\n\n- 结论：X');
  assert.equal(w1.ok, true);
  assert.equal(w1.existed, false);
  const w2 = await appendMemory(plan.file, '## 2026-11-26 归档：会话 ' + SID + 'b\n\n- 结论：Y');
  assert.equal(w2.existed, true, '第二次应检测到已存在');
  const written = fs.readFileSync(plan.file, 'utf8');
  assert.ok(written.includes('结论：X') && written.includes('结论：Y'), '两次内容都要在');
  assert.ok(fs.readdirSync(path.dirname(plan.file)).some(f => f.includes('.bak-')), '写前应留备份');

  /* ---------------- B. 初始态：会话不存在 ---------------- */
  const b = await readSessionTranscript(home, 'session-not-here');
  assert.equal(b.ok, false);
  assert.match(b.error, /找不到/);

  /* ---------------- C. 失败态：损坏 / 无文本 ---------------- */
  const badHome = stamp();
  const badDir = path.join(badHome, 'sessions', '--C-dsh-bad--', 'session-bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'session.v4.jsonl.zstd'), Buffer.from('not zstd at all'));
  const c1 = await readSessionTranscript(badHome, 'session-bad');
  assert.equal(c1.ok, false, '损坏正文不能谎称成功');

  const emptyHome = stamp();
  writeSession(emptyHome, '--C-dsh-e--', 'session-empty', [
    JSON.stringify({ type: 'session', version: 4 }),
    JSON.stringify({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '<system-reminder>只有注入</system-reminder>' }], role: 'user' } }),
  ]);
  const c2 = await readSessionTranscript(emptyHome, 'session-empty');
  assert.equal(c2.ok, false, '只有注入没有对话 → 明确失败');

  /* ---------------- D. 边界：未分组会话 ---------------- */
  const d = await archivePlan(home, 'session-orphan');
  assert.equal(d.ok, false);
  assert.match(d.error, /未分组|未登记/);

  /* ---------------- 编码规则 ---------------- */
  assert.equal(encodeWorkspaceGroup('C:\\dsh\\dw-plugin'), '--C-dsh-dw-plugin--');
  assert.equal(encodeWorkspaceGroup(null), null);

  console.log('memoryarchive-smoke: ok');
})().catch(e => { console.error('memoryarchive-smoke: FAIL', e); process.exit(1); });
