/**
 * dsh-larkcli · 二进制生命周期（安装 / 升级 / 校验）
 *
 * 为什么单独一层：v0.1.0 把版本和 SHA256 **写死**在 fetch-lark-cli.ps1 里，
 * 官方一发新版脚本就报「硬编码版本与最新版不一致」——那不是升级，那是每年返工一次。
 * 这里改成「每次现查现装」：
 *
 *   1) 列 https://registry.npmmirror.com/-/binary/lark-cli/   → 语义化排序取最大版本
 *   2) 读该版本目录下的 checksums.txt                         → 官方发布的 SHA256
 *   3) 下载 lark-cli-<ver>-windows-<arch>.zip                 → 校验，不匹配直接拒绝
 *   4) 解压（Windows 自带 tar.exe 支持 zip）→ 原子替换 exe
 *
 * 只用 Node 内建能力（fetch / crypto / fs）+ 系统 tar.exe，
 * 不依赖 npm 包、不依赖 PowerShell —— 这样面板按钮和模型工具走的是同一条路。
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir } from './core.js'

/** npmmirror 是官方推荐的国内镜像；GitHub 直连在国内基本不可用（本机实测超时）。 */
export const MIRROR_BASE = 'https://registry.npmmirror.com/-/binary/lark-cli'
/** 备用源：镜像挂掉时至少还有一条路（会慢，但比没有强）。 */
export const GITHUB_BASE = 'https://github.com/larksuite/cli/releases/download'
/** zip 里的四个文件，装 exe 之外顺手把文档也带过来（便于离线查）。 */
export const ASSET_DOCS = ['README.md', 'CHANGELOG.md', 'LICENSE']

/** 目标平台资产名。lark-cli 的 windows 包只有 amd64 / arm64 两种。 */
export function assetName(version, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : 'amd64'
  return `lark-cli-${version}-windows-${a}.zip`
}

/** 'v1.0.100' / '1.0.100' → [1,0,100]；无法解析返回 null。 */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * 语义化比较：a>b 返回正数。故意不用字符串比较（'1.0.100' < '1.0.99' 是字符串陷阱）。
 *
 * 预发布后缀也按 semver 处理：`1.2.3-beta` < `1.2.3`。
 * 镜像上真出过 rc 版本，把 rc 当正式会误报「已最新」而不升级（或反之降级）。
 */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  // 数字部分相等时看预发布：有后缀的比没后缀的小
  const pa = String(a ?? '').trim().replace(/^v?\d+\.\d+\.\d+/, '').replace(/^[-+]/, '')
  const pb = String(b ?? '').trim().replace(/^v?\d+\.\d+\.\d+/, '').replace(/^[-+]/, '')
  if (pa && !pb) return -1
  if (!pa && pb) return 1
  if (pa === pb) return 0
  return pa < pb ? -1 : 1
}

function fetchOpts(timeoutMs) {
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  return { signal, redirect: 'follow', headers: { 'user-agent': 'dsh-larkcli-installer' } }
}

async function fetchText(url, timeoutMs = 20000) {
  const r = await fetch(url, fetchOpts(timeoutMs))
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return await r.text()
}

/** 列镜像上的所有版本目录，返回按语义化**降序**的版本号数组（不带 v 前缀）。 */
export async function listVersions({ timeoutMs = 20000 } = {}) {
  const text = await fetchText(`${MIRROR_BASE}/`, timeoutMs)
  const json = JSON.parse(text)
  const arr = Array.isArray(json) ? json : []
  const out = []
  for (const item of arr) {
    const name = typeof item === 'string' ? item : item?.name
    const m = /^v?(\d+\.\d+\.\d+)\/?$/.exec(String(name || ''))
    if (m) out.push(m[1])
  }
  // 去重 + 降序
  return [...new Set(out)].sort((a, b) => compareVersions(b, a))
}

/** 最新版；网络异常时抛出可读错误（调用方决定是「提示」还是「失败」）。 */
export async function latestVersion(opts = {}) {
  const list = await listVersions(opts)
  if (!list.length) throw new Error('镜像上没有可用版本（返回为空）')
  return list[0]
}

/**
 * 取某版本的官方 SHA256。
 * checksums.txt 形如 `<hash>  <asset>`，与 release 里的文件一一对应。
 */
