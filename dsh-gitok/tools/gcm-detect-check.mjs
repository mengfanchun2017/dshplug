#!/usr/bin/env node
/**
 * GCM 定位回归测试 —— 专治「明明装着却报未找到」。
 *
 * 为什么需要它：
 *   v0.4.4 及之前 resolveGcm() 只查 4 条写死的绝对路径，其中第一条还是开发机的
 *   用户目录（C:\Users\franc\...）。换一台机器，只要 GCM 不在那 4 个位置，面板就报
 *   「❌ 未找到 GCM，无法管理凭据」—— 而该机 git 认证其实完全正常。
 *   用户就是这么撞上的，且没有任何手段从面板上判断「插件没找」还是「真没装」。
 *
 *   这类 bug 用 node --check 查不出（语法正确），用烟雾测试也查不出（本机恰好命中），
 *   只能用「断言源码里不许出现开发机路径 + 逐个验证解析函数」的方式钉住。
 *
 * 它做什么：
 *   1. 静态断言：源码不得含 C:\Users\<名>\ 或 C:\Program Files\...exe 之类写死路径
 *   2. 静态断言：旧的 GCM_CANDIDATES 表必须已被删除
 *   3. 运行时断言：直接调用 GCM 定位里的纯函数，验证各层判定
 *   4. 调用链断言：所有 gcm() 调用点都必须 await（async 改造漏一个就静默出错）
 *
 * 用法：
 *   $node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
 *   & $node C:\dsh\dw-plugin\dsh-gitok\tools\gcm-detect-check.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const indexPath = path.join(here, '..', 'lib', 'index.js')
const src = readFileSync(indexPath, 'utf8')

let bad = 0
const ok = (name) => console.log(`✅ ${name}`)
const fail = (name, extra) => {
  bad++
  console.log(`❌ ${name}`)
  if (extra) for (const e of [].concat(extra)) console.log('   ' + e)
}
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return ok(name)
  fail(name, [`实际: ${JSON.stringify(got)}`, `期望: ${JSON.stringify(want)}`])
}
const truthy = (name, cond, why) => (cond ? ok(name) : fail(name, why))

// ── 1. 静态断言：去掉注释后，代码里不许有写死的绝对路径 ────────────────────
// 注释里举 C:\Program Files 当例子是对的（说明为什么要加引号），不能一起判死。
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
  .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（避开 https://）

eq('代码里无 C:\\Users\\<名>\\ 写死路径', code.match(/C:\\+Users\\+[A-Za-z0-9_.-]+\\+/g) || [], [])
eq('代码里无 C:\\Program Files\\...exe 写死路径', code.match(/C:\\+Program Files[^'"`\r\n]*\.exe/gi) || [], [])
truthy('代码里无开发机用户名（franc）', !/franc/i.test(code))
truthy('旧的 GCM_CANDIDATES 路径表已删除', !code.includes('GCM_CANDIDATES'), ['该表是本次 bug 的根因'])

// ── 2. 静态断言：新的多来源定位必须都在 ────────────────────────────────
for (const sym of ['GCM_EXE_NAMES', 'GCM_SUBDIRS', 'gcmInstallRootDirs', 'gcmDirsFromExecPath', 'gcmProbeCommand', 'parseGcmProbe', 'managerCoreBroken', 'probeFailed', 'gcmInfo']) {
  truthy(`实现了 ${sym}`, src.includes(sym))
}

// ── 3. 调用链：gcm() 已改成 async，漏 await 会把 Promise 当路径用 ──────────
const nakedCalls = code
  .split(/\r?\n/)
  .filter((l) => /(?:^|[^.\w])gcm\(\)|api\.gcm\(\)/.test(l))
  .filter((l) => !/await\s/.test(l))
  .filter((l) => !/const gcm\s*=|gcmInfo\s*=/.test(l))
eq('所有 gcm() 调用点都 await 了', nakedCalls, [])

// ── 4. 运行时：把定位逻辑那一段纯函数抽出来直接调 ─────────────────────────
const lines = src.split(/\r?\n/)
const start = lines.findIndex((l) => l.includes('GCM 可执行文件名'))
const end = lines.findIndex((l) => l.includes('探测结果缓存')) - 2
if (start < 0 || end <= start) {
  fail('能从源码里抽出 GCM 定位纯函数段', [`start=${start} end=${end}`])
} else {
  const body = lines.slice(start, end + 1).join('\n')
  let t = null
  try {
    t = new Function('existsSync', 'path', 'process', body +
      '\nreturn { parseGcmProbe, gcmDirsFromExecPath, helperBareName, gcmPathFromHelperValue, gcmInstallRootDirs, splitPathEnv }')(existsSync, path, process)
  } catch (err) {
    fail('抽出段可执行', [err.message])
  }

  if (t) {
    // 4a. git --exec-path → 同级 bin（这是「问 git」这一层的核心）
    const realExec = 'C:/Users/someone/AppData/Local/Programs/MinGit/ucrt64/libexec/git-core'
    eq('exec-path 反推出同级 bin',
      t.gcmDirsFromExecPath(realExec)[0],
      path.join('C:\\Users\\someone\\AppData\\Local\\Programs\\MinGit\\ucrt64', 'bin'))
    eq('exec-path 为空时不报错', t.gcmDirsFromExecPath(''), [])

    // 4b. 探针输出解析：注册表 / exec-path / helper（含 scoped 行）
    const probeText = [
      'REG_HKLM: C:\\Program Files\\Git',
      'REG_HKCU: ',
      'EXECPATH: C:/Program Files/Git/ucrt64/libexec/git-core',
      'HELPER: manager-core',
      'SCOPED: credential.https://github.com.helper !"C:/tools/gcm/git-credential-manager.exe"',
      'SCOPED: credential.https://gist.github.com.helper',
    ].join('\n')
    const info = t.parseGcmProbe(probeText)
    eq('探针解析 HKLM', info.regHklm, 'C:\\Program Files\\Git')
    eq('探针解析空 HKCU', info.regHkcu, '')
    eq('探针解析 exec-path', info.execPath, 'C:/Program Files/Git/ucrt64/libexec/git-core')
    eq('探针解析 helper 值（空 scoped 行不产空串）', info.helperValues,
      ['manager-core', '!"C:/tools/gcm/git-credential-manager.exe"'])

    // 4c. 裸名 vs 路径：决定「这是交给 git 解析的名字」还是「可直接执行的 exe」
    eq('manager 是裸名', t.helperBareName('manager'), 'manager')
    eq('manager-core 也是裸名（会走旧名诊断）', t.helperBareName('manager-core'), 'manager-core')
    eq('! 命令不是裸名', t.helperBareName('!"C:/x/git-credential-manager.exe"'), '')
    eq('绝对路径不是裸名', t.helperBareName('C:\\x\\git-credential-manager.exe'), '')

    const realExe = 'C:\\Windows\\System32\\cmd.exe'
    eq('存在的绝对路径被采纳', t.gcmPathFromHelperValue(realExe), realExe)
    eq('带引号与 ! 前缀会被剥壳', t.gcmPathFromHelperValue('!"' + realExe + '"'), realExe)
    eq('不存在的路径不采纳', t.gcmPathFromHelperValue('C:\\nope\\git-credential-manager.exe'), '')
    eq('裸名不当作路径', t.gcmPathFromHelperValue('manager'), '')

    // 4d. 安装根只由环境变量推导 —— 这条是「不再写死开发机路径」的行为级证明
    const roots = t.gcmInstallRootDirs()
    eq('安装根含 ucrt64 新布局', roots.some((d) => /MinGit\\ucrt64\\bin$/i.test(d)), true)
    eq('安装根含独立安装包目录', roots.some((d) => /Git Credential Manager$/i.test(d)), true)
    eq('安装根含 dotnet tool 目录', roots.some((d) => /\.dotnet\\tools$/i.test(d)), true)
    // 所有根都必须能被某个环境变量解释（换机器就自动变）
    const envVals = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, process.env.USERPROFILE]
      .filter(Boolean)
    eq('每个安装根都能被环境变量解释', roots.filter((d) => !envVals.some((v) => d.startsWith(v))), [])
  }
}

// ── 5. 文案断言：面板/报告不得把「没查到」写成「不存在」 ──────────────────
const clientSrc = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
truthy('面板 deps 说明提到四层探测', /git --exec-path/.test(clientSrc))
truthy('面板提示 where.exe 不可靠', /不能打印版本|能打印版本/.test(clientSrc))
truthy('宿主有「无法确认」措辞（探针失败分支）', /无法确认 GCM 是否已装/.test(src))

console.log(bad ? `\n失败 ${bad} 项` : '\n全部通过')
process.exit(bad ? 1 : 0)
