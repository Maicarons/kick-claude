# kick-claude

**Remove Claude Code collaboration files from a git repository — working tree *and* complete history — without touching anything else.**

[中文文档](./README_zh.md)

Claude Code scatters files and metadata through a repository: `CLAUDE.md`,
`.claude/`, `.mcp.json`, `.claude.json`, plus trailers in commit messages. If you
ever want those gone — from the tree, from every historical commit, and from your
forks — deleting the files is not enough. This tool does the whole job in one
pass and then proves that nothing else changed.

- **Lossless** — every commit, branch, tag, merge, author, timestamp, mode bit and
  non-Claude blob is preserved byte-for-byte. The test suite asserts exactly that.
- **Fast** — one streaming `git fast-export │ filter │ git fast-import` pass.
  The repository is never cloned or re-checked-out; blob contents are never
  rewritten because blobs are never in the stream.
- **Native** — no Python, no Java, no `git-filter-repo` install. Only `git` is
  required. Ships a single ESM bundle that runs on Node.js ≥ 18.17 and on Bun.
- **Verified** — a bundle backup is created first, and after the rewrite every
  ref is fingerprinted and compared against a pre-rewrite snapshot. If a single
  non-Claude blob changed, the tool fails loudly.

---

## Install

```bash
npm install -g kick-claude        # or: bun add -g kick-claude
kick-claude --version
```

Without installing:

```bash
npx kick-claude scan
```

## Quick start

```bash
# 1. See what is there — nothing is modified
kick-claude scan

# 2. Optional: drop a key that leaked into .mcp.json
kick-claude scan --secrets

# 3a. Only care about the current checkout?
kick-claude clean --stage

# 3b. Make them disappear from every commit (see "Before you purge")
kick-claude purge
```

## What gets detected

| Rule id          | Matches                                                  | Default |
| ---------------- | -------------------------------------------------------- | ------- |
| `claude-dir`     | `.claude/` at **any** depth (`settings.json`, `rules/`, `commands/`, `agents/`, `skills/`, hooks, plugins) | on |
| `claude-md`      | `CLAUDE.md` / `claude.md` at any depth                    | on |
| `claude-local-md`| `CLAUDE.local.md`                                         | on |
| `claude-home-json`| `.claude.json`                                            | on |
| `mcp-json`       | `.mcp.json`                                               | on |
| `claude-md-dir`  | `docs/ai-guide.md`, `.ai/` — opt-in, off by default        | off |

`kick-claude rules` prints the full set with its regular expressions.

Commit messages are scrubbed of:

- `Co-Authored-By: Claude <noreply@anthropic.com>` (and other Claude trailers)
- `🤖 Generated with [Claude Code](https://claude.ai/code)` footers

`.gitignore` is inspected too — the managed block that Claude Code may have
written for you is reported as a finding too.

## Commands

### `scan`

Read-only. Reports artifacts in the working tree, in **all** history (every ref),
in commit messages, in `.gitignore`, and optionally credentials.

```bash
kick-claude scan
kick-claude scan --json                 # machine readable
kick-claude scan --worktree             # skip history probes (fast)
kick-claude scan --secrets              # look for sk-ant-…, api keys, tokens
kick-claude scan --reflog               # also inspect reflog-only objects
kick-claude scan --path 'docs/ai-guide.md' --path 'glob:**/*.prompt'
kick-claude scan --include claude-dir --exclude mcp-json
```

Exit code `1` when something was found (so it works in CI), `0` when clean.

### `clean`

Removes the artifacts from the working tree, stages the deletions
(`--stage`), and writes a managed block into `.gitignore`. History is untouched.

```bash
kick-claude clean --dry-run
kick-claude clean --stage
kick-claude clean --no-gitignore
```

### `init`

Only (re)writes the managed `.gitignore` block. Idempotent.

### `purge`

Rewrites all history so the artifacts never existed.

```bash
kick-claude purge --dry-run     # show the plan, change nothing
kick-claude purge               # interactive confirmation
kick-claude purge -y            # unattended
```

