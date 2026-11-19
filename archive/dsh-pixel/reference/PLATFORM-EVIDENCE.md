# 平台证据摘录 · dsh-pixel 退役相关

采集时间 2026-11-16。每条都标注了取证方式，**没有一条是猜的**。

---

## E1 · 市场版数据目录与文件格式

**来源**：`C:\Users\franc\.dsh\profiles\desktop\node_modules\@muxiuesd\dsh-pixel-studio\index.js`
（已安装的 `@muxiuesd/dsh-pixel-studio@0.6.1`，直接读的安装产物，不是文档）

```js
function storeDirectory() {
    const profile = process.env.DSH_PROFILE_DIR;
    if (profile && profile.trim() !== '') return path.join(profile, 'pixel-studio');
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'pixel-studio');
}

function storeFile() {
    return path.join(storeDirectory(), 'works.json');
}
```

读取时的校验（同文件 `load()` 附近）：

```js
if (parsed && typeof parsed === 'object' && parsed.works && typeof parsed.works === 'object') {
    cache = { version: 1, works: parsed.works };
} else { cache = { version: 1, works: {} }; }
```

**结论**：本机实际路径 = `C:\Users\franc\.dsh\pixel-studio\works.json`（实测存在，4,722 字节）。
只认 `works` 是对象，作品对象内部字段不校验 → 与自研版写入的数据兼容。

---

## E2 · 自研版宿主半不读写作品存储

**来源**：`dsh-pixel\lib\index.js` 文件头注释（归档于 `source\lib\index.js`）

```
 * Everything else (artwork storage, the PNG the editor shows, history) stays in
 * a pixel store plugin; this route never reads or writes that store.
```

**结论**：`~/.dsh/pixel-studio/` 不是自研 `dsh-pixel` 的私有数据，删它等于删市场版的作品。

---

## E3 · 卸载后宿主路由返回 404

**取证方式**：对本机运行中的 DSH Web GUI 发 HTTP 请求。

| URL | 结果 |
|---|---|
| `GET http://127.0.0.1:56487/plugins/pixel/state` | **404** |
| `GET http://127.0.0.1:56487/plugins/pixel/works` | **404** |
| `GET http://127.0.0.1:56487/` | 401（GUI 需要鉴权，正常） |

**结论**：插件已从运行时摘除，宿主半没有残留注册。

---

## E4 · profile 里只剩 Junction 残留

**来源**：`C:\Users\franc\.dsh\profiles\desktop\package.json` / `pnpm-workspace.yaml` / `cordis.patch.yml`

- `dependencies` 中**没有** `dsh-pixel`；
- `dsh.profile.bundles` 中**没有** `dsh-pixel`（只有 `@muxiuesd/dsh-pixel-studio`）；
- `cordis.patch.yml` 中 `pixel` 匹配 **0 行**；
- 但 `node_modules\dsh-pixel` 存在，`LinkType=Junction`，`Target=C:\dsh\dshplug\dsh-pixel`。

**结论**：卸载只摘了「声明」，没摘「落实出来的软链接」。见 README ADR-004。

---

## E5 · 测试代码对目录结构的硬约束

**来源**：`dsh-pixel\test\host.test.mjs`

```js
const listJson = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "list.json"), "utf8"));
const entry = listJson.plugins.find((plugin) => plugin.name === "dsh-pixel");
assert.ok(entry, "registered in list.json");
assert.equal(entry.version, pkg.version, "list.json version in sync");
assert.equal(entry.status, "active", "list.json status");
assert.equal(entry.dir, "dsh-pixel", "list.json dir");
assert.equal(entry.packageName, undefined, "no packageName needed when dir === name");
```

