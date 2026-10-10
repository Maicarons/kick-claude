/**
 * `kick-claude purge` orchestration:
 *
 *   pre-flight checks -> fingerprint -> backup -> rewrite -> cleanup -> verify
 */
import { commitCount, git, repoState, type RepoInfo } from "../git.ts";
import { scan, resolveRules, type ScanOptions } from "../detect.ts";
import type { CompiledRule } from "../rules.ts";
import { nativePurge, type NativePurgeResult } from "./native.ts";
import { defaultMessageFilter } from "./stream.ts";
import { runFilterRepo, rulesToPathSpecs } from "./filterRepo.ts";
import { createBackup, restoreHint, type Backup } from "./backup.ts";
import {
  fingerprintRefs,
  verifyRewrite,
  type VerifyReport,
  type FingerprintResult,
} from "./verify.ts";
import { dim } from "../ui.ts";

export type Engine = "auto" | "native" | "filter-repo";

export interface PurgeOptions {
  engine: Engine;
  pruneEmpty: boolean;
  remapHashes: boolean;
  /** Take a `git bundle` snapshot before touching anything. */
  backup: boolean;
  /** Skip the interactive confirmation (CI). */
  assumeYes: boolean;
  /** Proceed even when the repository is dirty. */
  force: boolean;
  /** Keep unreachable objects (no reflog expire / gc). */
  keepOldObjects: boolean;
  /**
   * Delete the artifact files from every commit. Off by default: the common
   * case is "stop crediting Claude", which only needs the commit messages
   * rewritten and leaves every file (and therefore every tree) untouched.
   */
  removeFiles: boolean;
  /**
   * Also delete commit message lines that mention a removed artifact, e.g. a
   * subject line saying "add CLAUDE.md". Off by default because it rewrites
   * prose; the leftovers are reported as a warning either way.
   */
  scrubMessageMentions?: boolean;
  /** Scan tuning, shared with `kick-claude scan`. */
  scan: ScanOptions;
  log(msg: string): void;
}

export interface PurgePlan {
  artifactPaths: string[];
  /** Number of distinct artifact paths that exist somewhere in history. */
  historyPathCount: number;
  /**
   * Number of (commit, path) pairs that will actually be rewritten. This is
   * usually larger than `historyPathCount`: one file touched by ten commits is
   * ten occurrences, not one.
   */
  historyOccurrences: number;
  /** Commit messages that still mention a path being removed, found by scan. */
  messageMentions: number;
  messageCount: number;
  commits: number;
  rules: CompiledRule[];
  engine: Engine;
  resolvedEngine: "native" | "filter-repo";
  /** Whether the artifact files themselves will be deleted from history. */
  removeFiles: boolean;
  hasWork: boolean;
}

export interface PurgeResult {
  plan: PurgePlan;
  backup: Backup | null;
  native: NativePurgeResult | null;
  filterRepoOutput: string | null;
  verify: VerifyReport;
  before: FingerprintResult;
  warnings: string[];
}

export async function planPurge(
  info: RepoInfo,
  opts: PurgeOptions,
  filterRepoAvailable: boolean,
): Promise<PurgePlan> {
  const rules = resolveRules(opts.scan);
  const report = await scan(info, opts.scan);
  const commits = await commitCount(info);
  const resolvedEngine: "native" | "filter-repo" =
    opts.engine === "filter-repo" && filterRepoAvailable ? "filter-repo" : "native";

  const historyPaths = report.paths;
  const [historyOccurrences, messageMentions] = await Promise.all([
    countHistoryOccurrences(info, historyPaths),
    countMessageMentions(info, opts, historyPaths),
  ]);

  const hasWork = opts.removeFiles
    ? report.findings.some((f) => f.scope !== "message")
    : report.findings.some((f) => f.scope === "message");

  return {
    artifactPaths: report.paths,
    historyPathCount: report.findings.filter((f) => f.scope === "history").length,
    historyOccurrences: opts.removeFiles ? historyOccurrences : 0,
    messageMentions,
    messageCount: report.findings.filter((f) => f.scope === "message").length,
    commits,
    rules,
    engine: opts.engine,
    resolvedEngine,
    removeFiles: opts.removeFiles,
    hasWork,
  };
}

