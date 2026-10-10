"use strict";
/**
 * GitHub Action entry point for kick-claude.
 *
 * Zero dependencies on purpose: the runner only ships Node and git, and a
 * committed bundle plus this file means `uses: Maicarons/kick-claude@v1` works
 * without the npm registry being reachable.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CLI = path.join(__dirname, "cli.js");
const MAX_BUFFER = 256 * 1024 * 1024;

function input(name, fallback = "") {
  const raw = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

function boolInput(name, fallback) {
  const raw = input(name, "");
  if (raw === "") return fallback;
  return /^(true|yes|1|on)$/i.test(raw.trim());
}

function listInput(name) {
  return input(name, "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const COMMAND = input("command", "scan").trim();
const REPO_PATH = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd(), input("path", "."));
const EXTRA_ARGS = input("args", "").trim();
const FAIL_ON_FINDINGS = boolInput("fail-on-findings", true);
const SECRETS = boolInput("secrets", false);
const EXTRA_PATHS = listInput("extra-paths");
const INCLUDE_RULES = listInput("include-rules");
const EXCLUDE_RULES = listInput("exclude-rules");
const DRY_RUN = boolInput("dry-run", false);
const PRUNE_EMPTY = boolInput("prune-empty", true);
const REMAP_HASHES = boolInput("remap-hashes", true);
const INCLUDE_REFLOG = boolInput("include-reflog", false);
const ENGINE = input("engine", "auto").trim();
const ENSURE_FULL_HISTORY = boolInput("ensure-full-history", true);
const GC = boolInput("gc", false);
const PUSH = boolInput("push", false);
const PUSH_REMOTE = input("push-remote", "origin").trim();
const PUSH_REFSPEC = input(
  "push-refspec",
  "--force --prune refs/heads/*:refs/heads/* refs/tags/*:refs/tags/*"
).trim();
const TOKEN = input("token", "").trim();
const WRITE_SUMMARY = boolInput("summary", true);
const REMOVE_FILES = boolInput("files", false);
const SCRUB_MENTIONS = boolInput("scrub-mentions", false);

const VALID_COMMANDS = new Set(["scan", "clean", "init", "purge", "rules"]);

function log(message) {
  process.stdout.write(message + "\n");
}

function warn(message) {
  log(`::warning::${message}`);
}

function fail(message) {
  log(`::error::${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const text = String(value == null ? "" : value);
  if (!file) return;
  const delimiter = `ghadelimiter_${name}`;
  fs.appendFileSync(
    file,
    text.includes("\n") ? `${name}<<${delimiter}\n${text}\n${delimiter}\n` : `${name}=${text}\n`
  );
}

function git(args, cwd = REPO_PATH) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
}

function gitOk(args, cwd = REPO_PATH) {
  const r = git(args, cwd);
  if (r.status !== 0) {
    warn(`git ${args.join(" ")} failed: ${(r.stderr || "").trim().split("\n")[0]}`);
  }
  return r;
}

function writeSummary(body) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file || !WRITE_SUMMARY) return;
  fs.appendFileSync(file, body + "\n");
}

function guardInputs() {
  if (!VALID_COMMANDS.has(COMMAND)) {
    fail(`Unknown command "${COMMAND}". Expected one of: ${[...VALID_COMMANDS].join(", ")}.`);
  }
  if (!fs.existsSync(CLI)) {
    fail(`The bundled CLI is missing at ${CLI}. This action installation looks corrupt.`);
  }
  if (!fs.existsSync(path.join(REPO_PATH, ".git"))) {
    fail(`No git repository found at ${REPO_PATH}. Did you forget actions/checkout?`);
  }
  if (PUSH && COMMAND !== "purge") {
    fail('"push" only applies to the purge command. Use command: purge with push: true.');
  }
  if (PUSH && DRY_RUN) warn("dry-run is enabled, so the force push is skipped.");
  const event = process.env.GITHUB_EVENT_NAME || "";
  if (PUSH && event.startsWith("pull_request")) {
    fail(
      `Refusing to force push from a ${event} event. A pull_request workflow must never rewrite ` +
        "the base branch. Run this from a push or workflow_dispatch workflow instead."
    );
  }
}

function describeRepo() {
  const head = gitOk(["rev-parse", "--short", "HEAD"]).stdout.trim();
  const branch = gitOk(["symbolic-ref", "--short", "HEAD"]).stdout.trim();
  const origin = gitOk(["remote", "get-url", PUSH_REMOTE]).stdout.trim();
  const shallow = gitOk(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
  return { head, branch: branch || null, origin, shallow };
}

function ensureFullHistory() {
  if (describeRepo().shallow) {
    log("::group::kick-claude: fetching complete history");
    let r = git(["fetch", "--prune", "--unshallow", PUSH_REMOTE]);
    if (r.status !== 0) r = git(["fetch", "--prune", "--all", "--tags", "--force"]);
    if (r.status !== 0) {
      fail(
        "The checkout is shallow and could not be deepened. A shallow clone hides commits, " +
          "which would make a force push delete history. Use fetch-depth: 0 on actions/checkout."
      );
    }
    log(gitOk(["rev-parse", "--is-shallow-repository"]).stdout.trim());
    log("::endgroup::");
  }
  if (PUSH) gitOk(["fetch", "--prune", "--tags", "--force", PUSH_REMOTE]);
}

function assertCleanWorktree() {
  const status = gitOk(["status", "--porcelain"]).stdout.trim();
  if (status) {
    fail(
      "The working tree has uncommitted changes, so the history was not rewritten.\n" +
        status.split("\n").slice(0, 10).join("\n") +
        "\nCommit, stash or clean them first, or re-run with args: --force."
    );
  }
}

function warnIfSelfRepo(repo) {
  const self = (process.env.GITHUB_ACTION_REPOSITORY || "").toLowerCase();
  if (!self || !repo.origin) return;
  const parts = self.split("/");
  const origin = repo.origin.toLowerCase();
  if (origin.includes(parts[0]) && parts[1] && origin.includes(parts[1])) {
    warn(
      `This action is rewriting the repository it lives in (${self}). If a moving tag such as ` +
        "v1 is rewritten, every workflow pinned to it breaks."
    );
  }
}

function buildArgs() {
  const args = [COMMAND, "--cwd", REPO_PATH, "--json"];

  if (SECRETS) args.push("--secrets");
  if (DRY_RUN) args.push("--dry-run");
  if (INCLUDE_REFLOG) args.push("--reflog");
  for (const p of EXTRA_PATHS) args.push("--path", p);
  for (const r of INCLUDE_RULES) args.push("--include", r);
  for (const r of EXCLUDE_RULES) args.push("--exclude", r);

  if (COMMAND === "purge") {
    args.push("--yes");
    // Only the commit messages are rewritten unless the caller opts into
    // deleting the files, mirroring the CLI default.
    if (REMOVE_FILES) args.push("--files");
    if (SCRUB_MENTIONS && REMOVE_FILES) args.push("--scrub-mentions");
    if (!PRUNE_EMPTY) args.push("--no-prune");
    if (!REMAP_HASHES) args.push("--no-remap");
    if (!GC) args.push("--keep-old");
    if (ENGINE && ENGINE !== "auto") args.push("--engine", ENGINE);
  }

  if (COMMAND === "scan" || COMMAND === "clean" || COMMAND === "init") {
    args.push("--force");
  }

  if (EXTRA_ARGS) args.push(...EXTRA_ARGS.split(/\s+/).filter(Boolean));
  return args;
}

function parseJson(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

function forcePush(repo) {
  if (!repo.origin) {
    fail(`Remote "${PUSH_REMOTE}" does not exist, so the rewritten history cannot be pushed.`);
  }
  if (!repo.branch) {
    fail(
      "HEAD is detached, so there is no branch to update. Check out a branch before purging, " +
        "or push the refs yourself with --mirror."
    );
  }
  if (TOKEN) {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    gitOk([
      "config",
      "--local",
      "http.https://github.com/.extraheader",
      `AUTHORIZATION: basic ${basic}`,
    ]);
  }
  // git requires the remote *before* any refspec, so split the configured
  // tokens into leading flags and the refspecs that follow the repository.
  const tokens = PUSH_REFSPEC.split(/\s+/).filter(Boolean);
  const flags = tokens.filter((t) => t.startsWith("-"));
  const refspecs = tokens.filter((t) => !t.startsWith("-"));
  log(`::group::kick-claude: git push ${PUSH_REMOTE} ${[...flags, ...refspecs].join(" ")}`);
  const r = git(["push", ...flags, PUSH_REMOTE, ...refspecs]);
  log((r.stdout || "") + (r.stderr || ""));
  log("::endgroup::");
  if (r.status !== 0) {
    fail(
      "The force push failed. The job usually needs `permissions: contents: write`, and the " +
        "remote must allow force pushes."
    );
  }
}

function handleScan(report) {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const paths = Array.isArray(report.paths) ? report.paths : [];
  setOutput("found", findings.length ? "true" : "false");
  setOutput("paths", paths.join("\n"));

  if (findings.length === 0) {
    log("No Claude Code artifacts found.");
    return;
  }

  log(`${findings.length} finding(s):`);
  for (const f of findings.slice(0, 50)) log(`  ${f.scope} ${f.path || f.label || ""}`);
  if (findings.length > 50) log(`  ... and ${findings.length - 50} more`);

  const secrets = findings.filter((f) => f.scope === "secret");
  if (secrets.length) {
    warn(
      `${secrets.length} possible credential(s) in committed files. Rotate them: removing the ` +
        "file from history does not un-leak a secret."
    );
  }
  if (FAIL_ON_FINDINGS) {
    fail(
      `${findings.length} Claude Code artifact(s) found. Run "command: purge" to remove them ` +
        'from history, or "command: clean" for the working tree only.'
    );
  }
}

function handlePurgePlan(plan) {
  const paths = Array.isArray(plan.artifactPaths) ? plan.artifactPaths : [];
  setOutput("found", paths.length ? "true" : "false");
  setOutput("paths", paths.join("\n"));
  setOutput("commits-seen", plan.commits == null ? 0 : plan.commits);
  setOutput("pushed", "false");

  log(`Nothing was changed (dry run). ${plan.commits ?? 0} commit(s) would be inspected.`);
  if (!paths.length) {
    log("No artifacts to purge.");
    return;
  }
  log(`${paths.length} artifact path(s) would be removed:`);
  for (const p of paths.slice(0, 50)) log(`  ${p}`);
  if (paths.length > 50) log(`  ... and ${paths.length - 50} more`);
}

function handlePurge(report) {
  const stats = report.stats || {};
  const verification = report.verification || {};

  if (!stats) {
    // The repository had nothing to purge, so the CLI reported a plan only.
    setOutput("found", "false");
    setOutput("pushed", "false");
    log("Nothing to purge.");
    return;
  }
  setOutput("commits-seen", stats.commits == null ? 0 : stats.commits);
  setOutput("commits-pruned", stats.prunedCommits == null ? 0 : stats.prunedCommits);
  setOutput("files-removed", stats.removedFileChanges == null ? 0 : stats.removedFileChanges);
  setOutput("messages-rewritten", (stats.rewrittenMessages || 0) + (report.remappedMessages || 0));
  setOutput("verification-ok", verification.ok ? "true" : "false");
  setOutput("backup-bundle", report.backup ? report.backup.bundle : "");
  setOutput("found", stats.removedFileChanges ? "true" : "false");

  log(
    `commits seen ${stats.commits || 0}, pruned ${stats.prunedCommits || 0}, ` +
      `file changes removed ${stats.removedFileChanges || 0}, ` +
      `messages rewritten ${stats.rewrittenMessages || 0}`
  );

  if (Array.isArray(report.warnings)) for (const w of report.warnings) warn(w);

  if (!verification.ok) {
    for (const note of verification.notes || []) warn(note);
    fail(
      "The rewrite finished but verification did not pass. Inspect the git fsck output above " +
        "and restore from the backup bundle if needed."
    );
  }

  if (PUSH && !DRY_RUN) {
    forcePush(describeRepo());
    setOutput("pushed", "true");
    log("Force pushed the rewritten history. Collaborators must delete and re-clone.");
    log(
      "The remote keeps the old objects until it runs: " +
        "git reflog expire --expire=now --all && git gc --prune=now"
    );
  } else {
    setOutput("pushed", "false");
    log(`History rewritten locally only. Push it with:\n  git push ${PUSH_REFSPEC} ${PUSH_REMOTE}`);
  }
}

function renderSummary(report) {
  const lines = ["## kick-claude", ""];
  if (report.plan) {
    const p = report.plan;
    lines.push(
      `Dry run - nothing was changed. ${p.commits || 0} commit(s) inspected, ` +
        `${(p.artifactPaths || []).length} artifact path(s) would be removed.`,
      ""
    );
    for (const path of (p.artifactPaths || []).slice(0, 100)) lines.push(`- \`${path}\``);
    return lines.join("\n");
  }
  if (report.counts) {
    const c = report.counts;
    lines.push(
      `Findings: **${c.total || 0}** (worktree ${c.worktree || 0}, history ${c.history || 0}, ` +
        `messages ${c.message || 0}, gitignore ${c.gitignore || 0}, credentials ${c.secret || 0})`,
      ""
    );
    const findings = Array.isArray(report.findings) ? report.findings : [];
    if (findings.length) {
      lines.push("| scope | path | rule |", "| --- | --- | --- |");
      for (const f of findings.slice(0, 100)) {
        lines.push(`| ${f.scope} | \`${f.path || f.label || ""}\` | ${f.ruleId || ""} |`);
      }
      if (findings.length > 100) lines.push(`\n... and ${findings.length - 100} more`);
    }
  } else if (report.stats) {
    const s = report.stats;
    lines.push(
      "| metric | value |",
      "| --- | --- |",
      `| commits seen | ${s.commits || 0} |`,
      `| commits pruned | ${s.prunedCommits || 0} |`,
      `| file changes removed | ${s.removedFileChanges || 0} |`,
      `| messages rewritten | ${s.rewrittenMessages || 0} |`,
      `| passes | ${report.passes || 1} |`,
      `| verification | ${report.verification && report.verification.ok ? "passed" : "FAILED"} |`,
      ""
    );
  } else if (Array.isArray(report.removed)) {
    lines.push(
      `Removed ${report.removed.length} path(s) from the working tree.`,
      "",
      ...report.removed.map((p) => `- \`${p}\``),
      ""
    );
  }
  return lines.join("\n");
}

function main() {
  guardInputs();

  const repo = describeRepo();
  log(`kick-claude ${COMMAND} on ${REPO_PATH} (${repo.head || "no commits"})`);
  warnIfSelfRepo(repo);

  if (ENSURE_FULL_HISTORY) ensureFullHistory();
  if (COMMAND === "purge" && !DRY_RUN) assertCleanWorktree();

  const r = spawnSync(process.execPath, [CLI, ...buildArgs()], {
    cwd: REPO_PATH,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (r.error) fail(`Failed to run the bundled CLI: ${r.error.message}`);
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  const report = parseJson(stdout);

  if (!report) {
    if (stdout.trim()) log(stdout.trimEnd());
    if (stderr.trim()) log(stderr.trimEnd());
    if (r.status !== 0) fail(`kick-claude ${COMMAND} exited with code ${r.status}.`);
    setOutput("found", "false");
    setOutput("result", "{}");
    return;
  }

  setOutput("result", JSON.stringify(report));
  writeSummary(renderSummary(report));

  if (COMMAND === "scan") return handleScan(report);

  // A purge that never ran (dry run) reports the plan instead of a result.
  if (COMMAND === "purge" && report.plan) return handlePurgePlan(report.plan);

  if (COMMAND === "clean" || COMMAND === "init") {
    const removed = Array.isArray(report.removed) ? report.removed : [];
    setOutput("found", removed.length ? "true" : "false");
    setOutput("paths", removed.join("\n"));
    log(
      removed.length
        ? `Removed ${removed.length} path(s) from the working tree.`
        : "Nothing to clean in the working tree."
    );
    if (Array.isArray(report.gitignoreAdded) && report.gitignoreAdded.length) {
      log(`.gitignore now ignores: ${report.gitignoreAdded.join(", ")}`);
    }
    return;
  }

  if (COMMAND === "purge") return handlePurge(report);
  setOutput("found", "false");
}

try {
  main();
} catch (error) {
  if (!process.exitCode) fail(error && error.message ? error.message : String(error));
}