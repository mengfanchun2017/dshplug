/**
 * dsh-larkcli · 身份与账户信息（「认证后在面板上看得到什么」）
 *
 * v0.1.0 只报 `bot ✅ / user ❌`，用户看不出这到底是哪个应用、哪个人的账号。
 * 这一层把三类信息拉齐并**只保留可展示字段**：
 *
 *   应用（bot token）
 *     api GET /open-apis/bot/v3/info                       → 应用名、头像、bot open_id、启用状态
 *     api GET /open-apis/application/v6/applications/<id>  → 描述、权限清单、发版状态、owner
 *   用户（user token，设备流授权后才有）
 *     contact +get-user                                    → 姓名、头像、部门、邮箱、工号
 *     auth status                                          → 身份可用性
 *
 * 全部包在 try 里：任一来源失败只让对应字段留空，**不能让整张卡片消失**
 * （面板最忌讳「因为一个可选信息拿不到，连已有的都不显示」）。
 */
import { appScopesOf } from './scopes.js'

/** 从 `api GET` 的返回里剥出 data；失败返回 null 并带原因。 */
function pickData(r, what) {
  if (!r || !r.ok) {
    const err = r?.error || {}
    return {
      data: null,
      error: `${what}：${err.message || (r && r.stderr) || '未知原因'}`,
      code: err.code,
      hint: err.hint,
    }
  }
  return { data: r.json?.data ?? r.json ?? null, error: '' }
}

/**
 * 应用名/头像（bot v3）。这个接口只要 `application:bot.basic_info:read`，
 * 比 application v6 门槛低，所以**先用它兜底**：即使 v6 没权限，也有名字显示。
 */
export async function botInfo(service, accountId) {
  const r = await service.run(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot'], {
    accountId,
    timeoutMs: 25000,
  })
  const { data, error, code } = pickData(r, '读取应用信息')
  return {
    appName: String(data?.app_name || ''),
    avatarUrl: String(data?.avatar_url || ''),
    openId: String(data?.open_id || ''),
    activateStatus: data?.activate_status ?? null,
    error,
    code,
  }
}

/**
 * 应用详情（application v6）：描述、owner、权限清单、发版状态。
 * 需要 `application:application:self_manage`（本机应用已开通）。
 */
export async function appInfo(service, accountId, appId, brand = 'feishu') {
  const lang = brand === 'lark' ? 'en_us' : 'zh_cn'
  const r = await service.run(
    ['api', 'GET', `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`, '--params', JSON.stringify({ lang }), '--as', 'bot'],
    { accountId, timeoutMs: 25000 },
  )
  const { data, error, code } = pickData(r, '读取应用详情')
  const app = data?.app || null
  if (!app) return { app: null, scopes: {}, error, code }
  return {
    app: {
      appId: String(app.app_id || appId),
      appName: String(app.app_name || ''),
      description: String(app.description || ''),
      avatarUrl: String(app.avatar_url || ''),
      status: app.status,
      sceneType: app.scene_type,
      primaryLanguage: String(app.primary_language || ''),
      onlineVersionId: String(app.online_version_id || ''),
      ownerId: String(app.owner?.owner_id || ''),
      ownerType: app.owner?.type,
      callbackType: String(app.callback_info?.callback_type || ''),
      createSource: String(app.create_source || ''),
    },
    scopes: appScopesOf(data),
    error,
  }
}

/**
 * 当前 user 身份（设备流授权后）。未授权时 `user` 为 null，`hint` 说明怎么授权。
 *
 * `contact +get-user` 不带 --user-id 就是「查自己」，但要 user 身份；
 * 另外它还要求 `contact:user.basic_profile:readonly`（粗略）——
 * 缺权限时飞书返回的 hint 会直接给一条带 --scope 的命令，这里把它剥出来复用。
 */
export async function userInfo(service, accountId) {
  const r = await service.run(['contact', '+get-user', '--as', 'user'], { accountId, timeoutMs: 25000 })
  if (!r.ok) {
    const err = r?.error || {}
    const missing = Array.isArray(err.missing_scopes) ? err.missing_scopes : []
    return {
      user: null,
      error: err.message || r.stderr || '未知原因',
      subtype: err.subtype || '',
      missingScopes: missing,
      consoleUrl: String(err.console_url || ''),
      hint: String(err.hint || ''),
    }
  }
  const u = r.json?.data?.user || r.json?.data || r.json || {}
  return {
    user: {
      name: String(u.name || ''),
      enName: String(u.en_name || ''),
      avatarUrl: String(u.avatar_url || u.avatar_big || ''),
      openId: String(u.open_id || ''),
      unionId: String(u.union_id || ''),
      userId: String(u.user_id || ''),
      email: String(u.email || u.enterprise_email || ''),
      mobile: String(u.mobile || ''),
      jobTitle: String(u.job_title || ''),
      employeeNo: String(u.employee_no || ''),
      department: Array.isArray(u.department_ids) ? u.department_ids : [],
      city: String(u.city || ''),
      country: String(u.country || ''),
    },
    error: '',
  }
}

