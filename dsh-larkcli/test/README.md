# test/

本目录两类东西，**别混**。

## 1. 长期保留的测试源码（入库）

| 文件 | 覆盖什么 | 跑法（不启 DSH） |
|---|---|---|
| `run.mjs` | 38 项：纯函数、数据层、失败态、真实 CLI 版本 | `& $node test/run.mjs` |
| `tools.mjs` | 27 项：真实 CLI + 真实凭据，逐个执行 9 个工具 | `& $node test/tools.mjs` |
| `client.mjs` | 浏览器半形态、`ctx.locale.bind`、slot 注册、初始态渲染 | `& $node test/client.mjs` |
| `smoke.mjs` | 宿主半结构、9 个工具齐全、每个工具字段完整 | `& $node test/smoke.mjs` |
| `e2e.mjs` | 端到端：迁移旧凭据 → status / +chat-list / schema 缓存 | `& $node test/e2e.mjs` |

`$node` = `$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（PATH 里没有 node）。

**这些文件会进 git。** 根 `.gitignore` 的 `test/*` 带斜杠，只锚定**仓库根**的 `test/`，
管不到本目录（实测 `git check-ignore -v dsh-larkcli/test/run.mjs` 返回 exit 1）。
与 `dsh-pixel/test/` 同待遇，不需要 `git add -f`。

## 2. 临时产物（用完即删，绝不入库）

探针脚本（`_probe*.mjs`）、dump、下载回来的 zip、日志、二维码图片、临时 configDir。

**纪律**：跑完立刻删。提交前确认目录里只剩上面那 5 个 `.mjs` + 本 README。

> 反向验证过：曾因只测成功态，漏掉「首帧 undefined 导致永久空白」的致命 bug。
> 所以这里刻意覆盖**初始态**（无二进制/无账户/无 secret）与**失败态**（坏命令、坏 id、超时、缓存污染）。
