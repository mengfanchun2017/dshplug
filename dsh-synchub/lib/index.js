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
const VERSION = '0.17.0';
/* 分支不能写死。远端仓库可能是 master（GitHub 旧默认）也可能是 main，
   写死一个就会在已有仓库上推出一个**平行的空历史分支**。
   优先级：config.channels[ch].branch → 远端 HEAD 指向的分支 → DEFAULT_BRANCH。 */
const DEFAULT_BRANCH = 'main';
const BRANCH_CACHE = new Map();

/* ---- 单仓库（ADR-037）------------------------------------------
 * 只有 repos/all 一个物理仓库、一个 cfg.remote。
 * config / sessions 不再是通道，SURFACES[].channel 只用于分组展示。 */
function channelsOf() { return ['all']; }
function repoKeyOf() { return 'all'; }
function remoteOf(channel, cfg) { return String((cfg && cfg.remote) || '').trim(); }
function channelLabel() { return '同步仓库'; }

/* 缓存优先；没探测过时读本地仓库的实际分支（比 DEFAULT_BRANCH 可靠得多）：
   config 仓库当初就是从 master 建的，写死 main 会让阳性值算错——
   rev-list HEAD...origin/main 会失败，于是 behind 停在 0，看起来「与远端一致」。 */
function branchOf(channel, cfg) {
  const key = repoKeyOf(channel, cfg);
  const cached = BRANCH_CACHE.get(key);
  if (cached) return cached;
  // 同步函数不能 await：读 .git/HEAD（一行 ref: refs/heads/<name>）够快且无子进程。
  try {
    const head = fs.readFileSync(path.join(repoDir(channel, cfg), '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s+refs\/heads\/(\S+)$/.exec(head);
    if (m) {
      BRANCH_CACHE.set(key, m[1]);
      return m[1];
    }
  } catch { /* 未初始化或分离 HEAD：回退默认值 */ }
  return DEFAULT_BRANCH;
}
/** 探测远端默认分支并缓存；失败则保持现状。 */
async function probeBranch(channel, cfg) {
  const dir = repoDir(channel, cfg);
  const r = await git(dir, ['ls-remote', '--symref', 'origin', 'HEAD'], 120000);
  if (!r.ok || !r.out) return null;
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(r.out);
  if (m) {
    BRANCH_CACHE.set(repoKeyOf(channel, cfg), m[1]);
    return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ 路径 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ADR-034：会话体检与修复。为了不让 index.js 继续膨胀（已 3500+ 行）且好单测，
   引擎放在兄弟模块里；它只拿 dshHome 做纯文件操作，不注册路由、不读配置。 */
import { doctorScan as sessionDoctorScan, doctorApply as sessionDoctorApply } from './sessiondoctor.js';
import { decodeSessionLog, sessionLogSeqGaps } from './sessionlog.js';
import { memoryMap, archivePlan, readSessionTranscript, appendMemory, writeMemoryFile, recentWorkspaceTranscript, MEMORY_DIR, USER_MEMORY_FILE } from './memory.js';

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
    roots: ['skills'],
    note: '技能文件本体；技能的安装走 dsh-market'
  },
  {
    id: 'agentInstructions',
    channel: 'config',
    label: '全局记忆文件',
    tier: 'safe',
    on: true,
    files: ['AGENTS.md'],
    exclude: [],
    note: '用户全局 AGENTS.md（DSH 每次会话注入的规则）。工作区内的 AGENTS.md 归各工作区自己的 git 管',
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
  {
    id: 'memory',
    channel: 'config',
    label: '记忆文件',
    tier: 'safe',
    on: true,
    roots: ['memory'],
    exclude: [/\.bak-/],
    note: '用户级记忆 ~/.dsh/memory/（归档时自动写入）。工作区级 <工作区>/memory/ 随各工作区自己的 git',
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

/** 默认工作区根：沿用仓库约定 C:\\dsh\\<注册名>（可用 config.workspaceRoot 覆盖）。 */
function defaultWorkspaceRoot() {
  return DEFAULTS && DEFAULTS.workspaceRoot ? DEFAULTS.workspaceRoot : 'C:\\dsh';
}

/**
 * 工作区映射表规范化。每行 {name, path|null, note?}：
 *  - name 是**注册名**（对应 workspace.json 的 title，大小写不敏感唯一）
 *  - path 省略时默认 <workspaceRoot>\<name>（所以 C:\dsh\dshplug 只需填 dshplug）
 *  - 同名多条只保留第一条（后者不静默覆盖，避免误改）
 * 不抛错：面板/配置里的脏数据不能让整个配置读不出来。
 */
function normalizeWorkspaceMap(list, root) {
  const out = [];
  const seen = new Set();
  const base = (typeof root === 'string' && root.trim()) ? root.trim() : defaultWorkspaceRoot();
  for (const raw of Array.isArray(list) ? list : []) {
    if (raw == null) continue;
    // 字符串行两种含义：带分隔符/盘符的当路径，否则当注册名。
    let rec;
    if (typeof raw === 'string') {
      const s = raw.trim();
      rec = (/[\\/]/.test(s) || /^[a-zA-Z]:/.test(s)) ? { path: s } : { name: s };
    } else {
      rec = raw;
    }
    let name = String(rec.name ?? '').trim();
    let p = rec.path == null ? '' : String(rec.path).trim();
    // 只给了路径：注册名取最后一段目录名。
    if (!name && p) name = path.basename(p.replace(/[\\/]+$/, ''));
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      path: p || path.join(base, name),
      ...(rec.note ? { note: String(rec.note).slice(0, 200) } : {}),
    });
    if (out.length >= 50) break;
  }
  return out;
}

/* ---------------------------------------------------------- 真实工作区登记
 * 从 workspace.json 读「DSH 实际登记了哪些工作区」（UUID + title + path + 会话数），
 * 再和用户配的 workspaceMap 对照。这样“注册名 → 本机位置”不是拍脑袋，
 * 而是有宿主的真名作为锚。
 */
async function realWorkspaces() {
  const file = path.join(DSH_HOME, 'storages', 'workspace.json');
  let doc;
  try { doc = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { return { ok: false, error: `workspace.json 无法解析：${e.message}`, workspaces: [] }; }
  const wss = (doc && doc.tables && doc.tables.workspaces) || {};
  const list = Object.entries(wss).map(([id, w]) => ({
    id,
    title: w.title || '',
    path: w.path || '',
    sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
    pathExists: Boolean(w.path) && fs.existsSync(w.path),
  }));
  list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  // suggestions：给面板「检查并自动填写」用的纯数据（注册名 = title，位置 = 真实 path）。
  // 全部读自 workspace.json，确定性推导，不涉及任何模型推断。
  const suggestions = list.filter(w => w.title).map(w => ({ name: w.title, path: w.path }));
  return { ok: true, workspaces: list, suggestions, defaultWorkspaceId: (doc && doc.global && doc.global.defaultWorkspaceId) || null };
}

/** 映射表 ↔ 真实工作区对照：逐个标注已登记/未登记/路径不一致。 */
async function workspaceReport(cfg) {
  const real = await realWorkspaces();
  const byTitle = new Map();
  for (const w of real.workspaces) if (w.title) byTitle.set(w.title.toLowerCase(), w);
  const map = normalizeWorkspaceMap(cfg.workspaceMap, cfg.workspaceRoot);
  const rows = map.map(m => {
    const hit = byTitle.get(m.name.toLowerCase());
    const exists = fs.existsSync(m.path);
    // 三种状态：matched（含路径一致）/ pathDiffers（登记路径与配置不同）/ unregistered
    let state = 'unregistered';
    if (hit) state = (hit.path.toLowerCase() === m.path.toLowerCase()) ? 'matched' : 'pathDiffers';
    return {
      name: m.name, path: m.path, configured: true,
      registered: Boolean(hit), state,
      realPath: hit ? hit.path : null,
      realPathExists: hit ? hit.pathExists : null,
      sessionCount: hit ? hit.sessionCount : null,
      pathExists: exists,
    };
  });
  // 反向：DSH 里登记了、但映射表没写的（只用提示，不自动加）。
  const configuredNames = new Set(map.map(m => m.name.toLowerCase()));
  const missingInMap = real.workspaces
    .filter(w => w.title && !configuredNames.has(w.title.toLowerCase()))
    .map(w => ({ name: w.title, path: w.path, sessionCount: w.sessionCount, pathExists: w.pathExists }));
  return {
    ok: true,
    workspaceRoot: cfg.workspaceRoot,
    realError: real.ok ? null : real.error,
    total: real.workspaces.length,
    rows,
    missingInMap,
    // 全部真实工作区的名字+路径（确定性），供面板「检查并自动填写」一键带入。
    suggestions: real.suggestions || [],
    defaultWorkspaceId: real.defaultWorkspaceId || null,
  };
}

const DEFAULTS = {
  machine: os.hostname(),
  /* 唯一同步仓库（ADR-037）：dsh-msynchub。 */
  remote: '',
  workspace: 'C:\\dsh\\workspace1',
  workspaceRoot: 'C:\\dsh',
  workspaces: [],
  /* 工作区映射表：每行 = 一个「注册名 + 本地位置」。
     - name 唯一，对应 workspace.json 里工作区的 title（注册名）
     - path 可省略，省略时默认 C:\\dsh\\<name>
     它回答「要同步哪些工作区、它们在本机哪里」，比纯路径列表好管。 */
  workspaceMap: [],
  showInSidebar: true,
  surfaces: Object.fromEntries(SURFACES.map(s => [s.id, s.on])),
  idlePushMinutes: 20,
  autoPush: false,
  staleHours: 48,
  /* 代码仓库：用户自己的 git 仓库（插件源码 / 工作区笔记）。
     与 channels 完全分离 —— 那些是「运行时状态快照」，这些是「已有历史的代码库」。
     codeRepoAutoMinutes=0 表示不自动，只在面板手动触发。 */
  codeRepos: [],
  codeRepoAutoMinutes: 60,   // 全局默认：60 分钟自动提交一次
  codeRepoAutoEnabled: false, // 默认关：首次接入需用户明确打开，不默默改别人仓库
  /* 插件清单备份/恢复（ADR-038）。只记名字（npm）与名字+位置（link），不记版本。
     enabled 默认关：与 dsh-market 的备份导出二选一，避免两处同时判定插件清单；
     autoMinutes=0 表示不自动，只在面板手动触发。 */
  pluginSync: { enabled: false, autoMinutes: 0, includeLink: true },
  /* 记忆管理（阶段②，ADR-040）：
     - onArchive：会话归档时是否自动总结并写入该工作区的 memory/PROJECT.md
     - workspaces：逐工作区开关（name = workspace.json 的 title）
     - userEnabled：是否同时写用户级 ~/.dsh/memory/USER.md
     - tidy：整理记忆（阶段③），intervalHours=0 表示不定时 */
  memory: {
    enabled: true,
    onArchive: true,
    userEnabled: false,
    workspaces: [],
    tidy: { enabled: false, intervalHours: 0 },
  },
};

/* dshplug 仓库：布局与可复制安装信息（新主机用）。
 *
 * 仓库是 monorepo，根不是 bundle —— 装单个 synchub 必须用 #path: 指向子目录，
 * 否则 DSH 在仓库根找不到 dsh.bundle.patch。
 *
 * ⚠ 地址不写死：从本仓库实际 git remote 推导（换仓库/改 remote 不用改代码）；
 * 也**不写“远端是旧版”**这种硬文案——只报事实（本地 vs origin 的版本），避免说错。 */
const PLUGIN_DIR = path.dirname(HERE);          // …/dshplug/dsh-synchub
const REPO_ROOT_GUESS = path.dirname(PLUGIN_DIR); // …/dshplug

/** 把各种 git remote 写法归一成「可粘到 DSH 插件管理器」的 HTTPS 地址。 */
function normalizeRemoteToHttps(remote) {
  let r = String(remote || '').trim();
  if (!r) return null;
  // scp 风格：git@github.com:user/repo.git
  const scp = /^[\w.-]+@([^:]+):(.+)$/.exec(r);
  if (scp) r = `https://${scp[1]}/${scp[2]}`;
  // git+https / ssh 协议
  r = r.replace(/^git\+/i, '').replace(/^ssh:\/\/git@/i, 'https://');
  if (!/^https?:\/\//i.test(r)) return null;
  r = r.replace(/\.git$/i, '').replace(/\/+$/, '');
  return r;
}

/** 只读探一下本仓库 remote 与（可能的）origin 分支版本，失败不抛。 */
async function repoFacts() {
  const facts = { repoRoot: null, remote: null, repoHttps: null, branch: null, localVersion: VERSION, remoteVersion: null, remoteRef: null, error: null };
  // 插件目录的上一级很可能就是仓库根（dshplug 扁平布局）；不是就只说“不知道”。
  const pj = path.join(REPO_ROOT_GUESS, 'list.json');
  if (!fs.existsSync(pj)) return facts;
  facts.repoRoot = REPO_ROOT_GUESS;
  const r = await git(REPO_ROOT_GUESS, ['remote', 'get-url', 'origin'], 8000);
  if (!r.ok || !r.out) { facts.error = 'no-remote'; return facts; }
  facts.remote = r.out;
  facts.repoHttps = normalizeRemoteToHttps(r.out);
  const b = await git(REPO_ROOT_GUESS, ['rev-parse', '--abbrev-ref', 'HEAD'], 8000);
  if (b.ok && b.out) facts.branch = b.out;
  // 读 origin/<branch> 上的 synchub 版本（纯本地引用，不联网）。
  if (facts.branch) {
    const ref = `origin/${facts.branch}:dsh-synchub/package.json`;
    const show = await git(REPO_ROOT_GUESS, ['show', ref], 8000);
    if (show.ok && show.out) {
      try {
        facts.remoteVersion = JSON.parse(show.out).version || null;
        facts.remoteRef = `origin/${facts.branch}`;
      } catch { /* 不是 JSON 就不报 */ }
    }
  }
  return facts;
}

/** DSH 官方安装入口说明（dsh-market / 插件管理器 vs 本插件的分工）。 */
async function installInfo() {
  const f = await repoFacts();
  const base = f.repoHttps;
  const spec = base ? `${base}#path:dsh-synchub` : null;
  // 版本差异只说事实：本地与 origin 已记录的版本各是多少。
  let remoteState = 'unknown';
  let remoteNote = '无法读取本仓库 origin 上的版本（未配 remote 或未 fetch 过），不冒充知道。';
  if (f.remoteVersion) {
    remoteState = f.remoteVersion === f.localVersion ? 'same' : 'differs';
    remoteNote = remoteState === 'same'
      ? `本地与 ${f.remoteRef} 记录的版本一致（${f.localVersion}）。`
      : `本地 ${f.localVersion}，而 ${f.remoteRef} 记录的是 ${f.remoteVersion}（可能是旧版，也可能本地改动未推送）；从 git 地址装前先确认。`;
  } else if (f.error === 'no-remote') {
    remoteNote = '本仓库没配 git remote，无法给出 git 安装地址；请用下面的本机脚本方式。';
  }
  return {
    ok: true,
    repoRoot: f.repoRoot,
    remote: f.remote,
    repoHttps: base ? base + '.git' : null,
    spec,
    command: spec ? 'dsh plugin add ' + spec : null,
    powershell: f.repoRoot ? `& "${path.join(f.repoRoot, 'install.ps1')}" -Only dsh-synchub` : null,
    whySubdir: 'dshplug 是多插件 monorepo，仓库根不是 bundle；必须带 #path:dsh-synchub 指向子目录，DSH 才能找到 dsh.bundle.patch。',
    pluginManager: {
      entry: '设置 → 插件 → 添加插件（dsh-market / 插件管理器）',
      supports: 'npm 包名、Git 仓库地址、本地目录路径',
      note: '本插件（Msynchub）不是市场插件，是自研 link: 插件；市场/插件管理器负责「装插件」，本插件负责「同步 DSH 的数据」。',
    },
    version: { local: f.localVersion, remote: f.remoteVersion, remoteRef: f.remoteRef, state: remoteState, note: remoteNote },
  };
}

/** 空闲判定标准的可读说明（面板直接展示，避免用户猜「空闲」指什么）。 */
function idleStandard() {
  return {
    what: '空闲 = 距上次对 Msynchub 面板/接口的手动操作超过 idlePushMinutes 分钟',
    triggers: ['已到空闲阈值', '确实有本机改动（不是空跑）', '没有落后远端', '不在上次自动推送后 5 分钟冷却期'],
    notCounted: '不检测 DSH 会话里是否有正在运行的 agent/turn；只按本插件收到的 HTTP 操作计时，agent 在后台跑但与面板无交互仍会被判为空闲。',
    defaultOff: 'autoPush 默认关闭；只有在关闭状态下才按你设定的阈值与冷却触发。',
  };
}

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
  if (typeof patch.workspaceRoot === 'string' && patch.workspaceRoot.trim()) out.workspaceRoot = patch.workspaceRoot.trim();
  // 侧边栏入口开关：关掉后仍可在「设置 → Msynchub」用，不影响功能。
  if (typeof patch.showInSidebar === 'boolean') out.showInSidebar = patch.showInSidebar;
  // 工作区映射表（规范化 + 去重 + 默认路径）；旧的 workspaces 路径列表自动迁移。
  if (Array.isArray(patch.workspaceMap)) {
    out.workspaceMap = normalizeWorkspaceMap(patch.workspaceMap, out.workspaceRoot);
  } else if (Array.isArray(patch.workspaces)) {
    out.workspaceMap = normalizeWorkspaceMap(patch.workspaces.map(p => ({ path: p })), out.workspaceRoot);
  }
  if (Number.isFinite(Number(patch.idlePushMinutes))) {
    out.idlePushMinutes = Math.min(720, Math.max(0, Math.trunc(Number(patch.idlePushMinutes))));
  }
  if (typeof patch.autoPush === 'boolean') out.autoPush = patch.autoPush;
  if (Number.isFinite(Number(patch.staleHours))) {
    out.staleHours = Math.min(720, Math.max(1, Math.trunc(Number(patch.staleHours))));
  }
  // 唯一同步仓库地址（ADR-037）。
  if (typeof patch.remote === 'string') out.remote = patch.remote.trim();
  if (patch.surfaces && typeof patch.surfaces === 'object') {
    for (const s of SURFACES) {
      if (typeof patch.surfaces[s.id] === 'boolean') out.surfaces[s.id] = patch.surfaces[s.id];
    }
  }
  /* 代码仓库清单：白名单式规范化。
     为什么不在前端随便传路径：一条错误的路径会让同步去 commit 不相干的目录，
     所以这里严格校验 —— 必须是绝对路径、去重、按 id 稳定排序。 */
  if (Array.isArray(patch.codeRepos)) {
    const seen = new Set();
    const list = [];
    for (const r of patch.codeRepos) {
      if (!r || typeof r !== 'object') continue;
      const p = String(r.path || '').trim();
      if (!p) continue;
      /* 只收绝对路径：相对路径会随 cwd 飘移，同步目标变得不可预测。 */
      if (!path.isAbsolute(p)) continue;
      const id = String(r.id || path.basename(p)).trim() || path.basename(p);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({
        id,
        path: p,
        enabled: r.enabled !== false,
        autoCommitMinutes: Math.min(1440, Math.max(0, Math.trunc(Number(r.autoCommitMinutes) || 0))),
      });
    }
    out.codeRepos = list;
  }
  if (Number.isFinite(Number(patch.codeRepoAutoMinutes))) {
    out.codeRepoAutoMinutes = Math.min(1440, Math.max(0, Math.trunc(Number(patch.codeRepoAutoMinutes))));
  }
  if (typeof patch.codeRepoAutoEnabled === 'boolean') out.codeRepoAutoEnabled = patch.codeRepoAutoEnabled;
  // 插件清单备份/恢复（ADR-038）：插件清单是否由本插件管。
  if (patch.pluginSync && typeof patch.pluginSync === 'object') {
    const ps = patch.pluginSync;
    if (typeof ps.enabled === 'boolean') out.pluginSync.enabled = ps.enabled;
    if (Number.isFinite(Number(ps.autoMinutes))) {
      out.pluginSync.autoMinutes = Math.min(1440, Math.max(0, Math.trunc(Number(ps.autoMinutes))));
    }
    if (typeof ps.includeLink === 'boolean') out.pluginSync.includeLink = ps.includeLink;
  }
  /* 记忆管理（ADR-040）。workspaces 是白名单：name 对应 workspace.json 的 title，
     只收 {name, enabled}，去重；脏数据不能让配置读不出来。 */
  if (patch.memory && typeof patch.memory === 'object') {
    const m = patch.memory;
    if (typeof m.enabled === 'boolean') out.memory.enabled = m.enabled;
    if (typeof m.onArchive === 'boolean') out.memory.onArchive = m.onArchive;
    if (typeof m.userEnabled === 'boolean') out.memory.userEnabled = m.userEnabled;
    if (Array.isArray(m.workspaces)) {
      const seen = new Set();
      out.memory.workspaces = m.workspaces
        .filter(w => w && typeof w.name === 'string' && w.name.trim())
        .map(w => ({ name: w.name.trim(), enabled: w.enabled !== false }))
        .filter(w => !seen.has(w.name.toLowerCase()) && seen.add(w.name.toLowerCase()));
    }
    if (m.tidy && typeof m.tidy === 'object') {
      if (typeof m.tidy.enabled === 'boolean') out.memory.tidy.enabled = m.tidy.enabled;
      if (Number.isFinite(Number(m.tidy.intervalHours))) {
        out.memory.tidy.intervalHours = Math.min(720, Math.max(0, Math.trunc(Number(m.tidy.intervalHours))));
      }
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

function repoDir(channel, cfg) {
  return path.join(REPO_ROOT, repoKeyOf(channel, cfg));
}

/* 仓库里镜像 $DSH_HOME 的目录名（ADR-037：从 payload/ 改为更直观的 dsh-home/）。 */
const PAYLOAD_DIR_NAME = 'dsh-home';

function payloadDir(channel, cfg) {
  return path.join(repoDir(channel, cfg), PAYLOAD_DIR_NAME);
}

/**
 * 不依赖本地仓库状态，直接问远端「你到底存不存在」。
 * 未初始化的通道没法 fetch，但「仓库根本没建」和「仓库已建只是本地还没接」
 * 对用户的下一步完全不同：前者要去 GitHub 建，后者直接点拉取就行。
 */
async function probeRemoteExists(channel, remote) {
  if (!remote) return { ok: false };
  const r = await git(REPO_ROOT, ['ls-remote', '--heads', remote], 90000);
  if (r.ok) return { ok: true, missing: false };
  const why = r.err || r.out || '';
  const missing = /not found|does not appear|Repository not found|404|not exist/i.test(why);
  return { ok: false, missing, error: why };
}

/**
 * fetch 一个可能空的远端。远端仓库刚建、一次都没推过时，
 * `fetch origin main` 会以 `couldn't find remote ref main` 报错 ——
 * 那不是错误，是「远端还没有这个分支」。靠先探测是否有任何 ref 来区分。
 */
/* fetch 结果缓存（短 TTL）。
   一次面板刷新会并发请求 /status /preflight /self-check /map，
   它们各自都去 ls-remote + fetch，同一份数据在网络上往返 3–4 次。
   实测：ls-remote 3.9s + fetch 2.8s，单通道就 6.7s，三接口叠加就是 20s+，
   直接撞破前端 30s 超时 → 面板显示「接口不可用」。
   缓存 8 秒：足够让同一次刷新复用，又不至于让「另一台刚推过」变得不可见。 */
const FETCH_TTL_MS = 8000;
const FETCH_CACHE = new Map(); // channel -> { at, promise }

async function fetchRemoteCached(channel, remote, cfg) {
  const key = repoKeyOf(channel, cfg);
  const hit = FETCH_CACHE.get(key);
  const now = Date.now();
  if (hit && hit.remote === remote && now - hit.at < FETCH_TTL_MS) return hit.promise;
  // 存 Promise 而不是结果：并发的多个请求共用同一趟网络往返，不会各跑一次。
  const promise = fetchRemote(channel, remote, cfg);
  FETCH_CACHE.set(key, { at: now, remote, promise });
  promise.catch(() => FETCH_CACHE.delete(key));
  return promise;
}

/* 本地 refs 快照（完全无网络）。fast 模式用它回答「落后/领先」。
   behind/ahead 基于上次 fetch 的 origin/<br>，可能在缓存 TTL 内陈旧 ——
   这在侧边栏轮询里是可接受的：它会明确标 stale=true，不假装刚查过。 */
function cachedRemoteState(channel, remote, cfg) {
  const hit = FETCH_CACHE.get(repoKeyOf(channel, cfg));
  if (!hit || hit.remote !== remote) return null;
  return { ok: true, at: hit.at, stale: Date.now() - hit.at >= FETCH_TTL_MS };
}

async function fetchRemote(channel, remote, cfg) {
  const dir = repoDir(channel, cfg);
  const anyRef = await git(dir, ['ls-remote', '--heads', 'origin'], 120000);
  // ls-remote 失败 = 仓库根本不存在 / 没权限，和「仓库存在但为空」是两件事。
  // 前者拉一百次也不会自动建好，必须明说，不能引导用户去点拉取。
  if (!anyRef.ok) {
    const why = anyRef.err || anyRef.out || '';
    const missing = /not found|does not appear|Repository not found|404/i.test(why);
    return { ok: false, empty: false, missing, error: why };
  }
  if (!anyRef.out) return { ok: true, empty: true };

  // 先探默认分支（master/main 都可能），再 fetch 它 —— 不探就会 fetch 错分支。
  await probeBranch(channel, cfg);
  const br = branchOf(channel, cfg);
  const f = await git(dir, ['fetch', '--prune', 'origin', br], 120000);
  if (!f.ok) return { ok: false, empty: false, error: f.err || f.out };
  const up = await git(dir, ['rev-parse', '--verify', '--quiet', `origin/${br}`]);
  return { ok: true, empty: !up.ok, branch: br, output: f.out };
}

/* 仓库根 README（ADR-037）：让人打开仓库就知道每个目录是什么。
   只在缺失时写入，不覆盖用户自己的修改。 */
const REPO_README = [
  '# dsh-msynchub · DSH 同步仓库',
  '',
  '这是 `dsh-synchub` 插件的**唯一**同步仓库：多台机器共用，一台推、其它拉。',
  '`dsh-home/` 是 `$DSH_HOME`（默认 `C:\\Users\\<你>\\.dsh`）的镜像，路径一一对应。',
  '',
  '| 目录 / 文件 | 是什么 |',
  '|---|---|',
  '| `dsh-home/sessions/` | 会话日志（zstd 压缩；子目录名 = 工作区绝对路径编码） |',
  '| `dsh-home/storages/` | 工作区登记表 `workspace.json` + 投影缓存 |',
  '| `dsh-home/attachments/` | 附件池（sha256 内容寻址） |',
  '| `dsh-home/skills/` | 技能文件本体 |',
  '| `dsh-home/profiles/<profile>/` | DSH 配置层（cordis*.yml，不含密钥） |',
  '| `dsh-home/AGENTS.md` | 用户全局规则 |',
  '',
  '- **谁推的**：看提交消息尾注 `Synchub-Machine` / `Synchub-At`。',
  '- **怎么恢复**：另一台装好 DSH 与本插件，填这个仓库地址，点「拉取并应用」。',
  '- **别手改**：会话正文与 `workspace.json` 必须一起动，手改会留下悬空引用。',
  '',
  '不在这个仓库里的：插件清单（含 `link:` 绝对路径）、凭据、登录态、运行时、缓存 —— 刻意的，',
  '见插件设置页的「目录清单」。',
  '',
].join('\n');

/** 仓库脚手架：旧 payload/ → dsh-home/ 的一次性迁移 + 补 README。*/
function ensureRepoScaffold(dir) {
  try {
    const oldP = path.join(dir, 'payload');
    const newP = path.join(dir, PAYLOAD_DIR_NAME);
    if (fs.existsSync(oldP) && !fs.existsSync(newP)) fs.renameSync(oldP, newP);
  } catch { /* 迁移失败不阻断；最坏是两套目录并存，用户能看到 */ }
  try {
    const rm = path.join(dir, 'README.md');
    if (!fs.existsSync(rm)) fs.writeFileSync(rm, REPO_README, 'utf8');
  } catch { /* README 写不了不影响同步 */ }
}

async function ensureRepo(channel, remote, cfg) {
  const dir = repoDir(channel, cfg);
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
      '# 只提交 dsh-home/ 与 synchub/，其余是运行时产物\n/backups/\n/hash-cache.json\n',
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
  ensureRepoScaffold(dir);

  return { dir, fresh };
}

/** 首次接入远端：把远端已有历史取下来，本地工作区对齐。 */
async function bootstrapFromRemote(channel, remote, cfg) {
  const dir = repoDir(channel, cfg);
  const info = await ensureRepo(channel, remote, cfg);
  if (!remote) return { ok: false, error: '未配置远端仓库' };

  const fetched = await fetchRemote(channel, remote, cfg);
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
    for (const sub of [PAYLOAD_DIR_NAME, 'synchub', '.gitattributes', '.gitignore', 'README.md']) {
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
    const br = fetched.branch || branchOf(channel, cfg);
    const co = await git(dir, ['checkout', '-f', '-B', br, `origin/${br}`]);
    if (!co.ok) return { ok: false, error: `检出远端分支失败：${co.err}` };
    return { ok: true, adopted: true, stashed: moved, stashDir: moved ? stash : null };
  }
  const brDone = fetched.branch || branchOf(channel, cfg);
  await git(dir, ['branch', '--set-upstream-to', `origin/${brDone}`, brDone]);
  return { ok: true };
}

/** 通道当前状态。带 opts.fetch 时先去远端刷新引用 —— 否则「落后」永远是旧值。 */
async function channelState(channel, cfg, opts = {}) {
  const dir = repoDir(channel, cfg);
  const out = {
    channel,
    label: channelLabel(channel),
    remote: remoteOf(channel, cfg),
    enabled: true,
    initialized: fs.existsSync(path.join(dir, '.git')),
    branch: branchOf(channel, cfg),
    ahead: 0,
    behind: 0,
    dirty: 0,
    files: 0,
    lastCommitAt: null,
    lastCommit: null,
    remoteCommitAt: null,
    remoteMachine: null,
    fetched: false,
    remoteMissing: false,
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
      const fr = await fetchRemoteCached(channel, out.remote, cfg);
      out.fetched = fr.ok;
      if (fr.missing) out.remoteMissing = true;
      if (!fr.ok) out.error = fr.missing ? 'remote-missing' : `fetch-failed: ${fr.error}`;
      if (fr.ok && fr.empty) out.remoteEmpty = true;
      if (fr.ok && fr.branch) out.branch = fr.branch;
    } else {
      /* 不 fetch 也仍然要回答「落后/领先」——那算的是本地 origin/<br> ref，
         不是网络。只是可能陈旧（上次 fetch 之后的远端提交看不到）。
         必须标记出来，不能把「没查」当成「一致」（ADR-026 的同一教训）。 */
      const cs = cachedRemoteState(channel, out.remote, cfg);
      out.fetched = false;
      out.stale = true;
      out.checkedAt = cs ? new Date(cs.at).toISOString() : null;
    }
    const br = branchOf(channel, cfg);
    const up = await git(dir, ['rev-parse', '--verify', '--quiet', `origin/${br}`]);
    if (up.ok) {
      if (head.ok) {
        const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${br}`]);
        if (counts.ok) {
          const m = /^(\d+)\s+(\d+)/.exec(counts.out);
          if (m) {
            out.ahead = Number(m[1]);
            out.behind = Number(m[2]);
            // 既领先又落后 = 两台各自推过 = 分叉（ADR-030）。侧边栏据此亮红点。
            out.diverged = out.ahead > 0 && out.behind > 0;
          }
        }
      } else {
        // 本地无提交但远端有 → 整枝都算要拉的
        out.behind = 1;
      }
      const rl = await git(dir, ['log', '-1', '--format=%cI', `origin/${br}`]);
      if (rl.ok) out.remoteCommitAt = rl.out || null;
      const st = await parseStamp(channel, cfg);
      if (st) {
        out.remoteMachine = st.machine;
        out.remoteStampAt = st.at;
      }
    }
  }

  // ⚠ 旧版这里用 `git status --porcelain -uno` 充当「有东西没同步」，在两个空仓库上恒为 0，
  // 于是面板显示「payload 已对齐本机」、preflight 判「可以开始工作」，
  // 而实际一次都没暂存过（2026-11-18 用户踩到：GitHub 上看仓库是空的）。
  // payloadMissing 很便宜（就一个 existsSync），总算；它能把「零提交/从未暂存」区分出来。
  out.payloadMissing = !fs.existsSync(payloadDir(channel, cfg));

  // pending 要扫全量文件并算指纹（sessions 可达 80MB+），不能挂在 /status 轮询里。
  // 只在显式 opts.scan 时算；不算时置 null（= 「没查」，不假装 0）。
  if (opts.scan) {
    let pending = 0;
    try {
      const diff = await diffLocalToPayload(cfg);
      // diff 按「逻辑分组」标记 channel；单仓库模式下按物理仓库 key 过滤
      const key = repoKeyOf(channel, cfg);
      pending = diff.added.filter(x => repoKeyOf(x.channel, cfg) === key).length
        + diff.removed.filter(x => repoKeyOf(x.channel, cfg) === key).length;
    } catch { pending = null; }
    out.pending = pending;
  } else {
    out.pending = null;
  }


  const dirty = await git(dir, ['status', '--porcelain', '-uno']);
  if (dirty.ok) out.dirty = dirty.out ? dirty.out.split('\n').filter(Boolean).length : 0;
  // 对外统一口径：unsynced = 仓库未提交 + 本机未暂存。两者都代表「还没同步上去」。
  // pending 为 null 表示本次没扫，就只报已知的 dirty（不把它当成 0 来粉饰）。
  out.unsynced = out.dirty + (out.pending || 0);
  out.scanned = out.pending !== null;
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
  if (surface.tier === 'danger') return false;
  if (!cfg.surfaces[surface.id]) return false;
  // 分组开关：单仓库模式下它是「同步哪一组」的唯一手段；双仓库模式下也生效，
  return true;
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

  // payload 每个物理仓库只扫一次，后面复用（避免重复 readdir 与重复哈希）。
  // 单仓库模式下只有一个 key（'all'），但 rel 路径不冲突，所以能共存于同一 payload。
  const payloadIndex = new Map();
  for (const key of channelsOf(cfg)) {
    const acc = [];
    await walkFiles(payloadDir(key, cfg), '', [], acc);
    const m = new Map();
    for (const item of acc) m.set(toPosix(item.rel), item);
    payloadIndex.set(key, m);
  }

  for (const f of files) {
    const sha = await fingerprint(f);
    const existing = (payloadIndex.get(repoKeyOf(f.channel, cfg)) || new Map()).get(f.rel);
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
  // payload 里有、本机没有，且属于某个启用面 → 需要从 payload 删除
  const present = new Set(files.map(f => `${repoKeyOf(f.channel, cfg)}\u0000${f.rel}`));
  const seen = new Set();
  for (const s of SURFACES) {
    if (!surfaceEnabled(s, cfg)) continue;
    const key = repoKeyOf(s.channel, cfg);
    const idx = payloadIndex.get(key);
    if (!idx) continue;
    for (const rel of idx.keys()) {
      if (present.has(`${key}\u0000${rel}`)) continue;
      if (!belongsTo(s, rel)) continue;
      const k = `${key}\u0000${rel}`;
      if (seen.has(k)) continue;
      seen.add(k);
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
  ensureRepoScaffold(repoDir('all', cfg));
  const diff = await diffLocalToPayload(cfg);
  const written = [];
  const deleted = [];
  const skipped = [];

  for (const a of diff.added) {
    if (opts.onlySurface && a.surface !== opts.onlySurface) {
      skipped.push(a.rel);
      continue;
    }
    const target = path.join(payloadDir(repoKeyOf(a.channel, cfg), cfg), a.rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(a.abs, target);
    written.push(a.rel);
  }

  for (const item of diff.removed) {
    if (opts.onlySurface && item.surface !== opts.onlySurface) continue;
    const target = path.join(payloadDir(repoKeyOf(item.channel, cfg), cfg), item.rel);
    if (fs.existsSync(target)) {
      await fsp.rm(target, { force: true });
      deleted.push(item.rel);
    }
  }

  await saveCache();

  for (const ch of channelsOf(cfg)) {
    const dir = repoDir(ch, cfg);
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
  for (const ch of channelsOf(cfg)) {
    const dir = repoDir(ch, cfg);
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
async function parseStamp(channel, cfg, { remoteOnly = false } = {}) {
  const dir = repoDir(channel, cfg);
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const br = branchOf(channel, cfg);
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
  for (const ch of channelsOf(cfg)) {
    const conf = { remote: remoteOf(ch, cfg) };
    const dir = repoDir(ch, cfg);
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
    const f = await fetchRemote(ch, conf.remote, cfg);
    if (!f.ok) {
      out[ch] = { ok: false, reason: `fetch-failed: ${f.error}` };
      continue;
    }
    if (!f.empty) {
      const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${f.branch || branchOf(ch, cfg)}`]);
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

    const brPush = f.branch || branchOf(ch, cfg);
    const r = await git(dir, ['push', '-u', 'origin', `${brPush}:${brPush}`], 180000);
    out[ch] = r.ok
      ? { ok: true, committed, output: r.err || r.out }
      : { ok: false, reason: r.err || r.out || 'push-failed' };
  }
  return out;
}

async function pullChannels(cfg) {
  const out = {};
  for (const ch of channelsOf(cfg)) {
    const conf = { remote: remoteOf(ch, cfg) };
    const dir = repoDir(ch, cfg);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      if (!conf.remote) {
        out[ch] = { ok: false, reason: 'no-remote' };
        continue;
      }
      const boot = await bootstrapFromRemote(ch, conf.remote, cfg);
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
      const boot = await bootstrapFromRemote(ch, conf.remote, cfg);
      out[ch] = boot.ok ? { ok: true, bootstrapped: true, boot } : { ok: false, reason: boot.error };
      continue;
    }
    if (!conf.remote) {
      out[ch] = { ok: false, reason: 'no-remote' };
      continue;
    }
    const f = await fetchRemote(ch, conf.remote, cfg);
    if (!f.ok) {
      out[ch] = { ok: false, reason: `fetch-failed: ${f.error}` };
      continue;
    }
    if (f.empty) {
      out[ch] = { ok: true, emptyRemote: true };
      continue;
    }
    const brPull = f.branch || branchOf(ch, cfg);
    const mb = await git(dir, ['merge', '--ff-only', `origin/${brPull}`]);
    out[ch] = mb.ok
      ? { ok: true, output: mb.out || 'up-to-date' }
      : { ok: false, reason: `需要人工处理（非快进）：${mb.err || mb.out}` };
  }
  return out;
}

/* ------------------------------------------------- 动作：分叉（diverged）处理
 * 场景：单位 A 和家里 B 都各自推过，两台都既领先又落后（rev-list 两边都 >0）。
 * 正常 /pull 会撞「非快进」然后失败，旧版只能人工进仓库手改。
 * 这里把「人工处理」产品化成两个显式选项（ADR-030：不做三方合并）：
 *
 *   keep-local   云覆盖本地语义的反面 = 以本机为准：先把本机 payload 全量提交，
 *                再 force-with-lease 推上去，远端被覆盖成本机样子。
 *   keep-remote  本地覆盖云语义的反面 = 以远端为准：reset --hard 到 origin/<br>
 *                （丢掉本机未同步的提交），再把 payload apply 回本机磁盘。
 *
 * 两个方向都先备份被覆盖的一方（backups/diverge-<ts>/），都可回滚。
 */

/** 看两个通道现在是否分叉（含预览）。只读，不改任何东西。 */
async function divergeInfo(cfg) {
  const channels = {};
  for (const ch of channelsOf(cfg)) {
    const conf = { remote: remoteOf(ch, cfg) };
    const dir = repoDir(ch, cfg);
    const st = { label: channelLabel(ch), initialized: fs.existsSync(path.join(dir, '.git')), remote: conf.remote || '', diverged: false, ahead: 0, behind: 0 };
    if (!st.initialized || !st.remote) { channels[ch] = st; continue; }
    const f = await fetchRemoteCached(ch, st.remote, cfg);
    const br = (f.ok && f.branch) || branchOf(ch, cfg);
    const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${br}`]);
    const m = counts.ok ? /^(\d+)\s+(\d+)/.exec(counts.out) : null;
    if (m) {
      st.ahead = Number(m[1]);
      st.behind = Number(m[2]);
      st.diverged = st.ahead > 0 && st.behind > 0;
    }
    if (st.diverged) {
      /* 各取双方独有的提交摘要（前 10 条），面板给用户看「到底在比什么」。 */
      const fmt = '--format=%h %cI %s';
      const ours = await git(dir, ['log', fmt, '-n', '10', `HEAD..origin/${br}`]).catch(() => null);
      const theirs = await git(dir, ['log', fmt, '-n', '10', `origin/${br}..HEAD`]).catch(() => null);
      // HEAD..origin = 远端有本地没有（我们要丢弃/接受的）；origin..HEAD = 本机独有的
      st.remoteOnly = (ours && ours.ok && ours.out ? ours.out : '').split('\n').filter(Boolean);
      st.localOnly = (theirs && theirs.ok && theirs.out ? theirs.out : '').split('\n').filter(Boolean);
    }
    channels[ch] = st;
  }
  const diverged = channelsOf(cfg).some(ch => channels[ch].diverged);
  return {
    ok: true,
    diverged,
    channels,
    hint: diverged
      ? '两台机器各自推过，普通拉取会失败。二选一：以本机为准（覆盖云）或以远端为准（覆盖本机）。两个方向都会先备份。'
      : '没有分叉，普通「拉取并应用」即可。',
  };
}

/* ============================================================================
 * 代码仓库同步（code repos）
 *
 * 与 config/sessions 两个通道**完全分离**：那两个是「运行时状态快照」，
 * 这里是「用户自己的 git 仓库」（dshplug 插件源码、base 工作区笔记等）。
 *
 * 为什么不塞进现有通道：
 *   1. 它们已经是 git 仓库，有自己的历史/分支/remote —— 塞进 payload 等于双重版本控制；
 *   2. 体积差一个量级（dshplug 50MB vs profiles 几MB），每次 stage 都太贵；
 *   3. 现有通道语义是「整目录快照覆盖」，而代码仓库要的是 pull --rebase 合并。
 *
 * 设计照 ccconfig lib/monitor.sh 的已验证做法（用户指定参考）：
 *   · 只处理**有改动**的仓库（先 status 后决定，空仓库不提交）；
 *   · push 前**必先 pull --rebase --autostash** —— 多机安全的根本；
 *   · 冲突则 rebase --abort，保留现场并报告，**绝不静默覆盖**；
 *   · 提交信息带改动文件摘要，不只留时间戳（历史可读性）。
 *
 * 刻意不做（与 ADR-028 同一取舍）：三方合并、自动解决冲突、force push。
 * ========================================================================== */

/** 仓库清单：cfg.codeRepos = [{ id, path, enabled, autoCommitMinutes, remote, branch }] */
function codeRepoList(cfg) {
  const list = Array.isArray(cfg && cfg.codeRepos) ? cfg.codeRepos : [];
  return list.filter(r => r && r.path);
}

/** 只读看一个代码仓库的本地事实：分支、是否有改动、领先/落后（全部不访网）。
 *
 *  性能要点（2026-11-19 实测）：Windows 上每条 git 命令的进程启动开销 ~80-120ms，
 *  与仓库大小无关。所以「少起进程」比「少读数据」重要得多。
 *  最初实现用了 7 条命令（branch/status/log/verify/rev-list/remote），
 *  两个仓库就是 14 次进程启动 ≈ 1.0s —— 侧边栏每 20s 轮询一次，代价太明显。
 *
 *  压到 2 条：
 *    · `status --porcelain -uall --branch` 首行 `## main...origin/main [ahead 2, behind 1]`
 *      已同时包含分支名、上游引用、领先/落后数和改动列表，一条顶四条；
 *    · `log -1` 单独留（历史摘要不在 status 里）。
 *  实测 1022ms → 约 250ms（两个仓库）。
 */
async function codeRepoState(repo) {
  const dir = repo.path;
  const out = {
    id: repo.id || dir,
    path: dir,
    enabled: repo.enabled !== false,
    exists: fs.existsSync(dir),
    initialized: false,
    branch: null,
    dirty: 0,
    unsynced: 0,
    ahead: 0,
    behind: 0,
    diverged: false,
    upstream: null,
    remote: repo.remote || '',
    autoCommitMinutes: Number(repo.autoCommitMinutes) || 0,
    lastCommit: null,
    error: null,
  };
  if (!out.exists) { out.error = '目录不存在'; return out; }
  out.initialized = fs.existsSync(path.join(dir, '.git'));
  if (!out.initialized) { out.error = '不是 git 仓库'; return out; }

  /* 一条命令拿齐：分支 / 上游 / 领先落后 / 全部改动。
     -uall 展开未跟踪目录，否则新建一个目录只报一行，看不出到底几个文件。
     注意 --branch 会把分支信息放在首行（`## ...`），其余行才是文件。 */
  const st = await git(dir, ['status', '--porcelain', '-uall', '--branch'], 15000);
  if (st.ok) {
    const all = st.out ? st.out.split('\n') : [];
    const head = all.length && all[0].startsWith('##') ? all.shift() : '';
    const files = all.filter(Boolean);
    out.dirty = files.length;
    out.unsynced = files.length;

    if (head) {
      /* 形态一：## main...origin/main [ahead 2, behind 1]
         形态二：## main...origin/main            （已同步，无中括号）
         形态三：## main                          （无上游）
         形态四：## HEAD (no branch)              （游离）
         形态五：## No commits yet on main        （空仓库，无提交）*/
      if (/^## HEAD \(no branch\)/.test(head)) {
        out.branch = null;
      } else {
        const m = /^## (?:No commits yet on )?([^\s.]+)/.exec(head);
        if (m) out.branch = m[1];
        const up = /\.\.\.(\S+)/.exec(head);
        if (up) out.upstream = up[1];
        const ab = /\[([^\]]+)\]/.exec(head);
        if (ab) {
          const a = /ahead (\d+)/.exec(ab[1]);
          const b = /behind (\d+)/.exec(ab[1]);
          if (a) out.ahead = Number(a[1]);
          if (b) out.behind = Number(b[1]);
        }
        /* 有上游但无中括号 = 完全对齐；有上游但本地有提交而无中括号不会发生，
           所以上面取到的 ahead/behind 就是准的。 */
        if (out.upstream && !ab) { out.ahead = 0; out.behind = 0; }
        if (!out.upstream) out.remoteMissing = true;
      }
      out.diverged = out.ahead > 0 && out.behind > 0;
    }
  } else {
    out.error = (st.err || 'git status 失败').slice(0, 200);
    return out;
  }

  /* 远端 URL 与最近提交互不依赖，并行跑：两个进程开销叠在一个往返里。
     URL 通常已缓存在配置里，那就只剩 log 一条。 */
  const [r, lg] = await Promise.all([
    out.remote ? Promise.resolve(null) : git(dir, ['remote', 'get-url', 'origin'], 8000),
    git(dir, ['log', '-1', '--format=%h %cI %s'], 8000),
  ]);
  if (r && r.ok && r.out) out.remote = r.out;
  if (lg.ok && lg.out) out.lastCommit = lg.out;

  /* 「没有远端」不是「已同步」（ADR-026 同型，第三次踩）。
     dw-base 就是这种情况：本地提交齐全、0 未提交、0 领先 0 落后，
     但因为从没配 origin，这个 0 毫无意义 —— 远端根本不存在。
     前端必须据此画「未连远端」而不是 ✓。 */
  if (!out.remote) out.remoteMissing = true;

  return out;
}

/** 汇总所有代码仓库（只读、不访网，可安全挂在轮询上）。
 *  仓库之间用 Promise.all 并发，互不依赖。 */
async function codeReposPayload(cfg) {
  const list = codeRepoList(cfg);
  const repos = await Promise.all(list.map(r => codeRepoState(r).catch(e => ({
    id: r.id || r.path, path: r.path, enabled: r.enabled !== false,
    exists: true, initialized: false, error: String(e && e.message || e),
    unsynced: 0, ahead: 0, behind: 0, diverged: false,
  }))));
  const active = repos.filter(r => r.enabled);
  return {
    ok: true,
    at: new Date().toISOString(),
    fetched: false,
    total: active.length,
    dirty: active.reduce((n, r) => n + (r.unsynced || 0), 0),
    ahead: active.reduce((n, r) => n + (r.ahead || 0), 0),
    behind: active.reduce((n, r) => n + (r.behind || 0), 0),
    diverged: active.some(r => r.diverged),
    /* 自动提交设置随 payload 下发，前端不用再求一次 /config。 */
    auto: {
      enabled: cfg.codeRepoAutoEnabled === true,
      minutes: Number(cfg.codeRepoAutoMinutes) || 0,
    },
    repos,
  };
}

/**
 * 同步一个代码仓库：add → commit（有改动才）→ pull --rebase --autostash → push。
 *
 * 顺序要点（照 monitor.sh，但这里更保守）：
 *   · **先 commit 再 pull**：本地有未提交改动时直接 pull 会因 dirty 失败；
 *     先固化成提交，rebase 才有东西可搬，--autostash 只当兜底。
 *   · pull 用 --rebase 而非 merge：多机各自提交时不会产生「Merge branch」垃圾提交。
 *   · 冲突立刻 rebase --abort 并返回，不尝试自动解决 —— 代码冲突必须人看。
 */
async function syncCodeRepo(cfg, repo, opts = {}) {
  const dir = repo.path;
  const res = { id: repo.id || dir, path: dir, ok: true, steps: [], committed: null, pushed: false, pulled: null, message: null };
  const fail = (step, detail) => { res.ok = false; res.steps.push({ id: step, ok: false, detail }); return res; };

  if (!fs.existsSync(dir)) return fail('check', '目录不存在：' + dir);
  if (!fs.existsSync(path.join(dir, '.git'))) return fail('check', '不是 git 仓库：' + dir);

  /* 冲突残留会让后续 add 悄悄留下未合并状态，必须先拦。 */
  const unmerged = await git(dir, ['ls-files', '-u'], 10000);
  if (unmerged.ok && unmerged.out) {
    return fail('check', '仓库里有未解决的冲突（git ls-files -u 非空），先手工解决再同步');
  }

  /* 同 codeRepoState：空仓库（无提交）上 abbrev-ref 返回 `HEAD`，
     必须用 symbolic-ref 兼得分支名，否则刚 init 的仓库会被误判为游离 HEAD。 */
  let branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], 8000)).out || '';
  if (!branch || branch === 'HEAD') {
    const sr = await git(dir, ['symbolic-ref', '--short', 'HEAD'], 8000);
    if (sr.ok && sr.out) branch = sr.out;
  }
  if (branch === 'HEAD' || !branch) return fail('check', '无法确定当前分支（游离 HEAD 或仓库损坏），先 git checkout 到具体分支');

  /* ── 1) 暂存 + 提交（只有真的有改动才提交）── */
  const before = await git(dir, ['status', '--porcelain', '-uall'], 15000);
  const dirtyLines = before.ok && before.out ? before.out.split('\n').filter(Boolean) : [];
  if (dirtyLines.length) {
    const added = await git(dir, ['add', '-A'], 20000);
    if (!added.ok) return fail('add', added.err || 'git add 失败');

    /* 提交信息带文件摘要：只留时间戳等于把「改了什么」全丢掉（monitor.sh 踩过）。 */
    const staged = await git(dir, ['diff', '--cached', '--name-only'], 15000);
    const files = staged.ok && staged.out ? staged.out.split('\n').filter(Boolean) : [];
    const subject = opts.message || `synchub: ${path.basename(dir)} 自动提交 ${files.length} 个文件`;
    const body = files.slice(0, 12).map(f => '  ' + f).join('\n')
      + (files.length > 12 ? `\n  …还有 ${files.length - 12} 个` : '');
    const msg = files.length ? `${subject}\n\n${body}` : subject;

    const cm = await git(dir, ['commit', '-m', msg], 30000);
    if (!cm.ok) {
      if (/nothing to commit|no changes added/i.test((cm.out || '') + (cm.err || ''))) {
        res.steps.push({ id: 'commit', ok: true, detail: '没有可提交的改动（可能被 .gitignore 忽略）' });
      } else {
        return fail('commit', cm.err || cm.out || 'git commit 失败');
      }
    } else {
      const h = (await git(dir, ['rev-parse', '--short', 'HEAD'], 8000)).out;
      res.committed = h;
      res.steps.push({ id: 'commit', ok: true, detail: `已提交 ${h}（${files.length} 个文件）` });
    }
  } else {
    res.steps.push({ id: 'commit', ok: true, detail: '工作区本来就没有改动' });
  }

  /* ── 2) pull --rebase --autostash：push 前必做 ── */
  const hasRemote = (await git(dir, ['remote', 'get-url', 'origin'], 8000)).ok;
  if (!hasRemote) {
    res.steps.push({ id: 'pull', ok: true, detail: '没有 origin 远端，只做本地提交' });
    res.steps.push({ id: 'push', ok: true, detail: '无远端，跳过推送' });
    res.message = res.committed ? `已提交 ${res.committed}（本地仓库，无远端）` : '本地无改动';
    return res;
  }

  const pl = await git(dir, ['pull', '--rebase', '--autostash', 'origin', branch], 60000);
  if (!pl.ok) {
    /* 冲突：abort 保现场，原样上报。绝不自动 resolve —— 代码冲突要人看。 */
    const inRebase = fs.existsSync(path.join(dir, '.git', 'rebase-merge'))
      || fs.existsSync(path.join(dir, '.git', 'rebase-apply'));
    if (inRebase) {
      await git(dir, ['rebase', '--abort'], 15000);
      res.steps.push({ id: 'pull', ok: false, detail: 'pull 有冲突，已 rebase --abort 恢复现场（本地提交完好，需人工处理）' });
      res.message = '分叉冲突：已中止 rebase，未推送。';
      return res;
    }
    const txt = (pl.out || '') + (pl.err || '');
    if (/couldn't find remote ref|no such ref|unknown revision/i.test(txt)) {
      res.steps.push({ id: 'pull', ok: true, detail: '远端还没有该分支（首次推送）' });
    } else {
      res.steps.push({ id: 'pull', ok: false, detail: (pl.err || pl.out || 'pull 失败').slice(0, 300) });
      res.message = 'pull 失败，未推送（避免造成分叉）。';
      return res;
    }
  } else {
    const upToDate = /Already up[ -]to[ -]date|is up to date/i.test(pl.out || '');
    res.pulled = upToDate ? 0 : (pl.out || '').split('\n').filter(Boolean).length;
    res.steps.push({ id: 'pull', ok: true, detail: upToDate ? '已是最新' : '已 rebase 到远端最新' });
  }

  /* ── 3) push ── */
  const ps = await git(dir, ['push', 'origin', branch], 60000);
  if (!ps.ok) {
    const txt = (ps.out || '') + (ps.err || '');
    if (/everything up-to-date|up to date/i.test(txt)) {
      res.steps.push({ id: 'push', ok: true, detail: '远端已是最新' });
    } else {
      return fail('push', (ps.err || ps.out || 'push 失败').slice(0, 300));
    }
  } else {
    res.pushed = true;
    res.steps.push({ id: 'push', ok: true, detail: `已推送到 origin/${branch}` });
  }

  res.message = res.committed
    ? `已提交 ${res.committed} 并推送`
    : (res.pulled ? '无新改动，已整合远端提交' : '已是最新');
  return res;
}

/** 同步全部启用中的代码仓库（逐个，单个失败不影响其他）。 */
async function syncAllCodeRepos(cfg, opts = {}) {
  const list = codeRepoList(cfg).filter(r => r.enabled !== false);
  const targets = opts.id ? list.filter(r => (r.id || r.path) === opts.id) : list;
  const results = [];
  for (const r of targets) {
    try {
      results.push(await syncCodeRepo(cfg, r, opts));
    } catch (e) {
      results.push({ id: r.id || r.path, path: r.path, ok: false, steps: [], message: String(e.message || e) });
    }
  }
  return { ok: results.every(r => r.ok), at: new Date().toISOString(), count: results.length, results };
}

/** 以本机为准：全量 stage+commit 后 force-with-lease 推送，远端变成本机样子。 */
async function resolveKeepLocal(cfg) {
  const out = { ok: true, mode: 'keep-local', channels: {} };
  await stageChanges(cfg);
  const backupDir = path.join(BACKUP_ROOT, 'diverge-' + new Date().toISOString().replace(/[:.]/g, '-'));
  for (const ch of channelsOf(cfg)) {
    const conf = { remote: remoteOf(ch, cfg) };
    const dir = repoDir(ch, cfg);
    if (!conf.remote || !fs.existsSync(path.join(dir, '.git'))) { out.channels[ch] = { ok: true, skipped: true }; continue; }
    const f = await fetchRemote(ch, conf.remote, cfg);
    const br = (f.ok && f.branch) || branchOf(ch, cfg);
    // 备份远端侧被覆盖前的提交，便于事后找回（不做 git 层面的分支保留，简单直接）
    const remoteLog = await git(dir, ['log', '--format=%H', '-n', '50', `origin/${br}`]);
    if (remoteLog.ok && remoteLog.out) {
      await fsp.mkdir(backupDir, { recursive: true });
      await fsp.writeFile(path.join(backupDir, `${ch}-remote-heads.txt`), remoteLog.out, 'utf8');
    }
    const st = await git(dir, ['status', '--porcelain', '-uno']);
    if (st.ok && st.out) {
      const c = await git(dir, ['commit', '-m', `synchub: keep-local @ ${new Date().toISOString()}` + stampTrailer(cfg)]);
      if (!c.ok) { out.channels[ch] = { ok: false, reason: c.err || c.out }; continue; }
    }
    const r = await git(dir, ['push', '--force-with-lease', 'origin', `${br}:${br}`], 180000);
    out.channels[ch] = r.ok ? { ok: true, pushed: true } : { ok: false, reason: r.err || r.out };
  }
  out.ok = Object.values(out.channels).every(v => v.ok);
  return out;
}

/** 以远端为准：reset --hard 到 origin/<br>，再把 payload 落回本机磁盘（含备份）。 */
async function resolveKeepRemote(cfg, opts = {}) {
  const out = { ok: true, mode: 'keep-remote', channels: {}, applied: null };
  for (const ch of channelsOf(cfg)) {
    const conf = { remote: remoteOf(ch, cfg) };
    const dir = repoDir(ch, cfg);
    if (!conf.remote || !fs.existsSync(path.join(dir, '.git'))) { out.channels[ch] = { ok: true, skipped: true }; continue; }
    const f = await fetchRemote(ch, conf.remote, cfg);
    if (!f.ok || f.empty) { out.channels[ch] = { ok: false, reason: f.ok ? 'remote-empty' : `fetch-failed: ${f.error}` }; continue; }
    const br = f.branch || branchOf(ch, cfg);
    // 丢弃前把本机独有提交的哈希留下来（万一反悔还能从 reflog 找回）
    const localLog = await git(dir, ['log', '--format=%H', '-n', '50', `origin/${br}..HEAD`]);
    const backupDir = path.join(BACKUP_ROOT, 'diverge-' + new Date().toISOString().replace(/[:.]/g, '-'));
    if (localLog.ok && localLog.out) {
      await fsp.mkdir(backupDir, { recursive: true });
      await fsp.writeFile(path.join(backupDir, `${ch}-local-heads.txt`), localLog.out, 'utf8');
    }
    const r = await git(dir, ['reset', '--hard', `origin/${br}`]);
    out.channels[ch] = r.ok ? { ok: true, reset: true } : { ok: false, reason: r.err || r.out };
  }
  out.ok = Object.values(out.channels).every(v => v.ok);
  if (out.ok) out.applied = await applyPayload(cfg, { prune: opts.prune === true, force: true });
  return out;
}

/* --------------------------------------------------------- 动作：apply 到本机 */

/**
 * 把 payload 写回 $DSH_HOME。
 * - 覆盖/删除前一律备份到 backups/<ts>/
 * - 跳过当前正在写入的会话：DSH_SESSION_ID 有值时按路径跳过；但插件宿主进程里
 *   这个变量通常是空的（实测桌面版 activeSession 一直是 null），所以真正的保护
 *   是下面的内容守卫——payload 是本机日志的前缀（本机更新）时绝不覆盖。
 */
/** 会话日志（session.v4.jsonl.zstd）的 rel 判定。 */
function isSessionLogRel(rel) {
  return rel.startsWith('sessions/') && rel.endsWith('session.v4.jsonl.zstd');
}

/**
 * apply 前的会话日志守卫（ADR-043）。
 *
 * 背景：一次真实故障里，`/sync` 的 apply 把停滞的 payload（seq 0..1171）盖到正在
 * 写入的本机日志（seq 0..1368）上；DSH 内存里还记着 lastSeq=1368，继续往下写
 * 1369..，磁盘上就成了 0..1171 + 1369.. 的断口日志，历史直接打不开。
 * `DSH_SESSION_ID` 在宿主进程里是空的，skipActive 形同虚设，必须做内容判断。
 *
 * 判据（只读，不解不成不猜）：
 *   ① payload 解不开 → 跳过（不把坏 payload 盖到本机）；
 *   ② payload 有 seq 断口 → 跳过（坏数据不外传）；
 *   ③ payload 明文是本机的严格前缀 → 本机更新，跳过（随后 stage 会把本机推上去）；
 *   ④ 本机解不开、payload 正常 → 放行（让 payload 修本机）；
 *   ⑤ 其余（payload 更新 / 分叉）→ 放行，沿用既有「接力覆盖」语义。
 *
 * @param {string} localAbs 本机文件绝对路径
 * @param {string} payloadAbs payload 文件绝对路径
 * @returns {{skip:boolean, reason:string}}
 */
function sessionLogApplyGuard(localAbs, payloadAbs) {
  const payload = decodeSessionLog(payloadAbs);
  if (!payload.ok) return { skip: true, reason: `payload 无法解码：${payload.error}` };
  const gaps = sessionLogSeqGaps(payload.plaintext);
  if (gaps.gaps.length) return { skip: true, reason: `payload 有 seq 断口（${gaps.gaps.length} 处）` };
  const local = decodeSessionLog(localAbs);
  if (!local.ok) return { skip: false, reason: '' };
  const lp = local.plaintext;
  const pp = payload.plaintext;
  if (lp.length > pp.length && lp.subarray(0, pp.length).equals(pp)) {
    return { skip: true, reason: '本机日志更新（payload 是本机的前缀），跳过以免覆盖活日志' };
  }
  return { skip: false, reason: '' };
}

async function applyPayload(cfg, opts = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUP_ROOT, stamp);
  const written = [];
  const deleted = [];
  const skipped = [];
  const guarded = [];
  let backedUp = 0;

  const skipActive = rel => Boolean(ACTIVE_SESSION) && rel.includes(ACTIVE_SESSION);

  for (const s of SURFACES) {
    if (!surfaceEnabled(s, cfg)) continue;
    if (opts.onlySurface && s.id !== opts.onlySurface) continue;
    const base = payloadDir(repoKeyOf(s.channel, cfg), cfg);
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
        if (!opts.force && isSessionLogRel(rel)) {
          const guard = sessionLogApplyGuard(dest, item.abs);
          if (guard.skip) {
            skipped.push(rel);
            guarded.push({ rel, reason: guard.reason });
            continue;
          }
        }
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
      const base = payloadDir(repoKeyOf(s.channel, cfg), cfg);
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
    guarded: guarded.slice(0, 50),
    backedUp,
    backupDir: written.length || deleted.length ? backupDir : null,
    sample: written.slice(0, 20),
  };
}

/* ------------------------------------------- ADR-005 受控会话删除 purgeSession
 * 手工删 .zstd 会留下 workspace.json 悬空引用 + projcache + 搜索索引不一致
 * （ADR-004 §4.4）。本实现把「物理目录 + workspace.json 所有引用 + projcache」
 * 一次改完，并保留回滚点。搜索索引是 DSH 自己的 SQLite FTS5 派生库，会在
 * 下次检索时对照持久化层自动重建（源码：dsh-session-query-sqlite._reconcile），
 * 因此不直接写它——在 DSH 运行时改活库反而危险。 */

function bareSessionId(id) {
  return String(id || '').trim().replace(/^session-/, '');
}

/** 一个会话 id 的两种写法都要认：登记表里是 session-<uuid>，projcache 文件名是裸 uuid。 */
function sessionIdForms(id) {
  const bare = bareSessionId(id);
  const s = new Set([bare]);
  if (!String(id || '').startsWith('session-')) s.add(`session-${bare}`);
  else s.add(String(id).trim());
  return s;
}

/**
 * 递归找出（可选：剔除）一个 JSON 树里所有等于该会话 id 的数组元素，
 * 并返回命中的 JSON 路径。这样「workspace.json 四处引用」不依赖写死字段名，
 * 也不怕 unit.version 升级后多出/改名了某个数组。
 */
function walkSessionRefs(node, ids, at, found, mutate) {
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const child = node[i];
      if (typeof child === 'string' && ids.has(child)) {
        found.push(at);
        if (mutate) node.splice(i, 1);
      } else if (child && typeof child === 'object') {
        walkSessionRefs(child, ids, `${at}[${i}]`, found, mutate);
      }
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') walkSessionRefs(v, ids, `${at}.${k}`, found, mutate);
    }
  }
  return found;
}

