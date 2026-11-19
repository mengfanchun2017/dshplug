/* 代码仓库同步 smoke —— 用真 git 仓库验证，不 mock。
 *
 * 为什么必须真跑：syncCodeRepo 的正确性全在 git 的实际行为里
 * （pull --rebase --autostash 会不会失败、冲突时 rebase --abort 留不留现场）。
 * 打桩只能验证「我写了这行代码」，验证不了「git 真的这么做」。
 *
 * 覆盖：
 *   1. 非 git 目录 / 不存在的目录 → 明确报错，不崩
 *   2. 有改动 → add/commit 真的产生提交，提交信息带文件摘要
 *   3. 无改动 → 不产生空提交
 *   4. 无 remote → 只本地提交，不报错
 *   5. 有 remote → 首次推送（远端还没有该分支）不被当成失败
 *   6. 双端分叉 → pull --rebase 整合，不产生 merge 提交
 *   7. .gitignore 生效 → 被忽略的文件不入库
 *
 * 用法：node test\repo-sync-smoke.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

/* git 在测试里必须带身份，否则 commit 直接失败（CI 环境没有全局配置）。 */
const GENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@test',
  GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@test',
  GIT_TERMINAL_PROMPT: '0',
};

function g(cwd, args, allowFail) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', cwd, ...args], { env: GENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    if (allowFail) return { ok: false, out: String(e.stdout || '').trim(), err: String(e.stderr || e.message || '').trim() };
    throw e;
  }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-repo-'));
const created = [];

