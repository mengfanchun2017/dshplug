/**
 * getnote-organize —— 浏览器半区（Client 插件）
 *
 * 在 DSH「设置」里注册一个**顶层侧边栏分区 Getnote**（settings.section），
 * 分区内是一个表单，直接读写本插件行的 Config（命名空间 = patch row id "getnote"）。
 * 这样 API Key / Client ID / dataDir / media.images / minInterval 都能在设置里改，
 * 不用去翻文件、也不用找插件行的「配置」按钮。
 *
 * 机制（依据 DSH 0.2.x 源码）：
 *  - Host 的 dsh-settings 只把 Config 里 `.volatile()` 的字段投影成可编辑表单；
 *    本包 index.js 已把全部字段标为 volatile，并把 apiKey/clientId 标 role('secret')。
 *  - 命名空间 = cordis.patch.yml 里 insert 的 id，即 "getnote"。
 *  - `configForms.get('getnote')` 提供 getSnapshot()/subscribe()/set()/unset()/mutate()。
 *  - `settings.section` 是设置侧边栏的顶层分区槽（general/plugins 都注册在这里）。
 *
 * 约束：不 import @deepseek-ai/dsh-client-ui-primitives（官方 UI 规则），
 * 只用 react + 主题 CSS 变量手写控件；文案走 ctx.locale。
 */

const NS = 'getnote.settings'

// configForms 的命名空间 = profile entry id。
//
// 实测结论（2026-11-10，拿 Host 侧 settings.describe() 真数据验证）：
//     ns = "getnote"        ← 不带 include: 前缀，这是对的
//     entryId = "include:getnote"（plugin_manager 里显示的那个，不是命名空间）
// 全部 27 个条目的 ns 都不带前缀：session-log-deepseek / better-sidebar / getnote ……
//
// 但真正的故障根因不在命名空间，而在 Config 为 undefined：
// schemastery 只按 DSH_PROFILE_DIR 定位，而 Host 进程里根本没这个环境变量
// （只有 DSH_CLIENT_VERSION / ELECTRON_RUN_AS_NODE），导致 z=null →
// ConfigShape=undefined → settings.describe() 直接跳过本行 →
// 面板除凭据框外全部禁用（凭据框走 remote.credentials，是另一条路）。
// 已在 index.js 改为多锚点探测（process.cwd() 是可靠锚点）。
//
// 这里保留候选式探测：万一以后 DSH 改前缀，也不用再改一次。
const FORM_NS_CANDIDATES = ['getnote', 'include:getnote']

/** 逐个候选试探，拿到第一个真的 status='ready' 的表单控制器。
 *  两个都不中时回退到第一个候选（让面板显示“不可用”而不是崩掉）。 */
function pickForm(configForms) {
  const list = FORM_NS_CANDIDATES.map((ns) => configForms.get(ns))
  const hit = list.find((f) => {
    try { const s = f && f.getSnapshot && f.getSnapshot(); return s && s.status === 'ready' }
    catch { return false }
  })
  return hit || list[0]
}

const zh = {
  nav: 'Getnote',
  // 左侧边栏图标的名字（sidebar.panellist 的 label）
  panelName: 'Getnote 工作台',
  tabOverview: '笔记现状',
  tabSuggest: '处理建议',
  tabApply: '确认执行',
  tabLog: '执行日志',
  localFirst: '本地优先',
  subtitle: '本地镜像是安全网：所有改动先在这里预演，确认后才写线上。',
  overviewTitle: '当前笔记现状',
  overviewTitleEmpty: '原型阶段：这里将显示笔记总数、按知识库/标签的分布、重复项与最近变更。',
  suggestTitle: '整理建议',
  suggestTitleEmpty: '原型阶段：这里将列出 AI 生成的分类 / 合并 / 命名建议，逐条可接受或忽略。',
  applyTitle: '确认与执行',
  applyTitleEmpty: '原型阶段：这里将在执行前列出将要发生的每一步改动，需显式确认。',
  logTitle: '执行日志',
  logTitleEmpty: '原型阶段：这里将显示每次操作的请求、结果与可回溯的审计记录。',
  title: '得到大脑 · 笔记整理',
  intro: '通过官方 OpenAPI 整理得到大脑（原 Get笔记）。这里填写账号凭据与统一数据目录，保存即生效、无需重启。',
  groupCredentials: '账号凭据',
  groupData: '下载与目录',
  groupAdvanced: '高级',
  apiKey: 'API Key',
  apiKeyHint: 'gk_live_…；会员账号在开放平台创建应用获取。留空则用环境变量或 apiKeyFile。',
  clientId: 'Client ID',
  clientIdHint: 'cli_…；与 API Key 成对。',
  apiKeyFile: '凭据文件（备用）',
  apiKeyFileHint: '本地 json 路径，含 {"api_key","client_id"}。只在凭据库没有完整 Key+Client ID 时才生效；两个都存了就不看这个。路径写错会在自检里报错。',
  apiBase: 'OpenAPI 地址',
  dataDir: '统一数据目录',
  dataDirHint: '下载 / 中间产物 / 快照 / 日志 / 审计 / 计划全归它。相对路径相对工作区根。',
  dirHead: '数据存哪里、存了什么',
  dirWhere: '配置值',
  dirResolved: '实际位置',
  dirRelToWorkspace: '相对路径，实解析到工作区根目录下',
  dirAbsolute: '绝对路径，直接使用',
  dirWhat: '存什么',
  dirWhatVal: '笔记全文 Markdown、AI 总结、整理快照、审计日志、计划文件',
  dirMedia: '不存什么',
  dirMediaVal: '音频 / 视频二进制永不下载；图片默认关闭（需手动开启）',
  dirWhen: '什么时候有内容',
  dirWhenVal: '目录自动创建，无需初始化；跑一次「下载」才会出现 Markdown。刚装完是空的。',
  images: '下载图片',
  imagesHint: '默认只取全文字；音频/视频二进制为硬约束永不下载。',
  minInterval: '请求最小间隔（秒）',
  pythonPath: 'Python 解释器',
  pythonTimeoutMs: '单次调用超时（毫秒）',
  saved: '已保存',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  loading: '正在读取配置…',
  unavailable: '配置命名空间暂不可用（插件未激活或应用需重启）。',
  readonly: '当前配置为只读（可能被更高优先级补丁覆盖）。',
  secretPlaceholder: '（已保存，留空表示不修改）',
  secretEmpty: '（未设置）',
  saveFailed: '保存失败，请重试。',
  restartHint: '提示：面板保存后即时生效，无需重启；下次调用工具就用新值。',
  guideHint: '完整说明见工作区 getnote/README.md 第 9 节。',

  // —— 安全凭据（写入 DSH 凭据库，不进组合树）——
  credTitle: '账号凭据（安全存储）',
  credExplain: '保存后写入 DSH 凭据库 $DSH_HOME/.credentials.yaml，不会进入插件配置（组合树）明文，也不出现在日志里。实测：这个文件的 ACL 跟普通配置文件完全一样（SYSTEM / Administrators / 你本人 均完全控制），所以它不是 OS 密钥链，也不比放明文配置更难被同账号程序读到；它只是不落组合树、不会被配置导出带走。',
  apiKeyHint2: '开放平台创建的 API Key（gk_live_…）。填一次保存即可，以后不会回显。',
  clientIdHint2: '与 API Key 成对的 Client ID（cli_…）。',
  saveCred: '保存凭据',
  savingCred: '保存中…',
  credSaved: '凭据已保存到 DSH 凭据库。',
  credFailed: '凭据保存失败，请重试。',
  credClear: '清除已存密钥',
  credCleared: '已从凭据库删除。',
  credNotWritable: '凭据库为只读，无法从这里写入。',
  credNoService: 'DSH 凭据服务未挂载，密钥输入已禁用。请检查 credentials 服务是否启用。',

  // —— 接入信息 ——
  statusTitle: '接入信息',
  statusIntro: '下面是从本机实际读出来的状态；点「测试连接」会真的发一次请求。',
  testConn: '测试连接',
  testing: '测试中…',
  connOk: '✅ 认证通过，已可调用',
  connFail: '❌ 未通过，请看下方诊断',
  originLabel: '凭据来源',
  dataDirLabel: '数据目录',
  apiBaseLabel: 'API 地址',
  memberLabel: '会员状态',
  memberUnknown: '未测试',
  quotaLabel: '配额',
  quotaNone: '官方未在响应头下发（只能靠 429 判断）',
  quotaNeedLive: '点「测试连接」后可查',
  copyUsage: '复制说明',
  copied: '已复制 ✓',
  copiedManual: '浏览器不允许直接写剪贴板；已帮你选中下方文字，按 Ctrl+C 复制。',
  noStatus: '暂无接入信息（点「测试连接」获取）。',

  // —— 怎么用 ——
  usageTitle: '怎么用',
  usageIntro: '认证通过后，在任意会话里直接对我说下面这些，我会调对应工具。',
  // locale 的 t() 只返回字符串，不能给数组。用法逐条平铺。
  usage1: '「先跑一下 getnote_doctor」— 本地自检，确认目录与限速',
  usage2: '「用 getnote_download 把笔记全量下载下来」— 只拉全文字，默认不拉音视频',
  usage3: '「做一次 getnote_backup 快照」— 任何写操作前必须做',
  usage4: '「搜一下我笔记里关于 XX 的内容」— getnote_search 语义检索',
  usage5: '「列一下我的知识库」— getnote_topics',
  usage6: '「把 A、B 两篇重复笔记合并」— 我会先生成 plan 给你确认，你同意后才 getnote_apply',
  usageSafety: '安全约束：默认只读；写操作必须先给 plan 并得到你明确确认；删除按不可逆对待，需双重闸门。',
}