function projCacheFile(id) {
  return path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${bareSessionId(id)}.json`);
}

async function findSessionDirs(id) {
  const ids = sessionIdForms(id);
  const dirs = [];
  const root = path.join(DSH_HOME, 'sessions');
  let groups = [];
  try { groups = await fsp.readdir(root, { withFileTypes: true }); } catch { return dirs; }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const gp = path.join(root, g.name);
    let entries = [];
    try { entries = await fsp.readdir(gp, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isDirectory() && ids.has(ent.name)) dirs.push(path.join(gp, ent.name));
    }
  }
  return dirs;
}

async function dirSize(dir) {
  const acc = [];
  await walkFiles(dir, '', [], acc);
  return { files: acc.length, bytes: acc.reduce((a, f) => a + (f.size || 0), 0) };
}

/** 「校验静止」：当前会话 / 30 秒内有写入 / projcache 里有未结束的 turn、step、工具调用、子代理都拒绝。 */
async function assertSessionQuiet(id, dirs) {
  if (ACTIVE_SESSION && sessionIdForms(id).has(ACTIVE_SESSION)) {
    return '目标就是当前会话（DSH_SESSION_ID），拒绝删除';
  }
  const now = Date.now();
  for (const d of dirs) {
    let st;
    try { st = await fsp.stat(path.join(d, 'session.v4.jsonl.zstd')); } catch { /* 正文可能缺 */ }
    if (st && now - st.mtimeMs < 30_000) return '会话日志 30 秒内有写入，可能正在运行，请稍后再试';
  }
  let raw;
  try { raw = JSON.parse(await fsp.readFile(projCacheFile(id), 'utf8')); } catch { return null; }
  const rows = (raw && raw.record && raw.record.rows) || {};
  const tb = rows.turnBoundary && rows.turnBoundary.val;
  if (tb && tb.openTurnStartSeq != null) return '投影缓存显示该会话有未结束的 turn';
  const stats = rows.sessionStats && rows.sessionStats.val;
  if (stats && stats.openStep != null) return '投影缓存显示该会话有未结束的 step';
  if (stats && stats.pendingCalls && Object.keys(stats.pendingCalls).length) {
    return '投影缓存显示该会话有待返回的工具调用';
  }
  for (const [k, v] of Object.entries(rows)) {
    if (!/subagent|job|schedule|timer/i.test(k)) continue;
    const val = v && v.val;
    if (val && typeof val === 'object') {
      const flag = val.active ?? val.running ?? val.status;
      if (flag === true || flag === 'running' || flag === 'active') {
        return `投影缓存显示该会话有运行中的 ${k}`;
      }
    }
  }
  return null;
}

async function workspaceRefs(id, mutate) {
  const file = path.join(DSH_HOME, 'storages', 'workspace.json');
  let doc;
  try { doc = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { return { error: `workspace.json 无法解析：${e.message}`, paths: [] }; }
  const paths = walkSessionRefs(doc, sessionIdForms(id), '$', [], mutate);
  return { file, doc, paths };
}

async function purgePreview(id) {
  if (!bareSessionId(id)) return { ok: false, error: '缺少 sessionId' };
  const dirs = await findSessionDirs(id);
  const sizes = await Promise.all(dirs.map(dirSize));
  const ref = await workspaceRefs(id, false);
  const pc = projCacheFile(id);
  const quiet = await assertSessionQuiet(id, dirs);
  return {
    ok: true,
    id,
    quiet: !quiet,
    quietReason: quiet || null,
    physical: dirs.map((d, i) => ({ path: d, ...sizes[i] })),
    workspaceRefs: ref.paths,
    workspaceError: ref.error || null,
    projcache: fs.existsSync(pc) ? pc : null,
    totalBytes: sizes.reduce((a, s) => a + s.bytes, 0),
    // 搜索索引不直接改：它是派生库，删掉正文后下次检索会自动重建。
    searchIndex: 'derived · DSH 下次检索按持久化层自动重建（不直接写活库）',
    needsConfirm: true,
    confirmWith: id,
  };
}

async function purgeExecute(id, confirm) {
  const pre = await purgePreview(id);
  if (!pre.ok) return pre;
  if (confirm !== id) {
    return { ...pre, ok: false, error: `需要二次确认：confirm 必须等于 sessionId（${id}）`, needsConfirm: true };
  }
  if (!pre.quiet) return { ...pre, ok: false, error: `会话未静止，拒绝删除：${pre.quietReason}` };
  if (!pre.physical.length && !pre.workspaceRefs.length && !pre.projcache) {
    return { ...pre, ok: false, error: '没有找到该会话的任何痕迹，什么都没做' };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackDir = path.join(BACKUP_ROOT, `purge-${stamp}-${bareSessionId(id)}`);
  const manifest = { at: new Date().toISOString(), id, version: VERSION, kind: 'purgeSession', files: [], dirs: [], refs: pre.workspaceRefs };

  // ① 全量备份：正文目录整棵 + workspace.json + projcache，逐字节复制到回滚点。
  for (const item of pre.physical) {
    const d = item.path;
    const rel = path.relative(DSH_HOME, d);
    const to = path.join(rollbackDir, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.cp(d, to, { recursive: true });
    manifest.dirs.push(rel);
  }
  const wsFile = path.join(DSH_HOME, 'storages', 'workspace.json');
  if (fs.existsSync(wsFile)) {
    await fsp.mkdir(path.join(rollbackDir, 'storages'), { recursive: true });
    await fsp.copyFile(wsFile, path.join(rollbackDir, 'storages', 'workspace.json'));
    manifest.files.push('storages/workspace.json');
  }
  if (pre.projcache) {
    const rel = path.relative(DSH_HOME, pre.projcache);
    const to = path.join(rollbackDir, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(pre.projcache, to);
    manifest.files.push(rel);
  }

  // ② 原子改 workspace.json：先写临时文件再 rename（Windows 上 rename 会替换已存在文件）。
  const ref = await workspaceRefs(id, true);
  if (ref.error) return { ...pre, ok: false, error: ref.error, rollbackDir };
  const tmp = `${wsFile}.purge-tmp-${stamp}`;
  await fsp.writeFile(tmp, JSON.stringify(ref.doc, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, wsFile);

  // ③ 删 projcache 一行（一个文件）与正文目录。
  if (pre.projcache) await fsp.rm(pre.projcache, { force: true });
  for (const item of pre.physical) await fsp.rm(item.path, { recursive: true, force: true });

  // ④ 回滚点说明书：默认保留，不自动清理。
  await fsp.writeFile(path.join(rollbackDir, 'rollback.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(rollbackDir, 'RESTORE.md'),
    `# purgeSession 回滚点\n\n` +
    `- 会话 id：${id}\n- 备份时间：${manifest.at}\n\n` +
    `在 DSH **完全退出**时，把本目录里的内容按相对路径复制回 $DSH_HOME 即可恢复：\n\n` +
    '```powershell\n' +
    `$rb = '${rollbackDir}'\n` +
    `$dsh = $env:USERPROFILE + '\\.dsh'\n` +
    `Copy-Item \"$rb\\storages\\workspace.json\" \"$dsh\\storages\\workspace.json\" -Force\n` +
    `Copy-Item \"$rb\\sessions\\*\" \"$dsh\\sessions\" -Recurse -Force\n` +
    `Copy-Item \"$rb\\storages\\session_projcache\\sessions\\*\" \"$dsh\\storages\\session_projcache\\sessions\" -Force\n` +
    '```\n\n恢复后重启 DSH；搜索索引会自行重建。\n',
    'utf8');

  // ⑤ 指纹缓存失效：下一次 stage 会把「本机已删」识别成 payload 的 removed。
  cache = {};
  await saveCache();

  return {
    ok: true,
    id,
    removed: {
      dirs: pre.physical.map(p => p.path),
      workspaceRefPaths: ref.paths,
      projcache: Boolean(pre.projcache),
    },
    rollbackDir,
    restartRequired: true,
    verifyHint: `重启 DSH 后调用 GET /api/dsh-synchub/purge-session?id=${encodeURIComponent(id)} 验收`,
    note: '同步镜像里仍留有该会话；默认只增不删，需显式 prune 才会从远端仓库移除（ADR-001 规则二）。',
  };
}

