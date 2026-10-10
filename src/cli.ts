#!/usr/bin/env node
/**
 * kick-claude — detect and losslessly purge Claude Code collaboration
 * artifacts from a git repository.
 */
import { parseArgs } from "node:util";
import { GitError, commitCount, hasFilterRepo, repoInfo } from "./git.ts";
import { scan, type ScanOptions } from "./detect.ts";
import { DEFAULT_RULES } from "./rules.ts";
import { cleanWorktree, ignoreBlockLines, updateGitignore } from "./worktree.ts";
import {
  planPurge,
  purge,
  restoreInstructions,
  type Engine,
  type PurgeOptions,
} from "./purge/index.ts";
import {
  blue,
  bold,
  cyan,
  dim,
  gray,
  green,
  heading,
  humanBytes,
  magenta,
  out,
  red,
  setColor,
  shortOid,
  sym,
  table,
  yellow,
  confirm,
} from "./ui.ts";

const VERSION = "0.1.0";

const OPTION_SPEC = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  cwd: { type: "string" },
  secrets: { type: "boolean" },
  worktree: { type: "boolean" },
  reflog: { type: "boolean" },
  fast: { type: "boolean" },
  verbose: { type: "boolean" },
  rules: { type: "boolean" },
  stage: { type: "boolean" },
  "no-gitignore": { type: "boolean" },
  "exit-zero": { type: "boolean" },
  include: { type: "string", multiple: true },
  exclude: { type: "string", multiple: true },
  path: { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  force: { type: "boolean" },
  backup: { type: "boolean" },
  "no-backup": { type: "boolean" },
  "keep-old": { type: "boolean" },
  "scrub-mentions": { type: "boolean" },
  files: { type: "boolean" },
  engine: { type: "string" },
  "no-prune": { type: "boolean" },
  "no-remap": { type: "boolean" },
  "no-messages": { type: "boolean" },
} as const;

interface Options {
  cwd?: string;
  json: boolean;
  verbose: boolean;
  dryRun: boolean;
  assumeYes: boolean;
  force: boolean;
  stage: boolean;
  noGitignore: boolean;
  scan: ScanOptions;
}

function main(): Promise<number> {
  return dispatch();
}

async function dispatch(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: OPTION_SPEC,
      allowPositionals: true,
      args: process.argv.slice(2),
    });
  } catch (e) {
    errPrint((e as Error).message);
    return 2;
  }
  const v = parsed.values;
  const positionals = parsed.positionals;
  const command = positionals[0] ?? "scan";

  if (v.version) {
    out(VERSION);
    return 0;
  }
  if (v.rules || command === "rules") {
    printRules();
    return 0;
  }
  if (v.help || command === "help") {
    printHelp(positionals[1]);
    return 0;
  }
  if (v.json) setColor(false);

  const opts: Options = {
    cwd: v.cwd as string | undefined,
    json: Boolean(v.json),
    verbose: Boolean(v.verbose),
    dryRun: Boolean(v["dry-run"]),
    assumeYes: Boolean(v.yes),
    force: Boolean(v.force) || Boolean(v["exit-zero"]),
    stage: Boolean(v.stage),
    noGitignore: Boolean(v["no-gitignore"]),
    scan: {
      include: v.include as string[] | undefined,
      exclude: v.exclude as string[] | undefined,
      extraSpecs: v.path as string[] | undefined,
      includeReflog: Boolean(v.reflog),
      worktreeOnly: Boolean(v.worktree),
      secrets: Boolean(v.secrets),
      messages: !v["no-messages"],
      fast: Boolean(v.fast),
    },
  };

  switch (command) {
    case "scan":
      return await cmdScan(opts);
    case "clean":
      return await cmdClean(opts);
    case "init":
      return await cmdInit(opts);
    case "purge":
      return await cmdPurge(opts, v);
    default:
      errPrint(`unknown command: ${command}`);
      printHelp();
      return 2;
  }
}

