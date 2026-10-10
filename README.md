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

| Option              | Effect                                                        |
| ------------------- | ------------------------------------------------------------- |
| `--engine <e>`      | `auto` (default) \| `native` \| `filter-repo`                  |
| `--no-prune`        | keep commits that become empty after filtering                 |
| `--no-remap`        | do not rewrite old commit hashes mentioned in messages         |
| `--no-backup`       | skip the pre-rewrite bundle                                    |
| `--keep-old`        | do not expire reflogs / gc (keeps old objects reachable)       |
| `--dry-run`         | plan only                                                      |
| `-y, --yes`         | no prompt                                                      |
| `--force`           | rewrite even with a dirty working tree                         |

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
bun run typecheck
bun run build     # dist/ bundle + .d.ts
```

The end-to-end test builds a repository with artifacts across merges, tags and
commits that become empty, purges it, and asserts that every other blob, branch,
tag and merge is untouched and that `git fsck` is clean.

## License

Apache-2.0 — see [LICENSE](./LICENSE).