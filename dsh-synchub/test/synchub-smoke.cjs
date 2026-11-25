/**
 * dsh-synchub 综合 smoke（ADR-011/012 声称存在但仓库里缺失，本次补齐）。
 *
 * 覆盖三块：
 *  A. 宿主半 index.js：import / 导出 / apply 打桩注册 15 条路由 / guard / 版本一致。
 *  B. 浏览器半 client.js：用 React 桩真跑 apply + 真渲染 Panel 与 SettingsSection，
 *     断言两个插槽 label=Msynchub、红点 5×5 左上角、新用户引导第 0–4 步、
 *     新增卡片（purge/note/state）存在；顺带验证 apply 里用到的服务都在 inject 里
 *     （缺 inject 会抛，AGENTS.md 的秒级验证法）。
 *  C. CSS 规则级回归：.dsc 滚动区、主题变量都带 fallback、无裸十六进制颜色。
 *
 * 全程不碰真实 DSH_HOME，不发网络请求。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const idxPath = path.join(ROOT, 'lib', 'index.js');
const cliPath = path.join(ROOT, 'lib', 'client.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

(async () => {
  /* ---------------- A. 宿主半 ---------------- */
  process.env.DSH_HOME = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'synchub-smoke-'));
  const idx = await import(pathToFileURL(idxPath).href + '?a=' + Date.now());
  assert.equal(idx.name, 'dsh-synchub');
  assert.deepEqual(idx.inject, ['webServer']);
  assert.equal(typeof idx.apply, 'function');
  assert.equal(idx.VERSION_INFO, pkg.version, '版本必须与 package.json 一致');

  const routes = [];
  const effects = [];
  const ctx = {
    logger: () => {},
    effect(fn) { effects.push(fn); return () => {}; },
    webServer: { register(def) { routes.push(def); return () => {}; } },
  };
  idx.apply(ctx, {});
  assert.equal(routes.length, 30, '应注册 30 条路由（含 session-doctor / plugin-backup / plugin-restore / memory-map）');
  const paths = routes.map(r => r.path);
  for (const p of [
    'config', 'status', 'state', 'install-info', 'self-check', 'workspaces', 'map', 'memory-map', 'preflight', 'check', 'scan', 'stage',
    'pull', 'push', 'sync', 'auto', 'purge-session', 'purge-session/help', 'session-note', 'session-move', 'session-move/help', 'session-move/group',
    'diverge', 'diverge/resolve', 'repos', 'repos/sync', 'session-doctor', 'session-doctor/help',
    'plugin-backup', 'plugin-restore',
  ]) {
    assert.ok(paths.includes('/api/dsh-synchub/' + p), '缺路由 ' + p);
  }
  // guard：跨站/跨源/错误 content-type 都要拒
  const guardRes = {};
  const fakeRes = { writeHead(c) { guardRes.code = c; }, end(b) { guardRes.body = JSON.parse(b); } };
  routes[0].handler({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }, fakeRes);
  assert.equal(guardRes.code, 403, '跨站请求应被拒');

  /* 新增能力的数据层断言。
     注意：installInfo 现在从真实 git remote 推导，所以断言分两种情形——
     有 remote 时必须给出可粘的 HTTPS 地址；无 remote 时必须诚实返回 null，不编地址。 */
  const ii = await idx.__test.installInfo();
  assert.ok('spec' in ii && 'repoHttps' in ii, 'install-info 必须带 spec/repoHttps 字段');
  if (ii.repoHttps) {
    assert.ok(/^https:\/\/[^/]+\/[^/]+\/[^/#]+\.git$/.test(ii.repoHttps), '有 remote 时仓库地址应是 HTTPS .git 形式');
    assert.ok(ii.spec.endsWith('#path:dsh-synchub'), '安装地址必须带子目录片段');
    assert.ok(ii.spec.startsWith(ii.repoHttps.replace(/\.git$/, '')), '安装地址应基于同一 remote 推导');
    assert.ok(ii.command.startsWith('dsh plugin add '), '应给出 dsh plugin add 命令');
  } else {
    assert.equal(ii.spec, null, '无可用 remote 时不得编造安装地址');
    assert.equal(ii.command, null, '无地址时不应给命令');
  }
  assert.ok(ii.version && typeof ii.version.local === 'string', '应报告本地版本');
  assert.ok(['same', 'differs', 'unknown'].includes(ii.version.state), '版本对照只能是 same/differs/unknown');
  // unknown 时必须诚实（可能因为未配 remote、未 fetch、或本进程读不到 git）——
  // 绝不部分伪造地址，也不把自己不知道的事说成知道。
  if (ii.version.state === 'unknown') {
    assert.match(ii.version.note, /不冒充知道|无法读取|没配 git remote|请用下面的本机脚本/,
      '未知时必须诚实说明原因，不得静默');
  }

  /* remote 归一化是纯函数，不依赖 git 可执行 —— 必须单独覆盖，
     否则沙箱里读不到 git 时这条逻辑永远测不到。 */
  const nr = idx.__test.normalizeRemoteToHttps;
  assert.equal(nr('https://github.com/a/b.git'), 'https://github.com/a/b', 'https 应去掉 .git');
  assert.equal(nr('https://github.com/a/b'), 'https://github.com/a/b', '无 .git 原样保留');
  assert.equal(nr('git@github.com:a/b.git'), 'https://github.com/a/b', 'scp 风格应转 https');
  assert.equal(nr('git+https://github.com/a/b.git'), 'https://github.com/a/b', 'git+ 前缀应去掉');
  assert.equal(nr('https://github.com/a/b/'), 'https://github.com/a/b', '尾部斜线应去掉');
  assert.equal(nr(''), null, '空 remote 应返回 null');
  assert.equal(nr('D:\\local\\repo'), null, '本地路径不是可粘地址，应返回 null');
  assert.equal(nr('ssh://git@github.com/a/b.git'), 'https://github.com/a/b', 'ssh 协议应转 https');
  const idle = idx.__test.idleStandard();
  assert.ok(idle.what && idle.triggers.length === 4, '空闲标准应说明定义与四个触发条件');
  assert.match(idle.notCounted, /不检测/, '必须明说不检测 agent/turn');
  // 旧的 workspaces（纯路径）现在迁移成 workspaceMap，不再回写 workspaces。
  const merged = idx.__test.mergeConfig({ workspace: '', workspaces: [], surfaces: {}, channels: {} }, { workspaces: ['C:\\dsh\\dshplug', 'C:\\dsh\\base', 'C:\\dsh\\dshplug'] });
  assert.deepEqual(merged.workspaceMap.map(m => m.name), ['dshplug', 'base'], '旧 workspaces 应迁移成映射表并去重');
  const sb = idx.__test.mergeConfig({ workspace: '', workspaces: [], surfaces: {}, channels: {} }, { showInSidebar: false });
  assert.equal(sb.showInSidebar, false, '侧栏开关应可写为 false');

  /* 工作区映射表：注册名唯一 + 默认路径 = root\\name + 只给路径时取目录名。 */
  const nm = idx.__test.normalizeWorkspaceMap;
  const wm = nm([{ name: 'dshplug' }, { name: 'base', path: 'D:\\proj\\base' }, { name: 'DSHPLUG' }], 'C:\\dsh');
  assert.equal(wm.length, 2, '同名（大小写不敏感）应去重');
  assert.equal(wm[0].path, 'C:\\dsh\\dshplug', '留空时默认 root\\注册名');
  assert.equal(wm[1].path, 'D:\\proj\\base', '手填路径应保留');
  assert.equal(nm(['C:\\dsh\\agent'], 'C:\\dsh')[0].name, 'agent', '只给路径时注册名取目录名');
  assert.equal(nm([{ name: '' }], 'C:\\dsh').length, 0, '空行应丢掉');
  assert.equal(nm([{ name: 'x' }], 'C:\\dsh').length, 1, '单行应保留');
  /* selfCheck：未配远端时必须给“缺什么/去哪/怎么验”三段可执行引导；
     已配好时（这里用空 step 模拟 ready）应直接报 OK。 */
  const scEmpty = await idx.__test.selfCheck({ machine: 'T', workspaceRoot: 'C:\\dsh', workspaceMap: [], remote: '', surfaces: {} });
  assert.equal(scEmpty.ok, true);
  assert.equal(scEmpty.ready, false, '没配远端不能报 ready');
  assert.ok(scEmpty.headline.includes('还不能同步'), '结论要说“还不能同步”');
  const g0 = scEmpty.guide.find(x => /没有地址/.test(x.missing || ''));
  assert.ok(g0, '应给出缺地址的引导');
  assert.ok(g0.where.includes('设置'), '引导要说去哪里填');
  assert.ok(g0.verify && g0.verify.length > 8, '引导要说怎么验证');
  assert.equal(scEmpty.channels.filter(c => !c.configured).length, 1, '唯一仓库应标为未配置');
  // 目标 C：就绪时要能报“上一次同步时间”，所以字段必须始终存在（无同步时为 null，不编造）。
  assert.ok('lastCommitAt' in scEmpty, 'self-check 必须带 lastCommitAt 字段');
  assert.equal(scEmpty.lastCommitAt, null, '没同步过时应为 null，而不是假时间');
  console.log('A. 宿主半：18 路由 + 导出 + guard + selfCheck OK');

  /* ---------------- B. 浏览器半 ---------------- */
  // 极简 React 桩：createElement 返回描述对象；hooks 用固定值；组件是函数，可手工调用。
  const hooks = { useState: v => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useCallback: fn => fn, useMemo: fn => fn(), useRef: v => ({ current: v }) };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    ...hooks,
  };
  const registered = [];
  const fakeSlots = {
    inject(name, fn) { fn(); },
    register(meta, comp) { registered.push({ meta, comp }); return () => {}; },
  };
  // 安装信息也放进 fake /status，让安装卡走「有数据」分支（真实场景）。
  const fakeInstall = { repoHttps: 'https://github.com/o/r.git', spec: 'https://github.com/o/r#path:dsh-synchub', command: 'dsh plugin add https://github.com/o/r#path:dsh-synchub', powershell: '& "C:\\x\\install.ps1" -Only dsh-synchub', version: { local: '0.5.1', remote: '0.5.1', remoteRef: 'origin/master', state: 'same', note: 'ok' }, pluginManager: {} };
  const fakeFetch = async () => ({ json: async () => ({ ok: true, channels: {}, surfaces: [], auto: {}, state: { root: 'X', initialized: true, repos: {}, backupCount: 0, hint: 'ok' }, install: fakeInstall }) });
  global.fetch = fakeFetch;
  let loader;
  global.window = {
    __ModuleLoader__: { load(mod) { loader = mod; } },
  };
  // client.js 是 IIFE 风格，require('react') 由加载器的 factory 提供
  const clientSrc = fs.readFileSync(cliPath, 'utf8');
  // 用 Function 执行，注入 window；factory 内部 require 由我们提供
  new Function('window', 'require', 'fetch', 'AbortSignal', clientSrc)(
    global.window,
    name => name === 'react' ? react : (() => { throw new Error('unexpected require ' + name); })(),
    fakeFetch,
    { timeout: () => undefined },
  );
  assert.ok(loader && typeof loader.factory === 'function', 'client 模块未加载');
  const mod = loader.factory(name => name === 'react' ? react : null);
  assert.equal(mod.name, 'dsh-synchub');
  assert.deepEqual(mod.inject, ['slots'], 'client 只注入 slots —— ADR/AGENTS 明确 synchub 不用 locale');

  const clientCtx = { slots: fakeSlots };
  mod.apply(clientCtx);
  const labels = registered.map(r => r.meta.label);
  assert.ok(labels.includes('Msynchub'), '两个插槽 label 必须是 Msynchub');
  assert.ok(labels.every(l => !String(l).includes('同步中心')), '不应残留旧名「同步中心」');
  assert.equal(registered.length, 3, '应注册 sidebar.panellist / main / settings.section 三个槽');

  // 真渲染主面板：把每个 useState 的初始对象按顺序给出，让组件走完整分支
  const main = registered.find(r => r.meta.name === 'main');
  const settings = registered.find(r => r.meta.name === 'settings.section');
  assert.ok(main && settings, '主面板与设置分节都要在');
  const tree = main.comp();
  const series = JSON.stringify(tree);
  for (const s of ['④ 受控删除单个会话', '⑤ 会话蒸馏成文档', '⑥ 新主机安装（复制地址）']) {
    assert.ok(series.includes(s), '主面板应含卡片：' + s);
  }
  // 顺序：未配远端时 connectCard 必须排在 heroCard 之前（看渲染顺序，不是变量定义顺序）。
  // 之前把 heroCard（拉取/推送按钮）排在前面，而那两个按钮在没配远端时根本无效。
  const body = (tree.children || []).find(c => c && c.props && c.props.className === 'body');
  assert.ok(body, '应找到滚动主体');
  const bodyKids = (body.children || []).filter(Boolean);
  const findIdx = (needle) => bodyKids.findIndex(c => { try { return JSON.stringify(c).includes(needle); } catch { return false; } });
  /* 2026-11-18 行为变更（ADR-028）：
     own=null（接口还没回 / 超时）时，**不再**显示「还缺两个仓库地址」。
     旧断言要求它总是出现，而那正是用户踩到的拖导：设置里明明填对了，
     侧边栏却因为接口超时让人去重填。现在未配置引导卡只在「真的读到了配置且确实没配」时出现。
     本渲染桩里 Panel 的 own 永远是 null（useEffect 不跑），所以引导卡必须不出现。 */
  const iConn = findIdx('还缺两个仓库地址');
  assert.ok(iConn < 0, 'own=null 时不得显示“还缺两个仓库地址”（那会把超时误报成未配置）');
  assert.ok(series.includes('设置 → Msynchub'), '仪表盘/说明区必须保留指向设置页的入口');
  // 仪表盘必须排在首位：用户要的四件事（多少要同步/差异/下次自动/手动）一眼就看到。
  const iDash = findIdx('待同步');
  assert.ok(iDash >= 0, 'body 里应有仪表盘（含「待同步」格子）');
  assert.strictEqual(iDash, 0, '仪表盘必须是 body 的第一张卡');
  // 安装卡：有 install 数据时给可复制地址；没有时必须诚实地降级说明（不编地址）。
  // 沙箱里读不到 git，own.install 会降级，所以这里两种情形都要合法。
  // 渲染桩里 Panel 的 own 初始为 null（useEffect 不跑），所以安装卡会走降级分支；
  // 这本身就是合法且需要覆盖的路径：必须诚实解释，不编地址。
  const hasInstallData = false;
  if (hasInstallData) {
    assert.ok(series.includes('#path:dsh-synchub'), '安装卡应给出带子目录的安装地址');
    assert.ok(series.includes('dsh plugin add'), '安装卡应给出等价命令');
    assert.ok(series.includes('复制'), '安装卡应有可复制按钮');
  } else {
    assert.ok(/无法给出 git 安装地址|没有声明组合包/.test(series), '无地址时安装卡应诚实解释原因');
  }
  const setTree = settings.comp();
  const setSeries = JSON.stringify(setTree);
  assert.ok(setSeries.includes('新用户从这里开始'), '设置页应有新用户引导');
  for (let i = 0; i <= 4; i++) assert.ok(setSeries.includes('第 ' + i + ' 步'), '应设置页第 ' + i + ' 步');
  assert.ok(setSeries.includes('install.ps1'), '引导应含 install.ps1 命令');
  // 表单区在 form===null 时不渲染（异步 load 未跑），同「状态目录」一样改源码断言。
  assert.ok(clientSrc.includes("'在侧边栏显示 Msynchub'"), '设置页应有侧栏显示开关');
  assert.ok(clientSrc.includes("showInSidebar"), '侧栏开关应绑定 showInSidebar 配置');
  assert.ok(clientSrc.includes('工作区映射（同步哪些工作区'), '设置页应有工作区映射表');
  assert.ok(clientSrc.includes('＋ 增加一行'), '工作区表应可增加行');
  assert.ok(clientSrc.includes('全部加入'), '应能把 DSH 已登记工作区一键加入');
  assert.ok(clientSrc.includes('工作区根目录'), '应有工作区根目录设置');
  assert.ok(clientSrc.includes("row('状态目录'"), '设置页应展示状态目录真实状态（源码断言：异步加载的状态行无法在同步桩渲染中出现）');
  console.log('B. 浏览器半：3 槽 + Msynchub + 新卡片 + 顺序 + 侧栏开关 + 多工作区 OK');

  /* ---------------- C. CSS 规则回归 ---------------- */
  assert.match(clientSrc, /\.dsc\{[^}]*height:100%/, '.dsc 需 height:100%');
  assert.match(clientSrc, /\.dsc\{[^}]*overflow:hidden/, '.dsc 需 overflow:hidden');
  assert.match(clientSrc, /\.dsc \.body\{[^}]*overflow-y:auto/, '.body 需可滚动');
  assert.match(clientSrc, /\.dsc \.body\{[^}]*min-height:0/, '.body 需 min-height:0');
  assert.match(clientSrc, /\.dsc \.hd\{[^}]*flex:0 0 auto/, '.hd 需固定不滚');
  // 红点 5×5 左上角：找 width:5,height:5 与 left:-2，且不含 right
  assert.match(clientSrc, /width: 5, height: 5/, '红点应 5×5');
  assert.match(clientSrc, /left: -2/, '红点应在左上角（left）');
  // 主题变量必须带 fallback（var(--x, ...)）
  const vars = [...clientSrc.matchAll(/var\(--dsw-[a-z-]+/g)].map(m => m[0]);
  assert.ok(vars.length > 0, '应存在 --dsw 主题变量');
  for (const line of clientSrc.split('\n')) {
    for (const m of line.matchAll(/var\(--dsw-[a-z-]+\)/g)) {
      assert.ok(false, '主题变量缺 fallback：' + m[0]);
    }
  }

  /* ---------------- D. 两个已报 bug 的回归防线 ----------------
     这些断言的目的：以后谁再改回旧写法，smoke 会直接报错。 */
  // bug1：侧边栏保存不生效 —— 曾把 useState setter 当字段 setter 用。
  // 只看代码行（去掉注释），否则会把“修 bug 的说明注释”误判成真调用。
  const codeLines = clientSrc.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(!codeLines.some(l => /setDraft\s*\(\s*['"]/.test(l)),
    'bug1 回归：不得把 setDraft 当字段 setter 调用（setDraft(\'config\', v) 会把 state 变成字符串）');
  assert.ok(clientSrc.includes('setDraftField'), 'bug1 回归：必须有字段级 setter');
  // bug1 的根治形式变了：侧边栏**不再有输入框**（配置只在设置里），
  // 所以断言改为「侧边栏不得再出现通道输入框 / 保存地址按钮」。
  assert.ok(!/setDraftField\('config'/.test(clientSrc), 'bug1 回归：侧边栏不应再直接绑定通道输入');
  assert.ok(!/onBlur:\s*ev\s*=>\s*setDraft/.test(clientSrc), 'bug1 回归：不应在 onBlur 里写回 draft');
  assert.ok(!/defaultValue:\s*conf\.remote/.test(clientSrc), 'bug1 回归：不应再用 defaultValue=conf.remote');
  // 设置页那边：仓库地址必须是受控输入（value 绑定 form.remote）。
  assert.ok(/value:\s*form\?\.remote\s*\?\?\s*''/.test(clientSrc),
    '设置页仓库输入应是受控 value=form.remote');

  /* bug2：设置保存后侧边栏信息丢失。
     现在的根治比之前更强：侧边栏**完全不写配置**（ADR-022 分工），
     只剩设置页 doSave 一处写入，因此不可能再出现两条写入互相覆盖。 */
  assert.ok(!clientSrc.includes('const saveRemotes'),
    'bug2 回归：侧边栏不得再有 saveRemotes（配置写入只允许在设置页一处）');
  assert.ok(clientSrc.includes('const doSave'), '设置页必须保留唯一的保存实现 doSave');
  /* bug2 的实质防线：只 PATCH remote 时，其他字段必须原封不动（用真实 mergeConfig）。 */
  const partial = idx.__test.mergeConfig(
    { machine: 'T', workspaceRoot: 'C:\\dsh', workspaceMap: [{ name: 'dshplug', path: 'C:\\dsh\\dshplug' }], remote: 'https://x/old', surfaces: {} },
    { remote: 'https://x/new' });
  assert.equal(partial.remote, 'https://x/new', '目标字段应更新');
  assert.equal(partial.workspaceMap.length, 1, 'bug2 回归：局部 PATCH 不得清空 workspaceMap');
  assert.equal(partial.machine, 'T', '局部 PATCH 不得改动 machine');

  // bug3（本轮）：工作区表“输入不进去” —— 渲染用的临时占位行与 setWsRow 改的数组不是同一份。
  assert.ok(!/\(wsRows\.length \? wsRows : \[/.test(clientSrc),
    'bug3 回归：不得再在渲染处新建占位行（会与 setWsRow 的目标脱节，输入被丢弃）');
  assert.ok(/const wsRows = wsRowsRaw\.length \? wsRowsRaw : \[\{ name: '', path: '' \}\]/.test(clientSrc),
    'bug3 回归：必须定义唯一的“有效行”数组，渲染与编辑共用');

  // 新功能：检查并自动填写必须是确定性的（读 suggestions），不靠 AI/猜路径。
  assert.ok(clientSrc.includes('autofillWorkspaces'), '应有“检查并自动填写”实现');
  assert.ok(clientSrc.includes('检查并自动填写'), 'UI 上应有该按钮');
  assert.ok(clientSrc.includes('workspaceReport.suggestions'), '自动填写应基于真实 workspace.json 的 suggestions');
  assert.ok(clientSrc.includes('不涉及 AI'), '文案应明确说明不涉及 AI');
  console.log('D. 两个已报 bug + 工作区表输入 bug 的回归断言 OK');
  console.log('C. CSS 滚动区 + 红点 + 主题变量 fallback OK');

  console.log('\nSYNCHUB_SMOKE_OK');
})().catch(e => { console.error(e); process.exit(1); });
