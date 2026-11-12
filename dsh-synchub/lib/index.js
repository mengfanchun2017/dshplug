/**
 * dsh-synchub · 宿主半（v0.3.0）
 *
 * 定位变了：从「状态看板」升级为**同步引擎**。
 * 0.2.0 只聚合 chatsync / config-manager 的状态；0.3.0 自己直接管同步：
 *
 *   本机 $DSH_HOME  ──stage──▶  私有仓库 payload/  ──commit/push──▶  origin
 *   本机 $DSH_HOME  ◀──apply──  私有仓库 payload/  ◀──pull/ff────  origin
 *
 * 为什么用 git 当传输层（而不是自己写 manifest + 上传）：
 *   1) 版本历史、可回滚，天然有「上一次一致状态」；
 *   2) 内容寻址去重，附件池只有一份；
 *   3) 冲突由 git 检测，我们绝不做 force，一律 ff-only；
 *   4) 不需要另存一份「谁改了哪个文件」的登记表 —— **HEAD 的 tree 就是权威清单**，
 *      两台机器各写各的 `synchub/machine.json`，永远不冲突。
 *
 * 三条硬规则（可靠性来源）：
 *   ① 落后远端时**禁止**写本机（必须先 pull），避免制造分叉；
 *   ② 写本机前一律**备份**被覆盖/删除的文件；
 *   ③ 任何破坏性动作（force、prune 全删）都必须显式传参，默认不做。
 *
 * 边界：不读密钥文件、不把凭据放进任何通道、不碰用户工作区自己的 .git。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const name = 'dsh-synchub';
const inject = ['webServer'];
const VERSION = '0.3.0';
/* 分支不能写死。远端仓库可能是 master（GitHub 旧默认）也可能是 main，
   写死一个就会在已有仓库上推出一个**平行的空历史分支**。
   优先级：config.channels[ch].branch → 远端 HEAD 指向的分支 → DEFAULT_BRANCH。 */
const DEFAULT_BRANCH = 'main';
const BRANCH_CACHE = new Map();

function branchOf(channel) {
  return BRANCH_CACHE.get(channel) || DEFAULT_BRANCH;
}

/** 探测远端默认分支并缓存；失败则保持现状。 */
async function probeBranch(channel) {
  const dir = repoDir(channel);
  const r = await git(dir, ['ls-remote', '--symref', 'origin', 'HEAD'], 120000);
  if (!r.ok || !r.out) return null;
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(r.out);
  if (m) {
    BRANCH_CACHE.set(channel, m[1]);
    return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ 路径 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 宿主 profile 目录：从本文件往上找 node_modules 的父目录。 */
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
const PROFILE = path.basename(PROFILE_DIR) || 'desktop';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const STATE_ROOT = path.join(DSH_HOME, 'dsh-synchub');
const REPO_ROOT = path.join(STATE_ROOT, 'repos');
const BACKUP_ROOT = path.join(STATE_ROOT, 'backups');
const CACHE_FILE = path.join(STATE_ROOT, 'hash-cache.json');
const CONFIG_FILE = path.join(STATE_ROOT, 'config.json');
const ACTIVE_SESSION = process.env.DSH_SESSION_ID || '';

/* -------------------------------------------------------------- 同步面定义 */

/**
 * 一个「同步面」= 一组要同步的路径 + 一条安全等级。
 *
 * tier:
 *   safe     随便同步，坏了也能重建
 *   caution  同步前要想一下（可能含本机特有路径 / 端点地址）
 *   danger   默认永不同步，只在目录地图里显示，防止误传密钥
 */
const SURFACES = [
  {
    id: 'sessions',
    channel: 'sessions',
    label: '会话记录',
    tier: 'safe',
    on: true,
    roots: ['sessions'],
    exclude: [],
    note: 'zstd 多帧压缩的会话日志，按工作区绝对路径编码分目录',
  },
  {
    id: 'storages',
    channel: 'sessions',
    label: '工作区登记表 / 投影缓存',
    tier: 'safe',
    on: true,
    roots: ['storages'],
    exclude: [/\.bak-/, /\.tmp$/],
    note: 'workspace.json 决定会话归属；两台机器工作区路径必须一致',
  },
  {
    id: 'attachments',
    channel: 'sessions',
    label: '附件池',
    tier: 'safe',
    on: true,
    roots: ['attachments'],
    exclude: [/[\\/]tmp[\\/]/],
    note: 'sha256 内容寻址，跨工作区共享，与路径无关',
  },
  {
    id: 'skills',
    channel: 'config',
    label: '技能库',
    tier: 'safe',
    on: true,
    roots: ['skills', 'skill-manager'],
    exclude: [/[\\/]\.skm-backups[\\/]/],
    note: '技能文件与工作区登记；技能本身的安装走 dsh-market / skill-manager',
  },
  {
    id: 'profileConfig',
    channel: 'config',
    label: 'DSH 配置层',
    tier: 'caution',
    on: true,
    files: [`profiles/${PROFILE}/cordis.patch.yml`, `profiles/${PROFILE}/cordis.yml`],
    exclude: [/\.bak-/],
    note: 'patch 层（模型/端点/UI 设置）。本机实测只含 apiKeyEnv 变量名，不含密钥；但含 baseURL 等环境特有地址',
  },
  {
    id: 'profileManifest',
    channel: 'config',
    label: '插件清单',
    tier: 'danger',
    on: false,
    files: [`profiles/${PROFILE}/package.json`, `profiles/${PROFILE}/pnpm-workspace.yaml`],
    exclude: [],
    note: '含 link:C:/dsh/... 绝对路径；另一台没有同一路径会导致 DSH 启动失败，默认不同步',
  },
];

/** 永不同步的目录/文件：只在地图里显示，并解释为什么不能同步。 */
const DANGER_PATHS = [
  { id: 'credentials', label: '凭据', paths: ['.credentials.yaml'], note: 'API key 等凭据，绝不进任何仓库' },
  { id: 'traeAuth', label: 'Trae 登录态', paths: ['.trae-auth.cn.json', '.trae-auth.cn.json.bak'], note: '设备令牌' },
  { id: 'workbuddy', label: 'WorkBuddy 设备身份', paths: ['.workbuddy-device.json', '.workbuddy-device-profiles.json', '.workbuddy-host-heartbeat.json', '.workbuddy-roster-seen.cn.json'], note: '设备标识，应各机各自登录' },
  { id: 'mobileKeys', label: '移动访问私钥', paths: ['mobile-access'], note: 'iroh TLS 私钥（ca-key.pem/server-key.pem），泄露即中间人' },
  { id: 'runtimes', label: '运行时与依赖', paths: ['dsh-runtimes', `profiles/${PROFILE}/node_modules`, `profiles/${PROFILE}/.pnpm`], note: '可重新生成（数百 MB），同步只会拖慢且会因平台差异失效' },
  { id: 'caches', label: '插件缓存', paths: ['plugins', 'pixel-studio', 'workbuddy-vault', 'dsh-market'], note: '本地缓存/市场状态，重建即可' },
  { id: 'quarantine', label: '隔离与历史备份', paths: ['_sessions-quarantine-20261112'], note: '疑似损坏的历史会话，留档用，不参与同步' },
  { id: 'logs', label: '日志', paths: ['logs'], note: '本机运行时日志，只对排障本机有意义，同步过去只会误导' },
  { id: 'profileOther', label: '配置目录的非同步部分', paths: ['profiles'], note: '只有 cordis.patch.yml / cordis.yml 进仓库；同目录下 node_modules、.pnpm、缓存的登录态均不同步' },
  { id: 'deviceId', label: '匿名设备 ID', paths: ['.anonymous-user-id'], note: '每台机器一个身份，同步会让两台机器互相冒充（统计/配额会算错）' },
];

const ALL_SURFACES = new Map(SURFACES.map(s => [s.id, s]));

/* ------------------------------------------------------------------ 配置 */

const DEFAULTS = {
  machine: os.hostname(),
  workspace: 'C:\\dsh\\workspace1',
  channels: {
    config: { remote: '', enabled: true },
    sessions: { remote: '', enabled: true },
  },
  surfaces: Object.fromEntries(SURFACES.map(s => [s.id, s.on])),
  idlePushMinutes: 20,
  autoPush: false,
  staleHours: 48,
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

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
    const l = ctx && ctx.logger;
    if (typeof l === 'function') return l(`[dsh-synchub] ${msg}`);
    if (l && typeof l[level] === 'function') return l[level](`[dsh-synchub] ${msg}`);
  } catch { /* fall through */ }
  if (level === 'error') console.error(`[dsh-synchub] ${msg}`);
}

async function readConfig() {
  try {
    const v = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
    return mergeConfig(DEFAULTS, v);
  } catch (e) {
    if (e.code !== 'ENOENT') log(null, 'warn', `config unreadable: ${e.message}`);
    return structuredClone(DEFAULTS);
  }
}

function mergeConfig(base, patch) {
  const out = structuredClone(base);
  if (!patch || typeof patch !== 'object') return out;
  if (typeof patch.machine === 'string' && patch.machine.trim()) out.machine = patch.machine.trim();
  if (typeof patch.workspace === 'string') out.workspace = patch.workspace.trim();
  if (Number.isFinite(Number(patch.idlePushMinutes))) {
    out.idlePushMinutes = Math.min(720, Math.max(0, Math.trunc(Number(patch.idlePushMinutes))));
  }
  if (typeof patch.autoPush === 'boolean') out.autoPush = patch.autoPush;
  if (Number.isFinite(Number(patch.staleHours))) {
    out.staleHours = Math.min(720, Math.max(1, Math.trunc(Number(patch.staleHours))));
  }
  if (patch.channels && typeof patch.channels === 'object') {
    for (const ch of ['config', 'sessions']) {
      const src = patch.channels[ch];
      if (!src || typeof src !== 'object') continue;
      if (typeof src.remote === 'string') out.channels[ch].remote = src.remote.trim();
      if (typeof src.enabled === 'boolean') out.channels[ch].enabled = src.enabled;
    }
  }
  if (patch.surfaces && typeof patch.surfaces === 'object') {
    for (const s of SURFACES) {
      if (typeof patch.surfaces[s.id] === 'boolean') out.surfaces[s.id] = patch.surfaces[s.id];
    }
  }
  return out;
}

async function writeConfig(patch) {
  const next = mergeConfig(await readConfig(), patch);
  await fsp.mkdir(STATE_ROOT, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/* -------------------------------------------------------------------- git */

async function git(cwd, args, timeout = 20000) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_AUTHOR_NAME: 'dsh-synchub',
        GIT_AUTHOR_EMAIL: 'dsh-synchub@localhost',
        GIT_COMMITTER_NAME: 'dsh-synchub',
        GIT_COMMITTER_EMAIL: 'dsh-synchub@localhost',
      },
    });
    return { ok: true, out: String(stdout || '').trim(), err: String(stderr || '').trim() };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout || '').trim(),
      err: String(e.stderr || e.message || '').trim(),
      code: e.code,
    };
  }
}