async function purgeVerify(id) {
  if (!bareSessionId(id)) return { ok: false, error: '缺少 sessionId' };
  const dirs = await findSessionDirs(id);
  const ref = await workspaceRefs(id, false);
  const pc = fs.existsSync(projCacheFile(id));
  const checks = {
    physicalGone: dirs.length === 0,
    workspaceRefsGone: ref.paths.length === 0,
    projcacheGone: !pc,
    searchIndex: 'self-healing (not a durable store here)',
  };
  const clean = checks.physicalGone && checks.workspaceRefsGone && checks.projcacheGone;
  return { ok: true, id, clean, checks, remainingRefs: ref.paths, workspaceError: ref.error || null };
}

/* ──────────────────────────────────────────────────────────────────────────────
   会话迁移：把一个会话从 A 工作区搬到 B 工作区（跨机器改名/改路径后的必修课）

   为什么需要它：
     用户把 C:\dsh\base 改名成 C:\dsh\dw-base 后，旧工作区的登记条目消失了，
     但 sessions\--C-dsh-base--\ 下的会话正文还在。于是侧边栏把这些会话显示成
     「未分组」—— 数据没丢，是「归属」丢了。

     DSH 里会话归属有两处，必须一起改，缺一处就半残：
       ① workspace.json  tables.workspaces[wsId].sessionIds   ← 侧边栏按这个分组
       ② sessions\<组目录>\<会话id>\                          ← 正文按这个存

     `--C-dsh-base--` 这种组目录名是**路径编码**：盘符和分隔符都换成 `-`。
     迁移 = 正文搬目录 + workspace.json 里从一个 sessionIds 移到另一个。

   与 purge 的相同纪律（ADR-004）：
     · 先全量备份到回滚点，再由用户 confirm 才动手；
     · 目标已存在同 id 会话时**拒绝**，不覆盖；
     · 会话仍在写入（30 秒内 / 未结束 turn）时拒绝，避免搬走正在写的数据；
     · 只用 workspace.json 作为归属权威，不猜。
   ────────────────────────────────────────────────────────────────────────────── */

