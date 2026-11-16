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
    //   slots  —— 只注册 settings.section（刻意不做侧边栏，见 apply 末尾说明）
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

    // 每一项「到底在查什么、看不懂该怎么办」。
    // 用户反馈：「端到端通路 未配置 heartbeatUrl…这里是检查什么需要搞好么 看不懂要做什么」
    // → 光报状态不够，得说清「它想确认什么 / 不配有什么后果 / 怎么配」。
    const CHECK_HELP = {
      heartbeat: {
        what: '拿一个真实仓库试跑一次 git 拉取，确认「凭据 → 网络 → GitHub」整条链是通的。',
        why: '上面几项查的都是配置对不对；只有这一项能证明「真的能用」。不配也能用，只是没有这项保险。',
        how: '要测就在设置里把 heartbeatUrl 填成任意一个你有权限的仓库地址，例如 https://github.com/你的用户名/某个仓库.git。留空 = 跳过，不影响使用。',
      },
      plaintext: {
        what: '查有没有把 token / 密码以明文形式存在磁盘上（~/.git-credentials、gh 的 hosts.yml 等）。',
        why: '明文文件一旦被备份、上传或打进镜像，密钥就等于泄露了。',
        how: '发现明文就照面板里 WSL 区的顺序处理：先接管 → 验证通过 → 再删明文。',
      },
      sshkey: {
        what: '查 SSH 私钥是否存在、有没有设口令。',
        why: '空口令的私钥被人拿到文件就能直接用。',
        how: '用 ssh-keygen -p -f ~/.ssh/id_ed25519 加口令，或改用 GCM（本插件推荐的方式，不需要 SSH 密钥）。',
      },
      helper: {
        what: '查 git 的 credential.helper 有没有叠加配置（多个 helper 会互相抢答，行为难预测）。',
        why: '叠加时到底是哪个 helper 应答，取决于顺序，出问题极难排查。',
        how: '按 host 只保留一条。面板 WSL 区第③步就是按这个原则写的，可以照抄。',
      },
      creds: {
        what: '查 Windows 凭据管理器里有没有 git 的凭据条目、是什么类型。',
        why: '这是「已经登录过」的直接证据。',
        how: '没有就点上面的「登录 GitHub」；要删就点「撤销凭据」。',
      },
      deps: {
        what: '查 GCM 是否装好、git 版本、以及代理端口能不能连通。',
        why: '环境缺件时，后面所有步骤都会失败，先把这里弄绿。',
        how: '代理连不上通常是 VPN 没开；GCM 缺失要重装 Git for Windows（自带 GCM）。',
      },
    };

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
              react.createElement(WslGuide, { st, docsPath: data && data.docsPath }),
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
          react.createElement(CheckRow, { key: c.id, c, mark, color }),
        ),
      );
    }

    // 单行检查项。点行首的「?」展开说明 —— 用户看不懂这一项在查什么时，
    // 不用去翻文档，就地能读到「查什么 / 为什么 / 怎么办」。
    function CheckRow({ c, mark, color }) {
      const [open, setOpen] = useState(false);
      const help = CHECK_HELP[c.id];
      const e = react.createElement;

      return e(
        'div',
        { style: { borderBottom: `1px solid ${C.borderSoft}` } },
        e(
          'div',
          { style: { ...S.row, alignItems: 'flex-start', borderBottom: 'none', paddingBottom: open ? 2 : 5 } },
          e(
            'span',
            { style: { ...S.k, minWidth: 110, color: color(c.level), fontWeight: 500, display: 'inline-flex', gap: 5 } },
            mark(c.level) + ' ' + c.label,
            help &&
              e(
                'span',
                {
                  title: open ? '收起说明' : '这一项在查什么？点开看',
                  onClick: () => setOpen(!open),
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    border: `1px solid ${C.fg3}`,
                    color: C.fg3,
                    fontSize: 10,
                    lineHeight: 1,
                    cursor: 'pointer',
                    flex: '0 0 auto',
                    userSelect: 'none',
                  },
                },
                open ? '−' : '?',
              ),
          ),
          e(
            'span',
            { style: { ...S.v, fontFamily: 'inherit', textAlign: 'left', color: C.fg3 } },
            c.detail,
          ),
        ),
        open &&
          help &&
          e(
            'div',
            {
              style: {
                margin: '0 0 9px 0',
                padding: '8px 11px',
                background: C.code,
                border: `1px solid ${C.borderSoft}`,
                borderRadius: C.radius,
                fontSize: 12,
                lineHeight: 1.7,
                color: C.fg2,
              },
            },
            e('div', null, e('strong', { style: { color: C.fg } }, '查什么：'), help.what),
            e('div', { style: { marginTop: 4 } }, e('strong', { style: { color: C.fg } }, '为什么：'), help.why),
            e('div', { style: { marginTop: 4 } }, e('strong', { style: { color: C.fg } }, '怎么办：'), help.how),
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


    // ── 复制到剪贴板 ──────────────────────────────────────────────────────
    // 宿主支持 navigator.clipboard（已确认 app.asar 里有），失败时的回退必须
    // **明确告诉用户「文本只是被选中，没有进剪贴板」** —— 否则按一下没反应，
    // 会以为复制成功了。这个回退路径照抄 dsh-getbrain，它是踩过才写出来的。
    function useCopy() {
      const [state, setState] = useState(null); // null | 'ok' | 'manual' | 'fail'
      const copy = async (text, elId) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            throw new Error('no clipboard api');
          }
          setState('ok');
          setTimeout(() => setState(null), 2000);
        } catch {
          // 回退：选中目标区域，用户按 Ctrl+C
          let selected = false;
          try {
            const el = elId && document.getElementById(elId);
            if (el) {
              const sel = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(el);
              sel.removeAllRanges();
              sel.addRange(range);
              selected = true;
            }
          } catch { /* ignore */ }
          setState(selected ? 'manual' : 'fail');
          setTimeout(() => setState(null), 6000);
        }
      };
      return { copy, state };
    }

    // 一行「复制」按钮 + 状态反馈
    function CopyBtn({ text, elId, label = '复制', small }) {
      const { copy, state } = useCopy();
      const hint =
        state === 'ok' ? '已复制 ✓' : state === 'manual' ? '已选中，按 Ctrl+C' : state === 'fail' ? '复制失败，请手动选' : null;
      return react.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        react.createElement(
          'button',
          {
            type: 'button',
            onClick: () => copy(text, elId),
            style: {
              ...S.btn,
              padding: small ? '2px 9px' : '4px 12px',
              fontSize: small ? 11.5 : 12,
              background: state === 'ok' ? 'rgba(22,163,74,.12)' : 'transparent',
              borderColor: state === 'ok' ? C.ok : C.border,
              color: state === 'ok' ? C.ok : C.fg2,
            },
          },
          state === 'ok' ? '✓ 已复制' : label,
        ),
        hint &&
          react.createElement(
            'span',
            { style: { fontSize: 11.5, color: state === 'ok' ? C.ok : C.warn } },
            hint,
          ),
      );
    }

    // ── 代码块（带标题 + 复制） ────────────────────────────────────────────
    // 用 whiteSpace:'pre-wrap' + wordBreak:'break-word'，不要用 'pre' 配 overflowX。
    // 原来写 'pre' 就必然横向滚动条，命令一长右侧被裁，用户以为内容不全；
    // 而且 'pre' 会把面板源码里的缩进原样带出来，看着歪。
    function CodeBlock({ label, text, elId, hint }) {
      return react.createElement(
        'div',
        { style: { marginTop: 10 } },
        (label || text) &&
          react.createElement(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                justifyContent: 'space-between',
                marginBottom: 5,
              },
            },
            react.createElement(
              'span',
              { style: { fontSize: 12.5, fontWeight: 600, color: C.fg } },
              label || '',
            ),
            react.createElement(CopyBtn, { text, elId, small: true }),
          ),
        react.createElement(
          'pre',
          {
            id: elId,
            style: {
              margin: 0,
              padding: '9px 11px',
              background: C.code,
              border: `1px solid ${C.borderSoft}`,
              borderRadius: C.radius,
              fontSize: 11.5,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
              color: C.fg2,
            },
          },
          text,
        ),
        hint && react.createElement('div', { style: { fontSize: 11.5, color: C.fg3, marginTop: 4 } }, hint),
      );
    }


    // ── WSL 接入区 ────────────────────────────────────────────────────────
    // 决策 D 的实现方式：WSL 不存密钥，git 需要凭据时 fork 调用 Windows 的 GCM，
    // 由 GCM 从 Windows 凭据管理器（DPAPI）取出后直接回给 git。
    //
    // 用户反馈两轮迭代后的形态：
    //   v0.3.3：命令全堆在一个 <pre> 里 → 「点击看到好多命令，也不能复制」
    //   v0.3.4：拆成 4 个独立步骤，每步自带复制按钮；顶部给「复制文档路径」，
    //           用户直接把路径贴给 Claude，让 Claude 自己去读文档、自己装。
    //
    // 缩进问题：<pre> 里绝不能再有源码缩进。命令文本一律从行首写起（用数组 join），
    // 不要像以前那样写成 '  git config ...' —— 那是源码缩进，会原样显示出来。
    function WslGuide(props) {
      // 注意：props 是对象（createElement 传的）。不要写成 WslGuide(st) 直接调用——
      // 那样内部 useState 会跨组件边界，报「Rendered more hooks than during the previous render」。
      const st = props && props.st;
      const docsPath = (props && props.docsPath) || '';
      const [open, setOpen] = useState(false);
      const eps = (st && st.wslEndpoints) || [];
      const e = react.createElement;

      // 命令里必须写真实的 GCM 路径；拿不到就退回占位符，并提示怎么找。
      const gcm = (st && st.gcmPath) || '<你的 GCM 路径>';
      const toWsl = (p) =>
        p.replace(/^([A-Za-z]):\\/, (_, d) => '/mnt/' + d.toLowerCase() + '/').replace(/\\/g, '/');
      const gcmWsl = gcm.indexOf('<') === 0 ? gcm : toWsl(gcm);

      // 每一步一个字符串，行首零缩进 —— 直接就是用户要粘进终端的样子。
      const step1 =
        'test -x "' + gcmWsl + '" && echo OK || echo MISSING';
      const step2 =
        [
          'cp ~/.gitconfig ~/.gitconfig.bak.gitok-$(date +%Y%m%d%H%M%S)',
        ].join('\n');
      const step3 =
        [
          'for h in github.com gist.github.com; do',
          'git config --global --unset-all "credential.https://$h.helper" 2>/dev/null || true',
          'git config --global --add "credential.https://$h.helper" "!' + gcmWsl + '"',
          'done',
        ].join('\n');
      const step4 =
        [
          'timeout 40 git ls-remote origin HEAD; echo "REAL_EXIT=$?"',
        ].join('\n');
      const step5 =
        [
          'gh auth logout -h github.com 2>&1 || true',
          'rm -f ~/.git-credentials',
        ].join('\n');

      // 给 AI 的一句话：把文档路径交给 Claude，让它自己读自己配。
      const aiPrompt =
        '请阅读 ' + (docsPath || '<文档路径>') +
        ' ，按里面的「第二部分：粘给 AI 的指令」帮我配置 WSL 的 git 认证。' +
        '每一步的命令和真实输出都要贴给我。';

      const stepTitle = (n, title) =>
        e(
          'div',
          { style: { fontSize: 12.5, fontWeight: 600, marginTop: 12, marginBottom: 2, color: C.fg } },
          n + '  ' + title,
        );

      return e(
        'div',
        { style: { marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` } },

        // 折叠头
        e(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' },
            onClick: () => setOpen(!open),
          },
          e('span', { style: { fontWeight: 600 } }, 'WSL 里怎么用'),
          e('span', { style: { color: C.fg3, fontSize: 12 } }, open ? '收起 ▲' : '展开看步骤 ▼'),
        ),

        // 折叠时的摘要（把结论先说清楚）
        !open &&
          e(
            'div',
            { style: { marginTop: 6, fontSize: 12, color: C.fg3, lineHeight: 1.65 } },
            'WSL 不存密钥，每次由 Windows 凭据管理器代答。在 Windows 登录一次，所有发行版跟着变。',
          ),

        open &&
          e(
            'div',
            { style: { marginTop: 10 } },

            // ── 最快的路：把路径丢给 AI ──
            e(
              'div',
              {
                style: {
                  padding: 11,
                  background: 'var(--dsw-alias-state-success-tertiary, rgba(22,163,74,.08))',
                  border: '1px solid var(--dsw-alias-state-success-primary, #16a34a)',
                  borderRadius: C.radius,
                  marginBottom: 4,
                },
              },
              e('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 5, color: C.fg } },
                '最省事：把下面这段话直接发给 Claude'),
              e('div', { style: { fontSize: 12, color: C.fg2, lineHeight: 1.7, marginBottom: 6 } },
                '它会自己读文档、探测环境、配好并验证。你只需要把输出贴回来核对。'),
              e(CodeBlock, {
                label: '',
                text: aiPrompt,
                elId: 'gitok-ai-prompt',
                hint: docsPath ? null : '（文档路径没拿到，先点上面的「重新检查」）',
              }),
            ),

            // ── 文档绝对路径 ──
            e(
              'div',
              { style: { marginTop: 10 } },
              e('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 2, color: C.fg } },
                '文档绝对路径'),
              e(CodeBlock, {
                label: '',
                text: docsPath || '(未获取，点上面「重新检查」)',
                elId: 'gitok-docs-path',
                hint: 'WSL 里也能读：把 C:\\ 换成 /mnt/c/，反斜杠改正斜杠。',
              }),
            ),

            // ── 手工步骤 ──
            e('div', { style: { fontSize: 13, fontWeight: 600, marginTop: 16, marginBottom: 2 } },
              '想自己动手？五步，每步都能单独复制'),
            e('div', { style: { fontSize: 12, color: C.fg3, lineHeight: 1.7 } },
              '「claude」是发行版名，换成你自己的（', e('code', { style: S.inlineCode }, 'wsl -l -v'), ' 可查）。'),

            stepTitle('①', '确认 WSL 能执行到 Windows 的 GCM'),
            e(CodeBlock, {
              text: step1,
              elId: 'gitok-wsl-1',
              hint: '必须回 OK。回 MISSING 说明 /mnt/c 没挂或 interop 被关，先解决这个。',
            }),

            stepTitle('②', '备份现有配置'),
            e(CodeBlock, { text: step2, elId: 'gitok-wsl-2', hint: '改坏了能退，文件名带时间戳。' }),

            stepTitle('③', '按 host 精确接管'),
            e(CodeBlock, {
              text: step3,
              elId: 'gitok-wsl-3',
              hint: '只动 github.com 和 gist，不碰飞书等其他 helper。',
            }),

            stepTitle('④', '验证（必须看到 40 位 SHA）'),
            e(CodeBlock, {
              text: step4,
              elId: 'gitok-wsl-4',
              hint: '在任意一个 git 仓库里跑。别接管道——`| head` 会把超时伪装成成功。',
            }),

            stepTitle('⑤', '验证通过后才删明文'),
            e(CodeBlock, {
              text: step5,
              elId: 'gitok-wsl-5',
              hint: '顺序不能反！先删后接会直接丢认证。删完再跑一次第④步确认。',
            }),

            // ── 当前端点状态 ──
            eps.length > 0 &&
              e(
                'div',
                { style: { marginTop: 14 } },
                e('div', { style: { fontWeight: 600, fontSize: 12.5, marginBottom: 4 } }, '当前端点'),
                eps.map((ep) =>
                  e(
                    'div',
                    { key: ep.name, style: { ...S.row, alignItems: 'flex-start' } },
                    e(
                      'span',
                      { style: { ...S.k, minWidth: 110, color: ep.adopted ? C.ok : C.warn, fontWeight: 500 } },
                      (ep.adopted ? '✅ ' : '⚠️ ') + ep.name,
                    ),
                    e(
                      'span',
                      { style: { ...S.v, fontFamily: 'inherit', textAlign: 'left', color: C.fg3, fontSize: 12 } },
                      ep.adopted ? '已接管，借用 Windows 凭据' : '未接管：' + (ep.helper || '无 helper'),
                    ),
                  ),
                ),
              ),

            // ── 两个必须知道的坑 ──
            e(
              'div',
              {
                style: {
                  marginTop: 14,
                  padding: 10,
                  background: 'var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,.10))',
                  border: '1px solid var(--dsw-alias-state-warn-primary, #b45309)',
                  borderRadius: C.radius,
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: C.fg,
                },
              },
              e('strong', null, '顺序不能反：'),
              '先接管 → 验证通过 → 再删明文。反了会直接丢认证。',
              e('br'),
              e('strong', null, '网络先排查：'),
              'VPN 没开时任何 helper 都会超时。先跑 ',
              e('code', { style: S.inlineCode }, 'curl -sS -o /dev/null https://github.com'),
              '，它也慢就是网络问题，不是 GCM 坏了。',
            ),
          ),
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
          // nav = 设置分区的显示名。
          // 不需要 panelName：那是给侧边栏用的，本插件不注册 sidebar.panellist。
          zh: { nav: 'Mgitok' },
          en: { nav: 'Mgitok' },
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


      // ⚠ 刻意【不】注册 sidebar.panellist 与 main：
      // gitok 的功能全部在设置面板里，侧边栏只是同一组件的第二个入口，
      // 两处并存等于重复（用户 2026-11-16：「gitok 在设置就看就可以了 不用侧边栏」）。
      // 这样 sideBar 少一个图标，也少一次无谓的状态探测。
      // 若日后要恢复：重新注册 sidebar.panellist（icon 组件需一并恢复）+ main（key 对应）。

      // 自报一次，便于黑盒确认 slot 注册真的执行了（失败不影响界面）。
      try {
        fetch('/plugins/gitok/status', { credentials: 'same-origin' }).catch(() => {});
      } catch { /* noop */ }
    }

    module.exports = { name: 'dsh-gitok', inject, apply };
    return module.exports;
  },
});
