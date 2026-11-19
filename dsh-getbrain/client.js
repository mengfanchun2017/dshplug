/**
 * dsh-getbrain —— 浏览器半区（Client 插件）
 *
 * 在 DSH「设置」里注册一个**顶层侧边栏分区 Mgetbrain**（settings.section），
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
  nav: 'Mgetbrain',
  // 左侧边栏图标的名字（sidebar.panellist 的 label）
  panelName: 'Mgetbrain',
  tabStructure: '分类调整',
  tabOverview: '笔记现状',
  tabSuggest: '处理建议',
  tabApply: '确认执行',
  tabLog: '执行日志',
  localFirst: '本地优先',
  subtitle: '先在这里看真实层级、改分类，确认后才写线上。',
  // —— 分类调整页 ——
  invTitle: '层级清单',
  invLoading: '正在本地重建层级（不联网，扫 4000+ 个文件头，约 1–3 秒）…',
  invFail: '读取失败：',
  invFailHint: '多半是本地镜像还没下载。先在会话里说「用 getnote_download 全量下载」。',
  invEmpty: '本地镜像还是空的，没有可分类的内容。',
  loadFail: '读取失败：',
  mirrorTitle: '本地镜像现状',
  statTotal: '本地镜像',
  statTotalHint: '篇 Markdown',
  statNoTopic: '未归知识库',
  statNoTag: '无标签',
  statCourses: '可拆专题',
  statCoursesHint: '按量排序',
  biggestTitle: '最该先动手的地方',
  typesTitle: '笔记类型分布',
  dirLabel: '镜像目录：',
  applyGuard: '先干跑预览，确认后才发写请求。',
  invIntro: '这棵树是从本地镜像重建的真实结构：知识库 → 目录（专栏/课程）→ 书 → 讲 → 划线。官方 API 里知识库是平的、没有文件夹，所以层级只存在于这里。',
  invStat: '共 {t} 条笔记，未归知识库 {u} 条，无来源 {s} 条。',
  // —— 顶层分三类（自建库 / 待归类 / 电子书书架）——
  secOwnKb: '我的知识库',
  secOwnKbHint: '{n} 个',
  secOwnKbEmpty: '还没有自建知识库。',
  secUntopiced: '待归类',
  secUntopicedHint: '{n} 条没归库',
  untopicedName: '未归知识库',
  secShelf: '电子书书架',
  secShelfHint: '{n} 个 · 得到自动生成',
  shelfShow: '展开书架（买过的书，共 {n} 个）',
  shelfHide: '收起书架（买过的书）',
  badgeShelf: '书',
  secUnknown: '未区分',
  secUnknownHint: '未拉取 scope 缓存，分不出是库还是书架',
  secUnknownAction: '跑一次 gn.py kb-scopes 就能分清楚。',
  // —— 自动归类页 ——
  tabAuto: '自动归类',
  autoTitle: '自动归类',
  autoSub: '按作者 / 训练营 / 大课程成批归库，只生成计划',
  autoWhy: '规则一共四条，每条都能解释：① 作者系列（如「万维钢·精英日课6」→ 万维钢）；② 训练营；③ 单目录 ≥ 30 条；④ 其余不动。',
  autoWhy2: '为什么不全自动：零碎目录平均只有 1.7 条笔记，强行归一起只会造出新的垃圾库。',
  autoBuild: '生成归类计划（只算，不写）',
  autoBuilding: '正在生成计划…',
  autoScope: '当前可归类：{n} 条未归库。',
  autoIdle: '点上面的按钮生成计划。生成只是算一遍本地镜像，不联网、不改线上。',
  autoLoading: '正在扫 4000+ 个文件头并按规则分组…',
  autoFail: '生成失败：',
  autoStatGroups: '拟建知识库',
  autoStatGroupsHint: '成规模的组',
  autoStatMove: '将归位',
  autoStatMoveHint: '条笔记',
  autoStatKeep: '不动',
  autoStatKeepHint: '零碎目录，保留原样',
  autoStatActions: '动作数',
  autoStatActionsHint: '干跑后再真写',
  autoGroupsTitle: '会建成这些知识库',
  autoSkipTitle: '不动的（保持原样）',
  autoSkipWhy: '这些目录太小（平均 1.7 条），单独建库只会得到一堆空库。想看完整清单点下面的干跑。',
  autoNextTitle: '下一步',
  autoNext: '先干跑：不发任何请求，只把每批 20 条的完整清单打出来。确认无误再回「确认执行」页真写。',
  autoDry: '先干跑（不发包）',
  autoRunning: '执行中…',
  // —— AI 动作页 ——
  tabAI: 'AI 动作',
  aiTitle: 'AI 动作',
  aiSub: '发芽 / 审问 / 连线：取素材 + 可改的提示词，结果不自动写回',
  aiHow: '填一条笔记的 id（在「分类调整」里展开到「讲」能看到），先生成素材包，再点按钮。',
  aiNoteIdPh: '笔记 id（数字）',
  aiLoadPack: '取素材包',
  aiPacking: '正在取素材…',
  aiPacking2: '正在扫本地镜像找相关上下文…',
  aiPackFail: '取出失败：',
  aiCheckSprout: '查平台发芽',
  aiSproutHas: '平台侧已有发芽内容，已取回。',
  aiSproutNone: '平台侧还没有发芽。要生成，用下面的按钮由 AI 做；或在得到 App 里点发芽。',
  aiPackTitle: '素材包（AI 会看到这些）',
  aiPackCenter: '中心：',
  aiPackSiblings: '同系列：',
  aiPackRelated: '跨系列相关：',
  aiSibTitle: '同系列的讲：',
  aiRelTitle: '跨系列相关（命中词）：',
  aiActsTitle: '动作（每个按钮绑一份提示词）',
  aiPromptLabel: '它会这样问 AI（可在 dataDir/prompts 里改）：',
  aiBuild: '拼好发给 AI 的内容',
  aiBuildHint: '复制后粘到会话里，或直接说「用这个跑一次」',
  aiPayloadTitle: '要发给 AI 的内容',
  aiCopy: '复制',
  aiIdle: '先填一个笔记 id 并点「取素材包」。只有素材包存在时，按钮才会出现。',
  applyEmptyUndoHint: '若刚才已经写过，可直接在下面回退。',
  // —— 撤销区 ——
  undoTitle: '撤销',
  undoSub: '只还原知识库/标签归属，不删笔记',
  undoLoading: '正在读撤销记录…',
  undoFail: '读撤销记录失败：',
  undoNone: '没有可撤销的批次。每次真写前会自动拍一份归属快照，撤销就靠它。',
  // —— 删除区 ——
  delTitle: '删除笔记',
  delSub: '单程票：平台删除可能不进回收站，本工具会先存本地副本',
  delExpand: '展开删除区',
  delCollapse: '收起',
  delWarn: '官方 FAQ 自列 bug：删除后可能直接彻底删除、不进回收站。所以：① 每次只删一条；② 删前先把正文存到本地 trash/；③ 存不下就拒绝删除。',
  delIdLabel: '笔记 ID',
  delIdPh: '数字 ID（可从勾选带入）',
  delResolving: '正在解析…',
  delUseSel: '用勾选的那一条',
  delSelNeed: '先在上面的树上勾选要删的那一篇，或直接填 ID',
  delAck: '我知道删除可能不可恢复',
  delDry: '干跑（先备份到 trash/，不删）',
  delArm: '准备删除…',
  delReally: '真的删掉（不可恢复）',
  delOk: '完成。',
  delOkDry: '（干跑，线上未动）',
  delFail: '失败：',
  delTrashAt: '本地副本：',
  undoHint: '第一步是干跑，不会发包。确认清单对再点真撤销。',
  undoNotes: '{n} 条',
  undoDry: '干跑',
  undoRealArm: '我要撤销 → 再点一次',
  undoRealNow: '确认撤销',
  undoRunning: '正在撤销…',
  undoDone: '完成',
  undoErr: '失败：',
  undoDoneList: '已撤销的批次：',
  undoStatusUndone: '已撤销',
  unitLectures: ' 条',
  unitNotes: ' 条',
  selCount: '已选 {n} 讲',
  selClear: '清空',
  selToPlan: '生成调整计划 →',
  selHint: '每一层都能勾：选知识库 = 整个库，选目录 = 整个系列，选讲 = 单篇。',
  selHintKb: '选中整个知识库',
  selHintCourse: '选中整个目录',
  selHintBook: '选中整本书',
  applyEmpty: '还没有计划。先去「分类调整」勾选要动的笔记，生成计划。',
  applyBuilding: '正在把选中的层级解析成具体笔记，并生成计划（不联网）…',
  applyFail: '生成计划失败：',
  applySummary: '共 {n} 个动作。这一步只预览，不连网；点下面的按钮才真正写线上。',
  applyDryRun: '先干跑（不发写请求）',
  applyRunning: '执行中…',
  applyRealArm: '我要真写 → 需再点一次',
  applyRealNow: '确认写入线上（不可撤销）',
  applyErr: '失败：',
  colOp: '动作',
  colTarget: '目标',
  colCount: '条数',
  targetKb: '知识库 ',
  moreRows: '…还有 {n} 个动作未展开',
  planFile: '计划文件：',
  targetLabel: '归到：',
  targetKbOpt: '知识库',
  targetTagOpt: '标签',
  topicIdPh: 'topic_id',
  kbPickPh: '选择知识库…',
  kbPickNew: '＋ 新建知识库（手填名字）',
  kbNewNamePh: '新库名',
  tagPh: '新标签名',
  logLoading: '正在读日志…',
  logFail: '读日志失败：',
  logReload: '刷新',
  logEmpty: '还没有执行记录。所有写操作都会落到 <数据目录>/logs/ 下的审计文件。',
  overviewTitle: '当前笔记现状',
  overviewTitleEmpty: '本地镜像还是空的。先跑一次下载，Markdown 就会出现在这里。',
  applyTitle: '确认与执行',
  logTitle: '执行日志',
  title: 'Mgetbrain · 得到大脑笔记整理',
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
  dataDirHint: '下载 / 中间产物 / 快照 / 日志 / 审计 / 计划全归它。留空 = 用下面那个默认值（首次运行自动创建）；相对路径相对工作区根，改绝对路径则直接用。',
  dataDirDefault: '（留空 = 默认值，首次运行自动创建）',
  dirDefaultDerived: '留空 → 由代码推导，规则是「仓库所在目录的上一级」+ data-<插件短名>',
  dirExample: '例：仓库在 C:\\dsh\\dshplug，插件在 C:\\dsh\\dshplug\\dsh-getbrain → 数据落在 C:\\dsh\\data-getbrain，与 dshplug 平级，不在 Git 里。',
  dirExampleLabel: '具体例子',
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
  guideHint: '完整说明见插件目录里的 README.md（dsh-getbrain\\README.md），不在数据目录。',

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
  statusIntro: '打开本页会自动跑一次 gn.py doctor：纯本地检查（解释器、目录、限速、凭据来源），不联网、不耗配额，跟会话里的 getnote_doctor 是同一条命令。下面那个「测试连接」不是同一件事——它是 doctor --live，会真发一次只读请求。',
  testConn: '测试连接（doctor --live，耗 1 次配额）',
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
  quotaNeedLive: '点「测试连接」后才有（doctor --live 会真发一次请求）',
  copyUsage: '复制说明',
  copied: '已复制 ✓',
  copiedManual: '浏览器不允许直接写剪贴板；已帮你选中下方文字，按 Ctrl+C 复制。',
  noStatus: '本地自检（doctor）还没回来——刷新页面重试。',

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
  nav: 'Mgetbrain',
  panelName: 'Mgetbrain',
  tabStructure: 'Organize',
  tabOverview: 'Current state',
  tabSuggest: 'Suggestions',
  tabApply: 'Review & apply',
  tabLog: 'Activity log',
  localFirst: 'Local first',
  subtitle: 'See the real hierarchy here, adjust categories, and only write to the server after you confirm.',
  invTitle: 'Hierarchy',
  invLoading: 'Rebuilding the hierarchy locally (offline; scanning 4000+ file headers, ~1–3s)…',
  invFail: 'Failed to read: ',
  invFailHint: 'Most likely the local mirror has not been downloaded yet. Ask "download all notes with getnote_download" in a session first.',
  invEmpty: 'The local mirror is empty — nothing to classify yet.',
  loadFail: 'Load failed: ',
  mirrorTitle: 'Local mirror',
  statTotal: 'Local mirror',
  statTotalHint: 'Markdown files',
  statNoTopic: 'No knowledge base',
  statNoTag: 'No tags',
  statCourses: 'Splittable series',
  statCoursesHint: 'sorted by size',
  biggestTitle: 'Where to start',
  typesTitle: 'Note types',
  dirLabel: 'Mirror dir: ',
  applyGuard: 'Dry-run first; nothing is sent until you confirm.',
  invIntro: 'This tree is rebuilt from the local mirror: knowledge base → series (course/column) → book → lecture → highlight. The official API has flat topics with no folders, so the hierarchy exists only here.',
  invStat: '{t} notes total, {u} not in any knowledge base, {s} without a source.',
  // —— top level is split into three kinds ——
  secOwnKb: 'My knowledge bases',
  secOwnKbHint: '{n}',
  secOwnKbEmpty: 'No self-built knowledge base yet.',
  secUntopiced: 'Unfiled',
  secUntopicedHint: '{n} notes not in any KB',
  untopicedName: 'No knowledge base',
  secShelf: 'Ebook shelves',
  secShelfHint: '{n} · generated by 得到',
  shelfShow: 'Show shelves ({n} books you have bought)',
  shelfHide: 'Hide shelves (bought books)',
  badgeShelf: 'book',
  secUnknown: 'Unclassified',
  secUnknownHint: 'scope cache missing — cannot tell KBs from shelves',
  secUnknownAction: 'Run gn.py kb-scopes once to tell them apart.',
  // —— auto-classify tab ——
  tabAuto: 'Auto-classify',
  autoTitle: 'Auto-classify',
  autoSub: 'Group by author / bootcamp / large series; builds a plan only',
  autoWhy: 'Four rules, each explainable: (1) author series (e.g. Wan Weigang · Elite Daily 6 → 万维钢); (2) bootcamps; (3) a single series with 30+ notes; (4) everything else untouched.',
  autoWhy2: 'Why not fully automatic: leftover series average 1.7 notes each; forcing them together only creates new junk KBs.',
  autoBuild: 'Build classification plan (computes only, writes nothing)',
  autoBuilding: 'Building the plan…',
  autoScope: 'Currently classifiable: {n} unfiled notes.',
  autoIdle: 'Click the button to build a plan. It only recomputes the local mirror — no network, no changes online.',
  autoLoading: 'Scanning 4000+ file headers and grouping by rule…',
  autoFail: 'Build failed: ',
  autoStatGroups: 'KB to create',
  autoStatGroupsHint: 'groups large enough',
  autoStatMove: 'To be filed',
  autoStatMoveHint: 'notes',
  autoStatKeep: 'Untouched',
  autoStatKeepHint: 'tiny series, left as is',
  autoStatActions: 'Actions',
  autoStatActionsHint: 'dry-run before writing',
  autoGroupsTitle: 'These knowledge bases will be created',
  autoSkipTitle: 'Left as is',
  autoSkipWhy: 'These series are too small (1.7 notes on average); creating a KB for each yields a pile of empty shells. Hit dry-run below for the full list.',
  autoNextTitle: 'Next step',
  autoNext: 'Dry-run first: no requests sent, it just prints each 20-note batch. Once that looks right, go to "Apply" and write for real.',
  autoDry: 'Dry-run (sends nothing)',
  autoRunning: 'Running…',
  // —— AI actions tab ——
  tabAI: 'AI actions',
  aiTitle: 'AI actions',
  aiSub: 'Sprout / Interrogate / Link: fetch context + editable prompts; results are never written back',
  aiHow: 'Enter a note id (expand to a lecture under Organize to see one), load the context pack, then pick an action.',
  aiNoteIdPh: 'note id (digits)',
  aiLoadPack: 'Load context pack',
  aiPacking: 'Fetching context…',
  aiPacking2: 'Scanning the local mirror for related context…',
  aiPackFail: 'Failed: ',
  aiCheckSprout: 'Check platform sprout',
  aiSproutHas: 'The platform already has sprout content; fetched it.',
  aiSproutNone: 'No sprout on the platform yet. Generate it below with AI, or tap sprout in the app.',
  aiPackTitle: 'Context pack (what the AI sees)',
  aiPackCenter: 'Center: ',
  aiPackSiblings: 'Same series: ',
  aiPackRelated: 'Cross-series related: ',
  aiSibTitle: 'Other lectures in the same series:',
  aiRelTitle: 'Cross-series related (matched terms):',
  aiActsTitle: 'Actions (each button binds one prompt)',
  aiPromptLabel: 'This is what it asks the AI (edit under dataDir/prompts):',
  aiBuild: 'Compose the AI payload',
  aiBuildHint: 'Copy it into the conversation, or just say “run this once”',
  aiPayloadTitle: 'Payload to send to the AI',
  aiCopy: 'Copy',
  aiIdle: 'Enter a note id and load the context pack first. Actions appear only when a pack exists.',
  applyEmptyUndoHint: 'If you just wrote, you can roll it back below.',
  // —— undo section ——
  undoTitle: 'Undo',
  undoSub: 'Restores knowledge-base/tag membership only; never deletes notes',
  undoLoading: 'Reading undo records…',
  undoFail: 'Failed to read undo records: ',
  undoNone: 'No undoable batch. Every real write snapshots ownership first; undo relies on it.',
  // —— delete ——
  delTitle: 'Delete note',
  delSub: 'One-way: the platform may not keep a recycle bin, so a local copy is saved first',
  delExpand: 'Open delete area',
  delCollapse: 'Collapse',
  delWarn: 'The official FAQ lists this bug: deleting may remove the note permanently with no recycle bin. Hence: (1) one note at a time; (2) the body is copied to local trash/ before deleting; (3) if the copy fails, deletion is refused.',
  delIdLabel: 'Note ID',
  delIdPh: 'Numeric ID (can be filled from selection)',
  delResolving: 'Resolving…',
  delUseSel: 'Use the selected one',
  delSelNeed: 'Tick the lecture you want to delete in the tree above, or type an ID',
  delAck: 'I understand deletion may be irreversible',
  delDry: 'Dry run (copy to trash/ first, do not delete)',
  delArm: 'Prepare to delete…',
  delReally: 'Delete for real (irreversible)',
  delOk: 'Done.',
  delOkDry: ' (dry run, nothing changed online)',
  delFail: 'Failed: ',
  delTrashAt: 'Local copy: ',
  undoHint: 'Step one is a dry-run; nothing is sent. Confirm the list, then click undo for real.',
  undoNotes: '{n} notes',
  undoDry: 'Dry-run',
  undoRealArm: 'Undo → click again',
  undoRealNow: 'Confirm undo',
  undoRunning: 'Undoing…',
  undoDone: 'Done',
  undoErr: 'Failed: ',
  undoDoneList: 'Undone batches:',
  undoStatusUndone: 'undone',
  unitLectures: ' notes',
  unitNotes: ' notes',
  selCount: '{n} lecture(s) selected',
  selClear: 'Clear',
  selToPlan: 'Build change plan →',
  selHint: 'Every level is selectable: a knowledge base = the whole KB, a series = the whole course, a lecture = one note.',
  selHintKb: 'Select the whole knowledge base',
  selHintCourse: 'Select the whole series',
  selHintBook: 'Select the whole book',
  applyEmpty: 'No plan yet. Go to "Organize", tick what you want to change, and build a plan.',
  applyBuilding: 'Resolving the selected levels into concrete notes and building the plan (offline)…',
  applyFail: 'Failed to build the plan: ',
  applySummary: '{n} action(s). This is a preview only — no network; nothing is written until you press the button below.',
  applyDryRun: 'Dry run first (no writes)',
  applyRunning: 'Running…',
  applyRealArm: 'I really want to write → press again',
  applyRealNow: 'Confirm writing to the server (irreversible)',
  applyErr: 'Failed: ',
  colOp: 'Action',
  colTarget: 'Target',
  colCount: 'Count',
  targetKb: 'Knowledge base ',
  moreRows: '…{n} more action(s) not shown',
  planFile: 'Plan file: ',
  targetLabel: 'Move to:',
  targetKbOpt: 'Knowledge base',
  targetTagOpt: 'Tag',
  topicIdPh: 'topic_id',
  kbPickPh: 'Choose a knowledge base…',
  kbPickNew: '＋ New knowledge base (type a name)',
  kbNewNamePh: 'New KB name',
  tagPh: 'New tag name',
  logLoading: 'Reading the log…',
  logFail: 'Failed to read the log: ',
  logReload: 'Refresh',
  logEmpty: 'No activity yet. Every write lands in the audit files under <dataDir>/logs/.',
  overviewTitle: 'Current state',
  overviewTitleEmpty: 'The local mirror is empty. Run a download and Markdown will show up here.',
  applyTitle: 'Review & apply',
  logTitle: 'Activity log',
  title: 'Mgetbrain · Notes Organizer',
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
  dataDirHint: 'Downloads / intermediate / snapshots / logs / audit / plans all live here. Leave empty to use the default below (created on first run); a relative path resolves under the workspace root, an absolute path is used as-is.',
  dataDirDefault: '(empty = default, created on first run)',
  dirDefaultDerived: 'empty → derived in code as <parent of the repo> + data-<plugin short name>',
  dirExample: 'Example: repo at C:\\dsh\\dshplug, plugin at C:\\dsh\\dshplug\\dsh-getbrain → data lands in C:\\dsh\\data-getbrain, a sibling of dshplug, outside Git.',
  dirExampleLabel: 'Concrete example',
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
  guideHint: 'Full guide: README.md inside the plugin folder (dsh-getbrain\\README.md), not the data directory.',
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
  statusIntro: 'Opening this page automatically runs gn.py doctor: a purely local check (interpreter, directories, rate limit, credential source) that makes no network call and burns no quota — it is the same command as getnote_doctor. "Test connection" below is a different thing: doctor --live, which really sends one read-only request.',
  testConn: 'Test connection (doctor --live, 1 quota)',
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
  quotaNeedLive: 'only after "Test connection" (doctor --live sends a real request)',
  copyUsage: 'Copy instructions',
  copied: 'Copied ✓',
  copiedManual: 'The browser blocked clipboard access; the text below is selected — press Ctrl+C to copy.',
  noStatus: 'Local self-check (doctor) has not returned yet — refresh the page.',

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
    primary: { background: 'var(--dsw-alias-state-business-primary)',
      color: 'var(--dsw-alias-label-primary-foreground)', border: 'none' },
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
  id: 'dsh-getbrain',
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
      const [view, setView] = React.useState('structure')
      const [sum, setSum] = React.useState({ phase: 'loading' })
      const [inv, setInv] = React.useState({ phase: 'loading' })
      const [plan, setPlan] = React.useState({ data: null })
      const [log, setLog] = React.useState({ lines: [] })
      // 树的展开状态：用 Set 存 key，分三层（知识库 / 目录 / 书）
      const [openKb, setOpenKb] = React.useState(new Set())
      const [openCourse, setOpenCourse] = React.useState(new Set())
      const [openBook, setOpenBook] = React.useState(new Set())
      const [sel, setSel] = React.useState(new Set())
      // 拖拽状态：drag = 正在拖的层级路径；dropOn = 当前悬停的知识库名。
      // 为何用拖拽而不是只靠勾选：勾选要「展开→找→勾」三步，拖拽是一步；
      // 而且拖拽能看见「放到哪」，勾选看不见目标。两种都留，不是取代关系。
      const [drag, setDrag] = React.useState(null)
      const [dropOn, setDropOn] = React.useState(null)
      // 电子书书架默认收起：111 个自动生成的架子把真知识库（11 个）埋了
      const [showShelf, setShowShelf] = React.useState(false)
      const [showUnknown, setShowUnknown] = React.useState(false)
      // 自动归类的计划预览（跟手工选的 plan 分开存，因为两套动作完全不同）
      const [autoPlan, setAutoPlan] = React.useState({ phase: 'idle' })
      // 进「确认执行」页时拉一次撤销列表。
      // 不放在这里用 useEffect：loadUndos 定义在后面（TDZ），
      // 所以另在 loadUndos 之后挂一个 effect。
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

      // 层级清单：只在第一次进「分类调整」时拉（扫描 4000+ 文件，不便宜）
      const loadInv = React.useCallback(async () => {
        setInv({ phase: 'loading' })
        try {
          const r = await fetch('/plugins/getnote/inventory', { credentials: 'same-origin' })
          const d = await r.json()
          setInv(d && d.ok ? { phase: 'ready', data: d } : { phase: 'error', error: (d && d.error) || ('HTTP ' + r.status) })
        } catch (e) {
          setInv({ phase: 'error', error: String((e && e.message) || e) })
        }
      }, [])

      // 日志：每次进「执行日志」都重新拉（日志随时在长，缓存没意义）
      const loadLog = React.useCallback(async () => {
        setLog({ phase: 'loading', lines: [] })
        try {
          const r = await fetch('/plugins/getnote/log?lines=200', { credentials: 'same-origin' })
          const d = await r.json()
          setLog(d && d.ok
            ? { phase: 'ready', lines: d.lines || [], file: d.file, total: d.total }
            : { phase: 'error', lines: [], error: (d && d.error) || ('HTTP ' + r.status) })
        } catch (e) {
          setLog({ phase: 'error', lines: [], error: String((e && e.message) || e) })
        }
      }, [])

      React.useEffect(() => {
        if (view === 'structure' && inv.phase === 'loading' && !inv.__tried) {
          setInv((x) => ({ ...x, __tried: true }))
          loadInv()
        }
        if (view === 'log' && log.phase === undefined) loadLog()
      }, [view])

      // 勾选「讲」→ 生成计划（纯本地，不发写请求）
      // 勾选「讲」→ 交给 Host 解析成 note_id 并生成计划（只写计划文件，不执行）
      const onPlan = React.useCallback(async (target) => {
        if (!target) return
        setPlan({ data: null, phase: 'building' })
        setView('apply')
        try {
          const r = await fetch('/plugins/getnote/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            // #untopiced 只是界面上的合成行，不是真实层级名。
            // 直接传下去会解析不到任何笔记（服务端叫「(未归知识库)」）。
            // 在这里翻译成真实前缀，界面就能用「选整行」代替「展开 2055 条再一个个勾」。
            body: JSON.stringify({
              // 拖拽落点时用 dropPaths（单个层级），否则用当前勾选。
              // 不合并两者：拖拽后如果再叠加上老勾选，用户会莫名多归一批笔记。
              paths: (target.dropPaths && target.dropPaths.length
                ? target.dropPaths
                : [...sel])
                .map((p) => p === '#untopiced' ? '(未归知识库)' : p),
              target: target.dropPaths
                ? { kind: 'kb', topicName: target.topicName }
                : target,
            }),
          })
          const d = await r.json()
          setPlan(d && d.ok
            ? { data: d.plan, planPath: d.planPath, phase: 'ready' }
            : { data: null, phase: 'error', error: (d && d.error) || ('HTTP ' + r.status) })
        } catch (e) {
          setPlan({ data: null, phase: 'error', error: String((e && e.message) || e) })
        }
      }, [sel])

      // 执行：先干跑，再真写（双点确认）。
      // planPath 必须能分开带：手工计划写 plan.pending.json，自动归类写
      // plan.classify.json。不分开的话，在自动归类页点干跑会跑去执行上一份手工计划，
      // 而界面显示的是新摘要 —— 这是最危险的一种错（看起来对，改的不是这批）。
      const [armed, setArmed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      // 撤销列表必须定义在 runApply 之前：
      // runApply 真写成功后会调 setUndos 刷新，若状态在它后面声明（const），
      // 就是 TDZ —— 而函数的闭包要到点击时才求值，所以会变成“一点真写就报错”。
      const [undos, setUndos] = React.useState({ phase: 'idle', list: [] })
      const runApply = React.useCallback(async (dry, planPath) => {
        if (busy) return
        setBusy(true)
        setResult(null)
        try {
          const r = await fetch('/plugins/getnote/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ confirm: 'APPLY', dryRun: dry,
              planPath: planPath || undefined }),
          })
          const d = await r.json()
          setResult(d)
          setResult(d)
          if (!dry && d && d.ok) {
            setArmed(false)
            // 真写成功后必须立刻刷新撤销列表：
            // 否则用户刚写完就去看，会以为“没有可回退的”，不敢真写。
            setUndos({ phase: 'idle', list: [] })
          }
        } catch (e) {
          setResult({ ok: false, error: String((e && e.message) || e) })
        } finally {
          setBusy(false)
        }
      }, [busy])

      // 「生成调整计划」需要先选一个目标（哪个知识库 / 哪个标签）
      const [targetKind, setTargetKind] = React.useState('kb')
      const [topicId, setTopicId] = React.useState('')
      const [tagName, setTagName] = React.useState('')
      // 「＋ 新建知识库」时手填的名字。单独一个状态，因为下拉框的 value
      // 要保留 '__new__' 这个哨兵值，不能把库名塞回 topicId。
      const [newKbName, setNewKbName] = React.useState('')
      const onPlanMenu = React.useCallback(() => {
        let target
        if (targetKind === 'kb') {
          if (!topicId) return
          if (topicId === '__new__') {
            // 新建：交给后端 kb_ensure（同名复用，幂等），不需要人知道 id
            const nm = newKbName.trim()
            if (!nm) return
            target = { kind: 'kb', topicName: nm }
          } else if (topicId.startsWith('name:')) {
            // 清单里没拿到 id 的库（scope 未缓存）——按名字归，同样不需要 id
            target = { kind: 'kb', topicName: topicId.slice(5) }
          } else {
            target = { kind: 'kb', topicId: topicId.trim() }
          }
        } else {
          target = { kind: 'tag', tag: tagName.trim() }
          if (!target.tag) return
        }
        onPlan(target)
      }, [targetKind, topicId, tagName, newKbName, onPlan])
      // 拖拽落点：把一个层级拖到另一个知识库上 → 直接生成计划（不写）。
      //
      // 为何走 onPlan 而不直接调 /apply：拖拽只是一个「意图」，
      // 用户可能拖错。必须先在「确认执行」页看到「把 N 条归到 X」才能决定。
      const onDropToKb = React.useCallback((path, kbName) => {
        if (!path || !kbName) return
        // 拖到自己所在的库里 = 无意义，直接忽略（否则会生成一堆「已在目标库」的空动作）
        if (path.split('\u001f')[0] === kbName) return
        onPlan({ kind: 'kb', topicName: kbName, dropPaths: [path] })
      }, [onPlan])

      // 撤销批次列表
      const [undoResult, setUndoResult] = React.useState(null)
      const loadUndos = React.useCallback(async () => {
        setUndos({ phase: 'loading', list: [] })
        try {
          const r = await fetch('/plugins/getnote/undos', { credentials: 'same-origin' })
          const d = await r.json()
          setUndos(d && d.ok
            ? { phase: 'ready', list: d.undos || [] }
            : { phase: 'error', list: [], error: (d && d.error) || ('HTTP ' + r.status) })
        } catch (e) {
          setUndos({ phase: 'error', list: [], error: String((e && e.message) || e) })
        }
      }, [])

      const [undoBusy, setUndoBusy] = React.useState(false)
      const [undoArmed, setUndoArmed] = React.useState(null)
      const onUndo = React.useCallback(async (undoPath, dry) => {
        setUndoResult(null)
        setUndoBusy(true)
        try {
          const r = await fetch('/plugins/getnote/undo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ confirm: 'UNDO', dryRun: dry, undoPath, allowLarge: true }),
          })
          const d = await r.json()
          setUndoResult(d)
          if (d && d.ok && !dry) loadUndos()
        } catch (e) {
          setUndoResult({ ok: false, error: String((e && e.message) || e) })
        } finally {
          setUndoBusy(false)
        }
      }, [loadUndos])

      // ── 删除区状态 ──────────────────────────────────────
      // 为何要一整套本地状态而不是复用 apply：删除不能混进批量计划，
      // 也不能默认干跑——它需要“展开、勾确认、先干跑、再真删”四步。
      const [delOpen, setDelOpen] = React.useState(false)
      const [delNoteId, setDelNoteId] = React.useState('')
      const [delAck, setDelAck] = React.useState(false)
      const [delResult, setDelResult] = React.useState(null)
      const [delBusy, setDelBusy] = React.useState(false)
      const [delArmed, setDelArmed] = React.useState(false)
      const runDelete = React.useCallback(async (dry) => {
        if (delBusy || !delNoteId) return
        setDelBusy(true)
        setDelResult(null)
        try {
          const r = await fetch('/plugins/getnote/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            // acknowledged 必须反映真实勾选：写死 true 等于把服务端的
            // 二次确认变成摆设，勾框就成了纯装饰。
            body: JSON.stringify({ confirm: 'DELETE', acknowledged: !!delAck,
              dryRun: dry, noteId: delNoteId }),
          })
          const d = await r.json()
          setDelResult(d)
          if (d && d.ok && !dry) setDelArmed(false)
        } catch (e) {
          setDelResult({ ok: false, error: String((e && e.message) || e) })
        } finally {
          setDelBusy(false)
        }
      }, [delNoteId, delBusy, delAck])

      // 把树上勾的层级路径转成 note_id。
      // 为何必须做这一步：直接要求用户手填 19 位 note_id 等于没法用。
      const [delResolving, setDelResolving] = React.useState(false)
      const loadFromSel = React.useCallback(async (paths) => {
        if (!paths || !paths.length) return
        setDelResolving(true)
        setDelResult(null)
        try {
          const r = await fetch('/plugins/getnote/resolve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ paths }),
          })
          const d = await r.json()
          if (!d || !d.ok) {
            setDelResult({ ok: false, error: (d && d.error) || ('HTTP ' + r.status) })
            return
          }
          const ids = d.noteIds || []
          if (!ids.length) {
            setDelResult({ ok: false, error: '选中的层级下没有任何笔记' })
            return
          }
          setDelArmed(false)
          if (ids.length === 1) {
            setDelNoteId(String(ids[0]))
            setDelResult({ ok: true, output: '已从勾选带入 1 条笔记：' + ids[0] })
          } else {
            // 多层勾选会解析出很多条。删除只能一条条来，所以不默默取第一条。
            setDelResult({ ok: false,
              error: '这次勾选解析出 ' + ids.length + ' 条笔记。删除只能一次一条：'
                + '请只勾选一篇「讲」，或直接填 ID。前几个：' + ids.slice(0, 5).join(', ') })
          }
        } catch (e) {
          setDelResult({ ok: false, error: String((e && e.message) || e) })
        } finally {
          setDelResolving(false)
        }
      }, [])
      // 真写成功后、或每次进「确认执行」页，都要刷新可撤销列表：
      // 刚写的批次必须马上出现，否则用户以为无法回退。
      React.useEffect(() => {
        if (view === 'apply' && undos.phase === 'idle') loadUndos()
      }, [view, undos.phase, loadUndos])
      // —— AI 动作（发芽/审问/连线）——
      // 状态分三块：提示词与按钮（aiData）、素材包（pack）、当前选中动作。
      // 为何分开：提示词可以改完不取素材；素材包也可以对多个动作复用。
      const [aiData, setAiData] = React.useState(null)
      const [aiNoteId, setAiNoteId] = React.useState('')
      const [pack, setPack] = React.useState(null)
      const [packBusy, setPackBusy] = React.useState(false)
      const [packError, setPackError] = React.useState('')
      const [sprout, setSprout] = React.useState(null)
      const [sproutBusy, setSproutBusy] = React.useState(false)
      const [activeAction, setActiveAction] = React.useState('')
      const [payload, setPayload] = React.useState('')

      const loadAI = React.useCallback(async () => {
        try {
          const r = await fetch('/plugins/getnote/ai', { credentials: 'same-origin' })
          const d = await r.json()
          if (d && d.ok) setAiData(d)
        } catch { /* 取不到就留空，不阻断页面 */ }
      }, [])

      // 进 AI 页时拉一次提示词：用户在文件里改过，也要能立即看到最新版。
      // 放在 loadAI 定义之后，否则会引用到尚未初始化的 const（TDZ）。
      React.useEffect(() => {
        if (view === 'ai' && !aiData) loadAI()
      }, [view, aiData, loadAI])

      const loadPack = React.useCallback(async () => {
        if (!/^\d{6,}$/.test(aiNoteId)) return
        setPackBusy(true); setPackError(''); setPack(null); setPayload('')
        try {
          const r = await fetch('/plugins/getnote/context-pack', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ noteId: aiNoteId }),
          })
          const d = await r.json()
          if (d && d.ok) setPack(d)
          else setPackError((d && d.error) || ('HTTP ' + r.status))
        } catch (e) {
          setPackError(String((e && e.message) || e))
        } finally {
          setPackBusy(false)
        }
      }, [aiNoteId])

      const checkSprout = React.useCallback(async () => {
        if (!/^\d{6,}$/.test(aiNoteId)) return
        setSproutBusy(true)
        try {
          const r = await fetch('/plugins/getnote/sprout?noteId=' + encodeURIComponent(aiNoteId),
            { credentials: 'same-origin' })
          const d = await r.json()
          setSprout(d && d.ok
            ? { checked: true, hasSprout: !!d.hasSprout, data: d.sprout }
            : { checked: true, hasSprout: false, error: (d && d.error) || ('HTTP ' + r.status) })
        } catch (e) {
          setSprout({ checked: true, hasSprout: false, error: String((e && e.message) || e) })
        } finally {
          setSproutBusy(false)
        }
      }, [aiNoteId])

      // 拼「发给 AI 的内容」：提示词 + 素材包。
      // 为何不直接调模型：本插件是数据层，模型调用属于会话侧；
      // 而且把内容摊开给用户看，他才能判断这个提示词合不合适。
      const buildPayload = React.useCallback(() => {
        if (!pack || !pack.pack || !aiData) return
        const act = (aiData.actions || []).find((x) => x.id === activeAction)
        const promptText = act ? (aiData.prompts || {})[act.prompt] || '' : ''
        const pk = pack.pack
        const parts = [promptText, '', '---', ''
          , '【中心笔记】' + (pk.center.title || '')
          , '课程：' + (pk.center.course || '') + '　类型：' + (pk.center.type || '')
          , ''
          , pk.center.body || ''
        ]
        if ((pk.siblings || []).length) {
          parts.push('', '【同系列的其他讲】')
          pk.siblings.forEach((s, i) => {
            parts.push('', '(' + (i + 1) + ') ' + (s.title || ''), s.excerpt || '')
          })
        }
        if ((pk.related || []).length) {
          parts.push('', '【跨系列可能相关的段落】')
          pk.related.forEach((r, i) => {
            parts.push('', '(' + (i + 1) + ') [' + (r.course || '') + '] ' + (r.title || '')
              , '命中：' + (r.matched || []).join(' / '), r.excerpt || '')
          })
        }
        setPayload(parts.join('\n'))
      }, [pack, aiData, activeAction])

      const copyPayload = React.useCallback(async () => {
        try {
          await navigator.clipboard.writeText(payload)
        } catch {
          // 回退：选中文本，但必须明说「只是选中了」
          try {
            const ta = document.createElement('textarea')
            ta.value = payload
            document.body.appendChild(ta)
            ta.select()
            alert('已选中全部文字，请按 Ctrl+C 复制（浏览器拒绝了直接写剪贴板）')
            document.body.removeChild(ta)
          } catch { /* 最后放弃 */ }
        }
      }, [payload])

      // 一键生成自动归类计划：只写计划文件，不发写请求。
      // 为何要这个：2055 条没归库，靠手勾「讲」是几百次点击，不可能完成。
      // 但仍然不能在浏览器里自己算——必须先看计划，再确认，才 apply。
      const onAutoPlan = React.useCallback(async () => {
        setAutoPlan({ phase: 'building' })
        setView('auto')
        try {
          const r = await fetch('/plugins/getnote/auto-plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ minGroup: 5 }),
          })
          const d = await r.json()
          setAutoPlan(d && d.ok
            ? { phase: 'ready', data: d }
            : { phase: 'error', error: (d && d.error) || ('HTTP ' + r.status) })
        } catch (e) {
          setAutoPlan({ phase: 'error', error: String((e && e.message) || e) })
        }
      }, [])

      const tabs = [
        { id: 'structure', label: T('tabStructure', '分类调整') },
        { id: 'overview', label: T('tabOverview', '笔记现状') },
        { id: 'apply', label: T('tabApply', '确认执行') },
        { id: 'auto', label: T('tabAuto', '自动归类') },
        { id: 'ai', label: T('tabAI', 'AI 动作') },
        { id: 'log', label: T('tabLog', '执行日志') },
      ]
      const act = { openKb: [openKb, setOpenKb], openCourse: [openCourse, setOpenCourse],
        openBook: [openBook, setOpenBook], sel: [sel, setSel], setSel, onPlanMenu,
        showShelf: [showShelf, setShowShelf], showUnknown: [showUnknown, setShowUnknown],
        onAutoPlan, autoPlan,
        drag: [drag, setDrag], dropOn: [dropOn, setDropOn], onDropToKb,
        undo: undos, onUndo, undoResult, undoBusy, undoArmed, setUndoArmed,
        targetKind, setTargetKind, topicId, setTopicId, tagName, setTagName,
        newKbName, setNewKbName,
        del: { open: [delOpen, setDelOpen], noteId: [delNoteId, setDelNoteId],
          ack: [delAck, setDelAck], result: [delResult, setDelResult],
          busy: [delBusy, setDelBusy], armed: [delArmed, setDelArmed],
          run: runDelete, resolveFromSel: loadFromSel, resolving: delResolving },
        selPaths: Array.from(sel) }

      let content
      if (view === 'structure') content = renderStructure(T, h, P, inv, act)
      else if (view === 'overview') content = renderOverview(sum, T, h, P)
      else if (view === 'apply') content = renderApply(T, h, P, { ...plan, result },
        { run: runApply, busy, armed, setArmed,
          undo: undos, onUndo, undoResult, undoBusy, undoArmed, setUndoArmed })
      else if (view === 'auto') content = renderAuto(T, h, P, autoPlan, { onAutoPlan, run: runApply, busy, inv })
      else if (view === 'ai') content = renderAI(T, h, P,
        { data: aiData, pack, packBusy, packError, sprout, sproutBusy },
        { noteId: aiNoteId, setNoteId: setAiNoteId, loadPack, checkSprout,
          activeAction, setActiveAction, buildPayload, payload, copyPayload })
      else content = renderLog(T, h, P, log, loadLog)


      return h('div', { style: P.root },
        h('header', { style: P.header },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h1', { style: P.title }, T('title', 'Mgetbrain')),
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
          h('p', { style: { ...P.muted, color: 'var(--dsw-alias-state-error-primary)' } },
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

    // ────────────────────────────────────────────────────────────────
    //  「分类调整」页：真实层级浏览 + 可执行动作
    //
    //  为什么做成树而不是列表：官方 API 里 topics 是平的（只有 id/name/scope），
    //  一个人的真实结构是「知识库 → 目录 → 书 → 讲 → 划线」。这棵树不在服务器上，
    //  而是由 Host 侧的 gn.py inventory 从本地镜像重建。
    //
    //  交互约定：先选中（不写线上），再生成计划，最后显式确认才发写请求。
    //  删除一律走双重闸门（勾选 + 输入词），与 gn.py 的 CLI 保持一致。
    // ────────────────────────────────────────────────────────────────
    function renderStructure(T, h, P, inv, act) {
      const [openKb, setOpenKb] = act.openKb
      const [openCourse, setOpenCourse] = act.openCourse
      const [openBook, setOpenBook] = act.openBook
      const sel = act.sel[0]
      const drag = act.drag[0]
      const dropOn = act.dropOn[0]
      const setDrag = act.drag[1]
      const setDropOn = act.dropOn[1]
      if (inv.phase === 'loading') {
        return h('section', { style: P.card }, h('p', { style: P.muted }, T('invLoading', '正在本地重建层级（不联网，扫 4000+ 个文件头，约 1–3 秒）…')))
      }
      if (inv.phase === 'error') {
        return h('section', { style: P.card },
          h('h2', { style: P.cardTitle }, T('invTitle', '层级清单')),
          h('p', { style: { ...P.muted, color: 'var(--dsw-alias-state-error-primary)' } },
            T('invFail', '读取失败：') + inv.error),
          h('p', { style: P.muted }, T('invFailHint', '多半是本地镜像还没下载。先在会话里说「用 getnote_download 全量下载」。')))
      }
      const d = inv.data || {}
      const kbs = d.knowledge_bases || []
      if (!kbs.length) {
        return h('section', { style: P.card },
          h('h2', { style: P.cardTitle }, T('invTitle', '层级清单')),
          h('p', { style: P.muted }, T('invEmpty', '本地镜像还是空的，没有可分类的内容。')),
          h('p', { style: P.dirLine }, d.dir || ''))
      }

      // 顶层节点分三类，语义完全不同，不能平铺在一超展示：
      //   kb         = 我自己建的知识库（真分类，我会去用）
      //   book_shelf = 得到电子书自动生成的书架（一本书一个，是“买过什么”不是“我怎么归类”）
      //   untopiced  = 还没归位的笔记（这是待处理入口，不是知识库）
      // 之前三者混在一起，顶层 123 个节点看起来像“我有 123 个知识库”，
      // 实际上真知识库只有 11 个，剩下 111 个全是买书自带的架子。
      const ownKb = kbs.filter((x) => x.kind === 'kb')
      const shelves = kbs.filter((x) => x.kind === 'book_shelf')
      const untopicedNode = kbs.find((x) => x.kind === 'untopiced')
      const unknownKb = kbs.filter((x) => x.kind === 'unknown')
      const [showShelf, setShowShelf] = act.showShelf
      const [showUnknown, setShowUnknown] = act.showUnknown

      const toggle = (setter, cur, key) => () => {
        const next = new Set(cur)
        if (next.has(key)) next.delete(key); else next.add(key)
        setter(next)
      }
      // 勾选/取消一个层级（任意层）。setSel 直接传值，不走 setter。
      const pick = (key) => {
        const next = new Set(sel)
        if (next.has(key)) next.delete(key); else next.add(key)
        act.setSel(next)
      }
      const chev = (on) => on ? '▾' : '▸'

      const rowStyle = (depth, active) => ({
        ...P.treeRow,
        paddingLeft: 8 + depth * 14,
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      })

      // 把一组知识库节点渲染成树（三类主体逻辑一样，只是颜色/前缀不同）
      const renderKbGroup = (list, opts) => list.map((kb) => {
        const kbOpen = openKb.has(kb.name)
        // 每一层都要能选：勾「知识库」= 整个库一次性归到别处。
        // 之前只有最底的「讲」能勾，4321 条笔记等于要勾几百次——这不是「整理笔记」，
        // 是体力活。cmd_resolve 本来就支持前缀匹配（len(parts) <= 4），
        // 缺的只是界面上的勾框。
        const kbPath = kb.name
        const kbPicked = sel.has(kbPath)
        // 拖拽放置目标：只有「真自建库」能作为目标。
        // 为何排除电子书书架：书架是平台按书自动建的，往里拖笔记会造出双重归属，
        // 而且用户无法删除书架，放错了很难收拾。
        const canDrop = opts.canDrop === true
        const isDropOver = dropOn === kb.name && canDrop
        const kbHdr = h('div', {
          key: 'kb-' + (opts.tag || '') + kb.name,
          style: { ...rowStyle(0, kbPicked || isDropOver),
            ...(isDropOver ? { outline: '2px dashed var(--dsw-alias-brand-primary)',
              borderRadius: 6 } : null) },
          onDragOver: canDrop ? ((e) => {
            if (!drag) return
            e.preventDefault()   // 不 preventDefault 浏览器不认这里是合法落点
            if (dropOn !== kb.name) setDropOn(kb.name)
          }) : undefined,
          onDragLeave: canDrop ? (() => {
            if (dropOn === kb.name) setDropOn(null)
          }) : undefined,
          onDrop: canDrop ? ((e) => {
            e.preventDefault()
            const path = drag || e.dataTransfer.getData('text/plain')
            setDropOn(null)
            setDrag(null)
            if (path) act.onDropToKb(path, kb.name)
          }) : undefined,
        },
          h('span', {
            style: P.treeCheck,
            title: T('selHintKb', '选中整个知识库'),
            onClick: (e) => { e.stopPropagation(); pick(kbPath) },
          }, kbPicked ? '☑' : '☐'),
          h('span', {
            style: { ...P.treeChev, cursor: 'pointer' },
            onClick: toggle(setOpenKb, openKb, kb.name),
          }, chev(kbOpen)),
          h('span', {
            style: { ...P.treeName, cursor: 'pointer' }, title: kb.name,
            onClick: toggle(setOpenKb, openKb, kb.name),
          }, kb.name),
          opts.badge
            ? h('span', { style: { ...P.chip, marginLeft: 6, fontSize: 10 } }, opts.badge)
            : null,
          h('span', { style: P.treeCount }, String(kb.count)))

        if (!kbOpen) return kbHdr

        const courseNodes = (kb.courses || []).slice(0, 40).map((co) => {
          const ck = kb.name + '\u0000' + co.name
          const coOpen = openCourse.has(ck)
          const coPicked = sel.has(ck)
          // 目录行可拖：拖着整个系列去另一个库，是最高频的批量操作。
          // 拖拽时勾选框仍可用；两者不冲突（拖拽改的是「放到哪」，勾选改的是「选中哪」）。
          const coHdr = h('div', {
            key: 'co-' + ck,
            draggable: true,
            onDragStart: (e) => {
              setDrag(ck)
              try { e.dataTransfer.setData('text/plain', ck) } catch { /* 有些浏览器限制 */ }
              e.dataTransfer.effectAllowed = 'move'
            },
            onDragEnd: () => { setDrag(null); setDropOn(null) },
            style: { ...rowStyle(1, coPicked), cursor: 'grab' },
          },
            h('span', {
              style: P.treeCheck,
              title: T('selHintCourse', '选中整个目录'),
              onClick: (e) => { e.stopPropagation(); pick(ck) },
            }, coPicked ? '☑' : '☐'),
            h('span', {
              style: { ...P.treeChev, cursor: 'pointer' },
              onClick: toggle(setOpenCourse, openCourse, ck),
            }, chev(coOpen)),
            h('span', {
              style: { ...P.treeName, cursor: 'pointer' }, title: co.name,
              onClick: toggle(setOpenCourse, openCourse, ck),
            }, co.name),
            h('span', { style: P.treeCount }, String(co.count)))

          if (!coOpen) return coHdr

          const bookNodes = (co.books || []).map((bk) => {
            const bKey = ck + '\u0000' + (bk.name || '\u0001flat')
            const bkOpen = openBook.has(bKey)
            // 空书名 = 服务端已展平（没有书名的单篇）。不再画一层「书」行，
            // 直接把这些讲接在目录下面，否则多一层拿掉正是为了去掉的空壳。
            const isFlat = !bk.name
            const bkPicked2 = sel.has(bKey)
            const bkHdr = h('div', {
              key: 'bk-' + bKey,
              draggable: !isFlat,
              onDragStart: isFlat ? undefined : ((e) => {
                setDrag(bKey)
                try { e.dataTransfer.setData('text/plain', bKey) } catch { /* 降级：靠 drag 状态 */ }
                e.dataTransfer.effectAllowed = 'move'
              }),
              onDragEnd: isFlat ? undefined : (() => { setDrag(null); setDropOn(null) }),
              style: { ...rowStyle(2, bkPicked2), cursor: isFlat ? 'default' : 'grab' },
            },
              h('span', {
                style: P.treeCheck,
                title: T('selHintBook', '选中整本书'),
                onClick: (e) => { e.stopPropagation(); pick(bKey) },
              }, bkPicked2 ? '☑' : '☐'),
              h('span', {
                style: { ...P.treeChev, cursor: 'pointer' },
                onClick: toggle(setOpenBook, openBook, bKey),
              }, chev(bkOpen)),
              h('span', {
                style: { ...P.treeName, cursor: 'pointer' }, title: bk.name,
                onClick: toggle(setOpenBook, openBook, bKey),
              }, bk.name),
              h('span', { style: P.treeCount }, bk.count + T('unitLectures', ' 条')))

            // 「讲」这一层：一本书拆成多讲，每讲的划线分散成多条笔记。
            // 每讲单独一行（带勾框），这是最小粒度，也是唯一能精确选到单篇的粒度。
            const lectureRows = (bk.lectures || []).map((lc) => {
              const lk = bKey + '\u0000' + lc.name
              const picked = sel.has(lk)
              return h('div', {
                key: 'lc-' + lk,
                style: { ...rowStyle(isFlat ? 2 : 3, picked), cursor: 'pointer' },
                onClick: () => pick(lk),
                title: lc.name,
              },
                h('span', { style: P.treeCheck }, picked ? '☑' : '☐'),
                h('span', { style: P.treeName }, lc.name || '(无标题)'),
                h('span', { style: P.treeCount }, String(lc.count) + T('unitNotes', ' 条')))
            })

            // 展平：不画书行，讲直接接在目录下
            if (isFlat) return lectureRows
            if (!bkOpen) return bkHdr
            return [bkHdr, ...lectureRows]
          })
          return [coHdr, ...bookNodes]
        })
        return [kbHdr, ...courseNodes]
      })

      const sectionLabel = (text, hint) => h('div', { style: P.groupLabel },
        h('span', null, text),
        hint ? h('span', { style: P.groupHint }, hint) : null)

      const kbNodes = [].concat(
        sectionLabel(T('secOwnKb', '我的知识库'),
          T('secOwnKbHint', '{n} 个').replace('{n}', ownKb.length)),
        ownKb.length
          ? renderKbGroup(ownKb, { canDrop: true })
          : [h('p', { key: 'noown', style: { ...P.muted, paddingLeft: 26 } },
              T('secOwnKbEmpty', '还没有自建知识库。'))],

        untopicedNode
          ? [sectionLabel(T('secUntopiced', '待归类'),
              T('secUntopicedHint', '{n} 条没归库').replace('{n}', untopicedNode.count)),
            h('div', {
              key: 'untoped-entry',
              style: { ...rowStyle(0, sel.has('#untopiced')), cursor: 'pointer' },
              onClick: () => {
                const next = new Set(sel)
                if (next.has('#untopiced')) next.delete('#untopiced')
                else next.add('#untopiced')
                act.setSel(next)
              },
            },
              h('span', { style: P.treeCheck }, sel.has('#untopiced') ? '☑' : '☐'),
              h('span', { style: P.treeName }, T('untopicedName', '未归知识库')),
              h('span', { style: P.treeCount }, String(untopicedNode.count)))]
          : [],

        [sectionLabel(T('secShelf', '电子书书架'),
          T('secShelfHint', '{n} 个 · 得到自动生成').replace('{n}', shelves.length)),
          h('div', {
            key: 'shelf-toggle',
            style: { ...rowStyle(0, false), cursor: 'pointer' },
            onClick: () => setShowShelf(!showShelf),
          },
            h('span', { style: P.treeChev }, chev(showShelf)),
            h('span', { style: P.treeName },
              showShelf
                ? T('shelfHide', '收起书架（买过的书）')
                : T('shelfShow', '展开书架（买过的书，共 {n} 个）').replace('{n}', shelves.length)))],
        showShelf ? renderKbGroup(shelves, { tag: 'shelf', badge: T('badgeShelf', '书') }) : [],

        unknownKb.length
          ? [sectionLabel(T('secUnknown', '未区分'),
              T('secUnknownHint', '未拉取 scope 缓存，分不出是库还是书架')),
            h('p', { key: 'unkhint', style: { ...P.muted, paddingLeft: 26 } },
              T('secUnknownAction', '跑一次 gn.py kb-scopes（或点上面的刷新）就能分清楚。'))]
          : [],
        showUnknown && unknownKb.length ? renderKbGroup(unknownKb, { tag: 'unk' }) : []
      )

      const totalSel = sel.size
      return h('div', null,
        h('p', { style: { ...P.muted, marginBottom: 10 } },
          T('invIntro', '层级分三类，语义不同：我的知识库（我自己建的）、待归类（还没归库的笔记）、电子书书架（得到买书自动生成，不是我的分类）。\n官方 API 里知识库是平的，目录/书/讲 只存在于本地重建。')),
        h('div', { style: P.treeBox }, kbNodes),
        h('p', { style: P.dirLine },
          T('invStat', '共 {t} 条笔记，未归知识库 {u} 条，无来源 {s} 条。')
            .replace('{t}', d.total).replace('{u}', d.untopiced).replace('{s}', d.no_source)),
        totalSel
          ? h('div', { style: P.selBar },
              h('span', null, T('selCount', '已选 {n} 项').replace('{n}', totalSel)),
              h('button', { style: P.btn, onClick: () => act.setSel(new Set()) },
                T('selClear', '清空')),

              // 目标选择器：归到哪个知识库 / 加哪个标签
              h('span', { style: { marginLeft: 'auto', fontSize: 11.5 } }, T('targetLabel', '归到：')),
              h('select', {
                style: P.input,
                value: act.targetKind,
                onChange: (e) => act.setTargetKind(e.target.value),
              },
                h('option', { value: 'kb' }, T('targetKbOpt', '知识库')),
                h('option', { value: 'tag' }, T('targetTagOpt', '标签'))),
              act.targetKind === 'kb'
                // 之前这里是必填 topic_id 输入框，用户根本不知道 ID 从哪来。
                // 库存清单（inventory）里本来就有每个库的真实 id，直接拿来用；
                // 没清单时退化为「新建/按名归库」，总之不需要人去翻 ID。
                ? h('select', {
                    style: { ...P.input, maxWidth: 190 },
                    value: act.topicId,
                    onChange: (e) => act.setTopicId(e.target.value),
                  },
                    h('option', { value: '' }, T('kbPickPh', '选择知识库…')),
                    ownKb.map((k) => h('option', { key: k.id || k.name, value: k.id || ('name:' + k.name) },
                      `${k.name}（${k.count}）`)),
                    h('option', { value: '__new__' },
                      T('kbPickNew', '＋ 新建知识库（手填名字）')))
                : h('input', {
                    style: { ...P.input, width: 130 },
                    placeholder: T('tagPh', '新标签名'),
                    value: act.tagName,
                    onChange: (e) => act.setTagName(e.target.value),
                  }),
              // 选了「新建」才让人手填库名（这是唯一需要打字的地方）
              act.targetKind === 'kb' && act.topicId === '__new__'
                ? h('input', {
                    style: { ...P.input, width: 130 },
                    placeholder: T('kbNewNamePh', '新库名'),
                    value: act.newKbName || '',
                    onChange: (e) => act.setNewKbName(e.target.value),
                  })
                : null,
              h('button', { style: { ...P.btn, ...P.primary }, onClick: act.onPlanMenu },
                T('selToPlan', '生成计划 →')))
          : h('p', { style: P.muted }, T('selHint', '点开层级、勾选「讲」，就能把它整批归到别的知识库或加标签。')),
        renderDelete(T, h, P, act))
    }

    /**
     * 删除区（默认收起）。
     *
     * 为何单独一个区、还要主动展开：删除是单程票。官方 FAQ 自列
     * 「删除后直接彻底删除、未进回收站」，所以这里不做“一键批量删”。
     * 流程故意长：展开 → 填/选中一条 → 勾「我知道可能不可恢复」→ 干跑 → 真删。
     * 干跑会先把正文存到 <数据目录>/trash/，真删时也先存再删
     * （gn.py 里存不下就拒绝删，不给“反正有回收站”的幻觉）。
     */
    function renderDelete(T, h, P, act) {
      const dl = act.del || {}
      const [open, setOpen] = dl.open || [false, () => {}]
      const [noteId, setNoteId] = dl.noteId || ['', () => {}]
      const [ack, setAck] = dl.ack || [false, () => {}]
      const [result, setResult] = dl.result || [null, () => {}]
      const [busy, setBusy] = dl.busy || [false, () => {}]
      const [armed, setArmed] = dl.armed || [false, () => {}]
      const delResolving = !!dl.resolving

      // 删除只处理一条：把树上勾的层级交给 loadFromSel 去解析成 note_id。
      // 之前靠人自己填 19 位 ID，根本没法用——现在从勾选带入。
      const picked = (act.selPaths || []).slice()
      const canUse = picked.length > 0

      const head = h('div', { style: { ...P.sgHead, marginTop: 16 } },
        h('h2', { style: { ...P.cardTitle, marginBottom: 0 } }, T('delTitle', '删除笔记')),
        h('span', { style: { ...P.muted, fontSize: 11 } },
          T('delSub', '单程票：平台删除可能不进回收站，本工具会先存本地副本')),
        h('button', {
          style: { ...P.btn, marginLeft: 'auto' },
          onClick: () => setOpen(!open),
        }, open ? T('delCollapse', '收起') : T('delExpand', '展开删除区')))

      if (!open) {
        return h('section', { style: { ...P.card, marginTop: 12 } }, head)
      }

      return h('section', { style: { ...P.card, marginTop: 12 } }, head,
        h('p', { style: P.muted }, T('delWarn',
          '官方 FAQ 自列 bug：删除后可能直接彻底删除、不进回收站。所以：① 每次只删一条；② 删前先把正文存到本地 trash/；③ 存不下就拒绝删除。')),

        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12 } }, T('delIdLabel', '笔记 ID')),
          h('input', {
            style: { ...P.input, width: 220 },
            placeholder: T('delIdPh', '数字 ID（可从勾选带入）'),
            value: noteId,
            onChange: (e) => { setNoteId(e.target.value.replace(/[^\d]/g, '')); setArmed(false) },
          }),
          canUse
            ? h('button', {
                style: P.btn,
                disabled: delResolving,
                onClick: () => dl.resolveFromSel && dl.resolveFromSel(picked),
              }, delResolving
                ? T('delResolving', '正在解析…')
                : T('delUseSel', '用勾选的那一条'))
            : h('span', { style: { ...P.muted, fontSize: 11 } },
                T('delSelNeed', '先在上面的树上勾选要删的那一篇，或直接填 ID'))),
        h('label', { style: { ...P.boolRow, marginTop: 10 } },
          h('input', {
            type: 'checkbox', checked: ack,
            onChange: (e) => { setAck(e.target.checked); setArmed(false) },
          }),
          h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } },
            T('delAck', '我知道删除可能不可恢复'))),

        h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
          h('button', {
            style: { ...P.btn, ...(busy || !noteId || !ack ? { opacity: 0.5, cursor: 'not-allowed' } : null) },
            disabled: busy || !noteId || !ack,
            onClick: () => dl.run && dl.run(true),
          }, T('delDry', '干跑（先备份到 trash/，不删）')),
          armed
            ? h('button', {
                style: { ...P.btn, ...P.danger, ...(busy ? { opacity: 0.5 } : null) },
                disabled: busy,
                onClick: () => dl.run && dl.run(false),
              }, T('delReally', '真的删掉（不可恢复）'))
            : h('button', {
                style: { ...P.btn, ...(busy || !noteId || !ack ? { opacity: 0.5, cursor: 'not-allowed' } : null) },
                disabled: busy || !noteId || !ack,
                onClick: () => setArmed(true),
              }, T('delArm', '准备删除…'))),

        result
          ? h('div', { style: { marginTop: 12 } },
              h('p', { style: { ...P.muted, color: result.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } },
                result.ok
                  ? T('delOk', '完成。') + (result.dryRun ? T('delOkDry', '（干跑，线上未动）') : '')
                  : T('delFail', '失败：') + (result.error || '')),
              result.trashPath
                ? h('p', { style: P.muted }, T('delTrashAt', '本地副本：') + result.trashPath)
                : null,
              result.output
                ? h('pre', { style: P.logPre }, String(result.output).slice(0, 2000))
                : null)
          : null)
    }
    /** 「确认执行」页：列出计划、干跑、双重闸门。 */
    function renderApply(T, h, P, plan, apply) {
      if (plan.phase === 'building') {
        return h('section', { style: P.card },
          h('h2', { style: P.cardTitle }, T('applyTitle', '确认与执行')),
          h('p', { style: P.muted }, T('applyBuilding', '正在把选中的层级解析成具体笔记，并生成计划（不联网）…')))
      }
      if (plan.phase === 'error') {
        return h('section', { style: P.card },
          h('h2', { style: P.cardTitle }, T('applyTitle', '确认与执行')),
          h('p', { style: { ...P.muted, color: 'var(--dsw-alias-state-error-primary)' } },
            T('applyFail', '生成计划失败：') + plan.error))
      }
      const p = plan.data
      if (!p) {
        // 没有待执行计划时，也必须能看到撤销区：
        // 用户可能刚写完（计划已被消费），或想去回退上次的操作。
        // 早期版本这里直接 return，导致“撤销”永远不出现——与“可回退”的目标相违。
        return h('div', null,
          h('section', { style: P.card },
            h('h2', { style: P.cardTitle }, T('applyTitle', '确认与执行')),
            h('p', { style: P.muted }, T('applyEmpty',
              '还没有待执行的计划。先去「分类调整」勾选要动的笔记，生成计划。')),
            h('p', { style: { ...P.muted, fontSize: 11.5 } }, T('applyEmptyUndoHint',
              '若刚才已经写过，可直接在下面回退。'))),
          apply.undo ? renderUndo(T, h, P, apply.undo, apply) : null)
      }
      const actions = p.actions || []
      // 计划可能很长（一整个目录就是一条 kb_batch_add，但标签是逐条），
      // 只展示前 50 条，剩下的给数量。
      const shown = actions.slice(0, 50)
      const out = plan.result

      return h('section', { style: P.card },
        h('h2', { style: P.cardTitle }, T('applyTitle', '确认与执行')),
        h('p', { style: P.muted },
          T('applySummary', '共 {n} 个动作。这一步只预览，不连网；点下面的按钮才真正写线上。')
            .replace('{n}', actions.length)),
        h('table', { style: P.planTable },
          h('thead', null, h('tr', null,
            h('th', { style: P.planTh }, '#'),
            h('th', { style: P.planTh }, T('colOp', '动作')),
            h('th', { style: P.planTh }, T('colTarget', '目标')),
            h('th', { style: P.planTh }, T('colCount', '条数')))),
          h('tbody', null, ...shown.map((s, i) => h('tr', { key: i },
            h('td', { style: P.planTd }, String(i + 1)),
            h('td', { style: P.planTd }, String(s.op || '')),
            h('td', { style: P.planTd },
              s.op === 'kb_batch_add'
                ? T('targetKb', '知识库 ') + String((s.args && s.args.topic_id) || '')
                : String((s.args && (s.args.note_id || (s.args.tags || []).join(','))) || '')),
            h('td', { style: P.planTd },
              s.op === 'kb_batch_add' ? String(((s.args && s.args.note_ids) || []).length) : '1'))))),
        actions.length > shown.length
          ? h('p', { style: { ...P.muted, marginTop: 6 } },
              T('moreRows', '…还有 {n} 个动作未展开').replace('{n}', actions.length - shown.length))
          : null,
        h('p', { style: P.dirLine }, T('planFile', '计划文件：') + (plan.planPath || '（未写入磁盘）')),

        // —— 执行区：先干跑，再真写 ——
        h('div', { style: P.selBar },
          h('span', null, T('applyGuard', '先干跑预览，确认后才发写请求。')),
          h('button', {
            style: { ...P.btn, ...P.primary },
            disabled: apply.busy,
            onClick: () => apply.run(true, plan.planPath),
          }, apply.busy ? T('applyRunning', '执行中…') : T('applyDryRun', '先干跑（不发写请求）')),
          h('button', {
            style: { ...P.btn, ...(apply.armed ? P.danger : null) },
            disabled: apply.busy,
            onClick: () => (apply.armed ? apply.run(false, plan.planPath) : apply.setArmed(true)),
          }, apply.armed
            ? T('applyRealNow', '确认写入线上（不可撤销）')
            : T('applyRealArm', '我要真写 → 需再点一次'))),

        // —— 撤销区 ——
        // 为何放在这一页而不是做成全局「撤销上一步」：
        // 这个面板容易被误触，而「上一步」是隐式的——用户以为是刚才那次，
        // 实际可能是别处改的。所以显式列出「哪一批、多少条、什么状态」，让他选。
        apply.undo ? renderUndo(T, h, P, apply.undo, apply) : null,

        out
          ? h('pre', { style: P.logPre }, out.error
              ? (T('applyErr', '失败：') + out.error + '\n' + (out.output || ''))
              : (out.output || ''))
          : null)
    }
    /**
     * 撤销区：列出可回退的批次，双点确认才执行。
     *
     * 为何不是一颗“撤销”按钮：
     *   · 面板会误触，而“上一步”是隐式的（可能是别处改的）；
     *   · 一次可能改过好几批，必须让用户挑是哪一批；
     *   · 撤销干跑和真写分开，避免“点一下就把几百条退回”。
     */
    function renderUndo(T, h, P, undo, apply) {
      // undos 的形状是 { phase, list, error }，不是 { data: { list } }。
      // 早期写成 undo.data.list，导致即使有批次也永远显示“没有可撤销”——
      // 界面看着正常、功能完全失效，典型静默错误。
      const list = undo.list || []
      const open = list.filter((x) => x.status === 'open')
      // 已撤销的批次也要露出（只读展示），否则用户会以为记录丢了；
      // 但不能给按钮——已撤销的再点只会报错，是噪声。
      const done = list.filter((x) => x.status !== 'open')

      const head = h('div', { style: { ...P.sgHead, marginTop: 16 } },
        h('h2', { style: { ...P.cardTitle, marginBottom: 0 } }, T('undoTitle', '撤销')),
        h('span', { style: { ...P.muted, fontSize: 11 } },
          T('undoSub', '只还原知识库/标签归属，不删笔记')))

      if (undo.phase === 'loading') {
        return h('section', { style: { ...P.card, marginTop: 12 } }, head,
          h('p', { style: P.muted }, T('undoLoading', '正在读撤销记录…')))
      }
      if (undo.phase === 'error') {
        return h('section', { style: { ...P.card, marginTop: 12 } }, head,
          h('p', { style: { ...P.muted, color: 'var(--dsw-alias-state-error-primary)' } },
            T('undoFail', '读撤销记录失败：') + (undo.error || '')))
      }
      // 把「已撤销」列表做成一个可复用片段：
      // 没 open 批次时也要显示（否则用户以为记录全消失了）。
      const doneBlock = done.length
        ? h('div', { style: { marginTop: 8 } },
            h('div', { style: { ...P.muted, fontSize: 11 } },
              T('undoDoneList', '已撤销的批次：')),
            done.slice(0, 6).map((u) => h('div', {
              key: 'd-' + u.file,
              style: { fontSize: 11, opacity: 0.6, padding: '2px 0' },
            }, '· ' + (u.createdAt || '').replace('T', ' ').slice(0, 19)
              + '　' + T('undoNotes', '{n} 条').replace('{n}', u.noteCount)
              + '　' + T('undoStatusUndone', '已撤销'))))
        : null

      if (!open.length) {
        return h('section', { style: { ...P.card, marginTop: 12 } }, head,
          h('p', { style: P.muted }, T('undoNone',
            '没有可撤销的批次。每次真写前会自动拍一份归属快照，撤销就靠它。')),
          doneBlock)
      }

      return h('section', { style: { ...P.card, marginTop: 12 } }, head,
        h('p', { style: { ...P.muted, fontSize: 11.5 } }, T('undoHint',
          '下到将要执行的第一步是干跑，不会发包。确认清单对再点真撤销。')),
        open.slice(0, 12).map((u) => h('div', {
          key: u.file,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)' },
        },
          h('span', { style: { ...P.muted, fontSize: 11.5, flex: '0 0 auto' } },
            (u.createdAt || '').replace('T', ' ').slice(0, 19)),
          h('span', { style: { ...P.chip, flex: '0 0 auto' } },
            T('undoNotes', '{n} 条').replace('{n}', u.noteCount)),
          h('span', { style: { flex: 1, fontSize: 11, opacity: 0.7,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, u.file),
          h('button', {
            style: P.btn,
            disabled: apply.undoBusy,
            onClick: () => apply.onUndo(u.path, true),
          }, T('undoDry', '干跑')),
          h('button', {
            style: { ...P.btn, ...P.danger },
            disabled: apply.undoBusy,
            onClick: () => {
              // 双点确认：第一下只要求确认，第二下才真执行（和真写一致）
              if (!apply.undoArmed || apply.undoArmed !== u.file) {
                apply.setUndoArmed(u.file)
              } else {
                apply.setUndoArmed(null)
                apply.onUndo(u.path, false)
              }
            },
          }, apply.undoArmed === u.file
            ? T('undoRealNow', '确认撤销')
            : T('undoRealArm', '我要撤销 → 再点一次')))),
        apply.undoBusy
          ? h('p', { style: P.muted }, T('undoRunning', '正在撤销…'))
          : null,
        apply.undoResult
          ? h('pre', { style: { ...P.logPre, marginTop: 8 } },
              apply.undoResult.ok
                ? (apply.undoResult.output || T('undoDone', '完成'))
                : (T('undoErr', '失败：') + (apply.undoResult.error || '')))
          : null,
        doneBlock)
    }

    /**
     * 「AI 动作」页：发芽 / 审问 / 连线。
     * 「AI 动作」页：发芽 / 审问 / 连线。
     *
     * 设计要点（为何长这样）：
     *  · 平台只开了 GET /resource/note/sprout，**没有生成接口**（POST 404），
     *    所以这里不是「一键生成」，而是：取素材 → 拼提示词 → 交给会话里的 AI。
     *  · 每个按钮绑一份**可编辑的提示词**。点之前能看见它会怎么问 AI，
     *    否则用户无法预期结果，也不会信任它。
     *  · 结果只展示，不写回笔记。改正文不可撤销（见 docs/UNDO-DESIGN.md §7）。
     */
    function renderAI(T, h, P, ai, ctl) {
      const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
        h('h2', { style: { ...P.cardTitle, margin: 0 } }, T('aiTitle', 'AI 动作')),
        h('span', { style: { ...P.muted, fontSize: 11.5 } },
          T('aiSub', '发芽 / 审问 / 连线：取素材 + 可改的提示词，结果不自动写回')))

      const noteId = ctl.noteId || ''
      const input = h('section', { style: { ...P.card, marginBottom: 12 } },
        h('p', { style: P.muted }, T('aiHow',
          '填一条笔记的 id（在「分类调整」里展开到「讲」能看到），先生成素材包，再点按钮。')),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            style: { ...P.input, width: 220 },
            placeholder: T('aiNoteIdPh', '笔记 id（数字）'),
            value: noteId,
            onChange: (e) => ctl.setNoteId(e.target.value.trim()),
          }),
          h('button', {
            style: { ...P.btn, ...P.primary },
            disabled: !/^\d{6,}$/.test(noteId) || ctl.packBusy,
            onClick: () => ctl.loadPack(),
          }, ctl.packBusy ? T('aiPacking', '正在取素材…') : T('aiLoadPack', '取素材包')),
          h('button', {
            style: P.btn,
            disabled: !/^\d{6,}$/.test(noteId) || ctl.sproutBusy,
            onClick: () => ctl.checkSprout(),
          }, T('aiCheckSprout', '查平台发芽'))),
        ai.sprout && ai.sprout.checked
          ? h('p', { style: P.dirLine },
              ai.sprout.hasSprout
                ? T('aiSproutHas', '平台侧已有发芽内容，已取回。')
                : T('aiSproutNone', '平台侧还没有发芽。要生成，用下面的按钮由 AI 做；或在得到 App 里点发芽。'))
          : null)

      if (ai.pack && ai.pack.pack) {
        const pk = ai.pack.pack
        // 素材包摘要：让用户确认「AI 看到了什么」，而不是黑箱
        const packView = h('section', { style: { ...P.card, marginBottom: 12 } },
          h('h2', { style: P.cardTitle }, T('aiPackTitle', '素材包（AI 会看到这些）')),
          h('div', { style: P.chipWrap },
            h('span', { style: P.chip }, T('aiPackCenter', '中心：') + (pk.center.title || '').slice(0, 24)),
            h('span', { style: P.chip }, T('aiPackSiblings', '同系列：') + pk.stats.siblings),
            h('span', { style: P.chip }, T('aiPackRelated', '跨系列相关：') + pk.stats.related),
            (pk.keywords || []).map((k) => h('span', { key: 'kw' + k, style: P.chip }, k))),
          pk.siblings.length
            ? h('div', { style: { marginTop: 8 } },
                h('div', { style: { ...P.muted, fontSize: 11 } }, T('aiSibTitle', '同系列的讲：')),
                pk.siblings.map((s) => h('div', { key: s.note_id, style: { ...P.dirLine, marginTop: 2 } },
                  '· ' + (s.title || '').slice(0, 60))))
            : null,
          pk.related.length
            ? h('div', { style: { marginTop: 8 } },
                h('div', { style: { ...P.muted, fontSize: 11 } }, T('aiRelTitle', '跨系列相关（命中词）：')),
                pk.related.map((r) => h('div', { key: r.note_id, style: { ...P.dirLine, marginTop: 2 } },
                  '· [' + (r.course || '').slice(0, 12) + '] ' + (r.title || '').slice(0, 40)
                  + ' — ' + (r.matched || []).join('/'))))
            : null)

        const acts = (ai.data && ai.data.actions) || []
        const prompts = (ai.data && ai.data.prompts) || {}
        const btnRow = h('section', { style: { ...P.card, marginBottom: 12 } },
          h('h2', { style: P.cardTitle }, T('aiActsTitle', '动作（每个按钮绑一份提示词）')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            acts.map((a) => h('button', {
              key: a.id,
              style: { ...P.btn, ...(a.id === ctl.activeAction ? P.primary : null) },
              onClick: () => ctl.setActiveAction(a.id),
              title: a.hint || '',
            }, a.label || a.id))),
          ctl.activeAction && prompts[((acts.find((x) => x.id === ctl.activeAction) || {}).prompt)]
            ? h('div', { style: { marginTop: 10 } },
                h('div', { style: { ...P.muted, fontSize: 11, marginBottom: 4 } },
                  T('aiPromptLabel', '它会这样问 AI（可在 dataDir/prompts 里改）：')),
                h('pre', { style: { ...P.logPre, maxHeight: 200 } },
                  prompts[(acts.find((x) => x.id === ctl.activeAction) || {}).prompt] || ''))
            : null,
          ctl.activeAction
            ? h('div', { style: { marginTop: 10, display: 'flex', gap: 8 } },
                h('button', {
                  style: { ...P.btn, ...P.primary },
                  onClick: () => ctl.buildPayload(),
                }, T('aiBuild', '拼好发给 AI 的内容')),
                h('span', { style: { ...P.muted, fontSize: 11, alignSelf: 'center' } },
                  T('aiBuildHint', '复制后粘到会话里，或直接说「用这个跑一次」')))
            : null)

        return h('div', null, head, input, ai.sprout && ai.sprout.checked ? null : null, packView, btnRow,
          ctl.payload
            ? h('section', { style: P.card },
                h('h2', { style: P.cardTitle }, T('aiPayloadTitle', '要发给 AI 的内容')),
                h('button', { style: { ...P.btn, marginBottom: 8 }, onClick: () => ctl.copyPayload() },
                  T('aiCopy', '复制')),
                h('pre', { style: P.logPre }, ctl.payload))
            : null)
      }

      if (ai.packBusy) {
        return h('div', null, head, input,
          h('section', { style: P.card }, h('p', { style: P.muted }, T('aiPacking2', '正在扫本地镜像找相关上下文…'))))
      }
      if (ai.packError) {
        return h('div', null, head, input,
          h('section', { style: P.card },
            h('p', { style: { ...P.muted, color: 'var(--dsw-alias-state-error-primary)' } },
              T('aiPackFail', '取出失败：') + ai.packError)))
      }
      return h('div', null, head, input,
        h('section', { style: P.card },
          h('p', { style: P.muted }, T('aiIdle', '先填一个笔记 id 并点「取素材包」。只有素材包存在时，按钮才会出现。'))))
    }

    /**
     * 「自动归类」页。
     *
     * 这一页存在的理由：2055 条没归库的笔记，靠「分类调整」里手勾「讲」需要
     * 几百次点击，实际上不可能完成。自动化能做的事必须先被看见、再被确认。
     * 所以这里是三步而非一键：生成计划（只算）→ 看清单（人看）→ 干跑/真写（闸门）。
     */
    function renderAuto(T, h, P, ap, ctl) {
      const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
        h('h2', { style: { ...P.cardTitle, margin: 0 } }, T('autoTitle', '自动归类')),
        h('span', { style: { ...P.muted, fontSize: 11.5 } },
          T('autoSub', '按作者 / 训练营 / 大课程成批归库，只生成计划')))

      const explain = h('section', { style: { ...P.card, marginBottom: 12 } },
        h('p', { style: P.muted }, T('autoWhy',
          '规则一共四条，每条都能解释：① 作者系列（如「万维钢·精英日课6」→ 万维钢）；② 训练营；③ 单目录 ≥ 30 条；④ 其余不动。')),
        h('p', { style: P.muted }, T('autoWhy2',
          '为什么不全自动：零碎目录平均只有 1.7 条笔记，强行归一起只会造出新的垃圾库。')),
        h('div', { style: { marginTop: 10 } },
          h('button', {
            style: { ...P.btn, ...P.primary },
            disabled: ap.phase === 'building',
            onClick: () => ctl.onAutoPlan(),
          }, ap.phase === 'building'
            ? T('autoBuilding', '正在生成计划…')
            : T('autoBuild', '生成归类计划（只算，不写）'))),
        ctl.inv && ctl.inv.data
          ? h('p', { style: P.dirLine },
              T('autoScope', '当前可归类：{n} 条未归库。')
                .replace('{n}', ctl.inv.data.untopiced))
          : null)

      if (ap.phase === 'idle') {
        return h('div', null, head, explain,
          h('section', { style: P.card },
            h('p', { style: P.muted }, T('autoIdle', '点上面的按钮生成计划。生成只是算一遍本地镜像，不联网、不改线上。'))))
      }
      if (ap.phase === 'building') {
        return h('div', null, head, explain,
          h('section', { style: P.card },
            h('p', { style: P.muted }, T('autoLoading', '正在扫 4000+ 个文件头并按规则分组…'))))
      }
      if (ap.phase === 'error') {
        return h('div', null, head, explain,
          h('section', { style: P.card },
            h('p', { style: { ...P.muted, color: 'var(--dsw-alias-state-error-primary)' } },
              T('autoFail', '生成失败：') + ap.error)))
      }

      const d = ap.data || {}
      const groups = d.groups || []
      const sum = d.summary || {}
      const max = groups.length ? groups[0].count : 1

      return h('div', null, head, explain,
        h('div', { style: P.statRow },
          h(Stat, { label: T('autoStatGroups', '拟建知识库'), value: groups.length,
            hint: T('autoStatGroupsHint', '成规模的组') }),
          h(Stat, { label: T('autoStatMove', '将归位'), value: sum.notes_to_move || 0,
            hint: T('autoStatMoveHint', '条笔记') }),
          h(Stat, { label: T('autoStatKeep', '不动'), value: sum.notes_untouched || 0,
            hint: T('autoStatKeepHint', '零碎目录，保留原样') }),
          h(Stat, { label: T('autoStatActions', '动作数'), value: sum.actions || 0,
            hint: T('autoStatActionsHint', '干跑后再真写') })),

        h('section', { style: { ...P.card, marginTop: 14 } },
          h('h2', { style: P.cardTitle }, T('autoGroupsTitle', '会建成这些知识库')),
          groups.map((g, i) => h('div', { key: 'g' + i, style: { marginBottom: 9 } },
            h(RankRow, { name: g.name, count: g.count, max }),
            h('div', { style: { ...P.muted, fontSize: 11, paddingLeft: 2 } },
              Object.entries(g.courses || {}).slice(0, 4)
                .map(([k, v]) => k + ' ' + v).join('　·　'))))),

        Object.keys(d.skipped_sample || {}).length
          ? h('section', { style: { ...P.card, marginTop: 14 } },
              h('h2', { style: P.cardTitle }, T('autoSkipTitle', '不动的（保持原样）')),
              h('p', { style: P.muted }, T('autoSkipWhy',
                '这些目录太小（平均 1.7 条），单独建库只会得到一堆空库。想看完整清单点下面的干跑。')),
              h('div', { style: P.chipWrap },
                Object.entries(d.skipped_sample || {}).slice(0, 12).map(([k, v]) =>
                  h('span', { key: k, style: P.chip }, k + ' ' + v))))
          : null,

        h('section', { style: { ...P.card, marginTop: 14 } },
          h('h2', { style: P.cardTitle }, T('autoNextTitle', '下一步')),
          h('p', { style: P.muted }, T('autoNext',
            '先干跑：不发任何请求，只把每批 20 条的完整清单打出来。确认无误再回「确认执行」页真写。')),
          h('p', { style: P.dirLine }, d.planPath || ''),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', {
              style: { ...P.btn, ...P.primary },
              disabled: ctl.busy,
              onClick: () => ctl.run(true, d.planPath),
            }, ctl.busy ? T('autoRunning', '执行中…') : T('autoDry', '先干跑（不发包）')))))
    }

    /** 「执行日志」页。 */
    function renderLog(T, h, P, log, reload) {
      const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 } },
        h('h2', { style: { ...P.cardTitle, margin: 0 } }, T('logTitle', '执行日志')),
        log.file
          ? h('span', { style: { ...P.muted, fontSize: 11 } },
              log.file + (log.total != null ? ` · ${log.total} 条` : ''))
          : null,
        reload
          ? h('button', { style: { ...P.btn, marginLeft: 'auto' }, onClick: reload },
              T('logReload', '刷新'))
          : null)

      if (log.phase === 'loading') {
        return h('section', { style: P.card }, head,
          h('p', { style: P.muted }, T('logLoading', '正在读日志…')))
      }
      if (log.phase === 'error') {
        return h('section', { style: P.card }, head,
          h('p', { style: { ...P.muted, color: 'var(--dsw-alias-state-error-primary)' } },
            T('logFail', '读日志失败：') + log.error))
      }
      const lines = log.lines || []
      if (!lines.length) {
        return h('section', { style: P.card }, head,
          h('p', { style: P.muted },
            T('logEmpty', '还没有执行记录。所有写操作都会落到 <数据目录>/logs/ 下的审计文件。')))
      }
      return h('section', { style: P.card }, head,
        h('pre', { style: P.logPre }, lines.join('\n')))
    }

    /** 工作台自己的样式（与设置面板的 S 分开，避免互相干扰）。 */
    function panelStyles() {
      const bd = '1px solid var(--dsw-alias-border-l2)'
      const txt2 = 'var(--dsw-alias-label-secondary)'
      return {
        root: {
          display: 'flex', flexDirection: 'column', height: '100%',
          minHeight: 0, padding: '18px 20px 0', boxSizing: 'border-box',
          color: 'var(--dsw-alias-label-primary)',
        },
        header: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
        title: { margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.3 },
        subtitle: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: txt2 },
        pill: {
          flexShrink: 0, fontSize: 11, padding: '3px 9px', borderRadius: 999,
          background: 'var(--dsw-alias-bg-layer-2)',
          color: txt2, border: bd,
        },
        tabs: { display: 'flex', gap: 4, borderBottom: bd },
        tab: {
          appearance: 'none', border: 'none', background: 'transparent',
          color: txt2, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
          borderBottom: '2px solid transparent', marginBottom: -1,
        },
        tabActive: {
          color: 'var(--dsw-alias-label-primary)',
          borderBottom: '2px solid var(--dsw-alias-brand-primary)', fontWeight: 600,
        },
        body: { flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 14, paddingBottom: 20 },
        card: {
          border: bd, borderRadius: 10, padding: 16,
          background: 'var(--dsw-alias-bg-layer-2)',
        },
        cardTitle: { margin: '0 0 8px', fontSize: 14, fontWeight: 600 },
        // —— 按钮 / 表单控件 ——
        btn: {
          font: 'inherit', fontSize: 12, cursor: 'pointer',
          padding: '5px 12px', borderRadius: 6,
          border: bd, background: 'var(--dsw-alias-button-elevated-fill)',
          color: 'inherit', whiteSpace: 'nowrap',
        },
        primary: {
          background: 'var(--dsw-alias-brand-primary)',
          color: 'var(--dsw-alias-label-primary-foreground)', border: 'none',
        },
        danger: {
          background: 'var(--dsw-alias-state-error-primary)',
          color: 'var(--dsw-alias-label-primary-foreground)', border: 'none',
        },
        input: {
          font: 'inherit', fontSize: 12, padding: '4px 8px',
          borderRadius: 6, border: bd, background: 'transparent',
          color: 'inherit', outline: 'none',
        },
        muted: { margin: 0, fontSize: 12.5, lineHeight: 1.6, color: txt2 },

        // ── 数据页样式 ─────────────────────────────────────
        statRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 },
        stat: {
          border: bd, borderRadius: 10, padding: '12px 14px',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
        statTone: {
          warn: { borderColor: 'var(--dsw-alias-state-warn-primary)' },
          ok: { borderColor: 'var(--dsw-alias-state-success-primary)' },
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
          background: 'var(--dsw-alias-interactive-bg-hover)',
        },
        rankBar: {
          height: '100%', borderRadius: 3,
          background: 'var(--dsw-alias-brand-primary)',
        },
        rankCount: {
          flex: '0 0 auto', fontSize: 11.5, color: txt2,
          fontVariantNumeric: 'tabular-nums', minWidth: 32, textAlign: 'right',
        },

        chipWrap: { display: 'flex', flexWrap: 'wrap', gap: 6 },
        chip: {
          fontSize: 11, padding: '3px 8px', borderRadius: 6,
          background: 'var(--dsw-alias-interactive-bg-hover)',
          color: txt2, border: bd, fontVariantNumeric: 'tabular-nums',
        },

        dirLine: { marginTop: 14, fontSize: 11, color: txt2, opacity: 0.7, wordBreak: 'break-all' },

        sgHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
        badge: {
          fontSize: 10.5, padding: '2px 7px', borderRadius: 5,
          background: 'var(--dsw-alias-interactive-bg-hover)',
          color: txt2, border: bd,
        },
        badgeNum: {
          fontSize: 10.5, padding: '2px 7px', borderRadius: 5, color: txt2,
          fontVariantNumeric: 'tabular-nums',
        },
        sgTitle: { margin: '0 0 4px', fontSize: 13, fontWeight: 600, lineHeight: 1.45 },

        // —— 层级树（分类调整页）——
        // 行高 26px 是权衡结果：太小点不准，太大一屏只能看十几行，
        // 而这个面板要能一屏扫完一个目录。
        treeBox: {
          border: bd, borderRadius: 8, overflow: 'auto',
          maxHeight: 'calc(100vh - 300px)', minHeight: 200,
          background: 'var(--dsw-alias-bg-layer-1)',
        },
        // 分组标题：把「我的知识库 / 待归类 / 电子书书架」三种语义隔开，
        // 否则 122 个顶层节点平铺在一起，看不出哪些是自己建的。
        groupLabel: {
          display: 'flex', alignItems: 'baseline', gap: 8,
          padding: '10px 8px 3px', fontSize: 11, fontWeight: 600,
          color: txt2, letterSpacing: '0.02em',
        },
        groupHint: { fontSize: 10.5, fontWeight: 400, color: txt2, opacity: 0.7 },
        treeRow: {
          display: 'flex', alignItems: 'center', gap: 6,
          minHeight: 26, paddingRight: 8, fontSize: 12.5,
          borderBottom: '1px solid var(--dsw-alias-border-l2)',
        },
        treeChev: { flex: '0 0 12px', fontSize: 10, color: txt2, opacity: 0.8 },
        treeCheck: { flex: '0 0 14px', fontSize: 12, color: txt2 },
        treeName: {
          flex: 1, minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
        treeCount: {
          flex: '0 0 auto', fontSize: 11, color: txt2,
          fontVariantNumeric: 'tabular-nums',
        },
        selBar: {
          display: 'flex', alignItems: 'center', gap: 8,
          marginTop: 10, padding: '8px 10px', borderRadius: 8,
          background: 'var(--dsw-alias-bg-layer-2)',
          fontSize: 12,
        },

        // —— 计划表 ——
        planTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
        planTh: {
          padding: '5px 8px', borderBottom: bd, textAlign: 'left',
          fontSize: 11, color: txt2, fontWeight: 600,
        },
        planTd: {
          padding: '5px 8px', borderBottom: bd,
          verticalAlign: 'top', wordBreak: 'break-word',
        },
        logPre: {
          margin: 0, padding: 10, borderRadius: 8, border: bd,
          fontSize: 11.5, lineHeight: 1.6, overflow: 'auto',
          maxHeight: 'calc(100vh - 300px)', whiteSpace: 'pre-wrap',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
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
        // dataDir 现在默认留空（由代码推导），所以空值时不能显示空白，要显示「默认」说明。
        const d = (typeof raw === 'string' && raw) ? raw : ''
        const abs = /^[A-Za-z]:[\\/]/.test(d) || d.startsWith('/')
        return { raw: d || t('dataDirDefault'), abs, empty: !d }
      })()
      const dataDirExplain = h('div', { style: S.dirBox },
        h('p', { style: S.dirHead }, t('dirHead')),
        h('p', { style: S.dirLine },
          h('span', { style: S.dirK }, t('dirWhere')),
          h('code', { style: S.code }, dirBase.raw)),
        h('p', { style: S.dirLine },
          h('span', { style: S.dirK }, t('dirResolved')),
          h('span', { style: S.dirV },
            dirBase.empty ? t('dirDefaultDerived')
              : (dirBase.abs ? t('dirAbsolute') : t('dirRelToWorkspace')))),
        // 光说「由代码推导」等于没说：用户必须能对上自己机器上的真实路径。
        h('p', { style: S.dirLine },
          h('span', { style: S.dirK }, t('dirExampleLabel')),
          h('span', { style: S.dirV }, t('dirExample'))),
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
          order: 201,
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
