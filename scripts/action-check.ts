#!/usr/bin/env bun
/**
 * Local harness that exercises the GitHub Action exactly like a runner would:
 * same entry point, same `INPUT_*` environment variables, same `GITHUB_*`
 * context variables. Run it against throwaway repositories so a regression in
 * action/index.cjs is caught without waiting for CI.
 *
 *   bun run scripts/action-check.ts
 */
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const entry = join(root, "action", "index.cjs");
const cli = join(root, "action", "cli.js");

if (!existsSync(cli)) {
  console.error("action/cli.js is missing. Run `bun run build` first.");
  process.exit(1);
}

let failures = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo(files: string[], message = "feat: initial commit"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kick-claude-action-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@e.c"], dir);
  git(["config", "user.name", "T"], dir);
  for (const rel of files) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, rel.endsWith(".md") ? "# claude\n" : "{}\n", "utf8");
  }
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
  git(["tag", "v1.0.0"], dir);
  return dir;
}

async function runAction(dir: string, inputs: Record<string, string>, event = "push") {
  // The output/summary files must live outside the repository: writing them
  // inside would make the working tree dirty and the purge guard would (rightly)
  // refuse to run.
  const sidecar = await mkdtemp(join(tmpdir(), "kick-claude-action-io-"));
  const outputFile = join(sidecar, "outputs.txt");
  const summaryFile = join(sidecar, "summary.md");
  await writeFile(outputFile, "", "utf8");
  await writeFile(summaryFile, "", "utf8");

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GITHUB_WORKSPACE: dir,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_EVENT_NAME: event,
    GITHUB_ACTION_REPOSITORY: "someoneelse/kick-claude",
  };
  for (const [k, v] of Object.entries(inputs)) {
    env[`INPUT_${k.toUpperCase().replace(/ /g, "_")}`] = v;
  }

  const r = spawnSync(process.execPath, [entry], { cwd: dir, encoding: "utf8", env });
  const result = {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    outputs: await readFile(outputFile, "utf8"),
    summary: await readFile(summaryFile, "utf8"),
  };
  await rm(sidecar, { recursive: true, force: true });
  return result;
}

function outputValue(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(text);
  return match ? match[1] : undefined;
}

console.log("scan on a repository with artifacts (fail-on-findings: true)");
{
  const dir = await makeRepo(
    ["CLAUDE.md", ".claude/settings.json", "README.md"],
    "feat: initial commit\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"
  );
  const r = await runAction(dir, { command: "scan", secrets: "true" });
  check("step fails", r.status === 1, `status=${r.status}`);
  check("found output is true", outputValue(r.outputs, "found") === "true");
  check("paths output lists CLAUDE.md", /\bCLAUDE\.md\b/.test(r.outputs));
  check("result output is json", (outputValue(r.outputs, "result") || "").startsWith("{"));
  check("job summary written", r.summary.includes("## kick-claude"));
  check("history untouched", git(["log", "--format=%s"], dir).includes("initial commit"));
  await rm(dir, { recursive: true, force: true });
}

console.log("scan on a clean repository");
{
  const dir = await makeRepo(["src/index.js", "README.md"], "feat: nothing to see here");
  const r = await runAction(dir, { command: "scan" });
  check("step succeeds", r.status === 0, `status=${r.status}\n${r.stdout}\n${r.stderr}`);
  check("found output is false", outputValue(r.outputs, "found") === "false");
  await rm(dir, { recursive: true, force: true });
}

console.log("scan with fail-on-findings: false");
{
  const dir = await makeRepo(["CLAUDE.md"]);
  const r = await runAction(dir, { command: "scan", "fail-on-findings": "false" });
  check("step succeeds", r.status === 0, `status=${r.status}`);
  check("still reports found", outputValue(r.outputs, "found") === "true");
  await rm(dir, { recursive: true, force: true });
}

console.log("purge without push");
{
  const dir = await makeRepo(
    ["README.md"],
    "feat: initial commit\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"
  );
  // Second commit only adds artifacts, so it must disappear entirely.
  await writeFile(join(dir, "CLAUDE.md"), "# claude\n", "utf8");
  await writeFile(join(dir, ".mcp.json"), "{}\n", "utf8");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "chore: add claude config"], dir);

  const before = Number(git(["rev-list", "--count", "HEAD"], dir));
  const r = await runAction(dir, { command: "purge", files: "true" });
  check("step succeeds", r.status === 0, r.stdout + r.stderr);
  check("verification output true", outputValue(r.outputs, "verification-ok") === "true");
  check("files-removed is 2", outputValue(r.outputs, "files-removed") === "2", r.stdout);
  check("commits-pruned is 1", outputValue(r.outputs, "commits-pruned") === "1", r.stdout);
  check("message scrubbed", !git(["log", "--format=%B"], dir).includes("Co-Authored-By"));
  check("tag survived", git(["tag"], dir) === "v1.0.0");
  check(
    "only README.md remains",
    git(["ls-tree", "-r", "--name-only", "HEAD"], dir) === "README.md",
    git(["ls-tree", "-r", "--name-only", "HEAD"], dir)
  );
  check("artifact-only commit was dropped", git(["log", "--format=%s"], dir) === "feat: initial commit\n\nCo-Authored-By: Claude <noreply@anthropic.com>".split("\n\n")[0]);
  check("commit count shrank", Number(git(["rev-list", "--count", "HEAD"], dir)) < before);
  check("pushed output is false", outputValue(r.outputs, "pushed") === "false");
  await rm(dir, { recursive: true, force: true });
}

