// dsh-larkcli · 浏览器半（设置面板）
//
// 与 dsh-gitok / dsh-synchub / dsh-getbrain 同形态：
//   window.__ModuleLoader__.load({ id, factory }) 包装 + Cordis apply(ctx) 导出。
//
// 职责：在「设置」里注册一个顶层分区 **飞书**，让人不记工具名也能：
//   看每个账户的 bot/user 授权状态、改描述与标签（这直接决定 lark_account_search 的质量）、
//   切默认账户、发起设备流授权（拿链接）、刷新状态。
//
// 数据通路：面板 → GET /plugins/larkcli/status（Host 路由，实际跑 lark-cli）
//         写操作 → POST /plugins/larkcli/{account,default,login-start}
// Client 半边拿不到 Host 工具与进程能力，所以必须走 HTTP。
//
// 约束：不 import @deepseek-ai/dsh-client-ui-primitives，只用 react + 主题 CSS 变量手写控件。
window.__ModuleLoader__.load({
  id: 'dsh-larkcli',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');
    const { useState, useEffect, useCallback, useRef } = react;

    // 铁律：apply 里每出现一次 ctx.xxx，这里就要列一个 xxx。
    // 漏列 = Cordis 给 undefined = apply 首行抛错 = 整个浏览器半不注册，
    // 且**控制台干净、设置里就是什么都没有**（本插件 0.2.0 实际踩过：
    // 用了 ctx.locale 却只写 ['slots']，设置面板一直不出现）。
    const inject = ['slots', 'locale'];

    const API = '/plugins/larkcli/status';
    const NS = 'larkcli.settings';

    // ── 数据 ────────────────────────────────────────────────────────
    // Host 侧要真起 lark-cli 子进程（每账户一次 ~300ms），超时给宽一点。
    /*
     * 404 在宿主半刚更新、还没重启时是**正常现象**：新路由要宿主重新加载才存在。
     * 不包这层的话，用户看到的就是“HTTP 404”六个字，无从下手。
     */
    const httpError = (r, path) =>
      r.status === 404
        ? new Error(
            `接口 ${path} 不存在（HTTP 404）—— 通常是宿主半刚更新但还没重启 DSH。\n` +
              '完全退出 DSH 再打开（只刷页面无效，路由是宿主启动时注册的）。',
          )
        : new Error(`HTTP ${r.status}（${path}）`);

    const fetchStatus = async (refresh = false, timeout = 30000) => {
      const url = refresh ? `${API}?refresh=1` : API;
      const r = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw httpError(r, API);
      return r.json();
    };

    // 只发「意图」，请求体里永远没有 secret（Host 侧也会拒收这类字段）。
    const postAction = async (path, body = {}, timeout = 120000) => {
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw d.error ? new Error(d.error) : httpError(r, path);
      return d;
    };

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 铁律：颜色只用 `--dsw-alias-*`（语义色），`--dsh-*` 里全是布局尺寸、**没有任何颜色**。
    // v0.1.0 写过 `var(--dsh-bg-elevated, #fff)`：变量名不存在 → 静默取 fallback #fff
    // → 深色主题下「白底 + color:inherit」= 白底白字，按钮整个看不见。
    // 所以这里不写任何颜色 fallback：查不到就是不生效，砰一眼能发现，而不是默默错。
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l2)',
      borderSoft: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    };

    const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    const S = {
      wrap: { padding: '16px 18px', maxWidth: 860, fontFamily: 'inherit', fontSize: 13, color: C.text },
      h: { fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: C.text },
      sub: { color: C.dim, margin: '0 0 16px', fontSize: 12, lineHeight: 1.7 },
      card: {
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: '14px 16px',
        marginBottom: 12,
        background: C.layer,
      },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        padding: '5px 0',
        borderBottom: `1px dashed ${C.borderSoft}`,
        alignItems: 'baseline',
      },
      k: { color: C.dim, flex: '0 0 auto', minWidth: 96 },
      v: { fontFamily: mono, fontSize: 12, textAlign: 'right', wordBreak: 'break-all', flex: 1 },
      btn: {
        padding: '5px 12px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.layer2,
        color: C.text,
        cursor: 'pointer',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      btnPrimary: {
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: C.brand,
        // 品牌色上固定用白字：这是唯一不跟随主题的地方，因为背景已是深色品牌色
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      btnLink: {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: C.brand,
        cursor: 'pointer',
        fontSize: 12,
        fontFamily: 'inherit',
        textDecoration: 'underline',
      },
      input: {
        padding: '5px 8px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.layer2,
        color: C.text,
        fontSize: 12,
        fontFamily: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      },
      // 徽标：颜色用语义 token，背景用同色低透明 —— 不再硬编码绿/黄 hex
      badge: (kind) => {
        const col = kind === 'ok' || kind === true ? C.ok : kind === 'err' ? C.err : kind === 'warn' || kind === false ? C.warn : C.dim;
        return {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '1px 8px',
          borderRadius: 999,
          fontSize: 11.5,
          fontWeight: 600,
          color: col,
          border: `1px solid ${col}`,
          opacity: 0.95,
        };
      },
      pre: {
        fontFamily: mono,
        fontSize: 11.5,
        lineHeight: 1.55,
        background: C.layer2,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: 10,
        overflow: 'auto',
        maxHeight: 260,
        // pre-wrap + break-word：pre 会横向流、右侧被裁；命令必须能看全
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: '8px 0 0',
        color: C.text,
      },
      hint: { fontSize: 12, lineHeight: 1.7, color: C.dim, margin: '8px 0 0' },
      tag: {
        display: 'inline-block',
        padding: '1px 7px',
        margin: '0 4px 4px 0',
        borderRadius: 999,
        fontSize: 11,
        background: C.layer2,
        color: C.dim,
      },
      avatar: { width: 28, height: 28, borderRadius: 6, objectFit: 'cover', background: C.layer2, flex: '0 0 auto' },
      avatarFallback: {
        width: 28, height: 28, borderRadius: 6, background: C.layer2, color: C.dim,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 600, flex: '0 0 auto',
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 8 },
      meter: { height: 4, borderRadius: 2, background: C.layer2, overflow: 'hidden', marginTop: 4 },
    };

    const Row = ({ k, v, mono = true }) =>
      react.createElement(
        'div',
        { style: S.row },
        react.createElement('span', { style: S.k }, k),
        react.createElement('span', { style: mono ? S.v : { ...S.v, fontFamily: 'inherit' } }, v),
      );

    // ── 权限清单 ─────────────────────────────────────────────────────────────
    /*
     * 用户的目标原话：接入申请时权限要「清晰全面，直接弹出只用点确认」。
     * 所以这里做三件事：
     *   1. 默认选「只读」档位（最省事且够查文档）—— 一上来拉 145 条会把人吓跑；
     *   2. 应用侧缺口给一条**预填好的**开放平台链接，打开就能点「确认」；
     *   3. 用户侧缺口给一条可直接复制的命令（含 domains），不用手拼。
     */
    function ScopePanel({ accountId }) {
      const [profile, setProfile] = useState('read');
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = useCallback(
        async (p) => {
          setBusy(true);
          setErr(null);
          try {
            const qs = '?profile=' + encodeURIComponent(p) + '&account=' + encodeURIComponent(accountId);
            const r = await fetch('/plugins/larkcli/scopes' + qs, {
              credentials: 'same-origin',
              signal: AbortSignal.timeout(120000),
            });
            const d = await r.json();
            if (!alive.current) return;
            if (!d.ok) throw d.error ? new Error(d.error) : httpError(r, r.url || '?');
            setData((d.accounts || [])[0] || null);
          } catch (e) {
            if (alive.current) setErr(String((e && e.message) || e));
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [accountId],
      );

      useEffect(() => {
        load(profile);
      }, [load, profile]);

      const acc = data || {};

      return react.createElement(
        'div',
        { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + C.borderSoft } },
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          react.createElement('span', { style: { ...S.hint, margin: 0, fontWeight: 600 } }, '要申请的权限范围：'),
          [['read', '只读（推荐）'], ['standard', '标准'], ['full', '全部']].map(([k, label]) =>
            react.createElement(
              'button',
              {
                key: k,
                style: profile === k ? S.btnPrimary : S.btn,
                disabled: busy,
                onClick: () => setProfile(k),
              },
              label,
            ),
          ),
        ),
        busy ? react.createElement('p', { style: { ...S.hint, color: C.brand } }, '正在比对权限…') : null,
        err ? react.createElement('p', { style: { ...S.hint, color: C.err } }, err) : null,
        acc.error ? react.createElement('p', { style: { ...S.hint, color: C.err } }, acc.error) : null,

        data && !busy
          ? react.createElement(
              'div',
              null,
              (acc.groups || []).map((g) =>
                react.createElement(
                  'div',
                  { key: g.domain, style: { marginTop: 8 } },
                  react.createElement(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                    react.createElement('strong', { style: { fontSize: 12 } }, g.label),
                    react.createElement(
                      'span',
                      { style: { ...S.hint, margin: 0 } },
                      g.rows.length + ' 条' +
                        (g.missingTenant ? '｜应用缺 ' + g.missingTenant : '') +
                        (g.missingUser ? '｜用户缺 ' + g.missingUser : '') +
                        (!g.missingTenant && !g.missingUser ? '｜✅ 已齐' : ''),
                    ),
                  ),
                  // 只展开「有缺口」的明细：全列出来会把面板刷成一堵墙
                  g.missingTenant || g.missingUser
                    ? react.createElement(
                        'div',
                        { style: { ...S.hint, margin: '2px 0 0', fontFamily: mono, fontSize: 11 } },
                        g.rows.filter((r) => (r.needsTenant && !r.appGranted) || (r.needsUser && !r.userGranted))
                          .map((r) =>
                            (r.needsTenant && !r.appGranted ? '应用缺 ' : '用户缺 ') + r.scope +
                            (r.description ? '（' + r.description + '）' : ''),
                          )
                          .join('\n'),
                      )
                    : null,
                ),
              ),

              // 应用侧缺口：一键申请链接
              acc.applyUrl
                ? react.createElement(
                    'div',
                    { style: { marginTop: 12 } },
                    react.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 2 } },
                      '应用侧缺 ' + (acc.tenantMissing || []).length + ' 条 —— 点这条链接，权限已勾好，按「确认」即可'),
                    react.createElement('button', {
                      style: S.btnPrimary,
                      onClick: () => window.open(acc.applyUrl, '_blank', 'noopener'),
                    }, '打开权限申请页'),
                    react.createElement(Copyable, { text: acc.applyUrl, id: 'scopes-' + accountId }),
                    react.createElement('p', { style: { ...S.hint, margin: '4px 0 0' } },
                      '申请后还要在开放平台「创建版本并发布」，租户级权限才真正生效。'),
                  )
                : react.createElement('p', { style: { ...S.hint, color: C.ok } },
                    '✅ 应用侧权限已齐（该档位）。'),

              // 用户侧缺口：一条可直接跑的命令
              acc.userMissingCount
                ? react.createElement(
                    'div',
                    { style: { marginTop: 10 } },
                    react.createElement('div', { style: { fontWeight: 600, fontSize: 12, marginBottom: 2 } },
                      '用户侧缺 ' + acc.userMissingCount + ' 条（仅 user 身份需要，bot 不受影响）'),
                    react.createElement(Copyable, {
                      id: 'login-' + accountId,
                      text: 'lark_login_start account="' + accountId + '" domains=["docs","drive","sheets","base","wiki","contact"]',
                    }),
                  )
                : react.createElement('p', { style: { ...S.hint, color: C.ok } },
                    '✅ 用户侧权限已齐。'),
            )
          : null,
      );
    }

    // ── 单个账户卡片 ─────────────────────────────────────────────────────────
    function AccountCard({ acc, onChanged, alive }) {
      const [editing, setEditing] = useState(false);
      const [label, setLabel] = useState(acc.label || '');
      const [desc, setDesc] = useState(acc.description || '');
      const [tags, setTags] = useState((acc.tags || []).join(', '));
      const [busy, setBusy] = useState(null);
      const [msg, setMsg] = useState(null);
      const [ident, setIdent] = useState(null);
      const [showScopes, setShowScopes] = useState(false);

      useEffect(() => {
        setLabel(acc.label || '');
        setDesc(acc.description || '');
        setTags((acc.tags || []).join(', '));
      }, [acc.id, acc.label, acc.description, acc.tags]);

      const save = async () => {
        setBusy('保存中…');
        setMsg(null);
        try {
          await postAction('/plugins/larkcli/account', {
            id: acc.id,
            label,
            description: desc,
            tags: tags
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            appId: acc.appId,
            brand: acc.brand,
          });
          if (!alive.current) return;
          setEditing(false);
          setMsg({ ok: true, text: '已保存。描述与标签会立刻影响按任务搜索账户的结果。' });
          onChanged();
        } catch (e) {
          if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          if (alive.current) setBusy(null);
        }
      };

      const makeDefault = async () => {
        setBusy('切换中…');
        setMsg(null);
        try {
          await postAction('/plugins/larkcli/default', { id: acc.id });
          if (!alive.current) return;
          setMsg({ ok: true, text: `已把 ${acc.id} 设为默认账户。` });
          onChanged();
        } catch (e) {
          if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          if (alive.current) setBusy(null);
        }
      };

      const [authUrl, setAuthUrl] = useState(null);

      const login = async () => {
        setBusy('正在获取授权链接…');
        setMsg(null);
        try {
          /*
           * 默认一次要够：--domain all。
           * 用户原话「机器人的和用户的授权如果都需要你就一次都开开」。
           * bot 侧靠开发者后台的 scope，user 侧靠这次 login 拿到的授权；
           * 两边都要的权限，一次 --domain all 就把 user 侧全申请了，不用分几次点。
           */
          const d = await postAction('/plugins/larkcli/login-start', { account: acc.id, domains: 'all' });
          if (!alive.current) return;
          /*
           * 目标④「尽量零点击」：链接不能只是一段文本。
           * 但也不自动开窗 —— 弹窗需要用户手势，setTimeout 里 window.open 会被拦。
           * 所以把三条路都摆出来：直接点开 / 复制 / 手机扫码。
           */
          setAuthUrl({
            url: d.verificationUrl || '',
            expiresIn: d.expiresIn || 600,
            requestedAt: Date.now(),
          });
          setMsg({
            ok: true,
            text:
              `已发起授权（${Math.round((d.expiresIn || 600) / 60)} 分钟内有效），本次一次性申请全部业务域权限。\n` +
              '重要：请先在浏览器里登录到「你想授权的那个飞书账号」，再点「打开授权页」——授权是发给当前浏览器里登着的那个人的。\n' +
              '授权完成后本面板会自动检测并刷新（也可随时点「刷新状态」）。',
          });
        } catch (e) {
          if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          if (alive.current) setBusy(null);
        }
      };

      /*
       * 授权后的自动刷新。
       * 用户原话：「我点击了 user 身份授权，到网页授权完成了，但是这里没有刷新，还是 user 未授权状态」。
       * 原因：面板只在点按钮时拉一次，浏览器里点头意之后没有任何人通知它。
       * 而且真实完成要靠 login-finish（用 device_code 兑换）—— 光点头意不兑换，
       * CLI 侧依旧认为 user 是 missing。所以「自动刷新」不只是刷新显示，
       * 而是**主动去兑换并刷新显示**，否则用户等到天荒地老也不会变。
       *
       * 策略：发起授权后每 4s 试一次 login-finish（它是长轮询，只会快返回不阻塞），
       * 拿到 ok 就停轮询、自动拉身份、通知父级刷新；10 分钟后放弃。
       */
      useEffect(() => {
        if (!authUrl || !authUrl.url) return undefined;
        let stopped = false;
        let timer = null;
        let tries = 0;
        const deadline = (authUrl.requestedAt || Date.now()) + 10 * 60 * 1000;

        const tick = async () => {
          if (stopped || !alive.current) return;
          if (Date.now() > deadline) {
            setMsg({ ok: false, text: '授权链接已过期（10 分钟）。请重新点「授权 user 身份」拿一条新的。' });
            setAuthUrl(null);
            setBusy(null);
            return;
          }
          tries += 1;
          /*
           * 间隔要**自适应**，不能写死 4s。
           * 因为 timeoutMs 是 0.2.2 新增的宿主参数：如果宿主半还是旧版（没重启），
           * 它会忽略这个字段、按默认 30s 长轮询，一个请求真的就占 30s。
           * 写死 4s 排程会让请求不断堆积（同时多个 device_code 兑换在跑）。
           * 所以：下一轮的延迟 = max(4s, 本轮实际耗时)，天然适配新旧两种宿主。
           */
          const startedAt = Date.now();
          try {
            /*
             * timeoutMs=5000：让长轮询变成“快问快答”。
             * 不传就是 30s，自动轮询会变成 34s 一轮、用户在 “正在检查” 里干等。
             * 超时不会作废 device_code（service 只在 ok 时删 pending），所以短超时安全。
             */
            const d = await postAction('/plugins/larkcli/login-finish', { account: acc.id, timeoutMs: 5000 });
            if (stopped || !alive.current) return;
            if (d && d.ok) {
              setMsg({ ok: true, text: '授权完成，user 身份已可用（状态已自动刷新）。' });
              setAuthUrl(null);
              setBusy(null);
              await loadIdentity(false);
              if (onChanged) onChanged();
              return;
            }
            // 还没确认：keep polling，但把“正在等”告诉用户，别让人以为卡死
            setBusy(`等待你在浏览器/手机上确认…（已检查 ${tries} 次）`);
          } catch (e) {
            /*
             * 两类失败要分开处理：
             *   - “链接已过期” = 确定性失败，再轮询一万次也不会变 → 停掉并让用户重新发起；
             *   - 其他（网络抖动/子进程偶尔挂）= 继续轮询。
             * 不区分就会变成：明明已经过期，面板还永远转着“等待确认”。
             */
            const msg = String((e && e.message) || e)
            if (/过期|expired/i.test(msg)) {
              setMsg({ ok: false, text: msg })
              setBusy(null)
              setAuthUrl(null)
              return
            }
          }
          if (stopped) return;
          const cost = Date.now() - startedAt;
          timer = setTimeout(tick, Math.max(4000, cost));
        };

        timer = setTimeout(tick, 3000);
        return () => {
          stopped = true;
          if (timer) clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [authUrl && authUrl.url, acc.id]);


      /*
       * 身份信息是**按需拉**的（opt-in）：describeAccount 要跑 2-3 次 API（bot info、application v6、
       * 还可能拉一次通讯录），每个账户都自动拉会让面板首帧多等 1-2 秒。
       * 所以默认不拉，点「看应用信息」才拉。
       */
      /*
       * verify=true 才向服务端验 token（每账户 +1.1s）。
       * 默认不验：面板首帧必须快，而且不验时我们只敢说“存在”，不会假装健康。
       */
      const loadIdentity = async (verify) => {
        setBusy(verify ? '正在向服务端验证 token…' : '正在读取应用与授权信息…');
        setMsg(null);
        try {
          const qs = 'account=' + encodeURIComponent(acc.id) + (verify ? '&verify=1' : '');
          const r = await fetch('/plugins/larkcli/identity?' + qs, {
            credentials: 'same-origin',
            signal: AbortSignal.timeout(60000),
          });
          const d = await r.json();
          if (!alive.current) return;
          if (!d.ok) throw d.error ? new Error(d.error) : httpError(r, r.url || '?');
          setIdent((d.accounts || [])[0] || null);
        } catch (e) {
          if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          if (alive.current) setBusy(null);
        }
      };

      return react.createElement(
        'div',
        { style: { ...S.card, marginBottom: 10 } },
        /*
         * 标题区：第一行大字 = 显示名，第二行小字 = 技术 id。
         * 用户原话：「上面写的 default 是说 default 用户么，我没有看到有改名字的地方」。
         * 原先是直接写 acc.id（= 'default'）当标题，而“显示名”藏在「编辑描述/标签」里，
         * 用户根本不会想到去那里改名。现在：
         *   - 第一行大字 = 显示名（label），没设则回退到 id；
         *   - 第二行小字 = id + appId，技术上认人用，但不抢占视觉；
         *   - “默认”只是个徒标，表达“不指定时用哪个”，不是用户名。
         */
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 } },
          react.createElement('strong', { style: { fontSize: 14 } }, acc.label || acc.id),
          acc.isDefault ? react.createElement('span', { style: S.badge(true) }, '默认') : null,
          react.createElement('span', { style: S.badge(!!acc.bot) }, acc.bot ? 'bot 可用' : 'bot 不可用'),
          react.createElement('span', { style: S.badge(!!acc.user) }, acc.user ? 'user 已授权' : 'user 未授权'),
          acc.hasSecret ? null : react.createElement('span', { style: S.badge(false) }, '缺 secret'),
        ),
        react.createElement(
          'div',
          { style: { ...S.hint, margin: '0 0 8px', fontFamily: mono } },
          'id ' + acc.id + (acc.appId ? '  ·  ' + acc.appId : ''),
        ),

        /*
         * 身份块。用户原话是「信息展示包括接入的飞书 app，用户名等详细内容」。
         * 未拉之前显示按钮而不显示占位行 —— 一屏「未知」比一个按钮更让人焦虑。
         */
        ident
          ? react.createElement(
              'div',
              { style: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 } },
              ident.app && ident.app.avatarUrl
                ? react.createElement('img', { src: ident.app.avatarUrl, style: S.avatar, alt: '' })
                : react.createElement('span', { style: S.avatarFallback },
                    (ident.app && ident.app.appName ? ident.app.appName : acc.id || '?').slice(0, 1).toUpperCase()),
              react.createElement(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                react.createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                  react.createElement('strong', { style: { fontSize: 13 } },
                    (ident.app && ident.app.appName) || acc.label || acc.id),
                  ident.app && ident.app.activateStatus === 2
                    ? react.createElement('span', { style: S.badge('ok') }, '应用已发布')
                    : ident.app && ident.app.activateStatus !== undefined
                      ? react.createElement('span', { style: S.badge('warn') }, '应用未发布')
                      : null,
                ),
                ident.app && ident.app.description
                  ? react.createElement('div', { style: { ...S.hint, margin: '2px 0 0' } }, ident.app.description)
                  : null,
                /* 用户名：user 未授权时不可能知道，直说原因而不是空一行 */
                react.createElement(
                  'div',
                  { style: { ...S.hint, margin: '2px 0 0' } },
                  ident.user && ident.user.available
                    ? '用户：' + (ident.userProfile && ident.userProfile.name ? ident.userProfile.name : ident.user.status || '已授权')
                    : '用户：未知（user 身份尚未授权，无法读取自己的资料）',
                ),
              ),
            )
          : react.createElement(
              'div',
              { style: { display: 'flex', gap: 8, marginBottom: 8 } },
              react.createElement('button', { style: S.btnLink, disabled: !!busy, onClick: () => loadIdentity(false) },
                '查看接入的飞书应用信息'),
            ),
        /*
         * 工具栏放在三元表达式**外**面：上面那块是“还没拉过身份”时的大块，
         * 一旦拉过就换成头像详情。但“验证 token”/“我已完成授权”任何时候都得能点，
         * 否则刚点一次就再也验不了了。
         */
        react.createElement(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          ident
            ? react.createElement('button', { style: S.btnLink, disabled: !!busy, onClick: () => loadIdentity(true) }, '验证 token')
            : null,
          /*
           * 手动刷新按钮。
           * 用户原话：「是否应该加个自动刷新或者手动刷新按钮」。
           * 自动轮询只在“已发起授权”后跑；但人有无数种理由想手动确认现在到底是不是已授权
           * （在另一台机器上点的、等了很久回头看、刚改了后台权限），所以必须有个随时可点的。
           * 这个按钮要拉**真实状态**（不走缓存），否则点了没反应看起来就像坏了。
           */
          react.createElement(
            'button',
            {
              style: S.btnLink,
              disabled: !!busy,
              onClick: async () => {
                setBusy('正在刷新状态…');
                setMsg(null);
                try {
                  await loadIdentity(false);
                  if (onChanged) onChanged();
                  setMsg({ ok: true, text: '状态已刷新。' });
                } catch (e) {
                  if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
                } finally {
                  if (alive.current) setBusy(null);
                }
              },
            },
            '刷新状态',
          ),
          /*
           * 「我已完成授权」必须**任何时候都留着**。
           * 自动轮询只在本次会话发起过授权时才会跑；如果用户是之前在别处发起的授权、
           * 或者轮询刚好超时放弃了，那就只剩这一个手动入口能兑换 device_code。
           */
          ident && ident.user && ident.user.available
            ? null
            : react.createElement(
                'button',
                {
                  style: S.btnLink,
                  disabled: !!busy,
                  onClick: async () => {
                    setBusy('正在完成授权…');
                    setMsg(null);
                    try {
                      const d = await postAction('/plugins/larkcli/login-finish', { account: acc.id, timeoutMs: 8000 });
                      setMsg({ ok: !!d.ok, text: d.message || (d.ok ? '授权完成' : '授权未完成') });
                      if (d.ok) {
                        setAuthUrl(null);
                        await loadIdentity(false);
                        if (onChanged) onChanged();
                      }
                    } catch (e) {
                      setMsg({ ok: false, text: String((e && e.message) || e) });
                    } finally {
                      setBusy(null);
                    }
                  },
                },
                '我已完成授权',
              ),
          ident ? react.createElement('button', { style: S.btnLink, disabled: !!busy, onClick: () => setIdent(null) }, '收起') : null,
        ),

        ident ? react.createElement(Row, { k: '应用名', v: (ident.app && ident.app.appName) || '（读不到）' }) : null,
        ident && ident.appId ? react.createElement(Row, { k: 'appId', v: ident.appId }) : null,
        ident && ident.app && ident.app.botOpenId
          ? react.createElement(Row, { k: 'bot open_id', v: ident.app.botOpenId })
          : null,
        /*
         * 用户侧：目标②要求「用户姓名/头像/open_id」。user 未授权时这三项**根本不存在**，
         * 所以要么显示真实值，要么明确说“拿不到及为什么”，不显示空白行。
         */
        ident && ident.user && ident.user.available
          ? react.createElement(Row, { k: '用户', v: (ident.userProfile && ident.userProfile.name) || '（已授权，读不到姓名）' })
          : null,
        ident && ident.userProfile && ident.userProfile.openId
          ? react.createElement(Row, { k: '用户 open_id', v: ident.userProfile.openId })
          : null,
        ident && ident.userProfile && ident.userProfile.email
          ? react.createElement(Row, { k: '邮箱', v: ident.userProfile.email })
          : null,
        ident && ident.userProfile && ident.userProfile.avatarUrl
          ? react.createElement(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' } },
              react.createElement('img', { src: ident.userProfile.avatarUrl, style: S.avatar, alt: '' }),
              react.createElement('span', { style: S.hint }, '这是你（user 身份）的头像'),
            )
          : null,
        // token 状态：可验证真伪（--verify 会真的打一次服务端）
        ident && ident.bot
          ? react.createElement(Row, {
              k: 'bot token',
              v: ident.bot.available
                ? ident.bot.verified === true
                  ? '有效（已向服务端验证）'
                  : '存在（未验证，点「验证 token」实测）'
                : '不可用：' + (ident.bot.status || 'unknown'),
            })
          : null,
        ident && ident.user
          ? react.createElement(Row, {
              k: 'user token',
              v: ident.user.available
                ? ident.user.verified === true
                  ? '有效（已向服务端验证）'
                  : '存在（未验证）'
                : '未授权：' + (ident.user.status || 'missing'),
            })
          : null,
        /*
         * 用户侧缺权限：这是 target④ 的“清晰全面”部分。
         * 只说“user 未授权”对用户没价值，得告诉他**缺什么、去哪点**。
         */
        ident && ident.user && ident.user.missingScopes && ident.user.missingScopes.length
          ? react.createElement(
              'div',
              { style: { ...S.hint, color: C.warn, margin: '4px 0' } },
              'user 身份缺 ' + ident.user.missingScopes.length + ' 项权限：' + ident.user.missingScopes.slice(0, 6).join('、'),
              ident.user.missingScopes.length > 6 ? ' 等' : '',
              ident.user.consoleUrl
                ? react.createElement(
                    'div',
                    { style: { marginTop: 4 } },
                    react.createElement(
                      'button',
                      { style: S.btnLink, onClick: () => window.open(ident.user.consoleUrl, '_blank', 'noopener,noreferrer') },
                      '打开开放平台权限页',
                    ),
                  )
                : null,
            )
          : null,
        ident && ident.appScopes
          ? react.createElement(Row, { k: '应用已开通权限', v: Object.keys(ident.appScopes).length + ' 条' })
          : null,
        ident && ident.errors && ident.errors.length
          ? react.createElement('p', { style: { ...S.hint, color: C.warn } }, '部分信息读不到：' + ident.errors.join('；'))
          : null,

        editing
          ? react.createElement(
              'div',
              null,
              react.createElement('div', { style: { marginBottom: 6 } },
                react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, '显示名（面板上给人看的大字）'),
                react.createElement('input', { style: S.input, value: label, onChange: (e) => setLabel(e.target.value) }),
              ),
              react.createElement('div', { style: { marginBottom: 6 } },
                react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } },
                  '描述 —— 写清这个账户覆盖哪些群 / 文档 / 多维表格 / 日历，搜索靠它匹配'),
                react.createElement('textarea', {
                  style: { ...S.input, minHeight: 54, resize: 'vertical' },
                  value: desc,
                  onChange: (e) => setDesc(e.target.value),
                }),
              ),
              react.createElement('div', { style: { marginBottom: 8 } },
                react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, '标签（逗号分隔）'),
                react.createElement('input', { style: S.input, value: tags, onChange: (e) => setTags(e.target.value) }),
              ),
              react.createElement(
                'div',
                { style: { display: 'flex', gap: 8 } },
                react.createElement('button', { style: S.btnPrimary, disabled: !!busy, onClick: save }, busy || '保存'),
                react.createElement('button', { style: S.btn, disabled: !!busy, onClick: () => setEditing(false) }, '取消'),
              ),
            )
          : react.createElement(
              'div',
              null,
              acc.description
                ? react.createElement('div', { style: { marginBottom: 6, lineHeight: 1.6 } }, acc.description)
                : react.createElement('div', { style: { ...S.hint, margin: '0 0 6px' } },
                    '还没有描述。补上描述与标签，AI 才能按任务自动选对账户。'),
              (acc.tags || []).length
                ? react.createElement('div', null, (acc.tags || []).map((t) => react.createElement('span', { key: t, style: S.tag }, t)))
                : null,
              react.createElement(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
                // 「改名」必须能被看见。用户原话：「我没有看到有改名字的地方」。
                // 原先写「编辑描述/标签」，用户不会想到里面能改名 —— 显式说出来。
                react.createElement('button', { style: S.btn, onClick: () => setEditing(true) }, '改名 / 描述 / 标签'),
                acc.isDefault
                  ? null
                  : react.createElement('button', { style: S.btn, disabled: !!busy, onClick: makeDefault }, '设为默认'),
                acc.user
                  ? null
                  : react.createElement('button', { style: S.btnPrimary, disabled: !!busy, onClick: login }, '授权 user 身份'),
                // 权限清单入口放卡片上：缺哪些权限是「这个账户能不能用」的直接原因，
                // 藏在全局面板裏用户不会想到去看。
                react.createElement(
                  'button',
                  { style: S.btn, disabled: !!busy, onClick: () => setShowScopes((v) => !v) },
                  showScopes ? '收起权限清单' : '权限清单',
                ),
              ),
            ),

        acc.dir ? react.createElement(Row, { k: '目录', v: acc.dir }) : null,
        acc.appId ? react.createElement(Row, { k: 'appId', v: acc.appId }) : null,
        acc.error
          ? react.createElement('p', { style: { ...S.hint, color: C.err, margin: '8px 0 0' } }, acc.error)
          : null,
        busy ? react.createElement('p', { style: { ...S.hint, color: C.brand, fontWeight: 500 } }, busy) : null,
        msg
          ? react.createElement(
              'div',
              null,
              react.createElement(
                'pre',
                { style: { ...S.pre, borderColor: msg.ok ? C.ok : C.err } },
                msg.text,
              ),
            )
          : null,
        /*
         * 授权链接的三条出路。不用 <a href> 直接跳：桌面应用的窗口是新开的，
         * 用 window.open 能指定 noopener，也不会把当前面板导航走。
         */
        authUrl && authUrl.url
          ? react.createElement(
              'div',
              null,
              react.createElement(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
                react.createElement(
                  'button',
                  {
                    style: S.btnPrimary,
                    onClick: () => window.open(authUrl.url, '_blank', 'noopener,noreferrer'),
                  },
                  '1. 打开授权页',
                ),
                react.createElement(Copyable, { text: authUrl.url, id: 'auth-' + acc.id }),
                react.createElement(
                  'button',
                  {
                    style: S.btn,
                    disabled: !!busy,
                    onClick: async () => {
                      setBusy('正在检查授权结果…');
                      setMsg(null);
                      try {
                        const d = await postAction('/plugins/larkcli/login-finish', { account: acc.id, timeoutMs: 8000 });
                        if (!alive.current) return;
                        setMsg({ ok: !!(d && d.ok), text: (d && d.message) || (d && d.ok ? '授权完成' : '还没有检测到确认') });
                        if (d && d.ok) {
                          setAuthUrl(null);
                          await loadIdentity(false);
                          if (onChanged) onChanged();
                        }
                      } catch (e) {
                        if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
                      } finally {
                        if (alive.current) setBusy(null);
                      }
                    },
                  },
                  '2. 我已完成授权',
                ),
                react.createElement(
                  'a',
                  { href: '#', style: S.btnLink, onClick: (e) => { e.preventDefault(); setAuthUrl(null); } },
                  '取消',
                ),
              ),
              react.createElement(
                'div',
                {
                  style: {
                    ...S.hint,
                    margin: '0 0 8px',
                    padding: '8px 10px',
                    borderLeft: '3px solid ' + C.warn,
                    background: 'var(--dsw-alias-bg-overlay)',
                    lineHeight: 1.7,
                  },
                },
                '先在浏览器登录到你要授权的飞书账号，再点第 1 步。',
                react.createElement('br'),
                '授权是发给浏览器当前登录的那个人的；登错了账号，授权就会落到别人身上。',
              ),
            )
          : null,
        /*
         * 扫码：二维码是 Host 用 `auth qrcode` 现生成的 PNG（实测 416 字节，走账户目录）。
         * 手机飞书扫一下就完成确认 —— 这是比“复制链接再发到手机”少两步的路。
         */
        authUrl && authUrl.url
          ? react.createElement(
              'div',
              { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 } },
              react.createElement('img', {
                src: '/plugins/larkcli/qrcode?account=' + encodeURIComponent(acc.id) + '&t=' + Date.now(),
                style: { width: 132, height: 132, borderRadius: 6, background: '#fff', padding: 4 },
                alt: '登录二维码',
              }),
              react.createElement('span', { style: { ...S.hint, maxWidth: 220 } }, '用手机飞书扫这个码，确认授权；扫不上就点上面的「打开授权页」。'),
            )
          : null,
        showScopes ? react.createElement(ScopePanel, { accountId: acc.id }) : null,
      );
    }
    // ── 小工具：可复制的一段文字 ─────────────────────────────────────────────
    // 设计要点（dsh-gitok 的教训）：命令从行首写起，不要把源码缩进带进去；
    // pre-wrap + break-word 避免横滚裁切；复制失败必须**明说只是选中了**，
    // 否则用户按一下没反应会以为成功了。
    function Copyable({ text, id }) {
      const [state, setState] = useState(null);
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState({ ok: true, text: '已复制' });
        } catch {
          try {
            const el = document.getElementById('larkcli-copy-' + id);
            if (el) {
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }
          } catch {
            /* ignore */
          }
          setState({ ok: false, text: '剪贴板不可用，已选中文本，请按 Ctrl+C' });
        }
        setTimeout(() => setState(null), 2600);
      };
      return react.createElement(
        'div',
        null,
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          react.createElement('button', { style: S.btn, onClick: copy }, '复制'),
          state
            ? react.createElement('span', { style: { ...S.hint, margin: 0, color: state.ok ? C.ok : C.warn } }, state.text)
            : null,
        ),
        react.createElement('pre', { id: 'larkcli-copy-' + id, style: S.pre }, text),
      );
    }

    // ── lark-cli 本体：版本 / 升级 ───────────────────────────────────────────
    function Installer({ version }) {
      const [st, setSt] = useState(null);
      const [busy, setBusy] = useState(null);
      const [msg, setMsg] = useState(null);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const check = async () => {
        setBusy('正在查镜像…');
        setMsg(null);
        try {
          const r = await fetch('/plugins/larkcli/check-update', {
            credentials: 'same-origin',
            signal: AbortSignal.timeout(40000),
          });
          const d = await r.json();
          if (!alive.current) return;
          if (!d.ok) throw d.error ? new Error(d.error) : httpError(r, r.url || '?');
          setSt(d);
        } catch (e) {
          if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          if (alive.current) setBusy(null);
        }
      };

      const install = async () => {
        setBusy('正在下载并校验 SHA256（约 15 MB）…');
        setMsg(null);
        try {
          const d = await postAction('/plugins/larkcli/install', {}, 180000);
          if (!alive.current) return;
          setSt(null);
          setMsg({
            ok: true,
            text: d.changed
              ? '已从 ' + (d.previousVersion || '(无)') + ' 升级到 ' + d.version +
                '\nSHA256 ' + d.sha256 + '\n来源 ' + d.source +
                '\n重启 DSH 后生效（宿主半缓存了版本号）。'
              : '已是最新 ' + d.version + '，无需重装。',
          });
        } catch (e) {
          if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          if (alive.current) setBusy(null);
        }
      };

      const unknown = !version || version === 'unknown';
      const upd = !!(st && st.updateAvailable);

      return react.createElement(
        'div',
        { style: S.card },
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          react.createElement('strong', { style: { fontSize: 13 } }, 'lark-cli 本体'),
          react.createElement('span', { style: S.badge(unknown ? 'warn' : 'ok') }, unknown ? '版本未知' : 'v' + version),
          st && st.reachable
            ? react.createElement(
                'span',
                { style: S.badge(upd ? 'warn' : 'ok') },
                upd ? '可升级到 ' + st.latest : '已是最新',
              )
            : null,
          st && !st.reachable ? react.createElement('span', { style: S.badge('warn') }, '镜像不可达') : null,
          react.createElement('span', { style: { flex: 1 } }),
          react.createElement('button', { style: S.btn, disabled: !!busy, onClick: check }, '检查更新'),
          upd || unknown
            ? react.createElement(
                'button',
                { style: S.btnPrimary, disabled: !!busy, onClick: install },
                upd ? '升级到 ' + st.latest : '安装',
              )
            : null,
        ),
        react.createElement(
          'p',
          { style: { ...S.hint, margin: 0 } },
          '从 registry.npmmirror.com 下载官方包，逐字节比对 SHA256 后原子替换（旧版留着，失败自动回滚）。不经过 GitHub，不需要系统 Node。',
        ),
        st && st.error ? react.createElement('p', { style: { ...S.hint, color: C.warn } }, '查更新失败：' + st.error) : null,
        busy ? react.createElement('p', { style: { ...S.hint, color: C.brand, fontWeight: 500 } }, busy) : null,
        msg ? react.createElement('pre', { style: { ...S.pre, borderColor: msg.ok ? C.ok : C.err } }, msg.text) : null,
      );
    }

    // ── 新增账户表单 ─────────────────────────────────────────────────────────
    function NewAccount({ onChanged, alive }) {
      const [id, setId] = useState('');
      const [label, setLabel] = useState('');
      const [desc, setDesc] = useState('');
      const [tags, setTags] = useState('');
      const [appId, setAppId] = useState('');
      const [busy, setBusy] = useState(null);
      const [msg, setMsg] = useState(null);

      const create = async () => {
        setBusy('创建中…');
        setMsg(null);
        try {
          await postAction('/plugins/larkcli/account', {
            id: id.trim().toLowerCase(),
            label: label.trim() || undefined,
            description: desc.trim() || undefined,
            tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
            appId: appId.trim() || undefined,
            makeDefault: true,
          });
          if (!alive.current) return;
          setId('');
          setLabel('');
          setDesc('');
          setTags('');
          setAppId('');
          setMsg({ ok: true, text: '已创建。下一步：在会话里让 AI 调 lark_account_set_secret 写入该账户的 App Secret（面板不接收密钥）。' });
          onChanged();
        } catch (e) {
          if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          if (alive.current) setBusy(null);
        }
      };

      return react.createElement(
        'div',
        { style: S.card },
        react.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '新增账户'),
        react.createElement(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 } },
          react.createElement('div', null,
            react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, '账户 id（小写，会变成目录名）'),
            react.createElement('input', { style: S.input, placeholder: 'work', value: id, onChange: (e) => setId(e.target.value) }),
          ),
          react.createElement('div', null,
            react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, 'App ID'),
            react.createElement('input', { style: S.input, placeholder: 'cli_xxxxxxxx', value: appId, onChange: (e) => setAppId(e.target.value) }),
          ),
        ),
        react.createElement('div', { style: { marginBottom: 6 } },
          react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, '显示名（面板上给人看的大字）'),
          react.createElement('input', { style: S.input, placeholder: '公司主账号', value: label, onChange: (e) => setLabel(e.target.value) }),
        ),
        react.createElement('div', { style: { marginBottom: 6 } },
          react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, '描述（AI 按任务选账户时靠它）'),
          react.createElement('textarea', {
            style: { ...S.input, minHeight: 48, resize: 'vertical' },
            placeholder: '研发群、周报文档、项目A 多维表格、工作日历',
            value: desc,
            onChange: (e) => setDesc(e.target.value),
          }),
        ),
        react.createElement('div', { style: { marginBottom: 8 } },
          react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, '标签（逗号分隔）'),
          react.createElement('input', { style: S.input, placeholder: '研发, 周报, 项目A', value: tags, onChange: (e) => setTags(e.target.value) }),
        ),
        react.createElement(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          react.createElement('button', { style: S.btnPrimary, disabled: !!busy || !id.trim(), onClick: create }, busy || '创建'),
          react.createElement('span', { style: { ...S.hint, margin: 0 } }, 'App Secret 不在面板填写（走 lark_account_set_secret，值不回显）'),
        ),
        msg ? react.createElement('pre', { style: S.pre }, msg.text) : null,
      );
    }

    // ── 主面板 ───────────────────────────────────────────────────────────────
    function LarkSection() {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [err, setErr] = useState(null);
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
          const msg = String((e && e.message) || e);
          // 路由没挂上（Host 半未加载）与探测超时要分开说，否则新手不知道找谁
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

      const snap = data && data.snapshot;
      const layout = data && data.layout;
      const accounts = (snap && snap.accounts) || [];

      return react.createElement(
        'div',
        { style: S.wrap },

        react.createElement('h2', { style: S.h }, '飞书'),
        react.createElement(
          'p',
          { style: S.sub },
          'Windows 原生驱动官方 lark-cli：不靠 WSL、不装系统 Node。每个账户用自己的 App 凭据与 user 授权，' +
            '描述与标签决定 AI 按任务选哪个账户（省调用、省 token）。密钥只存在仓库外的数据目录，面板不接收、界面不回显。',
        ),

        react.createElement(
          'div',
          { style: S.card },
          react.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
            react.createElement('strong', { style: { fontSize: 13 } }, loading ? '正在读取…' : `共 ${accounts.length} 个账户`),
            snap && snap.defaultId
              ? react.createElement(
                  'span',
                  { style: { ...S.hint, margin: 0 } },
                  '不指定账户时用 ',
                  react.createElement('strong', { style: { color: C.text } }, snap.defaultId),
                )
              : null,
            react.createElement('span', { style: { flex: 1 } }),
            react.createElement('button', { style: S.btnPrimary, disabled: loading, onClick: () => load(true) }, loading ? '读取中…' : '刷新全部状态'),
          ),
          layout && react.createElement(Row, { k: '二进制', v: `${layout.binaryExists ? '✅' : '❌'} ${layout.binary}` }),
          /* 版本号单独拉一次会跑子进程，所以面板只展示 data.version；安装卡再负责检查更新 */
          layout && react.createElement(Row, { k: '版本', v: data.version || '未知' }),
          layout && react.createElement(Row, { k: '数据目录', v: layout.dataDir }),
          layout && react.createElement(Row, { k: '账户表', v: layout.accountsFile }),
          !layout || layout.binaryExists
            ? null
            : react.createElement(
                'p',
                { style: { ...S.hint, color: C.warn } },
                '找不到 lark-cli.exe。点下方安装卡里的「安装」（从镜像下载 + SHA256 校验，自动就位）。',
              ),
          err
            ? react.createElement('p', { style: { ...S.hint, color: C.err } }, err)
            : null,
        ),
        /*
         * 安装卡放在状态卡之后、账户列表之前：它回答「能不能用」的前置问题。
         * version 从 /status 拿（首帧已拉过），不额外跑子进程。
         */
        react.createElement(Installer, { version: data && data.version }),

        accounts.length === 0 && !loading
          ? react.createElement(
              'div',
              { style: S.card },
              react.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '还没有账户'),
              react.createElement(
                'p',
                { style: { ...S.hint, margin: 0 } },
                '一个账户 = 一个飞书应用（appId + secret）。要用几个飞书应用就建几个账户，它们相互独立。',
                react.createElement('br'),
                '建完后在会话里让 AI 调 ',
                react.createElement('code', { style: { fontSize: 11.5 } }, 'lark_account_set_secret'),
                ' 写入 App Secret（只报长度，不回显）。bot 身份配好 secret 即可用；要读私人文档/日历/邮件再点卡片上的「授权 user 身份」。',
              ),
            )
          : null,

        accounts.map((a) => react.createElement(AccountCard, { key: a.id, acc: a, onChanged: () => load(true), alive })),

        react.createElement(NewAccount, { onChanged: () => load(true), alive }),

        react.createElement(
          'div',
          { style: S.card },
          react.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '这些信息在哪里管理'),
          react.createElement(
            'div',
            { style: S.hint },
            'App Secret：文件在数据目录 accounts/<id>/appsecret.txt，用会话里的 ',
            react.createElement('code', { style: { fontSize: 11.5 } }, 'lark_account_set_secret'),
            ' 写入（只报告长度，永不回显）。',
            react.createElement('br'),
            'lark-cli 的 config.json 由插件按本机路径自动生成，不要手改 —— 迁移时凭据失效正是因为里面写死了旧绝对路径。',
            react.createElement('br'),
            'user 授权：点卡片上的「授权 user 身份」拿链接，浏览器完成后回到会话让 AI 调 ',
            react.createElement('code', { style: { fontSize: 11.5 } }, 'lark_login_finish'),
            ' 完成。',
            react.createElement('br'),
            '读内容的实际调用走 ',
            react.createElement('code', { style: { fontSize: 11.5 } }, 'lark_call'),
            '（如 args=["im","+chat-list","--as","bot"]）；不确定参数时先 ',
            react.createElement('code', { style: { fontSize: 11.5 } }, 'lark_schema'),
            '。',
          ),
        ),
      );
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────
    function apply(ctx) {
      // 必须用 ctx.locale.bind(NS)，不能写 const t = (s) => s：
      // 那样字典注册了也不生效，导航栏永远拿不到翻译后的文字（dsh-getbrain 验证过的坑）。
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            // 界面显示名：M + 技能名，全小写（仓库约定，见 dshplug/BOOTSTRAP.md §5.1）。
            // 中英文同一个名字：它是品牌标识，不参与翻译。
            zh: { nav: 'Mlarkcli' },
            en: { nav: 'Mlarkcli' },
          }),
        'larkcli: settings dictionaries',
      );

      const t = ctx.locale.bind(NS);

      // 顶层设置分区。order 202：M* 分区按显示名字母序排在内置分区之后，
      // Git 认证 200、getbrain 201、本项 202、synchub 203。
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'larkcli',
                order: 202,
                label: () => t('nav'),
                locale: NS,
              },
              LarkSection,
            ),
          ),
        'larkcli: settings section',
      );
    }

    module.exports = { name: 'dsh-larkcli', inject, apply };
    return module.exports;
  },
});
