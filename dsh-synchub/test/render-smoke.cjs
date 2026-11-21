#!/usr/bin/env node
/* 浏览器半渲染冒烟（render-smoke）—— 用最小 react 桩把 client.js 真跑一遍。
   为什么必须有这个文件：
     `node --check` 只查语法，查不出「少个逗号导致 e(...) 被当函数调用」这类
     运行时才炸的错误；而那个错误只在 form 非空（配置读回来了）时才求值，
     于是首帧正常、数据一到整块设置页白屏，用户看到的就是「点 Msynchub 什么都没有」。
     2026-11-18 线上就是踩了这个坑，故补此测试。

   覆盖：
     A. 模块能加载，apply 注册出 sidebar.panellist / main / settings.section
     B. 首帧（所有 state 为初值、接口未回）渲染不抛错
     C. 有数据（真实 config/status/map 形状）渲染不抛错，且文本量达到“看得见”的下限
     D. 同一组件连续渲染两次，钩子调用序列必须一致（条件 hooks 会让真 React 抛错→白屏）
     E. 无头环境下不依赖 DOM / fetch 真网络

   用法：node test/render-smoke.cjs
   退出码：0 全绿；1 有失败。 */
'use strict';

const fs = require('fs');
const path = require('path');

// 允许指向别的副本（仅在验证测试本身有效时用，正常跑不传）。
const clientFile = process.env.SYNCHUB_CLIENT || path.join(__dirname, '..', 'lib', 'client.js');
const code = fs.readFileSync(clientFile, 'utf8');

let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

/* ------------------------------------------------------------------ react 桩 */
const trail = [];
let comp = 'root';
let values = [];
let cursor = 0;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity) };
  },
  Fragment: Symbol('Fragment'),
  useState(init) {
    trail.push(comp + ':useState');
    const v = cursor < values.length ? values[cursor++] : (typeof init === 'function' ? init() : init);
    return [v, () => {}];
  },
  useEffect() { trail.push(comp + ':useEffect'); },
  useLayoutEffect() {},
  useCallback(fn) { trail.push(comp + ':useCallback'); return fn; },
  useMemo(fn) { trail.push(comp + ':useMemo'); return fn(); },
  useRef(v) { trail.push(comp + ':useRef'); return { current: v }; },
};

/* ------------------------------------------------------------------ 加载模块 */
let exported = null;
global.window = {
  __ModuleLoader__: {
    load(def) {
      exported = def.factory(name => {
        if (name === 'react') return React;
        throw new Error('unexpected require: ' + name);
      });
    },
  },
};

let loadErr = null;
try {
  new Function('window', code)(global.window);
} catch (e) { loadErr = e; }

console.log('A. 模块加载与槽位注册');
ok('client.js 可被 ModuleLoader 加载', !loadErr, loadErr && loadErr.message);
ok('导出 name/inject/apply', Boolean(exported && exported.name && exported.inject && exported.apply));
ok('inject 声明了 slots', Boolean(exported && exported.inject && exported.inject.indexOf('slots') >= 0));

const slots = {};
let applyErr = null;
try {
  exported.apply({
    slots: {
      inject(name, fn) { fn(); },
      register(meta, comp) { slots[meta.name] = comp; return () => {}; },
    },
  });
} catch (e) { applyErr = e; }
ok('apply 不抛错', !applyErr, applyErr && applyErr.message);
ok('注册 sidebar.panellist', typeof slots['sidebar.panellist'] === 'function');
ok('注册 main', typeof slots.main === 'function');
ok('注册 settings.section', typeof slots['settings.section'] === 'function');

