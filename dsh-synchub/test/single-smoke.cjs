/* dsh-synchub · 单仓库回归测试（ADR-037）
 *
 * 唯一仓库（cfg.remote）：一个物理仓库 repos/all，镜像 $DSH_HOME 的目录叫 dsh-home/。
 * 没有模式切换、没有分组开关；channels 配置被忽略。
 *
 * ⚠ 本测试**不依赖 git 子进程**：DSH 的沙箱会拦掉 node 起的 git（spawn EPERM），
 * 而插件的 git() 会把失败吞成 {ok:false}。所以直接手工搭出 repos/all/.git/HEAD，
 * 只验证「文件往哪落、状态怎么报、旧 payload/ 怎么迁移」，真实推送留给真机重启验收。
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
  const all = path.join(state, 'repos', 'all');
  fs.mkdirSync(path.join(dsh, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'sessions', '--C-dsh-x--', 's1'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'storages'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'profiles', 'desktop'), { recursive: true });
  fs.mkdirSync(path.join(all, '.git'), { recursive: true });
  fs.writeFileSync(path.join(all, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dsh, 'skills', 'a.md'), '# skill A\n');
  fs.writeFileSync(path.join(dsh, 'sessions', '--C-dsh-x--', 's1', 'session.v4.jsonl.zstd'), 'BINARY');
  fs.writeFileSync(path.join(dsh, 'storages', 'workspace.json'), '{"tables":{"workspaces":{}}}');
  fs.writeFileSync(path.join(dsh, 'AGENTS.md'), '# 全局规则\n');
  fs.writeFileSync(path.join(dsh, 'profiles', 'desktop', 'cordis.patch.yml'), 'model: x\n');

  process.env.DSH_HOME = dsh;
  process.env.DSH_PROFILE_DIR = path.join(dsh, 'profiles', 'desktop');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href);
  const t = mod.__test;

  const cfg = {
    machine: 'T', remote: '',
    surfaces: { sessions: true, storages: true, attachments: true, skills: true, profileConfig: true, agentInstructions: true, profileManifest: false },
  };

  console.log('A. 纯函数：只剩一个仓库');
  ok('channelsOf 恒为 [all]', JSON.stringify(t.channelsOf()) === JSON.stringify(['all']));
  ok('repoKeyOf 恒为 all', t.repoKeyOf() === 'all');
  ok('remoteOf 取 cfg.remote', t.remoteOf('all', { remote: 'https://x/y.git' }) === 'https://x/y.git');
  ok('remote 缺省为空串', t.remoteOf('all', {}) === '');
  ok('channelLabel = 同步仓库', t.channelLabel() === '同步仓库');

  console.log('B. mergeConfig：只认 remote，旧 channels/mode 被忽略');
  const merged = t.mergeConfig({ remote: '', surfaces: {} }, { remote: 'https://x/y.git', mode: 'split', channels: { config: { remote: 'https://old/c.git' } } });
  ok('remote 被接受', merged.remote === 'https://x/y.git');
  ok('mode 不再存在', merged.mode === undefined);
  ok('channels 不再存在', merged.channels === undefined);

  console.log('C. 同步面开关（没有分组概念）');
  ok('safe 面默认可用', t.surfaceEnabled({ id: 'skills', channel: 'config', tier: 'safe' }, cfg));
  ok('被关掉的面不可用', !t.surfaceEnabled({ id: 'skills', channel: 'config', tier: 'safe' }, { ...cfg, surfaces: { ...cfg.surfaces, skills: false } }));
  ok('danger 面永远不可用', !t.surfaceEnabled({ id: 'profileManifest', channel: 'config', tier: 'danger' }, cfg));

  console.log('D. 脚手架：旧 payload/ → dsh-home/ + 生成 README');
  fs.mkdirSync(path.join(all, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(all, 'payload', 'old-session.txt'), 'OLD');
  await t.ensureRepo('all', '', cfg);
  ok('payload/ 已改名为 dsh-home/', fs.existsSync(path.join(all, 'dsh-home', 'old-session.txt')));
  ok('旧 payload/ 不存在了', !fs.existsSync(path.join(all, 'payload')));
  ok('生成了仓库 README.md', fs.existsSync(path.join(all, 'README.md')));
  ok('README 说清 dsh-home 是什么', fs.readFileSync(path.join(all, 'README.md'), 'utf8').includes('dsh-home'));

  console.log('E. 端到端（文件层）：stage 把内容写进 repos/all/dsh-home');
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(cfg));
  const cfg2 = await t.readConfig();
  ok('readConfig 读回 remote', cfg2.remote === '');

  const diff0 = await t.diffLocalToPayload(cfg2);
  ok('diff 认得全局 AGENTS.md', diff0.added.some(a => a.rel === 'AGENTS.md'), JSON.stringify(diff0.added.map(a => a.rel)));
  ok('diff 认得技能文件', diff0.added.some(a => a.rel === 'skills/a.md'));

  const staged = await t.stageChanges(cfg2);
  ok('stage 写入了文件', staged.written >= 5, `written=${staged.written}`);
  const payload = path.join(all, 'dsh-home');
  ok('payload 落在 repos/all/dsh-home', fs.existsSync(path.join(payload, 'AGENTS.md')));
  ok('repos/config 不该被创建', !fs.existsSync(path.join(state, 'repos', 'config')));
  ok('repos/sessions 不该被创建', !fs.existsSync(path.join(state, 'repos', 'sessions')));
  ok('会话正文也进了同一个 dsh-home', fs.existsSync(path.join(payload, 'sessions', '--C-dsh-x--', 's1', 'session.v4.jsonl.zstd')));

  const diff1 = await t.diffLocalToPayload(cfg2);
  ok('stage 后 diff 归零', diff1.added.length === 0 && diff1.removed.length === 0, JSON.stringify(diff1));

  console.log('F. channelState / status 只报一个仓库');
  const st = await t.channelState('all', cfg2, {});
  ok('label=同步仓库', st.label === '同步仓库');
  ok('channel 是 all', st.channel === 'all');
  ok('仓库已初始化', st.initialized === true);
  ok('分支读自 .git/HEAD', st.branch === 'main', `branch=${st.branch}`);
  ok('payloadMissing=false', st.payloadMissing === false);
  const sp = await t.statusPayload(cfg2, { fast: true });
  ok('status.channels 只有 all', Object.keys(sp.channels).join(',') === 'all');
  ok('summary 不重复计数', sp.summary.unsynced === (st.unsynced || 0), JSON.stringify(sp.summary));

  console.log('G. apply 把 dsh-home 写回本机');
  fs.rmSync(path.join(dsh, 'skills', 'a.md'));
  const applied = await t.applyPayload(cfg2, {});
  ok('apply 成功', applied.ok === true);
  ok('被删的技能文件恢复', fs.existsSync(path.join(dsh, 'skills', 'a.md')));

  console.log('H. 失败态：无 remote');
  const empty = { machine: 'T', remote: '', surfaces: {} };
  const sc = await t.selfCheck(empty);
  ok('无 remote 时 ready=false', sc.ready === false);
  ok('引导说「填一个私有仓库地址」', (sc.guide || []).some(x => /一个私有仓库/.test(x.step || '')));
  ok('channels 列表只有一项且未配置', sc.channels.length === 1 && sc.channels[0].configured === false);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(fail ? `\nSINGLE_SMOKE_FAILED (${fail})` : `\nSINGLE_SMOKE_OK (${pass} assertions)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('smoke 崩溃:', e); process.exit(1); });