function mkRepo(name) {
  const d = path.join(ROOT, name);
  fs.mkdirSync(d, { recursive: true });
  g(d, ['init', '-b', 'main']);
  return d;
}
function write(d, rel, content) {
  const p = path.join(d, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

(async () => {
  const idx = path.join(__dirname, '..', 'lib', 'index.js');

  /* ── A. 源码级护栏 ─────────────────────────────────────────────── */
  console.log('\nA. 源码级护栏');
  const src = fs.readFileSync(idx, 'utf8');
  ok('注册了 /repos 只读路由', src.includes("path: '/api/dsh-synchub/repos'"));
  ok('注册了 /repos/sync 动作路由', src.includes("path: '/api/dsh-synchub/repos/sync'"));
  ok('push 前必先 pull --rebase --autostash',
    /pull',\s*'--rebase',\s*'--autostash'/.test(src));
  ok('冲突时执行 rebase --abort（不静默覆盖）', src.includes("['rebase', '--abort']"));
  ok('代码仓库同步与 idle 自动推送是两套独立闸门', src.includes('codeRepoAutoEnabled') && src.includes('autoPush'));
  ok('默认不开启自动提交（不默默改别人仓库）', /codeRepoAutoEnabled:\s*false/.test(src));

  /* ── B. 边界与错误态 ───────────────────────────────────────────── */
  console.log('\nB. 边界与错误态（先测失败态，避免只测成功态）');
  const mod = await import('file://' + idx.replace(/\\/g, '/'));
  const T = mod.__test || {};

  ok('导出了 codeRepoState', typeof T.codeRepoState === 'function');
  ok('导出了 syncCodeRepo', typeof T.syncCodeRepo === 'function');

  const missing = await T.codeRepoState({ id: 'x', path: path.join(ROOT, 'nope') });
  ok('不存在的目录 → exists=false 且给出原因', missing.exists === false && Boolean(missing.error));

  const notGit = path.join(ROOT, 'notgit');
  fs.mkdirSync(notGit, { recursive: true });
  const ng = await T.codeRepoState({ id: 'n', path: notGit });
  ok('不是 git 目录 → initialized=false 且给出原因', ng.initialized === false && Boolean(ng.error));

  const badSync = await T.syncCodeRepo({}, { id: 'n', path: notGit });
  ok('对非 git 目录执行同步 → ok=false，不抛异常', badSync.ok === false && badSync.steps.length > 0);

  /* ── C. 本地仓库：提交与空提交 ─────────────────────────────────── */
  console.log('\nC. 本地仓库（无远端）');
  const r1 = mkRepo('local-only');
  created.push(r1);
  write(r1, 'a.txt', 'hello\n');
  write(r1, 'docs/b.md', '# b\n');

  const st1 = await T.codeRepoState({ id: 'local', path: r1 });
  ok('有未提交文件时 unsynced > 0', st1.unsynced >= 2, 'unsynced=' + st1.unsynced);
  ok('读到分支名 main', st1.branch === 'main', 'branch=' + st1.branch);

  const s1 = await T.syncCodeRepo({}, { id: 'local', path: r1 });
  ok('无远端时同步成功（只本地提交）', s1.ok === true, JSON.stringify(s1.steps));
  ok('确实产生了提交', Boolean(s1.committed), 'committed=' + s1.committed);

  const msg = g(r1, ['log', '-1', '--format=%B'], true);
  ok('提交信息带文件摘要（不是只有时间戳）',
    /a\.txt|docs\/b\.md/.test(msg.out), msg.out.slice(0, 120));
  ok('提交信息用 synchub 前缀', /synchub:/.test(msg.out));

  const cnt1 = Number(g(r1, ['rev-list', '--count', 'HEAD'], true).out || 0);
  const s2 = await T.syncCodeRepo({}, { id: 'local', path: r1 });
  const cnt2 = Number(g(r1, ['rev-list', '--count', 'HEAD'], true).out || 0);
  ok('无改动时再同步 → 不产生空提交', cnt1 === cnt2, `${cnt1} -> ${cnt2}`);
  ok('无改动时也报 ok（不是错误）', s2.ok === true);

  /* ── D. .gitignore 生效 ───────────────────────────────────────── */
  console.log('\nD. .gitignore');
  const r2 = mkRepo('ign');
  created.push(r2);
  write(r2, '.gitignore', 'secret.env\n*.log\nbig/\n');
  write(r2, 'keep.txt', 'keep\n');
  write(r2, 'secret.env', 'TOKEN=abc\n');
  write(r2, 'debug.log', 'log\n');
  write(r2, 'big/blob.bin', 'x\n');
  const s3 = await T.syncCodeRepo({}, { id: 'ign', path: r2 });
  ok('.gitignore 生效：同步成功', s3.ok === true, JSON.stringify(s3.steps));
  const tracked = g(r2, ['ls-files']);
  ok('被忽略的文件未入库', !/secret\.env|debug\.log|big\/blob/.test(tracked.out), tracked.out);
  ok('未被忽略的文件已入库', /keep\.txt/.test(tracked.out));

  /* ── E. 有远端：首次推送 + 双端分叉 rebase ─────────────────────── */
  console.log('\nE. 有远端（本地 bare 仓库模拟 GitHub）');
  const bare = path.join(ROOT, 'origin.git');
  g(ROOT, ['init', '--bare', '-b', 'main', bare]);
  created.push(bare);

  const r3 = mkRepo('with-remote');
  created.push(r3);
  g(r3, ['remote', 'add', 'origin', bare]);
  write(r3, 'one.txt', '1\n');
  const s4 = await T.syncCodeRepo({}, { id: 'wr', path: r3 });
  ok('远端还没有该分支时，首次推送不算失败', s4.ok === true, JSON.stringify(s4.steps));
  ok('首次推送后远端有 main 分支',
    g(bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], true).ok === true);

  /* 模拟另一台机器：clone → 提交 → 推回，制造「远端领先」。 */
  const other = path.join(ROOT, 'other-machine');
  g(ROOT, ['clone', bare, other]);
  created.push(other);
  write(other, 'two.txt', '2\n');
  g(other, ['add', '-A']);
  g(other, ['commit', '-m', 'other: add two']);

  /* 本机也提交一笔，此时两端各有独立提交 → 必须 rebase 而非 merge。 */
  write(r3, 'three.txt', '3\n');
  g(r3, ['add', '-A']);
  g(r3, ['commit', '-m', 'mine: add three']);
  g(other, ['push', 'origin', 'main']);

  const beforeCount = Number(g(r3, ['rev-list', '--count', 'HEAD'], true).out || 0);
  const s5 = await T.syncCodeRepo({}, { id: 'wr', path: r3 });
  ok('分叉后同步成功（pull --rebase 整合）', s5.ok === true, JSON.stringify(s5.steps));
  const afterLog = g(r3, ['log', '--format=%s', '-n', '6']);
  ok('未产生 Merge 提交（用的是 rebase 不是 merge）',
    !/^Merge /m.test(afterLog.out), afterLog.out);
  ok('两端提交都在历史里', /other: add two/.test(afterLog.out) && /mine: add three/.test(afterLog.out));
  const afterCount = Number(g(r3, ['rev-list', '--count', 'HEAD'], true).out || 0);
  ok('rebase 后提交数增加（两个变三个，不是四个）', afterCount === beforeCount + 1,
    `${beforeCount} -> ${afterCount}`);
  ok('推送后与远端一致', g(r3, ['rev-parse', 'HEAD']).out === g(bare, ['rev-parse', 'refs/heads/main']).out);

  /* ── F. 汇总接口 ───────────────────────────────────────────────── */
  console.log('\nF. 汇总接口');
  const payload = await T.codeReposPayload({
    codeRepos: [
      { id: 'local', path: r1, enabled: true },
      { id: 'ign', path: r2, enabled: true },
      { id: 'gone', path: path.join(ROOT, 'gone'), enabled: true },
    ],
  });
  ok('返回 3 个仓库状态', payload.repos.length === 3);
  ok('统计只算启用中的', payload.total === 3, 'total=' + payload.total);
  ok('bad 仓库带上错误原因而非静默', payload.repos.find(r => r.id === 'gone').error !== null);

  const none = await T.codeReposPayload({});
  ok('未配置时安全返回空集（不崩）', none.ok === true && none.repos.length === 0);

  /* ── 清理 ─────────────────────────────────────────────────────── */
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 尽力 */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n失败项：');
    fails.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('REPO_SYNC_SMOKE_OK');
})().catch(e => {
  console.error('smoke 崩溃:', e && e.stack || e);
  process.exit(1);
});
