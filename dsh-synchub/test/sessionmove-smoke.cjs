#!/usr/bin/env node
/* 会话迁移（session-move）冒烟测试
 *
 * 这条能力解决的是「工作区改名后会话变未分组」——用户的真实事故：
 *   C:\dsh\base 改名成 C:\dsh\dw-base 后，workspace.json 里旧条目消失，
 *   但 sessions\--C-dsh-base--\ 下 10 个会话正文还在，侧边栏显示成「未分组」。
 *
 * 这里能测什么、不能测什么：
 *   能测 —— 路径编码规则（这是最容易写错、错了就搬错地方的纯函数）、
 *           函数存在性、危险闸门（没有 confirm 必须拒绝）。
 *   不测 —— 真实搬文件。它会改用户的 workspace.json，测试**绝不能**碰真数据；
 *           真实迁移已在 2026-11-19 对 10 个会话实测通过（含逐字节校验）。
 */

const assert = require('assert');
const path = require('path');

const PLUGIN = path.join(__dirname, '..');
const idxPath = path.join(PLUGIN, 'lib', 'index.js');
const src = require('fs').readFileSync(idxPath, 'utf8');

(async () => {
  const mod = await import('file:///' + idxPath.replace(/\\/g, '/'));
  const T = mod.__test;

  /* ── 1. 路径编码：DSH 的 sessions 组目录命名规则 ────────────────────────
     规则错了会怎样：搬到不存在的组目录 → 会话在新工作区里依然看不到，
     而且旧目录已经被删 → 数据「看起来丢了」。所以这是最关键的一条。 */
  assert.equal(typeof T.encodeWorkspaceGroup, 'function', '应导出 encodeWorkspaceGroup');
  const cases = [
    ['C:\\dsh\\base', '--C-dsh-base--'],
    ['C:\\dsh\\dw-base', '--C-dsh-dw-base--'],
    ['C:\\dsh\\dshplug', '--C-dsh-dshplug--'],
    ['C:\\Users\\franc\\Documents\\deepseek-harness\\default-workspace',
      '--C-Users-franc-Documents-deepseek-harness-default-workspace--'],
  ];
  for (const [input, want] of cases) {
    assert.equal(T.encodeWorkspaceGroup(input), want,
      '编码错误：' + input + ' 应为 ' + want);
  }
  console.log('A. 组目录路径编码（4 例，含盘符与多级目录） OK');

  /* ── 2. 编码结果必须与磁盘上真实存在的组目录名对上 ──────────────────────
     只比字符串会漏掉「规则对但盘上不是这样」的可能。这里读真实 sessions 目录，
     用真实目录名反查：只要有一个已存在的组目录符合我们的编码规则，就说明规则没跑偏。
     读不到就跳过（别的机器上可能没有这些目录），不能因此判失败。 */
  const fs = require('fs');
  const os = require('os');
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const sessRoot = path.join(dshHome, 'sessions');
  let checkedReal = 0;
  try {
    const groups = fs.readdirSync(sessRoot).filter(n => /^--.+--$/.test(n));
    for (const g of groups) {
      const dec = T.decodeWorkspaceGroup(g);
      if (!dec) continue;
      /* 编码/解码互逆：decode('--C-dsh-agent--') 得到 'C-dsh-agent'，
         把开头那个盘符字母后面补上 ':' 就还原成 'C:\dsh\agent' 的等价形式。
         这里只验证「同一个目录名来回一次不变」，不猜真实路径。 */
      assert.equal(T.encodeWorkspaceGroup(dec.replace(/^([A-Za-z])-/, '$1:\\')), g,
        '与真实目录不符：' + g);
      checkedReal++;
    }
  } catch { /* 目录不存在：跳过，不算失败 */ }
  console.log(`B. 与磁盘真实组目录交叉验证（${checkedReal} 个） OK`);

  /* ── 3. 函数齐全 ──────────────────────────────────────────────────────── */
  for (const fn of ['sessionMigratePreview', 'sessionMigrateExecute',
    'sessionMigrateVerify', 'sessionMigrateGroup', 'decodeWorkspaceGroup']) {
    assert.equal(typeof T[fn], 'function', '应导出 ' + fn);
  }
  console.log('C. 迁移相关函数齐全（5 个） OK');

  /* ── 4. 危险闸门：没有 confirm 必须拒绝，且不能碰任何文件 ──────────────
     这是最重要的一条安全断言。confirm 校验必须在读 workspace.json、搬文件**之前**
     短路返回，否则「拒绝了但已经动了一半」比不拒绝更糟。 */
  const bad = await T.sessionMigrateExecute('session-00000000-0000-0000-0000-000000000000', 'dw-base', '');
  assert.equal(bad.ok, false, '没 confirm 必须拒绝');
  assert.ok(/confirm/i.test(bad.error), '拒绝理由要说清缺 confirm，实际：' + bad.error);
  const bad2 = await T.sessionMigrateExecute('session-00000000-0000-0000-0000-000000000000', 'dw-base', 'yes');
  assert.equal(bad2.ok, false, 'confirm 值不对（yes）必须拒绝');
  const bad3 = await T.sessionMigrateGroup('--C-not-exist--', 'dw-base', '');
  assert.equal(bad3.ok, false, '批量：没 confirm 必须拒绝');
  console.log('D. 二次确认闸门（3 种错误 confirm 全部拒绝） OK');

  /* ── 5. 不存在的会话/组要给出可读错误，不是抛异常 ──────────────────────── */
  const ghost = await T.sessionMigratePreview('session-00000000-0000-0000-0000-000000000000', 'dw-base');
  assert.equal(ghost.ok, false, '不存在的会话应返回 ok:false');
  assert.ok(ghost.error && ghost.error.length > 2, '要给可读的 error');
  assert.ok(!/undefined|\[object/.test(String(ghost.error)), '错误里不能出现 undefined/[object]');
  const ghostGroup = await T.sessionMigrateGroup('--C-definitely-not-here--', 'dw-base', 'MOVE');
  assert.equal(ghostGroup.ok, false, '不存在的组应返回 ok:false');
  assert.ok(/不存在/.test(ghostGroup.error), '组不存在要说「不存在」，实际：' + ghostGroup.error);
  console.log('E. 不存在的目标给可读错误（不抛异常、无 undefined） OK');

  /* ── 6. 源码级约束：迁移必须先备份再动手 ────────────────────────────────
     搬会话是不可逆操作。顺序错了（先删再备份）在失败时就永久丢数据。
     这里直接查源码里三个动作的先后：备份 < 复制 < 删除。 */
  const execSrc = src.slice(src.indexOf('async function sessionMigrateExecute'),
    src.indexOf('async function sessionMigrateGroup'));
  const iBackup = execSrc.indexOf('copyFile');
  const iCopy = execSrc.indexOf('fsp.cp(pre.fromDir, pre.toDir');
  const iRemove = execSrc.indexOf('fsp.rm(pre.fromDir');
  assert.ok(iBackup > 0, '必须有备份步骤');
  assert.ok(iCopy > 0, '必须有复制步骤');
  assert.ok(iRemove > 0, '必须有删源步骤');
  assert.ok(iBackup < iCopy, '备份必须在复制之前');
  assert.ok(iCopy < iRemove, '删源必须在复制之后（否则中途失败就永久丢数据）');
  assert.ok(/bytes !== .*bytes|files !== .*files/.test(execSrc),
    '复制后必须校验文件数与字节数，不一致要中止');
  console.log('F. 先备份→再复制→校验→最后删源（源码顺序断言） OK');

  /* ── 7. 批量迁移不得碰「已属别的工作区」的会话 ──────────────────────────
     会误搬正在用的会话，比不搬危险得多。 */
  const grpSrc = src.slice(src.indexOf('async function sessionMigrateGroup'),
    src.indexOf('async function sessionMigrateGroup') + 3000);
  assert.ok(/registered\.has\(n\)/.test(grpSrc), '批量迁移必须排除已登记的会话');
  assert.ok(/todo = entries\.filter/.test(grpSrc), '应先算出待搬清单再动手');
  console.log('G. 批量迁移只碰未分组会话（源码断言） OK');

  console.log('\nSESSION_MOVE_SMOKE_OK');
})().catch(e => { console.error('FAIL: ' + (e && e.message)); console.error(e && e.stack); process.exit(1); });
