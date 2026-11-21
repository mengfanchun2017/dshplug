/**
 * dsh-synchub · 会话体检与修复 smoke（ADR-034）
 *
 * 全部在临时 DSH_HOME 里造现场，不碰真实 ~/.dsh。
 * 关键点：**必须覆盖初始态与失败态**（AGENTS.md 铁律），所以除了「有故障时能修好」，
 * 还专门验「没有故障时不许瞎报」和「危险动作没有 confirm 必须拒绝」。
 *
 * 分组：
 *   A. encodeGroup 与 index.js 的 encodeWorkspaceGroup 逐字符一致（两处实现不能漂移）
 *   B. 干净现场：不报任何 error，不给任何 safe 动作
 *   C. 幽灵组（原目录还在但登记丢了）→ 可重建登记
 *   D. 幽灵组（原目录已改名）→ 给 relocate 候选，且必须显式 targets 才执行
 *   E. 悬空引用 → 能清掉，清完引用没了但正文不动
 *   F. subagent 会话不被误报成「未分组」
 *   G. 二次确认闸门：不带 confirm 一律拒绝，且拒绝时不写盘
 *   H. 执行后写回 workspace.json 且备份存在
 *   I. 源码级断言：只读扫描里没有写盘调用
 *   J. 职责边界（0.9.0 收窄）：blocking/advisory 划分、一键救援范围、健康态
 *      —— 用户原话：「如果报错了先修复避免不能用，就可以了，其他交给专业的插件」。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const PASS = [];
const FAIL = [];
function ok(name, fn) {
  try { fn(); PASS.push(name); } catch (e) { FAIL.push(name + ' :: ' + e.message); }
}
async function okAsync(name, fn) {
  try { await fn(); PASS.push(name); } catch (e) { FAIL.push(name + ' :: ' + e.message); }
}

/** 造一个最小可用的会话文件：第一帧就是 header，后面再拼一帧正文（模拟多帧）。 */
function writeSession(dir, id, headerExtra) {
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({
    type: 'session', version: 4, id, createdAt: Date.now(),
    cwd: headerExtra && headerExtra.cwd, ...headerExtra,
  }) + '\n';
  const body = JSON.stringify({ type: 'user/message', seq: 1, data: { content: 'hi' } }) + '\n';
  const buf = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(header, 'utf8')),
    zlib.zstdCompressSync(Buffer.from(body, 'utf8')),
  ]);
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), buf);
}

function munge(p) {
  const body = p.replace(/^[A-Za-z]:/, m => m[0]).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '');
  return `--${body}--`;
}

/** 造一个临时 DSH_HOME，workspaces 与磁盘组都由调用方描述。 */
function makeHome(spec) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-smoke-'));
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'dsh-synchub', 'backups'), { recursive: true });

  const workspaces = {};
  const ids = [];
  for (const w of spec.workspaces || []) {
    const id = w.id || `ws-${Object.keys(workspaces).length + 1}`;
    workspaces[id] = {
      path: w.path, title: w.title || path.basename(w.path),
      sessionIds: w.sessionIds || [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    ids.push(id);
  }
  const doc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: ids[0] || null, workspaceIds: ids, archivedSessionIds: spec.archived || [], pinnedSessionIds: [] },
    tables: { workspaces },
  };
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(doc), 'utf8');

  for (const g of spec.groups || []) {
    /* 组目录本身要先建 —— 空组（sessions:[]）也要在磁盘上存在，否则扫不到。 */
    fs.mkdirSync(path.join(home, 'sessions', g.name), { recursive: true });
    for (const s of g.sessions || []) writeSession(path.join(home, 'sessions', g.name, s.id), s.id, s);
  }
  return home;
}

