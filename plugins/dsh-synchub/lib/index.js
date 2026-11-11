/**
 * dsh-synchub · 宿主半
 *
 * 只做三件事，绝不自己实现同步逻辑：
 *   1) 汇总状态：工作区 Git 仓库的 ahead/behind/dirty + 本机插件版本 vs npm latest；
 *      chatsync / dsh-config-manager 的状态由浏览器半直接 fetch 它们各自的只读接口。
 *   2) 转发动作：把「一键同步」转发到各插件既有接口；工作区仓库只做 pull/push。
 *   3) 心跳信标：在用户自己的工作区仓库里写 sync-beacon/<machine>.json，
 *      让另一台机器能看出「这边的插件/DSH 版本是不是旧的」。
 *
 * 边界：不直写 $DSH_HOME 配置、不持有凭据、不读密钥文件、不连私有同步仓库。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const name = 'dsh-synchub';
const inject = ['webServer'];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 找到宿主 profile 目录：从本文件所在目录往上走，遇到 node_modules 就取它的父目录。
 *  装到 <profile>/node_modules/dsh-synchub/lib/ 时，node_modules 的父目录正是 profile。
 *  这样不依赖 DSH_PROFILE 环境变量，两台机器路径不同也能正确工作。 */
function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    if (path.basename(dir).toLowerCase() === 'node_modules') return path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop');
}
const PROFILE_DIR = resolveProfileDir();
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-synchub', 'config.json');

const DEFAULTS = {
  workspace: 'C:\\dsh\\workspace1',
  staleHours: 24,
  beacon: true,
  machine: os.hostname(),
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

function json(res, code, body) {
  res.writeHead(code, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new Error('request too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function log(ctx, level, msg) {
  try {
    const l = ctx.logger;
    if (typeof l === 'function') return l(`[dsh-synchub] ${msg}`);
    if (l && typeof l[level] === 'function') return l[level](`[dsh-synchub] ${msg}`);
  } catch { /* fall through */ }
  if (level === 'error') console.error(`[dsh-synchub] ${msg}`);
}

async function readConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    const v = JSON.parse(raw);
    return { ...DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
  } catch (e) {
    if (e.code !== 'ENOENT') log({ logger: null }, 'warn', `config unreadable: ${e.message}`);
    return { ...DEFAULTS };
  }
}

async function writeConfig(patch) {
  const next = { ...(await readConfig()), ...patch };
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 只接受同源 / 非跨站请求，与 chatsync 的 guard 同口径。 */
function guard(req) {
  const h = req.headers || {};
  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 'cross-site';
  if (h.origin && h.origin !== 'null') {
    try {
      const u = new URL(h.origin);
      if (/^https?:$/.test(u.protocol) && h.host && u.host.toLowerCase() !== String(h.host).toLowerCase()) return 'cross-origin';
    } catch { return 'invalid-origin'; }
  }
  if (req.method && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const hasBody = Number(h['content-length'] || 0) > 0 || Boolean(h['transfer-encoding']);
    if (hasBody && !/^application\/json\s*(?:;|$)/i.test(String(h['content-type'] || ''))) return 'content-type';
  }
  return null;
}

async function git(cwd, args, timeout = 15000) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, out: String(stdout || '').trim() };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message || '').trim(), code: e.code };
  }
}

/** 工作区 Git 仓库状态（只读）。 */
async function workspaceStatus(cfg) {
  const root = cfg.workspace;
  const base = { root, configured: false, error: null, branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, lastCommitAt: null, lastCommit: null, remote: null };
  if (!root || !fs.existsSync(path.join(root, '.git'))) {
    return { ...base, error: 'not-a-git-repo' };
  }
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok) return { ...base, error: branch.out || 'git-rev-parse-failed' };
  base.configured = true;
  base.branch = branch.out;

  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream.ok) {
    base.upstream = upstream.out;
    const counts = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    if (counts.ok) {
      const m = /^(\d+)\s+(\d+)/.exec(counts.out);
      if (m) { base.ahead = Number(m[1]); base.behind = Number(m[2]); }
    }
  }
  const remote = await git(root, ['remote', 'get-url', 'origin']);
  base.remote = remote.ok ? remote.out : null;

  const dirty = await git(root, ['status', '--porcelain', '-uno']);
  if (dirty.ok) base.dirty = dirty.out ? dirty.out.split('\n').filter(Boolean).length : 0;

  const last = await git(root, ['log', '-1', '--format=%cI%x09%s']);
  if (last.ok && last.out) {
    const [at, ...rest] = last.out.split('\t');
    base.lastCommitAt = at || null;
    base.lastCommit = rest.join('\t') || null;
  }
  return base;
}

/** 本机已装插件版本（只读 node_modules 里的 package.json）。 */
function localVersions() {
  const out = {};
  for (const pkg of ['chatsync', 'dsh-config-manager', 'dsh-synchub', 'dshmarket']) {
    try {
      const p = path.join(PROFILE_DIR, 'node_modules', pkg, 'package.json');
      out[pkg] = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    } catch { out[pkg] = null; }
  }
  out.dsh = process.env.DSH_VERSION || null;
  return out;
}

