/**
 * dsh-synchub · 记忆地图（只读枚举）
 *
 * 目的：把 DSH 的「记忆」讲清楚 —— 它不是一个文件，而是几层：
 *   ① 记忆文件（本插件写入）  <workspace>/memory/ 与 ~/.dsh/memory/USER.md
 *   ② 用户全局规则            ~/.dsh/AGENTS.md → ~/.agents/AGENTS.md
 *   ③ 项目规则                <项目根>→会话 cwd 每层的 AGENTS.md/CLAUDE.md + *.local.md
 *   ④ 技能                    <项目根>/.dsh/skills、<项目根>/.agents/skills、~/.dsh/skills、~/.agents/skills
 *   ⑤ 会话日志                ~/.dsh/sessions/**
 *
 * 只读：不写盘、不删、不总结。任何一层的枚举失败都按「不存在」处理，
 * 不让整张表崩 —— 全新安装时多数层本来就是空的，那是正常态，不是错误。
 *
 * 同步状态（sync）三种：
 *   synchub       已在某个同步面里（sessions / storages / skills / agentInstructions）
 *   workspace-git 归工作区自己的 git 管，synchub 刻意不碰
 *   none          不同步（预留位、本地覆盖等）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MEMORY_DIR = 'memory';
export const USER_MEMORY_FILE = path.join('memory', 'USER.md');

const BASE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];
const LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'];

export function resolveAgentsHome() {
  return process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents');
}

function dshHomeOf(opts) {
  return opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

async function statOf(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

async function readWorkspaces(dshHome) {
  const file = path.join(dshHome, 'storages', 'workspace.json');
  let doc;
  try { doc = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return []; }   // 全新安装没有这个文件：正常态
  const wss = (doc && doc.tables && doc.tables.workspaces) || {};
  return Object.entries(wss)
    .map(([id, w]) => ({
      id,
      title: w.title || '',
      path: w.path || '',
      sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
      sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.slice() : [],
    }))
    .filter(w => w.path);
}

/** 向上找最近含 .git 的目录；没有返回 null（DSH 的项目根规则）。 */
function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 项目根到 target 的链（含两端）。target 不在 root 内时只返回 target 自身。 */
function chainFromRoot(root, target) {
  if (!isInside(root, target)) return [path.resolve(target)];
  const out = [];
  let dir = path.resolve(target);
  for (;;) {
    out.unshift(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

async function countSkillEntries(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  return entries.filter(e => e.isDirectory() || e.name.toLowerCase().endsWith('.md')).length;
}

function row(layer, absPath, opts) {
  const st = opts.stat || null;
  return {
    layer,
    path: absPath,
    label: opts.label || path.basename(absPath),
    rel: opts.rel || '',
    size: st && st.isFile() ? st.size : 0,
    files: opts.files == null ? (st && st.isFile() ? 1 : 0) : opts.files,
    exists: opts.exists != null ? opts.exists : Boolean(st),
    sync: opts.sync || 'none',
    workspace: opts.workspace || '',
    note: opts.note || '',
  };
}

/**
 * 枚举记忆地图。
 * @param opts.dshHome 覆盖 DSH_HOME（测试用）
 * @returns 分层清单；永远 resolve，不抛（每层内部自己兜住）。
 */
export async function memoryMap(opts = {}) {
  const dshHome = dshHomeOf(opts);
  const agentsHome = resolveAgentsHome();
  const workspaces = await readWorkspaces(dshHome);

  /* ① 记忆文件（本插件的落点，阶段②起会写入；这里只如实报存在与否） */
  const memoryRows = [];
  const userMemoryAbs = path.join(dshHome, USER_MEMORY_FILE);
  memoryRows.push(row('memory', userMemoryAbs, {
    rel: USER_MEMORY_FILE, label: '用户级记忆', sync: 'synchub',
    stat: await statOf(userMemoryAbs), note: '所有工作区共享',
  }));
  for (const ws of workspaces) {
    const dir = path.join(ws.path, MEMORY_DIR);
    const st = await statOf(dir);
    memoryRows.push(row('memory', dir, {
      rel: `${MEMORY_DIR}/`, label: ws.title || ws.path, sync: 'synchub',
      stat: st, workspace: ws.title || ws.path,
      files: st && st.isDirectory() ? (await fsp.readdir(dir).catch(() => [])).length : 0,
      note: st && st.isDirectory() ? '' : '尚未创建（归档时自动建）',
    }));
  }

  /* ② 用户全局规则 */
  const userRows = [];
  {
    const a = path.join(dshHome, 'AGENTS.md');
    userRows.push(row('user-instructions', a, {
      rel: 'AGENTS.md', label: 'DSH 全局规则', sync: 'synchub',
      stat: await statOf(a), note: 'agentInstructions 同步面',
    }));
    const b = path.join(agentsHome, 'AGENTS.md');
    userRows.push(row('user-instructions', b, {
      rel: '~/.agents/AGENTS.md', label: '共享 agent 规则（预留位）', sync: 'none',
      stat: await statOf(b), note: '本机通常没有；有则与上一行同组注入',
    }));
  }

  /* ③ 项目规则 + ④ 技能（按工作区） */
  const projectRows = [];
  const skillRows = [];
  for (const ws of workspaces) {
    const root = findProjectRoot(ws.path) || path.resolve(ws.path);
    ws.projectRoot = root;
    const chain = chainFromRoot(root, ws.path);
    for (const dir of chain) {
      for (const name of BASE_CANDIDATES.concat(LOCAL_CANDIDATES)) {
        const file = path.join(dir, name);
        const st = await statOf(file);
        if (!st || !st.isFile()) continue;
        projectRows.push(row('project-instructions', file, {
          rel: path.relative(root, file),
          label: (ws.title || ws.path) + (name.includes('.local.') ? ' · 本地' : ''),
          sync: 'workspace-git',
          stat: st, workspace: ws.title || ws.path,
          note: name.includes('.local.') ? '本地覆盖，通常不进 git' : '随工作区 git',
        }));
      }
    }
    for (const sub of [path.join('.dsh', 'skills'), path.join('.agents', 'skills')]) {
      const dir = path.join(root, sub);
      const n = await countSkillEntries(dir);
      if (n === null) continue;
      skillRows.push(row('skills', dir, {
        rel: path.join(path.relative(dshHome, root) || '.', sub),
        label: (ws.title || ws.path) + ' · 项目技能', sync: 'workspace-git',
        files: n, exists: true, workspace: ws.title || ws.path,
        note: n ? '' : '空目录',
      }));
    }
  }

  /* ④ 用户级技能 */
  for (const [dir, label, sync] of [
    [path.join(dshHome, 'skills'), '用户技能（~/.dsh/skills）', 'synchub'],
    [path.join(agentsHome, 'skills'), '用户技能（~/.agents/skills）', 'none'],
  ]) {
    const n = await countSkillEntries(dir);
    if (n === null) continue;
    skillRows.push(row('skills', dir, {
      rel: path.relative(dshHome, dir), label, sync, files: n, exists: true,
      note: n ? '' : '空目录',
    }));
  }

  /* ⑤ 会话日志：只数目录，不递归大小（几十 MB 的遍历不该放在打开面板时） */
  let sessionDirs = 0;
  let sessionGroups = 0;
  const sessionsRoot = path.join(dshHome, 'sessions');
  {
    const groups = await fsp.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
    for (const g of groups) {
      if (!g.isDirectory()) continue;
      sessionGroups += 1;
      const inner = await fsp.readdir(path.join(sessionsRoot, g.name), { withFileTypes: true }).catch(() => []);
      sessionDirs += inner.filter(x => x.isDirectory()).length;
    }
  }
  const sessionRows = [row('sessions', sessionsRoot, {
    rel: 'sessions/', label: '会话日志', sync: 'synchub',
    files: sessionDirs, exists: sessionGroups > 0,
    note: `${sessionGroups} 个工作区分组 · ${sessionDirs} 个会话目录（不解压、只数目录）`,
  })];

  const layers = [
    { id: 'memory', label: '记忆文件（本插件写入）', rows: memoryRows },
    { id: 'user-instructions', label: '用户全局规则', rows: userRows },
    { id: 'project-instructions', label: '项目规则（AGENTS.md / CLAUDE.md）', rows: projectRows },
    { id: 'skills', label: '技能', rows: skillRows },
    { id: 'sessions', label: '会话日志', rows: sessionRows },
  ];

  const all = layers.flatMap(l => l.rows);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    dshHome,
    agentsHome,
    workspaces,
    layers,
    counts: {
      files: all.reduce((n, r) => n + (r.files || 0), 0),
      bytes: all.reduce((n, r) => n + (r.size || 0), 0),
      workspaces: workspaces.length,
    },
  };
}

/* ======================== 阶段②：归档读会话 / 写记忆 ========================

  会话正文是 zstd 多帧压缩 JSONL（ADR-004 §4.1）。单次 zstdDecompressSync 只解第一帧
  （实测 162 帧只出 196 字节），必须逐帧扫边界再逐帧解。 */

import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

export function encodeWorkspaceGroup(wsPath) {
  if (!wsPath || typeof wsPath !== 'string') return null;
  const body = wsPath.replace(/^[A-Za-z]:/, m => m[0])
    .replace(/[:\\/]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `--${body}--`;
}

/** 逐帧解压；扫不出完整帧时返回已解出的部分（损坏会话不至于全丢）。 */
function decodeZstdFrames(buf) {
  const parts = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) break;
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buf.length) break;
    const descriptor = buf.readUInt8(offset); offset += 1;
    if ((descriptor & 0x18) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buf.length - offset < 3) {
        return parts.length ? Buffer.concat(parts) : null;
      }
      const blockHeader = buf.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) return parts.length ? Buffer.concat(parts) : null;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return parts.length ? Buffer.concat(parts) : null;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - offset < 4) break;
      offset += 4;
    }
    parts.push(zstdDecompressSync(buf.subarray(start, offset)));
  }
  return parts.length ? Buffer.concat(parts) : null;
}

