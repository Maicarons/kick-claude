/**
 * Safety net for destructive operations.
 *
 * Before any history rewrite we drop a self-contained `git bundle` inside
 * `.git/kick-claude/backups/`. A bundle (unlike a backup ref) keeps the old
 * objects alive without making them reachable, so the post-rewrite `gc` can
 * still reclaim them while the bundle stays a complete, clonable escape hatch.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitOrThrow, listRefs, type RepoInfo } from "../git.ts";

export interface Backup {
  dir: string;
  bundle: string;
  refsFile: string;
  createdAt: string;
  sizeBytes: number;
  refs: Record<string, string>;
}

export function backupRoot(info: RepoInfo, stamp: string): string {
  return join(info.gitDir, "kick-claude", stamp);
}

export async function createBackup(info: RepoInfo, stamp: string): Promise<Backup> {
  const dir = backupRoot(info, stamp);
  await mkdir(dir, { recursive: true });

  const bundle = join(dir, "history.bundle");
  // `--all` covers every ref; the snapshot below records what they pointed at.
  await gitOrThrow(["bundle", "create", bundle, "--all"], info.root);
  await gitOrThrow(["bundle", "verify", bundle], info.root);

  const refs = Object.fromEntries(await listRefs(info));
  const refsFile = join(dir, "refs.json");
  await writeFile(refsFile, JSON.stringify(refs, null, 2) + "\n");

  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(bundle)).size;
  } catch {
    /* ignore */
  }

  return { dir, bundle, refsFile, createdAt: new Date().toISOString(), sizeBytes, refs };
}

export function restoreHint(backup: Backup, info: RepoInfo): string[] {
  const target = join(backup.dir, "restored");
  return [
    `git clone "${backup.bundle}" "${target}"`,
    `cd "${target}" && git remote add origin ${info.remotes.origin ?? "<your-remote-url>"}`,
    "git push --force --mirror origin",
  ];
}