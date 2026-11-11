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

// —— 模块级诊断：证明「本模块到底有没有被宿主 import」——
// 与 apply() 里的诊断配合，可区分两种失败：
//   只有 module 行 → 模块进来了但 apply 没被调用；
//   两行都有       → 插件正常加载（问题在路由层）；
//   一行都没有     → 模块根本没被 import（bundle 没展开）。
try {
  const dir = path.join(os.homedir(), '.dsh', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'dsh-synchub-boot.log'),
    JSON.stringify({ at: new Date().toISOString(), phase: 'module', pid: process.pid }) + '\n',
  );
} catch { /* 诊断本身绝不影响加载 */ }

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

/** 只接受已知键，防止把任意内容写进配置（只读预检也走这里）。 */
function sanitizeConfig(raw) {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(raw, 'workspace') && typeof raw.workspace === 'string') out.workspace = raw.workspace.trim();
  if (Object.prototype.hasOwnProperty.call(raw, 'staleHours') && Number.isFinite(Number(raw.staleHours))) {
    out.staleHours = Math.min(720, Math.max(1, Math.trunc(Number(raw.staleHours))));
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'beacon') && typeof raw.beacon === 'boolean') out.beacon = raw.beacon;
  if (Object.prototype.hasOwnProperty.call(raw, 'machine') && typeof raw.machine === 'string') {
    out.machine = raw.machine.trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  }
  return out;
}

async function writeConfig(patch) {
  const next = { ...(await readConfig()), ...sanitizeConfig(patch) };
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 读 chatsync 的落盘配置（$DSH_HOME/dsh-sync.json）。
 * 只看两件事：有没有连私有仓库、是否仍靠「首次同步自动建仓」。
 * 不调用 chatsync 的接口 —— 自检必须是只读快照，不能触发同步副作用。
 */
async function readChatsyncChannel() {
  const file = path.join(DSH_HOME, 'dsh-sync.json');
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    return { remote: typeof raw.remote === 'string' ? raw.remote : '', autoRepo: raw.autoRepo !== false };
  } catch {
    return { remote: '', autoRepo: true };
  }
}

/**
 * 读 config-manager 的活动同步通道（$DSH_HOME/dsh-config-manager/sync-profiles/<profile>/sync-config.json）。
 * 各通道地址分散在 git.repoUrl / webdav.url / s3.* / gist.* 下，这里只提炼「配没配 + 哪个通道 + 地址」。
 */
async function readConfigManagerChannel() {
  const profile = path.basename(PROFILE_DIR) || 'desktop';
  const file = path.join(DSH_HOME, 'dsh-config-manager', 'sync-profiles', profile, 'sync-config.json');
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    const transport = typeof raw.transport === 'string' ? raw.transport : '';
    const where =
      (raw.git && raw.git.repoUrl) ||
      (raw.webdav && raw.webdav.url) ||
      (raw.s3 && (raw.s3.endpoint || raw.s3.bucket)) ||
      (raw.gist && (raw.gist.gistId || raw.gist.id)) ||
      '';
    return { configured: Boolean(transport && where), transport, where: String(where || '') };
  } catch {
    return { configured: false, transport: '', where: '' };
  }
}