const en = {
  nav: 'Getnote',
  panelName: 'Getnote Workbench',
  tabOverview: 'Current state',
  tabSuggest: 'Suggestions',
  tabApply: 'Review & apply',
  tabLog: 'Activity log',
  localFirst: 'Local first',
  subtitle: 'The local mirror is your safety net: preview every change here, write to the server only after you confirm.',
  overviewTitle: 'Current state',
  overviewTitleEmpty: 'Prototype: note totals, topic/tag distribution, duplicates and recent changes will appear here.',
  suggestTitle: 'Suggestions',
  suggestTitleEmpty: 'Prototype: AI-generated classify / merge / rename suggestions will be listed here, each acceptable or ignorable.',
  applyTitle: 'Review & apply',
  applyTitleEmpty: 'Prototype: every change will be listed step by step before execution; explicit confirmation required.',
  logTitle: 'Activity log',
  logTitleEmpty: 'Prototype: requests, results and an auditable trail will appear here.',
  title: '得到大脑 · Notes Organizer',
  intro: 'Organize 得到大脑/Get笔记 via official OpenAPI. Set credentials and the unified data directory here — saving applies immediately, no restart needed.',
  groupCredentials: 'Credentials',
  groupData: 'Download & directories',
  groupAdvanced: 'Advanced',
  apiKey: 'API Key',
  apiKeyHint: 'gk_live_…; get it from the open platform with a member account. Leave empty to use env var or apiKeyFile.',
  clientId: 'Client ID',
  clientIdHint: 'cli_…; pairs with the API Key.',
  apiKeyFile: 'Credential file (fallback)',
  apiKeyFileHint: 'Local json path with {"api_key","client_id"}. Only used when the credential store does not supply both Key and Client ID; ignored once both are saved. A bad path is reported by the self-check.',
  apiBase: 'OpenAPI base URL',
  dataDir: 'Unified data directory',
  dataDirHint: 'Downloads / intermediate / snapshots / logs / audit / plans all live here. Relative to workspace root.',
  dirHead: 'Where data lives & what it contains',
  dirWhere: 'Configured value',
  dirResolved: 'Resolved to',
  dirRelToWorkspace: 'Relative — resolved under the workspace root',
  dirAbsolute: 'Absolute — used as-is',
  dirWhat: 'Stores',
  dirWhatVal: 'Full-text note Markdown, AI summaries, organize snapshots, audit logs, plan files',
  dirMedia: 'Never stores',
  dirMediaVal: 'Audio/video binaries are never downloaded; images off by default',
  dirWhen: 'When it fills up',
  dirWhenVal: 'Created automatically, no setup needed. Markdown appears only after you run a download; empty on a fresh install.',
  images: 'Download images',
  imagesHint: 'Default: full text only. Audio/video binaries are never downloaded (hard rule).',
  minInterval: 'Min request interval (s)',
  pythonPath: 'Python interpreter',
  pythonTimeoutMs: 'Call timeout (ms)',
  saved: 'Saved',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  loading: 'Loading configuration…',
  unavailable: 'Configuration namespace is unavailable (plugin inactive or app needs a restart).',
  readonly: 'Configuration is read-only (possibly overridden by a higher-priority patch).',
  secretPlaceholder: '(saved — leave empty to keep)',
  secretEmpty: '(not set)',
  saveFailed: 'Save failed — please retry.',
  restartHint: 'Saved values apply immediately — no restart needed.',
  guideHint: 'Full guide: getnote/README.md §9 in the workspace.',
  credTitle: 'Credentials (secure storage)',
  credExplain: 'Saved to the DSH credential store $DSH_HOME/.credentials.yaml — never written into the plugin configuration (composition tree) as plaintext, and never logged. Measured: this file has exactly the same ACL as an ordinary config file (SYSTEM / Administrators / you all have FullControl), so it is NOT an OS keychain and is not harder for another process under the same account to read; its only real benefit is staying out of the composition tree and out of config exports.',
  apiKeyHint2: 'API Key from the open platform (gk_live_…). Enter once and save; it is never echoed back.',
  clientIdHint2: 'Client ID paired with the API Key (cli_…).',
  saveCred: 'Save credentials',
  savingCred: 'Saving…',
  credSaved: 'Credentials saved to the DSH credential store.',
  credFailed: 'Failed to save credentials — please retry.',
  credClear: 'Clear stored keys',
  credCleared: 'Removed from the credential store.',
  credNotWritable: 'The credential store is read-only; cannot write from here.',
  credNoService: 'The DSH credential service is not mounted, so key input is disabled. Check that the credentials service is enabled.',

  statusTitle: 'Connection info',
  statusIntro: 'Read from this machine. "Test connection" actually sends one request.',
  testConn: 'Test connection',
  testing: 'Testing…',
  connOk: '✅ Authenticated — ready to use',
  connFail: '❌ Not authenticated — see diagnostics below',
  originLabel: 'Credential source',
  dataDirLabel: 'Data directory',
  apiBaseLabel: 'API base',
  memberLabel: 'Membership',
  memberUnknown: 'not tested',
  quotaLabel: 'Quota',
  quotaNone: 'not sent by the API (only 429 reveals it)',
  quotaNeedLive: 'click "Test connection"',
  copyUsage: 'Copy instructions',
  copied: 'Copied ✓',
  copiedManual: 'The browser blocked clipboard access; the text below is selected — press Ctrl+C to copy.',
  noStatus: 'No connection info yet (click "Test connection").',

  usageTitle: 'How to use',
  usageIntro: 'Once authenticated, just ask me in any session and I will call the matching tool.',
  usage1: '"Run getnote_doctor" — local self-check of directories and rate limit',
  usage2: '"Use getnote_download to fetch all notes" — full text only, no audio/video',
  usage3: '"Take a getnote_backup snapshot" — required before any write',
  usage4: '"Search my notes for XX" — getnote_search semantic search',
  usage5: '"List my knowledge bases" — getnote_topics',
  usage6: '"Merge duplicates A and B" — I will draft a plan for your approval, then getnote_apply',
  usageSafety: 'Safety: read-only by default; writes require a plan and your explicit confirmation; deletion is treated as irreversible with a double gate.',
}