**By default only the commit messages are rewritten** — the `Co-Authored-By: Claude`
trailer and the `Generated with Claude Code` footer go away, while `CLAUDE.md`,
`.claude/` and friends stay exactly where they are, byte for byte. That is the
common case: "stop crediting Claude" without touching a single file.

Pass `--files` when the files themselves should disappear from every commit too:

```bash
kick-claude purge --files -y
```

| Option              | Effect                                                        |
| ------------------- | ------------------------------------------------------------- |
| `--files`           | also delete the artifact files from every commit (**off** by default) |
| `--scrub-mentions`  | with `--files`, also delete message lines that name a removed file |
| `--engine <e>`      | `auto` (default) \| `native` \| `filter-repo`                  |
| `--no-prune`        | keep commits that become empty after filtering                 |
| `--no-remap`        | do not rewrite old commit hashes mentioned in messages         |
| `--no-backup`       | skip the pre-rewrite bundle                                    |
| `--keep-old`        | do not expire reflogs / gc (keeps old objects reachable)       |
| `--dry-run`         | plan only                                                      |
| `-y, --yes`         | no prompt                                                      |
| `--force`           | rewrite even with a dirty working tree                         |

`--files` is a breaking change from `kick-claude <= 1.0`, where the files were
always deleted. `git filter-repo` cannot scrub messages at all, so
`--engine filter-repo` requires `--files`.

## How the purge works

```
git fast-export --no-data --all  ──▶  byte filter  ──▶  git fast-import
        (marks & deltas)              (this tool)         (new history)
```

1. **Snapshot** — `fingerprintRefs` records, for every ref, the sorted list of
   non-artifact `(path, blob-sha)` pairs plus its SHA-256 digest.
2. **Backup** — `git bundle create` of all refs into `.git/kick-claude/<ts>/`.
3. **Pass 1** — the stream is parsed *in flight*. Matching paths are dropped from
   file commands, commit messages are scrubbed, empty commits (and their merges)
   are pruned inside the filter, so `fast-import` simply never learns about them.
   Parent marks are resolved transitively so merges keep their second parent.
   Because commits that are pruned never reach the importer, they are pruned for
   good — this is the part `filter-branch` famously gets wrong.
4. **Pass 2 (only if needed)** — if commit messages mention old commit hashes and
   `--no-remap` was not given, the (much smaller) history is streamed once more to
   rewrite those references.
5. **Repack** — reflogs expired, `git gc --prune=now` so the objects are really gone.
6. **Verify** — `git fsck`, then re-fingerprint every ref and compare. Artifacts
   are re-scanned. Any difference in a non-Claude blob aborts with a loud error.

Only commits from the first affected commit onwards get new hashes; anything older
keeps its id, which keeps rebase/cherry-pick workflows cheap.

## Before you purge

Rewriting history changes every commit id from the first removed file onwards.

```bash
kick-claude purge -y
git push --force --branches --tags --prune origin
git reflog expire --expire=now --all && git gc --prune=now --aggressive   # on the remote/forks too
```

Everyone with a clone must **delete and re-clone**. A normal `git pull` will
resurrect the old history. If `.mcp.json` contained a real key, treat it as
compromised and rotate it — `kick-claude scan --secrets` tells you whether one
was there.

If you only want to stop new artifacts from appearing, use `clean` or `init`.

## Use it in GitHub Actions

The repository ships a first-class action, so a workflow can call it directly:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0            # required: a shallow clone hides commits

- id: kick-claude
  uses: Maicarons/kick-claude@v1
  with:
            command: purge
            files: true
            push: true
```

`fetch-depth: 0` matters. A shallow clone does not contain the history the tool
needs to rewrite, and force pushing from one deletes the rest of the repository.
The action detects a shallow clone and deepens it (`ensure-full-history`,
default `true`), but fetching everything up front is cheaper.

Or use the reusable workflow, which does the checkout for you:

```yaml
jobs:
  scrub:
    uses: Maicarons/kick-claude/.github/workflows/kick-claude.yml@v1
    with:
      command: purge
      push: true
    secrets: inherit
