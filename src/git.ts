/** Thin, dependency-free wrappers around the `git` CLI. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function baseEnv() {
  // Keep behaviour reproducible regardless of the user's pager/credential setup.
  return {
    ...process.env,
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

export function spawnGit(
  args: string[],
  options: { cwd?: string } = {},
) {
  return spawn("git", args, {
    cwd: options.cwd,
    env: baseEnv(),
    windowsHide: true,
    shell: false,
  });
}

/** Run git and buffer the whole result. Rejects only on spawn failure. */
export async function git(args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawnGit(args, { cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    child.on("error", rej);
    child.on("close", (code) =>
      res({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

/** Run git and throw a `GitError` when it fails. */
export async function gitOrThrow(args: string[], cwd?: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed (${r.code})`, args, r.code, r.stderr.trim());
  }
  return r.stdout;
}

/** Split NUL-delimited output, dropping the trailing empty element. */
export function splitNul(input: string): string[] {
  const parts = input.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export interface RepoInfo {
  root: string;
  gitDir: string;
  bare: boolean;
  head: string | null;
  branch: string | null;
  shallow: boolean;
  /** Remote URLs, recorded so we can restore `origin` if a tool removes it. */
  remotes: Record<string, string>;
}

export async function repoRoot(cwd = process.cwd()): Promise<string> {
  const r = await git(["rev-parse", "--show-toplevel"], cwd);
  if (r.code !== 0) {
    throw new GitError(
      "not inside a git repository (or the repository has no worktree)",
      ["rev-parse", "--show-toplevel"],
      r.code,
      r.stderr.trim(),
    );
  }
  return r.stdout.trim();
}

export async function repoInfo(cwd = process.cwd()): Promise<RepoInfo> {
  const root = await repoRoot(cwd);
  const [gitDir, bare, head, branch, shallow, remotesRaw] = await Promise.all([
    git(["rev-parse", "--absolute-git-dir"], root),
    git(["rev-parse", "--is-bare-repository"], root),
    git(["rev-parse", "HEAD"], root),
    git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    git(["rev-parse", "--is-shallow-repository"], root),
    git(["remote", "-v"], root),
  ]);

  const remotes: Record<string, string> = {};
  for (const line of remotesRaw.stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (m && m[3] === "fetch") remotes[m[1]!] = m[2]!;
  }

  return {
    root,
    gitDir: gitDir.stdout.trim(),
    bare: bare.stdout.trim() === "true",
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 && branch.stdout.trim() !== "HEAD" ? branch.stdout.trim() : null,
    shallow: shallow.stdout.trim() === "true",
    remotes,
  };
}

export function absGitPath(info: RepoInfo, ...p: string[]): string {
  return join(info.gitDir, ...p);
}

export function absPath(info: RepoInfo, ...p: string[]): string {
  return resolve(info.root, ...p);
}

/** State that makes a history rewrite unsafe to start. */
export interface RepoState {
  dirty: boolean;
  inProgress: string[];
  untracked: number;
}

const IN_PROGRESS_MARKERS = [
  ["rebase-merge", "rebase in progress"],
  ["rebase-apply", "rebase in progress"],
  ["MERGE_HEAD", "merge in progress"],
  ["CHERRY_PICK_HEAD", "cherry-pick in progress"],
  ["REVERT_HEAD", "revert in progress"],
  ["BISECT_LOG", "bisect in progress"],
] as const;

export async function repoState(info: RepoInfo): Promise<RepoState> {
  const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"], info.root);
  const lines = status.stdout.split("\n").filter(Boolean);
  let untracked = 0;
  let dirty = false;
  for (const l of lines) {
    if (l.startsWith("??")) untracked++;
    else dirty = true;
  }
  const inProgress: string[] = [];
  for (const [marker, label] of IN_PROGRESS_MARKERS) {
    if (existsSync(join(info.gitDir, marker))) inProgress.push(label);
  }
  return { dirty: dirty || untracked > 0, inProgress, untracked };
}

/** All refs (heads, tags, remotes, notes, stash …) as `ref<TAB>oid`. */
export async function listRefs(info: RepoInfo): Promise<Map<string, string>> {
  const out = await gitOrThrow(["for-each-ref", "--format=%(refname)%09%(objectname)"], info.root);
  const map = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const [ref, oid] = line.split("\t");
    if (ref && oid) map.set(ref, oid);
  }
  return map;
}

export async function commitCount(info: RepoInfo): Promise<number> {
  const r = await git(["rev-list", "--all", "--count"], info.root);
  return r.code === 0 ? Number(r.stdout.trim() || "0") : 0;
}

/** `git filter-repo` may be a git subcommand (installed via pip) or on PATH. */
export async function hasFilterRepo(
  info: RepoInfo,
): Promise<{ available: boolean; via: "subcommand" | "PATH" | null; version: string | null }> {
  const sub = await git(["filter-repo", "--version"], info.root);
  if (sub.code === 0) {
    return { available: true, via: "subcommand", version: sub.stdout.trim() };
  }
  const which = await new Promise<string | null>((res) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, ["git-filter-repo"], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (c) => (out += c));
    child.on("error", () => res(null));
    child.on("close", (code) => res(code === 0 ? out.split(/\r?\n/)[0]!.trim() : null));
  });
  if (which) {
    const v = await git(["filter-repo", "--version"], info.root);
    return { available: true, via: "PATH", version: v.code === 0 ? v.stdout.trim() : null };
  }
  return { available: false, via: null, version: null };
}