/* ------------------------------------------------------------------ 渲染器 */
function renderTree(component, stateValues) {
  values = stateValues || [];
  cursor = 0;
  trail.length = 0;
  const errors = [];
  const texts = [];
  let nodes = 0;

  function walk(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    nodes++;
    if (node.type === React.Fragment) { node.children.forEach(walk); return; }
    if (typeof node.type === 'function') {
      const name = node.type.name || 'anon';
      const prev = comp; comp = name;
      let out;
      try { out = node.type(node.props || {}); }
      catch (err) { errors.push(name + ': ' + err.message); comp = prev; return; }
      comp = prev;
      walk(out);
      return;
    }
    if (node.type === 'style') return;
    (node.children || []).forEach(walk);
  }

  let root;
  try { root = component(); }
  catch (e) { return { threw: e, errors, nodes, text: '', trail: trail.slice() }; }
  walk(root);

  // 文本量：真实 DOM 里这些就是用户能看见的字；白了就没字。
  const text = texts.join(' ').replace(/\s+/g, ' ').trim();
  return { threw: null, errors, nodes, text, trail: trail.slice() };
}

/* 真实数据形状（取自 2026-11-18 本机接口实际返回，剪到必要字段） */
const CONF = {
  ok: true,
  config: {
    machine: 'RedmiPro',
    workspace: 'C:\\dsh\\workspace1',
    workspaceRoot: 'C:\\dsh',
    workspaceMap: [],
    showInSidebar: true,
    channels: {
      config: { remote: 'https://github.com/u/dsh-config.git', enabled: true },
      sessions: { remote: 'https://github.com/u/dsh-sessions.git', enabled: true },
    },
    surfaces: {},
    autoPush: false,
    idlePushMinutes: 15,
    staleHours: 24,
  },
};
const STATUS = {
  ok: true,
  machine: 'RedmiPro',
  profile: 'desktop',
  dshHome: 'C:\\Users\\u\\.dsh',
  channels: {
    config: { remote: 'https://github.com/u/dsh-config.git', behind: 0, ahead: 0, dirty: 0, lastCommitAt: null },
    sessions: { remote: 'https://github.com/u/dsh-sessions.git', behind: 0, ahead: 0, dirty: 0, lastCommitAt: null },
  },
  surfaces: [
    { id: 'sessions', label: '会话', tier: 'safe', on: true, note: '可同步' },
    { id: 'runtimes', label: '运行时', tier: 'danger', on: false, note: '永不同步' },
  ],
  workspaceReport: {
    rows: [], missingInMap: [], suggestions: [{ name: 'base', path: 'C:\\dsh\\base' }],
  },
  state: { initialized: false, root: 'C:\\Users\\u\\.dsh\\dsh-synchub', repos: {}, backupCount: 0, hint: '' },
  install: null,
};
const MAP = { ok: true, rows: [], deep: false };

console.log('\nB. 首帧渲染（接口未回 / state 为初值）');
const s0 = renderTree(slots['settings.section'], []);
ok('settings.section 首帧不抛错', !s0.threw, s0.threw && s0.threw.message);
ok('settings.section 首帧无子组件报错', s0.errors.length === 0, s0.errors.join('; '));
ok('settings.section 首帧有可见文字', s0.text.length > 200, 'text=' + s0.text.length);
const p0 = renderTree(slots.main, []);
ok('main 首帧不抛错', !p0.threw, p0.threw && p0.threw.message);
ok('main 首帧无子组件报错', p0.errors.length === 0, p0.errors.join('; '));
ok('main 首帧有可见文字', p0.text.length > 100, 'text=' + p0.text.length);

console.log('\nC. 有数据渲染（配置已读回 —— 线上白屏就发生在这里）');
const conf = CONF.config;
// SettingsSection 的 useState 顺序：form, saved, check, status, map, busy, msg, deep
const settingsFilled = [conf, conf, { ok: true, checks: [] }, STATUS, MAP, '', { text: '', kind: '' }, false];
const s1 = renderTree(slots['settings.section'], settingsFilled);
ok('settings.section 有数据不抛错', !s1.threw, s1.threw && s1.threw.message);
ok('settings.section 有数据无子组件报错', s1.errors.length === 0, s1.errors.join('; '));
ok('settings.section 有数据文字量 > 首帧', s1.text.length > 2000, 'text=' + s1.text.length);
ok('settings.section 显示了仓库地址', s1.text.indexOf('dsh-config') >= 0 || s1.text.indexOf('私有仓库') >= 0);
ok('settings.section 有工作区表按钮', s1.text.indexOf('检查并自动填写') >= 0);
ok('settings.section 有分组标题', s1.text.indexOf('必做') >= 0 && s1.text.indexOf('诊断与维护') >= 0);

