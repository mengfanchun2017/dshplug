/**
 * diverge（分叉）能力 smoke —— ADR-028/029 的回归护栏。
 *
 * 覆盖三块（必须含初始态与失败态，AGENTS 规则）：
 *  A. 路由层：/diverge、/diverge/resolve 都已注册；resolve 拒绝非法 mode（400）。
 *  B. 数据层：channelState 在 ahead>0 && behind>0 时 diverged=true（分叉判定核心）；
 *     summary.diverged 是两通道的或运算；旧宿主半字段缺失时安全降级为 false。
 *  C. 状态机：resolveKeepLocal / resolveKeepRemote 在「没有仓库」的初始态必须
 *     安全跳过（ok:true, skipped）而不是抛错 —— 新机器首装就会走到这里。
 *
 * 全程不碰真实 DSH_HOME（用 mkdtemp），不发网络请求。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

(async () => {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'synchub-diverge-'));
  const idx = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href + '?a=' + Date.now());

  /* ---------------- A. 路由层 ---------------- */
  const routes = [];
  idx.apply({ logger: () => {}, effect() { return () => {}; }, webServer: { register(d) { routes.push(d); return () => {}; } } }, {});
  const byPath = Object.fromEntries(routes.map(r => [r.path, r]));
  assert.ok(byPath['/api/dsh-synchub/diverge'], '缺 /diverge 路由');
  assert.ok(byPath['/api/dsh-synchub/diverge/resolve'], '缺 /diverge/resolve 路由');

  // 非法 mode 必须被拒（手滑不能默默选边）
  {
    const res = {};
    const fake = { writeHead(c) { res.code = c; }, end(b) { res.body = JSON.parse(b); } };
    // 桩掉 readConfig 依赖不可行（闭包内），直接用 POST 空体触发 400 分支
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      on(ev, fn) { if (ev === 'data') fn(Buffer.from('{}')); if (ev === 'end') fn(); },
    };
    await byPath['/api/dsh-synchub/diverge/resolve'].handler(req, fake);
    assert.equal(res.code, 400, '非法 mode 应返回 400');
    assert.equal(res.body.ok, false);
    assert.match(String(res.body.error), /keep-local|keep-remote/);
  }

  /* ---------------- B. 数据层：diverged 判定 ---------------- */
  // 直接构造 channelState 的产物验证消费端逻辑（不真跑 git）：
  // client 侧 summary.diverged = config.diverged || sessions.diverged，
  // 源码级断言保证两处都有这个字段且是或运算 —— 撤掉字段必须被拦。
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
  assert.ok(/out\.diverged = out\.ahead > 0 && out\.behind > 0/.test(src),
    'channelState 必须计算 diverged（既领先又落后）');
  assert.ok(/diverged: chList\.some\(s => s\.diverged\)/.test(src),
    'summary.diverged 必须是所有仓库的或运算');

  const cli = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.ok(/summary\.diverged/.test(cli), 'client 必须消费 summary.diverged');
  assert.ok(/divergedNow/.test(cli), 'client 必须派生 divergedNow');

  /* ---------------- C. 初始态安全：无仓库时 resolve 不炸 ---------------- */
  const cfg = await idx.__test.readConfig();
  // 全新环境：两个通道都没仓库。两个方向的 resolve 都必须整体 ok 且逐通道 skipped。
  const kl = await idx.__test.resolveKeepLocal(cfg);
  assert.equal(kl.ok, true, '无仓库时 keep-local 必须安全跳过，实际：' + JSON.stringify(kl.channels));
  assert.ok(kl.channels.config.skipped && kl.channels.sessions.skipped, '两通道都应 skipped');

  const kr = await idx.__test.resolveKeepRemote(cfg);
  assert.equal(kr.ok, true, '无仓库时 keep-remote 必须安全跳过');
  assert.ok(kr.channels.config.skipped && kr.channels.sessions.skipped);

  // divergeInfo 在无仓库初始态：diverged=false，且不抛
  const dv = await idx.__test.divergeInfo(cfg);
  assert.equal(dv.ok, true);
  assert.equal(dv.diverged, false, '无仓库初始态不应报分叉');
  assert.ok(!dv.channels.config.diverged && !dv.channels.sessions.diverged);

  /* ---------------- D. 空配置缺 remote：不算分叉也不算错 ---------------- */
  const cfg2 = JSON.parse(JSON.stringify(cfg));
  cfg2.channels = { config: { remote: '' }, sessions: { remote: '' } };
  const dv2 = await idx.__test.divergeInfo(cfg2);
  assert.equal(dv2.ok, true);
  assert.equal(dv2.diverged, false, '无 remote 时 diverged 必须为 false');

  console.log('A. 路由注册 + 非法 mode 400 OK');
  console.log('B. diverged 判定源码护栏 OK');
  console.log('C. 初始态（无仓库）resolve 安全跳过 OK');
  console.log('D. 无 remote 安全降级 OK');
  console.log('DIVERGE_SMOKE_OK');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
