// dsh-synchub · 浏览器半（v0.3.0）
// 与 chatsync / dsh-config-manager 同形态：window.__ModuleLoader__.load 包装 + Cordis 导出。
//
// v0.3.0 的界面职责变了：0.2.0 是「看别人状态」，现在是「管自己同步」。
//   侧栏主面板 → 环境切换引导（该做什么）+ 通道状态 + 一键同步 + 目录地图
//   设置分节   → 通道地址、机器名、同步面开关、空闲自动推、危险目录清单
window.__ModuleLoader__.load({
  id: 'dsh-synchub',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');
    const e = react.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = react;
    const inject = ['slots'];

    const API = '/api/dsh-synchub';

    const getJSON = async (url, opts, timeout = 30000) => {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
      return r.json();
    };
    const post = (url, body) => getJSON(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    }, 300000);
    const put = (url, body) => getJSON(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    }, 60000);

    const fmt = iso => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    };

    const bytes = n => {
      const v = Number(n) || 0;
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
      return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
    };

    const ago = minutes => {
      const m = Number(minutes);
      if (!Number.isFinite(m)) return '—';
      if (m < 1) return '刚刚';
      if (m < 60) return `${Math.round(m)} 分钟前`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h} 小时前`;
      return `${Math.floor(h / 24)} 天前`;
    };

    const TIER_LABEL = { safe: '可同步', caution: '谨慎', danger: '不同步' };

    /* ---------------------------------------------------------- 提醒派生 */
    // 只由「可观测的漂移」派生；区分「查过了没事」与「根本没查」（读不到也算提醒）。
    function deriveAlerts(own) {
      const a = [];
      if (!own || !own.ok) {
        a.push({ level: 'red', text: '同步中心状态接口不可用，先看启动日志' });
        return a;
      }
      const ch = own.channels || {};
      const conf = ch.config || {};
      const sess = ch.sessions || {};

      // ① 环境切换：另一台推过 → 最该先 pull
      if (own.switched && own.stamp) {
        a.push({
          level: 'red',
          text: `换了环境：最近一次推送来自 ${own.stamp.machine}（${fmt(own.stamp.at)}）→ 先「拉取并应用」再开始工作`,
        });
      }

      // ② 通道没配好 = 根本没法跨机
      const noRemote = [];
      if (!(conf.remote || '')) noRemote.push('配置');
      if (!(sess.remote || '')) noRemote.push('会话');
      if (noRemote.length) {
        a.push({ level: 'red', text: `${noRemote.join(' / ')}通道还没连私有仓库：设置 → 同步中心` });
      }

      // ③ 落后 / 未推送 / 脏
      const behind = Math.max(conf.behind || 0, sess.behind || 0);
      const ahead = Math.max(conf.ahead || 0, sess.ahead || 0);
      const dirty = (conf.dirty || 0) + (sess.dirty || 0);
      if (behind > 0) a.push({ level: 'red', text: `落后远端 ${behind} 个提交，先拉取再改本机（否则会分叉）` });
      if (ahead > 0) a.push({ level: 'red', text: `${ahead} 个提交没推上去：点「提交并推送」` });
      if (dirty > 0) a.push({ level: 'warn', text: `payload 有 ${dirty} 处变动还没提交` });

      // ④ 从没同步过
      const never = [];
      if ((conf.remote || '') && !conf.lastCommitAt) never.push('配置');
      if ((sess.remote || '') && !sess.lastCommitAt) never.push('会话');
      if (never.length && !behind && !ahead) {
        a.push({ level: 'warn', text: `${never.join(' / ')}通道还没有任何提交，先「提交并推送」建立基线` });
      }

      // ⑤ 空闲自动推
      const auto = own.auto || {};
      if (auto.lastResult && auto.lastResult.ok === false) {
        const r = auto.lastResult;
        a.push({ level: 'warn', text: `上次空闲自动推送失败（${fmt(r.at)}）：${r.reason || (r.pushed && JSON.stringify(r.pushed)) || '未知原因'}` });
      }
      if (!auto.enabled) {
        a.push({ level: 'info', text: '空闲自动推送是关的：离开机器前记得手动「提交并推送」' });
      }

      // ⑥ 危险面被误开
      const risky = (own.surfaces || []).filter(s => s.tier === 'danger' && s.on);
      for (const s of risky) {
        a.push({ level: 'warn', text: `「${s.label}」被打开但属于不同步面：${s.note}` });
      }

      return a;
    }

    const Dot = ({ alerts, style }) => {
      const red = alerts.some(x => x.level === 'red');
      const amber = alerts.some(x => x.level === 'warn');
      return e('span', {
        className: 'dot' + (red ? '' : amber ? ' amber' : ' none'),
        style: style || null,
        title: red ? '有需要处理的同步问题' : amber ? '有提醒' : '一切正常',
      });
    };

    /* ---------------------------------------------------------- 侧栏入口 */
    const bridge = { alerts: [], listeners: [] };
    bridge.subscribe = fn => { bridge.listeners.push(fn); return () => { bridge.listeners = bridge.listeners.filter(f => f !== fn); }; };
    bridge.publish = list => { bridge.alerts = list; bridge.listeners.forEach(f => { try { f(list); } catch {} }); };

    // 侧栏文字由插槽元数据的 label 渲染，组件里**不能**再写名字，否则会重复两遍。
    function SidebarEntry() {
      const [alerts, setAlerts] = useState(bridge.alerts);
      useEffect(() => bridge.subscribe(setAlerts), []);
      const red = alerts.some(a => a.level === 'red');
      const amber = alerts.some(a => a.level === 'warn');
      const title = red ? '同步中心：有需要处理的问题' : amber ? '同步中心：有提醒' : '同步中心';
      return e('span', {
        title,
        'aria-label': title,
        style: { display: 'inline-flex', alignItems: 'center', gap: 5, position: 'relative' },
      },
        e('svg', {
          width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
          e('path', { d: 'M7 4v12' }),
          e('path', { d: 'M4 13l3 3 3-3' }),
          e('path', { d: 'M17 20V8' }),
          e('path', { d: 'M14 11l3-3 3 3' })),
        (red || amber) && e('span', {
          style: {
            position: 'absolute', top: -2, right: -3,
            width: 7, height: 7, borderRadius: '50%',
            background: red ? '#dc2626' : '#d97706',
            boxShadow: `0 0 0 2px ${red ? 'rgba(220,38,38,.25)' : 'rgba(217,119,6,.25)'}`,
          },
        }));
    }

    /* ---------------------------------------------------------- 主面板样式 */
    const STYLES = `