// 空 workspaceMap 时，表格必须还有一行可编辑（否则「无法输入」回归）
const emptyMapConf = JSON.parse(JSON.stringify(conf));
emptyMapConf.workspaceMap = [];
const s2 = renderTree(slots['settings.section'], [emptyMapConf, emptyMapConf, null, STATUS, MAP, '', { text: '', kind: '' }, false]);
ok('空工作区映射仍渲染出输入行', !s2.threw && s2.text.indexOf('＋ 增加一行') >= 0, s2.threw && s2.threw.message);

// missingInMap 非空：这条分支正是本次白屏的触发点，必须单独覆盖
const missStatus = JSON.parse(JSON.stringify(STATUS));
missStatus.workspaceReport.missingInMap = [{ name: 'base', path: 'C:\\dsh\\base', pathExists: true }];
const s3 = renderTree(slots['settings.section'], [conf, conf, null, missStatus, MAP, '', { text: '', kind: '' }, false]);
ok('missingInMap 非空分支不抛错', !s3.threw, s3.threw && s3.threw.message);
ok('missingInMap 非空时出现「全部加入」', !s3.threw && s3.text.indexOf('全部加入') >= 0);

// Panel 有数据
const panelFilled = [STATUS, { ok: true, checks: [] }, MAP, '', '', '', [], null, { ok: true, ready: true, headline: '可以同步' }, '', '', null, '', '', null, null];
const p1 = renderTree(slots.main, panelFilled);
ok('main 有数据不抛错', !p1.threw, p1.threw && p1.threw.message);
ok('main 有数据无子组件报错', p1.errors.length === 0, p1.errors.join('; '));
ok('main 有数据文字量 > 首帧', p1.text.length > 500, 'text=' + p1.text.length);

/* 仪表盘回归（2026-11-18）：侧边栏首屏必须直接回答四个问题。
   之前它是一大段「还缺两个仓库地址」的说明全文，用户原话「太难毣」。 */
const dashStatus = JSON.parse(JSON.stringify(STATUS));
dashStatus.summary = { pending: 7, unsynced: 7, behind: 0, ahead: 2, scanned: true, payloadMissing: [] };
dashStatus.auto = { ...(dashStatus.auto || {}), enabled: true, idlePushMinutes: 20, nextAt: new Date(Date.now() + 8 * 60000).toISOString() };
const p2 = renderTree(slots.main, [dashStatus, { ok: true, checks: [] }, MAP, '', '', '', [], null, { ok: true, ready: true, headline: '可以同步' }, '', '', null, '', '', null, null]);
ok('仪表盘：首屏显示待同步数', !p2.threw && p2.text.indexOf('待同步') >= 0, p2.threw && p2.threw.message);
ok('仪表盘：显示落后/待推送/自动同步四个格子',
  !p2.threw && p2.text.indexOf('落后') >= 0 && p2.text.indexOf('待推送') >= 0 && p2.text.indexOf('自动同步') >= 0);
ok('仪表盘：回答「下次自动是什么时候」',
  !p2.threw && p2.text.indexOf('下次自动') >= 0, '未找到「下次自动」');
ok('仪表盘：提供手动触发按钮',
  !p2.threw && p2.text.indexOf('提交并推送') >= 0 && p2.text.indexOf('重新检查') >= 0);
ok('仪表盘：一句话结论在最前',
  !p2.threw && /还有 \d+ 处本机变动没同步上去/.test(p2.text), p2.text.slice(0, 120));

/* 0.6.0（ADR-029/030）：主按钮改为「立即同步」，纯推送降为次按钮；分叉时出现二选一卡，退回旧按钮布局必须被拦住。 */
ok('仪表盘：主按钮是「立即同步」，旧的纯推送仍在',
  !p2.threw && p2.text.indexOf('立即同步') >= 0 && p2.text.indexOf('提交并推送') >= 0);