function repoDir(channel) {
  return path.join(REPO_ROOT, channel);
}

function payloadDir(channel) {
  return path.join(repoDir(channel), 'payload');
}

/**
 * fetch 一个可能空的远端。远端仓库刚建、一次都没推过时，
 * `fetch origin main` 会以 `couldn't find remote ref main` 报错 ——
 * 那不是错误，是「远端还没有这个分支」。靠先探测是否有任何 ref 来区分。
 */
async function fetchRemote(channel, remote) {
  const dir = repoDir(channel);
  const anyRef = await git(dir, ['ls-remote', '--heads', 'origin'], 120000);
  if (!anyRef.ok) return { ok: false, empty: false, error: anyRef.err || anyRef.out };
  if (!anyRef.out) return { ok: true, empty: true };

  // 先探默认分支（master/main 都可能），再 fetch 它 —— 不探就会 fetch 错分支。
  await probeBranch(channel);
  const br = branchOf(channel);
  const f = await git(dir, ['fetch', '--prune', 'origin', br], 120000);
  if (!f.ok) return { ok: false, empty: false, error: f.err || f.out };
  const up = await git(dir, ['rev-parse', '--verify', '--quiet', `origin/${br}`]);
  return { ok: true, empty: !up.ok, branch: br, output: f.out };
}