.dsc{font-size:13px;line-height:1.6;color:inherit;padding:16px;max-width:860px}
.dsc h2{margin:0 0 4px;font-size:17px;display:flex;align-items:center}
.dsc .sub{opacity:.7;margin-bottom:14px;font-size:12.5px}
.dsc .card{border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.dsc .card h3{margin:0 0 8px;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsc .row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;flex-wrap:wrap}
.dsc .k{opacity:.7}.dsc .v{font-variant-numeric:tabular-nums;word-break:break-all}
.dsc .good{color:#16a34a}.dsc .warn{color:#d97706}.dsc .red{color:#dc2626}.dsc .muted{opacity:.6}
.dsc .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.dsc button{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer}
.dsc button:hover{background:rgba(128,128,128,.12)}
.dsc button:disabled{opacity:.45;cursor:default}
.dsc button.primary{border-color:#2563eb;color:#2563eb}
.dsc button.danger{border-color:#dc2626;color:#dc2626}
.dsc .alert{padding:5px 8px;border-radius:6px;margin-bottom:5px;font-size:12.5px}
.dsc .alert.red{background:rgba(220,38,38,.1)}
.dsc .alert.warn{background:rgba(217,119,6,.1)}
.dsc .alert.info{opacity:.65}
.dsc .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626;box-shadow:0 0 0 2px rgba(220,38,38,.2);margin-left:6px}
.dsc .dot.amber{background:#d97706;box-shadow:0 0 0 2px rgba(217,119,6,.2)}
.dsc .dot.none{background:#16a34a;box-shadow:none}
.dsc .err{font-size:12px;color:#dc2626;margin-top:8px;white-space:pre-wrap;word-break:break-all}
.dsc .okmsg{font-size:12px;color:#16a34a;margin-top:8px;white-space:pre-wrap;word-break:break-all}
.dsc code{font-size:11.5px;opacity:.85;word-break:break-all}
.dsc .note{font-size:12px;opacity:.65;margin-top:10px;border-top:1px dashed rgba(128,128,128,.3);padding-top:10px}
.dsc .step{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;border-radius:6px;margin-bottom:4px;font-size:12.5px}
.dsc .step.ok{background:rgba(22,163,74,.07)}
.dsc .step.need{background:rgba(220,38,38,.09)}
.dsc .step.warn{background:rgba(217,119,6,.09)}
.dsc .step.fail{background:rgba(220,38,38,.14)}
.dsc .step .act{opacity:.7;font-size:11.5px;margin-top:2px}
.dsc .bar{height:4px;border-radius:3px;background:rgba(128,128,128,.25);overflow:hidden;margin-top:6px}
.dsc .bar>i{display:block;height:100%;background:#2563eb}
.dsc table{width:100%;border-collapse:collapse;font-size:12px}
.dsc th{text-align:left;font-weight:600;opacity:.65;padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.25)}
.dsc td{padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.12);vertical-align:top}
.dsc .tag{font-size:11px;padding:0 5px;border-radius:4px;border:1px solid currentColor;white-space:nowrap}
`;

    /* ------------------------------------------------------------ 目录表
       两处面板共用。抽出来是为了不让这份深层嵌套的 e(…) 表达式
       在 Panel / SettingsSection 里各写一遍 —— 手写嵌套最容易在这里丢括号。 */
    const TIER_WHY = {
      safe: '可重建，坏了不影响开工',
      caution: '含本机特有地址（endpoint / baseURL），换机后可能要改',
      danger: '含机密材料或绝对路径，同步过去会让另一台起不来或泄密',
    };

    function DirTable({ rows, deep, pathLabel }) {
      const th = t => e('th', null, t);
      return e('table', null,
        e('thead', null, e('tr', null,
          th('位置'), th(pathLabel || '相对 DSH_HOME'), th('等级'), th('文件'), th('大小'))),
        e('tbody', null, (rows || []).map(r => {
          const hide = r.tier === 'danger' && !deep;
          const tone = r.tier === 'danger' ? 'red' : r.tier === 'caution' ? 'warn' : 'good';
          return e('tr', { key: r.id },
            e('td', null,
              e('div', null, r.label),
              e('div', { className: 'muted' },
                r.tier === 'danger' ? '永不同步' : r.syncOn ? '同步中' : '已关闭',
                r.exists ? '' : ' · 不存在')),
            e('td', null, (r.paths || []).map((p, i) => e('div', { key: i }, e('code', null, p)))),
            e('td', null, e('span', { className: tone }, TIER_LABEL[r.tier] || r.tier)),
            e('td', null, hide ? '—' : String(r.files || 0)),
            e('td', null, hide ? '—' : bytes(r.bytes)));
        })));
    }
    /* ---------------------------------------------------------------- 主面板 */
    function Panel() {
      const [own, setOwn] = useState(null);
      const [pre, setPre] = useState(null);
      const [map, setMap] = useState(null);
      const [busy, setBusy] = useState('');
      const [err, setErr] = useState('');
      const [okMsg, setOkMsg] = useState('');
      const [log, setLog] = useState([]);
      const [checkedAt, setCheckedAt] = useState(null);
      const mounted = useRef(true);

      const addLog = useCallback(s => setLog(l => [{ at: new Date().toISOString(), s }, ...l].slice(0, 14)), []);

      const refresh = useCallback(async () => {
        setErr('');
        const r = await Promise.allSettled([
          getJSON(`${API}/status`), getJSON(`${API}/preflight`), getJSON(`${API}/map`),
        ]);
        if (!mounted.current) return;
        const [s, p, m] = r;
        const S = s.status === 'fulfilled' ? s.value : null;
        const P = p.status === 'fulfilled' ? p.value : null;
        const M = m.status === 'fulfilled' ? m.value : null;
        setOwn(S); setPre(P); setMap(M);
        setCheckedAt(new Date());
        bridge.publish(deriveAlerts(S));
        const failures = r.filter(x => x.status === 'rejected');
        if (failures.length) {
          setErr(`${failures.length} 个接口读取失败：${failures.map(f => String((f.reason && f.reason.message) || f.reason)).join('；')}`);
        }
      }, []);

      useEffect(() => {
        mounted.current = true;
        refresh();
        const id = setInterval(refresh, 45000);
        return () => { mounted.current = false; clearInterval(id); };
      }, [refresh]);

      const alerts = useMemo(() => deriveAlerts(own), [own]);

      const act = useCallback(async (label, fn) => {
        setBusy(label); setErr(''); setOkMsg('');
        try {
          const r = await fn();
          if (r && r.ok === false) {
            setErr(`${label}失败：${r.error || r.reason || JSON.stringify(r).slice(0, 400)}`);
            addLog(`${label}：失败`);
          } else {
            const bits = [];
            if (r && r.staged) bits.push(`写入 ${r.staged.written} / 删 ${r.staged.deleted}`);
            if (r && r.applied) bits.push(`落地 ${r.applied.written} / 删 ${r.applied.deleted}`);
            if (r && r.written !== undefined) bits.push(`写入 ${r.written}`);
            if (r && r.deleted) bits.push(`删除 ${r.deleted}`);
            if (r && r.changed !== undefined) bits.push(`变动 ${r.changed} / 待删 ${r.removed}`);
            const summary = bits.join('，');
            setOkMsg(`${label}完成${summary ? '：' + summary : ''}`);
            addLog(`${label}：完成${summary ? ' — ' + summary : ''}`);
          }
        } catch (ex) {
          setErr(`${label}异常：${String((ex && ex.message) || ex)}`);
          addLog(`${label}：异常`);
        } finally {
          setBusy('');
          await refresh();
        }
      }, [addLog, refresh]);

      const B = (label, fn, cls) => e('button', {
        className: cls || '', disabled: Boolean(busy), onClick: () => act(label, fn),
      }, busy === label ? label + '…' : label);

      const conf = (own && own.channels && own.channels.config) || {};
      const sess = (own && own.channels && own.channels.sessions) || {};
      const auto = (own && own.auto) || {};
      const red = alerts.some(a => a.level === 'red');
      const amber = alerts.some(a => a.level === 'warn');
      const todo = pre ? pre.todo : null;

      const chRow = (label, c) => e('div', { className: 'row' },
        e('span', { className: 'k' }, label),
        e('span', { className: 'v' },
          c.remote
            ? e('code', null, c.remote.replace(/^https?:\/\/github\.com\//, ''))
            : e('span', { className: 'red' }, '未配置远端'),
          ' · ',
          e('span', { className: (c.behind || 0) > 0 ? 'red' : 'good' }, `${c.behind || 0} 落后`),
          ' / ',
          e('span', { className: (c.ahead || 0) > 0 ? 'red' : 'good' }, `${c.ahead || 0} 领先`),
          ' / ',
          e('span', { className: (c.dirty || 0) > 0 ? 'warn' : 'good' }, `${c.dirty || 0} 脏`),
          c.lastCommitAt ? e('span', { className: 'muted' }, ` · ${fmt(c.lastCommitAt)}`) : null));

      const stepsCard = pre ? e('div', { className: 'card' },
        e('h3', null, '开工检查',
          e('span', { className: todo ? 'red' : 'good' }, todo ? `● ${todo} 项待处理` : '● 可以开始工作')),
        (pre.steps || []).map((s, i) => e('div', { key: i, className: 'step ' + (s.state === 'ok' ? 'ok' : s.state === 'fail' ? 'fail' : s.state === 'warn' ? 'warn' : 'need') },
          e('span', { className: s.state === 'ok' ? 'good' : 'red' }, s.state === 'ok' ? '✓' : s.state === 'warn' ? '!' : '✗'),
          e('div', null,
            e('strong', null, s.title), ' — ', e('span', { className: 'muted' }, s.detail),
            s.action ? e('div', { className: 'act' }, '→ ', s.action) : null))),
        e('div', { className: 'btns' },
          B('拉取并应用', () => post(`${API}/pull`, { apply: true }), 'primary'),
          B('提交并推送', () => post(`${API}/push`, {})),
          B('一键同步', () => post(`${API}/sync`, { pullFirst: true }))),
        e('div', { className: 'note' },
          '「一键同步」= 拉取 → 应用到本机 → 扫描 → 提交 → 推送。落后远端时它先拉，永不 force；',
          '写本机前会把被覆盖/删除的文件备份到 ',
          e('code', null, '$DSH_HOME\\dsh-synchub\\backups\\'),
          '。'))
        : e('div', { className: 'card' }, e('h3', null, '开工检查'), e('div', { className: 'muted' }, '读取中…'));

      const chanCard = e('div', { className: 'card' },
        e('h3', null, '① 两个同步通道'),
        chRow('配置通道', conf),
        chRow('会话通道', sess),
        own && own.stamp ? e('div', { className: 'row' },
          e('span', { className: 'k' }, '最近一次推送来自'),
          e('span', { className: own.switched ? 'red' : 'good' },
            `${own.stamp.machine} · ${fmt(own.stamp.at)}${own.switched ? '（不是本机，先拉取）' : '（本机）'}`)) : null,
        own && own.activeSession ? e('div', { className: 'row' },
          e('span', { className: 'k' }, '当前会话'),
          e('span', { className: 'v' }, e('code', null, own.activeSession), e('span', { className: 'muted' }, ' · 应用时会跳过它，避免覆盖活着的日志'))) : null,
        e('div', { className: 'btns' },
          B('扫描本机变动', () => getJSON(`${API}/scan`)),
          B('只拉取', () => post(`${API}/pull`, { apply: false })),
          B('只暂存', () => post(`${API}/stage`, {}))),
        e('div', { className: 'note' },
          '配置通道 = 技能库 + DSH 配置层（不含插件清单，避免把 link: 绝对路径带过去）；',
          '会话通道 = 会话日志 + 工作区登记表 + 附件池。两个通道各自独立提交，互不阻塞。'));

      const autoCard = e('div', { className: 'card' },
        e('h3', null, '② 空闲自动上传',
          e('span', { className: auto.enabled ? 'good' : 'warn' }, auto.enabled ? '● 已开启' : '● 已关闭')),
        e('div', { className: 'row' }, e('span', { className: 'k' }, '已空闲'), e('span', { className: 'v' }, ago(auto.idleMinutes))),
        e('div', { className: 'row' }, e('span', { className: 'k' }, '触发阈值'), e('span', { className: 'v' }, `${auto.idlePushMinutes || 0} 分钟无操作`)),
        e('div', { className: 'row' }, e('span', { className: 'k' }, '上次自动推送'), e('span', { className: 'v' },
          auto.lastAt ? `${fmt(auto.lastAt)} ${auto.lastResult && auto.lastResult.ok === false ? '（失败）' : ''}` : '还没触发过')),
        auto.lastResult ? e('div', { className: 'row' }, e('span', { className: 'k' }, '上次结果'), e('span', { className: auto.lastResult.ok ? 'good' : 'warn' },
          auto.lastResult.reason || (auto.lastResult.ok ? '成功' : '失败'))) : null,
        e('div', { className: 'btns' },
          B('立即自动推一次', () => post(`${API}/auto`, {}), 'primary'),
          B('刷新', () => getJSON(`${API}/auto`))),
        e('div', { className: 'note' },
          '自动推送只在「已达空闲阈值 + 未落后远端 + 确实有变动」时执行，且 5 分钟内不重复。',
          '落后远端时它**不动**，只记一条失败原因，等你自己先拉 —— 这是为了避免无人值守时分叉。'));

      const mapCard = map ? e('div', { className: 'card' },
        e('h3', null, '③ 本机目录地图', e('span', { className: 'muted' }, `DSH_HOME = ${map.dshHome}`)),
        e(DirTable, { rows: map.rows, pathLabel: '路径' }),
        e('div', { className: 'note' },
          '「不同步」的目录只在这里列出来，永不进入仓库 —— 解释见设置面板的目录清单。',
          '危险项不统计大小（避免遍历几百 MB 的运行时目录）。')) : null;

      return e('div', { className: 'dsc' },
        e('style', null, STYLES),
        e('h2', null, '同步中心', e(Dot, { alerts })),
        e('div', { className: 'sub' },
          `本机 ${own ? own.machine : '—'} · 插件 v${own ? own.version : '—'} · 检查于 ${fmt(checkedAt)} · `,
          e('button', { onClick: refresh, disabled: Boolean(busy) }, '刷新')),

        e('div', { className: 'card' },
          e('h3', null, '待办提醒',
            e('span', { className: red ? 'red' : amber ? 'warn' : 'good' },
              red ? '● 需要处理' : amber ? '● 有提醒' : '● 一切正常')),
          alerts.length === 0
            ? e('div', { className: 'muted' }, '没有待办项。')
            : alerts.map((a, i) => e('div', { key: i, className: 'alert ' + a.level }, a.text)),
          e('div', { className: 'note' },
            '红点只由「本机↔远端的领先/落后/脏、环境切换、自动推送失败」派生。',
            '刻意区分「查过了没事」与「根本没查」—— 读不到状态也算一条提醒，不会静默显示绿灯。')),

        stepsCard,
        chanCard,
        autoCard,
        mapCard,

        err ? e('div', { className: 'err' }, err) : null,
        okMsg ? e('div', { className: 'okmsg' }, okMsg) : null,
        log.length ? e('div', { className: 'card' }, e('h3', null, '操作记录'),
          log.map((l, i) => e('div', { key: i, className: 'row' },
            e('span', { className: 'k' }, fmt(l.at)), e('span', null, l.s)))) : null,
      );
    }

    /* ---------------------------------------------------------- 设置面板 */
    const CONFIG_STYLES = `
.dshc{font-size:13px;line-height:1.6;padding:16px;max-width:860px}
.dshc h2{margin:0 0 4px;font-size:17px}
.dshc .sub{opacity:.7;margin-bottom:16px;font-size:12.5px}
.dshc .card{border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.dshc .card h3{margin:0 0 10px;font-size:14px}
.dshc .field{display:grid;grid-template-columns:160px 1fr;gap:8px 12px;align-items:center;padding:5px 0}
.dshc .field label{opacity:.75;font-size:12.5px}
.dshc input[type=text],.dshc input[type=number]{font:inherit;width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit}
.dshc .hint{grid-column:2;font-size:11.5px;opacity:.6;margin-top:-3px}
.dshc .chk{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px}
.dshc .chk .why{opacity:.6;font-size:11.5px}
.dshc .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.dshc button{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer}
.dshc button:hover{background:rgba(128,128,128,.12)}.dshc button:disabled{opacity:.45;cursor:default}
.dshc button.primary{border-color:#2563eb;color:#2563eb}
.dshc .row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;flex-wrap:wrap}
.dshc .k{opacity:.7}.dshc .v{font-variant-numeric:tabular-nums;word-break:break-all}
.dshc .good{color:#16a34a}.dshc .warn{color:#d97706}.dshc .red{color:#dc2626}.dshc .muted{opacity:.6}
.dshc .check{padding:4px 8px;border-radius:6px;margin-bottom:4px;font-size:12.5px;display:flex;gap:8px;align-items:flex-start}
.dshc .check.ok{background:rgba(22,163,74,.08)}.dshc .check.bad{background:rgba(220,38,38,.1)}
.dshc code{font-size:11.5px;opacity:.85;word-break:break-all}
.dshc .msg{font-size:12px;margin-top:8px;white-space:pre-wrap;word-break:break-all}
.dshc .msg.err{color:#dc2626}.dshc .msg.ok{color:#16a34a}
.dshc .note{font-size:12px;opacity:.65;margin-top:10px;border-top:1px dashed rgba(128,128,128,.3);padding-top:10px}
.dshc table{width:100%;border-collapse:collapse;font-size:12px}
.dshc th{text-align:left;font-weight:600;opacity:.65;padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.25)}
.dshc td{padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.12);vertical-align:top}
.dshc .tag{font-size:11px;padding:0 5px;border-radius:4px;border:1px solid currentColor;white-space:nowrap}
`;


    function SettingsSection() {
      const [form, setForm] = useState(null);
      const [saved, setSaved] = useState(null);
      const [check, setCheck] = useState(null);
      const [status, setStatus] = useState(null);
      const [map, setMap] = useState(null);
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState({ text: '', kind: '' });
      const [deep, setDeep] = useState(false);

      const load = useCallback(async () => {
        try {
          const r = await getJSON(`${API}/config`);
          if (r.ok) { setForm(r.config); setSaved(r.config); }
        } catch (ex) { setMsg({ text: '配置读取失败：' + String((ex && ex.message) || ex), kind: 'err' }); }
        try { const s = await getJSON(`${API}/status`); if (s.ok) setStatus(s); } catch { /* 可选 */ }
        try { const m = await getJSON(`${API}/map`); if (m.ok) setMap(m); } catch { /* 可选 */ }
      }, []);

      useEffect(() => { load(); }, [load]);

      useEffect(() => {
        if (!deep) return;
        getJSON(`${API}/map?deep=1`).then(m => { if (m.ok) setMap(m); }).catch(() => {});
      }, [deep]);

      const set = (k, v) => setForm(f => ({ ...(f || {}), [k]: v }));
      const setCh = (ch, k, v) => setForm(f => {
        const next = { ...(f || {}) };
        next.channels = { ...(next.channels || {}) };
        next.channels[ch] = { ...(next.channels[ch] || {}), [k]: v };
        return next;
      });
      const setSurf = (id, v) => setForm(f => {
        const next = { ...(f || {}) };
        next.surfaces = { ...(next.surfaces || {}), [id]: v };
        return next;
      });

      const dirty = form && saved && JSON.stringify(form) !== JSON.stringify(saved);

      const doCheck = useCallback(async (draft) => {
        setBusy('check'); setMsg({ text: '', kind: '' });
        try {
          const r = await post(`${API}/check`, draft || form || {});
          setCheck(r);
          setMsg({
            text: r.ok ? '检查通过：所有项目可用。' : '检查发现问题，请逐项处理（不影响保存草稿）。',
            kind: r.ok ? 'ok' : 'err',
          });
        } catch (ex) { setMsg({ text: '检查失败：' + String((ex && ex.message) || ex), kind: 'err' }); }
        finally { setBusy(''); }
      }, [form]);

      const doSave = useCallback(async () => {
        setBusy('save'); setMsg({ text: '', kind: '' });
        try {
          const pre = await post(`${API}/check`, form);
          setCheck(pre);
          const r = await put(`${API}/config`, form || {});
          if (!r.ok) throw new Error(r.error || '保存失败');
          setForm(r.config); setSaved(r.config);
          setMsg({
            text: pre.ok ? '已保存，检查通过。' : '已保存，但检查仍有问题；建议修好后再用同步功能。',
            kind: pre.ok ? 'ok' : 'err',
          });
          const s = await getJSON(`${API}/status`); if (s.ok) setStatus(s);
        } catch (ex) { setMsg({ text: '保存失败：' + String((ex && ex.message) || ex), kind: 'err' }); }
        finally { setBusy(''); }
      }, [form]);

      const F = (k, label, hint, type) => e(react.Fragment, { key: k },
        e('div', { className: 'field' },
          e('label', null, label),
          type === 'checkbox'
            ? e('input', { type: 'checkbox', checked: Boolean(form?.[k]), onChange: ev => set(k, ev.target.checked) })
            : e('input', {
              type: type || 'text',
              value: form?.[k] ?? '',
              onChange: ev => set(k, type === 'number' ? Number(ev.target.value) : ev.target.value),
            }),
          hint ? e('div', { className: 'hint' }, hint) : null));

      const CH = (ch, label, hint) => e(react.Fragment, { key: ch },
        e('div', { className: 'field' },
          e('label', null, label),
          e('input', {
            type: 'text',
            placeholder: 'https://github.com/<你>/<私有仓库>.git',
            value: (form?.channels?.[ch]?.remote) ?? '',
            onChange: ev => setCh(ch, 'remote', ev.target.value),
          }),
          e('div', { className: 'hint' }, hint)),
        e('div', { className: 'chk' },
          e('input', {
            type: 'checkbox',
            checked: form?.channels?.[ch]?.enabled !== false,
            onChange: ev => setCh(ch, 'enabled', ev.target.checked),
          }),
          e('span', null, `启用${label}`)));

      const row = (k, v) => e('div', { className: 'row' }, e('span', { className: 'k' }, k), e('span', { className: 'v' }, v));

      const statusCard = e('div', { className: 'card' },
        e('h3', null, '当前状态'),
        status === null ? e('div', { className: 'k' }, '读取中…')
          : e(react.Fragment, null,
            row('本机 / profile', `${status.machine} · ${status.profile}`),
            row('DSH_HOME', e('code', null, status.dshHome)),
            row('配置通道', status.channels?.config?.remote
              ? e('span', { className: (status.channels.config.behind || 0) > 0 ? 'red' : 'good' },
                `${status.channels.config.behind || 0} 落后 / ${status.channels.config.ahead || 0} 领先 / ${status.channels.config.dirty || 0} 脏`)
              : e('span', { className: 'red' }, '未配置')),
            row('会话通道', status.channels?.sessions?.remote
              ? e('span', { className: (status.channels.sessions.behind || 0) > 0 ? 'red' : 'good' },
                `${status.channels.sessions.behind || 0} 落后 / ${status.channels.sessions.ahead || 0} 领先 / ${status.channels.sessions.dirty || 0} 脏`)
              : e('span', { className: 'red' }, '未配置')),
            row('最近推送来自', status.stamp
              ? `${status.stamp.machine} · ${fmt(status.stamp.at)}${status.switched ? '（另一台）' : '（本机）'}`
              : '—')));

      const channelCard = e('div', { className: 'card' },
        e('h3', null, '通道地址（私有仓库）'),
        CH('config', '配置通道', '技能库 + DSH 配置层。建议单独一个私有仓库，如 dsh-config'),
        CH('sessions', '会话通道', '会话日志 + 工作区登记表 + 附件。建议单独一个私有仓库，如 dsh-sessions'),
        e('div', { className: 'note' },
          '用 HTTPS 地址（不要用 git@github.com: 这种 SSH，实测会被墙）。',
          '首次推送时 Git 凭据管理器会弹窗，用户名填 GitHub 账号、密码栏粘 PAT（fine-grained，只给 Contents 读写）。',
          '凭据存在 Windows 凭据管理器里，不会写进任何文件，也不会被同步。'));

      const formCard = e('div', { className: 'card' },
        e('h3', null, '本机设置'),
        form === null ? e('div', { className: 'k' }, '读取中…')
          : e(react.Fragment, null,
            F('machine', '机器名', '两台必须不同，否则分不清「最近一次推送来自哪台」'),
            F('workspace', '工作区路径', '必须与另一台完全相同的绝对路径（方案 1：C:\\dsh\\workspace1 → C:\\dsh\\workspace1）'),
            F('idlePushMinutes', '空闲阈值（分钟）', '这么久没有操作就自动上传；0 表示关闭自动上传', 'number'),
            F('staleHours', '过期提醒（小时）', '超过这么久没同步会给橙点提醒', 'number'),
            e('div', { className: 'chk' },
              e('input', { type: 'checkbox', checked: Boolean(form?.autoPush), onChange: ev => set('autoPush', ev.target.checked) }),
              e('span', null, '开启空闲自动上传'),
              e('span', { className: 'why' }, '落后远端时它不动，只记失败原因')),
            e('div', { className: 'btns' },
              e('button', { disabled: Boolean(busy), onClick: () => doCheck(form) }, busy === 'check' ? '检查中…' : '检查当前表单'),
              e('button', { disabled: Boolean(busy), onClick: load }, '重新读取'),
              e('button', { className: 'primary', disabled: Boolean(busy) || !dirty, onClick: doSave },
                busy === 'save' ? '保存中…' : dirty ? '保存' : '已保存'))));

      const surfCard = e('div', { className: 'card' },
        e('h3', null, '同步面开关'),
        form === null ? e('div', { className: 'k' }, '读取中…')
          : (status?.surfaces || []).map(s => e('div', { className: 'chk', key: s.id },
            e('input', {
              type: 'checkbox',
              disabled: s.tier === 'danger',
              checked: s.tier === 'danger' ? false : Boolean(form?.surfaces?.[s.id]),
              onChange: ev => setSurf(s.id, ev.target.checked),
            }),
            e('span', null, s.label),
            e('span', { className: s.tier === 'danger' ? 'red' : s.tier === 'caution' ? 'warn' : 'good' },
              `[${TIER_LABEL[s.tier] || s.tier}]`),
            e('span', { className: 'why' }, s.note))),
        e('div', { className: 'note' },
          '「不同步」的面即使打开也不会进仓库 —— 这是硬约束，不是提示。',
          '插件清单含 link:C:/... 绝对路径，两台路径不同会让另一台 DSH 起不来；',
          '技能本身的安装走 dsh-market / skill-manager，这里只同步技能文件与登记。'));

      const mapCard = map ? e('div', { className: 'card' },
        e('h3', null, '目录清单（本机实际位置）'),
        e(DirTable, { rows: map.rows, deep: deep }),
        e('div', { className: 'btns' },
          e('button', { disabled: Boolean(busy), onClick: () => setDeep(d => !d) },
            deep ? '不统计危险目录大小' : '统计危险目录大小（慢）')),
        e('div', { className: 'note' },
          '这张表就是排查与迁移的唯一入口：换机器时按它的「同步中」搬，按「永不同步」重新登录/重建。',
          '运行时与依赖（dsh-runtimes、node_modules）达数百 MB 且平台相关，重装比同步快。')) : null;

      const checkCard = check ? e('div', { className: 'card' },
        e('h3', null, '检查结果', e('span', { className: check.ok ? 'good' : 'red' }, check.ok ? ' ● 全部可用' : ' ● 有问题')),
        (check.checks || []).map((c, i) => e('div', { key: i, className: 'check ' + (c.ok ? 'ok' : 'bad') },
          e('span', { className: c.ok ? 'good' : 'red' }, c.ok ? '✓' : '✗'),
          e('div', null,
            e('strong', null, c.id), ' — ', c.detail,
            c.action ? e('div', { className: 'muted' }, '→ ', c.action) : null)))) : null;

      return e('div', { className: 'dshc' },
        e('style', null, CONFIG_STYLES),
        e('h2', null, '同步中心 · 设置与目录'),
        e('div', { className: 'sub' },
          '这里是唯一改同步设置的地方。配置只写本机 $DSH_HOME\\dsh-synchub\\config.json，不进任何同步通道。'),
        e('div', { className: 'note' },
          e('strong', null, '和其他同步入口的分工：'),
          e('br'),
          '· ', e('strong', null, '本页（同步中心）'), ' — DSH 数据目录的同步：会话、工作区登记、附件、技能、配置层。',
          e('br'),
          '· ', e('strong', null, '插件 → 插件市场（dsh-market）'), ' — 插件本身的安装/更新/备份，以及自研插件源码走 dshplug 仓库。',
          e('br'),
          '· 两套不要同时管同一个东西：dsh-market 的备份导出里若含 plugins 分区，会和这里的插件清单判定打架。'),
        statusCard,
        channelCard,
        formCard,
        surfCard,
        mapCard,
        checkCard,
        e('div', { className: 'btns' },
          e('button', { disabled: Boolean(busy), onClick: () => doCheck(form) }, busy === 'check' ? '检查中…' : '全面检查'),
          e('button', { className: 'primary', disabled: Boolean(busy) || !dirty, onClick: doSave },
            busy === 'save' ? '保存中…' : dirty ? '保存' : '已保存')),
        msg.text ? e('div', { className: 'msg ' + msg.kind }, msg.text) : null);
    }

    function apply(ctx) {
      if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
      // 侧栏入口（带红点）+ 主面板，与其他插件用同一组 slot 名。
      ctx.slots.inject('sidebar.panellist', () => {
        const main = ctx.slots.register({ name: 'main', key: 'dsh-synchub', id: 'dsh-synchub-panel' }, Panel);
        const entry = ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-synchub', order: 460, label: '同步中心' },
          SidebarEntry);
        return () => { try { entry?.(); } catch {} try { main?.(); } catch {} };
      });
      // 设置分节：通道 / 本机设置 / 同步面 / 目录清单 / 检查。
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-synchub-settings', order: 470, label: '同步中心（设置与目录）' },
            SettingsSection));
      } catch { /* 宿主没有设置 slot 时优雅降级：主面板仍可用 */ }
      // 面板打开时主动拉一次，让红点在有数据前不至于空白。
      try { getJSON(`${API}/status`).then(s => bridge.publish(deriveAlerts(s))).catch(() => {}); } catch { /* noop */ }
    }

    module.exports = { name: 'dsh-synchub', inject, apply };
    return module.exports;
  },
});