const divStatus = JSON.parse(JSON.stringify(STATUS));
divStatus.summary = { pending: 1, unsynced: 1, behind: 3, ahead: 2, diverged: true, scanned: true, payloadMissing: [] };
divStatus.channels.config.behind = 3; divStatus.channels.config.ahead = 2;
const pDiv = renderTree(slots.main, [divStatus, { ok: true, checks: [] }, MAP, '', '', '', [], null, { ok: true, ready: true, headline: '可以同步' }, '', '', null, '', '', null, null]);
ok('分叉时出现二选一卡',
  !pDiv.threw && pDiv.text.indexOf('分叉处理') >= 0 && pDiv.text.indexOf('以本机为准') >= 0 && pDiv.text.indexOf('以远端为准') >= 0,
  pDiv.threw && pDiv.threw.message);
ok('分叉时一句话结论明确说普通同步会失败',
  !pDiv.threw && pDiv.text.indexOf('普通同步会失败') >= 0);
ok('分叉时拉取按钮被禁用提示不走普通拉取',
  !pDiv.threw && pDiv.text.indexOf('普通拉取会失败') >= 0);
/* own=null（接口还没回）时，绝不能声称「未配置远端」——
   那正是超时导致的误导：配置完全正常但面板让用户去填地址。 */
const pNull = renderTree(slots.main, [null, null, null, '', '', '', [], null, null, '', '', null, '', '', null, null]);
ok('接口未回时不误报「未配置远端」',
  !pNull.threw && pNull.text.indexOf('还缺两个仓库地址') < 0,
  'own=null 时不应出现仓库地址引导卡');

/* 首帧文案（2026-11-19 用户反馈）：「刚进侧边栏显示错误（未配置），过一会儿才刷新出来」。
   根因是 noRemote 直接看 conf.remote，而 own 未回来时 conf 退化成 {}，
   于是首帧把「还不知道」画成了红色「还没连仓库」。
   断言要求：首帧既不能说「没连仓库」，也不能说「已同步」，必须是中性的读取中。 */
ok('首帧不报红「没连仓库」', !pNull.threw && pNull.text.indexOf('还没连仓库') < 0,
  'text=' + (pNull.text || '').slice(0, 150));
ok('首帧显示中性的「正在读取」而不是错误', !pNull.threw && pNull.text.indexOf('正在读取') >= 0,
  '首帧应说明正在读取，实际：' + (pNull.text || '').slice(0, 120));
ok('首帧不谎称「已同步，不用管」', !pNull.threw && pNull.text.indexOf('已同步，不用管') < 0);

/* 读不到（有错误、无数据）必须与「没配置」区分：这是「不知道」，不是「你错了」。
   用户什么都不用做，或者只点一次重试 —— 不该被引导去改设置。 */
const pUnknown = renderTree(slots.main, [null, null, null, '', '接口读不到', '', [], null, null, '', '', null, '', '', null, null]);
ok('读不到时提示可重试，而不是让用户去填地址',
  !pUnknown.threw && pUnknown.text.indexOf('没读到') >= 0 && pUnknown.text.indexOf('还没连仓库') < 0,
  (pUnknown.text || '').slice(0, 150));

/* 另外：代码仓库卡只在登记了仓库时出现，没配就不该占首屏位置。 */
const repoStatus = JSON.parse(JSON.stringify(STATUS));
const pRepoNone = renderTree(slots.main, [repoStatus, { ok: true, checks: [] }, MAP, '', '', '', [], null,
  { ok: true, ready: true, headline: '可以同步' }, '', '', null, '', '', null, null, { ok: true, repos: [], total: 0, auto: { enabled: false, minutes: 0 } }]);
ok('没登记代码仓库时不显示代码仓库卡',
  !pRepoNone.threw && pRepoNone.text.indexOf('代码仓库') < 0,
  '空清单不该占位置');
const pRepoOne = renderTree(slots.main, [repoStatus, { ok: true, checks: [] }, MAP, '', '', '', [], null,
  { ok: true, ready: true, headline: '可以同步' }, '', '', null, '', '', null, null,
  { ok: true, total: 1, auto: { enabled: true, minutes: 60 }, repos: [{ id: 'dsh-base', path: 'C:\\dsh\\base', enabled: true, branch: 'main', unsynced: 3, ahead: 1, behind: 0, diverged: false, lastCommit: 'abc1234 x' }] }]);
