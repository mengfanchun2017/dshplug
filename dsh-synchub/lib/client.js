// dsh-synchub · 浏览器半（v0.5.9）
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

    /* 仓库真实状态用词。hasGit 只说明 .git 在，不代表同步过：
       零提交或没有 payload 时 NOT 写「已建」——那会让人以为已经推上去了（2026-11-18 踩到）。 */
    function repoWord(r) {
      if (!r || !r.hasGit) return '未建';
      if (!r.hasHead) return '空仓库（无提交）';
      if (!r.hasPayload) return '无 payload（未同步）';
      return '已同步';
    }

    /* ---------------------------------------------------------- 提醒派生 */
    // 只由「可观测的漂移」派生；区分「查过了没事」与「根本没查」（读不到也算提醒）。
    function deriveAlerts(own) {
      const a = [];
      if (!own) {
        // 与「未配置」严格区分：这里是「没拿到数据」，不能因此说用户没配。
        a.push({ kind: 'state', level: 'warn', text: '状态还在读，稍等；若一直停在这里，看启动日志' });
        return a;
      }
      if (!own.ok) {
        a.push({ kind: 'state', level: 'red', text: '状态接口返回错误：' + (own.error || '未给出原因') });
        return a;
      }
      const ch = own.channels || {};
      const conf = ch.config || {};
      const sess = ch.sessions || {};

      // ① 环境切换：另一台推过 → 最该先 pull
      if (own.switched && own.stamp) {
        a.push({
          kind: 'switch',
          level: 'red',
          text: `换了环境：最近一次推送来自 ${own.stamp.machine}（${fmt(own.stamp.at)}）→ 先「拉取并应用」再开始工作`,
        });
      }

      // ② 通道没配好 = 根本没法跨机
      const noRemote = [];
      if (!(conf.remote || '')) noRemote.push('配置');
      if (!(sess.remote || '')) noRemote.push('会话');
      if (noRemote.length) {
        a.push({ kind: 'remote', level: 'red', text: `${noRemote.join(' / ')}通道还没连私有仓库：到「设置 → Msynchub → 两个仓库地址」里填` });
      }

      // ③ 落后 / 未推送 / 脏
      const behind = Math.max(conf.behind || 0, sess.behind || 0);
      const ahead = Math.max(conf.ahead || 0, sess.ahead || 0);
      /* 用 unsynced（仓库未提交 + 本机未暂存），不是 git dirty ——
         空仓库的 dirty 恒为 0，会把「从未同步」说成「已对齐」（ADR-026）。 */
      const unsynced = (conf.unsynced || 0) + (sess.unsynced || 0);
      if (behind > 0 && ahead > 0) {
        a.push({ kind: 'diverged', level: 'red', text: `两台机器各自推过（领先 ${ahead} / 落后 ${behind}）：普通拉取会失败，在面板里二选一（以本机为准 / 以远端为准）` });
      }
      if (behind > 0 && ahead === 0) a.push({ kind: 'behind', level: 'red', text: `落后远端 ${behind} 个提交，先拉取再改本机（否则会分叉）` });
      if (ahead > 0) a.push({ kind: 'ahead', level: 'red', text: `${ahead} 个提交没推上去：点「提交并推送」` });
      if (unsynced > 0) a.push({ kind: 'dirty', level: 'warn', text: `还有 ${unsynced} 处本机变动没同步上去：点「提交并推送」` });

      // ④ 从没同步过
      const never = [];
      if ((conf.remote || '') && !conf.lastCommitAt) never.push('配置');
      if ((sess.remote || '') && !sess.lastCommitAt) never.push('会话');
      if (never.length && !behind && !ahead) {
        a.push({ kind: 'never', level: 'warn', text: `${never.join(' / ')}通道还没有任何提交，先「提交并推送」建立基线` });
      }
      // ④b 本机文件从未进过 payload（仓库空、或 payload 目录压根不存在）。
      // 旧版只看 git dirty，空仓库恒为 0 → 面板全绿而 GitHub 上是空的。
      // pending 只在显式扫描时存在（/status 不算，因为要算 80MB 指纹）。
      // 所以这里两条路都要管：能算出 pending 用 pending；算不出但 payloadMissing 也要报。
      const pending = (conf.pending || 0) + (sess.pending || 0);
      const noPayload = [];
      if (conf.remote && conf.payloadMissing && conf.initialized) noPayload.push('配置');
      if (sess.remote && sess.payloadMissing && sess.initialized) noPayload.push('会话');
      if (pending > 0) {
        a.push({ kind: 'pending', level: 'red', text: `本机还有 ${pending} 个文件从未同步上去：点「提交并推送」` });
      } else if (noPayload.length) {
        a.push({ kind: 'noPayload', level: 'red', text: `${noPayload.join(' / ')}通道还没有 payload，本机文件从未同步上去：点「提交并推送」` });
      }
      // ⑤ 空闲自动推
      const auto = own.auto || {};
      if (auto.lastResult && auto.lastResult.ok === false) {
        const r = auto.lastResult;
        a.push({ kind: 'auto', level: 'warn', text: `上次空闲自动推送失败（${fmt(r.at)}）：${r.reason || (r.pushed && JSON.stringify(r.pushed)) || '未知原因'}` });
      }
      if (!auto.enabled) {
        a.push({ kind: 'autoOff', level: 'info', text: '空闲自动推送是关的：离开机器前记得手动「提交并推送」' });
      }

      // ⑥ 危险面被误开
      const risky = (own.surfaces || []).filter(s => s.tier === 'danger' && s.on);
      for (const s of risky) {
        a.push({ kind: 'risky', level: 'warn', text: `「${s.label}」被打开但属于不同步面：${s.note}` });
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
      const title = red ? 'Msynchub：有需要处理的问题' : amber ? 'Msynchub：有提醒' : 'Msynchub';
      return e('span', {
        title,
        'aria-label': title,
        // 红点绝对定位到图标，容器只需自身尺寸；不加 gap 以免图标被推偏。
        style: { display: 'inline-flex', alignItems: 'center', position: 'relative' },
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
            // 小一点、放在图标**左上角**：原 7px / 右上角跟宿主的其他角标撞位置，看着像另一个入口。
            position: 'absolute', top: -1, left: -2,
            width: 5, height: 5, borderRadius: '50%',
            background: red
              ? 'var(--dsw-alias-state-error-primary, #dc2626)'
              : 'var(--dsw-alias-state-warn-primary, #d97706)',
            boxShadow: `0 0 0 1.5px ${red ? 'rgba(220,38,38,.22)' : 'rgba(217,119,6,.22)'}`,
            pointerEvents: 'none',
          },
        }));
    }

    /* ---------------------------------------------------------- 主面板样式 */
    const STYLES = `
.dsc{display:flex;flex-direction:column;flex:1 1 auto;height:100%;max-height:100%;min-height:0;font-size:13px;line-height:1.6;color:inherit;overflow:hidden}
/* 宿主的 .mainPanel 是不滚动的 flex 列（overflow 不在它身上），面板必须自己建滚动区，
   否则卡片一多就被裁在下面且无法滚——这是 0.3.x 的实障。
   结构：根 → 固定头部 hd + 滚动体 body。
   高度有两道保险：flex:1+height:100% 给「插槽锚点是 flex 项」的情况；
   max-height:100% + body 的 min-height:0 给「锚点是高度自适应的普通 div」的情况，
   两种下都能拿到真实视口高度，不会退化成按内容撑开。*/
.dsc .hd{flex:0 0 auto;padding:16px 16px 10px;border-bottom:1px solid rgba(128,128,128,.18)}
.dsc .body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px 16px 28px;width:100%;box-sizing:border-box;overscroll-behavior:contain}
.dsc .body>*{max-width:900px;margin-left:auto;margin-right:auto}
.dsc h2{margin:0 0 4px;font-size:17px;display:flex;align-items:center}
.dsc .sub{opacity:.7;font-size:12.5px}
.dsc .card{border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:12px 14px;margin-bottom:12px}
/* 仪表盘：首屏必须一眼看完四个数 + 下次自动 + 两个按钮。
   之前这里只有大段说明文字，用户原话「每次进来都这样，太难弣」。 */
.dsc .dash{padding:14px}
.dsc .head-line{font-size:14px;font-weight:600;margin-bottom:10px;line-height:1.45}
.dsc .head-line.good{color:var(--dsw-alias-state-success-primary, #16a34a)}
.dsc .head-line.warn{color:var(--dsw-alias-state-warn-primary, #d97706)}
.dsc .head-line.red{color:var(--dsw-alias-state-error-primary, #dc2626)}
.dsc .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
.dsc .stat{display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 4px;border-radius:8px;background:rgba(128,128,128,.08)}
.dsc .stat b{font-size:17px;font-variant-numeric:tabular-nums;line-height:1.2}
.dsc .stat span{font-size:11px;opacity:.65}
.dsc .next-line{font-size:12.5px;padding:7px 0;border-top:1px dashed rgba(128,128,128,.25);border-bottom:1px dashed rgba(128,128,128,.25)}
.dsc .dash .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.dsc .dash button{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer}
.dsc .dash button:hover:not(:disabled){background:rgba(128,128,128,.12)}
.dsc .dash button:disabled{opacity:.45;cursor:default}
.dsc .dash button.primary{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb);color:var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb);font-weight:600}
.dsc .good{color:var(--dsw-alias-state-success-primary, #16a34a)}.dsc .warn{color:var(--dsw-alias-state-warn-primary, #d97706)}.dsc .red{color:var(--dsw-alias-state-error-primary, #dc2626)}.dsc .muted{opacity:.6}
.dsc .card h3{margin:0 0 8px;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsc .row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;flex-wrap:wrap}
.dsc .k{opacity:.7}.dsc .v{font-variant-numeric:tabular-nums;word-break:break-all}
.dsc .good{color:var(--dsw-alias-state-success-primary, #16a34a)}.dsc .warn{color:var(--dsw-alias-state-warn-primary, #d97706)}.dsc .red{color:var(--dsw-alias-state-error-primary, #dc2626)}.dsc .muted{opacity:.6}
.dsc .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.dsc button{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));background:transparent;color:inherit;cursor:pointer}
.dsc button:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))}
.dsc button:disabled{opacity:.45;cursor:default}
.dsc button.primary{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb);color:var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb)}
.dsc button.danger{border-color:var(--dsw-alias-state-error-primary, #dc2626);color:var(--dsw-alias-state-error-primary, #dc2626)}
.dsc .alert{padding:5px 8px;border-radius:6px;margin-bottom:5px;font-size:12.5px}
.dsc .alert.red{background:rgba(220,38,38,.1)}
.dsc .alert.warn{background:rgba(217,119,6,.1)}
.dsc .alert.info{opacity:.65}
.dsc .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary, #dc2626);box-shadow:0 0 0 2px rgba(220,38,38,.2);margin-left:6px}
.dsc .dot.amber{background:var(--dsw-alias-state-warn-primary, #d97706);box-shadow:0 0 0 2px rgba(217,119,6,.2)}
.dsc .dot.none{background:var(--dsw-alias-state-success-primary, #16a34a);box-shadow:none}
.dsc .err{font-size:12px;color:var(--dsw-alias-state-error-primary, #dc2626);margin-top:8px;white-space:pre-wrap;word-break:break-all}
.dsc .okmsg{font-size:12px;color:var(--dsw-alias-state-success-primary, #16a34a);margin-top:8px;white-space:pre-wrap;word-break:break-all}
.dsc code{font-size:11.5px;opacity:.85;word-break:break-all}
.dsc .note{font-size:12px;opacity:.65;margin-top:10px;border-top:1px dashed rgba(128,128,128,.3);padding-top:10px}
.dsc .step{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;border-radius:6px;margin-bottom:4px;font-size:12.5px}
.dsc .step.ok{background:rgba(22,163,74,.07)}
.dsc .step.need{background:rgba(220,38,38,.09)}
.dsc .step.warn{background:rgba(217,119,6,.09)}
.dsc .step.fail{background:rgba(220,38,38,.14)}
.dsc .step .act{opacity:.7;font-size:11.5px;margin-top:2px}
.dsc .bar{height:4px;border-radius:3px;background:rgba(128,128,128,.25);overflow:hidden;margin-top:6px}
.dsc .bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb)}
.dsc table{width:100%;border-collapse:collapse;font-size:12px}
.dsc th{text-align:left;font-weight:600;opacity:.65;padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.25)}
.dsc td{padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.12);vertical-align:top}
.dsc .tag{font-size:11px;padding:0 5px;border-radius:4px;border:1px solid currentColor;white-space:nowrap}
/* 「下一步」头卡：只在真有未完成步骤时出现，把「现在该做什么」从一长串清单里提到最上面。*/
.dsc .hero{border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45));border-left:4px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb);border-radius:10px;padding:12px 14px;margin-bottom:12px;background:rgba(37,99,235,.06)}
.dsc .hero .lead{font-size:11.5px;letter-spacing:.04em;opacity:.75;text-transform:uppercase}
.dsc .hero .what{font-size:15px;font-weight:600;margin:3px 0 4px}
.dsc .hero .why{font-size:12.5px;opacity:.85;white-space:pre-wrap}
.dsc .hero .do{font-size:12.5px;margin-top:8px;padding:7px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));background:rgba(37,99,235,.1)}
.dsc .hero .btns{margin-top:10px}
.dsc .stepsWrap{margin-top:2px}
/* 面板内直接填仓库地址：样式与设置页一致，但不依赖设置页的 .dshc 作用域。*/
.dsc .field{display:grid;grid-template-columns:130px 1fr;gap:8px 12px;align-items:center;padding:5px 0}
.dsc .field label{opacity:.75;font-size:12.5px}
.dsc input[type=text]{font:inherit;width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));border-radius:6px;background:var(--dsw-alias-bg-layer-1, transparent);color:inherit}
.dsc input[type=text]:focus{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb);outline-offset:-1px}
`;

    /* ------------------------------------------------------------ 目录表
       两处面板共用。抽出来是为了不让这份深层嵌套的 e(…) 表达式
       在 Panel / SettingsSection 里各写一遍 —— 手写嵌套最容易在这里丢括号。 */
    const TIER_WHY = {
      safe: '可重建，坏了不影响开工',
      caution: '含本机特有地址（endpoint / baseURL），换机后可能要改',
      danger: '含机密材料或绝对路径，同步过去会让另一台起不来或泄密',
    };

    /* 可复制一行：主按钮写剪贴板；失败时只选中文本，并**明说「只是选中了」**——
       否则用户按了没反应会以为进剪贴板了（AGENTS.md 的反馈教训）。 */
    function copyable(label, value) {
      return e('div', { className: 'row', key: label },
        e('span', { className: 'k', style: { flex: '0 0 auto' } }, label),
        e('span', { className: 'v', style: { flex: '1 1 240px' } }, e('code', null, value)),
        e('button', {
          type: 'button',
          onClick: async (ev) => {
            const el = ev.currentTarget;
            const done = () => { el.textContent = '已复制'; setTimeout(() => { try { el.textContent = '复制'; } catch { /* noop */ } }, 1500); };
            try {
              await navigator.clipboard.writeText(value);
              done();
            } catch {
              // 回退：选中文本，并明确告知没进剪贴板
              try {
                const range = document.createRange();
                range.selectNodeContents(el.parentElement.querySelector('code'));
                const sel = window.getSelection();
                sel.removeAllRanges(); sel.addRange(range);
                el.textContent = '已选中（未进剪贴板）';
                setTimeout(() => { try { el.textContent = '复制'; } catch { /* noop */ } }, 2200);
              } catch { el.textContent = '复制失败'; }
            }
          },
        }, '复制'));
    }

    /* 凭据说明（三处复用）：不再教用户“粘 PAT”，而是把责任交回给用户，
       并指向真正负责凭据的 gitok；synchub 只按 DSH 已经配通的方式做一次连通性确认。
        —— 为什么改：原本文案把“弹窗填 PAT”当唯一正道，既越位（凭据不是本插件的职能），
        也容易让用户以为自己必须走某一种认证方式。 */
    function CredentialNote({ compact }) {
      return e('div', { className: compact ? 'muted' : 'note', style: compact ? { fontSize: 11.5 } : undefined },
        e('strong', null, 'Git 认证请你自己搞定'), '（本插件不接收、不存储、不转发任何凭据）。',
        compact ? ' ' : e('br'),
        '推荐装 ', e('code', null, 'dsh-gitok'), '用它的「设置 → Mgitok」一键初始化：它会检查 Windows 凭据管理器、',
        'credential helper、明文凭据、代理等并给出修复命令。',
        compact ? ' ' : e('br'),
        '不想装也可以用任何方式自己配好（GCM / SSH / PAT 均可）；配好后点上面的「重新检查」，',
        'Msynchub 会按 ', e('strong', null, 'DSH 当前已经配通的方式'), '做一次真实连通性确认，不预设你必须用哪种。');
    }

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
      /* 历史：这里曾有 draft/setDraftField 用来在侧边栏直接填仓库地址。
         0.5.4 起配置只在设置里改（ADR-022），因此整套输入与保存链路已从侧边栏移除；
         旧 bug（setDraft 当字段 setter 用）也随之不存在了。回归断言看 smoke D 段。 */
      // 自检结论（宿主算好的一次性结论 + 引导）
      const [selfCheckData, setSelfCheck] = useState(null);
      // ADR-005 受控会话删除：预览 → 输入 id 二次确认 → 执行 → 重启后验收。
      const [purgeId, setPurgeId] = useState('');
      const [purgeConfirm, setPurgeConfirm] = useState('');
      const [purgePreview, setPurgePreview] = useState(null);
      // ADR-006 人工蒸馏：预览拿模板 → 人在文本框填写结论 → confirm 闸门写盘（不自动导出）。
      const [noteId, setNoteId] = useState('');
      const [noteFile, setNoteFile] = useState('');
      const [noteDraft, setNoteDraft] = useState('');
      const [notePreview, setNotePreview] = useState(null);
      const mounted = useRef(true);

      const addLog = useCallback(s => setLog(l => [{ at: new Date().toISOString(), s }, ...l].slice(0, 14)), []);

      const refresh = useCallback(async (manual) => {
        setErr('');
        // 标记一下，让头部按钮有真实反馈（之前写了「刷新中…」但从不设 busy，永远不会显）。
        if (manual) setBusy('刷新');
        /* 分两批拿：
           快接口（status?fast=1 / map / repos）先到先渲染，慢接口（preflight / self-check）随后补上。
           之前四个一起 Promise.allSettled，任何一个超时都会让整次刷新看上去全挂了 ——
           用户看到的就是「未配置远端 + 接口不可用」，哪怕配置完全正常。 */
        const reposP = getJSON(`${API}/repos`, undefined, 20000);
        const mapP = getJSON(`${API}/map`, undefined, 20000);

        const [s, m, rp] = await Promise.allSettled([fastStatus, mapP, reposP]);
        if (!mounted.current) return;
        const S = s.status === 'fulfilled' ? s.value : null;
        const M = m.status === 'fulfilled' ? m.value : null;
        if (S) setOwn(S);
        if (M) setMap(M);
        if (rp.status === 'fulfilled' && rp.value) setRepos(rp.value);
        setCheckedAt(new Date());
        bridge.publish(deriveAlerts(S));
        // 快接口失败才值得报错；慢接口单独处理，不拖累首屏。
        const fastFail = [s, m].filter(x => x.status === 'rejected');
        if (fastFail.length) {
          setErr(`${fastFail.length} 个接口读不到：${fastFail.map(f => String((f.reason && f.reason.message) || f.reason)).join('；')}`);
        }
        if (manual) setBusy('');

        /* 慢接口：带 scan 的精确值 + 自检结论。超时设长些（60s），
           且它们失败时不清空已有数据、也不报错 —— 侧边栏靠 fast 就能用，精确值是增强项。 */
        const slow = await Promise.allSettled([
          getJSON(`${API}/preflight`, undefined, 60000),
          getJSON(`${API}/self-check`, undefined, 60000),
        ]);
        if (!mounted.current) return;
        const [p, sc] = slow;
        if (p.status === 'fulfilled' && p.value) setPre(p.value);
        if (sc.status === 'fulfilled' && sc.value) setSelfCheck(sc.value);
      }, []);

      useEffect(() => {
        mounted.current = true;
        refresh(false);
        /* 轮询只跑快接口：不能每 45s 就把 preflight + self-check 也拉一遍，
           那等于每 45s 做一次 87MB 指纹 + 4 趟 GitHub 往返。
           慢接口只在首屏、手动刷新、以及隔 5 分钟的定时里跑。 */
        const tick = () => {
          getJSON(`${API}/status?fast=1`, undefined, 20000)
            .then(S => {
              if (!mounted.current) return;
              setOwn(S); setCheckedAt(new Date()); bridge.publish(deriveAlerts(S));
            })
            .catch(() => { /* 轮询失败不弹错，下一轮会自己好；手动刷新才报 */ });
          /* 代码仓库状态也一起刷：否则用户手动 git commit 后面板上的数字
             要等 5 分钟才变，会以为按钮没生效。这个接口只读本地、不访网，便宜。 */
          getJSON(`${API}/repos`, undefined, 20000)
            .then(R => { if (mounted.current && R) setRepos(R); })
            .catch(() => { /* 同上，静默 */ });
        };
        const id = setInterval(tick, 20000);
        const slowId = setInterval(() => { if (mounted.current) refresh(false); }, 300000);
        return () => { mounted.current = false; clearInterval(id); clearInterval(slowId); };
      }, [refresh]);

      /* saveRemotes 已删除：侧边栏不再写配置（ADR-022）。
         配置写入只在设置页的 doSave 一处，避免两条保存链路互踩。 */

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
          await refresh(false);
        }
      }, [addLog, refresh]);

      const B = (label, fn, cls) => e('button', {
        className: cls || '', disabled: Boolean(busy), onClick: () => act(label, fn),
      }, busy === label ? label + '…' : label);

      /* 仪表盘用的两个主操作。走 act() 以拿到统一的 busy/错误处理，
         成功后自动刷一次快状态，让数字立刻回零（不用等 20s 轮询）。 */
      const actPush = useCallback(() => act('提交并推送', async () => {
        const r = await post(`${API}/push`, {});
        refresh(false);
        return r;
      }), [act, refresh]);
      const actPull = useCallback(() => act('拉取并应用', async () => {
        const r = await post(`${API}/pull`, { apply: true });
        refresh(false);
        return r;
      }), [act, refresh]);
      /* 立即同步（0.6.0，ADR-029）：拉取+应用+提交+推送一气呢。下班点一下，全部上线。
         服务端 /sync 的顺序就是 pushChannels 之前先 pull（拉不到会停在那一步并报原因），
         所以「还在处理就等20分钟」的担心不成立：拉不动它就不推，不会半套。
         分叉时服务端 pull 阶段会失败并返回原因 —— 前端这时引导去分叉卡二选一。 */
      const actSyncNow = useCallback(() => act('立即同步', async () => {
        const r = await post(`${API}/sync`, { pullFirst: true });
        if (r && r.ok === false && /非快进|behind/.test(String(r.error || ''))) {
          setErr('检测到两台机器各自推过（分叉）：普通同步会失败。请用下面的「分叉处理」二选一。');
        }
        refresh(false);
        return r;
      }), [act, refresh]);
      /* 分叉预览：只在怀疑分叉（summary.diverged）时才拉，平时不请求。 */
      /* 代码仓库：与上面两个通道的数据分开存，因为它们的语义完全不同 ——
         通道是「整目录快照」，代码仓库是「已有历史的 git 库」。混在一起会让
         仪表盘的数字既算状态又算代码，用户看不出哪个该管。 */
      const [repos, setRepos] = useState(null);
      const [divergeData, setDivergeData] = useState(null);
      const doDivergePreview = useCallback(async () => {
        setErr('');
        try { setDivergeData(await getJSON(`${API}/diverge`, undefined, 30000)); }
        catch (ex) { setErr(`分叉预览异常：${String((ex && ex.message) || ex)}`); }
      }, []);
      const doDivergeResolve = useCallback(async (mode) => {
        await act(mode === 'keep-local' ? '以本机为准（覆盖云）' : '以远端为准（覆盖本机）', () =>
          post(`${API}/diverge/resolve`, { mode }));
        setDivergeData(null);
      }, [act]);
      /* 代码仓库的自动提交设置（来自 /repos 的 auto 字段，无需再请求 /config）。
         后端没给时按「未开启」显示 —— 宁可保守也不谎报已开。 */
      const reposAuto = (repos && repos.auto) || { enabled: false, minutes: 0 };
      const actRepoSync = useCallback((id) => act('仓库:' + id, async () => {
        const r = await post(`${API}/repos/sync`, { id });
        setRepos(await getJSON(`${API}/repos`));
        const bad = (r && r.results || []).filter(x => !x.ok);
        if (bad.length) {
          /* 把 repo 的失败原因抬到主错误带：用户点完按钮就在首屏看到原因，
             不用去翻卡片里的小字。冲突这类事必须显眼。 */
          setErr(`${id} 同步失败：${bad[0].message || (bad[0].steps || []).map(s => s.detail).filter(Boolean).join('；')}`);
        }
        return r;
      }), [act]);
      const actRepoAll = useCallback(() => act('全部仓库', async () => {
        const r = await post(`${API}/repos/sync`, {});
        setRepos(await getJSON(`${API}/repos`));
        const bad = (r && r.results || []).filter(x => !x.ok);
        if (bad.length) setErr(`${bad.length} 个仓库同步失败：` + bad.map(x => x.id).join('、'));
        return r;
      }), [act]);
      const doPurgePreview = useCallback(async () => {
        setErr(''); setPurgePreview(null);
        if (!purgeId.trim()) { setErr('先填要删除的 sessionId'); return; }
        try {
          const r = await getJSON(`${API}/purge-session?id=${encodeURIComponent(purgeId.trim())}`);
          if (!r.ok) setErr(`预览失败：${r.error || '未知原因'}`);
          else setPurgePreview(r);
        } catch (ex) { setErr(`预览异常：${String((ex && ex.message) || ex)}`); }
      }, [purgeId]);
      const doPurgeExecute = useCallback(async () => {
        if (!purgePreview || !purgePreview.ok || !purgePreview.quiet) { setErr('先预览并确认会话已静止'); return; }
        if (purgeConfirm.trim() !== purgeId.trim()) {
          setErr('二次确认不一致：请在确认框里逐字输入同一个 sessionId'); return;
        }
        await act('受控删除会话', () => post(`${API}/purge-session`, { id: purgeId.trim(), confirm: purgeConfirm.trim() }));
        setPurgeConfirm(''); setPurgePreview(null);
      }, [purgePreview, purgeConfirm, purgeId, act]);

      const doNotePreview = useCallback(async () => {
        setErr(''); setNotePreview(null);
        if (!noteId.trim()) { setErr('先填来源 sessionId'); return; }
        try {
          const q = `${API}/session-note?id=${encodeURIComponent(noteId.trim())}` + (noteFile.trim() ? `&filename=${encodeURIComponent(noteFile.trim())}` : '');
          const r = await getJSON(q);
          if (!r.ok) setErr(`预览失败：${r.error || '未知原因'}`);
          else { setNotePreview(r); setNoteDraft(r.template); }
        } catch (ex) { setErr(`预览异常：${String((ex && ex.message) || ex)}`); }
      }, [noteId, noteFile]);
      const doNoteWrite = useCallback(async () => {
        if (!notePreview || !notePreview.ok) { setErr('先预览拿到模板'); return; }
        await act('写入蒸馏文档', () => post(`${API}/session-note`, {
          id: noteId.trim(), filename: noteFile.trim() || undefined,
          content: noteDraft, confirm: 'WRITE',
        }));
      }, [notePreview, noteId, noteFile, noteDraft, act]);

      const conf = (own && own.channels && own.channels.config) || {};
      const sess = (own && own.channels && own.channels.sessions) || {};
      const auto = (own && own.auto) || {};
      const red = alerts.some(a => a.level === 'red');
      const amber = alerts.some(a => a.level === 'warn');
      const todo = pre ? pre.todo : null;
      // preflight 的步骤已经覆盖了「通道/落后/领先/脏/环境切换」，
      // 这些再在「提醒」里重写一遍就是同一件事说三遍 —— 只留步骤没覆盖的那几条。
      const coveredBySteps = new Set(['remote', 'behind', 'ahead', 'dirty', 'switch']);
      const otherAlerts = alerts.filter(a => !coveredBySteps.has(a.kind));
      const next = (pre && pre.next) || null;
      const noRemote = !conf.remote || !sess.remote;

      /* ---------------------------------------------------------------- 仪表盘
         用户反馈（2026-11-18）：「侧边栏应该让我快速了解现在还差多少要同步、差异在哪、
         下次自动是什么时候、能触发手动」。那四件事就应该是首屏，其余全部后置或折叠。 */
      const sum = (own && own.summary) || {};
      /* 兼容回退：旧宿主半（<0.5.9）没有 summary 字段。
         client.js 改一次只要刷页面，index.js 改一次必须完全重启 ——
         两者版本错配是常态。如果不回退，summary 缺失时四个数全是 0 →
         仪表盘会显示绿色「已同步，不用管」，那又是一次假绿（ADR-026 同型错误）。
         所以：没有 summary 就从旧字段自己算，并明说可靠度较低。 */
      const legacy = !own || !own.summary;
      const pendingN = legacy
        ? ((conf.pending != null ? conf.pending : conf.dirty) || 0) + ((sess.pending != null ? sess.pending : sess.dirty) || 0)
        : (sum.unsynced || 0);
      const behindN = legacy
        ? Math.max(conf.behind || 0, sess.behind || 0)
        : (sum.behind || 0);
      const aheadN = legacy
        ? Math.max(conf.ahead || 0, sess.ahead || 0)
        : (sum.ahead || 0);
      const payloadMiss = legacy
        ? ['config', 'sessions'].filter(ch => (ch === 'config' ? conf : sess).payloadMissing)
        : (sum.payloadMissing || []);
      const scanned = legacy ? (conf.scanned === true && sess.scanned === true) : Boolean(sum.scanned);
      const busyNow = Boolean(auto.busy);
      const divergedNow = Boolean(sum.diverged);
      const nextAt = auto.nextAt ? new Date(auto.nextAt) : null;
      const minsToNext = nextAt ? Math.round((nextAt.getTime() - Date.now()) / 60000) : null;

      /* 一句话结论：只回答「现在该不该动手」。
         优先级：没配远端 > 有未同步 > 落后 > 领先 > 干净。 */
      let headline, tone;
      if (noRemote) { headline = '还没连仓库，先去设置填两个地址'; tone = 'red'; }
      else if (divergedNow) { headline = '两台机器各自推过，普通同步会失败'; tone = 'red'; }
      else if (behindN > 0) { headline = `落后远端 ${behindN} 个提交，先拉取`; tone = 'red'; }
      else if (pendingN > 0) { headline = `还有 ${pendingN} 处本机变动没同步上去`; tone = 'warn'; }
      else if (aheadN > 0) { headline = `${aheadN} 个提交还没推送`; tone = 'warn'; }
      else if (payloadMiss.length) { headline = `${payloadMiss.join(' / ')}通道还没同步过`; tone = 'warn'; }
      else { headline = '已同步，不用管'; tone = 'good'; }

      const dashCard = e('div', { className: 'card dash' },
        e('div', { className: 'head-line ' + tone }, (tone === 'good' ? '✓ ' : tone === 'red' ? '✗ ' : '! ') + headline),

        /* 四个数字：一眼看完全部关键量 */
        e('div', { className: 'stats' },
          e('div', { className: 'stat' },
            e('b', { className: pendingN > 0 ? 'warn' : 'good' }, String(pendingN)),
            e('span', null, '待同步')),
          e('div', { className: 'stat' },
            e('b', { className: behindN > 0 ? 'red' : 'good' }, String(behindN)),
            e('span', null, '落后')),
          e('div', { className: 'stat' },
            e('b', { className: aheadN > 0 ? 'warn' : 'good' }, String(aheadN)),
            e('span', null, '待推送')),
          e('div', { className: 'stat' },
            e('b', { className: auto.enabled ? 'good' : 'muted' }, auto.enabled ? '开' : '关'),
            e('span', null, '自动同步'))),

        /* 下次自动是什么时候 */
        e('div', { className: 'next-line' },
          auto.enabled
            ? (busyNow
              ? e('span', { className: 'warn' }, '正在自动同步…')
              : nextAt
                ? e('span', null, '下次自动：',
                  e('strong', null, minsToNext <= 0 ? '随时（已满足空闲条件）' : `约 ${minsToNext} 分钟后`),
                  e('span', { className: 'muted' }, ` · 空闲 ${auto.idlePushMinutes || 0} 分钟触发`))
                : e('span', { className: 'muted' }, '自动同步已开启，等本机空闲后触发'))
            : e('span', { className: 'muted' }, '自动同步已关闭（只在设置里改）')),

        /* 手动操作：主按钮是「立即同步」（拉+推一气呢）；旧的纯推送/纯拉取降为次按钮。 */
        e('div', { className: 'btns' },
          e('button', { className: 'primary', disabled: Boolean(busy) || noRemote, onClick: actSyncNow },
            busy === '立即同步' ? '同步中…' : '立即同步'),
          e('button', { disabled: Boolean(busy) || noRemote, onClick: actPush,
            title: '只把本机改动提交并推上去（不拉取）' },
            busy === '提交并推送' ? '推送中…' : '提交并推送'),
          e('button', { disabled: Boolean(busy) || noRemote || behindN === 0 || divergedNow, onClick: actPull },
            busy === '拉取并应用' ? '拉取中…' : behindN > 0 ? `拉取并应用（${behindN}）` : '拉取并应用'),
          e('button', { disabled: Boolean(busy), onClick: () => { setPre(null); setSelfCheck(null); refresh(true); } },
            busy === '刷新' ? '检查中…' : '重新检查')),

        /* 版本错配必须显式报出来：刷页面就会加载新版 client，
           但宿主半（index.js）要完全重启才生效。两者错配时数字来自旧字段，
           不说清楚就会被当成新版的结论。 */
        legacy
          ? e('div', { className: 'note', style: { borderTop: 'none', paddingTop: 4, marginTop: 4 } },
            e('span', { className: 'warn' }, '宿主半还是旧版（v' + ((own && own.version) || '?') + '），'),
            ' 上面的数字由旧字段推算，不是精确值。',
            ' 完全重启 DSH 后即可对齐（只刷页面只能更新本面板）。')
          : (pendingN > 0 || payloadMiss.length) && !scanned
            ? e('div', { className: 'note', style: { borderTop: 'none', paddingTop: 4, marginTop: 4 } },
              '精确待同步数正在后台统计（首次会扫一遍本机文件）；上面的数字来自上次检查。')
            : null);
      /* 分叉二选一卡（ADR-030）：只在 divergedNow 时出现。
         预览是可选的（点「看两边的提交」才发请求）。 */
      /* 分叉处理不走二级确认输入框：两个按钮本身就是明确的方向声明，
         再加输入框只会把「二选一」变成「先打字再二选一」。 */
      const divergeCard = (own && !noRemote && divergedNow) ? e('div', { className: 'card', style: { borderColor: 'rgba(220,38,38,.5)', background: 'rgba(220,38,38,.05)' } },
        e('h3', null, '分叉处理（二选一）', e('span', { className: 'red' }, '● 必须选一个')),
        e('div', { className: 'muted' },
          '两台机器都各自推过，「拉取并应用」与「提交并推送」都会失败。这里不做三方合并：',
          '两个方向都会先备份被覆盖一侧的提交哈希到 backups/diverge-*，事后可找回。'),
        e('div', { className: 'btns', style: { marginTop: 10 } },
          B('看两边的提交', doDivergePreview),
          B('以本机为准（覆盖云）', () => doDivergeResolve('keep-local'), 'danger'),
          B('以远端为准（覆盖本机）', () => doDivergeResolve('keep-remote'), 'danger')),
        divergeData
          ? e('div', { style: { marginTop: 10 } },
            Object.entries(divergeData.channels || {}).map(([ch, st]) => e('div', { key: ch, style: { marginTop: 8 } },
              e('strong', null, ch === 'config' ? '配置通道' : '会话通道'),
              `：本机独有 ${st.localOnly ? st.localOnly.length : 0} 条 · 远端独有 ${st.remoteOnly ? st.remoteOnly.length : 0} 条`,
              (st.localOnly || []).concat(st.remoteOnly || []).length
                ? e('details', { style: { marginTop: 4 } },
                  e('summary', { style: { cursor: 'pointer', fontSize: 12 } }, '展开提交列表'),
                  e('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, margin: '4px 0' } },
                    '本机独有：\n' + ((st.localOnly || []).join('\n') || '（无）') + '\n\n远端独有：\n' + ((st.remoteOnly || []).join('\n') || '（无）')))
                : null)))
          : e('div', { className: 'muted', style: { marginTop: 8 } },
            '不确定选哪边就先点「看两边的提交」，对比后再决定。')) : null;
      // 安装地址来自宿主从真实 git remote 推导（不写死）；可能为 null。
      const installInfo = (own && own.install) || null;
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
          // 用 unsynced（仓库未提交 + 本机未暂存），与设置页同口径。
          e('span', { className: (c.unsynced || 0) > 0 ? 'warn' : 'good' }, `${c.unsynced || 0} 未同步`),
          c.lastCommitAt ? e('span', { className: 'muted' }, ` · ${fmt(c.lastCommitAt)}`) : null));

      /* 「现在做什么」头卡：把一长串清单里最重要的一条提到最上面。
         没它就得上下一行行读，这正是之前「看不清楚」的主因。 */
      /* 旧头卡逻辑与自检卡重复，已合并到 selfCheckCard（由宿主 selfCheck 驱动）。 */
      /* 自检结论卡（侧边栏第一张）：先回答“现在能不能同步”，
         不能时展开“缺什么 / 去哪填 / 怎么验证”，而不是让用户自己拼。 */
      const scReady = Boolean(selfCheckData && selfCheckData.ready);
      const selfCheckCard = selfCheckData ? e('div', { className: 'hero', style: scReady ? { borderColor: 'rgba(22,163,74,.5)', background: 'rgba(22,163,74,.07)' } : null },
        e('div', { className: 'lead' }, scReady ? '同步状态' : `待处理 ${selfCheckData.todo} 项`),
        e('div', { className: 'what' }, (scReady ? '✓ ' : '✗ ') + selfCheckData.headline),
        e('div', { className: 'why' }, selfCheckData.detail || ''),
        /* 引导：每条三行（缺什么/去哪/怎么验） */
        (selfCheckData.guide || []).length ? e('details', { style: { marginTop: 8 } },
          e('summary', { style: { cursor: 'pointer', fontSize: 12.5, opacity: 0.85 } },
            `怎么做（${selfCheckData.guide.length} 步）`),
          selfCheckData.guide.map((g, i) => e('div', { key: i, className: 'step need', style: { marginTop: 6 } },
            e('span', { className: 'red' }, `${i + 1}.`),
            e('div', null,
              e('strong', null, g.step),
              e('div', { className: 'act' }, '缺什么：', g.missing),
              e('div', { className: 'act' }, '去哪里：', g.where),
              e('div', { className: 'act' }, '怎么验：', g.verify),
              g.quick ? e('div', { className: 'act' }, g.quick) : null)))) : null,
        e('div', { className: 'btns' },
          B('重新检查', () => refresh(true), scReady ? '' : 'primary'),
          scReady ? e(react.Fragment, null,
            B('提交并推送', () => post(`${API}/push`, {})),
            B('拉取并应用', () => post(`${API}/pull`, { apply: true }))) : null)) : null;
      /* 侧边栏不再内嵌输入框（ADR-022 分工：配置只在设置里改）。
         这里只告诉用户“去哪填 + 填什么”，不再重复一套输入 + 保存按钮，
         避免“两处都能填”的混乱，也去掉了两条保存链路的竞态。 */
      /* ⚠ 必须带 own 判断：没拿到数据 ≠ 没配。
         2026-11-18 用户报障：设置里明明填好了，侧边栏却一直说「还缺两个仓库地址」——
         根因是接口超时导致 own=null，conf/sess 退化为 {}，noRemote 于是为 true。
         这条误导信息比「没数据」更糟：它让用户去重填已经正确的配置。 */
      const connectCard = (own && noRemote) ? e('div', { className: 'card' },
        e('h3', null, '还缺两个仓库地址', e('span', { className: 'red' }, '● 必需一步')),
        e('div', { className: 'muted' },
          '没有仓库地址，下面所有按钮都不起作用。只需要做两件事：'),
        e('div', { className: 'step need', style: { marginTop: 8 } },
          e('span', { className: 'red' }, '1.'),
          e('div', null,
            e('strong', null, '到设置里填地址'),
            e('div', { className: 'act' }, '路径：设置 → Msynchub → ① 必做：两个仓库地址'),
            e('div', { className: 'act' }, '填完点「保存」')),
        ),
        e('div', { className: 'step need' },
          e('span', { className: 'red' }, '2.'),
          e('div', null,
            e('strong', null, '仓库要是空的私有仓库'),
            e('div', { className: 'act' }, 'GitHub → New repository，选 Private'),
            e('div', { className: 'act' }, '不要勾 README / .gitignore / License（否则首次推送会被拒）')),
        ),
        e('div', { className: 'note' },
          '填完回本面板点「重新检查」，这张卡会自动消失。'),
        e(CredentialNote, { compact: true })) : null;

      /* ---------------------------------------------------------- 代码仓库
         与上面两个通道不是一回事：那些是 DSH 运行时状态，这些是用户自己的 git 仓库
         （插件源码、工作区笔记）。所以单独一张卡，不混入主仪表盘的数字。
         只在真的有仓库时出现，没配就不占位置。 */
      const repoList = (repos && repos.repos) || [];
      const repoShown = repoList.filter(r => r.enabled);
      const reposCard = (repos && repos.ok && repoShown.length) ? e('div', { className: 'card' },
        e('h3', null, '代码仓库',
          e('span', { className: 'muted', style: { fontWeight: 400 } },
            '  ' + repoShown.length + ' 个 · 定时提交 ' + (reposAuto.enabled ? (reposAuto.minutes || 60) + ' 分钟' : '未开启'))),
        e('div', { className: 'muted', style: { marginBottom: 6 } },
          '把你自己的 git 仓库（插件源码 / 工作区笔记）纳入：先提交，再先拉后推；冲突时停下等你处理。'),
        repoShown.map((r, i) => e('div', { key: r.id || i, className: 'step ' + (r.error ? 'fail' : (r.unsynced > 0 || r.ahead > 0 || r.behind > 0) ? 'need' : 'ok') },
          e('span', { className: r.error ? 'red' : (r.unsynced > 0 || r.ahead > 0) ? 'warn' : 'good' },
            r.error ? '✗' : (r.unsynced > 0 || r.ahead > 0 || r.behind > 0) ? '!' : '✓'),
          e('div', { style: { flex: 1 } },
            e('strong', null, r.id),
            e('span', { className: 'muted', style: { fontSize: '0.85em', marginLeft: 6 } }, r.branch || ''),
            r.error
              ? e('div', { className: 'act red' }, r.error)
              : e('div', { className: 'act' },
                (r.unsynced || 0) + ' 未提交',
                r.behind ? ' · ' + r.behind + ' 落后' : '',
                r.ahead ? ' · ' + r.ahead + ' 领先' : '',
                r.diverged ? ' · 分叉' : '',
                r.lastCommit ? ' · ' + String(r.lastCommit).slice(0, 7) : '')),
          e('button', { disabled: Boolean(busy) || Boolean(r.error), onClick: () => actRepoSync(r.id),
            title: '提交并推送这个仓库（先 pull --rebase）' },
            busy === ('仓库:' + r.id) ? '同步中…' : '同步'))),
        e('div', { className: 'btns' },
          e('button', { disabled: Boolean(busy) || !repoShown.length, onClick: actRepoAll },
            busy === '全部仓库' ? '同步中…' : '全部同步'),
          e('span', { className: 'muted', style: { alignSelf: 'center', fontSize: '0.85em' } },
            reposAuto.enabled ? '定时提交已开（无改动不提交、不联网）' : '定时提交未开（在设置里开启）')),
        e('div', { className: 'note' },
          '只同步你明确登记的仓库。冲突时中止并保留现场，不会静默覆盖你的改动。')) : null;

      /* 检查明细：只在有未完成项时出现（就绪时自检卡已经说完了，不再重写一遍）。 */
      const stepsCard = (pre && pre.todo > 0) ? e('div', { className: 'card' },
        e('h3', null, '检查明细（哪一项没过、怎么过）',
          e('span', { className: 'red' }, `● ${todo} 项待处理`)),
        (pre.steps || []).filter(s => s.state !== 'ok').map((s, i) => e('div', { key: i, className: 'step ' + (s.state === 'fail' ? 'fail' : s.state === 'warn' ? 'warn' : 'need') },
          e('span', { className: 'red' }, s.state === 'warn' ? '!' : '✗'),
          e('div', null,
            e('strong', null, s.title), ' — ', e('span', { className: 'muted' }, s.detail),
            s.action ? e('div', { className: 'act' }, '→ ', s.action) : null))),
        e('div', { className: 'note' },
          '已通过的项不在这里列出。想重跑一次就点上面的「重新检查」。'))
        : null;

      /* chanCard 已删除：它的内容合入下面烘焙的「同步通道状态」卡，
         避免同一信息在侧边栏里出现两遍（用户反馈“区分不清”的直接原因之一）。 */

      /* 空闲自动上传：完全是配置（开关/阈值），按分工应只在设置里。
         侧边栏只保留一行摘要，不提供修改，避免“两处都能配”的混乱。 */
      const autoCard = e('div', { className: 'row' },
        e('span', { className: 'k' }, '空闲自动上传'),
        e('span', { className: auto.enabled ? 'good' : 'muted' },
          auto.enabled ? `已开启 · ${auto.idlePushMinutes || 0} 分钟` : '已关闭（在设置里开启）'));

      /* 旧的「② 空闲自动上传」卡已从侧边栏移除（配置归设置）。
         侧边栏只在下面用一行摘要告诉用户当前是开还是关。 */

      const mapCard = map ? e('div', { className: 'card' },
        e('h3', null, '③ 本机目录地图', e('span', { className: 'muted' }, `DSH_HOME = ${map.dshHome}`)),
        e(DirTable, { rows: map.rows, pathLabel: '路径' }),
        e('div', { className: 'note' },
          '「不同步」的目录只在这里列出来，永不进入仓库 —— 解释见设置面板的目录清单。',
          '危险项不统计大小（避免遍历几百 MB 的运行时目录）。')) : null;

      const purgeCard = e('div', { className: 'card' },
        e('h3', null, '④ 受控删除单个会话',
          e('span', { className: 'muted' }, '不可逆 · 默认二次确认')),
        e('div', { className: 'muted', style: { marginBottom: 8 } },
          'GUI 不提供会话删除。该功能一次改「正文目录 + workspace.json 引用 + 投影缓存」，先全量备份到回滚点；搜索索引由 DSH 自行重建。删除后需重启 DSH。'),
        e('div', { className: 'field' },
          e('label', null, 'sessionId'),
          e('input', { type: 'text', value: purgeId, placeholder: 'session-xxxxxxxx-…-xxxx', onChange: ev => setPurgeId(ev.target.value) })),
        e('div', { className: 'btns' },
          e('button', { disabled: Boolean(busy), onClick: doPurgePreview }, busy === '预览影响' ? '预览中…' : '预览影响（不改动）')),
        purgePreview ? e('div', { className: 'note' },
          e('div', null, '会话静止：', purgePreview.quiet ? e('span', { className: 'good' }, '是') : e('span', { className: 'red' }, `否 — ${purgePreview.quietReason || '正在活动'}`)),
          e('div', null, '物理目录：', purgePreview.physical.length, ' 个，共 ', bytes(purgePreview.totalBytes)),
          e('div', null, 'workspace.json 引用：', purgePreview.workspaceRefs.length, ' 处'),
          e('div', null, '投影缓存：', purgePreview.projcache ? '有' : '无'),
          purgePreview.workspaceError ? e('div', { className: 'red' }, purgePreview.workspaceError) : null,
          e('div', { className: 'muted' }, purgePreview.searchIndex),
          e('div', { className: 'field' },
            e('label', null, '确认：再输入一次 id'),
            e('input', { type: 'text', value: purgeConfirm, placeholder: '逐字输入同一个 sessionId 才放行', onChange: ev => setPurgeConfirm(ev.target.value) })),
          e('div', { className: 'btns' },
            e('button', {
              className: 'danger',
              disabled: Boolean(busy) || !purgePreview.quiet || purgeConfirm.trim() !== purgeId.trim() || !purgeId.trim(),
              onClick: doPurgeExecute,
            }, '确认删除（不可撤销）')),
          e('div', { className: 'note' },
            '回滚点默认保留在 $DSH_HOME\\dsh-synchub\\backups\\purge-*\\，含 RESTORE.md。删除本体不动同步镜像；要清远端需另走「只暂存 → 提交并推送」时的显式 prune。')) : null);

      const noteCard = e('div', { className: 'card' },
        e('h3', null, '⑤ 会话蒸馏成文档',
          e('span', { className: 'muted' }, '人工确认 · 不自动导出')),
        e('div', { className: 'muted', style: { marginBottom: 8 } },
          'compact 摘要是给模型续用的上下文，不是给人看的结论。这里给一份模板，由你填写确定结论后确认写盘到会话所属工作区的 docs/session-notes/，由工作区 git 管理，随仓库跨机可见。'),
        e('div', { className: 'field' },
          e('label', null, '来源 sessionId'),
          e('input', { type: 'text', value: noteId, placeholder: 'session-xxxxxxxx-…-xxxx', onChange: ev => setNoteId(ev.target.value) })),
        e('div', { className: 'field' },
          e('label', null, '文件名（可选）'),
          e('input', { type: 'text', value: noteFile, placeholder: '留空 = session-<id>.md', onChange: ev => setNoteFile(ev.target.value) })),
        e('div', { className: 'btns' },
          e('button', { disabled: Boolean(busy), onClick: doNotePreview }, '取模板（不写盘）')),
        notePreview && notePreview.ok ? e(react.Fragment, null,
          e('div', { className: 'note' }, '目标：', e('code', null, notePreview.target),
            notePreview.exists ? e('span', { className: 'warn' }, ' · 已存在（不会覆盖，会先备份）') : e('span', { className: 'good' }, ' · 新建')),
          e('textarea', {
            value: noteDraft,
            onChange: ev => setNoteDraft(ev.target.value),
            rows: 16,
            style: { width: '100%', boxSizing: 'border-box', marginTop: 8, font: 'inherit', padding: 8, borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', whiteSpace: 'pre', fontFamily: 'monospace' },
          }),
          e('div', { className: 'note' },
            '请删掉模板里的占位文字，写入真实结论；原样提交会被拒绝。点下面的按钮即视为人工确认（confirm=WRITE）。'),
          e('div', { className: 'btns' },
            e('button', { className: 'primary', disabled: Boolean(busy) || !noteDraft.trim(), onClick: doNoteWrite }, '确认写入蒸馏文档'))) : null);

      /* 新主机安装卡：地址与命令都可点击复制（回退时显式提示「只是选中了」）。 */
      const installCard = e('div', { className: 'card' },
        e('h3', null, '⑥ 新主机安装（复制地址）'),
        e('div', { className: 'muted', style: { marginBottom: 8 } },
          '在另一台机器的「设置 → 插件 → 添加插件」里直接填下面的地址安装；地址从本仓库实际 git remote 推导，不是我写死的。'),
        (installInfo && installInfo.spec)
          ? e(react.Fragment, null,
            copyable('Git 仓库（根）', installInfo.repoHttps),
            copyable('synchub 安装地址（带子目录）', installInfo.spec),
            copyable('等价命令', installInfo.command),
            installInfo.powershell ? copyable('本机脚本方式（link:，改源码即时生效）', installInfo.powershell) : null)
          : e('div', { className: 'warn' },
            installInfo && installInfo.remote
              ? '本仓库 remote 不是可识别的 HTTPS 形态，无法自动给出安装地址。'
              : '本仓库没配 git remote（或不是扁平 dshplug 布局），无法给出 git 安装地址 —— 请用下面的本机脚本方式。'),
        installInfo && installInfo.version
          ? e('div', { className: 'note' },
            e('strong', null, '版本对照（只报事实）：'), installInfo.version.note)
          : null,
        e('div', { className: 'note' },
          e('strong', null, '为什么要带 #path:dsh-synchub：'), 'dshplug 是多插件 monorepo，**仓库根不是 bundle**；',
          '不指子目录，DSH 在根上找不到 dsh.bundle.patch，会报「没有声明组合包，无法安装」。'));

      return e('div', { className: 'dsc' },
        e('style', null, STYLES),

        /* 固定头部：标题 + 状态行 + 刷新，永不随内容滚走。 */
        e('div', { className: 'hd' },
          e('h2', null, 'Msynchub', e(Dot, { alerts })),
          e('div', { className: 'sub' },
            `本机 ${own ? own.machine : '—'} · 插件 v${own ? own.version : '—'} · 检查于 ${fmt(checkedAt)} `,
            e('button', { onClick: refresh, disabled: Boolean(busy), style: { marginLeft: 6 } }, busy === '刷新' ? '刷新中…' : '刷新'))),

        /* 滚动主体：所有卡片都在这里，内容再多也能滚到。 */
        e('div', { className: 'body' },
          /* 顺序（2026-11-18 重排，用户反馈「每次进来都这样，太难弣」）：
             ① 仪表盘：四个数 + 下次自动 + 手动按钮 —— 用户要的四件事全在这里；
             ② 未配时的引导卡（只有真的没配才出现）；
             ③ 自检结论；
             ④ 其余说明文字一律后置到折叠区。 */
          dashCard,
          /* 分叉卡必须紧跟仪表盘：它是唯一阻断性的事，其余都让位。 */
          divergeCard,
          connectCard,
          selfCheckCard,

          /* 说明性内容折叠：不需要每次进来都看到，但它又必须可查。 */
          e('details', { className: 'card', style: { padding: '8px 14px' } },
            e('summary', { style: { cursor: 'pointer', fontSize: 13, fontWeight: 600 } }, '说明与其他'),
            e('div', { style: { marginTop: 10 } },
              e('div', { className: 'muted', style: { marginBottom: 10 } },
                '本面板只管「看状态 / 点同步」。通道地址、工作区映射、同步面开关、空闲策略，',
                '全部在 ', e('strong', null, '设置 → Msynchub'), ' 里改。'),
              mapCard,
              purgeCard, noteCard, installCard)),


          otherAlerts.length ? e('div', { className: 'card' },
            e('h3', null, '还有这些提醒',
              e('span', { className: red ? 'red' : amber ? 'warn' : 'good' },
                red ? '● 需要处理' : amber ? '● 有提醒' : '● 一切正常')),
            otherAlerts.map((a, i) => e('div', { key: i, className: 'alert ' + a.level }, a.text)),
            e('div', { className: 'note' },
              '与「开工检查」重复的项不会在这里重写 —— 同一件事只说一遍。')) : null,

          stepsCard,

          /* 状态摘要：通道快照 + 空闲开关一句话（配置本身去设置里改）。 */
          e('div', { className: 'card' },
            e('h3', null, '同步通道状态'),
            chRow('配置通道', conf),
            chRow('会话通道', sess),
            own && own.stamp ? e('div', { className: 'row' },
              e('span', { className: 'k' }, '最近一次推送来自'),
              e('span', { className: own.switched ? 'red' : 'good' },
                `${own.stamp.machine} · ${fmt(own.stamp.at)}${own.switched ? '（不是本机，先拉取）' : '（本机）'}`)) : null,
            own && own.activeSession ? e('div', { className: 'row' },
              e('span', { className: 'k' }, '当前会话'),
              e('span', { className: 'v' }, e('code', null, own.activeSession),
                e('span', { className: 'muted' }, ' · 应用时会跳过它'))) : null,
            autoCard),


          err ? e('div', { className: 'err' }, err) : null,
          okMsg ? e('div', { className: 'okmsg' }, okMsg) : null,
          log.length ? e('div', { className: 'card' }, e('h3', null, '操作记录'),
            log.map((l, i) => e('div', { key: i, className: 'row' },
              e('span', { className: 'k' }, fmt(l.at)), e('span', null, l.s)))) : null));
    }

    /* ---------------------------------------------------------- 设置面板 */
    const CONFIG_STYLES = `
.dshc{font-size:13px;line-height:1.6}
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
.dshc button.primary{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb);color:var(--dsw-alias-brand-primary-new-colorprimary-new-color, #2563eb)}
.dshc .row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;flex-wrap:wrap}
.dshc .k{opacity:.7}.dshc .v{font-variant-numeric:tabular-nums;word-break:break-all}
.dshc .good{color:var(--dsw-alias-state-success-primary, #16a34a)}.dshc .warn{color:var(--dsw-alias-state-warn-primary, #d97706)}.dshc .red{color:var(--dsw-alias-state-error-primary, #dc2626)}.dshc .muted{opacity:.6}
.dshc .check{padding:4px 8px;border-radius:6px;margin-bottom:4px;font-size:12.5px;display:flex;gap:8px;align-items:flex-start}
.dshc .check.ok{background:rgba(22,163,74,.08)}.dshc .check.bad{background:rgba(220,38,38,.1)}
.dshc code{font-size:11.5px;opacity:.85;word-break:break-all}
.dshc .msg{font-size:12px;margin-top:8px;white-space:pre-wrap;word-break:break-all}
.dshc .msg.err{color:var(--dsw-alias-state-error-primary, #dc2626)}.dshc .msg.ok{color:var(--dsw-alias-state-success-primary, #16a34a)}
.dshc .note{font-size:12px;opacity:.65;margin-top:10px;border-top:1px dashed rgba(128,128,128,.3);padding-top:10px}
/* 新用户引导卡：每步左侧一条竖线，让 0→4 的顺序一眼看得出。*/
.dshc .guide{border-color:var(--dsw-alias-border-l2, rgba(128,128,128,.45))}
.dshc .guide .step{padding:8px 0 8px 12px;border-left:2px solid rgba(128,128,128,.25);margin-bottom:2px}
.dshc .guide .step:last-of-type{border-left-color:transparent}
.dshc .guide .step strong{display:block;font-size:12.5px;margin-bottom:2px}
.dshc .guide .step>b,.dshc .guide .step>div{font-size:12.5px}
.dshc .guide .muted{font-size:12px;opacity:.7;margin-top:3px;line-height:1.55}
.dshc table{width:100%;border-collapse:collapse;font-size:12px}
.dshc th{text-align:left;font-weight:600;opacity:.65;padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.25)}
.dshc td{padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.12);vertical-align:top}
.dshc .tag{font-size:11px;padding:0 5px;border-radius:4px;border:1px solid currentColor;white-space:nowrap}
/* 设置页分组标题：把 9 张卡压成三段，降低一次要读的信息量。 */
.dshc .groupTitle{margin:18px 0 8px;font-size:12.5px;font-weight:700;opacity:.9;padding-bottom:4px;border-bottom:1px solid rgba(128,128,128,.28)}
.dshc .groupTitle:first-child{margin-top:4px}
`;


    function SettingsSection() {
      const [form, setForm] = useState(null);
      const [saved, setSaved] = useState(null);
      const [check, setCheck] = useState(null);
      const [status, setStatus] = useState(null);
      const [map, setMap] = useState(null);
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState({ text: '', kind: '' });
      // 安装地址与 Panel 同源（/status.install，由宿主从真实 git remote 推导）。
      const installInfo = (status && status.install) || null;
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
      /* 工作区映射表编辑：form.workspaceMap 是 [{name, path}]。
         用普通数组编辑（增/删/改），保存时由宿主 normalizeWorkspaceMap 去重与补默认路径。

         ⚠ 修 bug：以前渲染用临时占位行 [{"", ""}]，而 setWsRow 改的是空数组 wsRows，
         对空数组 map 还是空 → 输入内容被丢掉，表现就是“在跑但输入不进去”。
         现在定义一个“有效行”：空列表时给一行空行，并且编辑与渲染用同一份。 */
      const wsRowsRaw = (form && Array.isArray(form.workspaceMap)) ? form.workspaceMap : [];
      const wsRows = wsRowsRaw.length ? wsRowsRaw : [{ name: '', path: '' }];
      const setWsRows = next => setForm(f => ({ ...(f || {}), workspaceMap: next }));
      const setWsRow = (i, patch) => setWsRows(wsRows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
      const addWsRow = () => setWsRows([...wsRows, { name: '', path: '' }]);
      // 删到空时保留一个空行，否则表格会整张消失、看不到“增加一行”。
      const removeWsRow = i => {
        const left = wsRows.filter((_, j) => j !== i);
        setWsRows(left.length ? left : [{ name: '', path: '' }]);
      };
      const adoptMissingWorkspaces = () => {
        const miss = (status && status.workspaceReport && status.workspaceReport.missingInMap) || [];
        const have = new Set(wsRows.map(r => (r.name || '').toLowerCase()).filter(Boolean));
        const add = miss.filter(m => !have.has(m.name.toLowerCase())).map(m => ({ name: m.name, path: '' }));
        // 只保留有内容的行，再追新（不要把占位空行也存进去）。
        if (add.length) setWsRows([...wsRows.filter(r => r.name || r.path), ...add]);
      };
      /* 检查并自动填写：把 DSH 里真实登记的工作区一次性带进来。
         纯确定性数据（读 workspace.json），不涉及 LLM，也不猜路径。
         策略：以真实工作区为准——已填的保留用户输入，未填的补齐（含真实 path）。 */
      const autofillWorkspaces = () => {
        const sugg = (status && status.workspaceReport && status.workspaceReport.suggestions) || [];
        if (!sugg.length) return 0;
        const existing = new Map(wsRows.filter(r => r.name).map(r => [r.name.toLowerCase(), r]));
        const merged = sugg.map(s => {
          const old = existing.get(s.name.toLowerCase());
          // 用户已填了本地位置就保留；否则用 DSH 登记的真实路径。
          return old && old.path ? old : { name: s.name, path: s.path || '' };
        });
        setWsRows(merged);
        return sugg.length;
      };
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
            // ⚠ 「脏」用 unsynced（仓库未提交 + 本机未暂存），不再是 git dirty。
            // 旧值在空仓库上恒为 0，于是 github 上是空的、面板却显示全绿。
            row('配置通道', status.channels?.config?.remote
              ? e('span', { className: ((status.channels.config.behind || 0) + (status.channels.config.unsynced || 0)) > 0 ? 'red' : 'good' },
                `${status.channels.config.behind || 0} 落后 / ${status.channels.config.ahead || 0} 领先 / ${status.channels.config.unsynced || 0} 未同步`)
              : e('span', { className: 'red' }, '未配置')),
            row('会话通道', status.channels?.sessions?.remote
              ? e('span', { className: ((status.channels.sessions.behind || 0) + (status.channels.sessions.unsynced || 0)) > 0 ? 'red' : 'good' },
                `${status.channels.sessions.behind || 0} 落后 / ${status.channels.sessions.ahead || 0} 领先 / ${status.channels.sessions.unsynced || 0} 未同步`)
              : e('span', { className: 'red' }, '未配置')),
            row('最近推送来自', status.stamp
              ? `${status.stamp.machine} · ${fmt(status.stamp.at)}${status.switched ? '（另一台）' : '（本机）'}`
              : '—'),
            status.state ? e(react.Fragment, null,
              row('状态目录', status.state.initialized
                ? e('span', { className: 'good' }, '已初始化')
                : e('span', { className: 'warn' }, '未初始化')),
              row('目录位置', e('code', null, status.state.root)),
              // ⚠ hasGit 只代表 .git 目录也在，不代表“同步成功”。旧文案写“已建”会让空仓库
              // （零提交、无 payload）看起来跟已经推上去一样——2026-11-18 用户就是这样
              // 在 GitHub 上看到空仓库、而面板显示正常的。现在分成三种真实状态。
              row('两通道仓库', e('span', null,
                `配置 ${repoWord(status.state.repos?.config)} · 会话 ${repoWord(status.state.repos?.sessions)}`)),
              row('回滚点', `${status.state.backupCount || 0} 个`),
              e('div', { className: 'muted', style: { fontSize: 11.5 } }, status.state.hint)) : null));

      const channelCard = e('div', { className: 'card' },
        e('h3', null, '通道地址（私有仓库）'),
        CH('config', '配置通道', '技能库 + DSH 配置层。建议单独一个私有仓库，如 dsh-config'),
        CH('sessions', '会话通道', '会话日志 + 工作区登记表 + 附件。建议单独一个私有仓库，如 dsh-sessions'),
        e(CredentialNote, null));

      const formCard = e('div', { className: 'card' },
        e('h3', null, '本机设置'),
        form === null ? e('div', { className: 'k' }, '读取中…')
          : e(react.Fragment, null,
            F('machine', '机器名', '每台机器必须不同（可多台），否则分不清「最近一次推送来自哪台」'),
            /* 工作区映射表：每行 = 「注册名 + 本地位置」。
               注册名就是 DSH 里那个工作区的名字（title，唯一）；
               本地位置留空 = 默认 <workspaceRoot>\<注册名>，也可手填。
               它只用于体检与展示（会话归属仍由 workspace.json 决定）。 */
            e('div', { className: 'field', style: { gridTemplateColumns: '1fr' } },
              e('label', null, '工作区映射（同步哪些工作区、它们在本机哪里）'),
              e('div', { className: 'hint', style: { gridColumn: '1' } },
                '一行一个工作区。注册名要等于 DSH 侧边栏里的工作区名（如 dshplug、base）；本地位置留空则用 ',
                e('code', null, (form?.workspaceRoot || 'C:\\dsh') + '\\<注册名>'), '。'),
              e('table', { style: { marginTop: 6 } },
                e('thead', null, e('tr', null,
                  e('th', null, '注册名'), e('th', null, '本地位置（可留空）'), e('th', null, '对照'), e('th', null, ''))),
                e('tbody', null,
                  wsRows.map((row, i) => {
                    const rep = (status && status.workspaceReport && status.workspaceReport.rows || []).find(r => r.name && row.name && r.name.toLowerCase() === row.name.toLowerCase());
                    return e('tr', { key: i },
                      e('td', null, e('input', {
                        type: 'text', value: row.name || '', placeholder: 'dshplug',
                        style: { width: '100%', boxSizing: 'border-box', font: 'inherit', padding: 4, borderRadius: 5, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit' },
                        onChange: ev => setWsRow(i, { name: ev.target.value }),
                      })),
                      e('td', null, e('input', {
                        type: 'text', value: row.path || '', placeholder: '(留空 = 默认)',
                        style: { width: '100%', boxSizing: 'border-box', font: 'inherit', padding: 4, borderRadius: 5, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit' },
                        onChange: ev => setWsRow(i, { path: ev.target.value }),
                      })),
                      e('td', null, rep
                        ? e('span', { className: rep.state === 'matched' && rep.pathExists ? 'good' : rep.state === 'unregistered' ? 'red' : 'warn' },
                          rep.state === 'unregistered' ? '未登记' : (rep.pathExists ? '已对齐' : '路径不存在'))
                        : e('span', { className: 'muted' }, row.name ? '未保存' : '')),
                      e('td', null, e('button', {
                        type: 'button', style: { padding: '2px 8px' },
                        onClick: () => removeWsRow(i), title: '删除这一行',
                      }, '×')));
                  }))),
              e('div', { className: 'btns' },
                e('button', { type: 'button', onClick: addWsRow }, '＋ 增加一行'),
                e('button', {
                  type: 'button',
                  disabled: !(status && status.workspaceReport && status.workspaceReport.suggestions && status.workspaceReport.suggestions.length),
                  onClick: () => {
                    const n = autofillWorkspaces();
                    if (n) setMsg({ text: `已按 DSH 真实登记填入 ${n} 个工作区（注册名与路径都来自 workspace.json），确认后点「保存」。`, kind: 'ok' });
                  },
                  title: '从 DSH 的 workspace.json 读取真实工作区，自动填入名字和路径（不涉及 AI）',
                }, '检查并自动填写')),
              // ⚠ 这里必须有逗号：上面 e('div',{className:'btns'},…) 是 field 的同级子节点，
              // 漏掉逗号会让 `e(...)` 的返回值被当成函数调用（`e(...) is not a function`），
              // 且只在 form 非空（配置读回来）时才求值 → 首帧正常、数据一到整块设置页白屏。
              (status && status.workspaceReport && status.workspaceReport.missingInMap && status.workspaceReport.missingInMap.length)
                ? e('div', { className: 'note' },
                  'DSH 里还登记了这些工作区，但没在你的映射表里：',
                  status.workspaceReport.missingInMap.map(m => e('span', { key: m.name },
                    ' ', e('code', null, m.name), m.pathExists ? '' : e('span', { className: 'warn' }, '(路径不存在)'))),
                  e('br'), '一键加上：',
                  e('button', {
                    type: 'button', style: { marginLeft: 4, padding: '2px 8px' },
                    onClick: () => adoptMissingWorkspaces(),
                  }, '全部加入'))
                : null),
            e('div', { className: 'field' },
              e('label', null, '工作区根目录'),
              e('input', {
                type: 'text', value: form?.workspaceRoot || '', placeholder: 'C:\\dsh',
                onChange: ev => set('workspaceRoot', ev.target.value),
              }),
              e('div', { className: 'hint' }, '注册名的默认位置 = 这个根 + \\ + 注册名。只影响体检提示，不改同步行为。')),
            e('div', { className: 'chk' },
              e('input', { type: 'checkbox', checked: form?.showInSidebar !== false, onChange: ev => set('showInSidebar', ev.target.checked) }),
              e('span', null, '在侧边栏显示 Msynchub'),
              e('span', { className: 'why' }, '关掉后侧栏入口消失，仍可从「设置 → Msynchub」使用')),
            F('idlePushMinutes', '空闲阈值（分钟）', '距上次面板操作超过这么久就算空闲；0 表示关闭自动上传（判定标准见下方）', 'number'),
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
          '技能本身的安装走 dsh-market，这里只同步技能文件。'));

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
            e('strong', null, c.label || c.id), ' — ', c.detail,
            c.action ? e('div', { className: 'muted' }, '→ ', c.action) : null)))) : null;

      return e('div', { className: 'dshc' },
        e('style', null, CONFIG_STYLES),
        e('h2', null, 'Msynchub · 设置与目录'),
        e('div', { className: 'sub' },
          '这里是唯一改同步设置的地方。配置只写本机 $DSH_HOME\\dsh-synchub\\config.json，不进任何同步通道。'),
        e('div', { className: 'note' },
          e('strong', null, '和其他同步入口的分工：'),
          e('br'),
          '· ', e('strong', null, '本页（Msynchub）'), ' — DSH 数据目录的同步：会话、工作区登记、附件、技能、配置层。',
          e('br'),
          '· ', e('strong', null, '插件本身 → 设置 → 插件 → 添加插件'), ' — 官方入口（dsh-market / 插件管理器），支持 npm 包名、Git 仓库地址、本地目录。',
          e('br'),
          '· ', e('strong', null, '本插件（Msynchub）不是市场插件'), ' — 它是自研 link: 插件，负责同步 DSH 的数据；两者的活不重迭。',
          e('br'),
          '· 两套不要同时管同一个东西：dsh-market 的备份导出里若含 plugins 分区，会和这里的插件清单判定打架。'),

        /* 新用户引导：内容保留（新人确实需要），但**默认折叠**。
           原因：它和侧边栏自检卡、BOOTSTRAP 三处覆盖同一件事，展开时会盖住首屏。
           现在首屏只留一句“如果不知道从哪开始”，想看再展开。 */
        e('details', { className: 'card guide' },
          e('summary', { style: { cursor: 'pointer' } },
            e('strong', null, '新用户从这里开始（点开看完整 0–4 步）'),
            e('span', { className: 'warn' }, ' ● 一次配好，多台机器长期用')),
          e('div', { style: { marginTop: 10 } }),
          e('div', { className: 'step' },
            e('strong', null, '第 0 步 · 先搞清楚你在同步什么'),
            e('div', null,
              '这个插件只搬 ', e('strong', null, 'DSH 自己的数据'), '：会话记录、工作区登记表、附件、技能文件、配置层。',
              e('div', { className: 'muted' },
                '它 ' , e('strong', null, '不装插件'), '（那是 dsh-market 的事），也 ', e('strong', null, '不碰'), ' 你的代码仓库。',
                '代码走 git 自己管，这里只负责「换台机器能接着干活」。'))),
          e('div', { className: 'step' },
            e('strong', null, '第 1 步 · 在 GitHub 建两个空私有仓库'),
            e('div', null,
              '两个都要 ', e('strong', null, 'Private'), '，而且 ', e('strong', null, '不要勾 README / .gitignore / License'),
              '（勾了就成了非空仓库，首次推送会被拒）。',
              e('div', { className: 'muted' },
                '建议叫 ', e('code', null, 'dsh-config'), '（配置层）与 ', e('code', null, 'dsh-sessions'), '（会话）。',
                '两者必须分开：会话体积大、变动频繁，混在一起会让配置通道天天冲突。'))),
          e('div', { className: 'step' },
            e('strong', null, '第 2 步 · 复制仓库地址，填到下面「通道地址」'),
            e('div', null,
              '必须是 ', e('code', null, 'https://github.com/<你>/<仓库>.git'), ' 这种 HTTPS 地址。',
              e('div', { className: 'muted' },
                'HTTPS 与 SSH 都行，取决于你本机已经配通哪种；不确定就先用 HTTPS，',
                '连不上时先查代理/凭据（见下面的「Git 认证」说明）。',
                '填完点「保存」，再点「重新检查」确认两个通道都不报错。'))),
          e('div', { className: 'step' },
            e('strong', null, '第 3 步 · 把 Git 认证配通（你自己搞定）'),
            e('div', null,
              '本插件不接收也不保存任何凭据。推荐装 ', e('code', null, 'dsh-gitok'), '，',
              '到「设置 → Mgitok」点一键初始化：它会检查 Windows 凭据管理器、credential helper、',
              '明文凭据、代理，并给出修复命令。',
              e('div', null, e(CredentialNote, { compact: true })))),
          e('div', { className: 'step' },
            e('strong', null, '第 4 步 · 先在一台建基线，其它机器拉'),
            e('div', null,
              e('strong', null, '第一台'), '：回侧边栏 ', e('strong', null, 'Msynchub'), '，点「', e('strong', null, '提交并推送'), '」建立基线。'),
            e('div', null,
              e('strong', null, '其它每台'), '：装好插件后点「', e('strong', null, '拉取并应用'), '」。'),
            e('div', { className: 'muted' },
              '所有机器的工作区必须放在完全相同的绝对路径（如都是 ', e('code', null, 'C:\dsh\workspace1'), '），',
              '否则工作区登记对不上。')),
          e('div', { className: 'note' },
            e('strong', null, '新机器怎么装：两条路径选一条。'),
            e('br'), e('br'),
            e('strong', null, 'A. 用 git 地址装（推荐新机器，不用 clone）'),
            e('div', null, '到 ', e('strong', null, '设置 → 插件 → 添加插件'), '，填下面任一形式：'),
            e('div', { className: 'muted' }, e('code', null, installInfo && installInfo.spec ? installInfo.spec : '<仓库地址>#path:dsh-synchub')),
            e('div', { className: 'muted' }, '也支持仓库根地址 + 子目录片段；必须带 ', e('code', null, '#path:dsh-synchub'), '，因为 dshplug 是多插件仓库，根目录不是插件包。'),
            e('div', null, e('strong', null, '升级：'), '到「设置 → 插件 → 已安装」里点「更新」（若界面提供），或先卸载再用同一地址重装。',
              e('span', { className: 'muted' }, '（git 安装拿到的是远端当前提交，没有版本自动升级。）')),
            e('br'),
            e('strong', null, 'B. 用本地目录装（适合开发/要改代码）'),
            e('div', null, '先把仓库放到固定路径，再注册为 link:'),
            e('div', { className: 'muted' }, e('code', null, '& "C:\\dsh\\dshplug\\install.ps1" -Only dsh-synchub')),
            e('div', null, e('strong', null, '升级：'), '在仓库目录 ', e('code', null, 'git pull'), ' 即可，',
              e('span', { className: 'muted' }, '因为 link: 直接指向源码，无需重装（只改了 index.js 就完全重启）。')),
            e('br'),
            '装完必须 ', e('strong', null, '完全退出 DSH 再打开'), '，插件才会出现。',
            e('br'),
            e('strong', null, '改代码后：'), '改 ', e('code', null, 'lib/client.js'), ' 刷页面即可；',
            '改 ', e('code', null, 'lib/index.js'), ' 或 ', e('code', null, 'package.json'), ' 必须完全重启 DSH。',
            e('br'),
            e('strong', null, '关于上架 dsh-market：'), '现在没上 —— 上架需要去掉 ', e('code', null, 'private'), '、选 npm 包名并发布，',
            '属发布决策（见 ADR-017）。上架后 A/B 两条路径会变成“从市场一键安装 + 市场内升级”，是多机分发的终点；',
            '在那之前，上面两条已够用。完整步骤见插件目录 ', e('code', null, 'BOOTSTRAP.md'), '。')),

        /* 配置页分三组，避免 9 张卡平铺：
           ① 必做（不配好就用不了）② 可选设置（不配也能用）③ 诊断与维护（平时不看）。 */
        e('div', { className: 'groupTitle' }, '① 必做：两个仓库地址'),
        channelCard,

        e('div', { className: 'groupTitle' }, '② 可选：本机与同步面'),
        formCard,
        surfCard,

        e('div', { className: 'groupTitle' }, '③ 诊断与维护'),
        statusCard,
        checkCard,
        mapCard,
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
        let disposed = false;
        const main = ctx.slots.register({ name: 'main', key: 'dsh-synchub', id: 'dsh-synchub-panel' }, Panel);
        const entry = ctx.slots.register(
          // 显示名 = M + 插件名（仓库级规则）：Msynchub。目录/包名仍是 dsh-synchub。
          { name: 'sidebar.panellist', id: 'dsh-synchub', order: 460, label: 'Msynchub' },
          SidebarEntry);
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          try { entry?.(); } catch { /* noop */ }
          try { main?.(); } catch { /* noop */ }
        };
        // 侧栏可见开关：apply 是同步的，先注册（首帧不闪），拿到配置后若关了就移除。
        // 设置分节不在此列 —— 关掉侧栏仍可从「设置 → Msynchub」用。
        try {
          getJSON(`${API}/config`).then(c => {
            if (c && c.config && c.config.showInSidebar === false) dispose();
          }).catch(() => {});
        } catch { /* noop */ }
        return dispose;
      });
      // 设置分节：通道 / 本机设置 / 同步面 / 目录清单 / 检查。
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-synchub-settings', order: 203, label: 'Msynchub' },
            SettingsSection));
      } catch { /* 宿主没有设置 slot 时优雅降级：主面板仍可用 */ }
      // 面板打开时主动拉一次，让红点在有数据前不至于空白。
      try { getJSON(`${API}/status`).then(s => bridge.publish(deriveAlerts(s))).catch(() => {}); } catch { /* noop */ }
    }

    module.exports = { name: 'dsh-synchub', inject, apply };
    return module.exports;
  },
});