/**
 * How many (commit, path) pairs will actually be rewritten. Counting distinct
 * paths understates this badly: a CLAUDE.md touched by twelve commits is
 * twelve occurrences, and that is the number users want to see before a
 * rewrite.
 */
async function countHistoryOccurrences(info: RepoInfo, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const r = await git(
    ["log", "--all", "--format=%x00", "--name-only", "--no-renames", ...paths],
    info.root,
  );
  if (r.code !== 0) return 0;
  let count = 0;
  // Records are NUL separated; the separator itself must not be counted as a
  // path, so split on NUL first and only then on newlines.
  for (const record of r.stdout.split("\0")) {
    for (const line of record.split("\n")) {
      if (line.trim()) count++;
    }
  }
  return count;
}

/** Commit messages that still reference a path this run is about to remove. */
async function countMessageMentions(
  info: RepoInfo,
  opts: PurgeOptions,
  paths: string[],
): Promise<number> {
  if (paths.length === 0 || opts.scan.messages === false) return 0;
  const r = await git(["log", "--all", "--format=%B%x00"], info.root);
  if (r.code !== 0) return 0;
  let count = 0;
  for (const message of r.stdout.split("\0")) {
    if (!message.trim()) continue;
    if (paths.some((p) => mentions(message, p))) count++;
  }
  return count;
}