ok('登记了代码仓库时显示卡片与同步按钮',
  !pRepoOne.threw && pRepoOne.text.indexOf('代码仓库') >= 0 && pRepoOne.text.indexOf('全部同步') >= 0,
  pRepoOne.threw && pRepoOne.threw.message);
ok('代码仓库卡显示未提交数与分支',
  !pRepoOne.threw && pRepoOne.text.indexOf('3 未提交') >= 0 && pRepoOne.text.indexOf('dsh-base') >= 0);

/* 版本错配：刷页面会加载新版 client，但宿主半要重启才生效。
   旧宿主半不返回 summary，此时绝不能把四个 0 当成「已同步」，更不能静默。 */
const legacyStatus = JSON.parse(JSON.stringify(STATUS));
delete legacyStatus.summary;
legacyStatus.channels.config.dirty = 3;
legacyStatus.channels.sessions.dirty = 2;
const pLegacy = renderTree(slots.main, [legacyStatus, { ok: true, checks: [] }, MAP, '', '', '', [], null, { ok: true, ready: true, headline: '可以同步' }, '', '', null, '', '', null, null]);
ok('旧宿主半（无 summary）时从旧字段回退，不报假绿',
  !pLegacy.threw && pLegacy.text.indexOf('已同步，不用管') < 0, '回退失败：把无数据当成了已同步');
ok('旧宿主半时明确提示需要完全重启',
  !pLegacy.threw && pLegacy.text.indexOf('宿主半还是旧版') >= 0, '未提示版本错配');

console.log('\nD. 钩子序稳定性（条件 hooks 会让真 React 抛错 → 整块白屏）');
const a = renderTree(slots['settings.section'], settingsFilled);
const b = renderTree(slots['settings.section'], settingsFilled);
ok('settings.section 两次渲染钩子序一致',
  a.trail.join('|') === b.trail.join('|'),
  'len ' + a.trail.length + ' vs ' + b.trail.length);
ok('settings.section 钩子数 > 0', a.trail.length > 0, 'len=' + a.trail.length);

const c1 = renderTree(slots.main, panelFilled);
const c2 = renderTree(slots.main, panelFilled);
ok('main 两次渲染钩子序一致',
  c1.trail.join('|') === c2.trail.join('|'),
  'len ' + c1.trail.length + ' vs ' + c2.trail.length);

const src0 = code;
console.log('\nE0. 代码仓库编辑卡（可在设置里增删任意仓库）');
ok('源码里有代码仓库编辑表（form.codeRepos 可增删）',
  /Array\.isArray\(form\.codeRepos\)/.test(src0),
  '找不到 codeRepos 的编辑入口');
ok('代码仓库表有「增加一个仓库」按钮',
  /增加一个仓库/.test(src0), '没有添加按钮，用户无法自己加第三个仓库');
ok('代码仓库表有「移除」按钮（不删磁盘）',
  /不会删磁盘上的仓库/.test(src0), '移除语义必须说清，否则用户以为会删仓库');
ok('代码仓库卡没被挂载会是死代码',
  /^\s+repoCard,$/m.test(src0), 'repoCard 定义了但没渲染（本会话已踩过一次）');
ok('设置页有定时自动提交开关', /codeRepoAutoEnabled/.test(src0));
ok('设置页有定时间隔输入', /codeRepoAutoMinutes/.test(src0));

console.log('\nE0b. 会话体检卡（ADR-034：目录改名后自动检查修复）');
ok('体检卡被真正挂载，不是死代码', /^\s+doctorCard,$/m.test(src0),
  'doctorCard 定义了但没渲染');