export async function checksumFor(version, asset, { timeoutMs = 20000 } = {}) {
  const text = await fetchText(`${MIRROR_BASE}/v${version}/checksums.txt`, timeoutMs)
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m && m[2].trim() === asset) return m[1].toLowerCase()
  }
  // 没有 checksums.txt 或里面没这个文件：**不猜**，交给调用方拒绝安装
  return ''
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function runTar(args, timeoutMs = 120000) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const exe = fs.existsSync(tar) ? tar : 'tar'
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
    } catch (e) {
      return resolve({ ok: false, error: String(e.message || e) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: `tar 超过 ${timeoutMs}ms` })
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(e.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, error: code === 0 ? '' : `tar exit ${code}` })
    })
  })
}

/**
 * 安装/升级到指定版本（省略 = 最新版）。
 *
 * @param {object} opts
 * @param {string} opts.targetExe   最终 exe 路径（插件目录下的 lark-cli-win\lark-cli.exe）
 * @param {string} opts.stagingDir  临时目录（数据目录下 staging，装完清空）
 * @param {string} [opts.version]   目标版本；省略 → 查镜像最新
 * @param {boolean} [opts.force]    同版本也重装
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{ok:boolean, version:string, previousVersion:string, changed:boolean,
 *                    sha256:string, source:string, exe:string, docs:string[], log:string[], error?:string}>}
 */