async function ensureRepo(channel, remote) {
  const dir = repoDir(channel);
  const fresh = !fs.existsSync(path.join(dir, '.git'));
  await fsp.mkdir(dir, { recursive: true });

  if (fresh) {
    let r = await git(dir, ['init', '-b', DEFAULT_BRANCH]);
    if (!r.ok) {
      // 老 git 没有 -b
      await git(dir, ['init']);
      await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${DEFAULT_BRANCH}`]);
    }
    // 二进制安全 + Windows 长路径 + 不留 GPG 交互
    await git(dir, ['config', 'core.autocrlf', 'false']);
    await git(dir, ['config', 'core.longpaths', 'true']);
    await git(dir, ['config', 'core.safecrlf', 'false']);
    await git(dir, ['config', 'commit.gpgsign', 'false']);
    await git(dir, ['config', 'core.quotepath', 'false']);
    await fsp.writeFile(
      path.join(dir, '.gitattributes'),
      '# 同步的是二进制/原样字节，禁止任何换行与编码转换\n* -text\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(dir, '.gitignore'),
      '# 只提交 payload/ 与 synchub/，其余是运行时产物\n/backups/\n/hash-cache.json\n',
      'utf8',
    );
  }

  if (remote) {
    const cur = await git(dir, ['remote', 'get-url', 'origin']);
    if (!cur.ok) await git(dir, ['remote', 'add', 'origin', remote]);
    else if (cur.out !== remote) await git(dir, ['remote', 'set-url', 'origin', remote]);
  } else {
    await git(dir, ['remote', 'remove', 'origin']).catch(() => {});
  }

  return { dir, fresh };
}

/** 首次接入远端：把远端已有历史取下来，本地工作区对齐。 */
async function bootstrapFromRemote(channel, remote) {
  const dir = repoDir(channel);
  const info = await ensureRepo(channel, remote);
  if (!remote) return { ok: false, error: '未配置远端仓库' };

  const fetched = await fetchRemote(channel, remote);
  if (!fetched.ok) return { ok: false, error: `拉取远端失败：${fetched.error}` };
  if (fetched.empty) {
    // 远端还没有 main（刚建的空仓库）：本地继续用现有状态，等 commit/push 建基线
    return { ok: true, fresh: true, info };
  }
  const localHead = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!localHead.ok) {
    // 本地还没有任何提交：先把自己脚手架/旧 payload 移开，再整枝对齐远端。
    // 不直接 -f 检查：payload 里可能有本机还没推上去的会话，不能用远端版本简单盖掉。
    const stash = path.join(BACKUP_ROOT, 'pre-bootstrap-' + new Date().toISOString().replace(/[:.]/g, '-'));
    let moved = 0;
    for (const sub of ['payload', 'synchub', '.gitattributes', '.gitignore']) {
      const from = path.join(dir, sub);
      if (!fs.existsSync(from)) continue;
      const acc = [];
      const st = await fsp.lstat(from).catch(() => null);
      if (st && st.isDirectory()) await walkFiles(from, sub, [], acc);
      else if (st && st.isFile()) acc.push({ rel: sub });
      if (!acc.length) continue;
      const to = path.join(stash, sub);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to).catch(async () => {
        await fsp.cp(from, to, { recursive: true });
        await fsp.rm(from, { recursive: true, force: true });
      });
      moved += acc.length;
    }
    const br = fetched.branch || branchOf(channel);
    const co = await git(dir, ['checkout', '-f', '-B', br, `origin/${br}`]);
    if (!co.ok) return { ok: false, error: `检出远端分支失败：${co.err}` };
    return { ok: true, adopted: true, stashed: moved, stashDir: moved ? stash : null };
  }
  const brDone = fetched.branch || branchOf(channel);
  await git(dir, ['branch', '--set-upstream-to', `origin/${brDone}`, brDone]);
  return { ok: true };
}

/** 通道当前状态。带 opts.fetch 时先去远端刷新引用 —— 否则「落后」永远是旧值。 */
async function channelState(channel, cfg, opts = {}) {
  const conf = cfg.channels[channel] || {};
  const dir = repoDir(channel);
  const out = {
    channel,
    remote: conf.remote || '',
    enabled: conf.enabled !== false,
    initialized: fs.existsSync(path.join(dir, '.git')),
    branch: branchOf(channel),
    ahead: 0,
    behind: 0,
    dirty: 0,
    files: 0,
    lastCommitAt: null,
    lastCommit: null,
    remoteCommitAt: null,
    remoteMachine: null,
    fetched: false,
    error: null,
  };
  if (!out.initialized) {
    // 尚未初始化：分支是「未知」，不是默认值。
    // 报 main 会让人误以为已经确定了分支，而实际远端可能是 master。
    out.branch = null;
    out.error = 'not-initialized';
    return out;
  }

  const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.ok) {
    const last = await git(dir, ['log', '-1', '--format=%cI%x09%s']);
    if (last.ok && last.out) {
      const [at, ...rest] = last.out.split('\t');
      out.lastCommitAt = at || null;
      out.lastCommit = rest.join('\t') || null;
    }
    const count = await git(dir, ['ls-tree', '-r', '--name-only', 'HEAD']);
    if (count.ok) out.files = count.out ? count.out.split('\n').filter(Boolean).length : 0;
  }

  // ⚠ 必须能区分「查过了与远端一致」与「根本没查」。
  // 不 fetch 就直接读 origin/main，永远看到的是上次 fetch 的旧快照，
  // 会把「另一台刚推过」误报成「与远端一致」。
  if (out.remote) {
    if (opts.fetch) {
      const fr = await fetchRemote(channel, out.remote);
      out.fetched = fr.ok;
      if (!fr.ok) out.error = `fetch-failed: ${fr.error}`;
      if (fr.ok && fr.empty) out.remoteEmpty = true;
      if (fr.ok && fr.branch) out.branch = fr.branch;
    }
    const br = branchOf(channel);
    const up = await git(dir, ['rev-parse', '--verify', '--quiet', `origin/${br}`]);
    if (up.ok) {
      if (head.ok) {
        const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${br}`]);
        if (counts.ok) {
          const m = /^(\d+)\s+(\d+)/.exec(counts.out);
          if (m) {
            out.ahead = Number(m[1]);
            out.behind = Number(m[2]);
          }
        }
      } else {
        // 本地无提交但远端有 → 整枝都算要拉的
        out.behind = 1;
      }
      const rl = await git(dir, ['log', '-1', '--format=%cI', `origin/${br}`]);
      if (rl.ok) out.remoteCommitAt = rl.out || null;
      const st = await parseStamp(channel);
      if (st) {
        out.remoteMachine = st.machine;
        out.remoteStampAt = st.at;
      }
    }
  }

  const dirty = await git(dir, ['status', '--porcelain', '-uno']);
  if (dirty.ok) out.dirty = dirty.out ? dirty.out.split('\n').filter(Boolean).length : 0;
  return out;
}

/* ------------------------------------------------------- 文件扫描与指纹 */

const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm', '.cache', 'tmp']);
const MAX_FILE_BYTES = 200 * 1024 * 1024;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function excluded(rel, patterns) {
  if (!patterns || !patterns.length) return false;
  const posix = toPosix(rel);
  return patterns.some(re => re.test(posix) || re.test(rel));
}

async function walkFiles(absRoot, relPrefix, patterns, acc, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fsp.readdir(absRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = path.join(absRoot, ent.name);
    const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    if (excluded(rel, patterns)) continue;
    if (ent.isSymbolicLink()) continue; // junction / 硬链接不跟（.pnpm 全是这种）
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await walkFiles(abs, rel, patterns, acc, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) continue;
    acc.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
  }
}

function surfaceEnabled(surface, cfg) {
  // danger 级别（插件清单）无论开关如何都不进同步，避免把 link: 绝对路径传到另一台
  return Boolean(cfg.surfaces[surface.id]) && surface.tier !== 'danger';
}

/** 枚举某个同步面在本机的实际文件。 */
async function surfaceFiles(surface) {
  const acc = [];
  const patterns = surface.exclude || [];
  for (const root of surface.roots || []) {
    const abs = path.join(DSH_HOME, root);
    await walkFiles(abs, root, patterns, acc);
  }
  for (const rel of surface.files || []) {
    if (excluded(rel, patterns)) continue;
    const abs = path.join(DSH_HOME, rel);
    try {
      const st = await fsp.lstat(abs);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) acc.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* 不存在就跳过 */ }
  }
  return acc;
}

/** 本机所有启用同步面的文件（rel 为 DSH_HOME 相对路径，posix 分隔）。 */
async function enabledFiles(cfg) {
  const all = [];
  const perSurface = {};
  for (const s of SURFACES) {
    if (!surfaceEnabled(s, cfg)) {
      perSurface[s.id] = 0;
      continue;
    }
    const files = await surfaceFiles(s);
    perSurface[s.id] = files.length;
    for (const f of files) all.push({ ...f, surface: s.id, channel: s.channel });
  }
  return { files: all, perSurface };
}