```

### What the action adds on top of the CLI

- **Job summary** with the findings table, plus `::warning::` annotations.
- **Real safety rails.** It refuses to force push from a `pull_request` event,
  refuses to purge a dirty working tree, refuses `push` on non-purge commands,
  and tells you exactly which permission is missing when a push fails.
- **Unchanged-history fast path**: shallow-clone detection, a full fetch before
  pushing, and `git fsck`/blob verification still run.

### Inputs

| input | default | meaning |
| ----- | ------- | ------- |
| `command` | `scan` | `scan`, `clean`, `init`, `purge` |
| `path` | `.` | repository path, relative to the workspace |
| `fail-on-findings` | `true` | fail the step when a scan finds something |
| `secrets` | `false` | also look for credentials |
| `extra-paths` | – | newline/comma separated extra rules |
| `include-rules` / `exclude-rules` | – | rule ids |
| `dry-run` | `false` | only print the plan |
| `purge` | | `prune-empty`, `remap-hashes`, `include-reflog`, `engine` |
| `files` | `false` | also delete the artifact files (default: messages only) |
| `scrub-mentions` | `false` | with `files`, drop message lines naming a removed file |
| `push` | `false` | force push the rewritten history |
| `push-remote` / `push-refspec` | `origin` / `--force --prune refs/heads/*:refs/heads/* refs/tags/*:refs/tags/*` | |
| `ensure-full-history` | `true` | deepen a shallow clone first |
| `gc` | `false` | expire reflogs and repack (pointless on ephemeral runners) |
| `token` | – | defaults to the credentials `actions/checkout` persists |
| `summary` | `true` | write a job summary |

Outputs: `found`, `paths`, `result`, `commits-seen`, `commits-pruned`,
`files-removed`, `messages-rewritten`, `verification-ok`, `backup-bundle`,
`pushed`.

Force pushing rewritten history needs `permissions: contents: write` on the
workflow, and the remote must allow force pushes. The action never pushes from
`pull_request`, so a fork cannot rewrite your base branch.

### Publishing to the Marketplace

`action.yml` at the repository root is all the Marketplace needs. To list it:
open the `action.yml` file view on GitHub → **Draft a release** → tick
**Publish this Action to the GitHub Marketplace** → pick a primary category →
publish. Accepting the Marketplace Developer Agreement and the 2FA prompt are
manual steps that only the repository owner can perform.

`uses: Maicarons/kick-claude@v1` works as soon as the `v1` tag exists, without
the Marketplace listing.

## Programmatic API

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

`git filter-repo` is available as a cross-check engine (`--engine filter-repo`)
for the cases where a second opinion is welcome. It is never used automatically.

## Notes and gotchas

- **Never pass `--quiet` to `git fast-export` together with delta output.** On
  git 2.45 it silently drops file changes for every non-root commit, which
  quietly corrupts the rewrite. `kick-claude` does not use it; progress goes to
  stderr instead.
- Reflog-only and unreachable objects are only rewritten if you pass `--reflog`,
  because `fast-export` cannot enumerate them. After a rewrite the reflogs are
  expired and the repository is repacked, so `--reflog` is only useful *before*.
- Bare repositories and detached HEADs are handled.
- `kick-claude` never touches `.git/config`, remotes, hooks or the index staging
  area during a purge (the index is refreshed with `git reset --hard` at the end).

## Development

```bash
bun install
bun test          # unit tests + an end-to-end purge against real temp repos
bun run test:action   # drives action/index.cjs with fake runner env vars
bun run typecheck
bun run build     # dist/ bundle + .d.ts + the committed action/cli.js copy
```

The end-to-end test builds a repository with artifacts across merges, tags and
commits that become empty, purges it, and asserts that every other blob, branch,
tag and merge is untouched and that `git fsck` is clean.

The action harness runs the real entry point with real `INPUT_*` and `GITHUB_*`
environment variables against throwaway repositories — including a force push to
a real bare remote that is then re-cloned and re-scanned. `action/cli.js` is a
committed copy of the bundle so the action needs neither npm nor a build step on
the runner; CI rebuilds it and fails if it differs, so it cannot go stale.

## License

Apache-2.0 — see [LICENSE](./LICENSE).