/** 把工作区绝对路径编码成 sessions 下的组目录名（DSH 的实际规则）。
 *  实测：C:\dsh\base → `--C-dsh-base--`
 *  规则：`--` + 路径里 `:` `\` `/` 全换成 `-` + `--`。 */
function encodeWorkspaceGroup(wsPath) {
  if (!wsPath || typeof wsPath !== 'string') return null;
  const body = wsPath.replace(/^[A-Za-z]:/, m => m[0]) /* 保留盘符字母 */
    .replace(/[:\\/]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `--${body}--`;
}

/** 反解组目录名（仅在需要提示用户时用，不做权威判断）。 */
function decodeWorkspaceGroup(name) {
  const m = /^--(.+)--$/.exec(name || '');
  if (!m) return null;
  return m[1];
}

/** 读 workspace.json 的 workspaces 表：{ [id]: {path,title,sessionIds,...} } */
async function readWorkspaceDoc() {
  const file = path.join(DSH_HOME, 'storages', 'workspace.json');
  let doc;
  try { doc = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { return { ok: false, file, error: `workspace.json 无法解析：${e.message}` }; }
  const table = (doc && doc.tables && doc.tables.workspaces) || {};
  return { ok: true, file, doc, table };
}

/** 只读预演：说清「现在在哪、要搬到哪、会动哪些文件」。 */
async function sessionMigratePreview(id, toName) {
  if (!bareSessionId(id)) return { ok: false, error: '缺少合法的 sessionId' };
  const dirs = await findSessionDirs(id);
  if (!dirs.length) return { ok: false, error: '找不到这个会话的正文目录（可能已被删除）' };

  const ws = await readWorkspaceDoc();
  if (!ws.ok) return { ok: false, error: ws.error };

  /* 当前归属：在哪个 workspace 的 sessionIds 里 */
  const ids = sessionIdForms(id);
  const from = [];
  const to = [];
  for (const [wsId, rec] of Object.entries(ws.table)) {
    if (!rec || !Array.isArray(rec.sessionIds)) continue;
    if (rec.sessionIds.some(s => ids.has(s))) from.push({ wsId, path: rec.path, title: rec.title });
  }
  for (const [wsId, rec] of Object.entries(ws.table)) {
    if (!rec) continue;
    if (String(rec.title || '').toLowerCase() === String(toName || '').toLowerCase()
      || String(rec.path || '') === String(toName || '')) {
      to.push({ wsId, path: rec.path, title: rec.title });
    }
  }
  if (to.length !== 1) {
    return {
      ok: false,
      error: to.length ? `目标工作区名不唯一：命中 ${to.length} 个` : `找不到名为「${toName}」的工作区（先在 DSH 里打开它一次，让它被登记）`,
      from,
    };
  }

  const target = to[0];
  const targetGroup = path.join(DSH_HOME, 'sessions', encodeWorkspaceGroup(target.path));
  const already = fs.existsSync(path.join(targetGroup, path.basename(dirs[0])));
  const quiet = await assertSessionQuiet(id, dirs);

  return {
    ok: true,
    id,
    from,
    to: target,
    fromDir: dirs[0],
    toDir: path.join(targetGroup, path.basename(dirs[0])),
    targetGroup,
    alreadyThere: already,
    quiet: !quiet,
    quietReason: quiet || null,
    projcache: projCacheFile(id),
    steps: [
      '备份 workspace.json + 会话正文目录到回滚点',
      `正文目录搬到 ${encodeWorkspaceGroup(target.path)}`,
      `workspace.json 里从 ${from.map(f => f.title).join('/') || '（未分组）'} 的 sessionIds 移到 ${target.title}`,
      'projcache 里的 cwd 不改（它是缓存，DSH 会自愈）',
    ],
    needsConfirm: true,
  };
}

/** 执行迁移。必须带 confirm='MOVE'。 */
async function sessionMigrateExecute(id, toName, confirm) {
  if (confirm !== 'MOVE') return { ok: false, error: "需要二次确认：请求体带 confirm:'MOVE'" };
  const pre = await sessionMigratePreview(id, toName);
  if (!pre.ok) return pre;
  if (!pre.quiet) return { ok: false, error: `会话仍在使用中：${pre.quietReason}` };
  if (pre.alreadyThere) return { ok: false, error: '目标位置已有同 id 会话，拒绝覆盖' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackDir = path.join(BACKUP_ROOT, `move-${stamp}-${bareSessionId(id)}`);
  const result = { ok: true, id, to: pre.to, from: pre.from, moved: false, rollbackDir, wrote: [] };

  /* ① 回滚点：workspace.json 与正文目录都留一份，逐字节复制。 */
  await fsp.mkdir(path.join(rollbackDir, 'storages'), { recursive: true });
  await fsp.copyFile(path.join(DSH_HOME, 'storages', 'workspace.json'),
    path.join(rollbackDir, 'storages', 'workspace.json'));
  result.wrote.push('storages/workspace.json');

  const bodyDest = path.join(rollbackDir, 'session-body', path.basename(pre.fromDir));
  await fsp.cp(pre.fromDir, bodyDest, { recursive: true });
  result.wrote.push('session-body/' + path.basename(pre.fromDir));

  /* ② 搬正文目录：先复制到目标组，成功后再删源。
     直接 rename 跨盘/跨组都可能失败；复制-校验-删除最稳，且中途失败源还在。 */
  await fsp.mkdir(pre.targetGroup, { recursive: true });
  await fsp.cp(pre.fromDir, pre.toDir, { recursive: true });
  const srcSize = await dirSize(pre.fromDir);
  const dstSize = await dirSize(pre.toDir);
  if (srcSize.bytes !== dstSize.bytes || srcSize.files !== dstSize.files) {
    return { ok: false, error: `复制校验失败（源 ${srcSize.files} 文件/${srcSize.bytes}B，目标 ${dstSize.files}/${dstSize.bytes}）；源目录已保留，未做任何删除`, rollbackDir };
  }
  await fsp.rm(pre.fromDir, { recursive: true, force: true });
  result.moved = true;

  /* ③ 改 workspace.json 的归属：从旧工作区移除、加进目标工作区。
     用 walkSessionRefs 的一般化思路只碰 sessionIds 数组，其余字段一律不动。 */
  const ids = sessionIdForms(id);
  const ws = await readWorkspaceDoc();
  if (!ws.ok) return { ok: false, error: ws.error, rollbackDir, moved: true };
  let touched = 0;
  for (const [wsId, rec] of Object.entries(ws.table)) {
    if (!rec || !Array.isArray(rec.sessionIds)) continue;
    const before = rec.sessionIds.length;
    rec.sessionIds = rec.sessionIds.filter(s => {
      /* 目标工作区保留，其他工作区一律剔除（同一会话不该同时挂在两处）。 */
      if (wsId === pre.to.wsId) return true;
      return !ids.has(s);
    });
    if (rec.sessionIds.length !== before) touched++;
    if (wsId === pre.to.wsId && !rec.sessionIds.some(s => ids.has(s))) {
      rec.sessionIds.push(id.startsWith('session-') ? id : `session-${bareSessionId(id)}`);
      touched++;
    }
  }
  rec_updatedAt(ws.doc, pre.to.wsId);
  const tmp = ws.file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(ws.doc, null, 2), 'utf8');
  await fsp.rename(tmp, ws.file);
  result.workspaceTouched = touched;

  return { ...result, verify: await sessionMigrateVerify(id, pre.to.wsId) };
}

/** 附注：更新目标工作区的 updatedAt（其它字段一律不动）。 */
function rec_updatedAt(doc, wsId) {
  const t = doc && doc.tables && doc.tables.workspaces && doc.tables.workspaces[wsId];
  if (t) t.updatedAt = new Date().toISOString();
}

/** 验收：正文在新组、workspace.json 只挂在目标、projcache 还在。 */
async function sessionMigrateVerify(id, toWsId) {
  const dirs = await findSessionDirs(id);
  const ws = await readWorkspaceDoc();
  const ids = sessionIdForms(id);
  const owners = [];
  if (ws.ok) {
    for (const [wsId, rec] of Object.entries(ws.table)) {
      if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.some(s => ids.has(s))) owners.push({ wsId, title: rec.title });
    }
  }
  const expect = ws.ok && ws.table[toWsId] ? ws.table[toWsId].path : null;
  const want = expect ? path.join(DSH_HOME, 'sessions', encodeWorkspaceGroup(expect)) : null;
  const inRightGroup = Boolean(want && dirs.some(d => path.dirname(d) === path.normalize(want)));
  const onlyTarget = owners.length === 1 && owners[0].wsId === toWsId;
  return {
    ok: inRightGroup && onlyTarget && dirs.length === 1,
    physicalDirs: dirs,
    expectedGroup: want,
    inRightGroup,
    owners,
    onlyTarget,
    projcachePresent: fs.existsSync(projCacheFile(id)),
    checks: { inRightGroup, onlyTarget, singleCopy: dirs.length === 1 },
  };
}

/** 批量迁移：把某个旧组目录下所有「未分组」会话一次搬到目标工作区。
 *
 *  场景：工作区改名后，旧组目录 `--C-dsh-base--` 里躺着一堆正文，
 *  workspace.json 里一个都没登记 —— 逐个迁移要敲 9 次 id，且漏一个就少一个。
 *
 *  安全边界（比单个迁移更保守）：
 *    · 只搬**未登记**的（已属于别的工作区绝不动，避免误搬正在用的）；
 *    · 某个会话仍在使用中 → 跳过并报告，不整批失败；
 *    · 目标已有同 id → 跳过；
 *    · 全部走同一个回滚点，出问题一次全退。
 */
async function sessionMigrateGroup(fromGroup, toName, confirm) {
  if (confirm !== 'MOVE') return { ok: false, error: "需要二次确认：请求体带 confirm:'MOVE'" };
  const src = path.join(DSH_HOME, 'sessions', fromGroup);
  if (!fs.existsSync(src)) return { ok: false, error: '组目录不存在：' + fromGroup };

  const entries = (await fsp.readdir(src, { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^session-/.test(e.name))
    .map(e => e.name);
  if (!entries.length) return { ok: false, error: '该组目录下没有会话' };

  const ws = await readWorkspaceDoc();
  if (!ws.ok) return { ok: false, error: ws.error };
  const registered = new Set();
  for (const rec of Object.values(ws.table)) {
    if (rec && Array.isArray(rec.sessionIds)) rec.sessionIds.forEach(s => registered.add(s));
  }

  const todo = entries.filter(n => !registered.has(n));
  const alreadyGrouped = entries.filter(n => registered.has(n));
  if (!todo.length) {
    return { ok: false, error: '该组下的会话都已在某个工作区里登记，没有「未分组」的', alreadyGrouped };
  }

  const done = [];
  const skipped = [];
  for (const id of todo) {
    const r = await sessionMigrateExecute(id, toName, 'MOVE');
    if (r.ok) done.push({ id, to: r.to && r.to.title, rollbackDir: r.rollbackDir, verify: r.verify && r.verify.ok });
    else skipped.push({ id, reason: r.error || '未知原因' });
  }

  /* 全搬完后，旧组若已空就删掉 —— 空目录留在 sessions 下会让侧边栏出现一个
     名字眼熟、点进去什么都没有的幽灵工作区。不空则保留并报告剩余。 */
  let groupRemoved = false;
  let groupRemaining = 0;
  try {
    const left = (await fsp.readdir(src)).filter(n => !n.startsWith('.'));
    groupRemaining = left.length;
    if (!left.length) { await fsp.rm(src, { recursive: true, force: true }); groupRemoved = true; }
  } catch { /* 删不掉不算失败：留个空目录无害，只是不好看 */ }

  return {
    ok: done.length > 0,
    fromGroup,
    to: toName,
    moved: done.length,
    skipped: skipped.length,
    done,
    skippedDetail: skipped,
    alreadyGrouped,
    groupRemoved,
    groupRemaining,
  };
}
/* ------------------------------------- ADR-006 人工蒸馏会话文档 sessionNote
 * compact 摘要是「给模型继续用的上下文」，不是给人看的决策记录，且写在 zstd
 * 多帧日志里（ADR-004）。按 ADR-006：不自动导出，只给模板 + 人工确认闸门，
 * 让人把「确定的结论」整理成 Markdown，落盘到会话所属工作区的 docs/session-notes/，
 * 由工作区自己的 git 管理，天然跨机可见，不依赖会话迁移。 */

const SESSION_NOTE_SUBDIR = path.join('docs', 'session-notes');

/** compact 蒸馏模板：逼人写「决策/结论/待办/路径/未解决问题」，而不是 dump 摘要。 */
function sessionNoteTemplate(id, cwd) {
  return [
    `# 会话蒸馏：${id}`,
    '',
    `- 来源会话：\`${id}\``,
    `- 工作区：\`${cwd || '(未确定)'}\``,
    `- 蒸馏日期：${new Date().toISOString().slice(0, 10)}`,
    '',
    '> 这是**人工 distillation**，不是 compact 摘要原样导出。只写你已经确认的事实与结论。',
    '',
    '## 1. 确定结论',
    '',
    '- （写这条会话里已经拍板、以后要遵守的结论）',
    '',
    '## 2. 决策与理由',
    '',
    '- 决策：',
    '- 理由：',
    '- 反面代价：',
    '',
    '## 3. 待办 / 未解决问题',
    '',
    '- [ ] ',
    '',
    '## 4. 涉及的文件路径',
    '',
    '- （相对工作区根；绝对路径请标注机器）',
    '',
    '## 5. 不适合进 ADR 的过程性细节',
    '',
    '- ',
    '',
  ].join('\n');
}

/** 从 workspace.json 找出该会话归属的工作区 path（唯一权威来源）。 */
async function workspacePathForSession(id) {
  const file = path.join(DSH_HOME, 'storages', 'workspace.json');
  let doc;
  try { doc = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { return { error: `workspace.json 无法解析：${e.message}` }; }
  const ids = sessionIdForms(id);
  const wss = (doc && doc.tables && doc.tables.workspaces) || {};
  for (const [wid, w] of Object.entries(wss)) {
    if ((w.sessionIds || []).some(s => ids.has(s))) {
      return { workspaceId: wid, path: w.path || '', title: w.title || '' };
    }
  }
  return { error: '该会话未登记到任何工作区（可能是未分组孤儿），无法自动确定落盘目录' };
}

/** 解析最终落盘路径，并强制限制在目标工作区的 docs/session-notes/ 内（防路径穿越）。 */
function resolveNotePath(workspace, filename) {
  if (!workspace || !workspace.path) return { error: '工作区路径为空' };
  const name = path.basename(String(filename || '')); // 去掉任何 ../ 目录成分
  if (!/^[A-Za-z0-9._-]+\.md$/.test(name) || name === '.md' || name === '..md') {
    return { error: '文件名必须是 *.md，且只含字母/数字/点/下划线/连字符' };
  }
  const dir = path.join(workspace.path, SESSION_NOTE_SUBDIR);
  return { dir, file: path.join(dir, name) };
}

async function sessionNotePreview(id, filename) {
  if (!bareSessionId(id)) return { ok: false, error: '缺少 sessionId' };
  const ws = await workspacePathForSession(id);
  if (ws.error) return { ok: false, error: ws.error };
  const r = resolveNotePath(ws, filename || `session-${bareSessionId(id)}.md`);
  if (r.error) return { ok: false, error: r.error };
  const exists = fs.existsSync(r.file);
  return {
    ok: true, id, workspace: ws, target: r.file,
    exists,
    mode: exists ? 'overwrite' : 'create',
    template: sessionNoteTemplate(id, ws.path),
    needsConfirm: true,
    note: '模板只是骨架；请由人填写「确定结论」，确认后才写盘。落盘到工作区文件，由工作区 git 管理，dsh-synchub 不搬运。',
  };
}

async function sessionNoteWrite(id, filename, content, confirm) {
  const pre = await sessionNotePreview(id, filename);
  if (!pre.ok) return pre;
  if (confirm !== true && confirm !== 'WRITE') {
    return { ...pre, ok: false, error: '需要二次确认：confirm 必须为 true 或 "WRITE"（不自动导出）', needsConfirm: true };
  }
  if (typeof content !== 'string' || !content.trim()) {
    return { ...pre, ok: false, error: '内容为空，拒绝写盘' };
  }
  // 拒绝把未改动的模板直接落盘（那不是人蒸馏的结论）。
  if (content.trim() === pre.template.trim()) {
    return { ...pre, ok: false, error: '内容与模板完全相同：请先由人填写确定结论再写盘' };
  }
  await fsp.mkdir(pre.target && pre.workspace.path ? path.dirname(pre.target) : pre.target, { recursive: true });
  if (pre.exists) {
    // 覆盖前备份到回滚点（沿用 ADR-001 规则二）。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const b = path.join(BACKUP_ROOT, 'session-note-' + stamp + '-' + bareSessionId(id) + '.md');
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.copyFile(pre.target, b);
    return { ...pre, ok: false, error: '目标已存在，已备份但本次不覆盖（避免误覆盖人写的文档）：' + b, backedUpTo: b };
  }
  await fsp.writeFile(pre.target, content.endsWith('\n') ? content : content + '\n', 'utf8');
  return {
    ok: true, id, target: pre.target, bytes: Buffer.byteLength(content, 'utf8'),
    note: '已写入工作区 docs/session-notes/；该文件由工作区 git 管理，请自行 commit。',
  };
}


/* ------------------------------------------------------------ 环境切换检测 */

async function remoteStamp(cfg) {
  // 只看 origin/main：要回答的是「远端最近一次是谁推的」。
  // 若都读不到尾注，返回 null，界面会显式说未知而不是假装一致。
  // 每个物理仓库都查，取时间戳更新的那个：可能只有其中一个被推过。
  const sts = [];
  for (const ch of channelsOf(cfg)) {
    const s = await parseStamp(ch, cfg, { remoteOnly: true });
    if (s) sts.push(s);
  }
  if (!sts.length) return null;
  sts.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return sts[0];
}

/* -------------------------------------------------------------- 只读体检 */

async function checkAll(cfg) {
  const checks = [];
  // 每项都带中文 label：设置面板与待办清单直接显示它，不再露出 configRemote 这类内部 id。
  const push = (id, label, ok, detail, action) => checks.push({ id, label, ok: Boolean(ok), detail, action: action || null });

  push('dshHome', 'DSH 数据目录', fs.existsSync(DSH_HOME), `${DSH_HOME} ${fs.existsSync(DSH_HOME) ? '存在' : '不存在'}`);

  const g = await git(DSH_HOME, ['--version'], 8000);
  push('git', 'git 可用', g.ok, g.ok ? g.out : '未找到 git，同步全部不可用');

  for (const ch of channelsOf(cfg)) {
    const conf = { remote: remoteOf(ch, cfg) };
    const st = await channelState(ch, cfg, { fetch: true });
    const label = channelLabel(ch);
    push(`${ch}Remote`, `${label}远端仓库`, Boolean(conf.remote), conf.remote || `${label}未配置远端仓库`, conf.remote ? null : `到设置面板「通道地址」里填${label}地址`);
    if (conf.remote && st.initialized) {
      push(`${ch}Behind`, `${label}落后远端`, st.behind === 0, st.behind > 0 ? `落后远端 ${st.behind} 个提交` : '与远端一致（未落后）', st.behind > 0 ? '先点「拉取」再改本机' : null);
      push(`${ch}Dirty`, `${label}未提交变动`, st.dirty === 0, st.dirty > 0 ? `payload 有 ${st.dirty} 处未提交` : 'payload 干净', st.dirty > 0 ? '点「提交并推送」' : null);
    }
  }

  const stamp = await remoteStamp(cfg);
  if (stamp) {
    const same = stamp.machine === (cfg.machine || os.hostname());
    push('machineSwitch', '环境切换', same, same
      ? `最近一次推送来自本机（${stamp.machine}）`
      : `最近一次推送来自另一台机器 ${stamp.machine}（${stamp.at}）→ 先 pull 再开始工作`,
      same ? null : '点「拉取并应用」把另一台的状态同步过来');
  }

  // 工作区：以「注册名 ↔ 真实登记 ↔ 本机路径」三方对照为准（不再是纯路径检查）。
  const wr = await workspaceReport(cfg);
  const wsBad = wr.rows.filter(r => !r.pathExists || r.state === 'unregistered');
  push('workspaceDir', '工作区映射', wr.rows.length > 0 && wsBad.length === 0,
    wr.rows.length === 0
      ? '未配置工作区映射（仅体检提示，不影响同步本体）'
      : `${wr.rows.length} 条：已对齐 ${wr.rows.length - wsBad.length} 条${wsBad.length ? '；待处理：' + wsBad.map(r => `${r.name}(${r.state === 'unregistered' ? '未在 DSH 登记' : '路径不存在'})`).join('、') : ''}`,
    wsBad.length ? '在设置的工作区映射表里修正；注册名要等于 DSH 里的工作区名' : null);

  // 危险项：确认没有把密钥面打开
  const leaked = [];
  for (const d of DANGER_PATHS) {
    if (d.id === 'runtimes' || d.id === 'caches' || d.id === 'quarantine' || d.id === 'mobileKeys') continue;
    for (const p of d.paths) {
      if (fs.existsSync(path.join(DSH_HOME, p))) leaked.push(p);
    }
  }
  const credInPayload = [];
  for (const ch of channelsOf(cfg)) {
    const base = payloadDir(ch, cfg);
    for (const p of ['.credentials.yaml', '.trae-auth.cn.json']) {
      if (fs.existsSync(path.join(base, p))) credInPayload.push(path.join(base, p));
    }
  }
  push('noSecrets', '凭据泄漏', credInPayload.length === 0,
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
      repo: repoKeyOf(s.channel, cfg),
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

  const channels = {};
  // preflight 要回答「到底同步了没」，必须拿到精确 pending。
  // 代价可接受：它只在用户点开面板/手动体检时跑，不在 /status 轮询路径上。
  for (const ch of channelsOf(cfg)) {
    channels[ch] = await channelState(ch, cfg, { fetch: true, scan: true });
  }
  const stamp = await remoteStamp(cfg);
  const switched = Boolean(stamp && stamp.machine !== (cfg.machine || os.hostname()));

  add('dshHome', fs.existsSync(DSH_HOME) ? 'ok' : 'fail', 'DSH 数据目录',
    DSH_HOME, null);

  const noRemote = channelsOf(cfg).filter(ch => !remoteOf(ch, cfg));
  const labelOf = ch => channelLabel(ch);
  // 标题必须随状态变 —— 之前无论 ok 还是 need 都写「远端仓库已配置」，
  // 结果 verdict 显示「已配置」而 todo=2，看着就像已经好了。
  add('remote', noRemote.length === 0 ? 'ok' : 'need',
    noRemote.length ? '远端仓库还没配' : '远端仓库已配置',
    noRemote.length
      ? `${noRemote.map(labelOf).join('、')}没有仓库地址`
      : `${channelsOf(cfg).map(labelOf).join('与')}都已连到私有仓库`,
    noRemote.length ? '在设置面板「通道地址」里填仓库地址' : null);

  // 未初始化的通道不能算「与远端一致」—— 那是没查，不是查过没问题。
  // 但「未初始化」不等于「要拉取」：仓库可能压根没建。
  // 对未初始化的通道先探一下远端存不存在，否则会把「仓库没建」误报成「首次拉取会自动建立」。
  const notInitRaw = channelsOf(cfg).filter(ch => remoteOf(ch, cfg) && !channels[ch].initialized);
  for (const ch of notInitRaw) {
    const probe = await probeRemoteExists(ch, remoteOf(ch, cfg));
    if (probe.missing) {
      channels[ch].remoteMissing = true;
      channels[ch].fetched = false;
    } else if (probe.ok) {
      channels[ch].fetched = true;
    }
  }
  const notInit = notInitRaw.filter(ch => !channels[ch].remoteMissing);
  // 同理：fetch 失败也不能算一致。behind 会停在 0，看上去像「追平了」。
  const fetchFail = channelsOf(cfg).filter(ch => {
    const st = channels[ch];
    return remoteOf(ch, cfg) && st.initialized && st.fetched === false;
  });
  const behind = Math.max(...channelsOf(cfg).map(ch => channels[ch].behind || 0));
  // 仓库根本没建好，和「本地还没接上」是两回事：后者拉一下就成，
  // 前者拉一百次也不会自动建。必须分开放前面说。
  const missing = channelsOf(cfg).filter(ch => channels[ch].remoteMissing);
  const pullOk = behind === 0 && notInit.length === 0 && fetchFail.length === 0 && missing.length === 0;
  add('pull', pullOk ? 'ok' : 'need',
    missing.length ? '远端仓库不存在' : '先拉取远端',
    missing.length
      ? `${missing.join('、')}通道的仓库在远端找不到（没建或没权限），拉取无法自己把它变出来`
      : notInit.length
        ? `${notInit.join('、')}通道还没接入远端（首次拉取会自动建立连接）`
        : fetchFail.length
          ? `${fetchFail.join('、')}通道无法访问远端（网络或权限），无法判断是否落后`
          : behind === 0
            ? '与远端一致'
            : `落后远端 ${behind} 个提交${switched ? `（另一台 ${stamp.machine} 推过）` : ''}`,
    pullOk ? null
      : missing.length
        ? '在 GitHub 上建一个空私有仓库，把地址填到设置里；建好后点「拉取并应用」'
        : fetchFail.length
          ? '先确认网络能访问 GitHub，再重试'
          : '点「拉取并应用」，把远端状态取到本机');


  const unpushed = Math.max(...channelsOf(cfg).map(ch => channels[ch].ahead || 0));
  add('push', unpushed === 0 ? 'ok' : 'need',
    '推送本机改动',
    unpushed === 0 ? '没有未推送的提交' : `${unpushed} 个提交未推送`,
    unpushed === 0 ? null : '点「提交并推送」');

  // 只看 git dirty 会骗人：两个空仓库 git 是干净的，但本机文件一个都没进 payload。
  // 必须用 unsynced（仓库未提交 + 本机未暂存）才能回答「到底同步了没」。
  const dirty = channelsOf(cfg).reduce((n, ch) => n + (channels[ch].unsynced || 0), 0);
  const payloadMissing = channelsOf(cfg).filter(ch => channels[ch].payloadMissing);
  add('stage', (dirty === 0 && payloadMissing.length === 0) ? 'ok' : 'need',
    '暂存本机变动',
    dirty === 0
      ? (payloadMissing.length ? `${payloadMissing.join('、')}通道还没有 payload（从未暂存过）` : 'payload 已对齐本机')
      : `${dirty} 处变动还没进仓库`,
    (dirty === 0 && payloadMissing.length === 0) ? null : '点「提交并推送」，把本机文件真正写进仓库');

  const wr = await workspaceReport(cfg);
  const wsBad = wr.rows.filter(r => !r.pathExists || r.state === 'unregistered');
  add('workspace', wr.rows.length === 0 ? 'ok' : (wsBad.length ? 'warn' : 'ok'), '工作区映射',
    wr.rows.length === 0
      ? '未配置工作区映射（可选，仅体检用）'
      : `${wr.rows.length} 条映射，已对齐 ${wr.rows.length - wsBad.length} 条`,
    wsBad.length ? '在设置里修正工作区映射：注册名要等于 DSH 里的工作区名' : null);

  const check = await checkAll(cfg);
  const failed = check.checks.filter(c => !c.ok);
  add('audit', failed.length === 0 ? 'ok' : 'warn', '只读体检',
    failed.length === 0 ? '全部通过' : `${failed.length} 项待处理：${failed.map(f => f.label || f.id).join('、')}`,
    failed.length ? '在设置面板点「检查」看逐项说明' : null);

  // verdict 只说「现在最该做的那一步」，且必须是未完成的步骤 —— 之前取 steps 里的
  // 第一项，导致 remote 未配置时 verdict 却是「远端仓库已配置」，正好反了。
  const order = steps.filter(s => s.state !== 'ok');
  const next = order.find(s => s.state === 'fail') || order[0] || null;
  const verdict = next ? `先处理：${next.title}` : '可以开始工作';
  return {
    machine: cfg.machine,
    switched,
    stamp,
    steps,
    todo: order.length,
    verdict,
    next: next ? { id: next.id, state: next.state, title: next.title, action: next.action } : null,
    // 可直接跟着做的下一步（含具体动作），供面板一键展示。
    nextAction: next ? (next.action || next.detail || null) : null,
  };
}

/* 自检：把「现在能不能同步」说成一句话结论 + 可执行引导，
   而不是扔一堆步骤让用户自己拼。面板第一张卡就用它。 */
async function selfCheck(cfg) {
  const pre = await preflight(cfg);
  const noRemote = channelsOf(cfg).filter(ch => !remoteOf(ch, cfg));
  const ready = pre.todo === 0;
  // 引导：每条都带「缺什么 / 去哪填 / 怎么验证」三件。
  const guide = [];
  if (noRemote.length) {
    guide.push({
      step: '填一个私有仓库地址',
      missing: noRemote.map(ch => channelLabel(ch)).join('、') + ' 没有地址',
      where: '设置 → Msynchub → 通道地址',
      verify: '填完点「保存」，再点「重新检查」；通道行应变成 N 落后 / N 领先 / N 脏，而不是「未配置远端」',
      quick: '本面板下方也有输入框可直接填（只改通道地址，不动其他配置）',
    });
  }
  if (pre.steps.some(s => s.id === 'pull' && /远端仓库不存在/.test(s.title || ''))) {
    guide.push({
      step: '在 GitHub 上建这个空仓库',
      missing: '远端根本不存在（拉取不会自己把仓库变出来）',
      where: 'GitHub → New repository（Private，不要勾 README / .gitignore / License）',
      verify: '建好后回面板点「重新检查」，这项应变成与远端一致',
    });
  }
  if (pre.steps.some(s => s.id === 'pull' && /无法访问远端/.test(s.detail || ''))) {
    guide.push({
      step: '把 Git 认证 / 网络弄通',
      missing: '本机 git 读写不到远端（凭据或代理）',
      where: '推荐装 dsh-gitok →「设置 → Mgitok」一键初始化；或自己配好 git 凭据',
      verify: '点「重新检查」不再报 fetch 失败；或手动 git ls-remote <仓库地址> 有输出',
    });
  }
  if (pre.todo > 0 && !guide.length) {
    const n = pre.next;
    guide.push({
      step: n ? n.title : '有未完成步骤',
      missing: pre.nextAction || '见面板「检查明细」',
      where: '设置 → Msynchub',
      verify: '处理完点「重新检查」',
    });
  }
  /* “上一次同步”取各仓库较新的 lastCommitAt（读自真实仓库，不编造）；
     就绪时必须把时间一起报出来 —— 否则用户只能说“应该好了吧”，不能确认。 */
  const chStates = await Promise.all(channelsOf(cfg).map(ch => channelState(ch, cfg, {})));
  const channelTimes = chStates.map(s => s.lastCommitAt).filter(Boolean).sort();
  const lastCommitAt = channelTimes.length ? channelTimes[channelTimes.length - 1] : null;
  return {
    ok: true,
    ready,
    headline: ready ? '同步已就绪' : `还不能同步（${pre.todo} 项待处理）`,
    detail: ready
      ? (lastCommitAt
        ? `${channelsOf(cfg).map(channelLabel).join('与')}都可用；最后一次本地同步提交：${lastCommitAt}。改完东西点「提交并推送」，换机时点「拉取并应用」。`
        : `${channelsOf(cfg).map(channelLabel).join('与')}都可用，但**还没有任何同步提交**（新基线）。先点一次「提交并推送」建立基线。`)
      : (pre.nextAction || pre.verdict),
    lastCommitAt,
    guide,
    channels: channelsOf(cfg).map(ch => ({
      id: ch,
      label: channelLabel(ch),
      remote: remoteOf(ch, cfg),
      configured: Boolean(remoteOf(ch, cfg)),
    })),
    todo: pre.todo,
    next: pre.next,
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
    const st = {};
    for (const ch of channelsOf(cfg)) st[ch] = await channelState(ch, cfg, { fetch: true });
    const behind = Math.max(...channelsOf(cfg).map(ch => st[ch].behind || 0));
    if (behind > 0) {
      runtime.lastAutoResult = { at: new Date().toISOString(), ok: false, reason: 'behind-remote' };
      runtime.lastAutoPushAt = Date.now();
      return;
    }
    // fetch 失败时 behind 会停在 0，不能误以为追平了就去写。
    const unreachable = channelsOf(cfg).filter(ch => st[ch].initialized && st[ch].fetched === false);
    if (unreachable.length) {
      runtime.lastAutoResult = { at: new Date().toISOString(), ok: false, reason: `remote-unreachable: ${unreachable.join(',')}` };
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
    const ok = channelsOf(cfg).every(ch => {
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

/** 状态目录真实磁盘状态（把「未初始化」变成面板能看到的字段）。只读，不创建。 */
async function stateInfo(cfg = {}) {
  const rootExists = fs.existsSync(STATE_ROOT);
  let config = { exists: false, modifiedAt: null, error: null };
  try {
    const st = await fsp.stat(CONFIG_FILE);
    config = { exists: true, modifiedAt: st.mtime.toISOString(), error: null };
  } catch (e) { config.error = e.code || String(e.message || e); }
  const repos = {};
  for (const ch of channelsOf(cfg)) {
    const dir = repoDir(ch, cfg);
    let hasGit = false, hasHead = false, payloadFiles = 0, error = null;
    try {
      hasGit = fs.existsSync(path.join(dir, '.git'));
      hasHead = hasGit && fs.existsSync(path.join(dir, '.git', 'HEAD'));
      // 不读 payload 内容，只数顶层是否存在（与 mapInfo 的深扫描区分）。
      payloadFiles = fs.existsSync(path.join(dir, PAYLOAD_DIR_NAME)) ? 1 : 0;
    } catch (e) { error = e.code || String(e.message || e); }
    repos[ch] = { dir, hasGit, hasHead, hasPayload: Boolean(payloadFiles), error };
  }
  let backups = 0;
  try {
    if (fs.existsSync(BACKUP_ROOT)) {
      backups = (await fsp.readdir(BACKUP_ROOT, { withFileTypes: true })).filter(e => e.isDirectory()).length;
    }
  } catch { /* 备份数读不到不影响主状态 */ }
  const initialized = rootExists && config.exists;
  return {
    root: STATE_ROOT, rootExists, initialized, config, repos, backupCount: backups,
    hint: initialized
      ? (config.modifiedAt ? `本机设置最后修改于 ${config.modifiedAt}` : '状态目录已就绪')
      : '状态目录尚未初始化：保存一次设置或点「提交并推送」会自动创建 config.json',
  };
}

/* 下次空闲自动推的预计时间（毫秒时间戳）。
   侧边栏要回答「下次自动是什么时候」，靠这个；没有开启就返回 null。 */
function nextAutoPushAt(cfg) {
  if (!cfg.autoPush || !cfg.idlePushMinutes) return null;
  const idleMs = cfg.idlePushMinutes * 60 * 1000;
  const dueByActivity = runtime.lastActivity + idleMs;
  // 还有一道「两次自动推至少隔 5 分钟」的闸门，取两者中较晚的。
  const dueByCooldown = runtime.lastAutoPushAt
    ? runtime.lastAutoPushAt + 5 * 60 * 1000
    : 0;
  return new Date(Math.max(dueByActivity, dueByCooldown)).toISOString();
}

/* 轻量响应缓存：/status 是轮询接口（侧边栏 45s 一次）。
   全量模式要访问 GitHub（实测 9–15s），轮询承受不起；
   所以轮询走 fast（只读本地 git，无网络），全量结果缓存 60s 供面板首屏用。 */
const STATUS_CACHE = { at: 0, cfg: null, data: null };

async function statusPayload(cfg, opts = {}) {
  const fast = opts.fast === true;
  // fast：完全不访问网。git 的 ls-remote 是这里唯一的外网调用，其它都是本地读。
  const scan = opts.scan === true;
  const states = {};
  await Promise.all(channelsOf(cfg).map(async ch => {
    states[ch] = await channelState(ch, cfg, { fetch: !fast, scan });
  }));
  const chList = channelsOf(cfg).map(ch => states[ch]);
  const stamp = await remoteStamp(cfg);
  const enabled = {};
  for (const s of SURFACES) enabled[s.id] = surfaceEnabled(s, cfg);
  // 侧边栏摘要：用 unsynced（仓库未提交 + 本机未暂存），不是 git dirty。
  const pendingTotal = chList.reduce((n, s) => n + (s.pending || 0), 0);
  const unsyncedTotal = chList.reduce((n, s) => n + (s.unsynced || 0), 0);
  return {
    ok: true,
    version: VERSION,
    fast,
    machine: cfg.machine,
    hostname: os.hostname(),
    dshHome: DSH_HOME,
    profile: PROFILE,
    activeSession: ACTIVE_SESSION || null,
    state: await stateInfo(cfg),
    channels: states,
    stamp,
    switched: Boolean(stamp && stamp.machine !== (cfg.machine || os.hostname())),
    // 侧边栏直接用的聚合值，免得前端自己加。
    summary: {
      pending: pendingTotal,
      unsynced: unsyncedTotal,
      behind: Math.max(...chList.map(s => s.behind || 0)),
      ahead: Math.max(...chList.map(s => s.ahead || 0)),
      // 分叉（ADR-030）：两台各自推过，普通拉取会失败，面板要给二选一。
      diverged: chList.some(s => s.diverged),
      scanned: chList.every(s => s.scanned),
      payloadMissing: channelsOf(cfg).filter(ch => states[ch].payloadMissing),
    },
    surfaces: SURFACES.map(s => ({ id: s.id, label: s.label, tier: s.tier, on: Boolean(cfg.surfaces[s.id]), channel: s.channel, repo: repoKeyOf(s.channel, cfg), note: s.note })),
    auto: {
      enabled: Boolean(cfg.autoPush),
      idlePushMinutes: cfg.idlePushMinutes,
      idleMinutes: Math.round((Date.now() - runtime.lastActivity) / 60000),
      lastAt: runtime.lastAutoPushAt ? new Date(runtime.lastAutoPushAt).toISOString() : null,
      lastResult: runtime.lastAutoResult,
      busy: Boolean(runtime.busy),
      standard: idleStandard(),
      nextAt: nextAutoPushAt(cfg),
    },
    pluginSync: {
      enabled: Boolean(cfg.pluginSync && cfg.pluginSync.enabled),
      autoMinutes: Number(cfg.pluginSync && cfg.pluginSync.autoMinutes) || 0,
      includeLink: cfg.pluginSync ? cfg.pluginSync.includeLink !== false : true,
      lastResult: PLUGIN_BACKUP_RUNTIME.lastResult,
    },
    workspaces: Array.isArray(cfg.workspaces) ? cfg.workspaces : (cfg.workspace ? [cfg.workspace] : []),
    // 这两项各自要跑 git / 扫目录，fast 模式下跳过（面板首屏用全量，侧边栏轮询用 fast）。
    install: fast ? null : await installInfo(),
    workspaceReport: fast ? null : await workspaceReport(cfg),
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
      handler: async (req, res) => {
        try {
          /* fast=1：侧边栏 45s 轮询走这条。只读本地 git，不访问 GitHub。
             不传就是全量（面板首屏用，带 install/workspaceReport）。 */
          const q = new URL(req.url || '', 'http://x');
          const fast = q.searchParams.get('fast') === '1';
          const scan = q.searchParams.get('scan') === '1';
          return json(res, 200, await statusPayload(await readConfig(), { fast, scan }));
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/state',
      handler: async (_req, res) => {
        try { return json(res, 200, { ok: true, ...(await stateInfo()) }); }
        catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/install-info',
      handler: async (_req, res) => {
        try { return json(res, 200, await installInfo()); }
        catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/self-check',
      handler: async (_req, res) => {
        try { return json(res, 200, await selfCheck(await readConfig())); }
        catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/workspaces',
      handler: async (_req, res) => {
        try { return json(res, 200, await workspaceReport(await readConfig())); }
        catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
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
      path: '/api/dsh-synchub/memory-map',
      handler: async (_req, res) => {
        try { return json(res, 200, await memoryMap()); }
        catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/memory',
      handler: async (_req, res) => {
        try {
          const cfg = await readConfig();
          return json(res, 200, { ok: true, config: cfg.memory || {}, map: await memoryMap() });
        } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/memory/archive',
      handler: async (req, res) => {
        try {
          const body = req.method === 'POST' ? await readBody(req) : {};
          const r = await archiveSessionById(body.id || '');
          return json(res, r && r.ok ? 200 : 400, r);
        } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/memory/tidy',
      handler: async (req, res) => {
        try {
          const r = await tidyMemoryNow('manual');
          return json(res, r && r.ok ? 200 : 400, r);
        } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/memory/file',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const target = url.searchParams.get('path') || '';
          if (req.method === 'GET') {
            const r = await resolveMemoryEditPath(target);
            if (!r.ok) return json(res, 400, r);
            const exists = fs.existsSync(r.path);
            const content = exists ? await fsp.readFile(r.path, 'utf8') : '';
            return json(res, 200, { ok: true, path: r.path, exists, content });
          }
          const body = await readBody(req);
          const r = await editMemoryFile(target || body.path, body.content, body.confirm);
          return json(res, r && r.ok ? 200 : 400, r);
        } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
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
      path: '/api/dsh-synchub/repos',
      handler: async (_req, res) => {
        try {
          /* 只读本地：不访网，可安全被侧边栏轮询。同步动作走 /repos/sync。 */
          return json(res, 200, await codeReposPayload(await readConfig()));
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/repos/sync',
      handler: async (req, res) => {
        try {
          touchActivity();
          const cfg = await readConfig();
          const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
          const r = await syncAllCodeRepos(cfg, { id: body.id, message: body.message });
          return json(res, 200, r);
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/diverge',
      handler: async (_req, res) => {
        try {
          touchActivity();
          const cfg = await readConfig();
          return json(res, 200, await divergeInfo(cfg));
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/diverge/resolve',
      handler: async (req, res) => {
        try {
          touchActivity();
          const cfg = await readConfig();
          const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
          // 二选一，没有默认值：make 一下手滑不至于错方向。
          if (body.mode !== 'keep-local' && body.mode !== 'keep-remote') {
            return json(res, 400, { ok: false, error: 'mode 必须是 keep-local 或 keep-remote' });
          }
          const r = body.mode === 'keep-local'
            ? await resolveKeepLocal(cfg)
            : await resolveKeepRemote(cfg, { prune: body.prune === true });
          return json(res, 200, r);
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
          for (const ch of channelsOf(cfg)) {
            const remote = remoteOf(ch, cfg);
            if (remote) {
              const dir = repoDir(ch, cfg);
              if (!fs.existsSync(path.join(dir, '.git'))) await bootstrapFromRemote(ch, remote, cfg);
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
    {
      kind: 'exact',
      path: '/api/dsh-synchub/purge-session',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const id = url.searchParams.get('id') || '';
          const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
          if (req.method === 'POST') {
            // 二次确认闸门：confirm 必须等于 sessionId，默认（任何不等）都不删。
            const r = await purgeExecute(body.id || id, body.confirm);
            return json(res, r.ok === false ? 400 : 200, r);
          }
          if (url.searchParams.get('verify') === '1') {
            return json(res, 200, await purgeVerify(id));
          }
          return json(res, 200, await purgePreview(id));
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/session-move',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const id = url.searchParams.get('id') || '';
          const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
          if (req.method === 'POST') {
            // 二次确认闸门：confirm 必须逐字是 'MOVE'，默认（任何不等）都不动文件。
            const r = await sessionMigrateExecute(body.id || id, body.to || url.searchParams.get('to'), body.confirm);
            return json(res, r.ok === false ? 400 : 200, r);
          }
          return json(res, 200, await sessionMigratePreview(id, url.searchParams.get('to')));
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/session-move/help',
      handler: async (_req, res) => json(res, 200, {
        ok: true,
        why: '工作区改名/改路径后，旧组的会话会变成「未分组」。数据没丢，是归属丢了 —— 需要同时改正文目录和 workspace.json。',
        how: [
          'GET  /api/dsh-synchub/session-move?id=<sessionId>&to=<工作区名>     # 预览：现在在哪、要搬到哪、动哪些文件',
          "POST /api/dsh-synchub/session-move {id, to, confirm:'MOVE'}          # 执行迁移",
          'GET  /api/dsh-synchub/session-move?id=<id>&to=<名>&verify=1          # 验收',
          "POST /api/dsh-synchub/session-move/group {from, to, confirm:'MOVE'}  # 批量：只搬未分组的"
        ],
        notes: [
          'to 可以是工作区标题（title），也可以是它的绝对路径；两者都认。',
          '目标工作区必须已在 DSH 里登记过（打开它一次即可），否则找不到归属。',
          '先写回滚点到 <state>/backups/move-<时间>-<会话id>/，含 workspace.json 与会话正文。',
          '复制后逐文件校验字节数与文件数，不一致就中止并保留源目录。',
          '会话仍在写入（30 秒内有活动 / 有未结束 turn）时拒绝迁移。',
        ],
      }),
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/session-move/group',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
          /* 批量只走 POST：GET 拿不到 from/to 就容易误触发，代价是搬错一批会话。
             这里不给 GET 预览，宁可让调用方先逐个 session-move 预览。 */
          if (req.method !== 'POST') {
            return json(res, 405, { ok: false, error: '批量迁移只接受 POST（避免误触发）' });
          }
          const r = await sessionMigrateGroup(
            body.from || '', body.to || '', body.confirm);
          return json(res, r.ok === false ? 400 : 200, r);
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/session-doctor',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const body = await readBody(req).catch(() => ({}));
            const r = await sessionDoctorApply({
              dshHome: DSH_HOME,
              backupRoot: BACKUP_ROOT,
              ids: Array.isArray(body.ids) ? body.ids : null,
              targets: body.targets && typeof body.targets === 'object' ? body.targets : null,
              confirm: body.confirm,
            });
            return json(res, r.ok === false ? 400 : 200, r);
          }
          return json(res, 200, await sessionDoctorScan({ dshHome: DSH_HOME }));
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/session-doctor/help',
      handler: async (_req, res) => json(res, 200, {
        ok: true,
        why: '工作区目录改名/移动/重加之后，会话会掉进「未分组」或变成幽灵组。数据没丢，是 workspace.json 的归属和 sessions/ 的分组目录对不上了。',
        scope: '只管「能不能用」：会话看不见 / 点进去空白 / 工作区打不开。重复登记、空组目录、归档这类整洁问题只报告不主动修 —— 那是专门的会话管理插件的事。',
        how: [
          'GET  /api/dsh-synchub/session-doctor                          # 全量体检（只读），返回 findings + actions + summary.health',
          "POST /api/dsh-synchub/session-doctor {confirm:'REPAIR'}        # 一键救援：只跑 rescue.ids（影响「能不能用」且 safe 的）",
          "POST /api/dsh-synchub/session-doctor {ids:[...], confirm:'REPAIR'}   # 只执行指定动作（想把整洁项一起做，把 misc.ids 也带进来）",
          "POST /api/dsh-synchub/session-doctor {ids:['relocate:...'], targets:{'relocate:...':'<wsId>'}, confirm:'REPAIR'}  # 改指到指定工作区",
        ],
        findings: {
          'workspace-path-missing': '[blocking] 工作区登记指向的路径已不存在（改名/删除），不可自动修，需重新添加工作区',
          'dangling-ref': '[blocking] 登记了磁盘上不存在的会话，点进去是空白；可安全清引用',
          'duplicate-ref': '[advisory] 同一会话被登记进多个工作区，只影响整洁，不主动修',
          'orphan-group-recoverable': '[blocking] 组目录还在但登记丢了，可重建登记或搬进目标工作区',
          'orphan-group-relocatable': '[blocking] 原工作目录已不存在（典型是改名了），可改指到现存工作区（必须人给 targets）',
          'orphan-group-dead': '[advisory] 对不上任何工作区时的归档建议（只隐藏，不删正文），不主动修',
          'unregistered-live': '[blocking] 会话就在有效组里却没登记，侧边栏看不见；补一条即可',
          'group-mismatch': '[blocking] 正文目录与归属工作区不一致，需要搬目录',
          'empty-group': '[advisory] 空组目录，不影响使用，不主动删',
        },
        notes: [
          '职责边界（0.9.0）：只修「会话打不开/看不见」，其余只报告。blocking vs advisory 见 findings 里的 impact 字段。',
          'summary.health 三态：ok=能用 / repairable=不能用但可一键修 / needs-human=不能用且必须人指定目标。',
          '只读扫描永不写盘；执行前先把 workspace.json 备份到 <state>/backups/doctor-<时间>/。',
          '搬目录一律「复制 → 逐文件/字节校验 → 删源」，失败时源仍在。',
          '30 秒内还在写入的会话拒绝搬动。',
          'subagent 会话（origin=subagent 或有 parentSession）不参与判断：它们本来就该藏在组目录里。',
          '改指（relocate-group）必须显式给 targets，工具不猜目标，猜错会把会话塞进错的工作区。',
          '改完 workspace.json 后，侧边栏要重启 DSH（或重新载入窗口）才按新归属显示。',
        ],
      }),
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/purge-session/help',
      handler: async (_req, res) => json(res, 200, {
        ok: true,
        why: 'GUI 不提供会话删除；物理删 .zstd 会留下悬空引用（ADR-004 §4.4 / ADR-005）。',
        how: [
          'GET  /api/dsh-synchub/purge-session?id=<sessionId>                # 预览影响面，不改任何东西',
          'POST /api/dsh-synchub/purge-session {id, confirm:<同一个 id>}     # 执行删除（confirm 必须逐字相等）',
          'GET  /api/dsh-synchub/purge-session?id=<id>&verify=1              # 重启后验收',
        ],
        backup: `回滚点在 $DSH_HOME/dsh-synchub/backups/purge-<ts>-<id>/，含 RESTORE.md`,
        searchIndex: 'SQLite FTS5 派生库，DSH 下次检索自动重建；不直接写活库',
      }),
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/session-note',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          if (req.method === 'POST') {
            const body = await readBody(req).catch(() => ({}));
            const r = await sessionNoteWrite(body.id || '', body.filename, body.content, body.confirm);
            return json(res, r.ok === false ? 400 : 200, r);
          }
          return json(res, 200, await sessionNotePreview(url.searchParams.get('id') || '', url.searchParams.get('filename') || ''));
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/plugin-backup',
      handler: async (req, res) => {
        try {
          const cfg = await readConfig();
          if (req.method === 'POST') {
            touchActivity();
            return json(res, 200, await backupPluginManifest(cfg));
          }
          const manifest = await readPluginManifest(cfg);
          return json(res, 200, {
            ok: true,
            enabled: Boolean(cfg.pluginSync && cfg.pluginSync.enabled),
            autoMinutes: Number(cfg.pluginSync && cfg.pluginSync.autoMinutes) || 0,
            includeLink: cfg.pluginSync ? cfg.pluginSync.includeLink !== false : true,
            lastResult: PLUGIN_BACKUP_RUNTIME.lastResult,
            manifest: { ok: manifest.ok, at: manifest.at || null, count: (manifest.plugins || []).length, error: manifest.error || null },
          });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e.message || e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-synchub/plugin-restore',
      handler: async (req, res) => {
        try {
          const cfg = await readConfig();
          if (req.method === 'POST') {
            touchActivity();
            const body = await readBody(req).catch(() => ({}));
            const r = await pluginRestoreExecute(cfg, { confirm: body.confirm });
            return json(res, r.ok === false ? 400 : 200, r);
          }
          return json(res, 200, await pluginRestorePreview(cfg));
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

/* ================================================== ADR-038 插件清单备份/恢复
 *
 * 只记「名字（npm）/ 名字+位置（link）」，**不记版本**（用户明确要求装最新）。
 * 清单落唯一仓库的 `dsh-home/plugins/manifest.json`，跟着 stage/pull 走。
 *
 * 两类来源：
 *   · npm —— 恢复时用宿主 `pluginManager.installBundle(name)`（运行时可装，无需退出 DSH）；
 *   · link —— 恢复时写回 profile `package.json` 的 `link:` 依赖并跑 pnpm install。
 *     因为 link 目标必须已在本地（源码归 dshplug 仓库管），所以先「检查」再装。
 */

let HOST_CTX = null;

function pluginManifestPath(cfg) {
  return path.join(payloadDir('config', cfg), 'plugins', 'manifest.json');
}

/** 把一个依赖 spec 分类成 npm / link / git。 */
function classifyPluginSpec(name, spec, baseDir) {
  const s = String(spec || '').trim();
  if (/^(link|file):/i.test(s)) {
    let p = s.replace(/^(link|file):/i, '');
    if (!path.isAbsolute(p)) p = path.resolve(baseDir || PROFILE_DIR, p);
    return { name, kind: 'link', linkPath: p.split(path.sep).join('/') };
  }
  if (/^(git\+|github:|git:)/i.test(s) || /^https?:\/\/.*\.git(?:[?#]|$)/i.test(s)) {
    return { name, kind: 'git' };
  }
  return { name, kind: 'npm' };
}

/** 读当前 profile 实际装了什么。优先宿主 listBundles（source 已解析），回退 package.json。 */
async function readInstalledPlugins(cfg = {}) {
  const plugins = [];
  const seen = new Set();
  const add = (name, kind, linkPath) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    const item = { name, kind };
    if (kind === 'link' && linkPath) item.linkPath = linkPath;
    plugins.push(item);
  };
  let source = '';
  // 1) 宿主 pluginManager：能拿到已解析好的 source spec，还能区分宿主自带 bundle。
  try {
    const mgr = HOST_CTX && typeof HOST_CTX.get === 'function' ? HOST_CTX.get('pluginManager') : null;
    if (mgr && typeof mgr.listBundles === 'function') {
      const bundles = await mgr.listBundles();
      if (Array.isArray(bundles) && bundles.length) {
        for (const b of bundles) {
          if (!b || !b.name) continue;
          const spec = String(b.source || '');
          // 宿主自带 bundle（安装时提供、无 source）不进清单：它们每台都有，不用同步。
          if (!spec && /^@deepseek-ai\//.test(b.name)) continue;
          const c = classifyPluginSpec(b.name, spec, PROFILE_DIR);
          add(c.name, c.kind, c.linkPath);
        }
        source = 'pluginManager';
      }
    }
  } catch { /* 回退 package.json */ }
  // 2) 回退：profile 的 package.json（离线/无宿主服务时也能用）
  if (!source) {
    let deps = {};
    try {
      const pj = JSON.parse(await fsp.readFile(path.join(PROFILE_DIR, 'package.json'), 'utf8'));
      deps = pj.dependencies || {};
    } catch (e) {
      return { ok: false, error: `package.json 读不到：${e.message}`, plugins: [] };
    }
    for (const [name, spec] of Object.entries(deps)) {
      const c = classifyPluginSpec(name, spec, PROFILE_DIR);
      add(c.name, c.kind, c.linkPath);
    }
    source = 'package.json';
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, source, plugins };
}

/** 生成清单对象（不含时间戳/机器名：内容相同才叫「没变化」）。 */
function buildPluginManifest(plugins, includeLink = true) {
  const list = plugins
    .filter(p => p.kind === 'npm' || (p.kind === 'link' && includeLink))
    .map(p => (p.kind === 'link' ? { name: p.name, kind: 'link', linkPath: p.linkPath } : { name: p.name, kind: 'npm' }));
  return { format: 'dsh-synchub-plugin-manifest', version: 1, plugins: list };
}

/** 读回已备份的清单（恢复预览用）。*/
async function readPluginManifest(cfg) {
  const p = pluginManifestPath(cfg);
  let stat = null;
  try { stat = await fsp.stat(p); } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? '清单不存在（还没备份过）' : e.message, plugins: [] };
  }
  try {
    const doc = JSON.parse(await fsp.readFile(p, 'utf8'));
    if (!doc || !Array.isArray(doc.plugins)) return { ok: false, error: '清单格式不对', plugins: [] };
    return { ok: true, doc, plugins: doc.plugins, at: stat.mtime.toISOString() };
  } catch (e) {
    return { ok: false, error: e.message, plugins: [] };
  }
}

/** 写清单进 payload。内容相同则不写盘（用户要求「没变化就不更新文件」）。 */
async function writePluginManifest(cfg) {
  if (!cfg.pluginSync || cfg.pluginSync.enabled !== true) return { ok: false, reason: 'disabled' };
  const cur = await readInstalledPlugins(cfg);
  if (!cur.ok) return { ok: false, reason: cur.error };
  const doc = buildPluginManifest(cur.plugins, cfg.pluginSync.includeLink !== false);
  const target = pluginManifestPath(cfg);
  const text = JSON.stringify(doc, null, 2);
  let same = false;
  try { same = (await fsp.readFile(target, 'utf8')) === text; } catch { /* 还不存在 */ }
  if (same) return { ok: true, unchanged: true, count: doc.plugins.length, source: cur.source };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text, 'utf8');
  return { ok: true, written: true, count: doc.plugins.length, source: cur.source };
}

/** 手动备份：写清单 + 只提交这一个文件（不顺手带别的）。 */
async function backupPluginManifest(cfg) {
  if (!cfg.pluginSync || cfg.pluginSync.enabled !== true) {
    return { ok: false, reason: 'disabled', hint: '先在「设置 → Msynchub」打开「插件清单备份」' };
  }
  const w = await writePluginManifest(cfg);
  if (!w.ok) return w;
  const dir = repoDir('config', cfg);
  // 清单相对仓库根的路径（payload 目录名随版本变，不能写死 plugins/）。
  const relManifest = path.relative(dir, pluginManifestPath(cfg)).split(path.sep).join('/');
  const commit = { ok: false, committed: false };
  if (!fs.existsSync(path.join(dir, '.git'))) {
    commit.reason = 'not-initialized';
  } else {
    await git(dir, ['add', '-A', '--', relManifest]);
    const st = await git(dir, ['status', '--porcelain', '--', relManifest]);
    if (!st.ok) {
      commit.ok = false; commit.reason = 'git-status-failed'; commit.output = st.err || st.out;
    } else if (st.out && st.out.trim()) {
      const c = await git(dir, ['commit', '-m', `synchub: plugin manifest @ ${new Date().toISOString()}` + stampTrailer(cfg)]);
      commit.ok = c.ok; commit.committed = c.ok; commit.output = c.err || c.out;
    } else {
      commit.ok = true; commit.committed = false; commit.reason = 'nothing-to-commit';
    }
  }
  return { ok: true, ...w, commit };
}

/** 恢复预览（只读）：清单 vs 当前已装，并列出去哪找 link 目标。 */
async function pluginRestorePreview(cfg) {
  if (!cfg.pluginSync || cfg.pluginSync.enabled !== true) {
    return { ok: false, reason: 'disabled', hint: '插件清单备份/恢复开关未开' };
  }
  const manifest = await readPluginManifest(cfg);
  const current = await readInstalledPlugins(cfg);
  const curByName = new Map((current.plugins || []).map(p => [p.name, p]));
  const addNpm = [], addLink = [], linkMissing = [], already = [];
  for (const p of manifest.plugins || []) {
    const cur = curByName.get(p.name);
    if (cur && cur.kind === p.kind) {
      // 已装同类：link 还要确认目标目录真的在（目标没了等于要重新链接）。
      if (p.kind === 'link') {
        const exists = Boolean(cur.linkPath) && fs.existsSync(cur.linkPath);
        if (!exists) { linkMissing.push({ ...p, linkPath: cur.linkPath || p.linkPath }); continue; }
      }
      already.push(p.name); continue;
    }
    if (p.kind === 'link') {
      const exists = Boolean(p.linkPath) && fs.existsSync(p.linkPath);
      (exists ? addLink : linkMissing).push(p);
    } else if (p.kind === 'npm') {
      addNpm.push(p);
    }
  }
  const manifestNames = new Set((manifest.plugins || []).map(p => p.name));
  const extra = (current.plugins || []).filter(p => !manifestNames.has(p.name)).map(p => p.name);
  const mgr = HOST_CTX && typeof HOST_CTX.get === 'function' ? HOST_CTX.get('pluginManager') : null;
  return {
    ok: true,
    manifestOk: manifest.ok,
    manifestError: manifest.error || null,
    manifestAt: manifest.at || null,
    currentSource: current.source,
    addNpm, addLink, linkMissing, already, extra,
    canInstall: addNpm.length > 0 || addLink.length > 0,
    managerAvailable: Boolean(mgr && typeof mgr.installBundle === 'function'),
  };
}

/** 找 pnpm 可执行入口：宿主提供的优先，其次 PATH，最后 bundled runtime。 */
async function resolvePnpmInvocation(cfg) {
  const pub = HOST_CTX && typeof HOST_CTX.get === 'function'
    ? HOST_CTX.get('profileContext') : null;
  const pm = pub && pub.packageManager;
  if (pm && typeof pm.command === 'string' && pm.command.trim()) {
    return { command: pm.command, args: Array.isArray(pm.args) ? pm.args : [], env: pm.env || {} };
  }
  // PATH 里的 pnpm
  const probe = await execFileAsync('pnpm', ['--version'], { timeout: 15000, windowsHide: true }).catch(() => null);
  if (probe && probe.stdout) return { command: 'pnpm', args: [], env: {} };
  // bundled runtime
  const dep = path.join(DSH_HOME, 'dsh-runtimes');
  try {
    const entries = await fsp.readdir(dep, { withFileTypes: true });
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const node = path.join(dep, d.name, 'dependencies', 'node', 'bin', 'node.exe');
      const pnpm = path.join(dep, d.name, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs');
      if (fs.existsSync(node) && fs.existsSync(pnpm)) return { command: node, args: [pnpm], env: {} };
    }
  } catch { /* 没有 runtime 目录 */ }
  return null;
}

/** link 恢复：写回 package.json 的 link: 依赖与 bundles，再跑 pnpm install。 */
async function restoreLinkPlugins(cfg, links) {
  const pjPath = path.join(PROFILE_DIR, 'package.json');
  const failed = [];
  let pj;
  try { pj = JSON.parse(await fsp.readFile(pjPath, 'utf8')); }
  catch (e) {
    return { installed: [], failed: links.map(p => ({ name: p.name, kind: 'link', error: 'package.json 读不到：' + e.message })) };
  }
  // 规则二：覆盖前备份。备份失败就停（否则回滚没有依据）。
  const backupDir = path.join(BACKUP_ROOT, 'plugin-restore-' + new Date().toISOString().replace(/[:.]/g, '-'));
  try {
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.copyFile(pjPath, path.join(backupDir, 'package.json'));
  } catch (e) {
    return { installed: [], failed: links.map(p => ({ name: p.name, kind: 'link', error: '备份 package.json 失败：' + e.message })) };
  }
  const deps = pj.dependencies || (pj.dependencies = {});
  const bundles = pj.dsh && pj.dsh.profile && Array.isArray(pj.dsh.profile.bundles)
    ? pj.dsh.profile.bundles
    : [];
  for (const p of links) {
    deps[p.name] = 'link:' + String(p.linkPath || '').split('/').join('/');
    if (!bundles.includes(p.name)) bundles.push(p.name);
  }
  if (!pj.dsh) pj.dsh = {};
  if (!pj.dsh.profile) pj.dsh.profile = {};
  pj.dsh.profile.bundles = bundles;
  await fsp.writeFile(pjPath, JSON.stringify(pj, null, 2), 'utf8');

  const inv = await resolvePnpmInvocation(cfg);
  if (!inv) {
    return {
      installed: [], failed: links.map(p => ({ name: p.name, kind: 'link', error: '找不到 pnpm（宿主未提供、PATH 里没有、runtime 里也没有）' })),
      backupDir, hint: '可手动执行：pnpm install（在 profile 目录）',
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(inv.command, [...inv.args, 'install', '--config.confirmModulesPurge=false'], {
      cwd: PROFILE_DIR, timeout: 600000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...inv.env, CI: 'true' },
    });
    return { installed: links.map(p => p.name), failed, backupDir, pnpmOutput: String(stdout || '').slice(0, 4000), pnpmError: String(stderr || '').slice(0, 2000) };
  } catch (e) {
    return {
      installed: [], failed: links.map(p => ({ name: p.name, kind: 'link', error: String(e.message || e).slice(0, 500) })),
      backupDir, hint: 'package.json 已改但 pnpm install 失败；原文件在 ' + backupDir,
    };
  }
}

/** 恢复执行：npm 走宿主服务；link 写依赖 + pnpm install。 */
async function pluginRestoreExecute(cfg, opts = {}) {
  if (opts.confirm !== 'RESTORE') return { ok: false, reason: 'need-confirm', hint: '确认闸门未过' };
  if (!cfg.pluginSync || cfg.pluginSync.enabled !== true) {
    return { ok: false, reason: 'disabled', hint: '插件清单备份/恢复开关未开' };
  }
  const preview = await pluginRestorePreview(cfg);
  if (!preview.manifestOk) return { ok: false, reason: 'manifest-missing', error: preview.manifestError };
  const mgr = HOST_CTX && typeof HOST_CTX.get === 'function' ? HOST_CTX.get('pluginManager') : null;
  const npm = [], link = [], failed = [];
  if (preview.addNpm.length) {
    if (!mgr || typeof mgr.installBundle !== 'function') {
      return {
        ok: false, reason: 'manager-unavailable',
        hint: '当前宿主没有 pluginManager 服务。可手动装：' + preview.addNpm.map(p => `dsh plugin add ${p.name}`).join('；'),
        preview,
      };
    }
    for (const p of preview.addNpm) {
      try {
        const r = await mgr.installBundle(p.name);
        const ok = r && (r.application === 'applied' || r.application === 'restart-required' || r.application === 'overridden');
        if (ok) npm.push({ name: p.name, application: r.application });
        else failed.push({ name: p.name, kind: 'npm', error: (r && r.error) || 'install failed' });
      } catch (e) {
        failed.push({ name: p.name, kind: 'npm', error: String(e.message || e) });
      }
    }
  }
  if (preview.addLink.length) {
    const r = await restoreLinkPlugins(cfg, preview.addLink);
    link.push(...(r.installed || []));
    failed.push(...(r.failed || []));
    if (r.hint && !r.installed) return { ok: false, reason: 'link-restore-failed', error: r.hint, npm, link, failed, preview };
  }
  return { ok: failed.length === 0, npm, link, failed, preview };
}

/* 自动备份 tick：与 autoPush / codeRepoAuto 同一条 60s 定时器，各自判自杀条件。 */
const PLUGIN_BACKUP_RUNTIME = { lastTickAt: null, lastResult: null };
async function pluginBackupAutoTick(ctx) {
  let cfg;
  try { cfg = await readConfig(); } catch { return; }
  if (!cfg.pluginSync || cfg.pluginSync.enabled !== true) return;
  const minutes = Number(cfg.pluginSync.autoMinutes) || 0;
  if (minutes <= 0) return;
  const now = Date.now();
  if (PLUGIN_BACKUP_RUNTIME.lastTickAt && now - PLUGIN_BACKUP_RUNTIME.lastTickAt < minutes * 60_000) return;
  PLUGIN_BACKUP_RUNTIME.lastTickAt = now;
  try {
    const r = await backupPluginManifest(cfg);
    PLUGIN_BACKUP_RUNTIME.lastResult = { at: new Date().toISOString(), ok: r.ok !== false, unchanged: r.unchanged === true };
    diag({ phase: 'plugin-backup-auto', ok: r.ok !== false, unchanged: r.unchanged === true });
  } catch (e) {
    PLUGIN_BACKUP_RUNTIME.lastResult = { at: new Date().toISOString(), ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ 入口 */

/* ------------------------------------------------ 阶段③ 整理记忆（ADR-041） */

function tidyConfigOf(cfg) {
  const m = memoryConfigOf(cfg);
  return (m && m.tidy) || { enabled: false, intervalHours: 0 };
}

async function tidyWithLlm(llm, provider, model, prev, recent) {
  const sys = { role: 'system', content: [{ type: 'text', text: '你是记忆整理助手。把「现有记忆」与「相关会话」合并成一份简洁、去重、按主题组织的 Markdown 记忆。保留仍然有效的结论，删掉过时内容，不要编造。' }] };
  const a = { role: 'user', content: [{ type: 'text', text: '现有记忆：\n' + (prev || '（空）') }] };
  const b = { role: 'user', content: [{ type: 'text', text: '相关会话（最近）：\n' + (recent || '（无）') }] };
  let text = '';
  for await (const chunk of llm.stream({ provider, model, messages: [sys, a, b] })) {
    if (!chunk) continue;
    if (chunk.kind === 'text-delta') text += (chunk.text ?? chunk.delta ?? '');
    if (chunk.kind === 'finish') break;
  }
  return text.trim();
}

/** 整理一个工作区的记忆：现有 PROJECT.md + 最近会话 → 模型合并 → 备份后覆盖。 */
async function tidyWorkspaceMemory(cfg, ws, llm, provider, model) {
  const file = path.join(ws.path || '', MEMORY_DIR, 'PROJECT.md');
  if (!ws.path) return { ok: false, error: '工作区没有路径' };
  const prev = fs.existsSync(file) ? await fsp.readFile(file, 'utf8') : '';
  const recent = await recentWorkspaceTranscript(DSH_HOME, ws, 5);
  if (!prev && !recent.length) return { ok: false, skipped: 'no-content' };
  const recentText = recent.map(r => '### ' + r.sessionId + '\n' + r.messages.map(m => (m.role === 'assistant' ? '助手：' : '用户：') + m.text).join('\n')).join('\n\n');
  const merged = await tidyWithLlm(llm, provider, model, prev, recentText.slice(0, 20000));
  if (!merged) return { ok: false, error: '整理结果为空' };
  const w = await writeMemoryFile(file, merged);
  return { ok: true, file, bytes: w.bytes, unchanged: w.unchanged };
}

/** 整理入口：手动与定时共用。范围 = 配置的工作区（空=全部）。 */
async function tidyMemoryNow(reason) {
  try {
    const cfg = await readConfig();
    const m = memoryConfigOf(cfg);
    if (!m.enabled) return { ok: false, skipped: 'disabled' };
    const t = tidyConfigOf(cfg);
    if (!t.enabled && reason === 'auto') return { ok: false, skipped: 'auto-disabled' };
    const llm = HOST_CTX && HOST_CTX.reflect && typeof HOST_CTX.reflect.get === 'function'
      ? HOST_CTX.reflect.get('llm', false) : null;
    if (!llm) return { ok: false, error: '该 profile 没有可用的 llm 服务，跳过整理' };
    const route = await resolveLlmRoute(llm, cfg);
    if (!route.provider || !route.model) return { ok: false, error: '无法确定 provider/model' };
    const all = await realWorkspaces();
    if (!all.ok) return { ok: false, error: all.error };
    const list = Array.isArray(m.workspaces) ? m.workspaces : [];
    const targets = list.length
      ? all.workspaces.filter(w => list.some(x => String(x.name).toLowerCase() === String(w.title).toLowerCase()))
      : all.workspaces;
    const results = [];
    for (const ws of targets) {
      const r = await tidyWorkspaceMemory(cfg, ws, llm, route.provider, route.model);
      results.push({ workspace: ws.title, ...r });
    }
    return { ok: true, reason, model: route.provider + '/' + route.model, results };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------ 阶段④ 受控编辑记忆（ADR-042） */

/** 允许编辑的记忆文件：用户级 ~/.dsh/memory/** 或某工作区 <path>/memory/**。 */
async function resolveMemoryEditPath(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: '缺少路径' };
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : null;
  if (!abs) return { ok: false, error: '路径必须是绝对路径' };
  const userDir = path.join(DSH_HOME, 'memory');
  const wss = await readWorkspacesList();
  const allowed = [userDir, ...wss.map(w => path.join(w.path, 'memory'))];
  const inside = allowed.some(dir => {
    const rel = path.relative(dir, abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!inside) return { ok: false, error: '只允许编辑用户级 ~/.dsh/memory/ 或某工作区 <path>/memory/ 下的文件' };
  if (!/\.(md|markdown)$/i.test(abs)) return { ok: false, error: '只允许 .md 文件' };
  return { ok: true, path: abs };
}

async function readWorkspacesList() {
  const { workspaces } = await realWorkspaces();
  return workspaces || [];
}

async function editMemoryFile(input, content, confirm) {
  const r = await resolveMemoryEditPath(input);
  if (!r.ok) return r;
  if (confirm !== true && confirm !== 'WRITE') return { ok: false, error: '需要二次确认：confirm 必须为 true 或 "WRITE"' };
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: '内容为空，拒绝写盘' };
  const w = await writeMemoryFile(r.path, content);
  return { ok: true, path: r.path, bytes: w.bytes, existed: w.existed, unchanged: w.unchanged };
}

async function tidyTick(ctx) {
  try {
    const cfg = await readConfig();
    const t = tidyConfigOf(cfg);
    if (!t.enabled || !t.intervalHours) return;
    const now = Date.now();
    const last = runtime.tidyLastAt || 0;
    if (last && now - last < t.intervalHours * 3600 * 1000) return;
    runtime.tidyLastAt = now;
    const r = await tidyMemoryNow('auto');
    if (r && r.ok) log(ctx, 'info', `定时整理记忆完成：${(r.results || []).filter(x => x.ok).length} 个工作区`);
    else if (r && r.error) log(ctx, 'warn', `定时整理记忆跳过：${r.error}`);
  } catch { /* 定时任务失败不影响主功能 */ }
}

/* ------------------------------------------------ 阶段② 归档总结（ADR-040） */

function memoryConfigOf(cfg) {
  return (cfg && cfg.memory) || {};
}

/** 解析 provider/model：配置优先，否则取第一个可用 provider 与其第一个模型。 */
async function resolveLlmRoute(llm, cfg) {
  const m = memoryConfigOf(cfg);
  let provider = String(m.provider || '').trim();
  let model = String(m.model || '').trim();
  try {
    if (!provider && typeof llm.listProviders === 'function') {
      const ps = llm.listProviders() || [];
      const first = ps[0];
      provider = typeof first === 'string' ? first : (first && (first.id || first.name)) || '';
    }
  } catch { /* 拿不到不抛 */ }
  try {
    if (!model && typeof llm.listModels === 'function') {
      const ms = await llm.listModels(provider);
      const arr = Array.isArray(ms) ? ms : ((ms && ms.models) || []);
      const f = arr[0];
      model = typeof f === 'string' ? f : (f && (f.id || f.name)) || '';
    }
  } catch { /* 拿不到不抛 */ }
  return { provider, model };
}

async function summarizeWithLlm(llm, provider, model, messages) {
  const sys = { role: 'system', content: [{ type: 'text', text: '你是会话归档助手。把下面的对话整理成简洁 Markdown：只写确定的结论、决策与理由、待办、涉及的文件路径。不要编造。' }] };
  const body = messages.slice(-40).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: m.text }] }));
  let text = '';
  for await (const chunk of llm.stream({ provider, model, messages: [sys, ...body] })) {
    if (!chunk) continue;
    if (chunk.kind === 'text-delta') text += (chunk.text ?? chunk.delta ?? '');
    if (chunk.kind === 'finish') break;
  }
  return text.trim();
}

/** 归档入口：事件回调与手动复用。任何失败都不抛（归档本身不能被总结拖垮）。 */
async function archiveSessionById(sessionId) {
  try {
    const cfg = await readConfig();
    const m = memoryConfigOf(cfg);
    if (!m.enabled || !m.onArchive) return { ok: false, skipped: 'disabled' };
    const plan = await archivePlan(DSH_HOME, sessionId);
    if (!plan.ok) return { ok: false, ...plan };
    const list = Array.isArray(m.workspaces) ? m.workspaces : [];
    if (list.length) {
      const hit = list.find(w => String(w.name).toLowerCase() === plan.title.toLowerCase());
      if (!hit || hit.enabled === false) return { ok: false, skipped: 'workspace-disabled', plan };
    }
    const t = await readSessionTranscript(DSH_HOME, sessionId);
    if (!t.ok) return { ok: false, ...t };
    const llm = HOST_CTX && HOST_CTX.reflect && typeof HOST_CTX.reflect.get === 'function'
      ? HOST_CTX.reflect.get('llm', false) : null;
    if (!llm) return { ok: false, error: '该 profile 没有可用的 llm 服务，跳过总结', plan };
    const route = await resolveLlmRoute(llm, cfg);
    if (!route.provider || !route.model) return { ok: false, error: '无法确定 provider/model（请在设置的记忆区填写）', plan };
    const summary = await summarizeWithLlm(llm, route.provider, route.model, t.messages);
    if (!summary) return { ok: false, error: '总结为空', plan };
    const block = `## ${new Date().toISOString().slice(0, 10)} 归档：${sessionId}\n\n- 工作区：${plan.title}\n- 模型：${route.provider}/${route.model}\n\n${summary}`;
    const w = await appendMemory(plan.file, block);
    if (m.userEnabled) await appendMemory(plan.userFile, block).catch(() => {});
    return { ok: true, plan, bytes: w.bytes, model: `${route.provider}/${route.model}` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function apply(ctx) {
  HOST_CTX = ctx;
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

  /* 归档事件（阶段②，ADR-040）：归档已持久化后触发，监听者自管后台工作。
     失败只记录，绝不影响归档本身。 */
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('workspace/session-archived', async (req) => {
        const id = req && req.sessionId;
        if (!id) return;
        const r = await archiveSessionById(id);
        if (r && r.ok) log(ctx, 'info', `归档总结已写入：${r.plan.file}`);
        else if (r && r.error) log(ctx, 'warn', `归档总结跳过：${r.error}`);
      });
    }
  } catch { /* 老版本没有该事件 */ }

  // 空闲自动推送 + 代码仓库定时提交：单一定时器，60s 一跳。
  // 两条路径各自读配置判自杀条件，未开启时零副作用。
  try {
    runtime.timer = setInterval(() => {
      autoPushTick(ctx).catch(() => {});
      codeRepoAutoTick(ctx).catch(() => {});
      pluginBackupAutoTick(ctx).catch(() => {});
      tidyTick(ctx).catch(() => {});
    }, 60_000);
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

/* ── 代码仓库定时提交 ────────────────────────────────────────────────
 *
 * 与 idle 自动推送**完全独立**的两套闸门（这一点很重要）：
 *   · idle 那套管「DSH 运行时状态」，条件看用户是不是离开了；
 *   · 这套管「用户自己的代码仓库」，条件只看「距上次提交过了多久」。
 * 混在一起会导致：用户只是没动 DSH，结果他的代码仓库被提交了。
 *
 * 不访网：是否真的要 push 由 syncCodeRepo 内部做 pull --rebase 决定。
 * 若仓库无改动也没提交，则完全不做网络往返（先 status 后决定）。
 */
const CODE_REPO_RUNTIME = { lastTickAt: null, lastResult: null };

async function codeRepoAutoTick(ctx) {
  let cfg;
  try { cfg = await readConfig(); } catch { return; }
  if (!cfg.codeRepoAutoEnabled) return;
  const minutes = Number(cfg.codeRepoAutoMinutes) || 0;
  if (minutes <= 0) return;

  const now = Date.now();
  /* 用全局嘀嗒而非每仓库各记时间：仓库清单变化时不丢状态，且实现简单。
     代价是「新加入的仓库会跟着下一个嘀嗒一起提交」——这反而是期望行为。 */
  if (CODE_REPO_RUNTIME.lastTickAt && now - CODE_REPO_RUNTIME.lastTickAt < minutes * 60_000) return;

  const list = codeRepoList(cfg).filter(r => r.enabled !== false);
  if (!list.length) return;

  /* 先快速看有哪个仓库真有改动；全都没改动就不进网络环节。 */
  const dirty = [];
  for (const r of list) {
    if (!fs.existsSync(path.join(r.path, '.git'))) continue;
    const st = await git(r.path, ['status', '--porcelain', '-uall'], 15000);
    if (st.ok && st.out) dirty.push(r);
  }
  if (!dirty.length) { CODE_REPO_RUNTIME.lastTickAt = now; return; }

  CODE_REPO_RUNTIME.lastTickAt = now;
  try {
    const r = await syncAllCodeRepos(cfg, {});
    CODE_REPO_RUNTIME.lastResult = { at: new Date().toISOString(), ok: r.ok, count: r.count };
    diag({ phase: 'code-repo-auto', ok: r.ok, count: r.count });
  } catch (e) {
    CODE_REPO_RUNTIME.lastResult = { at: new Date().toISOString(), ok: false, error: String(e && e.message || e) };
  }
}

export { name, inject, apply };
export const VERSION_INFO = VERSION;
// 供离线 smoke 测试用（node --check 查不出逻辑错，必须真跑一遍）。
export const __test = { memoryMap, archiveSessionById, tidyMemoryNow, editMemoryFile, resolveMemoryEditPath, codeRepoList, codeRepoState, codeReposPayload, syncCodeRepo, syncAllCodeRepos, divergeInfo, resolveKeepLocal, resolveKeepRemote, stampTrailer, purgePreview, purgeExecute, purgeVerify, sessionIdForms, walkSessionRefs, bareSessionId, sessionNoteTemplate, sessionNotePreview, sessionNoteWrite, resolveNotePath, sessionMigrateGroup, sessionMigratePreview, sessionMigrateExecute, sessionMigrateVerify, encodeWorkspaceGroup, decodeWorkspaceGroup, stateInfo, installInfo, idleStandard, mergeConfig, normalizeRemoteToHttps, repoFacts, normalizeWorkspaceMap, realWorkspaces, workspaceReport, selfCheck, channelState, readConfig, statusPayload, preflightReport: selfCheck, sessionDoctorScan, sessionDoctorApply, channelsOf, repoKeyOf, remoteOf, surfaceEnabled, diffLocalToPayload, stageChanges, commitChanges, pushChannels, pullChannels, applyPayload, ensureRepo, channelLabel, classifyPluginSpec, readInstalledPlugins, buildPluginManifest, readPluginManifest, writePluginManifest, backupPluginManifest, pluginRestorePreview, pluginRestoreExecute, pluginManifestPath, PLUGIN_BACKUP_RUNTIME };