/** 只读预检：逐项说清楚「能不能用」，不写任何东西。 */
async function checkConfig(raw) {
  const cfg = { ...DEFAULTS, ...sanitizeConfig(raw) };
  const checks = [];
  const push = (id, ok, detail) => checks.push({ id, ok, detail });
  // —— 两条跨机通道的真实配置（只读落盘文件，不调用对方接口） ——
  const chatsync = await readChatsyncChannel();
  const configManager = await readConfigManagerChannel();
  push('configFile', true, CONFIG_FILE);
  push('machine', Boolean(cfg.machine), `机器名 = ${cfg.machine || '(空)'}（两台必须不同，否则信标互相覆盖）`);
  push('dshHome', fs.existsSync(DSH_HOME), `${DSH_HOME} ${fs.existsSync(DSH_HOME) ? '存在' : '不存在'}`);
  const root = cfg.workspace;
  const isDir = root ? fs.existsSync(root) : false;
  push('workspaceDir', isDir, `${root || '(空)'} ${isDir ? '存在' : '不存在'}`);
  const isRepo = isDir && fs.existsSync(path.join(root, '.git'));
  push('workspaceGit', isRepo, isRepo ? '是 Git 仓库' : '不是 Git 仓库（拉取/推送/信标不可用）');
  if (isRepo) {
    const remote = await git(root, ['remote', 'get-url', 'origin']);
    // 没有 origin 并不等于「无法跨机同步」：chatsync 用自己独立的影子仓库
    // （gitdir + tree）承载工作区内容，推到私有仓库的 ws/<id> 分支，不读写工作区的 .git。
    // 所以这里只在有 origin 时校验它是否可用，没 origin 就降级为提示而非失败，
    // 真正的跨机通道由下面的 chatsync 自检项负责。
    if (remote.ok) {
      push('workspaceRemote', true, `origin = ${remote.out}`);
    } else {
      push('workspaceRemote', true, '无 origin（正常：工作区内容由 chatsync 经 ws/<id> 分支同步，不依赖工作区自身远端）');
    }
  } else push('workspaceRemote', false, '跳过（工作区不是 Git 仓库）');
  // 仓库根目录的插件清单
  const repoRoot = path.join(DSH_HOME, '..', 'dsh-plugins');
  const listPath = path.join('C:\\dsh', 'dsh-plugins', 'list.json');
  push('pluginList', fs.existsSync(listPath), listPath);
  push('profileDir', fs.existsSync(path.join(PROFILE_DIR, 'package.json')), PROFILE_DIR);

  // —— 真正的跨机通道自检：直接读 chatsync / config-manager 的落盘配置 ——
  // 之前只看工作区有没有 origin，但那个跟跨机无关；能同步与否由这两条通道决定。
  push('chatsyncChannel', chatsync.remote !== '', chatsync.remote !== ''
    ? `私有仓库 = ${chatsync.remote}（工作区经 ws/<id> 分支同步）`
    : '未连私有仓库：设置 → 同步 里填仓库地址');
  push('configChannel', configManager.configured, configManager.configured
    ? `通道 = ${configManager.transport}（DSH 配置快照）`
    : '未配同步通道：设置 → 备份与迁移 → 同步');

  return { ok: checks.every(c => c.ok), checks, config: cfg, channels: { chatsync, configManager } };
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

/** 写一条启动诊断（JSON Lines）。绝不抛错，绝不写入任何配置内容。 */
function diag(extra) {
  try {
    const dir = path.join(os.homedir(), '.dsh', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'dsh-synchub-boot.log'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...extra }) + '\n',
      'utf8',
    );
  } catch { /* 诊断失败不影响插件 */ }
}

function apply(ctx) {
  // —— 启动诊断：把加载事实写盘，便于排查「插件到底有没有被宿主加载」。 ——
  diag({
    phase: 'apply',
    version: process.versions?.node,
    hasCtx: !!ctx,
    hasWebServer: !!(ctx && ctx.webServer),
    webServerRegisterType: typeof (ctx && ctx.webServer && ctx.webServer.register),
    ctxKeys: ctx ? Object.keys(ctx).slice(0, 40) : [],
    dshHome: process.env.DSH_HOME || null,
    profile: process.env.DSH_PROFILE || null,
  });

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
      kind: 'exact', path: '/api/dsh-synchub/check', handler: async (req, res) => {
        try {
          // GET = 用当前落盘配置做只读体检；POST = 拿表单里的草稿先体检，不落盘。
          const raw = req.method === 'POST' ? await readBody(req) : await readConfig();
          return json(res, 200, { ok: true, ...(await checkConfig(raw)) });
        } catch (e) { return json(res, 400, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact', path: '/api/dsh-synchub/status', handler: async (_req, res) => {
        try {
          const cfg = await readConfig();
          const [workspace, vers, beacons, chatsyncCh, configCh] = await Promise.all([
            workspaceStatus(cfg), versions(), readBeacons(cfg),
            readChatsyncChannel(), readConfigManagerChannel(),
          ]);
          return json(res, 200, {
            ok: true, machine: cfg.machine, staleHours: cfg.staleHours,
            workspace, versions: vers, beacons,
            channels: { chatsync: chatsyncCh, configManager: configCh },
          });
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
    try {
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
      diag({ phase: 'routes-ok', count: routes.length });
    } catch (e) {
      // 注册失败必须留痕：否则表现就是「接口全 401」，无从判断。
      diag({ phase: 'routes-failed', error: String((e && e.stack) || e) });
      log(ctx, 'error', `路由注册失败: ${String((e && e.message) || e)}`);
    }
  } else {
    diag({ phase: 'no-webserver', hasCtx: !!ctx, webServerType: typeof (ctx && ctx.webServer) });
    log(ctx, 'warn', 'webServer 不可用：状态接口未注册');
  }
  // ⚠️ effect(fn) 会「立即调用 fn」，并把 fn 的返回值当作清理函数 ——
  // 绝不能把注销逻辑写进 fn 本体（那会在注册完成后立刻把路由全部撤销，
  // 于是 exact 表始终为空，请求落到 /api 前缀路由 → 全部 401）。
  try {
    ctx.effect(() => () => { for (const d of disposers) { try { d?.(); } catch { /* noop */ } } });
  } catch { /* 老版本 Cordis 无 effect 时忽略 */ }
}

export { name, inject, apply };
