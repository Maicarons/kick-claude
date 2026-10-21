# kick-claude

**把 Claude Code 的协作文件从 git 仓库里彻底清除 —— 工作区 *和* 完整历史 —— 且不误伤任何其他内容。**

[English](./README.md)

Claude Code 会在仓库里散落文件和元数据：`CLAUDE.md`、`.claude/`、`.mcp.json`、`.claude.json`，以及提交信息里的 trailer。想让这些东西彻底消失 —— 从目录树、从每一个历史提交、从你的 fork —— 删文件是不够的。这个工具一次搞定，并在事后证明"其他东西一个字节都没变"。

- **无损** —— 每一个提交、分支、标签、合并、作者、时间戳、文件权限位，以及所有非 Claude 的 blob 都逐字节保留。测试套件正是在断言这件事。
- **快** —— 单趟流式 `git fast-export │ filter │ git fast-import`。仓库不会被重新 clone，也不会重新 checkout；blob 数据根本不进入流，因此从不需要重写 blob。
- **原生** —— 不需要 Python、Java，也不需要安装 `git-filter-repo`。只依赖 `git`。产物是一个 ESM bundle，在 Node.js ≥ 18.17 和 Bun 上都能跑。
- **可验证** —— 改写前先生成 bundle 备份；改写后对每个 ref 做指纹快照并逐一比对。只要有一个非 Claude 的 blob 变了，工具就明确报错。

---

## 安装

```bash
npm install -g kick-claude        # 或：bun add -g kick-claude
kick-claude --version
```

不安装直接用：

```bash
npx kick-claude scan
```