let cache = null;
async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fsp.readFile(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache() {
  try {
    await fsp.mkdir(STATE_ROOT, { recursive: true });
    await fsp.writeFile(CACHE_FILE, JSON.stringify(cache || {}, null, 0), 'utf8');
  } catch { /* 缓存写不了不影响正确性 */ }
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(abs);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** 带 mtime/size 缓存的指纹；只有变动才真正重算。 */
async function fingerprint(file) {
  const c = await loadCache();
  const prev = c[file.rel];
  if (prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs && prev.sha256) {
    return prev.sha256;
  }
  const sha = await sha256File(file.abs);
  c[file.rel] = { sha256: sha, size: file.size, mtimeMs: file.mtimeMs };
  return sha;
}

/* ------------------------------------------------- 本机 ↔ payload 的差异 */

/**
 * 算「本机 → payload」要做什么。
 * added    : 本机有、payload 没有或内容不同 → 需要写进 payload
 * removed  : payload 有、本机没有 → 需要从 payload 删掉（同步删除动作）
 * unchanged: 一致
 */
async function diffLocalToPayload(cfg, opts = {}) {
  const { files } = await enabledFiles(cfg);
  const added = [];
  const unchanged = [];
  const removed = [];
  const renamed = [];

  // payload 每通道只扫一次，后面复用（避免重复 readdir 与重复哈希）
  const payloadIndex = { config: new Map(), sessions: new Map() };
  for (const ch of ['config', 'sessions']) {
    const acc = [];
    await walkFiles(payloadDir(ch), '', [], acc);
    for (const item of acc) payloadIndex[ch].set(toPosix(item.rel), item);
  }

  for (const f of files) {
    const sha = await fingerprint(f);
    const existing = payloadIndex[f.channel].get(f.rel);
    let same = false;
    if (existing && existing.size === f.size) {
      same = (await sha256File(existing.abs)) === sha;
    }
    if (same) {
      unchanged.push(f.rel);
    } else {
      added.push({ rel: f.rel, channel: f.channel, surface: f.surface, size: f.size, sha256: sha, abs: f.abs });
    }
  }

  // payload 里有、本机没有，且属于某个启用面 → 需要从 payload 删除
  const present = new Set(files.map(f => `${f.channel}\u0000${f.rel}`));
  const seen = new Set();
  for (const s of SURFACES) {
    if (!surfaceEnabled(s, cfg)) continue;
    for (const rel of payloadIndex[s.channel].keys()) {
      if (present.has(`${s.channel}\u0000${rel}`)) continue;
      if (!belongsTo(s, rel)) continue;
      const key = `${s.channel}\u0000${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      removed.push({ rel, channel: s.channel, surface: s.id });
    }
  }

  return { added, unchanged, removed };
}

/** 判断某个 rel 是否属于该同步面（用于 prune 时只删自己的地盘）。 */
function belongsTo(surface, rel) {
  const patterns = surface.exclude || [];
  if (excluded(rel, patterns)) return false;
  for (const root of surface.roots || []) {
    if (rel === root || rel.startsWith(`${root}/`)) return true;
  }
  for (const f of surface.files || []) {
    if (rel === f) return true;
  }
  return false;
}

/* -------------------------------------------------------------- 动作：stage */

async function stageChanges(cfg, opts = {}) {
  const diff = await diffLocalToPayload(cfg);
  const written = [];
  const deleted = [];
  const skipped = [];

  for (const a of diff.added) {
    if (opts.onlySurface && a.surface !== opts.onlySurface) {
      skipped.push(a.rel);
      continue;
    }
    const target = path.join(payloadDir(a.channel), a.rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(a.abs, target);
    written.push(a.rel);
  }

  for (const item of diff.removed) {
    if (opts.onlySurface && item.surface !== opts.onlySurface) continue;
    const target = path.join(payloadDir(item.channel), item.rel);
    if (fs.existsSync(target)) {
      await fsp.rm(target, { force: true });
      deleted.push(item.rel);
    }
  }

  await saveCache();

  for (const ch of ['config', 'sessions']) {
    const dir = repoDir(ch);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    await git(dir, ['add', '-A']);
  }

  return {
    ok: true,
    written: written.length,
    deleted: deleted.length,
    sample: written.slice(0, 20),
    deletedSample: deleted.slice(0, 20),
    skipped: skipped.length,
  };
}

/* ------------------------------------------------------------ 动作：commit */

async function commitChanges(cfg, message) {
  const results = {};
  for (const ch of ['config', 'sessions']) {
    const dir = repoDir(ch);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      results[ch] = { ok: false, reason: 'not-initialized' };
      continue;
    }
    const st = await git(dir, ['status', '--porcelain', '-uno']);
    if (!st.ok) {
      results[ch] = { ok: false, reason: st.err || 'status-failed' };
      continue;
    }
    if (!st.out) {
      results[ch] = { ok: true, committed: false, reason: 'nothing-to-commit' };
      continue;
    }
    const msg = message || `synchub: ${cfg.machine} @ ${new Date().toISOString()}`;
    // 尾注必须带：环境切换检测和「最近推送来自哪台」全靠它。
    // 早先这里漏了尾注，导致 switched 永远是 false（推了也认不出是谁推的）。
    const c = await git(dir, ['commit', '-m', msg + stampTrailer(cfg)]);
    results[ch] = c.ok
      ? { ok: true, committed: true }
      : { ok: false, reason: c.err || c.out || 'commit-failed' };
  }
  return results;
}

/* --------------------------------------------------------- 动作：push/pull */

/* 机器身份用**提交消息尾注**传达，不写共享文件。
   早先版本把 synchub/machine.json 提交进仓库，导致两台机器每次推送都改同一个文件，
   结果每次推送都制造一个真分叉（ff-only 永远拉不下来）。尾注方案没有共享文件：
   各机器只写自己的提交，读时从 origin/main 的 log 里解析。 */
const STAMP_MACHINE = 'Synchub-Machine';
const STAMP_AT = 'Synchub-At';

function stampTrailer(cfg) {
  return `\n\n${STAMP_MACHINE}: ${cfg.machine || os.hostname()}\n${STAMP_AT}: ${new Date().toISOString()}`;
}

/**
 * 从提交消息尾注解析「最近一次推送来自哪台」。
 * 优先看 origin/main（= 远端现状），没有才回退 HEAD。
 */
async function parseStamp(channel, { remoteOnly = false } = {}) {
  const dir = repoDir(channel);
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const br = branchOf(channel);
  const refs = remoteOnly ? [`origin/${br}`] : [`origin/${br}`, 'HEAD'];
  for (const ref of refs) {
    const r = await git(dir, ['log', '-1', '--format=%B', ref]);
    if (!r.ok || !r.out) continue;
    const machine = new RegExp(`^${STAMP_MACHINE}:\\s*(.+)$`, 'm').exec(r.out);
    const at = new RegExp(`^${STAMP_AT}:\\s*(.+)$`, 'm').exec(r.out);
    if (machine) return { machine: machine[1].trim(), at: at ? at[1].trim() : null, ref };
  }
  return null;
}

async function pushChannels(cfg, opts = {}) {
  const out = {};
  const message = opts.message || `synchub: ${cfg.machine} @ ${new Date().toISOString()}`;
  for (const ch of ['config', 'sessions']) {
    const conf = cfg.channels[ch] || {};
    if (conf.enabled === false) {
      out[ch] = { ok: true, skipped: 'disabled' };
      continue;
    }
    const dir = repoDir(ch);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      out[ch] = { ok: false, reason: 'not-initialized' };
      continue;
    }
    if (!conf.remote) {
      out[ch] = { ok: false, reason: 'no-remote' };
      continue;
    }

    // ⚠ 顺序故意是「先 fetch 判落后 → 再 commit → 再 push」。
    // 早先版本先 commit 再检查，落后时会先在本地凭空造一个分叉提交，
    // 之后 ff-only 永远拉不下来 —— 只能人工 reset。
    const f = await fetchRemote(ch, conf.remote);
    if (!f.ok) {
      out[ch] = { ok: false, reason: `fetch-failed: ${f.error}` };
      continue;
    }
    if (!f.empty) {
      const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${f.branch || branchOf(ch)}`]);
      if (counts.ok) {
        const m = /^(\d+)\s+(\d+)/.exec(counts.out);
        if (m && Number(m[2]) > 0) {
          out[ch] = { ok: false, reason: 'behind-remote', behind: Number(m[2]), hint: '先拉取再推送' };
          continue;
        }
      }
    }

    await git(dir, ['add', '-A']);
    const st = await git(dir, ['status', '--porcelain', '-uno']);
    let committed = false;
    if (st.ok && st.out) {
      const c = await git(dir, ['commit', '-m', message + stampTrailer(cfg)]);
      if (!c.ok) {
        out[ch] = { ok: false, reason: c.err || c.out || 'commit-failed' };
        continue;
      }
      committed = true;
    }

    const hasHead = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!hasHead.ok) {
      out[ch] = { ok: true, committed: false, reason: 'nothing-to-push' };
      continue;
    }

    const brPush = f.branch || branchOf(ch);
    const r = await git(dir, ['push', '-u', 'origin', `${brPush}:${brPush}`], 180000);
    out[ch] = r.ok
      ? { ok: true, committed, output: r.err || r.out }
      : { ok: false, reason: r.err || r.out || 'push-failed' };
  }
  return out;
}

