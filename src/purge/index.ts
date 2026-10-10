/**
 * `kick-claude purge` orchestration:
 *
 *   pre-flight checks -> fingerprint -> backup -> rewrite -> cleanup -> verify
 */
import { commitCount, git, repoState, type RepoInfo } from "../git.ts";
import { scan, resolveRules, type ScanOptions } from "../detect.ts";
import type { CompiledRule } from "../rules.ts";
import { nativePurge, type NativePurgeResult } from "./native.ts";
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
  /** Scan tuning, shared with `kick-claude scan`. */
  scan: ScanOptions;
  log(msg: string): void;
}

export interface PurgePlan {
  artifactPaths: string[];
  historyPathCount: number;
  messageCount: number;
  commits: number;
  rules: CompiledRule[];
  engine: Engine;
  resolvedEngine: "native" | "filter-repo";
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

  return {
    artifactPaths: report.paths,
    historyPathCount: report.findings.filter((f) => f.scope === "history").length,
    messageCount: report.findings.filter((f) => f.scope === "message").length,
    commits,
    rules,
    engine: opts.engine,
    resolvedEngine,
    hasWork: report.findings.length > 0,
  };
}

export async function purge(
  info: RepoInfo,
  plan: PurgePlan,
  opts: PurgeOptions,
): Promise<PurgeResult> {
  const warnings: string[] = [];
  const matcher = (p: string) => plan.rules.some((r) => r.test(p));

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
      log: (m) => opts.log(dim(m)),
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