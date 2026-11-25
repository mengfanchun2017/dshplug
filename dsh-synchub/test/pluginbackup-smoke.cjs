/* dsh-synchub · 插件清单备份/恢复 smoke（ADR-038）
 *
 * 覆盖：分类（npm/link/git）、清单只记名字不记版本、无变化不写盘、
 *       备份提交只带清单文件、恢复预览只读且能区分缺失 link 目标、
 *       确认闸门（confirm !== 'RESTORE' 拒绝）、开关关闭时备份拒绝。
 *
 * ⚠ 不依赖 git 子进程与宿主 pluginManager（沙箱会拦）。package.json 走夹具，
 *   git 提交部分只验证「未初始化时不崩、返回 not-initialized」。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synchub-plugins-'));
  const dsh = path.join(root, 'dsh');
  const profile = path.join(dsh, 'profiles', 'desktop');
  const state = path.join(dsh, 'dsh-synchub');
  const all = path.join(state, 'repos', 'all');
  fs.mkdirSync(path.join(dsh, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'sessions', '--C-dsh-x--', 's1'), { recursive: true });
  fs.mkdirSync(path.join(dsh, 'storages'), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.join(all, '.git'), { recursive: true });
  fs.writeFileSync(path.join(all, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dsh, 'AGENTS.md'), '# 全局规则\n');
  // link 目标目录（模拟已 clone 的插件仓库）
  const linkTarget = path.join(root, 'dw-plugin', 'dsh-gitok');
  fs.mkdirSync(linkTarget, { recursive: true });
  fs.writeFileSync(path.join(linkTarget, 'package.json'), JSON.stringify({ name: 'dsh-gitok', version: '0.4.4' }));

  // profile package.json：npm 两个 + link 一个 + git 一个
  const linkSpec = 'link:' + linkTarget.split(path.sep).join('/');
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: {
      'dsh-free-search': '0.9.82',
      'dsh-context': '^0.87.0',
      'dsh-gitok': linkSpec,
      'some-git-plugin': 'git+https://github.com/x/y.git',
    },
    dsh: { profile: { bundles: ['dsh-free-search', 'dsh-context', 'dsh-gitok'] } },
  }, null, 2));

  process.env.DSH_HOME = dsh;
  process.env.DSH_PROFILE_DIR = profile;
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href);
  const t = mod.__test;

  const cfg = {
    machine: 'T', remote: '',
    pluginSync: { enabled: true, autoMinutes: 0, includeLink: true },
  };

  console.log('A. classifyPluginSpec：npm / link / git');
  ok('裸版本号 = npm', t.classifyPluginSpec('dsh-context', '^0.87.0', profile).kind === 'npm');
  ok('link: = link 且路径绝对化', t.classifyPluginSpec('dsh-gitok', 'link:../dw-plugin/dsh-gitok', profile).kind === 'link');
  ok('file: = link', t.classifyPluginSpec('x', 'file:C:/a/b', profile).kind === 'link');
  ok('git+ = git', t.classifyPluginSpec('g', 'git+https://github.com/x/y.git', profile).kind === 'git');
  ok('github: = git', t.classifyPluginSpec('g', 'github:x/y', profile).kind === 'git');
  ok('linkPath 用正斜杠', t.classifyPluginSpec('x', 'link:C:\\a\\b', profile).linkPath === 'C:/a/b');

  console.log('B. readInstalledPlugins：回退 package.json（无宿主服务）');
  const cur = await t.readInstalledPlugins(cfg);
  ok('读取成功', cur.ok === true);
  ok('来源是 package.json', cur.source === 'package.json');
  const byName = Object.fromEntries(cur.plugins.map(p => [p.name, p]));
  ok('npm 两个', byName['dsh-free-search'] && byName['dsh-context'] && byName['dsh-free-search'].kind === 'npm');
  ok('link 一个且带 linkPath', byName['dsh-gitok'] && byName['dsh-gitok'].kind === 'link' && !!byName['dsh-gitok'].linkPath);
  ok('git 一个', byName['some-git-plugin'] && byName['some-git-plugin'].kind === 'git');

  console.log('C. buildPluginManifest：不记版本、不含 git');
  const doc = t.buildPluginManifest(cur.plugins, true);
  ok('只有 npm 与 link', doc.plugins.every(p => p.kind === 'npm' || p.kind === 'link'));
  ok('git 被排除', !doc.plugins.some(p => p.name === 'some-git-plugin'));
  ok('没有版本字段', JSON.stringify(doc).indexOf('0.9.82') === -1 && JSON.stringify(doc).indexOf('^0.87') === -1);
  ok('按名字排序', doc.plugins.map(p => p.name).join(',') === [...doc.plugins.map(p => p.name)].sort((a, b) => a.localeCompare(b)).join(','));
  const docNoLink = t.buildPluginManifest(cur.plugins, false);
  ok('includeLink=false 时排除 link', !docNoLink.plugins.some(p => p.kind === 'link'));

  console.log('D. writePluginManifest：写入 / 无变化不写盘');
  const w1 = await t.writePluginManifest(cfg);
  ok('首次写入', w1.ok === true && w1.written === true, JSON.stringify(w1));
  ok('计数正确', w1.count === 3, 'count=' + w1.count);
  const manifestPath = t.pluginManifestPath(cfg);
  ok('落在 dsh-home/plugins/manifest.json', manifestPath.endsWith(path.join('dsh-home', 'plugins', 'manifest.json')));
  // 提交时用的是「相对仓库根」的路径；写死 plugins/ 会因 payload 目录改名而失效（真机踩到）。
  const rel = path.relative(all, manifestPath).split(path.sep).join('/');
  ok('相对仓库根的路径含 dsh-home', rel === 'dsh-home/plugins/manifest.json', rel);
  ok('相对路径不越界（不以 .. 开头）', !rel.startsWith('..'));
  const text1 = fs.readFileSync(manifestPath, 'utf8');
  const w2 = await t.writePluginManifest(cfg);
  ok('二次无变化', w2.ok === true && w2.unchanged === true, JSON.stringify(w2));
  ok('文件内容未变', fs.readFileSync(manifestPath, 'utf8') === text1);

  console.log('E. 开关关闭：备份拒绝');
  const wOff = await t.writePluginManifest({ ...cfg, pluginSync: { ...cfg.pluginSync, enabled: false } });
  ok('disabled 被拒', wOff.ok === false && wOff.reason === 'disabled');
  const bOff = await t.backupPluginManifest({ ...cfg, pluginSync: { ...cfg.pluginSync, enabled: false } });
  ok('backup disabled 被拒', bOff.ok === false && bOff.reason === 'disabled');

  console.log('F. backupPluginManifest：git 不可用（沙箱）时如实报失败');
  const b1 = await t.backupPluginManifest(cfg);
  ok('ok=true（清单已写）', b1.ok === true, JSON.stringify(b1));
  ok('git 失败 → git-status-failed（不假装已提交）', b1.commit && (b1.commit.reason === 'git-status-failed' || b1.commit.reason === 'not-initialized'), JSON.stringify(b1.commit));

  console.log('G. readPluginManifest');
  const rm = await t.readPluginManifest(cfg);
  ok('读回成功', rm.ok === true && rm.plugins.length === 3);
  ok('有 mtime', !!rm.at);

  console.log('H. pluginRestorePreview：只读，区分缺失 link');
  const pv = await t.pluginRestorePreview(cfg);
  ok('预览 ok', pv.ok === true);
  ok('当前一致 3 个（都在清单里）', pv.already.length === 3, JSON.stringify(pv.already));
  ok('没有 addNpm', pv.addNpm.length === 0);
  ok('managerAvailable=false（无宿主服务）', pv.managerAvailable === false);
  // 让一个 link 目标消失 → 应进 linkMissing
  fs.rmSync(linkTarget, { recursive: true, force: true });
  const pv2 = await t.pluginRestorePreview(cfg);
  ok('缺失 link 目标进 linkMissing', pv2.linkMissing.length === 1 && pv2.linkMissing[0].name === 'dsh-gitok', JSON.stringify(pv2.linkMissing));
  ok('link 缺失时 canInstall=false（无处可装，需先 clone）', pv2.canInstall === false);
  // 把清单里的 npm 改成当前没有的 → addNpm
  const manifestDoc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifestDoc.plugins.push({ name: 'brand-new-plugin', kind: 'npm' });
  fs.writeFileSync(manifestPath, JSON.stringify(manifestDoc, null, 2));
  const pv3 = await t.pluginRestorePreview(cfg);
  ok('新 npm 进 addNpm', pv3.addNpm.length === 1 && pv3.addNpm[0].name === 'brand-new-plugin', JSON.stringify(pv3.addNpm));
  ok('本机多出的进 extra', Array.isArray(pv3.extra));

  console.log('I. pluginRestoreExecute：确认闸门');
  const denied = await t.pluginRestoreExecute(cfg, { confirm: 'YES' });
  ok('confirm 不对被拒', denied.ok === false && denied.reason === 'need-confirm');
  // 无宿主服务时 npm 恢复降级（清单里有 brand-new-plugin）
  const exec1 = await t.pluginRestoreExecute(cfg, { confirm: 'RESTORE' });
  ok('无 manager 时 manager-unavailable', exec1.ok === false && exec1.reason === 'manager-unavailable', JSON.stringify(exec1).slice(0, 200));
  ok('给出手动命令 hint', /dsh plugin add/.test(exec1.hint || ''));

  console.log('J. 清单不存在时的恢复');
  const emptyCfg = { ...cfg, remote: '' };
  // 临时移走清单
  const saved = fs.readFileSync(manifestPath, 'utf8');
  fs.rmSync(manifestPath, { force: true });
  const pvNo = await t.pluginRestorePreview(emptyCfg);
  ok('清单不存在 → manifestOk=false', pvNo.ok === true && pvNo.manifestOk === false);
  const exNo = await t.pluginRestoreExecute(emptyCfg, { confirm: 'RESTORE' });
  ok('执行被拒 manifest-missing', exNo.ok === false && exNo.reason === 'manifest-missing');
  fs.writeFileSync(manifestPath, saved);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log('PLUGINBACKUP_SMOKE_OK');
})().catch(e => { console.error(e); process.exit(1); });