// 表单字段定义：只列**非秘密**字段。密钥（apiKey/clientId）走 DSH 凭据库，
// 不进 config，所以不在这里。
// FIELDS 里每项的 key 与 index.js 的 Config 字段一一对应。
// 只留真正需要人改的三项。
//
// 移除的四个字段（2026-11-10 按用户反馈精简）：
//   apiBase       —— 官方地址固定 https://openapi.biji.com，改错只会搞坏
//   minInterval   —— 默认 0.55s ≈ 1.8 req/s，官方限流 read 5/s，已经安全余量足够
//   pythonPath    —— gn.ps1 / index.js 会自动找 bundled Python，手填反而容易错
//   pythonTimeoutMs —— 默认 600000ms；面板自检另有 20/45s 独立超时
// 这四个字段仍在 Config schema 里（cordis.patch.yml 可改），只是不占面板。
const FIELDS = [
  { key: 'apiKeyFile', type: 'text', group: 'groupCredentials', label: 'apiKeyFile', hint: 'apiKeyFileHint' },
  { key: 'dataDir', type: 'text', group: 'groupData', label: 'dataDir', hint: 'dataDirHint' },
  { key: 'media.images', type: 'bool', group: 'groupData', label: 'images', hint: 'imagesHint' },
]

function getPath(obj, path) {
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj)
}

function styles() {
  // 全部用主题 token，不用字面颜色（官方 UI 规则）
  const c = 'var(--dsw-alias-label-primary)'
  const c3 = 'var(--dsw-alias-label-tertiary)'
  const border = 'var(--dsw-alias-border-l4)'
  const bg = 'var(--dsw-alias-bg-layer-1)'
  return {
    section: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14, color: c },
    h2: { margin: 0, fontSize: 18, fontWeight: 600 },
    p: { margin: 0, fontSize: 13, color: c3, lineHeight: '20px' },
    group: { display: 'flex', flexDirection: 'column', gap: 10 },
    groupTitle: { margin: 0, fontSize: 14, fontWeight: 600, paddingBottom: 6,
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
    row: { display: 'flex', flexDirection: 'column', gap: 4 },
    label: { fontSize: 13, fontWeight: 500 },
    hint: { fontSize: 12, color: c3, lineHeight: '18px', margin: 0 },
    input: { width: '100%', boxSizing: 'border-box', height: 34, padding: '0 10px',
      font: 'inherit', fontSize: 13, color: c, background: bg,
      border: `0.5px solid ${border}`, borderRadius: 'var(--dsw-radius-md)', outline: 'none' },
    boolRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
    footer: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 },
    btn: { font: 'inherit', fontSize: 13, cursor: 'pointer', padding: '6px 16px',
      borderRadius: 'var(--dsw-radius-md)', border: `0.5px solid ${border}`,
      background: bg, color: c },
    primary: { background: 'var(--dsw-alias-state-business-primary)', color: '#fff', border: 'none' },
    status: { fontSize: 12, color: c3 },
    note: { fontSize: 12, color: c3, marginTop: 6 },
    // 接入信息面板
    card: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
      border: `0.5px solid ${border}`, borderRadius: 'var(--dsw-radius-md)', background: bg },
    kv: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: 6, fontSize: 12, lineHeight: '18px' },
    k: { color: c3 },
    v: { color: c, wordBreak: 'break-all' },
    pre: { margin: 0, font: 'inherit', fontSize: 12, lineHeight: '18px', color: c3,
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflow: 'auto' },
    ok: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-state-success-primary)' },
    bad: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' },
    ul: { margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: '21px', color: c },
    danger: { font: 'inherit', fontSize: 12, cursor: 'pointer', padding: '4px 10px',
      borderRadius: 'var(--dsw-radius-md)', border: `0.5px solid ${border}`,
      background: 'transparent', color: c },
    // 数据目录说明框
    dirBox: {
      marginTop: 8, padding: '10px 12px', borderRadius: 6,
      border: `1px solid ${border}`, background: bg,
    },
    dirHead: { fontSize: 12, fontWeight: 600, color: c, margin: '0 0 6px' },
    dirLine: { display: 'flex', gap: 8, fontSize: 12, margin: '3px 0', alignItems: 'baseline' },
    dirK: { color: c3, flexShrink: 0, minWidth: 68 },
    dirV: { color: c, wordBreak: 'break-all' },
    code: {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 11, padding: '1px 5px', borderRadius: 4,
      background: 'var(--dsw-alias-bg-layer-2)', color: c,
      wordBreak: 'break-all',
    },
    pathBox: { marginTop: 6 },
  }
}

