/**
 * dsh-synchub · 会话体检与修复引擎（ADR-034）
 *
 * 为什么单独成文件：index.js 已 3400+ 行，把「扫 sessions 树 + 读 zstd 头 + 改
 * workspace.json」再塞进去会让它更难测。这里只做**纯逻辑**：入参给 dshHome，
 * 出参给结构化结论，不注册路由、不读配置、不碰 git。
 *
 * 解决的故障（都是「目录改名」引发的同一类，共同点是**会话用不了**）：
 *   ① 工作区改名/移动 → DSH 删掉旧登记、新建一个登记 → 旧会话全部掉进「未分组」
 *   ② sessions/<编码组>/ 目录还在，但 workspace.json 里已经没有对应工作区 → 幽灵组
 *   ③ workspace.json 里登记了会话，但磁盘上没有目录 → 悬空引用（点进去空白）
 *   ④ 同一个会话被登记进两个工作区 → blocking（删了又加一次的典型后果）
 *   ⑤ 会话目录所在组与它的归属工作区路径不一致 → 显示在工作区 A、正文在 B（打不开）
 *   ⑥ 会话就在有效组里却没登记 → 侧边栏看不见
 *
 * **职责边界（0.9.0 收窄）**：synchub 只管「让它能用」。每条发现带 impact：
 *   - blocking：会话看不见 / 点进去空白 / 工作区打不开 —— 属于本插件的职责，
 *     其中动作 safe 的一律可以一键救援（summary.health='repairable'）。
 *   - advisory：重复登记、空组目录、可以归档的幽灵组 —— 只是不整洁，不影响使用，
 *     只报告不主动修。这些交给专门的会话管理插件，不要在这里掺和。
 * 判断标准很硬：「用户是不是打不开/看不见会话」。不是「数据不整齐」。
 *
 * 判据一律用**正向编码比对**（把候选路径 encode 成组名去比），不做反向解码。
 * 原因：路径里的 `-` 与分隔符 `-` 无法区分，反解必然出错（`deepseek-harness` 会被
 * 拆成 `deepseek\harness`）。这个坑已经踩过，见 sessionmove-smoke 的 B 组。
 *
 * 安全边界：
 *   - 只读扫描永不写盘；
 *   - 执行前把 workspace.json 与被移动的会话目录备份到回滚点；
 *   - 移动目录一律「复制 → 逐文件/字节校验 → 删源」，中途失败源还在；
 *   - 正在写入的会话（30 秒内有改动）拒绝搬动；
 *   - subagent 会话（origin=subagent / 有 parentSession）**不参与**任何修复判断：
 *     它们本来就该藏在组目录里，不该出现在侧边栏。把它们当「未分组」是误报。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/** 读 zstd 文件时只取头部这么多字节。会话日志是多帧拼接，第一帧就够放 header。 */
const HEADER_PROBE = 8192;
/** 会话目录在这么久之内被动过，认为还在写，拒绝搬动。 */
const QUIET_MS = 30 * 1000;
const SESSION_FILE_PREFIX = 'session.v4';

/**
 * 把工作区绝对路径编码成 sessions/ 下的组目录名。
 * 与 index.js 的 encodeWorkspaceGroup **必须逐字符一致**（有测试交叉断言）。
 */
export function encodeGroup(wsPath) {
  if (!wsPath || typeof wsPath !== 'string') return null;
  const body = wsPath.replace(/^[A-Za-z]:/, m => m[0])
    .replace(/[:\\/]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `--${body}--`;
}

/** 一个会话 id 的两种写法（登记表用 session-<uuid>，部分目录用裸 uuid）。 */
function idForms(id) {
  const bare = String(id || '').trim().replace(/^session-/, '');
  const s = new Set([bare]);
  if (!String(id || '').startsWith('session-')) s.add(`session-${bare}`);
  else s.add(String(id).trim());
  return s;
}

/** 裸 uuid ↔ session- 前缀，两边都要认。 */
function bareId(id) {
  return String(id || '').trim().replace(/^session-/, '');
}

/**
 * 名字相似度，只用来给「重新指向」排个序，绝不自动执行。
 * 场景：C:\dsh\base 改名成 C:\dsh\dw-base，旧组的会话 cwd 还指着 base。
 * 这条路径已经不存在，无法自动判定该归谁 —— 只能让用户看着候选点一下。
 */
function nameAffinity(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const tx = x.split('-').pop();
  const ty = y.split('-').pop();
  if (tx && tx === ty && tx.length > 2) return 0.5;
  return 0;
}
/** 读会话头（第一帧）。读不出来返回 null —— 调用方必须当成「未知」而不是「没问题」。 */
async function readSessionHeader(file) {
  let buf;
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const b = Buffer.alloc(HEADER_PROBE);
      const { bytesRead } = await fh.read(b, 0, HEADER_PROBE, 0);
      buf = b.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  let text;
  try {
    /* zstdDecompressSync 只解第一帧，正好就是我们想要的 header。 */
    text = zlib.zstdDecompressSync(buf).toString('utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.type === 'session') return o;
    } catch { /* 半行就跳过 */ }
  }
  return null;
}

async function dirSize(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      files++;
      try { bytes += (await fsp.stat(p)).size; } catch { /* 统计不到就少算，不致命 */ }
    }
  }
  return { files, bytes };
}