function errPrint(msg: string): void {
  process.stderr.write(msg + "\n");
}

// --------------------------------------------------------------------- scan

async function cmdScan(opts: Options): Promise<number> {
  const info = await repoInfo(opts.cwd ?? process.cwd());
  const report = await scan(info, opts.scan);

  if (opts.json) {
    out(
      JSON.stringify(
        {
          repo: report.repo,
          counts: report.counts,
          paths: report.paths,
          findings: report.findings,
          durationMs: report.durationMs,
        },
        null,
        2,
      ),
    );
    return report.findings.length > 0 && !opts.force ? 1 : 0;
  }

  heading(`kick-claude scan  ${dim(shortOid(info.head ?? "no commits"))}`);
  out(`  repo     ${info.root}`);
  out(`  branch   ${info.branch ?? gray("(detached)")}   commits ${await commitCount(info)}`);
  out(`  rules    ${report.activeRules.map((r) => r.id).join(", ")}`);
  out();

  if (report.findings.length === 0) {
    out(`${sym.ok()} No Claude Code artifacts found.`);
    return 0;
  }

  const groups: Array<[string, string, (s: string) => string]> = [
    ["worktree", "Working tree", cyan],
    ["history", "Git history (paths)", magenta],
    ["message", "Commit messages", yellow],
    ["gitignore", ".gitignore entries", blue],
    ["secret", "Credentials", red],
  ];

  for (const [scope, title, color] of groups) {
    const items = report.findings.filter((f) => f.scope === scope);
    if (items.length === 0) continue;
    out(color(title) + dim(`  (${items.length})`));
    table(
      items.slice(0, 40).map((f) => {
        const loc = f.introducedIn ? dim("first in " + shortOid(f.introducedIn)) : "";
        return ["  " + (f.path ?? f.excerpt ?? f.label), loc];
      }),
    );
    if (items.length > 40) out(dim(`  ... and ${items.length - 40} more`));
    out();
  }

  if (report.hasSecrets) {
    out(
      `${sym.err()} Credentials were found inside Claude Code config files.\n` +
        `  ${bold("Revoke/rotate them")} - deleting the files does not invalidate a leaked key.\n`,
    );
  }
  if (report.repo.shallow) {
    out(`${sym.warn()} Shallow clone: history results are incomplete. Run git fetch --unshallow.`);
  }

  out(
    `${sym.info()} Next: ${bold("kick-claude clean")} (working tree) or ${bold(
      "kick-claude purge",
    )} (full history).`,
  );
  out(dim(`  scan took ${report.durationMs} ms`));

  return opts.force ? 0 : 1;
}

// -------------------------------------------------------------------- clean

async function cmdClean(opts: Options): Promise<number> {
  const info = await repoInfo(opts.cwd ?? process.cwd());
  const report = await scan(info, { ...opts.scan, worktreeOnly: true, messages: false });

  const result = await cleanWorktree(info, {
    paths: report.paths,
    rules: report.activeRules,
    stage: opts.stage,
    gitignore: !opts.noGitignore,
    dryRun: opts.dryRun,
  });

  if (opts.json) {
    out(JSON.stringify(result, null, 2));
    return 0;
  }

  heading(opts.dryRun ? "kick-claude clean (dry run)" : "kick-claude clean");
  if (result.removed.length === 0) {
    out(`${sym.ok()} Nothing to clean in the working tree.`);
    return 0;
  }
  table(result.removed.map((p) => ["  " + red("- " + p)]));
  if (result.gitignoreAdded.length) {
    out();
    out(`${sym.info()} .gitignore now ignores: ${dim(result.gitignoreAdded.join(", "))}`);
  }
  if (result.staged) out(`${sym.ok()} Removals staged. Review with git status, then commit.`);
  if (opts.dryRun) out(dim("dry run - nothing was deleted"));
  return 0;
}