export async function installBinary({ targetExe, stagingDir, version = '', force = false, log = () => {} } = {}) {
  const lines = []
  const say = (m) => {
    lines.push(m)
    try {
      log(m)
    } catch {
      /* 日志回调不许影响安装 */
    }
  }
  const result = {
    ok: false,
    version: '',
    previousVersion: '',
    changed: false,
    sha256: '',
    source: '',
    exe: targetExe,
    docs: [],
    log: lines,
    error: '',
  }

  try {
    result.previousVersion = fs.existsSync(targetExe) ? 'unknown' : ''
    const want = version ? String(version).replace(/^v/, '') : await latestVersion()
    result.version = want
    say(`目标版本 ${want}`)

    if (!force && fs.existsSync(targetExe) && result.previousVersion) {
      const vs = await probeVersion(targetExe)
      result.previousVersion = vs || 'unknown'
      if (vs && compareVersions(vs, want) === 0) {
        say(`已是最新（本机 ${vs}），跳过下载。要强制重装传 force=true。`)
        result.ok = true
        result.sha256 = sha256File(targetExe)
        result.source = 'local'
        result.changed = false
        return result
      }
      say(`本机 ${vs || '未知'} → ${want}`)
    }

    const asset = assetName(want)
    say(`资产 ${asset}`)
    const expect = await checksumFor(want, asset)
    if (!expect) {
      throw new Error(
        `拿不到 ${asset} 的官方 SHA256（checksums.txt 里没有这一行）。` +
          '出于安全考虑拒绝安装未校验的二进制 —— 请确认该版本文件名为 ' +
          asset +
          '，或手动核对后放到插件目录。',
      )
    }

    ensureDir(stagingDir)
    const zipPath = path.join(stagingDir, asset)
    const url = `${MIRROR_BASE}/v${want}/${asset}`
    say(`下载 ${url}`)
    const r = await fetch(url, fetchOpts(180000))
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}（${url}）`)
    const buf = Buffer.from(await r.arrayBuffer())
    fs.writeFileSync(zipPath, buf)
    result.source = url
    say(`已下载 ${buf.length} 字节`)

    const actual = sha256File(zipPath)
    if (actual !== expect) {
      try {
        fs.unlinkSync(zipPath)
      } catch {
        /* ignore */
      }
      throw new Error(`SHA256 不匹配，已拒绝安装。\n  期望 ${expect}\n  实际 ${actual}`)
    }
    say('SHA256 校验通过')
    result.sha256 = actual

    const outDir = path.join(stagingDir, `x-${want}`)
    fs.rmSync(outDir, { recursive: true, force: true })
    ensureDir(outDir)
    const t = await runTar(['-xf', zipPath, '-C', outDir])
    if (!t.ok) throw new Error(`解压失败：${t.error}`)
    const newExe = path.join(outDir, 'lark-cli.exe')
    if (!fs.existsSync(newExe)) throw new Error(`压缩包里没有 lark-cli.exe（${outDir}）`)

    // 原子替换：先改名旧的，再落新的，最后删旧的。
    // 直接覆盖正在被占用的 exe 会 EBUSY；改名不受影响。
    ensureDir(path.dirname(targetExe))
    const oldPath = `${targetExe}.old-${Date.now()}`
    if (fs.existsSync(targetExe)) {
      try {
        fs.renameSync(targetExe, oldPath)
      } catch (e) {
        throw new Error(`无法替换正在使用的 exe（请先退出 DSH 或确保没有 lark-cli 进程在跑）：${e.message}`)
      }
    }
    try {
      fs.copyFileSync(newExe, targetExe)
    } catch (e) {
      // 失败要把旧的放回去，别留下「装了一半」的状态
      try {
        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, targetExe)
      } catch {
        /* ignore */
      }
      throw new Error(`写入新 exe 失败：${e.message}`)
    }
    try {
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
    } catch {
      /* 旧文件删不掉不影响使用，下次会覆盖 */
    }

    // 顺手把 README/CHANGELOG/LICENSE 一起更新（离线可查，且与 exe 版本对齐）
    for (const doc of ASSET_DOCS) {
      const src = path.join(outDir, doc)
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(path.dirname(targetExe), doc))
          result.docs.push(doc)
        } catch {
          /* 文档失败不算安装失败 */
        }
      }
    }

    result.changed = true
    result.ok = true
    say(`完成：${targetExe}`)
    try {
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.unlinkSync(zipPath)
    } catch {
      /* 清理失败不影响结果 */
    }
    const after = await probeVersion(targetExe)
    if (after) {
      result.version = after
      say(`新版本自报：${after}`)
    }
    return result
  } catch (e) {
    result.error = String(e.message || e)
    say(`失败：${result.error}`)
    return result
  }
}

/**
 * 读 exe 自报版本（`lark-cli --version` 输出里抓 semver）。
 *
 * 失败返回 **`'unknown'`**（不是空串）：空串在调用方那里会被当成“未提供”，
 * 而“文件在但读不出版本”和“根本没有文件”是两件不同的事，
 * 混淆了就会把损坏的 exe 当成已安装最新版（updateStatus 靠 `!== 'unknown'` 判断）。
 */
export function probeVersion(exePath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child
    const tmp = path.join(os.tmpdir(), `lark-ver-${process.pid}-${Date.now()}.txt`)
    let fd
    try {
      fd = fs.openSync(tmp, 'w')
      child = spawn(exePath, ['--version'], {
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, NO_COLOR: '1', LARKSUITE_CLI_NO_UPDATE_CHECK: '1' },
      })
    } catch {
      try {
        if (fd !== undefined) fs.closeSync(fd)
      } catch {
        /* ignore */
      }
      return resolve('unknown')
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
      let text = ''
      try {
        text = fs.readFileSync(tmp, 'utf8')
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      const m = /(\d+\.\d+\.\d+)/.exec(text)
      resolve(m ? m[1] : 'unknown')
    }
    child.on('error', finish)
    child.on('close', finish)
  })
}

/**
 * 版本体检：本机 / 最新 / 是否有更新。
 * **网络失败不是错误**：返回 reachable=false，面板显示「查不到」而不是假装「已最新」。
 */
export async function updateStatus({ exePath, timeoutMs = 20000 } = {}) {
  const out = {
    installed: '',
    latest: '',
    updateAvailable: false,
    reachable: false,
    error: '',
    asset: '',
    command: '',
  }
  if (exePath && fs.existsSync(exePath)) {
    out.installed = (await probeVersion(exePath)) || 'unknown'
  }
  try {
    out.latest = await latestVersion({ timeoutMs })
    out.reachable = true
    out.asset = assetName(out.latest)
    if (out.installed && out.installed !== 'unknown') {
      out.updateAvailable = compareVersions(out.latest, out.installed) > 0
    }
  } catch (e) {
    out.error = String(e.message || e)
  }
  out.command = out.updateAvailable ? `lark_install（升级到 ${out.latest}）` : out.installed ? '' : 'lark_install'
  return out
}