async function pullChannels(cfg) {
  const out = {};
  for (const ch of ['config', 'sessions']) {
    const conf = cfg.channels[ch] || {};
    if (conf.enabled === false) {
      out[ch] = { ok: true, skipped: 'disabled' };
      continue;
    }
    const dir = repoDir(ch);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      if (!conf.remote) {
        out[ch] = { ok: false, reason: 'no-remote' };
        continue;
      }
      const boot = await bootstrapFromRemote(ch, conf.remote);
      out[ch] = boot.ok ? { ok: true, bootstrapped: true, boot } : { ok: false, reason: boot.error };
      continue;
    }
    // 仓库已 init 但还没任何提交（= 首次运行）也要走 bootstrap，
    // 否则下面的 ff-only merge 会撞上我们自己的 .gitattributes 脚手架。
    const hasHead = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!hasHead.ok) {
      if (!conf.remote) {
        out[ch] = { ok: false, reason: 'no-remote' };
        continue;
      }
      const boot = await bootstrapFromRemote(ch, conf.remote);
      out[ch] = boot.ok ? { ok: true, bootstrapped: true, boot } : { ok: false, reason: boot.error };
      continue;
    }
    if (!conf.remote) {
      out[ch] = { ok: false, reason: 'no-remote' };
      continue;
    }
    const f = await fetchRemote(ch, conf.remote);
    if (!f.ok) {
      out[ch] = { ok: false, reason: `fetch-failed: ${f.error}` };
      continue;
    }
    if (f.empty) {
      out[ch] = { ok: true, emptyRemote: true };
      continue;
    }
    const brPull = f.branch || branchOf(ch);
    const mb = await git(dir, ['merge', '--ff-only', `origin/${brPull}`]);
    out[ch] = mb.ok
      ? { ok: true, output: mb.out || 'up-to-date' }
      : { ok: false, reason: `需要人工处理（非快进）：${mb.err || mb.out}` };
  }
  return out;
}

/* --------------------------------------------------------- 动作：apply 到本机 */

/**
 * 把 payload 写回 $DSH_HOME。
 * - 覆盖/删除前一律备份到 backups/<ts>/
 * - 跳过当前正在写入的会话（DSH_SESSION_ID），避免把活着的日志覆盖坏
 */
async function applyPayload(cfg, opts = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUP_ROOT, stamp);
  const written = [];
  const deleted = [];
  const skipped = [];
  let backedUp = 0;

  const skipActive = rel => Boolean(ACTIVE_SESSION) && rel.includes(ACTIVE_SESSION);

  for (const s of SURFACES) {
    if (!surfaceEnabled(s, cfg)) continue;
    if (opts.onlySurface && s.id !== opts.onlySurface) continue;
    const base = payloadDir(s.channel);
    const acc = [];
    await walkFiles(base, '', [], acc);
    for (const item of acc) {
      const rel = toPosix(item.rel);
      if (!belongsTo(s, rel)) continue;
      if (skipActive(rel)) {
        skipped.push(rel);
        continue;
      }
      const dest = path.join(DSH_HOME, rel);
      let same = false;
      try {
        const st = await fsp.lstat(dest);
        if (st.size === item.size) same = (await sha256File(dest)) === (await sha256File(item.abs));
      } catch { /* 不存在 */ }
      if (!same) {
        if (fs.existsSync(dest)) {
          const b = path.join(backupDir, rel);
          await fsp.mkdir(path.dirname(b), { recursive: true });
          await fsp.copyFile(dest, b);
          backedUp += 1;
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(item.abs, dest);
        written.push(rel);
      }
    }
  }

  // 删除：本机有、payload 没有（只在启用面内，且必须显式传 prune）
  if (opts.prune && !opts.onlySurface) {
    const { files } = await enabledFiles(cfg);
    const present = new Set(files.map(f => f.rel));
    for (const s of SURFACES) {
      if (!surfaceEnabled(s, cfg)) continue;
      const base = payloadDir(s.channel);
      const acc = [];
      await walkFiles(base, '', [], acc);
      const keep = new Set(acc.map(i => toPosix(i.rel)));
      for (const rel of present) {
        if (!belongsTo(s, rel)) continue;
        if (keep.has(rel)) continue;
        if (skipActive(rel)) continue;
        const target = path.join(DSH_HOME, rel);
        if (!fs.existsSync(target)) continue;
        // 删除也要备份 —— 否则 prune 就是不可逆操作。
        const b = path.join(backupDir, rel);
        await fsp.mkdir(path.dirname(b), { recursive: true });
        await fsp.copyFile(target, b);
        backedUp += 1;
        await fsp.rm(target, { force: true });
        deleted.push(rel);
        await pruneEmptyParents(path.dirname(target), s);
      }
    }
  }

/**
 * 删文件后清掉空的父目录，但**不越过同步面根**。
 * 不清理会留一堆空 session-xxx 目录，下次扫描/地图还会把它们当真的；
 * 清理过头又会把用户目录删了，所以边界固定在 surface 根。
 */
async function pruneEmptyParents(dir, surface) {
  const roots = (surface.roots || []).map(r => path.join(DSH_HOME, r));
  let cur = dir;
  for (let i = 0; i < 12; i++) {
    if (!roots.some(r => cur === r || cur.startsWith(r + path.sep))) return;
    if (roots.some(r => cur === r)) return;
    const left = await fsp.readdir(cur).catch(() => null);
    if (!left || left.length) return;
    await fsp.rmdir(cur).catch(() => {});
    cur = path.dirname(cur);
  }
}

  // 覆盖后指纹缓存失效
  cache = {};
  await saveCache();

  return {
    ok: true,
    written: written.length,
    deleted: deleted.length,
    skipped: skipped.length,
    backedUp,
    backupDir: written.length || deleted.length ? backupDir : null,
    sample: written.slice(0, 20),
  };
}