// --------------------------------------------------------------------- init

async function cmdInit(opts: Options): Promise<number> {
  const info = await repoInfo(opts.cwd ?? process.cwd());
  const lines = opts.dryRun ? [] : await updateGitignore(info);
  heading(opts.dryRun ? "kick-claude init (dry run)" : "kick-claude init");
  table(ignoreBlockLines().map((l) => ["  " + dim(l)]));
  out();
  out(
    opts.dryRun
      ? `${sym.info()} dry run - .gitignore unchanged`
      : `${sym.ok()} .gitignore updated (${lines.length} patterns)`,
  );
  return 0;
}

// -------------------------------------------------------------------- purge

async function cmdPurge(opts: Options, v: Record<string, unknown>): Promise<number> {
  const info = await repoInfo(opts.cwd ?? process.cwd());
  const fr = await hasFilterRepo(info);
  const engine = (v.engine as Engine) ?? "auto";
  if (engine === "filter-repo" && !fr.available) {
    errPrint("git filter-repo is not installed. Install it with: pipx install git-filter-repo");
    return 2;
  }

  const purgeOpts: PurgeOptions = {
    engine,
    pruneEmpty: !v["no-prune"],
    remapHashes: !v["no-remap"],
    backup: !v["no-backup"],
    assumeYes: opts.assumeYes,
    force: opts.force,
    keepOldObjects: Boolean(v["keep-old"]),
    scrubMessageMentions: Boolean(v["scrub-mentions"]),
    removeFiles: Boolean(v.files),
    scan: opts.scan,
    log: (m) => {
      if (opts.verbose) out(dim(m));
    },
  };

  const plan = await planPurge(info, purgeOpts, fr.available);

  // --json must never short-circuit a real rewrite: only a dry run reports the
// plan, everything else reports the outcome of the work it actually did.
if (opts.json && opts.dryRun) {
    out(JSON.stringify({ plan: { ...plan, rules: undefined } }, null, 2));
    return 0;
  }
  if (opts.json && !plan.hasWork) {
    out(JSON.stringify({ plan: { ...plan, rules: undefined }, stats: null }, null, 2));
    return 0;
  }

  heading(opts.dryRun ? "kick-claude purge (plan)" : "kick-claude purge");
  out(`  repo         ${info.root}`);
  out(`  branch       ${info.branch ?? gray("(detached)")}`);
  out(`  commits      ${plan.commits}`);
  out(`  engine       ${plan.resolvedEngine}`);
  out(
    `  paths        ${plan.artifactPaths.length} artifact path(s), ${plan.historyOccurrences} historical occurrence(s)`,
  );
  out(`  messages     ${plan.messageCount} commit message(s) with Claude markers`);
  if (plan.removeFiles && plan.messageMentions > 0) {
    out(
      `  mentions     ${plan.messageMentions} commit message(s) still mention a removed path` +
        (v["scrub-mentions"] && purgeOpts.removeFiles
          ? " (being scrubbed)"
          : dim("  (--scrub-mentions to remove)")),
    );
  }
  out(
    `  options      scope=${purgeOpts.removeFiles ? "messages+files" : "messages-only"}` +
      ` prune-empty=${purgeOpts.pruneEmpty} remap-hashes=${purgeOpts.remapHashes} backup=${purgeOpts.backup}`,
  );
  out();

  if (!plan.hasWork) {
    out(`${sym.ok()} Nothing to purge.`);
    return 0;
  }
  if (plan.artifactPaths.length) {
    table(
      plan.artifactPaths
        .slice(0, 25)
        .map((p) => ["  " + (purgeOpts.removeFiles ? red(p) : yellow(p))]),
    );
    if (plan.artifactPaths.length > 25) {
      out(dim(`  ... and ${plan.artifactPaths.length - 25} more`));
    }
    out(
      purgeOpts.removeFiles
        ? dim("  the files above are deleted from every commit")
        : yellow(
            `  the files above are KEPT - only commit messages are rewritten\n` +
              `  pass --files to delete them from history too`,
          ),
    );
    out();
  }

  if (opts.dryRun) {
    out(`${sym.info()} Dry run - no changes made.`);
    return 0;
  }

  out(
    `${sym.warn()} Rewriting history changes every commit id from the first removed file onwards.\n` +
      dim("  Everyone with a clone must re-clone; a normal pull resurrects the old history.") +
      "\n",
  );

  if (!opts.assumeYes) {
    const ok = await confirm("Rewrite this repository's history?", false);
    if (!ok) {
      out(dim("aborted"));
      return 130;
    }
  }

  const result = await purge(info, plan, purgeOpts);
const verdict = result.verify;

if (opts.json) {
    out(
      JSON.stringify(
        {
          repo: info.root,
          engine: plan.resolvedEngine,
          stats: result.native
            ? {
                commits: result.native.stats.commits,
                prunedCommits: result.native.stats.prunedCommits,
                removedFileChanges: result.native.stats.removedFileChanges,
                rewrittenMessages: result.native.stats.rewrittenMessages,
                droppedTags: result.native.stats.droppedTags,
                droppedResets: result.native.stats.droppedResets,
                droppedRefs: result.native.stats.droppedRefs,
              }
            : null,
          passes: result.native?.passes ?? null,
          remappedMessages: result.native?.remappedMessages ?? 0,
          backup: result.backup
            ? { bundle: result.backup.bundle, sizeBytes: result.backup.sizeBytes }
            : null,
          warnings: result.warnings,
          verification: {
            ok: verdict.ok,
            commitsAfter: verdict.commitsAfter,
            fsckOk: verdict.fsck.ok,
            treeDiff: verdict.treeDiff,
            notes: verdict.notes,
          },
        },
        null,
        2,
      ),
    );
    return verdict.ok ? 0 : 1;
  }

  heading("result");
  if (result.native) {
    const s = result.native.stats;
    out(`  commits seen         ${s.commits}`);
    out(`  commits pruned       ${green(String(s.prunedCommits))}`);
    out(`  file changes removed ${s.removedFileChanges}`);
    out(`  messages rewritten   ${s.rewrittenMessages}`);
    if (result.native.passes > 1) out(`  passes               ${result.native.passes}`);
  } else if (result.filterRepoOutput) {
    out("  " + dim(result.filterRepoOutput.split("\n").slice(-3).join("\n  ")));
  }

  out();
  out(
    verdict.ok
      ? `  ${sym.ok()} verification passed: ${verdict.commitsAfter} commits, every non-artifact blob identical`
      : `  ${sym.err()} verification reported problems`,
  );
  if (!verdict.fsck.ok) {
    out("  " + red("git fsck: " + verdict.fsck.output.split("\n").slice(0, 5).join("; ")));
  }
  for (const d of verdict.treeDiff) {
    out("  " + red(`tree changed on ${d.ref}: ${d.before.count} -> ${d.after.count} entries`));
  }
  for (const n of verdict.notes) out(`  ${yellow("!")} ${n}`);
  for (const w of result.warnings) out(`  ${yellow("!")} ${w}`);

  if (result.backup) {
    out();
    out(
      `  ${sym.info()} backup bundle: ${result.backup.bundle} ${dim(
        "(" + humanBytes(result.backup.sizeBytes) + ")",
      )}`,
    );
    out(`  ${dim("restore with:")}`);
    for (const line of restoreInstructions(result.backup, info)) out(dim("    " + line));
  }

  out();
  out(bold("Next steps"));
  const remote = info.remotes.origin ?? "origin";
  const lines = [
    // `--tags` cannot be combined with `--branches`, so both are pushed as
    // explicit refspecs instead.
    `git push --force --prune ${remote} refs/heads/*:refs/heads/* refs/tags/*:refs/tags/*`,
    "git reflog expire --expire=now --all && git gc --prune=now   # run on the remote/forks too",
    "tell collaborators to delete their clones and re-clone",
  ];
  for (const l of lines) out("  " + dim(l));

  return verdict.ok ? 0 : 1;
}

