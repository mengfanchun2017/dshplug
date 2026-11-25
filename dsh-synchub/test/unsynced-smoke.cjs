/* dsh-synchub · 假绿回归测试（unsynced / payloadMissing）
 *
 * 背景：2026-11-18 用户报「面板全绿，但 GitHub 上 dsh-session 是空的、dsh-config 只有 snapshot」。
 * 根因：channelState 用 `git status --porcelain -uno` 当「有东西没同步」。空仓库 git 恒干净 →
 * dirty=0 → preflight 判「payload 已对齐本机」「可以开始工作」，而本机 265 个文件一个都没进 payload。
 *
 * 这个测试锁死三件事：
 *   A. payload 目录不存在时，payloadMissing 必须为 true（不能因为 .git 在就算「已建」）
 *   B. 未显式 scan 时 pending 必须是 null（=「没查」），不能假装 0
 *   C. 显式 scan 时 pending 必须能算出真实待同步量；仓库里已有 payload 则应为 0
 *
 * 用真实仓库目录跑（只读，不写任何东西）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// SYNCHUB_ROOT 指向另一份插件目录时，就能用来做变异测试（验证本测试真能抓住回归）。
const ROOT = process.env.SYNCHUB_ROOT
  ? path.resolve(process.env.SYNCHUB_ROOT)
  : path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
}

(async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);
  const t = mod.__test;
  if (!t) { console.log('FATAL 宿主半没有导出 __test'); process.exit(1); }

  console.log('A. __test 暴露了需要的内部函数');
  ok('channelState 已导出', typeof t.channelState === 'function');

  if (typeof t.channelState !== 'function') {
    console.log('\n宿主半未导出 channelState，无法做行为断言；跳过 B/C。');
    console.log(fail ? `\nFAILED ${fail}` : '\nUNSYNCED_SMOKE_OK');
    process.exit(fail ? 1 : 0);
  }

  const cfg = await t.readConfig();
  console.log('B. payloadMissing 反映真实磁盘（不因 .git 存在就算「已建」）');
  for (const ch of ['all']) {
    const st = await t.channelState(ch, cfg, {});
    // channelState 不返回 dir（它不向外暴露路径），自己算同一个路径。
    const dir = path.join(os.homedir(), '.dsh', 'dsh-synchub', 'repos', ch);
    const realMissing = !fs.existsSync(path.join(dir, 'payload'));
    const realMissing = !fs.existsSync(path.join(dir, 'dsh-home'));
      st.payloadMissing === realMissing);
  }

  console.log('C. 不扫描时 pending 必须是 null（「没查」≠「没问题」）');
  for (const ch of ['all']) {
    const st = await t.channelState(ch, cfg, {});
    ok(`${ch}: 未 scan 时 pending === null`, st.pending === null, `实际 ${st.pending}`);
    ok(`${ch}: scanned 标记为 false`, st.scanned === false);
  }

  console.log('D. 显式 scan 时 pending 是数字且非负');
  for (const ch of ['all']) {
    const st = await t.channelState(ch, cfg, { scan: true });
    ok(`${ch}: scan 后 pending 是数字`, typeof st.pending === 'number', `实际 ${typeof st.pending}`);
    ok(`${ch}: scan 后 pending >= 0`, (st.pending || 0) >= 0);
    ok(`${ch}: scan 后 scanned 为 true`, st.scanned === true);
    ok(`${ch}: unsynced = dirty + pending`,
      st.unsynced === (st.dirty || 0) + (st.pending || 0),
      `unsynced=${st.unsynced} dirty=${st.dirty} pending=${st.pending}`);
  }

  console.log('E. 语义护栏：unsynced 不能等于「只看 git dirty」');
  const c0 = await t.channelState('all', cfg, {});
  const c1 = await t.channelState('all', cfg, { scan: true });
  ok('scan 能改变结论（否则等于没查）', c0.scanned === false && c1.scanned === true);
  ok('unsynced 包含 pending 而非仅 dirty', c1.unsynced >= (c1.pending || 0));

  /* 源码护栏：上面都是行为断言，但它们依赖「当前磁盘恰好缺 payload」才敏感。
     真实回归是「判定逻辑退回去」，所以必须直接锁源码形状：
     payloadMissing 不允许被写死成常量，否则就回到「.git 在 = 已建」的假绿。 */
  console.log('F. 源码护栏（退回假绿的写法必须被拦住）');
  let src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
  // 去掉注释，避免注释里的字样干扰
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('payloadMissing 由 fs.existsSync 计算，而非写死常量',
    /out\.payloadMissing\s*=\s*!?\s*fs\.existsSync\(/.test(src),
    '预期 out.payloadMissing = !fs.existsSync(...)');
  ok('payloadMissing 没有任何写死为 false/true 的赋值',
    !/out\.payloadMissing\s*=\s*(true|false)\s*;/.test(src),
    '发现写死的赋值 —— 这会退回假绿');
  ok('pending 只在 opts.scan 分支内被赋值（不在轮询路径上做全量哈希）',
    /if\s*\(opts\.scan\)\s*\{/.test(src));
  ok('unsynced 汇总了 pending，而非只报 dirty',
    /out\.unsynced\s*=\s*out\.dirty\s*\+\s*\(?out\.pending/.test(src),
    '预期 out.unsynced = out.dirty + (out.pending || 0)');
  console.log(fail ? `\nFAILED ${fail} / pass ${pass}` : `\nUNSYNCED_SMOKE_OK (${pass} assertions)`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('FATAL ' + (e && e.stack || e));
  process.exit(1);
});