/* ------------------------------------------------------------ 环境切换检测 */

async function remoteStamp(cfg) {
  // 只看 origin/main：要回答的是「远端最近一次是谁推的」。
  // 若都读不到尾注，返回 null，界面会显式说未知而不是假装一致。
  // 两个通道都查，取时间戳更新的那个：可能只有会话通道被推过。
  const a = await parseStamp('config', { remoteOnly: true });
  const b = await parseStamp('sessions', { remoteOnly: true });
  if (!a) return b;
  if (!b) return a;
  return String(b.at || '') > String(a.at || '') ? b : a;
}

/* -------------------------------------------------------------- 只读体检 */

async function checkAll(cfg) {
  const checks = [];
  const push = (id, ok, detail, action) => checks.push({ id, ok: Boolean(ok), detail, action: action || null });

  push('dshHome', fs.existsSync(DSH_HOME), `${DSH_HOME} ${fs.existsSync(DSH_HOME) ? '存在' : '不存在'}`);

  const g = await git(DSH_HOME, ['--version'], 8000);
  push('git', g.ok, g.ok ? g.out : '未找到 git，同步全部不可用');

  for (const ch of ['config', 'sessions']) {
    const conf = cfg.channels[ch] || {};
    const st = await channelState(ch, cfg, { fetch: true });
    const label = ch === 'config' ? '配置通道' : '会话通道';
    push(`${ch}Remote`, Boolean(conf.remote), conf.remote || `${label}未配置远端仓库`, conf.remote ? null : `在「同步中心 · 设置」里填${label}的私有仓库地址`);
    if (conf.remote && st.initialized) {
      push(`${ch}Behind`, st.behind === 0, st.behind > 0 ? `落后远端 ${st.behind} 个提交` : '与远端一致（未落后）', st.behind > 0 ? '先点「拉取」再改本机' : null);
      push(`${ch}Dirty`, st.dirty === 0, st.dirty > 0 ? `payload 有 ${st.dirty} 处未提交` : 'payload 干净', st.dirty > 0 ? '点「提交并推送」' : null);
    }
  }

  const stamp = await remoteStamp(cfg);
  if (stamp) {
    const same = stamp.machine === (cfg.machine || os.hostname());
    push('machineSwitch', same, same
      ? `最近一次推送来自本机（${stamp.machine}）`
      : `最近一次推送来自另一台机器 ${stamp.machine}（${stamp.at}）→ 先 pull 再开始工作`,
      same ? null : '点「拉取并应用」把另一台的状态同步过来');
  }

  // 工作区路径一致性（方案 1：两台机器同一绝对路径）
  const wsPath = cfg.workspace;
  push('workspaceDir', Boolean(wsPath) && fs.existsSync(wsPath), `${wsPath || '(未设置)'} ${wsPath && fs.existsSync(wsPath) ? '存在' : '不存在'}`, wsPath && !fs.existsSync(wsPath) ? '两台机器工作区必须放在完全相同的绝对路径' : null);

  // 危险项：确认没有把密钥面打开
  const leaked = [];
  for (const d of DANGER_PATHS) {
    if (d.id === 'runtimes' || d.id === 'caches' || d.id === 'quarantine' || d.id === 'mobileKeys') continue;
    for (const p of d.paths) {
      if (fs.existsSync(path.join(DSH_HOME, p))) leaked.push(p);
    }
  }
  const credInPayload = [];
  for (const ch of ['config', 'sessions']) {
    const base = payloadDir(ch);
    for (const p of ['.credentials.yaml', '.trae-auth.cn.json']) {
      if (fs.existsSync(path.join(base, p))) credInPayload.push(path.join(base, p));
    }
  }
  push('noSecrets', credInPayload.length === 0,
    credInPayload.length === 0 ? '同步目录里没有凭据文件' : `同步目录里发现凭据：${credInPayload.join(', ')}`,
    credInPayload.length ? '立刻删除这些文件并从历史中清理' : null);

  return { ok: checks.every(c => c.ok), checks };
}

/* ---------------------------------------------------------------- 目录地图 */

async function mapInfo(cfg, opts = {}) {
  const rows = [];
  for (const s of SURFACES) {
    const files = await surfaceFiles(s);
    const size = files.reduce((a, f) => a + f.size, 0);
    rows.push({
      id: s.id,
      label: s.label,
      paths: (s.roots || []).concat(s.files || []),
      tier: s.tier,
      syncOn: surfaceEnabled(s, cfg),
      channel: s.channel,
      files: files.length,
      bytes: size,
      note: s.note,
      exists: files.length > 0,
    });
  }
  for (const d of DANGER_PATHS) {
    let bytes = 0;
    let files = 0;
    let exists = false;
    for (const p of d.paths) {
      const abs = path.join(DSH_HOME, p);
      if (!fs.existsSync(abs)) continue;
      exists = true;
      // profileOther 指向整个 profiles，深度遍历会扫到 node_modules（数百 MB）；
      // logs 也可能很大。这两类只报「存在」，不统计体积。
      if (opts.deep && !['runtimes', 'caches', 'profileOther', 'logs'].includes(d.id)) {
        const acc = [];
        const st = await fsp.lstat(abs).catch(() => null);
        if (st && st.isDirectory()) await walkFiles(abs, p, [], acc);
        else if (st && st.isFile()) acc.push({ rel: p, size: st.size });
        files += acc.length;
        bytes += acc.reduce((a, f) => a + (f.size || 0), 0);
      }
    }
    rows.push({
      id: d.id,
      label: d.label,
      paths: d.paths,
      tier: 'danger',
      syncOn: false,
      channel: null,
      files,
      bytes,
      note: d.note,
      exists,
      deep: Boolean(opts.deep),
    });
  }
  return { dshHome: DSH_HOME, profileDir: PROFILE_DIR, profile: PROFILE, stateRoot: STATE_ROOT, rows };
}

/* ------------------------------------------------------------ 待办清单 */