/** True when `message` talks about `path` (basename or full path). */
function mentions(message: string, path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return (
    message.includes(path) ||
    new RegExp(`(^|[^\\w./-])${escapeRe(base)}([^\\w.-]|$)`, "m").test(message)
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite commit messages that talk about a removed artifact, so the history
 * does not keep claiming "add CLAUDE.md" for a file that no longer exists.
 *
 * The subject line is cleaned in place rather than deleted - dropping it would
 * promote the first body line into the subject. Body lines that only exist to
 * describe the removed file are dropped.
 */
export function stripMentionLines(message: string, paths: string[]): string {
  if (paths.length === 0) return message;
  const lines = message.split("\n");
  const subject = lines[0] ?? "";
  const body = lines.slice(1);

  const cleanedSubject = subject
    ? removeMentions(subject, paths)
    : subject;
  const keptBody = body.filter((line) => line.trim() === "" || !isArtifactBullet(line, paths));

  const out = [cleanedSubject, ...keptBody].join("\n").replace(/\n{3,}/g, "\n\n");
  return out.replace(/^\n+/, "").replace(/\n+$/, "\n");
}

/**
 * True for a body line whose subject *is* a removed artifact, such as
 * "- CLAUDE.md: 新增指引文件". Prose that merely mentions one ("Update docs
 * (AGENTS.md, CLAUDE.md, architecture)") is kept, because dropping it would
 * discard information about files that still exist.
 */
function isArtifactBullet(line: string, paths: string[]): boolean {
  const body = line.replace(/^[\s>*_-]+/, "").trimStart();
  if (!body) return false;
  return paths.some((p) => {
    const base = p.split("/").pop() ?? p;
    return (
      body.startsWith(p) || body.startsWith(base + ":") || body.startsWith(base + "：")
    );
  });
}

/**
 * Remove every mention of `paths` from a single line.
 *
 * The boundary guard matters: a naive pattern turns `Update .gitignore` into
 * `Update.gitignore`, and `\b` does not help either because a leading `.` is
 * not a word character. So require a non-word, non-dot character before the
 * name, which also protects `MY_CLAUDE.md` from losing its suffix.
 */
function removeMentions(line: string, paths: string[]): string {
  let out = line;
  for (const p of paths) {
    const base = p.split("/").pop() ?? p;
    for (const name of new Set([p, base])) {
      if (!name) continue;
      out = out.replace(new RegExp(`(^|[^\\w.-])[ \\t]*${escapeRe(name)}(?![\\w-])`, "g"), "$1");
    }
  }
  return out.replace(/[ \t]{2,}/g, " ").trimEnd();
}

export async function purge(
  info: RepoInfo,
  plan: PurgePlan,
  opts: PurgeOptions,
): Promise<PurgeResult> {
  const warnings: string[] = [];
  const artifactMatcher = (p: string) => plan.rules.some((r) => r.test(p));

  // Messages are scrubbed unconditionally; the files themselves are only
  // deleted when `--files` is given. With the default, the verification
  // fingerprint therefore *includes* CLAUDE.md, which proves the rewrite left
  // every file alone.
  const matcher = opts.removeFiles ? artifactMatcher : () => false;

  const state = await repoState(info);
  if (state.inProgress.length) {
    throw new Error(
      `refusing to rewrite: ${state.inProgress.join(", ")}. Finish or abort it first.`,
    );
  }
  if (state.dirty && !opts.force) {
    throw new Error(
      "refusing to rewrite a repository with uncommitted changes.\n" +
        "Commit, stash, or re-run with --force.",
    );
  }
  if (info.shallow) {
    warnings.push(
      "this is a shallow clone - old commits are missing and cannot be purged. " +
        "Run `git fetch --unshallow` first.",
    );
  }

  opts.log(dim(`... fingerprinting refs`));
  const before = await fingerprintRefs(info, matcher);
  for (const e of before.errors) warnings.push(`fingerprint: ${e}`);

  let backup: Backup | null = null;
  if (opts.backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    opts.log(dim("... creating backup bundle"));
    backup = await createBackup(info, stamp);
    opts.log(`backup written to ${backup.bundle}`);
  }

  const workDir = `${info.gitDir}/kick-claude/rewrite`;
  let native: NativePurgeResult | null = null;
  let filterRepoOutput: string | null = null;

  if (plan.resolvedEngine === "filter-repo") {
    if (!opts.removeFiles) {
      throw new Error(
        "the filter-repo engine only removes files; it cannot scrub commit messages.\n" +
          "Re-run with --engine native, or pass --files to delete the artifacts instead.",
      );
    }
    opts.log(dim("... rewriting history with git filter-repo"));
    const r = await runFilterRepo(info, {
      pathSpecs: rulesToPathSpecs(opts.scan.extraSpecs ?? []),
      force: true,
    });
    filterRepoOutput = r.output;
    if (!r.ok) throw new Error(`git filter-repo failed:\n${r.output}`);
  } else {
    opts.log(dim("... rewriting history (native engine)"));
    native = await nativePurge(info, {
      matchPath: matcher,
      pruneEmpty: opts.pruneEmpty,
      remapHashes: opts.remapHashes,
      workDir,
      ...(opts.scrubMessageMentions && opts.removeFiles
        ? {
            filterMessage: (message: string) =>
              stripMentionLines(defaultMessageFilter(message), plan.artifactPaths),
          }
        : {}),
      log: (m: string) => opts.log(dim(m)),
    });
  }

  if (!info.bare) {
    await git(["reset", "--hard", "--quiet"], info.root);
  }

  if (!opts.keepOldObjects) {
    opts.log(dim("... expiring reflogs and repacking"));
    await git(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"], info.root);
    await git(["gc", "--prune=now", "--quiet"], info.root);
  }

  // git filter-repo removes `origin` on purpose; put it back so the user's
  // next `git push` is not a surprise.
  if (plan.resolvedEngine === "filter-repo" && info.remotes.origin) {
    await git(["remote", "add", "origin", info.remotes.origin], info.root);
  }

  opts.log(dim("... verifying"));
  const verify = await verifyRewrite(info, before, plan.commits, matcher);

  return { plan, backup, native, filterRepoOutput, verify, before, warnings };
}

export function restoreInstructions(backup: Backup | null, info: RepoInfo): string[] {
  if (!backup) return [];
  return restoreHint(backup, info);
}