async function findSessionFile(dshHome, sessionId) {
  const root = path.join(dshHome, 'sessions');
  let groups;
  try { groups = await fsp.readdir(root, { withFileTypes: true }); } catch { return null; }
  const bare = String(sessionId).replace(/^session-/, '');
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    for (const name of [sessionId, `session-${bare}`]) {
      const f = path.join(root, g.name, name, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

/** 读会话的 user/assistant 文本（滤掉 system-reminder 注入）。
 *  失败一律返回 {ok:false,error}，不抛 —— 归档路径上不能让总结失败影响归档。 */
export async function readSessionTranscript(dshHome, sessionId) {
  const file = await findSessionFile(dshHome, sessionId);
  if (!file) return { ok: false, error: '找不到会话正文（未同步到本机或已删除）' };
  let buf;
  try { buf = await fsp.readFile(file); } catch (e) { return { ok: false, error: `读取失败：${e.message}` }; }
  const plain = decodeZstdFrames(buf);
  if (!plain) return { ok: false, error: '会话正文无法解压（可能已损坏）' };
  const messages = [];
  for (const line of plain.toString('utf8').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user/message' && o.type !== 'assistant/message') continue;
    const text = ((o.data && o.data.content) || []).map(c => c.text || '').join('').trim();
    if (!text || text.startsWith('<system-reminder>')) continue;
    messages.push({ role: o.type === 'user/message' ? 'user' : 'assistant', seq: o.seq, text: text.slice(0, 4000) });
  }
  if (!messages.length) return { ok: false, error: '会话里没有可用的对话文本' };
  return { ok: true, file, messages, chars: messages.reduce((n, m) => n + m.text.length, 0) };
}

/** 归档计划：定位会话所属工作区与记忆落点（权威来源 = workspace.json）。 */
export async function archivePlan(dshHome, sessionId) {
  const wss = await readWorkspaces(dshHome);
  const bare = String(sessionId).replace(/^session-/, '');
  const forms = new Set([String(sessionId), `session-${bare}`]);
  const hit = wss.find(w => (w.sessionIds || []).some(s => forms.has(String(s))));
  if (!hit) return { ok: false, error: '该会话未登记到任何工作区（未分组），无法确定记忆落点' };
  const memoryDir = path.join(hit.path, MEMORY_DIR);
  return {
    ok: true,
    workspaceId: hit.id,
    title: hit.title || hit.path,
    workspacePath: hit.path,
    memoryDir,
    file: path.join(memoryDir, 'PROJECT.md'),
    userFile: path.join(dshHome, USER_MEMORY_FILE),
  };
}

/** 追加记忆：目标已存在则先备份，再追加（不覆盖已有内容）。 */
export async function appendMemory(absPath, block) {
  if (!absPath) return { ok: false, error: '缺少落点' };
  const prev = fs.existsSync(absPath) ? await fsp.readFile(absPath, 'utf8') : '';
  if (prev) {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.copyFile(absPath, `${absPath}.bak-${Date.now()}`);
  }
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const sep = prev ? (prev.endsWith('\n') ? '' : '\n\n') : '';
  await fsp.writeFile(absPath, prev + sep + block.trim() + '\n', 'utf8');
  return { ok: true, bytes: Buffer.byteLength(block, 'utf8'), existed: Boolean(prev) };
}

/** 覆盖式写回（整理用）：先备份已有文件，再整文件覆盖。 */
export async function writeMemoryFile(absPath, content) {
  if (!absPath) return { ok: false, error: '缺少落点' };
  const prev = fs.existsSync(absPath) ? await fsp.readFile(absPath, 'utf8') : '';
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  if (prev) await fsp.copyFile(absPath, `${absPath}.bak-${Date.now()}`);
  const text = String(content || '').trim() + '\n';
  await fsp.writeFile(absPath, text, 'utf8');
  return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), existed: Boolean(prev), unchanged: prev === text };
}

/** 取某工作区最近 n 个会话的文本（整理时的输入）。 */
export async function recentWorkspaceTranscript(dshHome, workspace, limit = 5) {
  const ids = Array.isArray(workspace && workspace.sessionIds) ? workspace.sessionIds.slice(-limit) : [];
  const out = [];
  for (const sid of ids) {
    const t = await readSessionTranscript(dshHome, sid);
    if (t.ok) out.push({ sessionId: sid, messages: t.messages });
  }
  return out;
}

export const __test = { memoryMap, writeMemoryFile, recentWorkspaceTranscript, resolveAgentsHome, findProjectRoot, chainFromRoot, readSessionTranscript, archivePlan, appendMemory, encodeWorkspaceGroup };
