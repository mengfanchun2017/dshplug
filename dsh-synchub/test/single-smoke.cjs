/* dsh-synchub · 单仓库模式回归测试（ADR-036）
 *
 * 背景：用户提出「配置两个仓库太麻烦，量也不大」，要求一个仓库 + 两个分组开关。
 * 单仓库模式（cfg.mode==='single'）：
 *   - 一个物理仓库 repos/all，一个 remote；
 *   - config / sessions 退化为「逻辑分组」，channels.<group>.enabled 决定哪些面参与同步；
 *   - 逻辑通道只剩 'all' 一个。
 *
 * ⚠ 本测试**不依赖 git 子进程**：DSH 的沙箱会拦掉 node 起的 git（spawn EPERM），
 * 而插件的 git() 会把失败吞成 {ok:false}。所以这里直接手工搭出 repos/all/.git/HEAD，
 * 只验证「文件往哪落、开关怎么过滤、状态怎么报」，把真实推送留给真机重启验收。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-single-'));
  const dsh = path.join(root, 'dsh');
  const state = path.join(dsh, 'dsh-synchub');
  fs.mkdirSync(path.join(dsh, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'sessions', '--C-dsh-x--', 's1'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'storages'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'profiles', 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(state, 'repos', 'all', '.git'), { recursive: true });
  fs.writeFileSync(path.join(state, 'repos', 'all', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dsh, 'skills', 'a.md'), '# skill A\n');
  fs.writeFileSync(path.join(dsh, 'sessions', '--C-dsh-x--', 's1', 'session.v4.jsonl.zstd'), 'BINARY');
  fs.writeFileSync(path.join(dsh, 'storages', 'workspace.json'), '{"tables":{"workspaces":{}}}');
  fs.writeFileSync(path.join(dsh, 'AGENTS.md'), '# 全局规则\n');
  fs.writeFileSync(path.join(dsh, 'profiles', 'desktop', 'cordis.patch.yml'), 'model: x\n');

  process.env.DSH_HOME = dsh;
  process.env.DSH_PROFILE_DIR = path.join(dsh, 'profiles', 'desktop');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href);
  const t = mod.__test;

  console.log('A. 纯函数：模式抽象');
  ok('split 模式有两个逻辑通道', JSON.stringify(t.channelsOf({ mode: 'split' })) === JSON.stringify(['config', 'sessions']));
  ok('single 模式只有一个逻辑通道 all', JSON.stringify(t.channelsOf({ mode: 'single' })) === JSON.stringify(['all']));
  ok('single 模式下 repoKey 都落到 all', t.repoKeyOf('config', { mode: 'single' }) === 'all' && t.repoKeyOf('sessions', { mode: 'single' }) === 'all');
  ok('split 模式下 repoKey 各自独立', t.repoKeyOf('config', { mode: 'split' }) === 'config' && t.repoKeyOf('sessions', { mode: 'split' }) === 'sessions');
  ok('single 模式 remote 取 cfg.remote', t.remoteOf('all', { mode: 'single', remote: 'https://x/y.git' }) === 'https://x/y.git');
  ok('split 模式 remote 取 channels[ch].remote', t.remoteOf('config', { mode: 'split', channels: { config: { remote: 'https://x/c.git' } } }) === 'https://x/c.git');
  ok('single 模式 label', t.channelLabel('all') === '同步仓库');

  console.log('B. mergeConfig：mode / remote 落盘');
  const base = { mode: 'split', remote: '', channels: { config: { remote: '', enabled: true }, sessions: { remote: '', enabled: true } }, surfaces: {} };
  const merged = t.mergeConfig(base, { mode: 'single', remote: 'https://x/y.git' });
  ok('mode=single 被接受', merged.mode === 'single');
  ok('remote 被接受', merged.remote === 'https://x/y.git');
  ok('非法 mode 被忽略', t.mergeConfig(base, { mode: 'weird' }).mode === 'split');

  console.log('C. 分组开关决定同步哪些面');
  const cfgSingle = {
    machine: 'T', mode: 'single', remote: '',
    channels: { config: { remote: '', enabled: true }, sessions: { remote: '', enabled: true } },
    surfaces: { sessions: true, storages: true, attachments: true, skills: true, profileConfig: true, agentInstructions: true, profileManifest: false },
  };
  ok('配置组面默认可用', t.surfaceEnabled({ id: 'skills', channel: 'config', tier: 'safe' }, cfgSingle));
  const cfgNoConfig = { ...cfgSingle, channels: { config: { enabled: false }, sessions: { enabled: true } } };
  ok('关掉配置组后配置面不可用', !t.surfaceEnabled({ id: 'skills', channel: 'config', tier: 'safe' }, cfgNoConfig));
  ok('关掉配置组后会话面仍可用', t.surfaceEnabled({ id: 'sessions', channel: 'sessions', tier: 'safe' }, cfgNoConfig));
  ok('danger 面永远不可用', !t.surfaceEnabled({ id: 'profileManifest', channel: 'config', tier: 'danger' }, cfgSingle));

  console.log('D. 端到端（文件层）：stage 把内容写进 repos/all/payload');
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(cfgSingle));
  const cfg = await t.readConfig();
  ok('readConfig 读回 single 模式', cfg.mode === 'single');

  const diff0 = await t.diffLocalToPayload(cfg);
  ok('diff 认得全局 AGENTS.md', diff0.added.some(a => a.rel === 'AGENTS.md'), JSON.stringify(diff0.added.map(a => a.rel)));
  ok('diff 认得技能文件', diff0.added.some(a => a.rel === 'skills/a.md'));

  const staged = await t.stageChanges(cfg);
  ok('stage 写入了文件', staged.written >= 5, `written=${staged.written}`);
  const payload = path.join(state, 'repos', 'all', 'payload');
  ok('payload 落在 repos/all/payload', fs.existsSync(path.join(payload, 'AGENTS.md')));
  ok('repos/config 不该被创建', !fs.existsSync(path.join(state, 'repos', 'config')));
  ok('repos/sessions 不该被创建', !fs.existsSync(path.join(state, 'repos', 'sessions')));
  ok('会话正文也进了同一个 payload', fs.existsSync(path.join(payload, 'sessions', '--C-dsh-x--', 's1', 'session.v4.jsonl.zstd')));

  const diff1 = await t.diffLocalToPayload(cfg);
  ok('stage 后 diff 归零', diff1.added.length === 0 && diff1.removed.length === 0, JSON.stringify(diff1));

  console.log('E. channelState / status 在单仓库下只报一个通道');
  const st = await t.channelState('all', cfg, {});
  ok('channelState 标 label=同步仓库', st.label === '同步仓库');
  ok('channel 是 all', st.channel === 'all');
  ok('仓库已初始化', st.initialized === true);
  ok('分支读自 .git/HEAD', st.branch === 'main', `branch=${st.branch}`);
  ok('payloadMissing=false', st.payloadMissing === false);
  const sp = await t.statusPayload(cfg, { fast: true });
  ok('status.channels 只有 all', Object.keys(sp.channels).join(',') === 'all');
  ok('summary 不重复计数', sp.summary.unsynced === (st.unsynced || 0), JSON.stringify(sp.summary));
  ok('summary.payloadMissing 不含 all', !(sp.summary.payloadMissing || []).includes('all') || st.payloadMissing === true);

  console.log('F. 关掉配置组后，AGENTS.md 不再进 payload');
  const cfg2 = { ...cfg, channels: { config: { enabled: false }, sessions: { enabled: true } } };
  fs.writeFileSync(path.join(dsh, 'AGENTS.md'), '# 全局规则 v2\n');
  const diff2 = await t.diffLocalToPayload(cfg2);
  ok('配置组关掉后 diff 不含 AGENTS.md', !diff2.added.some(a => a.rel === 'AGENTS.md'), JSON.stringify(diff2.added.map(a => a.rel)));
  await t.stageChanges(cfg2);
  ok('payload 里 AGENTS.md 仍是旧内容', fs.readFileSync(path.join(payload, 'AGENTS.md'), 'utf8') === '# 全局规则\n');

  console.log('G. apply 把 payload 写回本机');
  fs.rmSync(path.join(dsh, 'skills', 'a.md'));
  const applied = await t.applyPayload(cfg, {});
  ok('apply 成功', applied.ok === true);
  ok('被删的技能文件从 payload 恢复', fs.existsSync(path.join(dsh, 'skills', 'a.md')));

  console.log('H. 失败态：空配置 / 无仓库');
  const empty = { machine: 'T', mode: 'single', remote: '', channels: { config: { remote: '', enabled: true }, sessions: { remote: '', enabled: true } }, surfaces: {} };
  const sc = await t.selfCheck(empty);
  ok('无 remote 时自检 ready=false', sc.ready === false);
  ok('引导说「填一个私有仓库地址」', (sc.guide || []).some(x => /一个私有仓库/.test(x.step || '')));
  ok('channels 列表只有一项且未配置', sc.channels.length === 1 && sc.channels[0].configured === false);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(fail ? `\nSINGLE_SMOKE_FAILED (${fail})` : `\nSINGLE_SMOKE_OK (${pass} assertions)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('smoke 崩溃:', e); process.exit(1); });
