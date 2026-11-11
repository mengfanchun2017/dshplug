// dsh-synchub · 浏览器半
// 与 chatsync / dsh-config-manager 同形态：window.__ModuleLoader__.load 包装 + Cordis 导出。
window.__ModuleLoader__.load({
  id: 'dsh-synchub',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');
    const e = react.createElement;
    const { useState, useEffect, useCallback, useMemo } = react;
    const inject = ['slots'];

    const API = '/api/dsh-synchub';
    const CHATSYNC_STATUS = '/dsh-sync/api/status';
    const CHATSYNC_RUN = '/dsh-sync/api/run';
    const CM_STATUS = '/api/dsh-config-manager/sync/status?detail=0';
    const CM_PUSH = '/api/dsh-config-manager/sync/push';
    const CM_PULL = '/api/dsh-config-manager/sync/pull';

    const getJSON = async (url, opts, timeout = 20000) => {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
      return r.json();
    };
    const post = (url, body) => getJSON(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    }, 120000);

    const fmt = iso => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    };

    const isNewer = (a, b) => {
      const p = v => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || ''));
      const x = p(a), y = p(b);
      if (!x || !y || x[4]) return false;
      for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
      return Boolean(y[4]);
    };

    /* ---------------------------------------------------------- 红点状态机 */
    // 红点只由「可观测的漂移」派生，并区分「查过了没事」与「根本没查」（读不到也算提醒）。
    function deriveAlerts(own, chat, cm) {
      const a = [];
      if (!own || !own.ok) a.push({ level: 'warn', text: '同步中心状态接口不可用' });
      if (own && own.ok) {
        const w = own.workspace || {};
        if (w.error === 'not-a-git-repo') a.push({ level: 'warn', text: '工作区不是 Git 仓库' });
        else if (w.error) a.push({ level: 'warn', text: '工作区 Git 状态读取失败' });
        if (w.behind > 0) a.push({ level: 'red', text: `工作区落后远端 ${w.behind} 个提交，先拉取` });
        if (w.ahead > 0) a.push({ level: 'red', text: `工作区有 ${w.ahead} 个提交未推送` });
        if (w.dirty > 0) a.push({ level: 'warn', text: `工作区有 ${w.dirty} 个未提交改动` });
        const hours = own.staleHours || 24;
        if (w.lastCommitAt && Date.now() - new Date(w.lastCommitAt).getTime() > hours * 3600 * 1000)
          a.push({ level: 'warn', text: '本机工作区超过阈值没有新提交，可能忘了同步' });
        if (!w.lastCommitAt && !w.error) a.push({ level: 'warn', text: '工作区还没有任何提交' });
        const v = own.versions || {};
        for (const p of ['chatsync', 'dsh-config-manager', 'dshmarket'])
          if (v.outdated && v.outdated[p]) a.push({ level: 'warn', text: `${p} 有新版本 ${v.latest && v.latest[p]}（本机 ${v.local && v.local[p]}）` });
        const peers = (own.beacons && own.beacons.machines || []).filter(m => m.machine !== own.machine);
        if (peers.length === 0) a.push({ level: 'info', text: '还没看到另一台机器的信标' });
        // 核心场景：切到这台终端时，另一台机器的插件/配置版本还是旧的 → 红点，别忘同步。
        const localPlugins = (v.local || {});
        for (const peer of peers) {
          const pp = peer.plugins || {};
          const behind = Object.keys(localPlugins).filter(k =>
            localPlugins[k] && pp[k] && isNewer(localPlugins[k], pp[k]));
          if (behind.length) {
            a.push({ level: 'red', text: `${peer.machine} 的 ${behind.join('、')} 比本机旧，切过去记得先拉取同步` });
          } else if (peer.at && Date.now() - new Date(peer.at).getTime() > hours * 3600 * 1000) {
            a.push({ level: 'warn', text: `${peer.machine} 超过阈值没有上报信标，可能那边忘了同步` });
          }
        }
      }
      if (chat) {
        if (chat.configError) a.push({ level: 'red', text: 'chatsync 配置有误' });
        else if (!chat.remote) a.push({ level: 'warn', text: 'chatsync 还没连私有仓库' });
        else if (chat.lastSyncAt === null || chat.lastSyncAt === undefined) a.push({ level: 'red', text: 'chatsync 从未同步过' });
        else if (chat.lastOk === false) a.push({ level: 'red', text: 'chatsync 上次同步失败' });
        if (chat.handoff && chat.handoff.pending) a.push({ level: 'red', text: 'chatsync 有未完成的交接' });
      } else a.push({ level: 'info', text: 'chatsync 状态不可读（可能未安装）' });
      if (cm) {
        if (cm.error) a.push({ level: 'warn', text: '配置同步状态读取失败' });
        else if (cm.configured === false) a.push({ level: 'warn', text: '配置同步还没配通道' });
        else if (cm.workDir && cm.workDir.behind > 0) a.push({ level: 'red', text: `配置同步工作副本落后 ${cm.workDir.behind} 个提交` });
      } else a.push({ level: 'info', text: '配置同步状态不可读（可能未安装）' });
      return a;
    }

    /* ---------------------------------------------------------- 组件 */
    const STYLES = `
.dsc{font-size:13px;line-height:1.6;color:inherit;padding:16px;max-width:760px}
.dsc h2{margin:0 0 4px;font-size:17px}
.dsc .sub{opacity:.7;margin-bottom:16px}
.dsc .card{border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.dsc .card h3{margin:0 0 8px;font-size:14px;display:flex;align-items:center;gap:8px}
.dsc .row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;flex-wrap:wrap}
.dsc .k{opacity:.7}
.dsc .v{font-variant-numeric:tabular-nums}
.dsc .good{color:#16a34a}.dsc .warn{color:#d97706}.dsc .red{color:#dc2626}.dsc .muted{opacity:.6}
.dsc .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.dsc button{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer}
.dsc button:hover{background:rgba(128,128,128,.12)}
.dsc button:disabled{opacity:.45;cursor:default}
.dsc button.primary{border-color:#2563eb;color:#2563eb}
.dsc .alert{padding:5px 8px;border-radius:6px;margin-bottom:5px;font-size:12.5px}
.dsc .alert.red{background:rgba(220,38,38,.1)}.dsc .alert.warn{background:rgba(217,119,6,.1)}.dsc .alert.info{opacity:.65}
.dsc .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626;box-shadow:0 0 0 2px rgba(220,38,38,.2);margin-left:6px}
.dsc .dot.amber{background:#d97706;box-shadow:0 0 0 2px rgba(217,119,6,.2)}
.dsc .dot.none{background:#16a34a;box-shadow:none}
.dsc .err{font-size:12px;color:#dc2626;margin-top:8px;white-space:pre-wrap;word-break:break-all}
.dsc code{font-size:11.5px;opacity:.8;word-break:break-all}
.dsc .note{font-size:12px;opacity:.65;margin-top:10px;border-top:1px dashed rgba(128,128,128,.3);padding-top:10px}
`;

    const bridge = { alerts: [], listeners: [] };
    bridge.subscribe = fn => { bridge.listeners.push(fn); return () => { bridge.listeners = bridge.listeners.filter(f => f !== fn); }; };
    bridge.publish = a => { bridge.alerts = a; bridge.listeners.forEach(f => { try { f(a); } catch {} }); };

    function Dot({ alerts }) {
      const red = alerts.some(a => a.level === 'red');
      const amber = alerts.some(a => a.level === 'warn');
      return e('span', {
        className: 'dot ' + (red ? '' : amber ? 'amber' : 'none'),
        title: red ? '有需要处理的同步问题' : amber ? '有提醒' : '一切正常',
      });
    }

    // sidebar.panellist 的 seat 组件：常驻可见，带红点。
    function SidebarEntry() {
      const [alerts, setAlerts] = useState(bridge.alerts);
      useEffect(() => bridge.subscribe(setAlerts), []);
      const red = alerts.some(a => a.level === 'red');
      const amber = alerts.some(a => a.level === 'warn');
      return e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        e('span', null, '同步中心'),
        e('span', {
          style: {
            display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
            background: red ? '#dc2626' : amber ? '#d97706' : 'transparent',
            boxShadow: red ? '0 0 0 2px rgba(220,38,38,.2)' : amber ? '0 0 0 2px rgba(217,119,6,.2)' : 'none',
          },
          title: red ? '有需要处理的同步问题' : amber ? '有提醒' : null,
        }));
    }

    function Panel() {
      const [own, setOwn] = useState(null);
      const [chat, setChat] = useState(null);
      const [cm, setCm] = useState(null);
      const [busy, setBusy] = useState('');
      const [err, setErr] = useState('');
      const [logLines, setLogLines] = useState([]);
      const [checkedAt, setCheckedAt] = useState(null);

      const addLog = useCallback(s => setLogLines(l => [{ at: new Date().toISOString(), s }, ...l].slice(0, 12)), []);

      const refresh = useCallback(async () => {
        setErr('');
        const r = await Promise.allSettled([
          getJSON(`${API}/status`), getJSON(CHATSYNC_STATUS), getJSON(CM_STATUS),
        ]);
        const [o, c, m] = r;
        const O = o.status === 'fulfilled' ? o.value : null;
        const C = c.status === 'fulfilled' ? c.value : null;
        const M = m.status === 'fulfilled' ? m.value : null;
        setOwn(O); setChat(C); setCm(M);
        setCheckedAt(new Date());
        const alerts = deriveAlerts(O, C, M);
        bridge.publish(alerts);
        const failures = r.filter(x => x.status === 'rejected');
        if (failures.length) setErr(`${failures.length} 个状态源读取失败：${failures.map(f => String(f.reason && f.reason.message || f.reason)).join('；')}`);
      }, []);

      useEffect(() => {
        refresh();
        const id = setInterval(refresh, 60000);
        return () => clearInterval(id);
      }, [refresh]);

      const alerts = useMemo(() => deriveAlerts(own, chat, cm), [own, chat, cm]);

      const act = useCallback(async (label, fn) => {
        setBusy(label); setErr('');
        try {
          const r = await fn();
          addLog(`${label}：${r && r.ok === false ? '失败' : '完成'}${r && r.summary ? ' — ' + r.summary : ''}${r && r.output ? ' — ' + String(r.output).slice(0, 160) : ''}`);
          if (r && r.ok === false && r.error) setErr(`${label}：${r.error}`);
          if (r && r.error && r.ok === undefined) setErr(`${label}：${r.error}`);
        } catch (ex) { setErr(`${label}：${String(ex && ex.message || ex)}`); addLog(`${label}：异常`); }
        finally { setBusy(''); await refresh(); }
      }, [addLog, refresh]);

      const B = (label, fn, primary) => e('button', {
        className: primary ? 'primary' : '', disabled: Boolean(busy), onClick: () => act(label, fn),
      }, busy === label ? label + '…' : label);

      const red = alerts.some(a => a.level === 'red');
      const amber = alerts.some(a => a.level === 'warn');
      const w = (own && own.workspace) || {};
      const v = (own && own.versions) || {};

      return e('div', { className: 'dsc' },
        e('style', null, STYLES),
        e('h2', null, '同步中心', e(Dot, { alerts })),
        e('div', { className: 'sub' }, `本机 ${own ? own.machine : '—'} · 检查于 ${fmt(checkedAt)} · `,
          e('button', { onClick: refresh, disabled: Boolean(busy) }, '刷新')),
        e('div', { className: 'card' },
          e('h3', null, '待办提醒', e('span', { className: red ? 'red' : amber ? 'warn' : 'good' },
            red ? '● 需要处理' : amber ? '● 有提醒' : '● 一切正常')),
          alerts.length === 0
            ? e('div', { className: 'muted' }, '没有待办项。')
            : alerts.map((a, i) => e('div', { key: i, className: 'alert ' + a.level }, a.text)),
          e('div', { className: 'note' }, '红点只由「本机↔远端的版本/哈希差、插件新版本、上次同步时间」派生。区分「查过了没事」与「根本没查」——读不到状态也算一条提醒。')),

        e('div', { className: 'card' },
          e('h3', null, '① 工作区源码 Git'),
          e('div', { className: 'row' }, e('span', { className: 'k' }, '路径'), e('span', { className: 'v' }, e('code', null, w.root || '—'))),
          e('div', { className: 'row' }, e('span', { className: 'k' }, '远端'), e('span', { className: 'v' }, e('code', null, w.remote || '未设置'))),
          e('div', { className: 'row' }, e('span', { className: 'k' }, '分支 / 上游'), e('span', { className: 'v' }, w.branch || '—', ' → ', w.upstream || '无')),
          e('div', { className: 'row' }, e('span', { className: 'k' }, '领先 / 落后 / 脏'), e('span', { className: 'v' },
            e('span', { className: w.ahead ? 'red' : 'good' }, w.ahead || 0), ' / ',
            e('span', { className: w.behind ? 'red' : 'good' }, w.behind || 0), ' / ',
            e('span', { className: w.dirty ? 'warn' : 'good' }, w.dirty || 0))),
          e('div', { className: 'row' }, e('span', { className: 'k' }, '最后提交'), e('span', { className: 'v' }, fmt(w.lastCommitAt), ' ', e('span', { className: 'muted' }, w.lastCommit || ''))),
          e('div', { className: 'btns' },
            B('拉取', () => post(`${API}/workspace/pull`)),
            B('推送', () => post(`${API}/workspace/push`)),
            B('写本机信标', () => post(`${API}/beacon`)))),

        e('div', { className: 'card' },
          e('h3', null, '② 会话同步 · chatsync'),
          chat === null ? e('div', { className: 'muted' }, '状态不可读（可能未安装）。')
            : e(react.Fragment, null,
              e('div', { className: 'row' }, e('span', { className: 'k' }, '私有仓库'), e('span', { className: 'v' }, e('code', null, chat.remote || '未设置'))),
              e('div', { className: 'row' }, e('span', { className: 'k' }, '上次同步 / 结果'), e('span', { className: 'v' }, fmt(chat.lastSyncAt), ' ', e('span', { className: chat.lastOk === false ? 'red' : 'good' }, chat.lastOk === null || chat.lastOk === undefined ? '从未同步' : chat.lastOk ? '成功' : '失败'))),
              e('div', { className: 'row' }, e('span', { className: 'k' }, '自动同步 / 项目文件'), e('span', { className: 'v' }, chat.auto ? '开' : '关', ' / ', chat.workspaceSync ? '开' : '关'),
                chat.workspaceSync ? e('span', { className: 'warn' }, '（建议关闭，项目文件交给 ①）') : null),
              e('div', { className: 'btns' }, B('立即同步', () => post(CHATSYNC_RUN, { approval: true }), true)))),

        e('div', { className: 'card' },
          e('h3', null, '③ 配置同步 · dsh-config-manager'),
          cm === null ? e('div', { className: 'muted' }, '状态不可读（可能未安装）。')
            : e(react.Fragment, null,
              e('div', { className: 'row' }, e('span', { className: 'k' }, '通道 / 已配置'), e('span', { className: 'v' }, (cm.transport || cm.channel || '—'), ' / ', cm.configured ? '是' : '否')),
              e('div', { className: 'row' }, e('span', { className: 'k' }, '自动同步'), e('span', { className: 'v' }, cm.autosync && cm.autosync.enabled ? '开' : '关')),
              e('div', { className: 'row' }, e('span', { className: 'k' }, '工作副本'), e('span', { className: 'v' }, cm.workDir ? `${cm.workDir.ahead || 0} 领先 / ${cm.workDir.behind || 0} 落后` : '—')),
              e('div', { className: 'btns' },
                B('推送预览', () => post(CM_PUSH, { preview: true })),
                B('拉取预览', () => post(CM_PULL, { preview: true })),
                B('推送配置', () => post(CM_PUSH, {}), true)))),

        e('div', { className: 'card' },
          e('h3', null, '④ 版本与另一台机器'),
          e('div', { className: 'row' }, e('span', { className: 'k' }, '本机插件版本'), e('span', { className: 'v' },
            Object.entries(v.local || {}).filter(([, x]) => x).map(([k, x]) => `${k} ${x}`).join(' · ') || '—')),
          e('div', { className: 'row' }, e('span', { className: 'k' }, '另一台信标'), e('span', { className: 'v' },
            (own && own.beacons && own.beacons.machines || []).length
              ? own.beacons.machines.map(m => `${m.machine} @ ${fmt(m.at)}`).join(' · ')
              : '暂无（两台都装好并写过信标后才会出现）')),
          e('div', { className: 'note' }, '密钥永远不经过这里：配置同步默认不带密钥，加密快照需你手动导出并输口令；各机 OAuth 设备身份各机各自登录。')),

        err ? e('div', { className: 'err' }, err) : null,
        logLines.length ? e('div', { className: 'card' }, e('h3', null, '操作记录'),
          logLines.map((l, i) => e('div', { key: i, className: 'row' }, e('span', { className: 'k' }, fmt(l.at)), e('span', null, l.s)))) : null,
      );
    }

    function apply(ctx) {
      if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
      // 侧栏入口（带红点）+ 主面板，和 chatsync 用同一组 slot 名。
      ctx.slots.inject('sidebar.panellist', () => {
        const main = ctx.slots.register({ name: 'main', key: 'dsh-synchub', id: 'dsh-synchub-panel' }, Panel);
        const entry = ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-synchub', order: 460, label: '同步中心' },
          SidebarEntry);
        return () => { try { entry?.(); } catch {} try { main?.(); } catch {} };
      });
    }

    module.exports = { name: 'dsh-synchub', inject, apply };
    return module.exports;
  },
});