**结论**：
1. 测试依赖 `<插件目录>\..\list.json`——所以归档里的 `source\` **不能直接跑测试**
   （上一级是归档根，没有 `list.json`），必须先还原成 `dsh-pixel\` 目录并登记回 `list.json`。
2. 目录名必须等于包名，且 `list.json` 条目里不能有 `packageName` 字段。

---

## E6 · `dsh-pixel` 的 Git 状态（含一次自我纠错）

### 最初（错误的）取证

在 `C:\dsh\dshplug` 执行：

```powershell
git ls-files dsh-pixel         # 当时看到的输出 → 判定为 0 条
git log --oneline -- dsh-pixel # 当时看到的输出 → 判定为无输出
```

据此写下「从未进入 Git」。**这个结论是错的**。

### 更正后的实测（2026-11-16 复核）

```powershell
$f = git -C C:\dsh\dshplug ls-files -- dsh-pixel
($f | Measure-Object).Count        # → 49
git -C C:\dsh\dshplug log --oneline --all -- dsh-pixel
# → 3221bdf 新增 dsh-pixel：像素 IP 工作台插件
# → 33f5b13 update 统一：dataDir 出仓库 + 技能面收窄 + ARCHITECTURE/ADR/BOOTSTRAP 文档
git -C C:\dsh\dshplug ls-tree --name-only origin/master -- dsh-pixel
# → dsh-pixel   （已推送到远端）
git -C C:\dsh\dshplug diff --stat -- dsh-pixel | Select-Object -Last 1
# → 49 files changed, 3102 deletions(-)
```

**结论**：
1. `dsh-pixel` **已被 Git 追踪且有两次提交，且已推送**。删除它会在 `git status` 里表现为 49 条 `D`，
   **需要提交并推送**才能同步到其他机器；不提交的话另一台 `git pull` 仍会拉回旧版目录。
2. 不改写 Git 历史（已推送，强推无收益）。见归档 README 的 ADR-003。
3. **教训**：判断「是否被追踪」必须用 `git ls-files` **带 `--` 分隔符** 并 `Measure-Object` 计数，
   再用 `git log --all` 与 `git ls-tree origin/master` 交叉验证。只看一次输出（尤其是被截断/夹杂大量日志时）
   极易把「空结果」误读成「没有」。
4. 最初误判的成因：第一次查询时同一批输出里混着 `git status` 结果，`ls-files` 那两行被当成空输出。
   （归档时该误判已写入 README / DEVELOPMENT-LOG，**均已同步更正**。）

---

## E7 · 沙箱事实：管道会被拒

**取证方式**：在 workspace-write 模式下执行 `& $node test/run.mjs 2>&1 | Select-Object -Last 30`。

```
程序'node.exe'运行失败： Access to the path '\\.\pipe\LOCAL\dotnet_....' is denied.
```

改用 `Start-Process -NoNewWindow -RedirectStandardOutput <文件>` 后正常执行。

**结论**：跑 node / pnpm / tar 一律重定向到文件再读，不要接 PowerShell 管道。
这条与插件无关，但会让「测试跑不起来」被误判成插件坏了。

---

## E8 · 归档时 `archive\` 目录整树写入被拒

**取证方式**：五项独立探测，同一时刻仓库根写入正常。

| 探测 | 结果 |
|---|---|
| `New-Item C:\dsh\dshplug\archive\_probe-a` | denied |
| `New-Item C:\dsh\dshplug\archive\dsh-pixel\source` | denied |
| `Set-Content C:\dsh\dshplug\archive\_probe.txt` | denied |
| `Set-Content C:\dsh\dshplug\archive\dsh-preview-editor\_probe.txt` | denied |
| `Rename-Item C:\dsh\dshplug\archive\dsh-preview-editor` | denied |
| `New-Item C:\dsh\dshplug\_probe-c`（对照组，仓库根） | **OK** |

`Get-Acl C:\dsh\dshplug\archive` 的继承项是完整的
（`Authenticated Users: Modify`、`Users: ReadAndExecute`），没有显式 Deny；
仓库根只有 `Everyone: DeleteSubdirectoriesAndFiles` 的 Deny（AGENTS.md 说这是预期项）。

**结论**：不是 NTFS 权限问题，是 DSH 沙箱对该子树的写入授予失效。属于环境问题，
与 dsh-pixel 退役无关；处置方式见 README §8。
