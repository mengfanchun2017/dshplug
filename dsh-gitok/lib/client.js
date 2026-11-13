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

    const inject = ['slots'];

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

    // ── 极简样式（只用主题变量，跟随亮/暗） ────────────────────────────────
    // 不引 UI 库，所以这里手写几个通用片段复用。
    const S = {
      wrap: { padding: '16px 18px', maxWidth: 760, fontFamily: 'inherit', fontSize: 13 },
      h: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      sub: { color: 'var(--dsh-text-secondary, #888)', margin: '0 0 16px', fontSize: 12 },
      card: {
        border: '1px solid var(--dsh-border, #e3e3e3)',
        borderRadius: 8,
        padding: '14px 16px',
        marginBottom: 12,
        background: 'var(--dsh-bg-elevated, transparent)',
      },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        padding: '5px 0',
        borderBottom: '1px dashed var(--dsh-border, #f0f0f0)',
        alignItems: 'baseline',
      },
      k: { color: 'var(--dsh-text-secondary, #777)', flex: '0 0 auto', minWidth: 96 },
      v: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        textAlign: 'right',
        wordBreak: 'break-all',
        flex: 1,
      },
      btn: {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, #ccc)',
        background: 'var(--dsh-bg-elevated, #fff)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      btnPrimary: {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'var(--dsh-accent, #2f6feb)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      badge: (level) => {
        const c =
          level === 'ok' ? '#1a7f37' : level === 'warn' ? '#9a6700' : level === 'error' ? '#cf222e' : '#666';
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
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        lineHeight: 1.55,
        background: 'var(--dsh-bg-code, rgba(127,127,127,.08))',
        border: '1px solid var(--dsh-border, #e3e3e3)',
        borderRadius: 6,
        padding: 12,
        overflow: 'auto',
        maxHeight: 320,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        margin: 0,
      },
      hint: {
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsh-text-secondary, #888)',
        margin: '8px 0 0',
      },
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
              StatusRows(st),
              CheckTable(st),
              ActionButtons({ st, busy, act }),
              // 必须用 createElement 而不是直接调用 WslGuide(st)：
              // 它内部有 useState，当普通函数调会报「Rendered more hooks than during the previous render」。
              react.createElement(WslGuide, { st }),
            ),

          err &&
            react.createElement(
              'p',
              { style: { ...S.hint, color: '#cf222e' } },
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
              { style: { ...S.hint, color: 'var(--dsh-accent, #2f6feb)', fontWeight: 500 } },
              action,
            ),
          actionMsg &&
            react.createElement(
              'div',
              { style: { marginTop: 10 } },
              react.createElement(
                'p',
                { style: { ...S.hint, margin: '0 0 6px', color: actionMsg.ok ? '#1a7f37' : '#cf222e', fontWeight: 500 } },
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
            react.createElement('code', { style: { fontSize: 11.5 } }, 'gitok_revoke'),
            '（需确认）精确删某一条。',
            react.createElement('br'),
            '换新账号：点上面的「重新检查」旁边让 AI 调 ',
            react.createElement('code', { style: { fontSize: 11.5 } }, 'gitok_login'),
            '，会弹浏览器走 GCM 登录，密钥由 GCM 直接写进凭据管理器。',
          ),
        ),
      );
    }

    // 状态行：抽出来避免主组件过长
    function StatusRows(st) {
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
    function CheckTable(st) {
      const checks = st && st.checks;
      if (!checks || !checks.length) return null;
      const mark = (lv) => (lv === 'ok' ? '✅' : lv === 'warn' ? '⚠️' : lv === 'error' ? '❌' : '❔');
      const color = (lv) =>
        lv === 'ok' ? '#1a7f37' : lv === 'warn' ? '#9a6700' : lv === 'error' ? '#cf222e' : '#666';

      return react.createElement(
        'div',
        { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dsh-border, #e3e3e3)' } },
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
              { style: { ...S.v, fontFamily: 'inherit', textAlign: 'left', color: 'var(--dsh-text-secondary, #777)' } },
              c.detail,
            ),
          ),
        ),
      );
    }

    // 受控写操作的按钮组。
    // “重新登录”只弹浏览器；“撤销”是破坏性的，必须 confirm。
    function ActionButtons({ st, busy, act }) {
      const hasCred = st && st.credTargets && st.credTargets.length > 0;
      const btn = (label, onClick, primary) =>
        react.createElement(
          'button',
          { style: primary ? S.btnPrimary : S.btn, disabled: busy, onClick },
          label,
        );

      return react.createElement(
        'div',
        { style: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' } },
        btn(hasCred ? '重新登录（换账号）' : '登录 GitHub', () => act('login'), true),
        btn('一键初始化', () => act('bootstrap'), false),
        hasCred &&
          react.createElement(
            'button',
            {
              style: { ...S.btn, color: '#cf222e', borderColor: '#cf222e55' },
              disabled: busy,
              onClick: () => act('logout'),
            },
            '撤销凭据',
          ),
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
              background: 'var(--dsh-bg-subtle, #f6f8fa)',
              border: '1px solid var(--dsh-border, #e3e3e3)',
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
        { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dsh-border, #e3e3e3)' } },
        react.createElement(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' },
            onClick: () => setOpen(!open),
          },
          react.createElement('span', { style: { fontWeight: 600 } }, 'WSL 里怎么用（决策 D）'),
          react.createElement('span', { style: { color: '#666', fontSize: 12 } }, open ? '收起 ▲' : '展开 ▼'),
        ),

        !open &&
          react.createElement(
            'div',
            { style: { marginTop: 6, fontSize: 12, color: 'var(--dsh-text-secondary, #777)' } },
            'WSL 不存密钥，每次由 Windows 凭据管理器代答。所以只需在 Windows 登录一次，所有发行版跟着变。',
          ),

        open &&
          react.createElement(
            'div',
            { style: { marginTop: 10 } },
            react.createElement(
              'div',
              { style: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsh-text-secondary, #666)' } },
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
                      { style: { ...S.k, minWidth: 110, color: e.adopted ? '#1a7f37' : '#9a6700', fontWeight: 500 } },
                      (e.adopted ? '✅ ' : '⚠️ ') + e.name,
                    ),
                    react.createElement(
                      'span',
                      { style: { ...S.v, fontFamily: 'inherit', textAlign: 'left', color: 'var(--dsh-text-secondary, #777)', fontSize: 12 } },
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
              { style: { marginTop: 12, padding: 10, background: '#fff8e6', border: '1px solid #f0d58c', borderRadius: 6, fontSize: 12, lineHeight: 1.7 } },
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


    // ── 插件入口 ──────────────────────────────────────────────────────────
    function apply(ctx) {
      // 必须用 ctx.locale.bind(NS)，不能写 const t = (s) => s：
      // 那样 locale 字典注册了也不会生效，导航栏永远拿不到翻译后的文字。
      // 这个坑 dsh-getbrain 里验证过（它的 1125 行同样写法）。
      ctx.effect(() =>
        ctx.locale.register(NS, {
          zh: { nav: 'Git 认证' },
          en: { nav: 'Git Auth' },
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

      // 自报一次，便于黑盒确认 slot 注册真的执行了（失败不影响界面）。
      try {
        fetch('/plugins/gitok/status', { credentials: 'same-origin' }).catch(() => {});
      } catch { /* noop */ }
    }

    module.exports = { name: 'dsh-gitok', inject, apply };
    return module.exports;
  },
});