> **说明：** 发布靠推送 `v*` tag 触发，npm 包也是那时才发布。在本工作流落地后的
> 第一个 tag 之前，npm 上的最新版本可能落后于仓库 —— 若 CLI 缺少你期望的东西，
> 请看[发布页](https://github.com/Maicarons/kick-claude/releases)。

## 快速开始

```bash
# 1. 先看有什么，全程不修改任何东西
kick-claude scan

# 2. 可选：检查是否把 key 泄漏进了 .mcp.json
kick-claude scan --secrets

# 3a. 只关心当前这一份检出？
kick-claude clean --stage

# 3b. 让它们从每一个提交里都消失（先读"改写历史之前"）
kick-claude purge
```

## 检测范围

| 规则 id            | 匹配内容                                                    | 默认 |
| ------------------ | ----------------------------------------------------------- | ---- |
| `claude-dir`       | 任意层级的 `.claude/`（`settings.json`、`rules/`、`commands/`、`agents/`、`skills/`、hooks、plugins） | 开 |
| `claude-md`        | 任意层级的 `CLAUDE.md` / `claude.md`                          | 开 |
| `claude-local-md`  | `CLAUDE.local.md`                                            | 开 |
| `claude-home-json` | `.claude.json`                                               | 开 |
| `mcp-json`         | `.mcp.json`                                                  | 开 |
| `claude-md-dir`    | `docs/ai-guide.md`、`.ai/` 等 —— 需要显式开启                 | 关 |

`kick-claude rules` 会打印完整规则集及其正则表达式。

提交信息会清理掉：

- `Co-Authored-By: Claude <noreply@anthropic.com>`（以及其他 Claude trailer）
- `🤖 Generated with [Claude Code](https://claude.ai/code)` 页脚

`.gitignore` 也会被检查 —— Claude Code 可能自动写入的托管区块同样会作为发现项报出。

## 命令

### `scan`

只读。报告工作区、**全部历史**（所有 ref）、提交信息、`.gitignore` 中的产物，以及可选的凭据。

```bash
kick-claude scan
kick-claude scan --json                 # 机器可读
kick-claude scan --worktree             # 跳过历史探测（更快）
kick-claude scan --secrets              # 查找 sk-ant-…、api key、token
kick-claude scan --reflog               # 连仅存在于 reflog 的对象一起查
kick-claude scan --path 'docs/ai-guide.md' --path 'glob:**/*.prompt'
kick-claude scan --include claude-dir --exclude mcp-json
```

有发现时退出码为 `1`（便于接入 CI），干净时为 `0`。

### `clean`

删除工作区中的产物，`--stage` 会把删除暂存进索引（`git rm --cached`），并向 `.gitignore` 写入托管区块。历史不动。

```bash
kick-claude clean --dry-run
kick-claude clean --stage
kick-claude clean --no-gitignore
```

### `init`

只（重）写 `.gitignore` 的托管区块，幂等。

### `purge`

改写全部历史，让这些文件从未存在过。

```bash
kick-claude purge --dry-run     # 只打印计划，不做任何修改
kick-claude purge               # 交互式确认
kick-claude purge -y            # 无交互
```

**默认只改写提交信息** —— `Co-Authored-By: Claude` trailer 和
`Generated with Claude Code` 页脚被清掉，而 `CLAUDE.md`、`.claude/` 等文件
原封不动地留在原地，逐字节不变。这是常见需求："别再把功劳算给 Claude"，
但一个文件都不想动。

想让文件本身也从每个提交里消失，加上 `--files`：

```bash
kick-claude purge --files -y
```

| 选项            | 作用                                              |
| --------------- | ------------------------------------------------- |
| `--files`       | 同时把产物文件从每个提交里删除（**默认关闭**）    |
| `--scrub-mentions` | 配合 `--files`，额外删除提到被删文件的提交信息行 |
| `--engine <e>`  | `auto`（默认）\| `native` \| `filter-repo`        |
| `--no-prune`    | 保留那些"过滤后变空"的提交                          |
| `--no-remap`    | 不重写提交信息里引用的旧 commit hash               |
| `--no-backup`   | 跳过改写前的 bundle 备份                            |
| `--keep-old`    | 不清 reflog / 不 gc（旧对象仍可通过 reflog 找回）  |
| `--dry-run`     | 只出计划                                            |
| `-y, --yes`     | 不询问                                             |
| `--force`       | 工作区脏也照改                                      |

`--files` 相对 `kick-claude <= 1.0` 是破坏性变更（旧版总是删文件）。
`git filter-repo` 无法改写提交信息，所以 `--engine filter-repo` 必须配合 `--files`。

## purge 的工作原理

```
git fast-export --no-data --all  ──▶  字节过滤器  ──▶  git fast-import
        (marks 与增量)             （本工具）        （新历史）
```

1. **快照** —— `fingerprintRefs` 为每个 ref 记录排序后的非产物 `(路径, blob-sha)` 列表及其 SHA-256 摘要。
2. **备份** —— `git bundle create` 把所有 ref 打包到 `.git/kick-claude/<时间戳>/`。
3. **第一趟** —— 流在解析中被就地改写。命中的路径从文件命令里剔除，提交信息被清理，空提交（及其衍生 merge）在过滤器内部就被剪掉，于是 `fast-import` 根本不会知道它们的存在。父提交 mark 会被传递地解析，因此 merge 能保留第二个父提交。由于被剪掉的提交从未送达 importer，它们是"真删"而非"变空" —— 这正是 `filter-branch` 众所周知做错的地方。
4. **第二趟（按需）** —— 如果提交信息里引用了旧 commit hash，且未指定 `--no-remap`，就再流式扫描一次（此时只剩提交信息，体量很小）来重写这些引用。
5. **重打包** —— 清空 reflog 并执行 `git gc --prune=now`，确保旧对象真的消失。
6. **校验** —— `git fsck`，然后重新为每个 ref 计算指纹并比对；同时重新扫描残留产物。任何一个非 Claude blob 出现差异都会中止并报错。

只有从第一个受影响提交开始及其之后的提交会拿到新 hash；更早的提交 id 保持不变，这让 rebase / cherry-pick 的成本尽可能低。

## 改写历史之前

改写历史会让"从第一个被删除的文件所在提交开始"的每一个提交 id 都改变。

```bash
kick-claude purge -y
git push --force --branches --tags --prune origin
git reflog expire --expire=now --all && git gc --prune=now --aggressive   # 远端/各 fork 上也要做
```

所有持有 clone 的协作者必须**删除并重新 clone**。普通 `git pull` 会把旧历史复活。如果 `.mcp.json` 里曾放过真实的 key，请视其已泄漏并立即轮换 —— `kick-claude scan --secrets` 会告诉你是否曾经存在过。

如果你只是想阻止今后再产生这些文件，用 `clean` 或 `init` 就够了。

## 在 GitHub Actions 中使用

本仓库自带一个官方 Action，工作流可以直接调用：

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0            # 必须：浅克隆会隐藏历史

- id: kick-claude
  uses: Maicarons/kick-claude@v1
  with:
    command: purge
    files: true
    push: true
```

`fetch-depth: 0` 很重要。浅克隆里没有工具改写所需的历史，基于它 force push 会把
其余历史全部删掉。Action 会检测浅克隆并自动补全（`ensure-full-history`，默认开启），
但一开始就把完整历史取下来更省事。

也可以直接用可复用工作流，它已经帮你做好了 checkout：

```yaml
jobs:
  scrub:
    uses: Maicarons/kick-claude/.github/workflows/kick-claude.yml@v1
    with:
      command: purge
      files: true
      push: true
    secrets: inherit
```

### Action 在 CLI 之上额外做的事

- **Job Summary**：输出发现项表格，以及 `::warning::` 标注。
- **真正的安全护栏**：拒绝在 `pull_request` 事件下 force push；拒绝在脏工作区下
  purge；拒绝在非 purge 命令下使用 `push`；push 失败时明确告诉你缺哪个权限。
- **快速路径**：浅克隆检测、push 前完整 fetch，以及 `git fsck` 与 blob 校验照常执行。

### 输入

| input | 默认值 | 说明 |
| ----- | ------ | ---- |
| `command` | `scan` | `scan` / `clean` / `init` / `purge` |
| `path` | `.` | 仓库路径，相对工作区 |
| `fail-on-findings` | `true` | scan 发现问题时让步骤失败 |
| `secrets` | `false` | 同时检测凭据 |
| `extra-paths` | – | 换行或逗号分隔的额外规则 |
| `include-rules` / `exclude-rules` | – | 规则 id |
| `dry-run` | `false` | 只出计划 |
| `files` | `false` | 同时删除产物文件（默认只改提交信息） |
| `scrub-mentions` | `false` | 配合 `files`，删除提到被删文件的提交信息行 |
| `purge` 相关 | | `prune-empty`、`remap-hashes`、`include-reflog`、`engine` |
| `push` | `false` | force push 改写后的历史 |
| `push-remote` / `push-refspec` | `origin` / `--force --prune refs/heads/*:refs/heads/* refs/tags/*:refs/tags/*` | |
| `ensure-full-history` | `true` | 先补全浅克隆 |
| `gc` | `false` | 清 reflog 并重新打包（临时 runner 上没意义） |
| `token` | – | 默认复用 `actions/checkout` 持久化的凭据 |
| `summary` | `true` | 写 job summary |

输出：`found`、`paths`、`result`、`commits-seen`、`commits-pruned`、
`files-removed`、`messages-rewritten`、`verification-ok`、`backup-bundle`、`pushed`。

force push 改写后的历史需要在工作流上声明 `permissions: contents: write`，且远端允许
force push。Action 绝不会在 `pull_request` 下 push，因此 fork 无法改写你的主分支。

### 发布到 Marketplace

Marketplace 只需要仓库根目录的 `action.yml`。上架步骤：在 GitHub 上打开
`action.yml` 文件页面 → **Draft a release** → 勾选
**Publish this Action to the GitHub Marketplace** → 选择主分类 → 发布。
接受 Marketplace Developer Agreement 与两步验证是只有仓库所有者才能完成的
手动步骤。

只要 `v1` 标签存在，`uses: Maicarons/kick-claude@v1` 就能用，无需先上架 Marketplace。

## 作为库使用

```ts
import { scan, purge, resolveRules, makePathMatcher, cleanWorktree } from "kick-claude";

const report = await scan(process.cwd(), { secrets: true });
console.log(report.counts, report.paths);

const matchPath = makePathMatcher(resolveRules());
const result = await purge(process.cwd(), {
  matchPath,
  filterMessage: (m) => m.replace(/🤖.*/g, ""),
  pruneEmpty: true,
  remapHashes: true,
});
console.log(result.stats, result.verification);
```

也可用 `--engine filter-repo` 调用 `git filter-repo` 作为交叉验证通道；它永远不会被自动使用。

## 注意事项与坑

- **绝不要在需要增量输出时给 `git fast-export` 传 `--quiet`。** 在 git 2.45 上，它会静默丢弃所有非根提交的文件变更，从而悄悄损坏改写结果。`kick-claude` 不使用它，进度信息改走 stderr。
- reflog 中以及不可达的对象，只有传 `--reflog` 才会被改写，因为 `fast-export` 无法枚举它们。但改写后 reflog 会被清空并重新打包，所以 `--reflog` 只在**改写之前**有意义。
- 支持裸仓库（bare）与 detached HEAD。
- purge 过程中 `kick-claude` 不会修改 `.git/config`、remote、hooks 或暂存区（结束时用 `git reset --hard` 刷新索引）。

## 开发

```bash
bun install
bun test          # 单元测试 + 针对真实临时仓库的端到端 purge
                  # （`bun run test` 额外带 30s 单测超时：e2e fixture 要建一个
                  #   真实仓库、发起约 31 次 git 调用，慢机器上会超过 Bun 默认的 5s）