async function preflight(cfg) {
  const steps = [];
  const add = (id, state, title, detail, action) => steps.push({ id, state, title, detail, action: action || null });

  const channels = {
    config: await channelState('config', cfg, { fetch: true }),
    sessions: await channelState('sessions', cfg, { fetch: true }),
  };
  const stamp = await remoteStamp(cfg);
  const switched = Boolean(stamp && stamp.machine !== (cfg.machine || os.hostname()));

  add('dshHome', fs.existsSync(DSH_HOME) ? 'ok' : 'fail', 'DSH 数据目录',
    DSH_HOME, null);

  const noRemote = ['config', 'sessions'].filter(ch => !(cfg.channels[ch] || {}).remote);
  add('remote', noRemote.length === 0 ? 'ok' : 'need',
    '远端仓库已配置',
    noRemote.length ? `未配置：${noRemote.join('、')}` : '配置通道与会话通道都已连到私有仓库',
    noRemote.length ? '在设置里填仓库地址（https://github.com/<你>/<私有仓库>.git）' : null);

  // 未初始化的通道不能算「与远端一致」—— 那是没查，不是查过没问题。
  const notInit = ['config', 'sessions'].filter(ch => (cfg.channels[ch] || {}).remote && !channels[ch].initialized);
  const behind = Math.max(channels.config.behind || 0, channels.sessions.behind || 0);
  add('pull', behind === 0 && notInit.length === 0 ? 'ok' : 'need',
    '先拉取远端',
    notInit.length
      ? `${notInit.join('、')}通道还没接入远端（首次拉取会自动建立连接）`
      : behind === 0
        ? '与远端一致'
        : `落后远端 ${behind} 个提交${switched ? `（另一台 ${stamp.machine} 推过）` : ''}`,
    behind === 0 && notInit.length === 0 ? null : '点「拉取并应用」，把远端状态取到本机');

  const unpushed = Math.max(channels.config.ahead || 0, channels.sessions.ahead || 0);
  add('push', unpushed === 0 ? 'ok' : 'need',
    '推送本机改动',
    unpushed === 0 ? '没有未推送的提交' : `${unpushed} 个提交未推送`,
    unpushed === 0 ? null : '点「提交并推送」');

  const dirty = (channels.config.dirty || 0) + (channels.sessions.dirty || 0);
  add('stage', dirty === 0 ? 'ok' : 'need',
    '暂存本机变动',
    dirty === 0 ? 'payload 已对齐本机' : `${dirty} 处变动还没进 payload`,
    dirty === 0 ? null : '点「扫描本机变动」或直接「提交并推送」');

  const ws = cfg.workspace;
  const wsOk = Boolean(ws && fs.existsSync(ws));
  add('workspace', wsOk ? 'ok' : 'fail', '工作区路径',
    wsOk ? `${ws}（两台机器必须完全相同）` : `${ws || '(未设置)'} 不存在`,
    wsOk ? null : '把工作区放到与另一台完全相同的绝对路径');

  const check = await checkAll(cfg);
  const failed = check.checks.filter(c => !c.ok);
  add('audit', failed.length === 0 ? 'ok' : 'warn', '只读体检',
    failed.length === 0 ? '全部通过' : `${failed.length} 项待处理：${failed.map(f => f.id).join('、')}`,
    failed.length ? '在设置面板点「检查」看逐项说明' : null);

  const order = steps.filter(s => s.state !== 'ok');
  return {
    machine: cfg.machine,
    switched,
    stamp,
    steps,
    todo: order.length,
    verdict: order.length === 0 ? '可以开始工作' : order[0].title,
  };
}

/* ------------------------------------------------------------------ 诊断 */

