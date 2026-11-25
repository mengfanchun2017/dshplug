/**
 * 记忆地图 smoke（阶段①：只读枚举）。
 *
 * 覆盖：
 *  A. 完整现场：用户全局规则 / 项目规则（含 .local）/ 项目技能 / 用户技能 / 会话日志 / 记忆文件
 *     都出现在正确的层里，sync 标记正确（synchub / workspace-git / none）。
 *  B. 初始态：DSH_HOME 是空目录时返回 ok:true 且各层存在（行可能 exists=false），不抛。
 *  C. 失败态：workspace.json 损坏时按「无工作区」处理，不崩、不抛。
 *  D. 边界：工作区路径不存在、项目根找不到（无 .git）时也能列出文件。
 *
 * 全程只读，不写真实 DSH_HOME。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const memPath = path.join(ROOT, 'lib', 'memory.js');

const stamp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-mem-'));

(async () => {
  const mem = await import(pathToFileURL(memPath).href + '?a=' + Date.now());
  const { memoryMap } = mem;

  /* ---------------- A. 完整现场 ---------------- */
  const home = stamp();
  const agents = stamp();
  process.env.DSH_AGENTS_HOME = agents;

  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# global\n');
  fs.writeFileSync(path.join(agents, 'AGENTS.md'), '# shared\n');

  // 工作区：项目根有 .git，根下有 AGENTS.md，子目录有 AGENTS.local.md 与 CLAUDE.md
  const wsRoot = path.join(home, 'ws-one');
  const wsSub = path.join(wsRoot, 'sub');
  fs.mkdirSync(wsSub, { recursive: true });
  fs.mkdirSync(path.join(wsRoot, '.git'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'AGENTS.md'), '# project\n');
  fs.writeFileSync(path.join(wsRoot, 'sub', 'CLAUDE.md'), '# sub\n');
  fs.writeFileSync(path.join(wsRoot, 'sub', 'AGENTS.local.md'), '# local\n');
  fs.mkdirSync(path.join(wsRoot, '.dsh', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, '.dsh', 'skills', 'skill-a'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, '.dsh', 'skills', 'skill-a', 'SKILL.md'), '# a\n');
  fs.mkdirSync(path.join(wsRoot, '.agents', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, '.agents', 'skills', 'flat.md'), '# flat\n');

  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills', 'user-skill'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'user-skill', 'SKILL.md'), '# u\n');
  fs.mkdirSync(path.join(agents, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'skills', 'shared.md'), '# s\n');

  // 记忆文件（阶段②起写入；这里先造出来验证列得出）
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(home, 'memory', 'USER.md'), '# user memory\n');
  fs.mkdirSync(path.join(wsRoot, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(wsSub, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(wsSub, 'memory', 'PROJECT.md'), '# proj\n');
  // 会话日志：两个分组、每组两个会话目录
  for (const g of ['--C-dsh-ws-one--', '--C-dsh-ws-two--']) {
    for (const id of ['session-aaa', 'session-bbb']) {
      fs.mkdirSync(path.join(home, 'sessions', g, id), { recursive: true });
    }
  }

  // workspace.json
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { 'ws-1': { title: 'ws-one', path: wsSub, sessionIds: ['session-aaa'] } } },
  }));

  const m = await memoryMap({ dshHome: home });
  assert.equal(m.ok, true);
  assert.equal(m.dshHome, home);
  assert.equal(m.agentsHome, agents);
  assert.equal(m.workspaces.length, 1);
  assert.equal(m.workspaces[0].projectRoot, wsRoot, '项目根应找到 .git');

  const layerIds = m.layers.map(l => l.id);
  for (const id of ['memory', 'user-instructions', 'project-instructions', 'skills', 'sessions']) {
    assert.ok(layerIds.includes(id), '缺层 ' + id);
  }
  const rowsOf = id => (m.layers.find(l => l.id === id) || { rows: [] }).rows;

  // 记忆文件
  const memRows = rowsOf('memory');
  assert.equal(memRows.length, 2, '用户级 + 工作区级各一行');
  assert.equal(memRows[0].sync, 'synchub');
  assert.equal(memRows[0].exists, true);
  assert.equal(memRows[1].files, 1, '工作区 memory/ 里有 1 个文件');

  // 用户全局规则
  const userRows = rowsOf('user-instructions');
  assert.equal(userRows.length, 2);
  assert.equal(userRows[0].sync, 'synchub');
  assert.equal(userRows[1].sync, 'none', '~/.agents 预留位不同步');

  // 项目规则：根 AGENTS.md + 子 CLAUDE.md + 子 AGENTS.local.md = 3
  const projRows = rowsOf('project-instructions');
  assert.equal(projRows.length, 3, '应有 3 条项目规则');
  assert.ok(projRows.every(r => r.sync === 'workspace-git'), '项目规则归工作区 git');
  assert.ok(projRows.some(r => r.note.includes('本地覆盖')), 'local 文件要标注');

  // 技能：项目 .dsh 1 + 项目 .agents 1 + 用户 .dsh 1 + 用户 .agents 1 = 4
  const skRows = rowsOf('skills');
  assert.equal(skRows.length, 4, '应有 4 行技能根');
  assert.ok(skRows.some(r => r.sync === 'synchub' && r.label.includes('~/.dsh')), '用户技能在同步面');
  assert.ok(skRows.some(r => r.sync === 'workspace-git' && r.label.includes('ws-one')), '项目技能归工作区');

  // 会话日志
  const seRows = rowsOf('sessions');
  assert.equal(seRows.length, 1);
  assert.equal(seRows[0].files, 4, '4 个会话目录');
  assert.equal(seRows[0].exists, true);

  /* ---------------- B. 初始态：空 DSH_HOME ---------------- */
  const emptyHome = stamp();
  const emptyAgents = stamp();
  process.env.DSH_AGENTS_HOME = emptyAgents;
  const b = await memoryMap({ dshHome: emptyHome });
  assert.equal(b.ok, true, '空目录也要 ok');
  assert.equal(b.workspaces.length, 0);
  const bRows = b.layers.flatMap(l => l.rows);
  assert.ok(bRows.length >= 3, '即便空也要列出用户规则/用户技能/会话日志等占位行');
  assert.ok(bRows.every(r => r.exists === false || r.files === 0), '初始态不该有真实文件');

  /* ---------------- C. 失败态：workspace.json 损坏 ---------------- */
  const badHome = stamp();
  fs.mkdirSync(path.join(badHome, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(badHome, 'storages', 'workspace.json'), '{ not json');
  const c = await memoryMap({ dshHome: badHome });
  assert.equal(c.ok, true, '损坏的登记表不能拖垮整张表');
  assert.equal(c.workspaces.length, 0);
  assert.equal(c.layers.find(l => l.id === 'project-instructions').rows.length, 0);

  /* ---------------- D. 边界：工作区路径不存在 / 无 .git ---------------- */
  const edgeHome = stamp();
  const edgeAgents = stamp();
  process.env.DSH_AGENTS_HOME = edgeAgents;
  const ghost = path.join(edgeHome, 'ghost-ws');
  fs.mkdirSync(path.join(edgeHome, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(edgeHome, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { 'w-ghost': { title: 'ghost', path: ghost, sessionIds: [] } } },
  }));
  const d = await memoryMap({ dshHome: edgeHome });
  assert.equal(d.ok, true, '路径不存在也要 ok');
  assert.equal(d.workspaces[0].projectRoot, path.resolve(ghost), '无 .git 时项目根退回工作区路径');
  assert.equal(d.layers.find(l => l.id === 'project-instructions').rows.length, 0, '没有文件就没有规则行');

  console.log('memorymap-smoke: ok');
})().catch(e => { console.error('memorymap-smoke: FAIL', e); process.exit(1); });
