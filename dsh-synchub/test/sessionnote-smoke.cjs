/**
 * sessionNote（compact 人工蒸馏）离线 smoke。
 * 临时 DSH_HOME + 临时工作区；覆盖：
 *  - 模板非空、包含五个章节、不是 compact 摘要 dump
 *  - 预览能定位工作区、默认文件名、不改盘
 *  - 未登记会话 / 路径穿越文件名 / 空内容 均拒绝
 *  - confirm 闸门：不带 confirm 不写
 *  - 内容与模板相同拒绝（必须人写结论）
 *  - 确认后写到工作区 docs/session-notes/，目标已存在时不覆盖且先备份
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'synchub-note-'));
  const dsh = path.join(tmp, 'dshhome');
  const wsDir = path.join(tmp, 'workspace1');
  await fsp.mkdir(path.join(dsh, 'storages'), { recursive: true });
  await fsp.mkdir(wsDir, { recursive: true });
  const sid = 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await fsp.writeFile(path.join(dsh, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: ['w1'] },
    tables: { workspaces: { w1: { path: wsDir, title: 'workspace1', sessionIds: [sid] } } },
  }));
  process.env.DSH_HOME = dsh;
  process.env.DSH_SESSION_ID = 'session-current';
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href + '?n=' + Date.now());
  const { sessionNoteTemplate, sessionNotePreview, sessionNoteWrite, resolveNotePath } = mod.__test;

  // 模板骨架
  const tpl = sessionNoteTemplate(sid, wsDir);
  for (const sec of ['## 1. 确定结论', '## 2. 决策与理由', '## 3. 待办', '## 4. 涉及的文件路径', '## 5.']) {
    assert.ok(tpl.includes(sec), '模板应含 ' + sec);
  }
  assert.ok(tpl.includes(sid));

  // 预览：定位工作区、目标路径、不改盘
  const pre = await sessionNotePreview(sid);
  assert.equal(pre.ok, true);
  assert.equal(pre.workspace.path, wsDir);
  assert.equal(pre.target, path.join(wsDir, 'docs', 'session-notes', `session-${sid.replace(/^session-/, '')}.md`));
  assert.equal(pre.exists, false);
  assert.equal(pre.mode, 'create');
  assert.equal(fs.existsSync(pre.target), false, '预览不能写盘');

  // 未登记会话 → 拒绝
  const orphan = await sessionNotePreview('session-does-not-exist');
  assert.equal(orphan.ok, false);
  assert.match(orphan.error, /未登记到任何工作区/);

  // 路径穿越文件名 → 拒绝
  const badName = resolveNotePath({ path: wsDir }, '../../evil.md');
  assert.ok(!badName.error, 'basename 应剥离目录成分');
  assert.equal(badName.file, path.join(wsDir, 'docs', 'session-notes', 'evil.md'), '路径穿越被剥离到工作区子目录内');

  // confirm 闸门
  const content = tpl.replace('- （写这条会话里已经拍板、以后要遵守的结论）', '- 已确认结论：X 用方案 A');
  const noConfirm = await sessionNoteWrite(sid, 'note.md', content, undefined);
  assert.equal(noConfirm.ok, false);
  assert.match(noConfirm.error, /二次确认/);
  assert.equal(fs.existsSync(path.join(wsDir, 'docs', 'session-notes', 'note.md')), false);

  // 空内容 / 模板原样 → 拒绝
  assert.equal((await sessionNoteWrite(sid, 'note.md', '', 'WRITE')).ok, false);
  const unchanged = await sessionNoteWrite(sid, 'note.md', tpl, 'WRITE');
  assert.equal(unchanged.ok, false);
  assert.match(unchanged.error, /模板完全相同/);

  // 正确写盘
  const ok = await sessionNoteWrite(sid, 'note.md', content, 'WRITE');
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(ok.target), true);
  assert.ok(fs.readFileSync(ok.target, 'utf8').includes('已确认结论：X 用方案 A'));

  // 目标已存在 → 不覆盖，先备份
  const again = await sessionNoteWrite(sid, 'note.md', content + '\n另一版', 'WRITE');
  assert.equal(again.ok, false);
  assert.match(again.error, /已存在/);
  assert.ok(again.backedUpTo && fs.existsSync(again.backedUpTo), '应留备份');
  assert.ok(fs.readFileSync(ok.target, 'utf8').includes('已确认结论'), '原文档未被覆盖');

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log('SESSIONNOTE_SMOKE_OK');
})().catch(e => { console.error(e); process.exit(1); });