async function diag(extra) {
  try {
    const dir = path.join(DSH_HOME, 'logs');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(
      path.join(dir, 'dsh-synchub-boot.log'),
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: VERSION, ...extra })}\n`,
      'utf8',
    );
  } catch { /* 诊断失败不影响插件 */ }
}

/* -------------------------------------------------------------- 空闲自动推 */

const runtime = {
  lastActivity: Date.now(),
  lastAutoPushAt: null,
  lastAutoResult: null,
  timer: null,
  busy: null,
};

function touchActivity() {
  runtime.lastActivity = Date.now();
}

async function autoPushTick(ctx) {
  if (runtime.busy) return;
  const cfg = await readConfig();
  if (!cfg.autoPush || !cfg.idlePushMinutes) return;
  const idleMs = Date.now() - runtime.lastActivity;
  if (idleMs < cfg.idlePushMinutes * 60 * 1000) return;
  if (runtime.lastAutoPushAt && Date.now() - runtime.lastAutoPushAt < 5 * 60 * 1000) return;

  runtime.busy = 'auto';
  try {
    const st = { config: await channelState('config', cfg, { fetch: true }), sessions: await channelState('sessions', cfg, { fetch: true }) };
    const behind = Math.max(st.config.behind || 0, st.sessions.behind || 0);
    if (behind > 0) {
      runtime.lastAutoResult = { at: new Date().toISOString(), ok: false, reason: 'behind-remote' };
      runtime.lastAutoPushAt = Date.now();
      return;
    }
    const staged = await stageChanges(cfg);
    if (!staged.written && !staged.deleted) {
      runtime.lastAutoResult = { at: new Date().toISOString(), ok: true, reason: 'nothing-to-do' };
      runtime.lastAutoPushAt = Date.now();
      return;
    }
    await commitChanges(cfg, `synchub: auto @ ${new Date().toISOString()}`);
    const pushed = await pushChannels(cfg, {});
    const ok = ['config', 'sessions'].every(ch => {
      const r = pushed[ch];
      return !r || r.ok !== false || r.skipped;
    });
    runtime.lastAutoResult = { at: new Date().toISOString(), ok, pushed };
    runtime.lastAutoPushAt = Date.now();
    touchActivity();
    log(ctx, 'info', `auto push: ${ok ? 'ok' : 'failed'} (written ${staged.written})`);
  } catch (e) {
    runtime.lastAutoResult = { at: new Date().toISOString(), ok: false, reason: String(e && e.message || e) };
    runtime.lastAutoPushAt = Date.now();
  } finally {
    runtime.busy = null;
  }
}

/* -------------------------------------------------------------- 路由注册 */

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

async function statusPayload(cfg) {
  const [config, sessions] = await Promise.all([
    channelState('config', cfg, { fetch: true }),
    channelState('sessions', cfg, { fetch: true }),
  ]);
  const stamp = await remoteStamp(cfg);
  const enabled = {};
  for (const s of SURFACES) enabled[s.id] = surfaceEnabled(s, cfg);
  return {
    ok: true,
    version: VERSION,
    machine: cfg.machine,
    hostname: os.hostname(),
    dshHome: DSH_HOME,
    profile: PROFILE,
    activeSession: ACTIVE_SESSION || null,
    channels: { config, sessions },
    stamp,
    switched: Boolean(stamp && stamp.machine !== (cfg.machine || os.hostname())),
    surfaces: SURFACES.map(s => ({ id: s.id, label: s.label, tier: s.tier, on: Boolean(cfg.surfaces[s.id]), channel: s.channel, note: s.note })),
    auto: {
      enabled: Boolean(cfg.autoPush),
      idlePushMinutes: cfg.idlePushMinutes,
      idleMinutes: Math.round((Date.now() - runtime.lastActivity) / 60000),
      lastAt: runtime.lastAutoPushAt ? new Date(runtime.lastAutoPushAt).toISOString() : null,
      lastResult: runtime.lastAutoResult,
      busy: Boolean(runtime.busy),
    },
  };
}

function routesFor() {
  return [
    {
      kind: 'exact',
      path: '/api/dsh-synchub/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'PUT') {
            const next = await writeConfig(await readBody(req));
            return json(res, 200, { ok: true, config: next });
          }
          return json(res, 200, { ok: true, config: await readConfig() });
        } catch (e) {
          return json(res, 400, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/status',
      handler: async (_req, res) => {
        try {
          return json(res, 200, await statusPayload(await readConfig()));
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/map',
      handler: async (req, res) => {
        try {
          const cfg = await readConfig();
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          return json(res, 200, { ok: true, ...(await mapInfo(cfg, { deep: url.searchParams.get('deep') === '1' })) });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/preflight',
      handler: async (_req, res) => {
        try {
          return json(res, 200, { ok: true, ...(await preflight(await readConfig())) });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/check',
      handler: async (req, res) => {
        try {
          const cfg = req.method === 'POST' ? mergeConfig(await readConfig(), await readBody(req)) : await readConfig();
          return json(res, 200, { ok: true, ...(await checkAll(cfg)) });
        } catch (e) {
          return json(res, 400, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/scan',
      handler: async (_req, res) => {
        try {
          touchActivity();
          const cfg = await readConfig();
          const diff = await diffLocalToPayload(cfg);
          return json(res, 200, {
            ok: true,
            changed: diff.added.length,
            removed: diff.removed.length,
            unchanged: diff.unchanged.length,
            sample: diff.added.slice(0, 30).map(a => ({ rel: a.rel, surface: a.surface, size: a.size })),
            removedSample: diff.removed.slice(0, 30),
          });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/stage',
      handler: async (_req, res) => {
        try {
          touchActivity();
          const cfg = await readConfig();
          const r = await stageChanges(cfg);
          return json(res, 200, r);
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/pull',
      handler: async (req, res) => {
        try {
          touchActivity();
          const cfg = await readConfig();
          const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
          const pulled = await pullChannels(cfg);
          const failed = Object.entries(pulled).filter(([, v]) => v.ok === false);
          if (failed.length) {
            return json(res, 200, { ok: false, pulled, error: failed.map(([k, v]) => `${k}: ${v.reason}`).join('；') });
          }
          if (body.apply === false) return json(res, 200, { ok: true, pulled, applied: null });
          const applied = await applyPayload(cfg, { prune: body.prune === true });
          return json(res, 200, { ok: true, pulled, applied });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/push',
      handler: async (req, res) => {
        try {
          touchActivity();
          const cfg = await readConfig();
          const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
          for (const ch of ['config', 'sessions']) {
            const conf = cfg.channels[ch] || {};
            if (conf.enabled !== false && conf.remote) {
              const dir = repoDir(ch);
              if (!fs.existsSync(path.join(dir, '.git'))) await bootstrapFromRemote(ch, conf.remote);
            }
          }
          const staged = await stageChanges(cfg);
          const committed = await commitChanges(cfg, body.message || `synchub: ${cfg.machine} @ ${new Date().toISOString()}`);
          const pushed = await pushChannels(cfg, {});
          const ok = Object.values(pushed).every(v => v.ok !== false);
          return json(res, 200, { ok, staged, committed, pushed });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/sync',
      handler: async (req, res) => {
        try {
          touchActivity();
          const cfg = await readConfig();
          const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
          const report = { at: new Date().toISOString(), steps: [] };
          const step = (id, r) => report.steps.push({ id, ok: r.ok !== false, detail: r });

          if (body.pullFirst !== false) {
            const pulled = await pullChannels(cfg);
            step('pull', pulled);
            const failed = Object.entries(pulled).filter(([, v]) => v.ok === false);
            if (failed.length) {
              return json(res, 200, { ok: false, stage: 'pull', error: failed.map(([k, v]) => `${k}: ${v.reason}`).join('；'), report });
            }
            const applied = await applyPayload(cfg, { prune: body.prune === true });
            step('apply', applied);
          }

          const staged = await stageChanges(cfg);
          step('stage', staged);
          const committed = await commitChanges(cfg, body.message || `synchub: ${cfg.machine} @ ${new Date().toISOString()}`);
          step('commit', committed);
          const pushed = await pushChannels(cfg, {});
          step('push', pushed);

          const ok = Object.values(pushed).every(v => v.ok !== false);
          return json(res, 200, { ok, report });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/auto',
      handler: async (req, res) => {
        try {
          const cfg = await readConfig();
          if (req.method !== 'POST') {
            return json(res, 200, {
              ok: true,
              enabled: Boolean(cfg.autoPush),
              idlePushMinutes: cfg.idlePushMinutes,
              idleMinutes: Math.round((Date.now() - runtime.lastActivity) / 60000),
              lastAt: runtime.lastAutoPushAt ? new Date(runtime.lastAutoPushAt).toISOString() : null,
              lastResult: runtime.lastAutoResult,
            });
          }
          touchActivity();
          const r = await autoPushTickManually(cfg);
          return json(res, 200, r);
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
  ];
}

async function autoPushTickManually(cfg) {
  runtime.busy = 'manual';
  try {
    const staged = await stageChanges(cfg);
    await commitChanges(cfg, `synchub: manual auto @ ${new Date().toISOString()}`);
    const pushed = await pushChannels(cfg, {});
    return { ok: Object.values(pushed).every(v => v.ok !== false), staged, pushed };
  } finally {
    runtime.busy = null;
  }
}

/* ------------------------------------------------------------------ 入口 */

function apply(ctx) {
  diag({
    phase: 'apply',
    node: process.versions && process.versions.node,
    hasWebServer: Boolean(ctx && ctx.webServer),
    registerType: typeof (ctx && ctx.webServer && ctx.webServer.register),
    dshHome: DSH_HOME,
    profile: PROFILE,
    activeSession: ACTIVE_SESSION || null,
  });

  const routes = routesFor();
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
      diag({ phase: 'routes-ok', count: routes.length });
      log(ctx, 'info', `registered ${routes.length} routes (v${VERSION})`);
    } catch (e) {
      diag({ phase: 'routes-failed', error: String((e && e.stack) || e) });
      log(ctx, 'error', `路由注册失败: ${String((e && e.message) || e)}`);
    }
  } else {
    diag({ phase: 'no-webserver', hasCtx: Boolean(ctx) });
    log(ctx, 'warn', 'webServer 不可用：状态接口未注册');
  }

  // 空闲自动推送：单一定时器，60s 一跳；无任何副作用除非 autoPush 开启。
  try {
    runtime.timer = setInterval(() => { autoPushTick(ctx).catch(() => {}); }, 60_000);
    if (runtime.timer.unref) runtime.timer.unref();
  } catch { /* 定时器失败不影响主功能 */ }

  // ⚠️ ctx.effect(fn) 会立即调用 fn，并把返回值当清理函数 —— 必须返回闭包。
  try {
    ctx.effect(() => () => {
      if (runtime.timer) clearInterval(runtime.timer);
      for (const d of disposers) {
        try { d?.(); } catch { /* noop */ }
      }
    });
  } catch { /* 老版本 Cordis 无 effect 时忽略 */ }
}

export { name, inject, apply };
export const VERSION_INFO = VERSION;