console.log("guards and dry runs");
{
  const dir = await makeRepo(["CLAUDE.md"]);
  const pr = await runAction(dir, { command: "purge", files: "true", push: "true" }, "pull_request");
  check("refuses force push from pull_request", pr.status === 1 && pr.stdout.includes("Refusing"));
  const mismatch = await runAction(dir, { command: "scan", push: "true" });
  check("push outside purge is rejected", mismatch.status === 1);
  const dry = await runAction(dir, { command: "purge", "dry-run": "true" });
  check("dry run succeeds", dry.status === 0, dry.stdout + dry.stderr);
  check(
    "dry run keeps artifacts",
    git(["ls-tree", "-r", "--name-only", "HEAD"], dir).includes("CLAUDE.md")
  );
  const bogus = await runAction(dir, { command: "nope" });
  check("unknown command is rejected", bogus.status === 1);
  await rm(dir, { recursive: true, force: true });
}

console.log("dirty working tree");
{
  const dir = await makeRepo(["CLAUDE.md"]);
  await appendFile(join(dir, "CLAUDE.md"), "local edit\n", "utf8");
  const r = await runAction(dir, { command: "purge", files: "true" });
  check("refuses a dirty working tree", r.status === 1 && r.stdout.includes("uncommitted"));
  await rm(dir, { recursive: true, force: true });
}

console.log("purge defaults to messages only");
{
  const dir = await mkdtemp(join(tmpdir(), "kick-claude-action-msgs-"));
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@e.c"], dir);
  git(["config", "user.name", "T"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  await writeFile(join(dir, "README.md"), "r\n", "utf8");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "feat: initial commit"], dir);
  await writeFile(join(dir, "CLAUDE.md"), "# claude\n", "utf8");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "docs: add guidance\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"], dir);
  const blob = git(["rev-parse", "HEAD:CLAUDE.md"], dir);

  const r = await runAction(dir, { command: "purge" });
  check("step succeeds", r.status === 0, r.stdout + r.stderr);
  check("files are kept by default", git(["cat-file", "-e", "HEAD:CLAUDE.md"], dir) === "");
  check("blob is unchanged", git(["rev-parse", "HEAD:CLAUDE.md"], dir) === blob);
  check("trailer is gone", !/Claude/.test(git(["log", "--format=%B", "-1"], dir)));
  check(
    "files-removed is 0",
    outputValue(r.outputs, "files-removed") === "0",
    outputValue(r.outputs, "files-removed")
  );
  await rm(dir, { recursive: true, force: true });
}

console.log("purge with a force push to a real bare remote");
{
  const remote = await mkdtemp(join(tmpdir(), "kick-claude-action-remote-"));
  const dir = await mkdtemp(join(tmpdir(), "kick-claude-action-push-"));

  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote], { encoding: "utf8" });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@e.c"], dir);
  git(["config", "user.name", "T"], dir);
  await writeFile(join(dir, "README.md"), "r\n", "utf8");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "feat: initial commit"], dir);
  await writeFile(join(dir, "CLAUDE.md"), "# claude\n", "utf8");
  await writeFile(join(dir, ".mcp.json"), "{}\n", "utf8");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "chore: add claude config"], dir);
  git(["remote", "add", "origin", remote], dir);
  git(["push", "-q", "origin", "main"], dir);
  git(["tag", "v1.0.0"], dir);
  git(["push", "-q", "origin", "v1.0.0"], dir);

  const r = await runAction(dir, { command: "purge", files: "true", push: "true", "push-remote": "origin" });

  check("step succeeds", r.status === 0, r.stdout + r.stderr);
  check("pushed output is true", outputValue(r.outputs, "pushed") === "true", r.stdout);
  if (r.status !== 0) console.log("---- action output ----\n" + r.stdout + r.stderr);
  check("verification passed", outputValue(r.outputs, "verification-ok") === "true");

  // The bare remote is the real proof: it must no longer serve the artifact.
  const clone = await mkdtemp(join(tmpdir(), "kick-claude-action-verify-"));
  const c = spawnSync("git", ["clone", "-q", remote, clone], { encoding: "utf8" });
  check("remote is cloneable", c.status === 0, c.stderr);
  check(
    "remote HEAD tree is clean",
    git(["ls-tree", "-r", "--name-only", "HEAD"], clone) === "README.md",
    git(["ls-tree", "-r", "--name-only", "HEAD"], clone)
  );
  const scanOut = spawnSync(
    process.execPath,
    [join(root, "action", "cli.js"), "scan", "--cwd", clone, "--json", "--force"],
    { encoding: "utf8" }
  );
  check(
    "remote history is free of artifacts",
    !/"CLAUDE\.md"|"\.mcp\.json"/.test(scanOut.stdout),
    scanOut.stdout.slice(0, 400)
  );

  await rm(remote, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
  await rm(clone, { recursive: true, force: true });
}

console.log(
  failures === 0 ? "\naction harness: all checks passed" : `\naction harness: ${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);