/** 目录最近一次被改动的时间（取目录本身与其中文件的最大 mtime）。 */
async function lastTouched(dir) {
  let max = 0;
  try { max = (await fsp.stat(dir)).mtimeMs; } catch { /* ignore */ }
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return max; }
  for (const e of entries) {
    try {
      const st = await fsp.stat(path.join(dir, e.name));
      if (st.mtimeMs > max) max = st.mtimeMs;
    } catch { /* ignore */ }
  }
  return max;
}

async function readWorkspaceDoc(dshHome) {
  const file = path.join(dshHome, 'storages', 'workspace.json');
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); }
  catch (e) {
    /* 文件不存在 ≠ 文件坏了。全新安装或刚清空数据时本来就没有这份登记，
       这是「还没任何工作区」的合法初始态，不是错误（旧版这里当成错误，
       新机器上体检会直接失败）。ENOENT 之外才是真故障。 */
    if (e && e.code === 'ENOENT') {
      return { ok: true, file, missing: true, doc: { unit: { name: 'workspace', version: 2 }, global: { initialized: false, defaultWorkspaceId: null, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } }, table: {} };
    }
    return { ok: false, file, error: `workspace.json 无法读取：${e.message}` };
  }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { return { ok: false, file, error: `workspace.json 无法解析：${e.message}` }; }
  if (!doc || typeof doc !== 'object') return { ok: false, file, error: 'workspace.json 内容不是对象' };
  if (!doc.tables) doc.tables = {};
  if (!doc.tables.workspaces) doc.tables.workspaces = {};
  if (!doc.global) doc.global = {};
  if (!Array.isArray(doc.global.workspaceIds)) doc.global.workspaceIds = Object.keys(doc.tables.workspaces);
  if (!Array.isArray(doc.global.archivedSessionIds)) doc.global.archivedSessionIds = [];
  return { ok: true, file, doc, table: doc.tables.workspaces };
}

/**
 * 全量扫描。只读，绝不写盘。
 * @returns {{ok:boolean, at:string, counts:object, findings:Array, actions:Array, summary:object, error?:string}}
 */
