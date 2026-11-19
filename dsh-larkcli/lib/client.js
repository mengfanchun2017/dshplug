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

    const inject = ['slots'];

    const API = '/plugins/larkcli/status';
    const NS = 'larkcli.settings';

    // ── 数据 ────────────────────────────────────────────────────────────────
    // Host 侧要真起 lark-cli 子进程（每个账户一次 ~300ms），超时给宽一点。
    const fetchStatus = async (refresh = false, timeout = 30000) => {
      const url = refresh ? `${API}?refresh=1` : API;
      const r = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    };

    // ── 样式（只用主题变量，跟随亮/暗） ──────────────────────────────────────
    const S = {
      wrap: { padding: '16px 18px', maxWidth: 820, fontFamily: 'inherit', fontSize: 13 },
      h: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      sub: { color: 'var(--dsh-text-secondary, #888)', margin: '0 0 16px', fontSize: 12, lineHeight: 1.6 },
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
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, #ccc)',
        background: 'var(--dsh-bg-elevated, #fff)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      btnPrimary: {
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'var(--dsh-accent, #2f6feb)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12,
        fontFamily: 'inherit',
      },
      input: {
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, #ccc)',
        background: 'var(--dsh-bg, transparent)',
        color: 'inherit',
        fontSize: 12,
        fontFamily: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      },
      badge: (ok) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        color: ok ? '#1a7f37' : '#9a6700',
        border: `1px solid ${ok ? '#1a7f37' : '#9a6700'}40`,
        background: `${ok ? '#1a7f37' : '#9a6700'}14`,
      }),
      pre: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        lineHeight: 1.55,
        background: 'var(--dsh-bg-code, rgba(127,127,127,.08))',
        border: '1px solid var(--dsh-border, #e3e3e3)',
        borderRadius: 6,
        padding: 10,
        overflow: 'auto',
        maxHeight: 260,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        margin: '8px 0 0',
      },
      hint: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsh-text-secondary, #888)', margin: '8px 0 0' },
      tag: {
        display: 'inline-block',
        padding: '1px 7px',
        margin: '0 4px 4px 0',
        borderRadius: 999,
        fontSize: 11,
        background: 'var(--dsh-bg-code, rgba(127,127,127,.12))',
        color: 'var(--dsh-text-secondary, #666)',
      },
    };

    const Row = ({ k, v, mono = true }) =>
      react.createElement(
        'div',
        { style: S.row },
        react.createElement('span', { style: S.k }, k),
        react.createElement('span', { style: mono ? S.v : { ...S.v, fontFamily: 'inherit' } }, v),
      );

    // ── 单个账户卡片 ─────────────────────────────────────────────────────────
    function AccountCard({ acc, onChanged, alive }) {
      const [editing, setEditing] = useState(false);
      const [label, setLabel] = useState(acc.label || '');
      const [desc, setDesc] = useState(acc.description || '');
      const [tags, setTags] = useState((acc.tags || []).join(', '));
      const [busy, setBusy] = useState(null);
      const [msg, setMsg] = useState(null);

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

      const login = async () => {
        setBusy('正在获取授权链接…');
        setMsg(null);
        try {
          const d = await postAction('/plugins/larkcli/login-start', { account: acc.id });
          if (!alive.current) return;
          setMsg({ ok: true, text: `授权链接（${Math.round((d.expiresIn || 600) / 60)} 分钟内有效）：\n${d.verificationUrl}\n\n在浏览器打开或复制到手机飞书。完成后回到会话让 AI 调 lark_login_finish。` });
        } catch (e) {
          if (alive.current) setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          if (alive.current) setBusy(null);
        }
      };

      return react.createElement(
        'div',
        { style: { ...S.card, marginBottom: 10 } },
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          react.createElement('strong', { style: { fontSize: 13 } }, acc.id),
          acc.isDefault ? react.createElement('span', { style: S.badge(true) }, '默认') : null,
          react.createElement('span', { style: S.badge(!!acc.bot) }, acc.bot ? 'bot 可用' : 'bot 不可用'),
          react.createElement('span', { style: S.badge(!!acc.user) }, acc.user ? 'user 已授权' : 'user 未授权'),
          acc.hasSecret ? null : react.createElement('span', { style: S.badge(false) }, '缺 secret'),
        ),

        editing
          ? react.createElement(
              'div',
              null,
              react.createElement('div', { style: { marginBottom: 6 } },
                react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, '显示名'),
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
                react.createElement('button', { style: S.btn, onClick: () => setEditing(true) }, '编辑描述/标签'),
                acc.isDefault
                  ? null
                  : react.createElement('button', { style: S.btn, disabled: !!busy, onClick: makeDefault }, '设为默认'),
                acc.user
                  ? null
                  : react.createElement('button', { style: S.btnPrimary, disabled: !!busy, onClick: login }, '授权 user 身份'),
              ),
            ),

        acc.dir ? react.createElement(Row, { k: '目录', v: acc.dir }) : null,
        acc.appId ? react.createElement(Row, { k: 'appId', v: acc.appId }) : null,
        acc.error
          ? react.createElement('p', { style: { ...S.hint, color: '#cf222e', margin: '8px 0 0' } }, acc.error)
          : null,
        busy ? react.createElement('p', { style: { ...S.hint, color: 'var(--dsh-accent, #2f6feb)', fontWeight: 500 } }, busy) : null,
        msg
          ? react.createElement(
              'div',
              null,
              react.createElement(
                'pre',
                { style: { ...S.pre, borderColor: msg.ok ? '#1a7f3740' : '#cf222e40' } },
                msg.text,
              ),
            )
          : null,
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
          react.createElement('div', { style: { ...S.hint, margin: '0 0 3px' } }, '显示名'),
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
            snap && snap.defaultId ? react.createElement('span', { style: S.badge(true) }, `默认 ${snap.defaultId}`) : null,
            react.createElement('span', { style: { flex: 1 } }),
            react.createElement('button', { style: S.btnPrimary, disabled: loading, onClick: () => load(true) }, loading ? '读取中…' : '刷新状态'),
          ),
          layout && react.createElement(Row, { k: '二进制', v: `${layout.binaryExists ? '✅' : '❌'} ${layout.binary}${data.version ? ` (v${data.version})` : ''}` }),
          layout && react.createElement(Row, { k: '数据目录', v: layout.dataDir }),
          layout && react.createElement(Row, { k: '账户表', v: layout.accountsFile }),
          !layout || layout.binaryExists
            ? null
            : react.createElement(
                'p',
                { style: { ...S.hint, color: '#9a6700' } },
                '找不到 lark-cli.exe。在插件目录运行 .\\scripts\\fetch-lark-cli.ps1（官方 SHA256 校验后自动补齐）。',
              ),
          err
            ? react.createElement('p', { style: { ...S.hint, color: '#cf222e' } }, err)
            : null,
        ),

        accounts.length === 0 && !loading
          ? react.createElement(
              'div',
              { style: S.card },
              react.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '还没有账户'),
              react.createElement(
                'p',
                { style: { ...S.hint, margin: 0 } },
                '用下面的「新增账户」建一个（id / App ID / 描述 / 标签），然后在会话里让 AI 调 ',
                react.createElement('code', { style: { fontSize: 11.5 } }, 'lark_account_set_secret'),
                ' 写入 App Secret。bot 身份配好 secret 即可用；要读私人文档/日历/邮件再授权 user 身份。',
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