// --------------------------------------------------------------------- help

function printRules(): void {
  heading("artifact rules");
  table(
    DEFAULT_RULES.map((r) => ["  " + bold(r.id), r.kind, r.pattern, dim(r.severity)]),
    { head: ["  id", "kind", "pattern", "level"] },
  );
  out();
  out(
    dim(
      "Use --include <id> / --exclude <id> to narrow the set and --path <spec> to add your own.\n" +
        "Specs accept dir:, file:, glob: or regex: prefixes; a bare value matches a root path.",
    ),
  );
}

function printHelp(topic?: string): void {
  if (topic === "rules") {
    printRules();
    return;
  }
  heading("kick-claude " + VERSION);
  out(
    [
      "",
      "  " + bold("Detect and losslessly purge Claude Code collaboration files"),
      "  CLAUDE.md, CLAUDE.local.md, .claude/, .mcp.json, .claude.json",
      "  " + dim("purge rewrites commit messages by default; add --files to delete the files too"),
      "",
      "  " + bold("USAGE"),
      "    kick-claude <command> [options]",
      "",
      "  " + bold("COMMANDS"),
      "    scan      Report every artifact in the working tree and in all history (default)",
      "    clean     Remove artifacts from the working tree and update .gitignore",
      "    init      Only write the managed .gitignore block",
      "    purge     Rewrite all history so the artifacts never existed (destructive)",
      "    rules     Show the artifact rule set",
      "",
      "  " + bold("SCAN OPTIONS"),
      "    --json               Machine-readable output",
      "    --secrets            Look for credentials inside .mcp.json / settings*.json",
      "    --worktree           Skip the history probes (much faster)",
      "    --reflog             Also inspect reflog-only objects",
      "    --fast               Use the cheaper (slightly less exact) history walk",
      "    --path <spec>        Add a path rule (repeatable)",
      "    --include <id>       Only these rule ids",
      "    --exclude <id>       Skip these rule ids",
      "    --no-messages        Do not inspect commit messages",
      "    --force              Always exit 0",
      "",
      "  " + bold("CLEAN OPTIONS"),
      "    --stage              Stage the deletions (git rm --cached)",
      "    --no-gitignore       Do not touch .gitignore",
      "    --dry-run            Show what would happen",
      "",
      "  " + bold("PURGE OPTIONS"),
      "    --files              Also delete CLAUDE.md & co from every commit (default: messages only)",
      "    --engine <e>         auto | native | filter-repo  (default: auto -> native)",
      "    --no-prune           Keep commits that become empty",
      "    --no-remap           Do not rewrite hash references inside commit messages",
      "    --no-backup          Skip the pre-rewrite git bundle",
      "    --keep-old           Do not expire reflogs / gc after the rewrite",
      "    --scrub-mentions      Also delete message lines that mention a removed path",
      "    --dry-run            Print the plan and exit",
      "    -y, --yes            Do not ask for confirmation",
      "    --force              Rewrite even with a dirty working tree",
      "",
      "  " + bold("EXAMPLES"),
      "    kick-claude scan --secrets",
      "    kick-claude clean --stage",
      "    kick-claude purge --dry-run",
      "    kick-claude purge -y && git push --force --all",
      "",
    ].join("\n"),
  );
  out(dim("Exit codes: 0 clean, 1 artifacts/problem found, 2 usage error, 130 aborted."));
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof GitError) errPrint(red("error: ") + e.message);
    else errPrint(red("error: ") + ((e as Error)?.message ?? String(e)));
    if (process.env.KICK_CLAUDE_DEBUG) errPrint(String((e as Error)?.stack ?? ""));
    process.exit(2);
  },
);