export async function doctorScan(opts = {}) {
  const dshHome = opts.dshHome || process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  const encode = typeof opts.encode === 'function' ? opts.encode : encodeGroup;
  const sessionsRoot = path.join(dshHome, 'sessions');

  const ws = await readWorkspaceDoc(dshHome);
  if (!ws.ok) return { ok: false, error: ws.error, at: new Date().toISOString(), findings: [], actions: [], counts: {}, summary: {} };
  const { doc, table } = ws;
  /* ws.missing 时表是空的，所有扫到的会话都会被当成「没有归属」。
     这仍然是有用信息（可以重建登记），但不能丢掉这个前提，否则
     用户会以为工作区真的全没了。下面 counts 里带出 workspaceFileMissing。 */

  /* ---------- 1. 工作区登记表 ---------- */
  const workspaces = Object.entries(table).map(([id, rec]) => ({
    id,
    path: rec && rec.path || '',
    title: rec && rec.title || '',
    sessionIds: Array.isArray(rec && rec.sessionIds) ? rec.sessionIds.slice() : [],
    pathExists: Boolean(rec && rec.path && fs.existsSync(rec.path)),
    group: encode(rec && rec.path || ''),
  }));
  const byPath = new Map();
  for (const w of workspaces) if (w.path) byPath.set(path.resolve(w.path).toLowerCase(), w);
  const byGroup = new Map();
  for (const w of workspaces) if (w.group) byGroup.set(w.group, w);

  /* 会话 id → 归属工作区（可能多个 = 重复登记） */
  const owners = new Map();
  for (const w of workspaces) {
    for (const sid of w.sessionIds) {
      const k = bareId(sid);
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(w);
    }
  }
  const archived = new Set((doc.global.archivedSessionIds || []).map(bareId));

  /* ---------- 2. 磁盘上的组目录与会话 ---------- */
  let groupNames = [];
  try {
    groupNames = (await fsp.readdir(sessionsRoot, { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch { /* sessions 不存在 → 下面全部为空，结论会显示 0 */ }

  const groups = [];
  const diskIds = new Set();
  const sessionIndex = []; // 每个会话目录一条

  for (const g of groupNames) {
    const gp = path.join(sessionsRoot, g);
    let entries = [];
    try { entries = await fsp.readdir(gp, { withFileTypes: true }); } catch { continue; }
    const rec = { name: g, dir: gp, workspace: byGroup.get(g) || null, sessions: [], subagents: 0, empty: false };
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(gp, ent.name);
      let files = [];
      try { files = await fsp.readdir(dir); } catch { continue; }
      const body = files.find(f => f.startsWith(SESSION_FILE_PREFIX)) || null;
      diskIds.add(bareId(ent.name));
      if (!body) {
        rec.sessions.push({ name: ent.name, dir, body: null, broken: true });
        sessionIndex.push({ name: ent.name, group: g, dir, body: null, broken: true, header: null, subagent: false });
        continue;
      }
      const header = await readSessionHeader(path.join(dir, body));
      const subagent = Boolean(header && (header.origin === 'subagent' || header.parentSession || Number(header.delegationDepth) > 0));
      const item = {
        name: ent.name,
        id: header && header.id ? header.id : ent.name,
        dir,
        group: g,
        body,
        header,
        cwd: header && header.cwd ? header.cwd : null,
        subagent,
        touchedAt: await lastTouched(dir),
      };
      if (subagent) rec.subagents++;
      else rec.sessions.push(item);
      sessionIndex.push({ ...item, broken: false });
    }
    rec.empty = rec.sessions.length === 0 && rec.subagents === 0;
    groups.push(rec);
  }

  /* ---------- 3. 逐条判定 ---------- */
  const findings = [];
  const actions = [];
  const push = (f, action) => {
    findings.push(f);
    if (action) { actions.push(action); f.actionId = action.id; }
  };

  /* ① 工作区路径已不存在（改名/移动/删除）—— 这是所有后续故障的源头。 */
  for (const w of workspaces) {
    if (w.pathExists) continue;
    push({
      code: 'workspace-path-missing',
      impact: 'blocking',
      severity: 'error',
      title: `工作区「${w.title || w.id}」的路径已不存在`,
      detail: `${w.path} 读不到。DSH 打开该工作区时会新建一个同路径的新登记，原来的 ${w.sessionIds.length} 个会话就会掉进「未分组」。`,
      evidence: { wsId: w.id, path: w.path, sessionCount: w.sessionIds.length },
      fixable: false,
    }, null);
  }

  /* ② 悬空引用：登记了但磁盘上没有目录。 */
  for (const w of workspaces) {
    const dead = w.sessionIds.filter(sid => !diskIds.has(bareId(sid)));
    if (!dead.length) continue;
    const id = `drop-dangling:${w.id}`;
    push({
      code: 'dangling-ref',
      impact: 'blocking',
      severity: 'error',
      title: `「${w.title || w.id}」登记了 ${dead.length} 个磁盘上不存在的会话`,
      detail: '侧边栏会显示这些条目，点进去是空白。清掉引用不影响任何正文文件。',
      evidence: { wsId: w.id, ids: dead },
      fixable: true,
    }, {
      id,
      kind: 'drop-ref',
      code: 'dangling-ref',
      safe: true,
      label: `清理「${w.title || w.id}」的 ${dead.length} 条悬空引用`,
      payload: { wsId: w.id, ids: dead },
    });
  }

  /* ③ 同一个会话被登记进多个工作区。 */
  for (const [sid, list] of owners) {
    if (list.length < 2) continue;
    const id = `dedupe:${sid}`;
    push({
      code: 'duplicate-ref',
      impact: 'advisory',
      severity: 'warn',
      title: `会话 ${sid} 被登记进 ${list.length} 个工作区`,
      detail: `分别属于：${list.map(w => w.title || w.id).join('、')}。通常来自「删掉工作区再加回来」。保留路径与实际目录一致的那个。`,
      evidence: { sessionId: sid, workspaces: list.map(w => ({ id: w.id, title: w.title, group: w.group })) },
      fixable: true,
    }, {
      id,
      kind: 'dedupe',
      code: 'duplicate-ref',
      safe: true,
      label: `会话 ${sid} 只保留一个归属`,
      payload: { sessionId: sid, wsIds: list.map(w => w.id) },
    });
  }

  /* ④ 幽灵组：sessions 下有这个组，但没有任何工作区对应它。 */
  for (const g of groups) {
    if (g.workspace) continue;
    const top = g.sessions.filter(s => !s.subagent && !s.broken);
    if (!top.length) continue;
    const liveCwd = top.filter(s => s.cwd && fs.existsSync(s.cwd));
    const unregistered = top.filter(s => !owners.has(bareId(s.name)) && !archived.has(bareId(s.name)));
    const recoverWs = liveCwd.length
      ? byPath.get(path.resolve(liveCwd[0].cwd).toLowerCase()) || null
      : null;

    if (recoverWs) {
      const ids = top.filter(s => !owners.has(bareId(s.name))).map(s => s.name);
      const id = `adopt-group:${g.name}`;
      push({
        code: 'orphan-group-recoverable',
        impact: 'advisory',
        severity: 'warn',
        title: `组 ${g.name} 下有 ${ids.length} 个会话可以归位到「${recoverWs.title}」`,
        detail: `这些会话的工作目录 ${liveCwd[0].cwd} 存在且已被工作区「${recoverWs.title}」登记，把正文目录搬过去并补登记即可恢复。`,
        evidence: { group: g.name, targetWs: recoverWs.id, ids },
        fixable: true,
      }, {
        id,
        kind: 'adopt-group',
        code: 'orphan-group-recoverable',
        safe: true,
        label: `把 ${ids.length} 个会话搬进「${recoverWs.title}」并补登记`,
        payload: { group: g.name, wsId: recoverWs.id, ids },
      });
      continue;
    }

    /* 路径还在但没登记 → 直接重建工作区登记（DSH 删过登记，目录还在）。 */
    if (liveCwd.length) {
      const live = liveCwd[0].cwd;
      const ids = top.map(s => s.name);
      const id = `create-ws:${g.name}`;
      push({
        code: 'orphan-group-recoverable',
        impact: 'advisory',
        severity: 'warn',
        title: `目录 ${live} 还在，但工作区登记丢了（${ids.length} 个会话）`,
        detail: 'DSH 在目录改名/重加工作区时会删掉旧登记。目录本身完好，重建一条登记就能让这些会话回到侧边栏。',
        evidence: { group: g.name, path: live, ids },
        fixable: true,
      }, {
        id,
        kind: 'create-workspace',
        code: 'orphan-group-recoverable',
        safe: false,
        label: `重建工作区「${path.basename(live)}」（${ids.length} 个会话）`,
        payload: { group: g.name, wsPath: live, ids },
      });
      continue;
    }

    /* 工作目录已经不存在 —— 这正好是「目录改名」的形状。
       不能自动判定该归谁（旧路径没任何线索指向新名字），但可以：
         ① 给出全部现存工作区作为候选，按名字相似度排序，让人点一下「改指到 X」；
         ② 同时保留「归档」选项，实在对不上时才用。
       把「重新指向」排在归档前面：改名重建是常见需求，归档是退路。 */
    if (unregistered.length) {
      const ids = unregistered.map(s => s.name);
      const deadCwd = top[0].cwd || null;
      const candidates = workspaces
        .filter(w => w.pathExists)
        .map(w => ({ wsId: w.id, title: w.title, path: w.path, score: nameAffinity(deadCwd, w.path) }))
        .sort((a, b) => b.score - a.score);

      if (candidates.length) {
        const id = `relocate:${g.name}`;
        push({
          code: 'orphan-group-relocatable',
          impact: 'advisory',
          severity: 'warn',
          title: `组 ${g.name} 的 ${ids.length} 个会话可改指到一个现存工作区`,
          detail: `这些会话原来的工作目录（${deadCwd || '未知'}）已不存在 —— 典型原因是目录被改名了。正文还在，选一个目标工作区，它们就搬过去并补登记。最像的是「${candidates[0].title}」。`,
          evidence: { group: g.name, deadCwd, ids, candidates },
          fixable: true,
        }, {
          id,
          kind: 'relocate-group',
          code: 'orphan-group-relocatable',
          safe: false, // 搬到哪个工作区必须人来选，猜错就把会话塞进错的地方
          label: `把 ${ids.length} 个会话改指到「${candidates[0].title}」（可改选）`,
          payload: { group: g.name, ids, candidates },
        });
      }

      const aid = `archive-orphan:${g.name}`;
      push({
        code: 'orphan-group-dead',
        impact: 'advisory',
        severity: 'info',
        title: `组 ${g.name} 的 ${ids.length} 个会话无法归位时，可以归档`,
        detail: `归档只是把它们从「未分组」里藏起来，正文一个字节都不动，日后还能取消归档。先试「改指到」，真对不上再归档。`,
        evidence: { group: g.name, cwd: deadCwd, ids },
        fixable: true,
      }, {
        id: aid,
        kind: 'archive',
        code: 'orphan-group-dead',
        safe: false,
        label: `归档 ${ids.length} 个无处可归的会话（只隐藏，不删正文）`,
        payload: { ids },
      });
    }
  }

  /* ⑤ 未登记、不归档、但所在组是有效工作区的会话 → 补登记。 */
  for (const s of sessionIndex) {
    if (s.broken || s.subagent) continue;
    const b = bareId(s.name);
    if (owners.has(b)) continue;
    if (archived.has(b)) continue;
    const g = groups.find(x => x.name === s.group);
    const target = g && g.workspace ? g.workspace : (s.cwd && fs.existsSync(s.cwd) ? byPath.get(path.resolve(s.cwd).toLowerCase()) : null);
    if (!target) continue; // 交给上面的幽灵组分支处理
    const id = `register:${s.name}`;
    push({
      code: 'unregistered-live',
      impact: 'blocking',
      severity: 'warn',
      title: `会话 ${s.name} 没登记进任何工作区`,
      detail: `它在组 ${s.group} 里，而该组对应工作区「${target.title || target.id}」。补一条登记即可，目录不需要搬。`,
      evidence: { sessionId: s.name, group: s.group, wsId: target.id },
      fixable: true,
    }, {
      id,
      kind: 'register',
      code: 'unregistered-live',
      safe: true,
      label: `把 ${s.name} 登记进「${target.title || target.id}」`,
      payload: { wsId: target.id, ids: [s.name] },
    });
  }

  /* ⑥ 组与归属不一致（正文在 A 组，登记在 B 工作区）→ 搬目录。 */
  for (const s of sessionIndex) {
    if (s.broken || s.subagent) continue;
    const list = owners.get(bareId(s.name));
    if (!list || list.length !== 1) continue;
    const w = list[0];
    if (!w.group || w.group === s.group) continue;
    const id = `move-dir:${s.name}`;
    push({
      code: 'group-mismatch',
      impact: 'blocking',
      severity: 'warn',
      title: `会话 ${s.name} 的正文目录与归属工作区不一致`,
      detail: `正文在 ${s.group}，但登记在「${w.title || w.id}」（应为 ${w.group}）。搬过去才在重启后仍能打开。`,
      evidence: { sessionId: s.name, from: s.group, to: w.group, wsId: w.id },
      fixable: true,
    }, {
      id,
      kind: 'move-dir',
      code: 'group-mismatch',
      safe: true,
      label: `搬 ${s.name} 的正文目录到 ${w.group}`,
      payload: { sessionId: s.name, fromGroup: s.group, toGroup: w.group },
    });
  }

  /* ⑦ 空组目录：留着会让侧边栏出现点进去什么都没有的工作区。 */
  for (const g of groups) {
    if (!g.empty) continue;
    const id = `rmdir:${g.name}`;
    push({
      code: 'empty-group',
      impact: 'advisory',
      severity: 'info',
      title: `空组目录 ${g.name}`,
      detail: '里面没有会话，只是一个空壳。删掉不影响任何数据。',
      evidence: { group: g.name },
      fixable: true,
    }, {
      id,
      kind: 'rmdir',
      code: 'empty-group',
      safe: true,
      label: `删除空组 ${g.name}`,
      payload: { group: g.name },
    });
  }

  /* ---------- 4. 分成「不能用」与「其余」 ----------
     设计目的（0.9.0）：synchub 的职责只是「别让会话用不了」。所以只有
     impact==='blocking' 的发现才算救援范围；其余（重复登记、空组、归档）
     一律降为 advisory，只报告不主动修 —— 那些交给专门的会话管理插件。
     判据：blocking = 「侧边栏点进去是空的 / 会话看不见了 / 工作区整个打不开」。 */
  const blocking = findings.filter(f => f.impact === 'blocking');
  const advisory = findings.filter(f => f.impact === 'advisory');
  const actionOf = id => actions.find(a => a.id === id) || null;
  const isSafeFor = f => Boolean(f.actionId && (actionOf(f.actionId) || {}).safe);
  /* 能一键搞定的「不能用」；剩下的要人给目标（改指/重建），或压根不可修。 */
  const rescueIds = blocking.filter(isSafeFor).map(f => f.actionId);
  const humanIds = [...new Set(blocking.filter(f => !isSafeFor(f)).map(f => f.code))];
  /* safe 但只影响整洁的——不并入救援，单独列出来。 */
  const miscIds = actions.filter(a => a.safe && rescueIds.indexOf(a.id) < 0).map(a => a.id);

  const summary = {
    error: findings.filter(f => f.severity === 'error').length,
    warn: findings.filter(f => f.severity === 'warn').length,
    info: findings.filter(f => f.severity === 'info').length,
    fixable: actions.filter(a => a.safe).length,
    needsChoice: actions.filter(a => !a.safe).length,
    total: findings.length,
    blocking: blocking.length,
    advisory: advisory.length,
    rescue: rescueIds.length,
    misc: miscIds.length,
    needsHuman: humanIds.length,
    /* ok=能用 / repairable=不能用但能一键修 / needs-human=不能用且要人给目标 */
    health: blocking.length === 0 ? 'ok' : (rescueIds.length ? 'repairable' : 'needs-human'),
  };

  return {
    ok: true,
    at: new Date().toISOString(),
    dshHome,
    sessionsRoot,
    counts: {
      workspaces: workspaces.length,
      groups: groups.length,
      sessionDirs: sessionIndex.length,
      topLevel: sessionIndex.filter(s => !s.subagent && !s.broken).length,
      subagent: sessionIndex.filter(s => s.subagent).length,
      broken: sessionIndex.filter(s => s.broken).length,
      registered: owners.size,
      archived: archived.size,
      workspaceFileMissing: Boolean(ws.missing),
      workspaceFile: ws.file,
    },
    findings,
    actions,
    /* 客户端只需看这两个字段：一键救援做什么、剩下多少要人管。 */
    rescue: { needed: rescueIds.length > 0, ids: rescueIds, humanCodes: humanIds },
    misc: { ids: miscIds, count: miscIds.length },
    summary,
  };
}

async function copyAndMove(srcDir, dstDir) {
  await fsp.mkdir(path.dirname(dstDir), { recursive: true });
  await fsp.cp(srcDir, dstDir, { recursive: true });
  const a = await dirSize(srcDir);
  const b = await dirSize(dstDir);
  if (a.files !== b.files || a.bytes !== b.bytes) {
    return { ok: false, error: `复制校验失败（源 ${a.files} 文件/${a.bytes}B，目标 ${b.files}/${b.bytes}B）；源目录已保留` };
  }
  await fsp.rm(srcDir, { recursive: true, force: true });
  return { ok: true, files: a.files, bytes: a.bytes };
}

/**
 * 执行修复。必须显式传 confirm:'REPAIR'。
 * @param {{dshHome?:string, backupRoot?:string, ids?:string[], confirm?:string, encode?:Function}} opts
 */
export async function doctorApply(opts = {}) {
  const confirm = opts.confirm;
  if (confirm !== 'REPAIR') {
    return { ok: false, error: "需要二次确认：请求体带 confirm:'REPAIR'（先跑 GET 扫描看会改什么）" };
  }
  const dshHome = opts.dshHome || process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  const encode = typeof opts.encode === 'function' ? opts.encode : encodeGroup;
  const backupRoot = opts.backupRoot || path.join(dshHome, 'dsh-synchub', 'backups');

  const scan = await doctorScan({ dshHome, encode });
  if (!scan.ok) return scan;

  /* 不传 ids = 一键救援：**只动「不能用」且 safe 的那些**。
     以前是「所有 safe 都干」（连空组目录、重复登记一起改），范围太宽。
     0.9.0 收窄：不传 ids 时只跑 scan.rescue.ids；想顺带搞整洁，显式传
     ids 把 scan.misc.ids 一起带上 —— 让「救急」与「打扫」是两个决定。 */
  const wanted = Array.isArray(opts.ids) && opts.ids.length
    ? new Set(opts.ids)
    : new Set(scan.rescue.ids);
  const chosen = scan.actions.filter(a => wanted.has(a.id));
  if (!chosen.length) {
    return {
      ok: false,
      error: scan.actions.length
        ? '当前没有可一键救援的「不能用」项（剩下的要么需要人给目标，要么只影响整洁）'
        : '没有需要处理的问题',
      health: scan.summary.health,
      available: scan.actions.map(a => a.id),
      misc: scan.misc.ids,
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, `doctor-${stamp}`);
  const result = { ok: true, at: new Date().toISOString(), backupDir, scope: 'rescue', applied: [], failed: [], skipped: [], wrote: [] };

  /* 回滚点：workspace.json 先落一份，任何动作前都有退路。
     文件本来不存在（全新安装）就记一笔 missing 而不是当成失败 ——
     那个状态本身就是「执行前什么也没有」，回滚就是删掉新生成的。 */
  const wsFile = path.join(dshHome, 'storages', 'workspace.json');
  let wsExistedBefore = false;
  try {
    await fsp.mkdir(path.join(backupDir, 'storages'), { recursive: true });
    if (fs.existsSync(wsFile)) {
      await fsp.copyFile(wsFile, path.join(backupDir, 'storages', 'workspace.json'));
      wsExistedBefore = true;
      result.wrote.push('storages/workspace.json');
    } else {
      result.wrote.push('storages/workspace.json（执行前不存在）');
    }
  } catch (e) {
    return { ok: false, error: `备份 workspace.json 失败，已中止（未改动任何东西）：${e.message}` };
  }
  result.workspaceExistedBefore = wsExistedBefore;

  const ws = await readWorkspaceDoc(dshHome);
  if (!ws.ok) return { ok: false, error: ws.error, backupDir };
  const { doc, table } = ws;
  let docDirty = false;

  const ensureIds = rec => {
    if (!Array.isArray(rec.sessionIds)) rec.sessionIds = [];
    return rec.sessionIds;
  };
  const touch = wsId => {
    const rec = table[wsId];
    if (rec) rec.updatedAt = new Date().toISOString();
  };

  for (const a of chosen) {
    try {
      if (a.kind === 'drop-ref') {
        const rec = table[a.payload.wsId];
        if (!rec) { result.skipped.push({ id: a.id, reason: '工作区已不存在' }); continue; }
        const dead = new Set(a.payload.ids.map(bareId));
        const before = ensureIds(rec).length;
        rec.sessionIds = rec.sessionIds.filter(s => !dead.has(bareId(s)));
        touch(a.payload.wsId);
        docDirty = true;
        result.applied.push({ id: a.id, kind: a.kind, removed: before - rec.sessionIds.length });
        continue;
      }

      if (a.kind === 'dedupe') {
        /* 保留「路径存在且与正文目录一致」的那一个，其余删掉。 */
        const sid = a.payload.sessionId;
        const diskGroup = (() => {
          for (const g of fs.readdirSync(path.join(dshHome, 'sessions'), { withFileTypes: true })) {
            if (!g.isDirectory()) continue;
            if (fs.existsSync(path.join(dshHome, 'sessions', g.name, sid))
              || fs.existsSync(path.join(dshHome, 'sessions', g.name, `session-${bareId(sid)}`))) return g.name;
          }
          return null;
        })();
        let keep = a.payload.wsIds.find(id => {
          const rec = table[id];
          if (!rec || !rec.path) return false;
          if (!fs.existsSync(rec.path)) return false;
          return !diskGroup || encode(rec.path) === diskGroup;
        });
        if (!keep) {
          keep = a.payload.wsIds.find(id => table[id] && fs.existsSync(table[id].path || '')) || a.payload.wsIds[0];
        }
        let dropped = 0;
        for (const id of a.payload.wsIds) {
          if (id === keep) continue;
          const rec = table[id];
          if (!rec) continue;
          const b = bareId(sid);
          const n = ensureIds(rec).length;
          rec.sessionIds = rec.sessionIds.filter(s => bareId(s) !== b);
          if (rec.sessionIds.length !== n) { dropped++; touch(id); docDirty = true; }
        }
        result.applied.push({ id: a.id, kind: a.kind, kept: keep, dropped });
        continue;
      }

      if (a.kind === 'register') {
        const rec = table[a.payload.wsId];
        if (!rec) { result.skipped.push({ id: a.id, reason: '工作区已不存在' }); continue; }
        const ids = ensureIds(rec);
        const have = new Set(ids.map(bareId));
        let added = 0;
        for (const sid of a.payload.ids) {
          if (have.has(bareId(sid))) continue;
          ids.push(sid.startsWith('session-') ? sid : `session-${bareId(sid)}`);
          have.add(bareId(sid));
          added++;
        }
        if (added) { touch(a.payload.wsId); docDirty = true; }
        result.applied.push({ id: a.id, kind: a.kind, added });
        continue;
      }

      if (a.kind === 'archive') {
        const list = doc.global.archivedSessionIds;
        const have = new Set(list.map(bareId));
        let added = 0;
        for (const sid of a.payload.ids) {
          const b = bareId(sid);
          if (have.has(b)) continue;
          list.push(sid.startsWith('session-') ? sid : `session-${b}`);
          have.add(b);
          added++;
        }
        if (added) docDirty = true;
        result.applied.push({ id: a.id, kind: a.kind, archived: added });
        continue;
      }

      if (a.kind === 'move-dir') {
        const src = path.join(dshHome, 'sessions', a.payload.fromGroup, a.payload.sessionId);
        const dst = path.join(dshHome, 'sessions', a.payload.toGroup, a.payload.sessionId);
        if (!fs.existsSync(src)) { result.skipped.push({ id: a.id, reason: '源目录已不存在' }); continue; }
        if (fs.existsSync(dst)) { result.skipped.push({ id: a.id, reason: '目标已存在同 id 目录，拒绝覆盖' }); continue; }
        const t = await lastTouched(src);
        if (Date.now() - t < QUIET_MS) { result.skipped.push({ id: a.id, reason: '会话仍在写入（30 秒内有改动）' }); continue; }
        const mv = await copyAndMove(src, dst);
        if (!mv.ok) { result.failed.push({ id: a.id, reason: mv.error }); continue; }
        result.applied.push({ id: a.id, kind: a.kind, files: mv.files, bytes: mv.bytes });
        continue;
      }

      if (a.kind === 'adopt-group' || a.kind === 'create-workspace' || a.kind === 'relocate-group') {
        /* relocate-group 必须由调用方指定目标：payload 里的 candidates 只是候选，
           猜错就会把会话塞进错的工作区，所以这里不默认选第一个。 */
        const targetWsId = a.kind === 'relocate-group'
          ? ((opts.targets && opts.targets[a.id]) || a.payload.wsId || null)
          : (a.kind === 'adopt-group' ? a.payload.wsId : null);
        if (a.kind === 'relocate-group' && !targetWsId) {
          result.skipped.push({ id: a.id, reason: '改指必须指定目标工作区：opts.targets[a.id] = <wsId>' });
          continue;
        }
        /* 先把正文目录搬进目标组，再补登记。搬失败就整条动作失败，不留半截。 */
        const rec = targetWsId ? table[targetWsId] : null;
        const wsPath = a.kind === 'create-workspace'
          ? a.payload.wsPath
          : (rec && rec.path ? rec.path : a.payload.wsPath);
        if (!wsPath) { result.skipped.push({ id: a.id, reason: '目标工作区路径为空' }); continue; }
        const targetGroup = encode(wsPath);
        const moved = [];
        let failed = null;
        for (const sid of a.payload.ids) {
          const src = path.join(dshHome, 'sessions', a.payload.group, sid);
          const dst = path.join(dshHome, 'sessions', targetGroup, sid);
          if (!fs.existsSync(src)) continue;
          if (targetGroup === a.payload.group) continue;
          const mv = await copyAndMove(src, dst);
          if (!mv.ok) { failed = `${sid}: ${mv.error}`; break; }
          moved.push(sid);
        }
        if (failed) {
          result.failed.push({ id: a.id, reason: `搬 ${failed} 失败，未改登记` });
          continue;
        }

        let wsId = targetWsId;
        if (!wsId) {
          wsId = crypto.randomUUID();
          const now = new Date().toISOString();
          table[wsId] = {
            path: wsPath,
            title: path.basename(wsPath) || wsPath,
            sessionIds: [],
            createdAt: now,
            updatedAt: now,
          };
          if (!doc.global.workspaceIds.includes(wsId)) doc.global.workspaceIds.push(wsId);
        }
        const ids = ensureIds(table[wsId]);
        const have = new Set(ids.map(bareId));
        let added = 0;
        for (const sid of a.payload.ids) {
          if (have.has(bareId(sid))) continue;
          ids.push(`session-${bareId(sid)}`);
          have.add(bareId(sid));
          added++;
        }
        touch(wsId);
        docDirty = true;
        result.applied.push({ id: a.id, kind: a.kind, wsId, moved: moved.length, added });
        continue;
      }

      if (a.kind === 'rmdir') {
        const dir = path.join(dshHome, 'sessions', a.payload.group);
        const left = fs.existsSync(dir) ? (await fsp.readdir(dir)).filter(n => !n.startsWith('.')) : [];
        if (left.length) { result.skipped.push({ id: a.id, reason: `目录里还有 ${left.length} 项，不删` }); continue; }
        await fsp.rm(dir, { recursive: true, force: true });
        result.applied.push({ id: a.id, kind: a.kind });
        continue;
      }

      result.skipped.push({ id: a.id, reason: `未知动作类型 ${a.kind}` });
    } catch (e) {
      result.failed.push({ id: a.id, reason: String(e.message || e) });
    }
  }

  if (docDirty) {
    try {
      await fsp.writeFile(ws.file, JSON.stringify(doc), 'utf8');
      result.wrote.push('storages/workspace.json');
    } catch (e) {
      return { ...result, ok: false, error: `写回 workspace.json 失败：${e.message}`, backupDir };
    }
  }

  /* 验收：重扫一遍，看「不能用」真的消失没有。
     注意判据变了（0.9.0）：以前是「非 info 的发现为 0」，那把重复登记/空组也算失败，
     但它们不影响使用，救急本来就不该去动。现在只看 blocking 是否归零。 */
  try {
    const after = await doctorScan({ dshHome, encode });
    const beforeBlocking = scan.summary.blocking;
    const afterBlocking = after.summary.blocking;
    result.verify = {
      ok: after.ok && afterBlocking === 0,
      before: scan.summary,
      after: after.summary,
      blockingBefore: beforeBlocking,
      blockingAfter: afterBlocking,
      fixed: Math.max(0, beforeBlocking - afterBlocking),
      remaining: (after.findings || [])
        .filter(f => f.impact === 'blocking')
        .map(f => ({ code: f.code, title: f.title })),
      /* 剩下的整洁项不算失败，但要如实报出来，不能让人以为全干净了。 */
      advisoryLeft: (after.findings || [])
        .filter(f => f.impact !== 'blocking')
        .map(f => f.code),
    };
  } catch (e) {
    result.verify = { ok: false, error: `复查失败：${e.message}` };
  }

  result.note = '只动了会影响「能不能打开」的部分。workspace.json 已改，侧边栏要等 DSH 重启（或重新载入窗口）后才按新归属显示；会话正文是即时生效的。';
  return result;
}