ok('体检卡默认不自动扫描（首屏不付磁盘往返）',
  !/useEffect\(\(\) => \{[^}]*doDoctorScan/.test(src0),
  '体检不应在 useEffect 里自动跑，100+ 目录逐个解首帧很贵');
ok('体检先只读扫描、再让用户选动作',
  /\/session-doctor/.test(src0) && /confirm: 'REPAIR'/.test(src0),
  '扫描与执行必须是两步，不能一个按钮直接改 workspace.json');
ok('执行时 confirm 逐字为 REPAIR',
  /const body = \{ confirm: 'REPAIR' \}/.test(src0),
  'confirm 写错就永远执行不了');
ok('改指必须带 targets（不让前端猜目标）',
  /body\.targets = targets/.test(src0) && /\{ \[act0\.id\]: wsId \}/.test(src0),
  'relocate 不带 targets 会被后端拒绝');
ok('体检卡文案说清「数据没丢」而不是只报错误',
  /数据不会因此丢失/.test(src0),
  '用户最怕丢数据，必须先回答这个问题');
ok('改完提示要重启 DSH 才刷新归属',
  /重启 DSH 才按新分组显示/.test(src0),
  '不说明就会让人以为没修好');

/* E0c — 体检卡的真渲染。
   E0b 那几条全是源码正则，查不出渲染期才求值的错误（历史上就因此白屏过两次）。
   E0c 真跑五种状态：未扫描 / 有发现 / 接口报错 / 干净 / 缺字段。
   fixture 必须带 impact + health + rescue —— 0.9.0 把判定从「整齐不整齐」
   改成「能不能用」，没了这三个字段就测不到真正的分支。
   注意 Panel 的 state 是「按位置」注入的，index 0~17 先用 undefined 占位，
   doctor 在 18、doctorBusy 19、doctorErr 20、doctorPick 21。 */
const doctorFixture = {
  ok: true,
  at: Date.now(),
  dshHome: 'C:\\Users\\x\\.dsh',
  counts: { workspaces: 2, groups: 3, sessionDirs: 9, topLevel: 8, subagent: 1, broken: 0,
    registered: 4, archived: 0, workspaceFileMissing: false },
  /* 改指是 blocking 但 safe=false → 不自作主张搬；悬空引用可一键清 → repairable。 */
  summary: { error: 0, warn: 2, info: 1, fixable: 1, needsChoice: 2, total: 3,
    blocking: 2, advisory: 1, rescue: 1, misc: 1, needsHuman: 1, health: 'repairable' },
  rescue: { needed: true, ids: ['drop:abc'], humanCodes: ['orphan-group-relocatable'] },
  misc: { ids: ['rmdir:--C-dsh-gone--'], count: 1 },
  findings: [
    { code: 'orphan-group-relocatable', severity: 'warn', impact: 'blocking',
      title: '组 --C-dsh-old-- 的 1 个会话可改指到一个现存工作区',
      detail: '原目录已不存在，典型原因是目录被改名了。',
      fixable: true, actionId: 'relocate:--C-dsh-old--' },
    { code: 'dangling-ref', severity: 'warn', impact: 'blocking',
      title: '1 条登记指向已删除的会话',
      detail: '清引用即可，不碰任何正文文件。',
      fixable: true, actionId: 'drop:abc' },
    { code: 'empty-group', severity: 'info', impact: 'advisory',
      title: '空组 --C-dsh-gone--', detail: '改名后留下的空壳。',
      fixable: true, actionId: 'rmdir:--C-dsh-gone--' },
  ],
  actions: [
    { id: 'relocate:--C-dsh-old--', kind: 'relocate-group', code: 'orphan-group-relocatable',
      safe: false, label: '把 1 个会话改指到「dw-plugin」（可改选）',
      payload: { group: '--C-dsh-old--', ids: ['session-a'], candidates: [
        { wsId: 'ws-1', title: 'dw-plugin', path: 'C:\\dsh\\dw-plugin', score: 0 },
        { wsId: 'ws-2', title: 'dw-base', path: 'C:\\dsh\\dw-base', score: 0 }] } },
    { id: 'drop:abc', kind: 'drop-ref', code: 'dangling-ref',
      safe: true, label: '清掉悬空引用', payload: { sessionId: 'abc', wsIds: ['ws-1'] } },
    { id: 'rmdir:--C-dsh-gone--', kind: 'rmdir', code: 'empty-group',
      safe: true, label: '删掉空组', payload: { group: '--C-dsh-gone--' } },
  ],
};
/* baseArgs 已填 index 0~15（own…notePreview）。
   后面依次是 repos=16、divergeData=17、doctor=18、doctorBusy=19、doctorErr=20、doctorPick=21。
   repos/divergeData 显式传 null（与其 useState 初值一致），否则 undefined 会把初始化函数盖掉。 */
const pad = (doctorVals) => [null, null, doctorVals[0], doctorVals[1], doctorVals[2], doctorVals[3]];
const baseStatus = JSON.parse(JSON.stringify(STATUS));
const baseArgs = [baseStatus, { ok: true, checks: [] }, MAP, '', '', '', [], null,
  { ok: true, ready: true, headline: '可以同步' }, '', '', null, '', '', null, null];
const renderPanel = (doctorVals) => renderTree(slots.main, baseArgs.concat(pad(doctorVals)));

// ① 未扫描：必须只能说「尚未检查」，不能报错也不能声称正常。
const d0 = renderPanel([null, '', '', {}]);
ok('体检未扫描时渲染不抛错', !d0.threw, d0.threw && d0.threw.message);
ok('体检未扫描显示「尚未检查」', !d0.threw && d0.text.indexOf('尚未检查') >= 0);
ok('体检未扫描不谎称「能用」也不谎称「有问题」',
  !d0.threw && d0.text.indexOf('● 能用') < 0 && d0.text.indexOf('要你定') < 0);
ok('体检卡有扫描按钮', !d0.threw && d0.text.indexOf('检查一下') >= 0);

// ② 扫完有发现：这是真正会求值 payload.candidates 的路径。
const d1 = renderPanel([doctorFixture, '', '', {}]);
ok('体检有发现时渲染不抛错', !d1.threw, d1.threw && d1.threw.message);
ok('体检有发现时无子组件报错', d1.errors.length === 0, d1.errors.join('; '));
ok('体检列出问题标题', !d1.threw && d1.text.indexOf('可改指到一个现存工作区') >= 0);
ok('体检结论说「能不能用」而不是「查到几条」',
  !d1.threw && d1.text.indexOf('能修') >= 0,
  '徽标应该是「能用/能修/要你定」三种之一');
ok('体检把整洁项折进 details，不占首屏',
  !d1.threw && d1.text.indexOf('明细与整洁项') >= 0,
  '重复登记/空组这类不该占首屏，必须折叠');
ok('可改指项渲染出候选下拉（真求值 candidates）',
  !d1.threw && JSON.stringify(d1).length > 0 && d1.text.indexOf('dw-plugin（C:\\dsh\\dw-plugin）') >= 0,
  '下拉没渲染出来，可能是 payload.candidates 求值出错');
ok('安全项按钮不要求二次确认',
  !d1.threw && d1.text.indexOf('清掉悬空引用') >= 0);
ok('非安全项按钮文案带「确认并」',
  !d1.threw && d1.text.indexOf('确认并把 1 个会话改指') >= 0);
ok('只有可一键救援的项才进总按钮（改指不进）',
  !d1.threw && /一键修复（1）/.test(d1.text),
  '改指要人给目标，不能默默默认第一个候选就往一键里塞');
ok('有可救援项时出现一个总修复按钮', !d1.threw && d1.text.indexOf('一键修复') >= 0);
ok('体检卡说明回滚点', !d1.threw && d1.text.indexOf('回滚点') >= 0);

// ③ 异常：错误必须显示成 alert，而不是静默。
const d2 = renderPanel([null, '', '体检异常：boom', {}]);
ok('体检报错时渲染不抛错', !d2.threw, d2.threw && d2.threw.message);
ok('体检报错时显示错误文案', !d2.threw && d2.text.indexOf('体检异常：boom') >= 0);

// ④ 干净现场：0 发现时必须给明确结论，不能只留一堆数字。
const cleanDoc = JSON.parse(JSON.stringify(doctorFixture));
cleanDoc.findings = []; cleanDoc.actions = [];
cleanDoc.summary = { error: 0, warn: 0, info: 0, fixable: 0, needsChoice: 0, total: 0 };
const d3 = renderPanel([cleanDoc, '', '', {}]);
ok('体检无问题时明确说「能用」',
  !d3.threw && d3.text.indexOf('能用') >= 0 && d3.text.indexOf('没有需要你处理的问题') >= 0);
ok('体检无问题时不给修复按钮', !d3.threw && d3.text.indexOf('一键修复') < 0);

/* ⑤ 缺字段不能崩：旧版宿主半不返回 candidates / summary 时必须降级。
   这是「新版 client + 旧版 index」的真实升级态。 */
const partialDoc = { ok: true, at: Date.now(), counts: {}, summary: {},
  findings: [{ code: 'x', severity: 'warn', title: 'T', detail: 'D', actionId: 'a1' }],
  actions: [{ id: 'a1', kind: 'relocate-group', safe: false, label: 'L', payload: {} }] };
const d4 = renderPanel([partialDoc, '', '', {}]);
ok('体检缺 candidates/summary 时不崩', !d4.threw, d4.threw && d4.threw.message);

console.log('\nE1. 打开侧边栏不强制刷新（20 分钟缓存 + 上次检查时间）');
ok('有跨挂载缓存（模块级，卸载不丢）', /const PANEL_CACHE = \{/.test(src0),
  '缓存必须在组件外，否则卸载即丢，下次打开照样要等');
ok('缓存 TTL 是 20 分钟', /PANEL_TTL_MS = 20 \* 60 \* 1000/.test(src0));
ok('首帧用缓存初始化（不是 null）',
  /useState\(\(\) => PANEL_CACHE\.own\)/.test(src0),
  '首帧若为 null 就会显示「正在读取」，等于没省那一次等待');
ok('刷新结果回写缓存', /panelCacheStore\(/.test(src0));
ok('头部时间说明新鲜度（不只是「检查于」）',
  /checkedAtText\(/.test(src0), '要告诉用户这个数新不新');
ok('时间文案含「结果」与分钟数', /分钟内沿用|正在后台更新/.test(src0));
ok('没有时间时不说谎', /尚未检查/.test(src0));

console.log('\nE. 源码级护栏（防止同类逗号/调用错误再引入）');
const src = code;
/* 曾经的 bug：`e('div', {...}, …)` 后面漏逗号，下一行开头的 `(cond ? …)` 就被当作
   上一个表达式的“函数调用” → `e(...) is not a function`。
   只做静态正则是不够的（注释行会夹在中间，见下），所以真正的把守是 C 段的有数据渲染；
   这里继续保留，作为“在浏览器里才会报、报在别处”时的快速线索。 */
/* 先把行尾统一成 \n：源文件可能是 CRLF，手工构造的文件还可能带 \r\r\r\r\n，
   不归一化的话 `\r?\n` 直接匹配不到，护栏就变成永远绿的空测。 */
const srcNoComments = src
  .replace(/\r+/g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
ok('不存在 “…)) 换行后 (cond” 这种漏逗号形态',
  !/\)\)[ \t]*\n\s*\((status|form|map|check)\s*&&/.test(srcNoComments));
ok('不存在 "}, 字面量)) 换行后 (cond" 这种漏逗号形态（同上，去注释后）',
  !/\}, '[^']*'\)\)[ \t]*\n\s*\((status|form|map|check)\s*&&/.test(srcNoComments));
/* 体检卡把 payload.candidates 当数组取元素。旧版宿主半不给 payload 时
   直接下标就是渲染期 TypeError → 整块侧边栏白屏（本文件本次真扫到过）。
   只允许经 candsOf / firstCand 取，不允许裸下标。 */
ok('体检卡不用裸 payload.candidates[0]（缺 payload 会渲染期崩溃）',
  !/\.payload\.candidates\s*\[/.test(srcNoComments),
  '请改用 candsOf(act) / firstCand(act)');
ok('candsOf 对非数组 candidates 返回空数组',
  /Array\.isArray\(p\.candidates\)\)\s*\?\s*p\.candidates\s*:\s*\[\]/.test(srcNoComments));
ok('settings.section 标签为 Msynchub', /label: 'Msynchub'/.test(src));
ok('侧栏标签为 Msynchub', /label: 'Msynchub'/.test(src));

console.log('\n' + (failed ? 'FAILED: ' + failed + ' 项' : 'ALL PASS'));
process.exit(failed ? 1 : 0);