bun run test:action   # 用模拟的 runner 环境变量驱动 action/index.cjs
bun run typecheck
bun run build     # dist/ bundle、.d.ts 以及提交进仓库的 action/cli.js 副本
```

端到端测试会构造一个包含 merge、tag 以及"会变空的提交"的仓库，对其执行 purge，然后断言其余每个 blob、分支、tag 与 merge 都未被改动，且 `git fsck` 干净。

Action 测试用真实的 `INPUT_*` 与 `GITHUB_*` 环境变量驱动真实入口，并覆盖到"向真实
bare 远端 force push 后重新 clone 再扫描"这一段。

### 为什么 `action/cli.js` 要提交进仓库

`uses: Maicarons/kick-claude@v1` 下载的是仓库里**已提交**的内容，所以 bundle 必须
存在于 git 中：有了它，Action 在 runner 上既不需要 npm 也不需要构建步骤，也不会因为
registry 不可达而失败。

代价是这份提交副本可能与它当初所基于的源码漂移，因此 `scripts/build.ts` 会给它盖上
一个 `src/` 下所有文件的散列戳（`// kick-claude-source-hash: <16 位十六进制>`），
由 `scripts/check-action-bundle.ts` 校验。有两点让这个检查真正有效而非装饰：

- 它从 **git 里**读 bundle（`git show HEAD:action/cli.js`），而不是读磁盘文件。真正
  发布出去的是提交副本；而 CI 自己也会跑 `bun run build`，构建会覆写 `action/cli.js`
  —— 只比对工作区文件的话，等于永远在拿 bundle 跟它自己比；