/**
 * 一次拿齐某账户的全部可展示信息。
 *
 * @param {object} opts
 * @param {object} opts.service     LarkService
 * @param {object} opts.account     账户登记项
 * @param {object} [opts.status]    已有 auth status（省一次探测）
 * @param {boolean} [opts.withApp]  是否拉 application v6（贵一点，但能拿到权限清单）
 */
export async function describeAccount({ service, account, status = null, withApp = true, verify = false } = {}) {
  const accountId = account.id
  const st = status || (await service.status({ account: accountId, verify }).catch(() => null))
  const out = {
    id: accountId,
    label: account.label,
    appId: account.appId || st?.appId || '',
    brand: account.brand || st?.brand || 'feishu',
    // verified 只有 status({verify:true}) 才有；透出去，面板才能区分“存在”与“真有效”。
    bot: {
      available: !!st?.identities?.bot?.available,
      status: st?.identities?.bot?.status || '',
      verified: st?.identities?.bot?.verified,
      openId: st?.identities?.bot?.openId || '',
      appName: st?.identities?.bot?.appName || '',
    },
    user: {
      available: !!st?.identities?.user?.available,
      status: st?.identities?.user?.status || '',
      verified: st?.identities?.user?.verified,
    },
    app: null,
    appScopes: {},
    userProfile: null,
    errors: [],
    fetchedAt: new Date().toISOString(),
  }

  // 应用信息：两个接口互为兜底。bot v3 门槛低，先跑它。
  if (out.bot.available) {
    try {
      const b = await botInfo(service, accountId)
      out.app = {
        appId: out.appId,
        appName: b.appName,
        avatarUrl: b.avatarUrl,
        description: '',
        botOpenId: b.openId,
        activateStatus: b.activateStatus,
        description2: '',
      }
      if (b.error) out.errors.push(b.error)
    } catch (e) {
      out.errors.push(`读取应用信息失败：${String(e.message || e)}`)
    }
    if (withApp && out.appId) {
      try {
        const a = await appInfo(service, accountId, out.appId, out.brand)
        if (a.app) {
          out.app = {
            ...out.app,
            appName: out.app.appName || a.app.appName,
            avatarUrl: out.app.avatarUrl || a.app.avatarUrl,
            description: a.app.description,
            status: a.app.status,
            sceneType: a.app.sceneType,
            primaryLanguage: a.app.primaryLanguage,
            onlineVersionId: a.app.onlineVersionId,
            ownerId: a.app.ownerId,
            callbackType: a.app.callbackType,
          }
          out.appScopes = a.scopes
        }
        if (a.error) out.errors.push(a.error)
      } catch (e) {
        out.errors.push(`读取应用详情失败：${String(e.message || e)}`)
      }
    }
  }

  // 用户信息：没授权就是 null，不算错误
  if (out.user.available) {
    try {
      const u = await userInfo(service, accountId)
      out.userProfile = u.user
      if (u.user && u.user.openId) out.user.openId = u.user.openId
      if (u.error) out.errors.push(`读取用户信息失败：${u.error}`)
      if (u.missingScopes?.length) out.user.missingScopes = u.missingScopes
      if (u.consoleUrl) out.user.consoleUrl = u.consoleUrl
    } catch (e) {
      out.errors.push(`读取用户信息失败：${String(e.message || e)}`)
    }
  } else {
    const st2 = st?.identities?.user || {}
    out.user.hint = st2.hint || '需要 user 身份时：lark_login_start'
  }

  return out
}

/** 一句话概括（工具输出与面板徽标共用）。 */
export function identityLine(info) {
  const parts = []
  const name = info?.app?.appName || info?.appId || info?.id || '?'
  parts.push(name)
  if (info?.app?.description) parts.push(`（${info.app.description}）`)
  const who = info?.userProfile?.name ? `${info.userProfile.name}${info.userProfile.email ? ` <${info.userProfile.email}>` : ''}` : ''
  const flags = [info?.bot?.available ? 'bot✅' : 'bot❌', info?.user?.available ? `user✅${who ? ` ${who}` : ''}` : 'user❌']
  return `${parts.join('')} ${flags.join(' ')}`
}
