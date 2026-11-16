// dsh-gitok · 浏览器半（设置面板）
//
// 与 dsh-synchub / dsh-getbrain 同形态：window.__ModuleLoader__.load 包装 + Cordis 导出。
//
// 职责：在「设置」里注册一个顶层分区 **Git 认证**，让新手不用记 gitok_* 工具名，
// 点按钮就能看状态、做体检、重新登录。
//
// 数据通路：
//   面板 → GET /plugins/gitok/status（Host 侧路由，实际跑 pwsh 探测）
//   → 返回 { ok, status, report }
//   Client 半边拿不到 Host 工具与进程能力，所以必须走这条 HTTP 路由。
//
// 约束：不 import @deepseek-ai/dsh-client-ui-primitives（官方 UI 规则），
// 只用 react + 主题 CSS 变量手写控件。
window.__ModuleLoader__.load({
  id: 'dsh-gitok',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');
    const { useState, useEffect, useCallback, useRef } = react;

    // inject 必须列全 apply 里用到的服务：
    //   slots  —— 注册 settings.section / sidebar.panellist
    //   locale —— locale.register / locale.bind
    // 只写 ['slots'] 而实际访问 ctx.locale，会让 apply 直接抛
    // "Cannot read properties of undefined (reading 'register')"，
    // 整个浏览器半崩掉，界面不出现也不报错（极难排查）。
    const inject = ['slots', 'locale'];

    const API = '/plugins/gitok/status';
    const NS = 'gitok.settings';

    // ── 取数据 ────────────────────────────────────────────────────────────
    // Host 侧的探测要起 pwsh 子进程（~2-5s），超时给宽一点。
    // 但也不能太宽：界面转圈 45s 用户会以为卡死。
    const fetchStatus = async (refresh = false, timeout = 30000) => {
      const url = refresh ? `${API}?refresh=1` : API;
      const r = await fetch(url, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };

    // ── 触发受控写操作 ──────────────────────────────────────────────────────
    // 只发「意图」，请求体里永远没有 token（Host 侧也会拒收）。
    // 登录要弹浏览器、轮换要跑预检，所以给 5 分钟。
    const postAction = async (path, body = {}, timeout = 300000) => {
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d.text || '';
    };

    // ── 主题变量 ──────────────────────────────────────────────────────────
    // 【铁律】配色只能用 --dsw-alias-*。
    // 宿主里 175 个 --dsh-* 全是布局尺寸（--dsh-sidebar-width 这类），**一个配色都没有**；
    // 语义色全在 --dsw-alias-*（475 个）。写成 var(--dsh-bg-elevated, #fff) 时变量查不到，
    // 静默回退成硬编码 #fff —— 深色主题下就是「白底白字」，按钮文字直接看不见。
    // 这正是 v0.3.2「一键初始化」按钮看不清的原因（v0.3.3 修复）。
    const C = {
      fg: 'var(--dsw-alias-label-primary, #1f2328)',
      fg2: 'var(--dsw-alias-label-secondary, #59636e)',
      fg3: 'var(--dsw-alias-label-tertiary, #818b98)',
      // 卡片底：settings-card-fill 是设置页专用的那层，比 bg-layer-1 更贴合宿主
      card: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, transparent))',
      border: 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, rgba(128,128,128,.28)))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))',
      brand: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, var(--dsw-alias-brand-primary, #2f6feb))',
      ok: 'var(--dsw-alias-state-success-primary, #15803d)',
      warn: 'var(--dsw-alias-state-warn-primary, #b45309)',
      err: 'var(--dsw-alias-state-error-primary, #cf222e)',
      code: 'var(--dsw-alias-markdown-code-block, rgba(127,127,127,.10))',
      radius: 'var(--dsw-radius-md, 8px)',
    };

    // ── 极简样式（只用主题变量，跟随亮/暗） ────────────────────────────────
    // 不引 UI 库，所以这里手写几个通用片段复用。
    const S = {
      wrap: { padding: '16px 18px', maxWidth: 760, fontFamily: 'inherit', fontSize: 13, color: C.fg },
      h: { fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: C.fg },
      sub: { color: C.fg3, margin: '0 0 16px', fontSize: 12 },
      card: {
        border: `1px solid ${C.border}`,
        borderRadius: C.radius,
        padding: '14px 16px',
        marginBottom: 12,
        background: C.card,
      },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        padding: '5px 0',
        borderBottom: `1px solid ${C.borderSoft}`,
        alignItems: 'baseline',
      },
      k: { color: C.fg3, flex: '0 0 auto', minWidth: 96 },
      v: {
        fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 12,
        textAlign: 'right',
        wordBreak: 'break-all',
        flex: 1,
        color: C.fg2,
      },
      // 按钮三态统一走「透明底 + 边框」，与 dsh-synchub 一致。
      // 不要用实心白底：--dsh-bg-elevated 不存在会退成 #fff，深色主题下白底白字。
      btn: {
        font: 'inherit',
        fontSize: 13,
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.fg,
        cursor: 'pointer',
        transition: 'background .12s ease, border-color .12s ease',
      },
      // 主操作：由调用处控制实心/描边，这里只给主色描边版
      btnPrimary: {
        font: 'inherit',
        fontSize: 13,
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid transparent',
        background: C.brand,
        color: 'var(--dsw-alias-label-on-color, #fff)',
        cursor: 'pointer',
        transition: 'filter .12s ease',
      },
      btnDanger: {
        font: 'inherit',
        fontSize: 13,
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: `1px solid ${C.err}`,
        background: 'transparent',
        color: C.err,
        cursor: 'pointer',
        transition: 'background .12s ease',
      },
      badge: (level) => {
        const c =
          level === 'ok' ? C.ok : level === 'warn' ? C.warn : level === 'error' ? C.err : C.fg3;
        return {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 10px',
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 600,
          color: c,
          border: `1px solid ${c}40`,
          background: `${c}14`,
        };
      },
      pre: {
        fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 11.5,
        lineHeight: 1.55,
        background: C.code,
        border: `1px solid ${C.borderSoft}`,
        borderRadius: C.radius,
        padding: 12,
        overflow: 'auto',
        maxHeight: 320,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        margin: 0,
        color: C.fg2,
      },
      hint: {
        fontSize: 12,
        lineHeight: 1.6,
        color: C.fg3,
        margin: '8px 0 0',
      },
      // 内联代码
      inlineCode: {
        fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
        fontSize: '0.94em',
        background: C.code,
        border: `1px solid ${C.borderSoft}`,
        borderRadius: 4,
        padding: '1px 5px',
        wordBreak: 'break-all',
      },
      link: { color: C.brand, textDecoration: 'none', cursor: 'pointer' },
    };

    const Row = ({ k, v, mono = true }) =>
      react.createElement(
        'div',
        { style: S.row },
        react.createElement('span', { style: S.k }, k),
        react.createElement('span', { style: mono ? S.v : { ...S.v, fontFamily: 'inherit' } }, v),
      );

    const LEVEL_TEXT = { ok: '正常', warn: '待处理', error: '异常', unknown: '未知' };

    // ── 主面板组件 ────────────────────────────────────────────────────────
    function GitokSection() {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [err, setErr] = useState(null);
      const [showReport, setShowReport] = useState(false);
      // 写操作进行中时置为文案（如「等待 GCM 登录…」）；null 表示空闲。
      const [action, setAction] = useState(null);
      const [actionMsg, setActionMsg] = useState(null);
      // mounted 守卫：面板切走后异步回调不再 setState（React 会警告）
      const alive = useRef(true);

      const load = useCallback(async (refresh) => {
        setLoading(true);
        setErr(null);
        try {
          const d = await fetchStatus(refresh);
          if (!alive.current) return;
          if (d && d.ok) setData(d);
          else setErr((d && d.error) || '状态接口返回失败');
        } catch (e) {
          if (!alive.current) return;
          // 路由没挂上（Host 半未加载）与探测超时要分开说，否则新手不知道找谁
          const msg = String((e && e.message) || e);
          setErr(
            msg.includes('404') || msg.includes('Failed to fetch')
              ? '状态接口不可用：Host 半边可能未加载（需完全退出 DSH 再打开）'
              : msg,
          );
        } finally {
          if (alive.current) setLoading(false);
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        load(false);
        return () => {
          alive.current = false;
        };
      }, [load]);

      const st = data && data.status;
      const level = st ? st.level : err ? 'error' : 'unknown';
      const busy = action !== null;

      /**
       * 受控写操作的统一入口。
       * 破坏性操作（撤销 / 轮换）必须二次确认，且在置位前不改变界面上任何可见状态。
       */
      const act = async (kind) => {
        if (busy) return;
        if (kind === 'logout') {
          const yes = window.confirm(
            '确认从本机删除 github.com 的 git 凭据？\n\n删除后所有用 github 的仓库会重新要求登录（可以在本面板点「重新登录」恢复）。'
          );
          if (!yes) return;
          setAction('撤销中…');
          setActionMsg(null);
          try {
            const text = await postAction('/plugins/gitok/revoke', { host: 'github.com', confirm: true });
            setActionMsg({ ok: true, text: text.split('\n').slice(0, 14).join('\n') });
          } catch (e) {
            setActionMsg({ ok: false, text: String((e && e.message) || e) });
          } finally {
            setAction(null);
            load(true);
          }
          return;
        }
        const label = kind === 'login' ? '等待 GCM 登录…' : '初始化中…';
        setAction(label);
        setActionMsg(null);
        try {
          const path = kind === 'login' ? '/plugins/gitok/login' : '/plugins/gitok/bootstrap';
          const text = await postAction(path, kind === 'login' ? { host: 'github.com' } : {});
          setActionMsg({ ok: true, text: text.split('\n').slice(0, 20).join('\n') });
        } catch (e) {
          setActionMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          setAction(null);
          load(true);
        }
      };

      return react.createElement(
        'div',
        { style: S.wrap },

        react.createElement('h2', { style: S.h }, 'Git 认证'),
        react.createElement(
          'p',
          { style: S.sub },
          '统一管理本机的 git 凭据。密钥存在 Windows 凭据管理器里（DPAPI 加密，换台机器解不开），插件本身不保存任何密钥。',
        ),

        // ── 状态卡 ──
        react.createElement(
          'div',
          { style: S.card },
          react.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
            react.createElement('span', { style: S.badge(level) }, LEVEL_TEXT[level] || level),
            react.createElement(
              'span',
              { style: { fontSize: 13, fontWeight: 500 } },
              loading ? '正在检查…' : st ? st.summary : err || '未知',
            ),
          ),

          st &&
            react.createElement(
              'div',
              null,
              react.createElement(StatusRows, { st }),
              react.createElement(CheckTable, { st }),
              react.createElement(ActionButtons, { st, busy, act }),
              // 必须用 createElement 而不是直接调用 WslGuide(st)：
              // 它内部有 useState，当普通函数调会报「Rendered more hooks than during the previous render」。
              react.createElement(WslGuide, { st }),
            ),

          err &&
            react.createElement(
              'p',
              { style: { ...S.hint, color: C.err } },
              err,
            ),

          // 操作区
          react.createElement(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' } },
            react.createElement(
              'button',
              {
                style: S.btnPrimary,
                disabled: loading,
                onClick: () => load(true),
              },
              loading ? '检查中…' : '重新检查',
            ),
            data &&
              react.createElement(
                'button',
                {
                  style: S.btn,
                  onClick: () => setShowReport((v) => !v),
                },
                showReport ? '收起原始报告' : '查看原始报告',
              ),
          ),

          // 写操作的进行中提示 / 结果回显
          action &&
            react.createElement(
              'p',
              { style: { ...S.hint, color: C.brand, fontWeight: 500 } },
              action,
            ),
          actionMsg &&
            react.createElement(
              'div',
              { style: { marginTop: 10 } },
              react.createElement(
                'p',
                { style: { ...S.hint, margin: '0 0 6px', color: actionMsg.ok ? C.ok : C.err, fontWeight: 500 } },
                actionMsg.ok ? '✅ 完成' : '❌ 失败',
              ),
              react.createElement('pre', { style: S.pre }, actionMsg.text || '(无输出)'),
            ),
        ),

        // ── 原始报告 ──
        showReport &&
          data &&
          react.createElement(
            'div',
            { style: S.card },
            react.createElement('pre', { style: S.pre }, data.report || '(空)'),
          ),

        // ── 给新手的说明 ──
        react.createElement(
          'div',
          { style: S.card },
          react.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '这些信息在哪里管理'),
          react.createElement(
            'div',
            { style: S.hint },
            '凭据本体在「Windows 凭据管理器」里（控制面板 → 凭据管理器 → Windows 凭据，找 git:https://...）。',
            react.createElement('br'),
            '删除：可以在那里直接删，也可以在本会话里让 AI 调 ',
            react.createElement('code', { style: S.inlineCode }, 'gitok_revoke'),
            '（需确认）精确删某一条。',
            react.createElement('br'),
            '换新账号：点上面的「重新检查」旁边让 AI 调 ',
            react.createElement('code', { style: S.inlineCode }, 'gitok_login'),
            '，会弹浏览器走 GCM 登录，密钥由 GCM 直接写进凭据管理器。',
          ),
        ),
      );
    }

    // 状态行：抽出来避免主组件过长
    function StatusRows(props) {
      const st = props && props.st;
      const rows = [];
      const push = (k, v) => {
        if (v) rows.push(react.createElement(Row, { key: k, k, v }));
      };
      push('凭据后端', st.store);
      push('git helper', st.helper);
      push('仓库级 helper', st.scoped !== '(无)' ? st.scoped : '');
      push('代理', st.proxy || st.sysProxy || '(未配置)');
      push('SSH 密钥', st.sshKeys || '(无)');
      push('gh CLI', st.gh);
      push(
        '已存凭据',
        st.credTargets && st.credTargets.length ? `${st.credTargets.length} 条` : '尚无',
      );
      push('GCM 路径', st.gcmPath);
      return rows.length ? react.createElement('div', null, rows) : null;
    }

    // 六项持续监控的表格：每项四态（ok / warn / error / unknown）
    function CheckTable(props) {
      const st = props && props.st;
      const checks = st && st.checks;
      if (!checks || !checks.length) return null;
      const mark = (lv) => (lv === 'ok' ? '✅' : lv === 'warn' ? '⚠️' : lv === 'error' ? '❌' : '❔');
      const color = (lv) =>
        lv === 'ok' ? C.ok : lv === 'warn' ? C.warn : lv === 'error' ? C.err : C.fg3;

      return react.createElement(
        'div',
        { style: { marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` } },
        react.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '持续监控'),
        checks.map((c) =>
          react.createElement(
            'div',
            { key: c.id, style: { ...S.row, alignItems: 'flex-start' } },
            react.createElement(
              'span',
              { style: { ...S.k, minWidth: 110, color: color(c.level), fontWeight: 500 } },
              mark(c.level) + ' ' + c.label,
            ),
            react.createElement(
              'span',
              { style: { ...S.v, fontFamily: 'inherit', textAlign: 'left', color: C.fg3 } },
              c.detail,
            ),
          ),
        ),
      );
    }

    // 受控写操作的按钮组。
    //
    // 「一键初始化」原来和「重新登录」并排，看不出区别也看不出后果 —— 用户反馈
    // 「一键初始化 看不出来（白底白字）」。除了配色（v0.3.3 修），这里再补三件事：
    //   1. 每个按钮下面一行小字说明「它会做什么」，不让人靠猜；
    //   2. 三档视觉权重明确区分：主操作(实心) / 次要(描边) / 破坏性(红描边)；
    //   3. 悬停有反馈（内联样式写不了 :hover，用 onMouseEnter/Leave 切状态）。
    //
    // “重新登录”只弹浏览器；“撤销”是破坏性的，Host 侧还会再要一次确认。
    function Btn({ label, hint, onClick, kind = 'normal', disabled }) {
      const [hover, setHover] = useState(false);
      const base = kind === 'primary' ? S.btnPrimary : kind === 'danger' ? S.btnDanger : S.btn;
      const style = { ...base, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer' };
      if (hover && !disabled) {
        if (kind === 'primary') style.filter = 'brightness(1.08)';
        else if (kind === 'danger') style.background = 'var(--dsw-alias-interactive-bg-hover-danger, rgba(220,38,38,.10))';
        else style.background = C.hover;
      }

      const button = react.createElement(
        'button',
        {
          type: 'button',
          style,
          disabled,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        label,
      );

      if (!hint) return button;
      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 210 } },
        button,
        react.createElement('span', { style: { fontSize: 11.5, lineHeight: 1.45, color: C.fg3 } }, hint),
      );
    }

    function ActionButtons({ st, busy, act }) {
      const hasCred = st && st.credTargets && st.credTargets.length > 0;
      const e = react.createElement;

      return e(
        'div',
        { style: { display: 'flex', gap: 12, marginTop: 14, flexWrap: 'wrap', alignItems: 'flex-start' } },
        e(Btn, {
          key: 'login',
          label: hasCred ? '重新登录（换账号）' : '登录 GitHub',
          hint: hasCred ? '在浏览器里换一个 GitHub 账号' : '弹出 GitHub 授权页，用当前浏览器登录',
          kind: 'primary',
          disabled: busy,
          onClick: () => act('login'),
        }),
        e(Btn, {
          key: 'bootstrap',
          label: '一键初始化',
          hint: '体检 → 登录 → 验证，一步跑完；新机器首选',
          kind: 'normal',
          disabled: busy,
          onClick: () => act('bootstrap'),
        }),
        hasCred &&
          e(Btn, {
            key: 'logout',
            label: '撤销凭据',
            hint: '删掉本机存的 GitHub 凭据，需重新登录',
            kind: 'danger',
            disabled: busy,
            onClick: () => act('logout'),
          }),
      );
    }


    // ── WSL 接管说明 ────────────────────────────────────────────────────
    // 决策 D 的实现方式：WSL 不存密钥，git 需要凭据时 fork 调用 Windows 的 GCM，
    // 由 GCM 从 Windows 凭据管理器（DPAPI）取出后直接回给 git。
    // 这里把「原理 + 当前端点状态 + 可复制命令」放在面板里，
    // 因为 BOOTSTRAP.md 里的命令用户到了现场未必翻得开。
    function WslGuide(props) {
      // 注意：props 是对象（createElement 传的）。不要写成 WslGuide(st) 直接调用——
      // 那样内部 useState 会跨组件边界，报「Rendered more hooks than during the previous render」。
      const st = props && props.st;
      const [open, setOpen] = useState(false);
      const eps = (st && st.wslEndpoints) || [];
      const code = (s) =>
        react.createElement(
          'pre',
          {
            style: {
              margin: '6px 0 0',
              padding: '8px 10px',
              background: C.code,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.5,
              overflowX: 'auto',
              whiteSpace: 'pre',
            },
          },
          s,
        );

      // 命令里必须写真实的 GCM 路径；拿不到就退回占位符，并提示怎么找。
      const gcm = (st && st.gcmPath) || '<你的 GCM 路径>';
      const toWsl = (p) => p.replace(/^([A-Za-z]):\\/, (_, d) => '/mnt/' + d.toLowerCase() + '/').replace(/\\/g, '/');
      const gcmWsl = gcm.indexOf('<') === 0 ? gcm : toWsl(gcm);

      return react.createElement(
        'div',
        { style: { marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` } },
        react.createElement(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' },
            onClick: () => setOpen(!open),
          },
          react.createElement('span', { style: { fontWeight: 600 } }, 'WSL 里怎么用（决策 D）'),
          react.createElement('span', { style: { color: C.fg3, fontSize: 12 } }, open ? '收起 ▲' : '展开 ▼'),
        ),

        !open &&
          react.createElement(
            'div',
            { style: { marginTop: 6, fontSize: 12, color: C.fg3 } },
            'WSL 不存密钥，每次由 Windows 凭据管理器代答。所以只需在 Windows 登录一次，所有发行版跟着变。',
          ),

        open &&
          react.createElement(
            'div',
            { style: { marginTop: 10 } },
            react.createElement(
              'div',
              { style: { fontSize: 13, lineHeight: 1.7, color: C.fg3 } },
              'WSL 的 git 需要凭据时，会执行 ', 
              react.createElement('code', null, 'credential.https://<host>.helper'),
              ' 里那行命令。只要它指向 Windows 的 ', 
              react.createElement('code', null, 'git-credential-manager.exe'),
              '（经 ', 
              react.createElement('code', null, '/mnt/c/...'),
              ' 由 WSL interop 调用），凭据就从 Windows 凭据管理器（DPAPI）取出后直接回给 git。',
              react.createElement('br'),
              '结果：WSL 磁盘上零密钥；轮换时只在 Windows 重登一次。',
            ),

            // 当前端点的真实状态（有数据才显示）
            eps.length > 0 &&
              react.createElement(
                'div',
                { style: { marginTop: 10 } },
                react.createElement('div', { style: { fontWeight: 600, fontSize: 13 } }, '当前端点'),
                eps.map((e) =>
                  react.createElement(
                    'div',
                    { key: e.name, style: { ...S.row, alignItems: 'flex-start' } },
                    react.createElement(
                      'span',
                      { style: { ...S.k, minWidth: 110, color: e.adopted ? C.ok : C.warn, fontWeight: 500 } },
                      (e.adopted ? '✅ ' : '⚠️ ') + e.name,
                    ),
                    react.createElement(
                      'span',
                      { style: { ...S.v, fontFamily: 'inherit', textAlign: 'left', color: C.fg3, fontSize: 12 } },
                      e.adopted ? '已接管，借用 Windows 凭据' : '未接管：' + (e.helper || '无 helper'),
                    ),
                  ),
                ),
              ),

            react.createElement(
              'div',
              { style: { marginTop: 12, fontSize: 13, fontWeight: 600 } },
              '在 WSL 里执行（把 claude 换成发行版名）',
            ),
            code(
              'GCM=' + gcmWsl + '\n' +
              '\n' +
              '# ① 确认 interop 能执行到 GCM\n' +
              'test -x "$GCM" && echo OK || echo MISSING\n' +
              '\n' +
              '# ② 先备份，改坏了能退\n' +
              'cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S)\n' +
              '\n' +
              '# ③ 按 host 精确接管（不要动飞书那条 helper）\n' +
              'for h in github.com gist.github.com; do\n' +
              '  git config --global --unset-all "credential.https://$h.helper" 2>/dev/null || true\n' +
              '  git config --global --add "credential.https://$h.helper" "!$GCM"\n' +
              'done\n' +
              '\n' +
              '# ④ 复查：每个 host 应当只剩一条\n' +
              'git config --global --get-all "credential.https://github.com.helper"',
            ),

            react.createElement(
              'div',
              { style: { marginTop: 12, fontSize: 13, fontWeight: 600 } },
              '验证（必须看到 40 位 SHA）',
            ),
            code(
              '# 不要接管道！`| head` 会把超时伪装成 exit=0\n' +
              'cd ~/git/<某个仓库>\n' +
              'timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"',
            ),

            react.createElement(
              'div',
              { style: { marginTop: 12, fontSize: 13, fontWeight: 600 } },
              '验证通过后才删明文 PAT',
            ),
            code(
              'gh auth logout -h github.com 2>&1 || true\n' +
              'rm -f ~/.git-credentials\n' +
              '\n' +
              '# 删完立刻再验一次（此时完全依赖 interop）\n' +
              'cd ~/git/<某个仓库> && timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"',
            ),

            react.createElement(
              'div',
              { style: { marginTop: 12, padding: 10, background: 'var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,.10))', border: '1px solid var(--dsw-alias-state-warn-primary, #b45309)', borderRadius: C.radius, fontSize: 12, lineHeight: 1.7, color: C.fg } },
              react.createElement('strong', null, '顺序不能反：'),
              '先接管 → 验证通过 → 再删明文。反了会直接丢认证。',
              react.createElement('br'),
              react.createElement('strong', null, '网络先排查：'),
              'VPN 没开时任何 helper 都会超时（DNS 污染）。先跑 ',
              react.createElement('code', null, 'curl -sS -o /dev/null https://github.com'),
              '，它也慢就是网络问题，不是 GCM 坏了。',
            ),
          ),
      );
    }

    // ── 侧边栏入口图标 ────────────────────────────────────────────────────
    // 与 dsh-synchub 同形态：这里只画一个图标 + 状态小点，
    // **文字由插槽元数据的 label 渲染**，组件里再写名字会重复两遍。
    // 图标取「钥匙 + 取销」的语义：一把钥匙 = 凭据，横线 = 正在校验。
    function GitokIcon() {
      const [level, setLevel] = useState(null);

      useEffect(() => {
        let alive = true;
        // 只在挂载时探一次；不轮询，避免侧栏常驻刷 Host 子进程。
        fetchStatus(false, 8000)
          .then((d) => { if (alive && d && d.ok && d.status) setLevel(d.status.level); })
          .catch(() => { /* 拿不到就不显示小点，不能因此弄坏侧栏 */ });
        return () => { alive = false; };
      }, []);

      const bad = level === 'error';
      const warn = level === 'warn';
      const title = bad
        ? 'Mgitok：认证异常'
        : warn
          ? 'Mgitok：有需要处理的项'
          : level === 'ok'
            ? 'Mgitok：认证正常'
            : 'Mgitok';

      return react.createElement(
        'span',
        {
          title,
          'aria-label': title,
          style: { display: 'inline-flex', alignItems: 'center', position: 'relative' },
        },
        react.createElement(
          'svg',
          {
            width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.9,
            strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          // 钥匙头（圆环）
          react.createElement('circle', { cx: 8, cy: 9, r: 3.2 }),
          // 钥匙杆 + 齿
          react.createElement('path', { d: 'M10.4 11.4L19 20' }),
          react.createElement('path', { d: 'M15.5 16.5l2-2' }),
          react.createElement('path', { d: 'M17.5 18.5l2-2' }),
        ),
        // 小点放在图标**左上角**：右上角会跟宿主其他角标撞位置（synchub 踩过）。
        (bad || warn) && react.createElement('span', {
          style: {
            position: 'absolute', top: -1, left: -2,
            width: 5, height: 5, borderRadius: '50%',
            background: bad
              ? 'var(--dsw-alias-state-error-primary, #dc2626)'
              : 'var(--dsw-alias-state-warn-primary, #d97706)',
            boxShadow: `0 0 0 1.5px ${bad ? 'rgba(220,38,38,.22)' : 'rgba(217,119,6,.22)'}`,
            pointerEvents: 'none',
          },
        }),
      );
    }


    // ── 插件入口 ──────────────────────────────────────────────────────────
    function apply(ctx) {
      // 必须用 ctx.locale.bind(NS)，不能写 const t = (s) => s：
      // 那样 locale 字典注册了也不会生效，导航栏永远拿不到翻译后的文字。
      // 这个坑 dsh-getbrain 里验证过（它的 1125 行同样写法）。
      ctx.effect(() =>
        ctx.locale.register(NS, {
          // 显示名统一为「M + 技能名」，全小写（2026-11-16 约定）。
          // 品牌标识 M 是固定前缀；仓库目录仍为 dsh-gitok，两者不要混。
          // nav    = 设置分区 + 侧边栏条目的显示名
          // panelName 与 getbrain 保持同名键，方便两者对照维护
          zh: { nav: 'Mgitok', panelName: 'Mgitok' },
          en: { nav: 'Mgitok', panelName: 'Mgitok' },
        }),
        'gitok: settings dictionaries',
      );

      const t = ctx.locale.bind(NS)
      // 顶层设置分区。order 取 65：getbrain 是 60，synchub 是 470，
      // 放在 getbrain 之后、同步中心之前，符合「先配凭据，再配同步」的使用顺序。
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'gitok',
                order: 65,
                label: () => t('nav'),
                locale: NS,
              },
              GitokSection,
            ),
          ),
        'gitok: settings section',
      );

      // 侧边栏入口。order 取 465：synchub 是 460，排在它之后。
      // sidebar.panellist 必须与一个 main 面板同时注册：点图标后打开的
      // 就是这个 main（key 对应）。不注册 main 时图标点不动。
      // main 面板直接复用 GitokSection，与设置里那个是同一个组件。
      // main 面板：点侧栏图标后打开的就是它（key 与 sidebar 条目的 id 对应）。
      // 单独 inject('main') 而不是塞进 sidebar 的回调里：
      // 宿主没有 sidebar 插槽时，面板本体仍应能打开（getbrain/synchub 都是这个结构）。
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'gitok', id: 'gitok-main', locale: NS }, GitokSection),
          ),
        'gitok: main panel',
      );

      // 侧边栏入口图标。order 取 465：synchub 是 460，排在它之后。
      // label 用 panelName 键（与 getbrain 同名），文字由插槽渲染，组件里不要再写名字。
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'gitok', order: 465, label: () => t('panelName'), locale: NS },
              GitokIcon,
            ),
          ),
        'gitok: sidebar entry',
      );

      // 自报一次，便于黑盒确认 slot 注册真的执行了（失败不影响界面）。
      try {
        fetch('/plugins/gitok/status', { credentials: 'same-origin' }).catch(() => {});
      } catch { /* noop */ }
    }

    module.exports = { name: 'dsh-gitok', inject, apply };
    return module.exports;
  },
});