let versionCache = { at: 0, data: null };
async function npmLatest(pkg) {
  try {
    const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.version === 'string' ? j.version : null;
  } catch { return null; }
}

function newer(latest, current) {
  const p = v => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || ''));
  const a = p(latest), b = p(current);
  if (!a || !b || a[4]) return false;
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  return Boolean(b[4]);
}

async function versions() {
  if (versionCache.data && Date.now() - versionCache.at < 30 * 60 * 1000) return versionCache.data;
  const local = localVersions();
  const pkgs = ['chatsync', 'dsh-config-manager', 'dshmarket'];
  const latest = {};
  await Promise.all(pkgs.map(async p => { latest[p] = await npmLatest(p); }));
  const outdated = {};
  for (const p of pkgs) outdated[p] = Boolean(latest[p] && local[p] && newer(latest[p], local[p]));
  const data = { local, latest, outdated, checkedAt: new Date().toISOString() };
  versionCache = { at: Date.now(), data };
  return data;
}

/** 读工作区仓库里所有机器留下的信标（只读）。 */
async function readBeacons(cfg) {
  const dir = path.join(cfg.workspace, 'sync-beacon');
  const out = { dir, machines: [], error: null };
  if (!cfg.beacon) return { ...out, error: 'disabled' };
  if (!fs.existsSync(dir)) return { ...out, error: 'no-beacon-dir' };
  try {
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const v = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
        if (v && typeof v === 'object') out.machines.push(v);
      } catch { /* skip broken beacon */ }
    }
  } catch (e) { out.error = e.message; }
  return out;
}

/** 写本机信标（只在用户显式发起同步后调用）。 */
async function writeBeacon(cfg, versionsData) {
  if (!cfg.beacon) return { ok: false, reason: 'disabled' };
  const dir = path.join(cfg.workspace, 'sync-beacon');
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(cfg.machine || os.hostname()).replace(/[^A-Za-z0-9_.-]/g, '_');
  const file = path.join(dir, `${safe}.json`);
  const payload = {
    machine: cfg.machine || os.hostname(),
    at: new Date().toISOString(),
    dsh: versionsData.local.dsh || null,
    plugins: versionsData.local,
  };
  await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  const add = await git(cfg.workspace, ['add', '--', 'sync-beacon/' + safe + '.json']);
  if (!add.ok) return { ok: false, reason: add.out };
  const commit = await git(cfg.workspace, ['commit', '-m', `sync-beacon: ${payload.machine} @ ${payload.at}`]);
  // 没有新变化时 commit 会失败，这不是错误
  return { ok: true, committed: commit.ok, file, payload };
}

function apply(ctx) {
  const routes = [
    {
      kind: 'exact', path: '/api/dsh-synchub/config', handler: async (req, res) => {
        try {
          if (req.method === 'PUT') return json(res, 200, { ok: true, config: await writeConfig(await readBody(req)) });
          return json(res, 200, { ok: true, config: await readConfig() });
        } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact', path: '/api/dsh-synchub/status', handler: async (_req, res) => {
        try {
          const cfg = await readConfig();
          const [workspace, vers, beacons] = await Promise.all([
            workspaceStatus(cfg), versions(), readBeacons(cfg),
          ]);
          return json(res, 200, { ok: true, machine: cfg.machine, staleHours: cfg.staleHours, workspace, versions: vers, beacons });
        } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact', path: '/api/dsh-synchub/workspace/pull', handler: async (_req, res) => {
        const cfg = await readConfig();
        if (!cfg.workspace || !fs.existsSync(path.join(cfg.workspace, '.git'))) return json(res, 400, { ok: false, error: '工作区不是 Git 仓库' });
        const r = await git(cfg.workspace, ['pull', '--ff-only'], 60000);
        return json(res, 200, { ok: r.ok, output: r.out });
      },
    },
    {
      kind: 'exact', path: '/api/dsh-synchub/workspace/push', handler: async (_req, res) => {
        const cfg = await readConfig();
        if (!cfg.workspace || !fs.existsSync(path.join(cfg.workspace, '.git'))) return json(res, 400, { ok: false, error: '工作区不是 Git 仓库' });
        const r = await git(cfg.workspace, ['push'], 60000);
        return json(res, 200, { ok: r.ok, output: r.out });
      },
    },
    {
      kind: 'exact', path: '/api/dsh-synchub/beacon', handler: async (_req, res) => {
        try {
          const cfg = await readConfig();
          const result = await writeBeacon(cfg, await versions());
          return json(res, 200, { ok: result.ok, ...result });
        } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
  ];

  const disposers = [];
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    for (const route of routes) {
      disposers.push(ctx.webServer.register({
        ...route,
        handler: (req, res) => {
          const reason = guard(req);
          if (reason) return json(res, 403, { ok: false, error: `请求来源不被接受（${reason}）` });
          return route.handler(req, res);
        },
      }));
    }
    log(ctx, 'info', `registered ${routes.length} routes`);
  } else {
    log(ctx, 'warn', 'webServer 不可用：状态接口未注册');
  }
  ctx.effect(() => { for (const d of disposers) { try { d?.(); } catch { /* noop */ } } });
}

export { name, inject, apply };
