/**
 * Working-tree cleanup: remove the artifacts, optionally stage the deletion,
 * and keep `.gitignore` honest so Claude Code does not re-add them tomorrow.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, type RepoInfo } from "./git.ts";
import type { CompiledRule } from "./rules.ts";

export interface CleanResult {
  removed: string[];
  skipped: string[];
  gitignoreAdded: string[];
  staged: boolean;
}

const BLOCK_START = "# >>> kick-claude";
const BLOCK_END = "# <<< kick-claude";

/** The ignore block we manage, so it can be found/updated/removed idempotently. */
export function ignoreBlockLines(): string[] {
  return [
    BLOCK_START,
    "# Added by kick-claude — Claude Code collaboration files",
    ".claude/",
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".mcp.json",
    ".claude.json",
    BLOCK_END,
  ];
}

async function readGitignore(info: RepoInfo): Promise<string | null> {
  try {
    return await readFile(join(info.root, ".gitignore"), "utf8");
  } catch {
    return null;
  }
}

export async function updateGitignore(info: RepoInfo): Promise<string[]> {
  const current = await readGitignore(info);
  const block = ignoreBlockLines();

  if (current === null) {
    await writeFile(join(info.root, ".gitignore"), block.join("\n") + "\n", "utf8");
    return block.slice(2, -1);
  }

  let lines = current.split(/\r?\n/);
  const start = lines.indexOf(BLOCK_START);
  const end = lines.indexOf(BLOCK_END);

  if (start >= 0 && end > start) {
    lines = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(...block);
  }

  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
  if (next !== current) await writeFile(join(info.root, ".gitignore"), next, "utf8");
  return block.slice(2, -1);
}

/** Remove our managed ignore block again. */
export async function removeIgnoreBlock(info: RepoInfo): Promise<string[]> {
  const current = await readGitignore(info);
  if (current === null) return [];
  const lines = current.split(/\r?\n/);
  const start = lines.indexOf(BLOCK_START);
  const end = lines.indexOf(BLOCK_END);
  if (start < 0 || end <= start) return [];
  const removed = lines.slice(start + 2, end).filter((l) => l.trim());
  const next = [...lines.slice(0, start), ...lines.slice(end + 1)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  await writeFile(join(info.root, ".gitignore"), next, "utf8");
  return removed;
}

export interface CleanOptions {
  /** Candidate repo-relative paths (already normalised). */
  paths: string[];
  rules: CompiledRule[];
  /** Stage the removals with `git rm --cached`. */
  stage: boolean;
  /** Install / keep the managed `.gitignore` block. */
  gitignore: boolean;
  dryRun: boolean;
}

export async function cleanWorktree(info: RepoInfo, opts: CleanOptions): Promise<CleanResult> {
  const tracked = new Set(
    (await git(["ls-files", "-z"], info.root)).stdout.split("\0").filter(Boolean),
  );

  const isTarget = (p: string) => opts.rules.some((r) => r.test(p));
  // Remove children before their parent directory, so removing `.claude` does
  // not make the later removal of `.claude/settings.json` fail.
  const targets = [...new Set(opts.paths.filter(isTarget))].sort(
    (a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b),
  );

  const removed: string[] = [];
  const skipped: string[] = [];

  for (const rel of targets) {
    try {
      if (!opts.dryRun) await rm(join(info.root, rel), { recursive: true, force: true });
      removed.push(rel);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // already gone (e.g. removed as part of a dir)
      skipped.push(rel);
    }
  }

  let gitignoreAdded: string[] = [];
  if (opts.gitignore && !opts.dryRun) gitignoreAdded = await updateGitignore(info);

  let staged = false;
  if (opts.stage && !opts.dryRun && removed.some((p) => tracked.has(p))) {
    const args = ["rm", "-r", "--cached", "--ignore-unmatch", "--quiet"];
    for (const rel of removed) {
      if (tracked.has(rel)) args.push("--", rel);
    }
    const r = await git(args, info.root);
    staged = r.code === 0;
  }

  return { removed, skipped, gitignoreAdded, staged };
}