(async () => {
  /* ================= A. 编码一致性 ================= */
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-a-'));
  const idx = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href + '?a=' + Date.now());
  const doc = await import(pathToFileURL(path.join(ROOT, 'lib', 'sessiondoctor.js')).href + '?a=' + Date.now());

  ok('A1 encodeGroup 与 encodeWorkspaceGroup 逐字符一致', () => {
    const samples = [
      'C:\\dsh\\dw-plugin', 'C:\\dsh\\dw-base', 'C:\\skill',
      'C:\\Users\\franc\\Documents\\deepseek-harness\\default-workspace',
      'D:\\a\\b\\c', 'C:\\x-y\\z-w',
    ];
    for (const p of samples) {
      assert.equal(doc.encodeGroup(p), idx.__test.encodeWorkspaceGroup(p), `编码不一致：${p}`);
      assert.equal(doc.encodeGroup(p), munge(p), `与测试自身 munge 不一致：${p}`);
    }
  });

  ok('A2 空输入返回 null，不抛', () => {
    assert.equal(doc.encodeGroup(''), null);
    assert.equal(doc.encodeGroup(null), null);
    assert.equal(doc.encodeGroup(undefined), null);
  });

  /* ================= B. 干净现场 ================= */
  await okAsync('B1 干净现场：0 error、0 safe 动作（不许瞎报）', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-clean-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ path: wsPath, title: 'clean', sessionIds: ['session-aaaa'] }],
      groups: [{ name: munge(wsPath), sessions: [{ id: 'session-aaaa', cwd: wsPath }] }],
    });
    const r = await doc.doctorScan({ dshHome: home });
    assert.equal(r.ok, true);
    assert.equal(r.summary.error, 0, '干净现场不该有 error：' + JSON.stringify(r.findings));
    assert.equal(r.actions.filter(a => a.safe).length, 0, '干净现场不该给 safe 动作');
    assert.equal(r.counts.topLevel, 1);
  });

  await okAsync('B2 空 DSH_HOME（一个会话都没有）不抛，返回 0', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-empty-'));
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
    const r = await doc.doctorScan({ dshHome: home });
    assert.equal(r.ok, true);
    assert.equal(r.counts.sessionDirs, 0);
    assert.equal(r.findings.length, 0);
  });

  await okAsync('B3 workspace.json 损坏时报错而不是假装没事', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-bad-'));
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), '{ this is not json', 'utf8');
    const r = await doc.doctorScan({ dshHome: home });
    assert.equal(r.ok, false);
    assert.ok(/无法解析/.test(r.error), '应给出可读的解析错误，实际：' + r.error);
  });

  /* ================= C. 幽灵组，原目录还在 ================= */
  await okAsync('C1 原目录还在但登记丢了 → create-workspace 动作', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-orphan-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [],
      groups: [{ name: munge(wsPath), sessions: [{ id: 'session-bbbb', cwd: wsPath }] }],
    });
    const r = await doc.doctorScan({ dshHome: home });
    const f = r.findings.find(x => x.code === 'orphan-group-recoverable');
    assert.ok(f, '应识别出可恢复的幽灵组，实际：' + JSON.stringify(r.findings.map(x => x.code)));
    assert.ok(/登记丢了/.test(f.title), '标题要说清是登记丢了：' + f.title);
    const a = r.actions.find(x => x.kind === 'create-workspace');
    assert.ok(a, '应给出 create-workspace 动作');
    assert.equal(a.safe, false, '重建工作区涉及新增登记，必须让人确认而不是批量自动跑');
  });

  /* ================= D. 目录改名 → relocate ================= */
  await okAsync('D1 原目录已改名 → 给 relocate 候选，且候选里带出现存工作区', async () => {
    const live = path.join(os.tmpdir(), 'doc-renamed-target');
    fs.mkdirSync(live, { recursive: true });
    const dead = path.join(os.tmpdir(), 'doc-renamed-old');   // 故意不创建 = 已改名
    const home = makeHome({
      workspaces: [{ path: live, title: 'renamed-target', sessionIds: [] }],
      groups: [{ name: munge(dead), sessions: [{ id: 'session-cccc', cwd: dead }] }],
    });
    const r = await doc.doctorScan({ dshHome: home });
    const f = r.findings.find(x => x.code === 'orphan-group-relocatable');
    assert.ok(f, '目录改名应识别为 relocatable，实际：' + JSON.stringify(r.findings.map(x => x.code)));
    assert.ok(Array.isArray(f.evidence.candidates) && f.evidence.candidates.length >= 1, '必须给出候选工作区');
    assert.equal(f.evidence.candidates[0].wsId, Object.keys(JSON.parse(
      fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8')).tables.workspaces)[0]);
    const a = r.actions.find(x => x.kind === 'relocate-group');
    assert.ok(a, '应给 relocate-group 动作');
    assert.equal(a.safe, false, '改指必须人工选目标，不能算安全动作');
  });

  await okAsync('D2 relocate 没有 targets 时拒绝执行（不猜目标）', async () => {
    const live = path.join(os.tmpdir(), 'doc-d2-live');
    fs.mkdirSync(live, { recursive: true });
    const dead = path.join(os.tmpdir(), 'doc-d2-dead');
    const home = makeHome({
      workspaces: [{ id: 'W1', path: live, title: 'l', sessionIds: [] }],
      groups: [{ name: munge(dead), sessions: [{ id: 'session-dddd', cwd: dead }] }],
    });
    const r = await doc.doctorApply({ dshHome: home, ids: ['relocate:' + munge(dead)], confirm: 'REPAIR' });
    assert.equal(r.ok, true, '整体不该失败');
    const skip = r.skipped.find(x => /改指必须指定目标/.test(x.reason));
    assert.ok(skip, '没有 targets 时必须跳过并说明原因，实际：' + JSON.stringify(r.skipped));
    // 会话目录必须原地没动
    assert.ok(fs.existsSync(path.join(home, 'sessions', munge(dead), 'session-dddd')), '拒绝后不该搬目录');
  });

  await okAsync('D3 relocate 带 targets 时真的搬过去并补登记', async () => {
    const live = path.join(os.tmpdir(), 'doc-d3-live');
    fs.mkdirSync(live, { recursive: true });
    const dead = path.join(os.tmpdir(), 'doc-d3-dead');
    const home = makeHome({
      workspaces: [{ id: 'W1', path: live, title: 'live', sessionIds: [] }],
      groups: [{ name: munge(dead), sessions: [{ id: 'session-eeee', cwd: dead }] }],
    });
    const actionId = 'relocate:' + munge(dead);
    const r = await doc.doctorApply({
      dshHome: home, ids: [actionId], targets: { [actionId]: 'W1' }, confirm: 'REPAIR',
    });
    assert.equal(r.ok, true);
    assert.equal(r.applied.length, 1, '应有一个动作成功：' + JSON.stringify(r));
    const moved = path.join(home, 'sessions', munge(live), 'session-eeee');
    assert.ok(fs.existsSync(moved), '正文目录应已搬到目标组');
    assert.ok(!fs.existsSync(path.join(home, 'sessions', munge(dead), 'session-eeee')), '源目录应已删除');
    const docJson = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
    assert.ok(docJson.tables.workspaces.W1.sessionIds.includes('session-eeee'), '应补进登记');
  });

  /* ================= E. 悬空引用 ================= */
  await okAsync('E1 悬空引用能被清掉，且不碰磁盘正文', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-dangling');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 'd', sessionIds: ['session-ghost', 'session-real'] }],
      groups: [{ name: munge(wsPath), sessions: [{ id: 'session-real', cwd: wsPath }] }],
    });
    const r = await doc.doctorScan({ dshHome: home });
    const f = r.findings.find(x => x.code === 'dangling-ref');
    assert.ok(f, '应识别悬空引用');
    assert.ok(f.evidence.ids.includes('session-ghost'));
    const a = r.actions.find(x => x.kind === 'drop-ref');
    assert.equal(a.safe, true, '清引用是安全的，可以归入一键修复');

    const ap = await doc.doctorApply({ dshHome: home, ids: [a.id], confirm: 'REPAIR' });
    assert.equal(ap.ok, true);
    const docJson = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
    assert.ok(!docJson.tables.workspaces.W1.sessionIds.includes('session-ghost'), '悬空引用应被清掉');
    assert.ok(docJson.tables.workspaces.W1.sessionIds.includes('session-real'), '真实会话不能误删');
    assert.ok(fs.existsSync(path.join(home, 'sessions', munge(wsPath), 'session-real', 'session.v4.jsonl.zstd')), '正文文件必须还在');
  });

  /* ================= F. subagent 不误报 ================= */
  await okAsync('F1 subagent 会话（origin=subagent）不参与未分组判断', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-sub');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 's', sessionIds: ['session-main'] }],
      groups: [{
        name: munge(wsPath),
        sessions: [
          { id: 'session-main', cwd: wsPath },
          { id: 'sub-1', cwd: wsPath, origin: 'subagent', delegationDepth: 1, parentSession: 'session-main' },
        ],
      }],
    });
    const r = await doc.doctorScan({ dshHome: home });
    assert.equal(r.counts.subagent, 1, '应识别出 1 个 subagent');
    assert.equal(r.findings.filter(f => f.code === 'unregistered-live').length, 0,
      'subagent 不该被报成未登记：' + JSON.stringify(r.findings.map(f => f.code)));
  });

  /* ================= G. 二次确认闸门 ================= */
  await okAsync('G1 不带 confirm 一律拒绝，且一个字节都不写', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-gate');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 'g', sessionIds: ['session-ghost'] }],
      groups: [],
    });
    const before = fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8');
    for (const bad of [undefined, '', 'repair', 'MOVE', 123]) {
      const r = await doc.doctorApply({ dshHome: home, confirm: bad });
      assert.equal(r.ok, false, `confirm=${bad} 应被拒`);
      assert.ok(/confirm/.test(r.error), '错误信息要说明需要 confirm');
    }
    const after = fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8');
    assert.equal(after, before, '被拒绝时 workspace.json 不能有任何变化');
    const backups = fs.readdirSync(path.join(home, 'dsh-synchub', 'backups'));
    assert.equal(backups.length, 0, '被拒绝时不该产生备份目录');
  });

  /* ================= H. 执行后留回滚点 ================= */
  await okAsync('H1 执行后 workspace.json 变了，回滚点里存着旧的那份', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-backup');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 'b', sessionIds: ['session-ghost'] }],
      groups: [],
    });
    const before = fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8');
    const r = await doc.doctorApply({ dshHome: home, confirm: 'REPAIR' });
    assert.equal(r.ok, true);
    const after = fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8');
    assert.notEqual(after, before, '清掉悬空引用后文件应该变了');
    assert.ok(fs.existsSync(path.join(r.backupDir, 'storages', 'workspace.json')), '回滚点里必须有 workspace.json');
    const saved = fs.readFileSync(path.join(r.backupDir, 'storages', 'workspace.json'), 'utf8');
    assert.equal(saved, before, '回滚点里必须是执行前的原文');
    assert.ok(r.verify, '执行后必须复查');
  });

  /* ================= I. 源码级约束 ================= */
  ok('I1 doctorScan 函数体里没有写盘调用（只读扫描的铁律）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'sessiondoctor.js'), 'utf8');
    const start = src.indexOf('export async function doctorScan');
    const end = src.indexOf('async function copyAndMove');
    assert.ok(start > 0 && end > start, '找不到 doctorScan 边界');
    const body = src.slice(start, end);
    for (const bad of ['writeFile', 'fsp.write', 'fsp.rm', 'fsp.cp', 'copyFile', 'mkdir']) {
      assert.ok(!body.includes(bad), `只读扫描里出现了写盘调用：${bad}`);
    }
  });

  ok('I2 搬目录必须是「复制→校验→删源」，且校验字节数与文件数', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'sessiondoctor.js'), 'utf8');
    const i = src.indexOf('async function copyAndMove');
    assert.ok(i > 0);
    const body = src.slice(i, i + 900);
    const cp = body.indexOf('fsp.cp');
    const chk = body.indexOf('a.files !== b.files');
    const rm = body.indexOf('fsp.rm');
    assert.ok(cp > 0 && chk > cp && rm > chk, '顺序必须是 cp → 校验 → rm');
  });

  ok('I3 路由在 index.js 里注册为 exact 且 POST 走 confirm', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
    assert.ok(/path: '\/api\/dsh-synchub\/session-doctor'/.test(src), '缺 session-doctor 路由');
    assert.ok(/path: '\/api\/dsh-synchub\/session-doctor\/help'/.test(src), '缺 help 路由');
    assert.ok(/sessionDoctorApply\(\{/.test(src), 'POST 分支应调 sessionDoctorApply');
    assert.ok(/confirm: body\.confirm/.test(src), 'confirm 必须从 body 透传，不能在路由里写死');
  });

  ok('I4 引擎导出的函数名与 index.js 的 import 对得上', () => {
    assert.equal(typeof doc.doctorScan, 'function');
    assert.equal(typeof doc.doctorApply, 'function');
    assert.equal(typeof doc.encodeGroup, 'function');
    assert.equal(typeof idx.__test.sessionDoctorScan, 'function', 'index.js 必须 re-export 给 smoke 用');
    assert.equal(typeof idx.__test.sessionDoctorApply, 'function');
  });

  /* ================= J. 职责边界（0.9.0 收窄） =================
     用户原话：「能不能做成 1 —— 如果报错了先修复避免不能用，就可以了，
     其他的交给专业的 session 管理插件」。于是判据从「数据整不整齐」
     改成「用户能不能打开会话」。J 组就是把这条边界钉住。 */
  await okAsync('J1 干净现场 health=ok，且不需要救援', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-j1-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 'j1', sessionIds: ['session-j1'] }],
      groups: [{ name: munge(wsPath), sessions: [{ id: 'session-j1', cwd: wsPath }] }],
    });
    const r = await doc.doctorScan({ dshHome: home });
    assert.equal(r.summary.health, 'ok', '干净现场必须报能用：' + JSON.stringify(r.summary));
    assert.equal(r.rescue.needed, false);
    assert.equal(r.rescue.ids.length, 0);
    assert.equal(r.summary.blocking, 0);
  });

  await okAsync('J2 悬空引用（点进去空白）属于 blocking，且可一键救援', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-j2-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 'j2', sessionIds: ['session-ghost'] }],
      groups: [],
    });
    const r = await doc.doctorScan({ dshHome: home });
    const f = r.findings.find(x => x.code === 'dangling-ref');
    assert.ok(f, '应识别悬空引用');
    assert.equal(f.impact, 'blocking', '点进去是空白 = 不能用 = blocking');
    assert.equal(r.summary.health, 'repairable', '全可一键修时必须是 repairable');
    assert.ok(r.rescue.needed, '应标为需要救援');
    assert.equal(r.rescue.ids.length, 1, '救援列表里应有 drop-ref：' + JSON.stringify(r.rescue));
  });

  await okAsync('J3 只有空组目录（不影响使用）不算 blocking，health 仍为 ok', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-j3-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 'j3', sessionIds: ['session-j3'] }],
      groups: [
        { name: munge(wsPath), sessions: [{ id: 'session-j3', cwd: wsPath }] },
        { name: '--C-leftover-empty--', sessions: [] },
      ],
    });
    const r = await doc.doctorScan({ dshHome: home });
    const f = r.findings.find(x => x.code === 'empty-group');
    assert.ok(f, '应识别空组目录：' + JSON.stringify(r.findings.map(x => x.code)));
    assert.equal(f.impact, 'advisory', '空组只是不整洁，不该算不能用');
    assert.equal(r.summary.blocking, 0, '空组不能计入 blocking');
    assert.equal(r.summary.health, 'ok', '只有整洁问题时必须报「能用」');
    assert.equal(r.rescue.ids.length, 0, '整洁项不能进救援列表');
    assert.ok(r.misc.count >= 1, '但要如实计入 misc，不能藏起来');
  });

  await okAsync('J4 一键救援（不传 ids）只动「不能用」的，不碰空组目录', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-j4-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 'j4', sessionIds: ['session-real', 'session-ghost'] }],
      groups: [
        { name: munge(wsPath), sessions: [{ id: 'session-real', cwd: wsPath }] },
        { name: '--C-j4-empty--', sessions: [] },
      ],
    });
    const emptyDir = path.join(home, 'sessions', '--C-j4-empty--');
    assert.ok(fs.existsSync(emptyDir), '前置：空组目录应该在');

    const r = await doc.doctorApply({ dshHome: home, confirm: 'REPAIR' });
    assert.equal(r.ok, true, '一键救援不应失败：' + JSON.stringify(r));
    assert.equal(r.scope, 'rescue', '结里要标明本次范围是救援');
    const kinds = r.applied.map(x => x.kind);
    assert.deepEqual(kinds, ['drop-ref'], '只该清悬空引用，实际：' + JSON.stringify(kinds));
    assert.ok(fs.existsSync(emptyDir), '空组目录不能被顺手删掉（那不是救援范围）');
  });

  await okAsync('J5 需要人指定目标的（改指）→ health=needs-human 且不进救援列表', async () => {
    const live = path.join(os.tmpdir(), 'doc-j5-live');
    fs.mkdirSync(live, { recursive: true });
    const dead = path.join(os.tmpdir(), 'doc-j5-dead');
    const home = makeHome({
      workspaces: [{ id: 'W1', path: live, title: 'j5', sessionIds: [] }],
      groups: [{ name: munge(dead), sessions: [{ id: 'session-j5', cwd: dead }] }],
    });
    const r = await doc.doctorScan({ dshHome: home });
    assert.equal(r.summary.health, 'needs-human',
      '改指需要人给目标，不能说成可自动修：' + JSON.stringify(r.summary));
    assert.equal(r.rescue.ids.length, 0, '不能把改指塞进一键救援（猜错就搬到错的地方）');
    assert.ok(r.rescue.humanCodes.indexOf('orphan-group-relocatable') >= 0,
      '要如实列出哪些项要人管：' + JSON.stringify(r.rescue.humanCodes));
  });

  await okAsync('J6 每条发现都必须带合法的 impact，不能有漏网', async () => {
    const wsPath = path.join(os.tmpdir(), 'doc-j6-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const dead = path.join(os.tmpdir(), 'doc-j6-dead');
    const home = makeHome({
      workspaces: [{ id: 'W1', path: wsPath, title: 'j6', sessionIds: ['session-ghost'] }],
      groups: [
        { name: munge(wsPath), sessions: [{ id: 'session-j6', cwd: wsPath }] },
        { name: munge(dead), sessions: [{ id: 'session-j6b', cwd: dead }] },
        { name: '--C-j6-empty--', sessions: [] },
      ],
    });
    const r = await doc.doctorScan({ dshHome: home });
    assert.ok(r.findings.length >= 3, '造了三种故障，应该全部报出来');
    for (const f of r.findings) {
      assert.ok(f.impact === 'blocking' || f.impact === 'advisory',
        `发现 ${f.code} 的 impact 不合法：${f.impact}`);
    }
    assert.equal(r.summary.blocking + r.summary.advisory, r.summary.total,
      'blocking + advisory 必须等于 total，不然就漏数据了');
  });

  /* ---------------- 汇总 ---------------- */
  for (const p of PASS) console.log('  ✓ ' + p);
  for (const f of FAIL) console.log('  ✗ ' + f);
  console.log(`\n会话体检 smoke：${PASS.length} 通过 / ${FAIL.length} 失败`);
  if (FAIL.length) process.exit(1);
})();