window.__ModuleLoader__.load({
  id: '@local/getnote-organize',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const S = styles()

    // ────────────────────────────────────────────────────────────────
    //  左侧边栏工作台（sidebar.panellist + main 两个 slot 配合）
    //
    //  依据 DSH 0.2.2 源码里的 slot 规格：
    //    sidebar.panellist (list, root)  注册图标按钮，选项 id/order/label，收到 {size, active}
    //    main (keyed, root)            注册主面板，key 必须与上面的 id 完全一致
    //    已占 key：conversation / plugin-manager / schedule
    //  官方定位：「A left-sidebar entry is navigation, not a second content area.
    //             Use it when the user needs a persistent place to reopen a feature.」
    //  —— 正是本场景。
    const PANEL_ID = 'getnote-workbench'

    /** 侧边栏图标（内联 SVG，尺寸跟 owner 给的 size 走）。 */
    function GetnoteIcon({ size = 20, active = false }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor',
        strokeWidth: active ? 2.2 : 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block', opacity: active ? 1 : 0.78 },
      },
        h('rect', { x: 3, y: 4.5, width: 18, height: 16, rx: 2.5 }),
        h('path', { d: 'M3 9.5h18' }),
        h('path', { d: 'M7.5 13.5h6' }),
        h('path', { d: 'M7.5 17h9' }))
    }

    /**
     * 主工作台。
     *
     * 数据来源：Host 侧 GET /plugins/getnote/summary
     *  —— 纯本地文件扫描（data/current/*.md 头部元数据），**不调 API、不耗配额**。
     *  这样即使凭据失效/断网，面板依然能显示本地镜像的真实状况。
     */
    function GetnoteWorkbench(props) {
      const t = (props && props.t) || (() => '')
      const T = (k, fb) => {
        try { const v = t(k); return (v && v !== k) ? v : fb } catch { return fb }
      }
      const [view, setView] = React.useState('overview')
      const [sum, setSum] = React.useState({ phase: 'loading' })

      // 拉一次统计；失败也要能看见失败原因，不要默默空白
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const r = await fetch('/plugins/getnote/summary', { credentials: 'same-origin' })
            const d = await r.json()
            if (alive) setSum(d && d.ok ? { phase: 'ready', data: d } : { phase: 'error', error: (d && d.error) || ('HTTP ' + r.status) })
          } catch (e) {
            if (alive) setSum({ phase: 'error', error: String((e && e.message) || e) })
          }
        }
        load()
        return () => { alive = false }
      }, [])

      const tabs = [
        { id: 'overview', label: T('tabOverview', '笔记现状') },
        { id: 'suggest', label: T('tabSuggest', '处理建议') },
        { id: 'apply', label: T('tabApply', '确认执行') },
        { id: 'log', label: T('tabLog', '执行日志') },
      ]

      let content
      if (view === 'overview') content = renderOverview(sum, T, h, P)
      else if (view === 'suggest') content = renderSuggest(sum, T, h, P)
      else if (view === 'apply') content = renderApply(T, h, P)
      else content = renderLog(T, h, P)

      return h('div', { style: P.root },
        h('header', { style: P.header },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h1', { style: P.title }, T('title', 'Getnote 工作台')),
            h('p', { style: P.subtitle },
              T('subtitle', '本地镜像是安全网：所有改动先在这里预演，确认后才写线上。'))),
          h('span', { style: P.pill }, T('localFirst', '本地优先'))),

        h('nav', { style: P.tabs },
          tabs.map((x) => h('button', {
            key: x.id,
            style: x.id === view ? { ...P.tab, ...P.tabActive } : P.tab,
            onClick: () => setView(x.id),
          }, x.label))),

        h('main', { style: P.body }, content))
    }

    /** 一个数字卡片。 */
    function Stat({ label, value, hint, tone }) {
      return h('div', { style: { ...P.stat, ...(tone ? P.statTone[tone] : null) } },
        h('div', { style: P.statValue }, value),
        h('div', { style: P.statLabel }, label),
        hint ? h('div', { style: P.statHint }, hint) : null)
    }

    /** 排行条：名字 + 数量 + 占比条。 */
    function RankRow({ name, count, max, suffix }) {
      const pct = max > 0 ? Math.round(count * 100 / max) : 0
      return h('div', { style: P.rankRow },
        h('div', { style: P.rankName, title: name }, name),
        h('div', { style: P.rankBarWrap },
          h('div', { style: { ...P.rankBar, width: Math.max(2, pct) + '%' } })),
        h('div', { style: P.rankCount }, String(count) + (suffix || '')))
    }

    /** 「笔记现状」页：真实数据。 */
    function renderOverview(sum, T, h, P) {
      if (sum.phase === 'loading') {
        return h('section', { style: P.card }, h('p', { style: P.muted }, T('loading', '正在读取本地镜像…')))
      }
      if (sum.phase === 'error') {
        return h('section', { style: P.card },
          h('h2', { style: P.cardTitle }, T('overviewTitle', '当前笔记现状')),
          h('p', { style: { ...P.muted, color: 'var(--dsw-alias-status-danger, #e06c75)' } },
            T('loadFail', '读取失败：') + sum.error))
      }
      const d = sum.data
      if (!d.total) {
        return h('section', { style: P.card },
          h('h2', { style: P.cardTitle }, T('overviewTitle', '当前笔记现状')),
          h('p', { style: P.muted }, T('overviewTitleEmpty', '本地镜像还是空的。先跑一次下载，Markdown 就会出现在这里。')),
          h('p', { style: P.dirLine }, d.dir))
      }

      const pctNoTopic = Math.round(d.noTopic * 100 / d.total)
      const maxCourse = d.courses.length ? d.courses[0].count : 1

      return h('div', null,
        // 数字总览
        h('div', { style: P.statRow },
          h(Stat, { label: T('statTotal', '本地镜像'), value: d.total, hint: T('statTotalHint', '篇 Markdown') }),
          h(Stat, { label: T('statNoTopic', '未归知识库'), value: d.noTopic,
            hint: pctNoTopic + '%', tone: pctNoTopic > 30 ? 'warn' : null }),
          h(Stat, { label: T('statNoTag', '无标签'), value: d.noTag,
            hint: Math.round(d.noTag * 100 / d.total) + '%', tone: 'ok' }),
          h(Stat, { label: T('statCourses', '可拆专题'), value: d.courses.length,
            hint: T('statCoursesHint', '按量排序') })),

        // 最该动手的事
        h('section', { style: { ...P.card, marginTop: 14 } },
          h('h2', { style: P.cardTitle }, T('biggestTitle', '最该先动手的地方')),
          d.courses.slice(0, 8).map((x, i) => h(RankRow, {
            key: 'c' + i, name: x.name, count: x.count, max: maxCourse,
          }))),

        // 类型分布
        h('section', { style: { ...P.card, marginTop: 14 } },
          h('h2', { style: P.cardTitle }, T('typesTitle', '笔记类型分布')),
          h('div', { style: P.chipWrap },
            Object.entries(d.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
              h('span', { key: k, style: P.chip }, k + ' ' + v)))),

        h('p', { style: P.dirLine }, T('dirLabel', '镜像目录：') + d.dir))
    }

    /** 「处理建议」页：基于真实数据推出可执行建议（规则引擎，非 AI）。 */
    function renderSuggest(sum, T, h, P) {
      if (sum.phase !== 'ready') {
        return h('section', { style: P.card }, h('p', { style: P.muted }, T('loading', '正在读取本地镜像…')))
      }
      const d = sum.data
      const items = []
      // 规则 1：大专题拆分
      d.courses.filter((x) => x.count >= 100).slice(0, 6).forEach((x) => {
        items.push({
          key: 'split-' + x.name,
          title: T('sgSplit', '把「{n}」拆成独立知识库').replace('{n}', x.name),
          detail: T('sgSplitDetail', '{c} 篇笔记挤在同一处，拆出去后其余分类才能看清。').replace('{c}', x.count),
          count: x.count, kind: T('kindSplit', '拆分'),
        })
      })
      // 规则 2：未归知识库
      if (d.noTopic > 50) {
        items.push({
          key: 'untopiced',
          title: T('sgTopic', '给 {n} 篇未归知识库的笔记补归属').replace('{n}', d.noTopic),
          detail: T('sgTopicDetail', '占比 {p}%。先按已有标签批量归类，比逐条整理快得多。')
            .replace('{p}', Math.round(d.noTopic * 100 / d.total) + '%'),
          count: d.noTopic, kind: T('kindTopic', '归类'),
        })
      }
      // 规则 3：家庭/工作二分
      items.push({
        key: 'family-work',
        title: T('sgSplit2', '建立「家庭」与「工作」两个顶层知识库'),
        detail: T('sgSplit2Detail', '两个人共用一个账号，先把大方向分开，之后所有整理都以此为基准。'),
        count: null, kind: T('kindStructure', '结构'),
      })

      if (!items.length) {
        return h('section', { style: P.card }, h('p', { style: P.muted }, T('suggestNone', '暂时没有发现需要处理的问题。')))
      }

      return h('div', null,
        h('p', { style: { ...P.muted, marginBottom: 12 } },
          T('suggestIntro', '以下是从本地镜像算出来的建议，按影响面排序。这一步只看不改，确认后才会动线上。')),
        items.map((x, i) => h('section', { key: x.key, style: { ...P.card, marginTop: i ? 10 : 0 } },
          h('div', { style: P.sgHead },
            h('span', { style: P.badge }, x.kind),
            x.count !== null ? h('span', { style: P.badgeNum }, String(x.count)) : null),
          h('h3', { style: P.sgTitle }, x.title),
          h('p', { style: P.muted }, x.detail))))
    }

    /** 「确认执行」页。 */
    function renderApply(T, h, P) {
      return h('section', { style: P.card },
        h('h2', { style: P.cardTitle }, T('applyTitle', '确认与执行')),
        h('p', { style: P.muted }, T('applyTitleEmpty', '这里会在执行前列出将要发生的每一步改动，需显式确认。')),
        h('p', { style: P.muted }, T('applyGuard', '护栏：每步都有 dry-run 预览；删除类操作默认禁止；执行后写日志可回溯。')))
    }

    /** 「执行日志」页。 */
    function renderLog(T, h, P) {
      return h('section', { style: P.card },
        h('h2', { style: P.cardTitle }, T('logTitle', '执行日志')),
        h('p', { style: P.muted }, T('logTitleEmpty', '这里会显示每次操作的请求、结果与可回溯的审计记录。')))
    }

    /** 工作台自己的样式（与设置面板的 S 分开，避免互相干扰）。 */
    function panelStyles() {
      const bd = '1px solid var(--dsh-border, rgba(255,255,255,.12))'
      const txt2 = 'var(--dsh-text-secondary, #9a9a9a)'
      return {
        root: {
          display: 'flex', flexDirection: 'column', height: '100%',
          minHeight: 0, padding: '18px 20px 0', boxSizing: 'border-box',
          color: 'var(--dsh-text-primary, #e8e8e8)',
        },
        header: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
        title: { margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.3 },
        subtitle: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: txt2 },
        pill: {
          flexShrink: 0, fontSize: 11, padding: '3px 9px', borderRadius: 999,
          background: 'var(--dsh-bg-secondary, rgba(255,255,255,.06))',
          color: txt2, border: bd,
        },
        tabs: { display: 'flex', gap: 4, borderBottom: bd },
        tab: {
          appearance: 'none', border: 'none', background: 'transparent',
          color: txt2, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
          borderBottom: '2px solid transparent', marginBottom: -1,
        },
        tabActive: {
          color: 'var(--dsh-text-primary, #e8e8e8)',
          borderBottom: '2px solid var(--dsh-accent, #4a9eff)', fontWeight: 600,
        },
        body: { flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 14, paddingBottom: 20 },
        card: {
          border: bd, borderRadius: 10, padding: 16,
          background: 'var(--dsh-bg-secondary, rgba(255,255,255,.03))',
        },
        cardTitle: { margin: '0 0 8px', fontSize: 14, fontWeight: 600 },
        muted: { margin: 0, fontSize: 12.5, lineHeight: 1.6, color: txt2 },

        // ── 数据页样式 ─────────────────────────────────────
        statRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 },
        stat: {
          border: bd, borderRadius: 10, padding: '12px 14px',
          background: 'var(--dsh-bg-secondary, rgba(255,255,255,.03))',
        },
        statTone: {
          warn: { borderColor: 'var(--dsw-alias-status-warning, #d19a66)' },
          ok: { borderColor: 'var(--dsw-alias-status-success, #98c379)' },
        },
        statValue: { fontSize: 22, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
        statLabel: { marginTop: 2, fontSize: 11.5, color: txt2 },
        statHint: { marginTop: 1, fontSize: 10.5, color: txt2, opacity: 0.75 },

        rankRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
        rankName: {
          flex: '0 0 42%', fontSize: 12, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
        rankBarWrap: {
          flex: 1, height: 6, borderRadius: 3, overflow: 'hidden',
          background: 'var(--dsh-bg-tertiary, rgba(255,255,255,.08))',
        },
        rankBar: {
          height: '100%', borderRadius: 3,
          background: 'var(--dsh-accent, #4a9eff)',
        },
        rankCount: {
          flex: '0 0 auto', fontSize: 11.5, color: txt2,
          fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right',
        },

        chipWrap: { display: 'flex', flexWrap: 'wrap', gap: 6 },
        chip: {
          fontSize: 11, padding: '3px 8px', borderRadius: 6,
          background: 'var(--dsh-bg-tertiary, rgba(255,255,255,.07))',
          color: txt2, border: bd, fontVariantNumeric: 'tabular-nums',
        },

        dirLine: { marginTop: 14, fontSize: 11, color: txt2, opacity: 0.7, wordBreak: 'break-all' },

        sgHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
        badge: {
          fontSize: 10.5, padding: '2px 7px', borderRadius: 5,
          background: 'var(--dsh-bg-tertiary, rgba(255,255,255,.08))',
          color: txt2, border: bd,
        },
        badgeNum: {
          fontSize: 10.5, padding: '2px 7px', borderRadius: 5, color: txt2,
          fontVariantNumeric: 'tabular-nums',
        },
        sgTitle: { margin: '0 0 4px', fontSize: 13, fontWeight: 600, lineHeight: 1.45 },
      }
    }
    const P = panelStyles()

    /** 单个配置字段控件。value/dirty 来自 GetnoteSettingsSection 的草稿状态。 */
    function Field({ f, t, value, dirty, configured, disabled, onChange }) {
      const label = t(f.label)
      const hint = f.hint ? t(f.hint) : null
      if (f.type === 'bool') {
        return h('div', { style: S.row },
          h('label', { style: S.boolRow },
            h('input', { type: 'checkbox', checked: !!value, disabled,
              onChange: (e) => onChange(f.key, e.target.checked) }),
            h('span', null, label)),
          hint ? h('p', { style: S.hint }, hint) : null)
      }
      // config 里已没有 secret 字段（密钥走 DSH 凭据库），这里只处理普通字段。
      return h('div', { style: S.row },
        h('label', { style: S.label, htmlFor: `gn-${f.key}` }, label),
        h('input', {
          id: `gn-${f.key}`,
          type: f.type === 'number' ? 'number' : 'text',
          step: f.type === 'number' ? 'any' : undefined,
          value: value ?? '',
          disabled,
          style: S.input,
          onChange: (e) => onChange(f.key, e.target.value),
        }),
        hint ? h('p', { style: S.hint }, hint) : null)
    }

    /**
     * 设置页里的「本地镜像现状」块。
     *
     * 为什么在设置里也放一份：侧边栏工作台是新增的 slot 注册，
     * 如果某个 DSH 版本上不生效，这里至少还能看到真实数字，不至于两眼一片黑。
     * 数据和侧边栏用的是同一个 /plugins/getnote/summary 路由。
     */
    function MirrorSummary({ t }) {
      const T = (k, fb) => {
        try { const v = t(k); return (v && v !== k) ? v : fb } catch { return fb }
      }
      const [sum, setSum] = React.useState({ phase: 'loading' })
      React.useEffect(() => {
        let alive = true
        fetch('/plugins/getnote/summary', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((d) => { if (alive) setSum(d && d.ok ? { phase: 'ready', data: d } : { phase: 'error', error: (d && d.error) || 'failed' }) })
          .catch((e) => { if (alive) setSum({ phase: 'error', error: String((e && e.message) || e) }) })
        return () => { alive = false }
      }, [])

      let inner
      if (sum.phase === 'loading') inner = h('p', { style: S.hint }, T('loading', '正在读取本地镜像…'))
      else if (sum.phase === 'error') inner = h('p', { style: S.hint }, T('loadFail', '读取失败：') + sum.error)
      else if (!sum.data.total) {
        inner = h('div', null,
          h('p', { style: S.hint }, T('overviewTitleEmpty', '本地镜像还是空的。先跑一次下载，Markdown 就会出现在这里。')),
          h('p', { style: { ...S.hint, opacity: 0.7 } }, sum.data.dir))
      } else {
        const d = sum.data
        const pct = Math.round(d.noTopic * 100 / d.total)
        inner = h('div', null,
          h('div', { style: P.statRow },
            h(Stat, { label: T('statTotal', '本地镜像'), value: d.total, hint: T('statTotalHint', '篇 Markdown') }),
            h(Stat, { label: T('statNoTopic', '未归知识库'), value: d.noTopic, hint: pct + '%', tone: pct > 30 ? 'warn' : null }),
            h(Stat, { label: T('statNoTag', '无标签'), value: d.noTag, hint: Math.round(d.noTag * 100 / d.total) + '%', tone: 'ok' })),
          d.courses.length ? h('div', { style: { marginTop: 12 } },
            h('div', { style: { ...P.muted, marginBottom: 6 } }, T('biggestTitle', '最该先动手的地方')),
            d.courses.slice(0, 5).map((x, i) => h(RankRow, {
              key: 'm' + i, name: x.name, count: x.count,
              max: d.courses[0].count,
            }))) : null,
          h('p', { style: P.dirLine }, d.dir))
      }

      return h('div', { style: S.group },
        h('div', { style: S.groupTitle }, T('mirrorTitle', '本地镜像现状')),
        inner)
    }

    /** 设置分区主体：凭据走 remote.credentials（安全），其余走 configForms。 */
    function GetnoteSettingsSection({ t, form, creds }) {
      // 防御：configForms.get() 正常不会返回 undefined（上游总是 new 一个 controller），
      // 但万一 future 重构成返回 undefined，不要整个面板崩掉——给一个空快照。
      const EMPTY_SNAP = { status: 'ready', value: {}, writable: false, revision: 0 }
      const formApi = form || {
        subscribe: () => () => {},
        getSnapshot: () => EMPTY_SNAP,
        mutate: async () => false,
      }
      const snap = React.useSyncExternalStore(
        (cb) => formApi.subscribe(cb),
        () => formApi.getSnapshot() || EMPTY_SNAP,
      )
      const [draft, setDraft] = React.useState(null)   // null = 未开始编辑，跟随 snap
      const [saving, setSaving] = React.useState(false)
      const [saved, setSaved] = React.useState(false)
      const [error, setError] = React.useState(null)

      const ready = snap.status === 'ready' && snap.value && typeof snap.value === 'object'
      const disabled = !ready || !snap.writable || saving

      // 快照 revision 变化（别处改了这个命名空间）时丢弃草稿；保存失败则保留草稿供重试。
      React.useEffect(() => {
        if (!saving) setDraft(null)
      }, [snap.revision, snap.status])
      // —— 凭据状态（安全存储）——
      // remote.credentials.describe(ref) 只返回 {configured, source, writable}，永不返回值。
      // 首次渲染拉一次；保存后重拉。
      const REF_API_KEY = 'GETNOTE_API_KEY'
      const REF_CLIENT_ID = 'GETNOTE_CLIENT_ID'
      const [credState, setCredState] = React.useState({ apiKey: null, clientId: null, loading: true })
      const [keyDraft, setKeyDraft] = React.useState('')
      const [idDraft, setIdDraft] = React.useState('')
      const [credSaving, setCredSaving] = React.useState(false)
      const [credMsg, setCredMsg] = React.useState(null)
      const [credErr, setCredErr] = React.useState(null)

      const readCreds = React.useCallback(async () => {
        if (!creds) { setCredState({ apiKey: null, clientId: null, loading: false }); return }
        try {
          const res = await creds.describe([REF_API_KEY, REF_CLIENT_ID])
          // 兼容两种返回形态：信封 {ok, value} 或裸对象 {ref: info}
          const map = (res && res.ok === true && res.value) ? res.value
            : (res && res.value && typeof res.value === 'object' && !res[REF_API_KEY]) ? res.value
            : res
          if (map && typeof map === 'object') {
            setCredState({
              apiKey: map[REF_API_KEY] || { configured: false, writable: true },
              clientId: map[REF_CLIENT_ID] || { configured: false, writable: true },
              loading: false,
              servicePresent: true,
            })
          } else {
            setCredState({ apiKey: null, clientId: null, loading: false, servicePresent: true })
          }
        } catch { setCredState({ apiKey: null, clientId: null, loading: false }) }
      }, [creds])

      React.useEffect(() => { readCreds() }, [readCreds])

      const saveCreds = async () => {
        if (!creds) return
        setCredSaving(true); setCredErr(null); setCredMsg(null)
        try {
          let wrote = false
          if (keyDraft.trim()) { await creds.set(REF_API_KEY, keyDraft.trim()); wrote = true }
          if (idDraft.trim()) { await creds.set(REF_CLIENT_ID, idDraft.trim()); wrote = true }
          if (!wrote) { setCredMsg(t('credSaved')); setCredSaving(false); return }
          setKeyDraft(''); setIdDraft('')
          await readCreds()
          // 关键：保存后同时刷新接入信息卡。否则卡片还停在保存前的
          // 「凭据未配置 / 会员未知」，你会以为没生效。带 refresh=1 绕过 5s 缓存。
          await fetchStatus(false, true)
          setCredMsg(t('credSaved'))
        } catch (err) {
          setCredErr(t('credFailed'))
        } finally { setCredSaving(false) }
      }

      const clearCreds = async () => {
        if (!creds) return
        setCredSaving(true); setCredErr(null); setCredMsg(null)
        try {
          // 逐个清，单个失败不阻断另一个（比如两个 ref 只有一个存在）。
          const errors = []
          for (const ref of [REF_API_KEY, REF_CLIENT_ID]) {
            try { await creds.unset(ref) } catch (e) { errors.push(ref) }
          }
          await readCreds()
          await fetchStatus(false, true)
          // 全失败才算失败；有存下就报已删除。
          if (errors.length === 2) setCredErr(t('credFailed'))
          else setCredMsg(t('credCleared'))
        } catch { setCredErr(t('credFailed')) }
        finally { setCredSaving(false) }
      }

      const current = (key) => {
        const base = ready ? getPath(snap.value, key) : undefined
        if (draft && Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
        return base
      }
      const isDirty = (key) => !!(draft && Object.prototype.hasOwnProperty.call(draft, key))
      const onChange = (key, v) => {
        setSaved(false)
        setError(null)
        setDraft((d) => ({ ...(d || {}), [key]: v }))
      }
      const pending = draft ? Object.entries(draft) : []

      // —— 接入信息 ——
      // 从 Host 的 /plugins/getnote/status 拉取（runGn doctor 的原文 + 凭据来源）。
      const [status, setStatus] = React.useState(null)
      const [testing, setTesting] = React.useState(false)
      const fetchStatus = async (live, refresh) => {
        try {
          const qs = []
          if (live) qs.push('live=1')
          if (refresh) qs.push('refresh=1')   // 绕过 Host 的 5s 缓存
          const url = `/plugins/getnote/status${qs.length ? '?' + qs.join('&') : ''}`
          const r = await fetch(url, {
            credentials: 'same-origin',
          })
          if (!r.ok) return null
          const j = await r.json()
          setStatus(j)
          return j
        } catch { return null }
      }
      const onTest = async () => {
        setTesting(true)
        await fetchStatus(true)
        setTesting(false)
      }
      // 首次挂载就拉一次本地检查（不打网络），这样你打开面板立刻能看到
      // API 地址 / 数据目录 / 自检结果。点「测试连接」才会带 live=1 打真网络。
      React.useEffect(() => { fetchStatus(false) }, [])

      const onSave = async () => {
        if (!pending.length) { setSaved(true); return }
        setSaving(true)
        setError(null)
        try {
          // 逐个字段写：清空 = unset（回落默认值，不写入空串）
          const ops = []
          for (const [key, raw] of pending) {
            const f = FIELDS.find((x) => x.key === key)
            if (!f) continue
            const pathArr = key.split('.')
            const empty = raw === '' || raw == null
            if (empty) {
              ops.push({ op: 'unset', path: pathArr })
              continue
            }
            if (f.type === 'number') {
              const n = Number(raw)
              if (!Number.isFinite(n)) throw new Error(`${key}: not a finite number`)
              ops.push({ op: 'set', path: pathArr, value: n })
              continue
            }
            if (f.type === 'bool') {
              ops.push({ op: 'set', path: pathArr, value: !!raw })
              continue
            }
            // configForms.mutate 用 path 数组；media.images 是嵌套路径
            ops.push({ op: 'set', path: pathArr, value: String(raw) })
          }
          if (!ops.length) { setDraft(null); setSaved(true); return }
          // mutate 返回 false 表示 Host 拒绝（冲突或校验失败），此时必须保留草稿
          const ok = await formApi.mutate(ops, snap.revision)
          if (ok) {
            setDraft(null)
            setSaved(true)
          } else {
            setError(t('saveFailed'))
          }
        } catch (err) {
          setError(t('saveFailed'))
        } finally {
          setSaving(false)
        }
      }
      const onDiscard = () => { setDraft(null); setSaved(false) }

      const groups = {}
      for (const f of FIELDS) (groups[f.group] ||= []).push(f)

      // 凭据区块（安全输入）
      const credField = (labelKey, hintKey, value, onChange, state) =>
        h('div', { style: S.row, key: labelKey },
          h('label', { style: S.label, htmlFor: `gn-${labelKey}` }, t(labelKey)),
          h('input', {
            id: `gn-${labelKey}`,
            type: 'password',
            value,
            autoComplete: 'off',
            style: S.input,
            disabled: credSaving || (state && state.writable === false),
            placeholder: state && state.configured ? t('secretPlaceholder') : t('secretEmpty'),
            onChange: (e) => onChange(e.target.value),
          }),
          h('p', { style: S.hint }, t(hintKey)),
          state && state.configured
            ? h('p', { style: S.hint }, `${t('originLabel')}: ${state.source || 'file'}`)
            : null)

      const credBlock = h('div', { style: S.group },
        h('h3', { style: S.groupTitle }, t('credTitle')),
        h('p', { style: S.hint }, t('credExplain')),
        credField('apiKey', 'apiKeyHint2', keyDraft, setKeyDraft, credState.apiKey),
        credField('clientId', 'clientIdHint2', idDraft, setIdDraft, credState.clientId),
        h('div', { style: S.footer },
          h('button', { style: { ...S.btn, ...S.primary },
            disabled: credSaving || !creds, onClick: saveCreds },
            credSaving ? t('savingCred') : t('saveCred')),
          // 凭据库空的时候不开放“清除”：unset 对不存在的 ref 会报错，
          // 让你看到一个没头没脑的“失败”。归一化后两个都配好才可点。
          h('button', {
            style: S.danger,
            disabled: credSaving || !creds || !(credState.apiKey && credState.apiKey.configured)
              && !(credState.clientId && credState.clientId.configured),
            onClick: clearCreds },
            t('credClear')),
          credMsg ? h('span', { style: S.status }, credMsg) : null,
          credErr ? h('span', { style: S.bad }, credErr) : null),
        credState.apiKey && credState.apiKey.writable === false
          ? h('p', { style: S.status }, t('credNotWritable')) : null,
        credState.servicePresent === false
          ? h('p', { style: S.bad }, t('credNoService')) : null)

      // 接入信息区块
      const statusBlock = h('div', { style: S.group },
        h('h3', { style: S.groupTitle }, t('statusTitle')),
        h('p', { style: S.hint }, t('statusIntro')),
        h('div', { style: S.footer },
          h('button', { style: S.btn, disabled: testing, onClick: onTest },
            testing ? t('testing') : t('testConn')),
          status
            ? h('span', { style: status.ok ? S.ok : S.bad },
                status.ok ? t('connOk') : t('connFail'))
            : null),
        status
          ? h('div', { style: S.card },
              h('div', { style: S.kv },
                h('span', { style: S.k }, t('originLabel')),
                h('span', { style: S.v }, status.origin || 'none'),
                h('span', { style: S.k }, 'API Key'),
                h('span', { style: S.v }, status.apiKeySet ? '✅' : '—'),
                h('span', { style: S.k }, 'Client ID'),
                h('span', { style: S.v }, status.clientIdSet ? '✅' : '—'),
                h('span', { style: S.k }, t('apiBaseLabel')),
                h('span', { style: S.v }, status.apiBase || '—'),
                h('span', { style: S.k }, t('dataDirLabel')),
                h('span', { style: S.v }, status.dataDir || '—'),
                h('span', { style: S.k }, t('memberLabel')),
                h('span', { style: status.member && status.member.ok ? S.ok : (status.member && status.member.ok === false ? S.bad : S.v) },
                  status.member && status.member.reported
                    ? status.member.text
                    : t('memberUnknown')),
                ...(status.quota && Object.keys(status.quota).length
                  ? Object.keys(status.quota).sort().flatMap((k) => [
                      h('span', { style: S.k, key: 'qk-' + k }, k),
                      h('span', { style: S.v, key: 'qv-' + k }, status.quota[k]),
                    ])
                  : [h('span', { style: S.k, key: 'qk' }, t('quotaLabel')),
                     h('span', { style: S.v, key: 'qv' }, status.live ? t('quotaNone') : t('quotaNeedLive'))])),
              h('pre', { style: S.pre }, status.text || ''))
          : h('p', { style: S.status }, t('noStatus')))

      // 怎么用区块（带「复制说明」按钮：先试 navigator.clipboard，失败则选中文本）
      const [copied, setCopied] = React.useState(false)
      const [copyHint, setCopyHint] = React.useState(null)
      const copyUsage = async () => {
        const lines = [t('usageTitle'), '', t('usageIntro'), '']
        for (let n = 1; n <= 6; n++) lines.push('• ' + t(`usage${n}`))
        lines.push('', t('usageSafety'))
        const textAll = lines.join('\n')
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(textAll)
          } else {
            throw new Error('no clipboard api')
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          // 回退：选中 usage 区域的文本，用户 Ctrl+C 即可
          try {
            const el = document.getElementById('gn-usage')
            if (el) {
              const sel = window.getSelection()
              const range = document.createRange()
              range.selectNodeContents(el)
              sel.removeAllRanges(); sel.addRange(range)
            }
          } catch { /* ignore */ }
          // 回退路径必须明说：此时文本只是被选中，并没进剪贴板。
          // 不说的话你按一下按钮见没反应，会以为复制成功了。
          setCopied(false)
          setCopyHint(t('copiedManual'))
          setTimeout(() => setCopyHint(null), 6000)
        }
      }
      // 数据目录"存在哪·存什么"：不依赖 status（status 拿不到时也要能看）。
      const dirBase = (() => {
        const raw = ready ? getPath(snap.value, 'dataDir') : undefined
        const d = (typeof raw === 'string' && raw) ? raw : 'getbraindata'
        const abs = /^[A-Za-z]:[\\/]/.test(d) || d.startsWith('/')
        return { raw: d, abs }
      })()
      const dataDirExplain = h('div', { style: S.dirBox },
        h('p', { style: S.dirHead }, t('dirHead')),
        h('p', { style: S.dirLine },
          h('span', { style: S.dirK }, t('dirWhere')),
          h('code', { style: S.code }, dirBase.raw)),
        h('p', { style: S.dirLine },
          h('span', { style: S.dirK }, t('dirResolved')),
          h('span', { style: S.dirV },
            dirBase.abs ? t('dirAbsolute') : t('dirRelToWorkspace'))),
        h('p', { style: S.dirLine },
          h('span', { style: S.dirK }, t('dirWhat')),
          h('span', { style: S.dirV }, t('dirWhatVal'))),
        h('p', { style: S.dirLine },
          h('span', { style: S.dirK }, t('dirMedia')),
          h('span', { style: S.dirV }, t('dirMediaVal'))),
        // 用户实际困惑的点：装完就看到 downloads/ 是空的，以为坏了。
        // 明确告知“什么时候才会生成”。
        h('p', { style: S.dirLine },
          h('span', { style: S.dirK }, t('dirWhen')),
          h('span', { style: S.dirV }, t('dirWhenVal'))))

      const usageBlock = h('div', { style: S.group },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('h3', { style: { ...S.groupTitle, flex: 1 } }, t('usageTitle')),
          h('button', { style: S.btn, onClick: copyUsage },
            copied ? t('copied') : t('copyUsage')),
          copyHint ? h('span', { style: S.hint }, copyHint) : null),
        h('div', { id: 'gn-usage' },
          h('p', { style: S.hint }, t('usageIntro')),
          h('ul', { style: S.ul },
            ...[1, 2, 3, 4, 5, 6].map((n) => h('li', { key: n }, t(`usage${n}`)))),
          h('p', { style: S.note }, t('usageSafety'))))

      return h('div', { style: S.section },
        h('h2', { style: S.h2 }, t('title')),
        h('p', { style: S.p }, t('intro')),
        !ready ? h('p', { style: S.status },
          snap.status === 'loading' ? t('loading') : t('unavailable')) : null,
        ready && !snap.writable ? h('p', { style: S.status }, t('readonly')) : null,
        error ? h('p', { style: S.status }, error) : null,
        // 1) 优先展示安全凭据输入
        credBlock,
        // 2) 其余非秘密配置
        ...Object.keys(groups).map((g) =>
          h('div', { style: S.group, key: g },
            h('h3', { style: S.groupTitle }, t(g)),
            ...groups[g].map((f) => h(Field, {
              key: f.key, f, t,
              value: current(f.key), dirty: isDirty(f.key),
              disabled, onChange,
            })),
            // 数据目录组后面直接显示「存在哪、存什么」，不用去猜。
            g === 'groupData' ? h('div', { style: S.pathBox }, dataDirExplain) : null)),
        h('div', { style: S.footer },
          h('button', { style: { ...S.btn, ...S.primary }, disabled: disabled || !pending.length,
            onClick: onSave }, saving ? t('saving') : t('save')),
          h('button', { style: S.btn, disabled: disabled || !pending.length,
            onClick: onDiscard }, t('discard')),
          saved && !pending.length ? h('span', { style: S.status }, t('saved')) : null),
        // 3) 接入信息
        statusBlock,
        // 3.5) 本地镜像现状（降级入口：侧边栏工作台没能显示时，这里也能看到数字）
        h(MirrorSummary, { t }),
        // 4) 怎么用
        usageBlock,
        h('p', { style: S.note }, t('restartHint')),
        h('p', { style: S.note }, t('guideHint')))
    }

    return {
      name: 'getnote',
      inject: ['slots', 'locale', 'configForms', 'remote'],
      apply(ctx) {
        // 文案词典
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'getnote: settings dictionaries')
        const t = ctx.locale.bind(NS)
        // 绑定到本插件行（profile entry id = include:getnote）的共享配置表单
        const form = pickForm(ctx.configForms)
        // 凭据库：remote.credentials 由 @deepseek-ai/dsh-api-settings-controller 暴露。
        // remote 是 inject 里声明的服务，按 Cordis 惯例直接点属性取（官方客户端也是这么写的：
        // ctx.remote.settings.openSettingsDocument）。credentials 是它下面的命名空间，
        // 所以取 ctx.remote.credentials；同时兼容 ctx.get('remote') 这类代理路径。
        const pickCreds = () => {
          const tries = []
          try { if (ctx.remote && ctx.remote.credentials) tries.push(ctx.remote.credentials) } catch { /* service absent */ }
          try { const r = typeof ctx.get === 'function' ? ctx.get('remote') : undefined
                if (r && r.credentials) tries.push(r.credentials) } catch { /* proxy refuses */ }
          try { const c = typeof ctx.get === 'function' ? ctx.get('remote.credentials') : undefined
                if (c) tries.push(c) } catch { /* proxy refuses */ }
          return tries.length ? tries[0] : undefined
        }
        const creds = pickCreds()
        const injected = () => ({ t, form, creds })

        // 顶层设置侧边栏分区（与「通用」「插件」同级）。
        // 用 ctx.effect 包裹，卸载时注销（与 dsh-rag client.js 一致的写法）。
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'getnote',
          order: 60,
          label: () => t('nav'),
          locale: NS,
          inject: injected,
        }, GetnoteSettingsSection)), 'getnote: settings section')

        // ── 左侧边栏工作台 ───────────────────────────────────────
        // 两个 slot 必须用**同一个 id**：
        //   sidebar.panellist 出图标，main 出内容，id 一致才会互相寻址。
        // 官方已占用 main 的 key：conversation / plugin-manager / schedule，
        // 我们用 'getnote-workbench'，不会覆盖任何东西。
        // 官方写法对照（本轮从 app.asar 实际源码里挖出来的）：
        //   plugins 面板：{ name:'sidebar.panellist', id:PANEL_ID, order:0,  label:()=>t('panel'), locale:NS }
        //   schedule 面板：{ name:'sidebar.panellist', id:PANEL_ID, order:10, locale:MANAGER_NS, label:()=>t('panel') }
        //   main：   { name:'main', key:PANEL_ID, locale:NS, store, inject:()=>({...}) }
        // 两个关键点之前没做对：
        //   1) 都要带 locale，否则 label 的 thunk 不会被重读，且导航行拿不到文字；
        //   2) main 的 inject 要展开成对象（不是函数只返回 t），否则 props 结构不对。
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 55,
          label: () => t('panelName'),
          locale: NS,
        }, GetnoteIcon)), 'getnote: sidebar icon')

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, GetnoteWorkbench)), 'getnote: main panel')

        // 上报注册结果，给 Agent 做黑盒验证用（失败了不影响界面）。
        // 能看到这条 GET /plugins/getnote/report 返回 sidebar.ok=true，
        // 就说明 slot 注册这件事在浏览器端真的执行了。
        try {
          const probe = {
            ts: new Date().toISOString(),
            panelId: PANEL_ID,
            sidebar: { attempted: true, ok: true },
            main: { attempted: true, ok: true },
            slotsApi: {
              inject: typeof ctx.slots.inject === 'function',
              register: typeof ctx.slots.register === 'function',
              entriesOfSlot: typeof ctx.slots.entriesOfSlot === 'function',
            },
            locale: NS,
            hasT: typeof t === 'function',
          }
          // 顺手报一下 sidebar.panellist 里现在有几项（含官方的），
          // 这样能区分“我没注册上”和“注册上了但没渲染”。
          try {
            const list = ctx.slots.entriesOfSlot && ctx.slots.entriesOfSlot('sidebar.panellist')
            probe.sidebar.totalEntries = Array.isArray(list) ? list.length : null
            probe.sidebar.ids = Array.isArray(list)
              ? list.map((e) => e && e.options && e.options.id).filter(Boolean)
              : null
          } catch (e2) { probe.sidebar.entriesError = String((e2 && e2.message) || e2) }
          fetch('/plugins/getnote/report', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(probe),
          }).catch(() => {})
        } catch { /* 上报失败不能影响插件 */ }
      },
    }
  },
})