- 散列前会把换行统一成 LF。否则这个戳会依赖检出环境：`core.autocrlf` 会让这些文件在
  Windows 工作区变成 CRLF，在那里构建就会盖上一个 Linux runner 无法复现的戳 —— 而这
  正是这个戳本该抓到的漂移。

CI 在 `bun run build` 的前后各跑一次该检查，`action/cli.js` 在 `.gitattributes` 里
被标记为 `-text`，git 不会改写它。改动 `src/` 下任何内容后，请执行
`bun run build && git add action/cli.js`，并把 bundle 放在同一个改动里提交，否则 CI
会失败。

### 发布

发布是手工的：**tag 就是发布**，`package.json` 跟在它后面。没有 release-please
或 changesets 之类的机器人替你决定版本号 —— 版本号是一种判断：purge 默认行为的
breaking change 就是 `2.0.0`，不该由工具挑一个数字。

1. 把改动写进 `CHANGELOG.md` 的 `[Unreleased]`，然后把该节改名为要发布的版本号。
2. 把 `package.json#version` 设为同一个版本号（不带 `v`）。
3. 两者一起提交，然后给这个提交打 tag：`git tag v1.2.3 && git push origin v1.2.3`。

推送 tag 会触发 `release.yml`，它会：

- 若 `package.json#version` 与 tag 不一致就失败 —— 版本对不上的 tag 不会发布任何东西；
- 在 tag 上重跑 typecheck、测试与构建，且不依赖 `ci.yml`，因此发布从不寄望于另一个
  工作流碰巧跑过；
- 检查已提交的 `action/cli.js` 与源码是否一致，在重新构建**前后各一次** —— 确保 tag
  发出的 bundle 就是源码能产出的那个；
- 带 **provenance** 发布到 npm（`id-token: write` + `npm publish --provenance`），
  使 tarball 可追溯到构建它的那次工作流运行；
- 创建 GitHub Release，说明取自 `CHANGELOG.md` 中该版本那一节，而非提交日志。

npm 凭据是仓库 secret（`NPM_TOKEN`），永远不会以字面量出现在工作流里。发布是最后
一步，所有门禁都在它之前，因为 npm 的版本号一旦用过就不能再用。

## 许可证

Apache-2.0，详见 [LICENSE](./LICENSE)。