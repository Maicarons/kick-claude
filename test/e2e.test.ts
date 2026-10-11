/**
 * End-to-end test: build a real repository with Claude Code artifacts spread
 * across history (including merges, tags and commits that become empty), purge
 * it with the native engine, and assert nothing else changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repoInfo, type RepoInfo } from "../src/git.ts";
import { scan } from "../src/detect.ts";
import { compileRule, DEFAULT_RULES } from "../src/rules.ts";
import { nativePurge } from "../src/purge/native.ts";
import { fingerprintRefs } from "../src/purge/verify.ts";
import { planPurge, purge } from "../src/purge/index.ts";

let dir: string;
let info: RepoInfo;

const g = (args: string[]) => git(args, dir);
async function gx(args: string[]) {
  const r = await g(args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
async function write(rel: string, content: string) {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}
async function commit(msg: string) {
  await gx(["add", "-A"]);
  await gx(["commit", "-q", "-m", msg]);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kick-claude-e2e-"));
  await gx(["init", "-q", "-b", "main"]);
  await gx(["config", "user.email", "test@example.com"]);
  await gx(["config", "user.name", "Test User"]);
  await gx(["config", "commit.gpgsign", "false"]);

  await write("src/a.txt", "A\n");
  await commit("feat: add a");

  // nothing but Claude artifacts - should be pruned entirely
  await write("CLAUDE.md", "# Project rules\n\nUse bun.\n");
  await write(".claude/settings.json", '{"model":"claude-sonnet-5"}\n');
  await write(".claude/agents/reviewer.md", "---\nname: reviewer\n---\n");
  await commit("chore: add claude config");

  await write("src/b.txt", "B\n");
  await commit(
    "feat: add b\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\nGenerated with [Claude Code](https://claude.ai/code)\n",
  );

  await gx(["checkout", "-q", "-b", "feature"]);
  await write("src/feature.txt", "F\n");
  await commit("feat: feature work");
  await gx(["checkout", "-q", "main"]);
  await gx(["merge", "-q", "--no-ff", "-m", "merge: feature", "feature"]);

  // A commit message that references an *earlier, rewritten* commit by hash,
  // so the hash-remapping second pass has something real to fix. (The root
  // commit is deliberately not used: it predates every artifact and therefore
  // keeps its id.)
  const rewrittenSha = (await gx(["rev-parse", "HEAD"])).trim();
  await write("src/c.txt", "C\n");
  await commit(`feat: add c\n\nFollow-up to ${rewrittenSha.slice(0, 8)}.\n`);

  await write(".mcp.json", '{"mcpServers":{"demo":{"command":"npx"}}}\n');
  await commit("chore: add mcp server");
  await write(
    ".mcp.json",
    '{"mcpServers":{"demo":{"command":"npx","env":{"TOKEN":"sk-ant-secret-value-here"}}}}\n',
  );
  await commit("chore: tweak mcp server");

  await write("packages/api/CLAUDE.md", "# api\n");
  await write("packages/api/src/api.txt", "API\n");
  await commit("feat: add api package");

  await gx(["tag", "v1.0.0"]);
  await write("docs/readme.md", "docs\n");
  await commit("docs: readme");

  // A branch whose entire history consists of artifacts. `fast-import` never
  // creates or updates refs it is not told about, so without an explicit reset
  // this branch would keep pointing at the old, artifact-carrying commits.
  await gx(["checkout", "-q", "-b", "scratch"]);
  await write("scratch/CLAUDE.md", "# scratch\n");
  await commit("chore: scratch claude notes");
  await gx(["checkout", "-q", "main"]);

  info = await repoInfo(dir);
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("scope default", () => {
  test(
    "messages-only purge keeps every file and only rewrites trailers",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "kick-claude-scope-"));
      const g = (args: string[]) => git(args, dir);
      const gx = async (args: string[]) => {
        const r = await g(args);
        if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
        return r.stdout;
      };
      const write = async (rel: string, body: string) => {
        await mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), body, "utf8");
      };

      await gx(["init", "-q", "-b", "main"]);
      await gx(["config", "user.email", "t@e.c"]);
      await gx(["config", "user.name", "T"]);
      await gx(["config", "commit.gpgsign", "false"]);
      await write("README.md", "r\n");
      await gx(["add", "-A"]);
      await gx(["commit", "-q", "-m", "feat: add readme"]);
      await write("CLAUDE.md", "# claude\n");
      await write("src/a.txt", "A\n");
      await gx(["add", "-A"]);
      await gx([
        "commit",
        "-q",
        "-m",
        "feat: add a\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
      ]);

      const claudeBlob = (await gx(["rev-parse", "HEAD:CLAUDE.md"])).trim();
      const info = await repoInfo(dir);
      const opts = {
        engine: "native" as const,
        pruneEmpty: true,
        remapHashes: true,
        backup: false,
        assumeYes: true,
        force: false,
        keepOldObjects: false,
        removeFiles: false,
        scan: {},
        log: () => {},
      };

      const plan = await planPurge(info, opts, false);
      expect(plan.removeFiles).toBe(false);
      expect(plan.hasWork).toBe(true);
      // Files are kept, so nothing may be reported as "removed".
      expect(plan.historyOccurrences).toBe(0);
      expect(plan.messageCount).toBe(1);

      const result = await purge(info, plan, opts);
      expect(result.native?.stats.removedFileChanges).toBe(0);
      expect(result.native?.stats.rewrittenMessages).toBe(1);
      // CLAUDE.md survives byte for byte.
      expect((await gx(["rev-parse", "HEAD:CLAUDE.md"])).trim()).toBe(claudeBlob);
      expect(await gx(["log", "--format=%B", "-1"])).not.toContain("Claude");
      expect((await gx(["rev-list", "--count", "HEAD"])).trim()).toBe("2");

      await rm(dir, { recursive: true, force: true });
    },
    60_000,
  );
});

describe("scan", () => {
  test("finds artifacts in the working tree and in history", async () => {
    const report = await scan(info);
    expect(report.counts.worktree).toBeGreaterThan(0);
    expect(report.counts.history).toBeGreaterThan(0);
    expect(report.counts.message).toBeGreaterThan(0);
    expect(report.paths).toContain("CLAUDE.md");
    expect(report.paths).toContain(".claude/settings.json");
    expect(report.paths).toContain("packages/api/CLAUDE.md");
    expect(report.paths).toContain(".mcp.json");
  });

  test("reports credentials when asked", async () => {
    const report = await scan(info, { secrets: true });
    expect(report.counts.secret).toBeGreaterThan(0);
    expect(report.hasSecrets).toBe(true);
  });

  // The history walk marks each commit with a bare NUL (`--pretty=format:%x00`).
  // Treating that sentinel as a path made us pass a NUL to `git log -- <path>`,
  // where Node refuses it: "must be a string without null bytes", exit 2.
  test("a rule broad enough to match the history sentinel does not crash", async () => {
    for (const spec of ["regex:.", "regex:^"]) {
      const report = await scan(info, { extraSpecs: [spec] });
      expect(report.paths.some((p) => p.includes("\0"))).toBe(false);
      expect(report.findings.some((f) => f.path?.includes("\0"))).toBe(false);
    }
  });
});

describe("native purge", () => {
  const matchers = DEFAULT_RULES.map(compileRule);
  const isArtifact = (p: string) => matchers.some((m) => m.test(p));

  let before: Awaited<ReturnType<typeof fingerprintRefs>>;
  let beforeFiles: Record<string, string>;
  let beforeCommits: number;

  test("captures the pre-rewrite state", async () => {
    before = await fingerprintRefs(info, isArtifact);
    beforeCommits = Number((await gx(["rev-list", "--all", "--count"])).trim());
    beforeFiles = await treeOf(["main", "feature", "v1.0.0"]);
    expect(Object.keys(beforeFiles).sort()).toEqual([
      "feature:.claude/agents/reviewer.md",
      "feature:.claude/settings.json",
      "feature:CLAUDE.md",
      "feature:src/a.txt",
      "feature:src/b.txt",
      "feature:src/feature.txt",
      "main:.claude/agents/reviewer.md",
      "main:.claude/settings.json",
      "main:.mcp.json",
      "main:CLAUDE.md",
      "main:docs/readme.md",
      "main:packages/api/CLAUDE.md",
      "main:packages/api/src/api.txt",
      "main:src/a.txt",
      "main:src/b.txt",
      "main:src/c.txt",
      "main:src/feature.txt",
      "v1.0.0:.claude/agents/reviewer.md",
      "v1.0.0:.claude/settings.json",
      "v1.0.0:.mcp.json",
      "v1.0.0:CLAUDE.md",
      "v1.0.0:packages/api/CLAUDE.md",
      "v1.0.0:packages/api/src/api.txt",
      "v1.0.0:src/a.txt",
      "v1.0.0:src/b.txt",
      "v1.0.0:src/c.txt",
      "v1.0.0:src/feature.txt",
    ]);
  });

  test(
    "rewrites history",
    async () => {
      const result = await nativePurge(info, {
        matchPath: isArtifact,
        pruneEmpty: true,
        remapHashes: true,
        workDir: join(dir, ".git", "kick-claude-test"),
      });
      expect(result.stats.commits).toBeGreaterThan(0);
      expect(result.stats.prunedCommits).toBeGreaterThanOrEqual(3);
      expect(result.stats.rewrittenMessages).toBeGreaterThanOrEqual(1);
      // the hash reference in "feat: add c" forces the second, message-only pass
      expect(result.passes).toBe(2);
      expect(result.remappedMessages).toBeGreaterThanOrEqual(1);
      await g(["reset", "--hard", "--quiet"]);
    },
    60_000,
  );

  test("no artifact path survives anywhere", async () => {
    const report = await scan(info);
    expect(report.paths).toEqual([]);
    expect(report.counts.message).toBe(0);
  });

  test("branches whose tip was pruned are repointed to a surviving commit", async () => {
    const scratch = await git(["rev-parse", "--verify", "--quiet", "refs/heads/scratch"], dir);
    const main = await git(["rev-parse", "refs/heads/main"], dir);
    // The scratch branch only ever added a CLAUDE.md, so after the rewrite it
    // must sit on a commit that still exists - never on the deleted one.
    expect(scratch.code).toBe(0);
    expect(scratch.stdout.trim()).toBe(main.stdout.trim());
    const tree = await git(["ls-tree", "-r", "--name-only", "scratch"], dir);
    expect(tree.stdout).not.toContain("CLAUDE.md");
  });

  test("commit messages no longer carry Claude markers", async () => {
    const log = await gx(["log", "--all", "--format=%B%x00"]);
    expect(log).not.toContain("Co-Authored-By: Claude");
    expect(log).not.toContain("Generated with [Claude Code]");
  });

  test("every other blob is byte-identical", async () => {
    const after = await treeOf(["main", "feature", "v1.0.0"]);
    const cleanBefore: Record<string, string> = {};
    for (const [k, v] of Object.entries(beforeFiles)) {
      if (isArtifact(k.split(":")[1]!)) continue;
      cleanBefore[k] = v;
    }
    expect(after).toEqual(cleanBefore);
  });

  test("non-artifact tree fingerprints are unchanged on every ref", async () => {
    const after = await fingerprintRefs(info, isArtifact);
    for (const [ref, fp] of before.refs) {
      const now = after.refs.get(ref);
      expect(now, `ref ${ref} disappeared`).toBeDefined();
      expect(now!.digest, `ref ${ref} changed`).toBe(fp.digest);
    }
  });

  test("topology, branches and tags survive", async () => {
    const commits = Number((await gx(["rev-list", "--all", "--count"])).trim());
    expect(commits).toBeLessThanOrEqual(beforeCommits);
    expect(commits).toBeGreaterThan(0);
    const refs = (await gx(["for-each-ref", "--format=%(refname)"])).split(/\r?\n/);
    expect(refs).toContain("refs/heads/main");
    expect(refs).toContain("refs/heads/feature");
    expect(refs).toContain("refs/heads/scratch");
    expect(refs).toContain("refs/tags/v1.0.0");
    expect((await gx(["rev-list", "--merges", "--count", "main"])).trim()).toBe("1");
  });

  test("the working tree matches the rewritten HEAD", async () => {
    expect((await g(["status", "--porcelain"])).stdout.trim()).toBe("");
    expect(await readFile(join(dir, "src/a.txt"), "utf8")).toBe("A\n");
  });

  test(
    "git fsck is clean",
    async () => {
      const r = await g(["fsck", "--no-progress", "--no-dangling"]);
      expect(r.code).toBe(0);
    },
    30_000,
  );
});

async function treeOf(refs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ref of refs) {
    const r = await git(["ls-tree", "-r", ref], dir);
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const meta = line.slice(0, tab).split(/\s+/);
      out[`${ref}:${line.slice(tab + 1)}`] = meta[2]!;
    }
  }
  return out;
}