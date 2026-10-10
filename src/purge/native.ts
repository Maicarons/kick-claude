/**
 * Native history-rewrite engine.
 *
 *   git fast-export … | FastExportFilter | git fast-import …
 *
 * This is the same pipeline `git filter-repo` uses, minus the Python runtime,
 * minus the fresh-clone restriction, and with single-pass empty-commit pruning.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoInfo } from "../git.ts";
import { FastExportFilter, defaultMessageFilter, type FilterStats } from "./stream.ts";

export const FAST_EXPORT_FLAGS = [
  // NOTE: never pass --quiet here. On git 2.45 `fast-export --quiet` silently
  // drops file changes for every non-root commit unless --full-tree is also
  // given, which would quietly corrupt the rewrite. Progress goes to stderr,
  // which we capture anyway.
  "--no-data",
  "--show-original-ids",
  "--reference-excluded-parents",
  "--fake-missing-tagger",
  "--signed-tags=strip",
  "--tag-of-filtered-object=rewrite",
  "--use-done-feature",
  "--reencode=yes",
  "--mark-tags",
];

export interface NativePurgeOptions {
  matchPath(path: string): boolean;
  filterMessage?(message: string): string;
  pruneEmpty: boolean;
  remapHashes: boolean;
  workDir: string;
  log?(msg: string): void;
}

export interface NativePurgeResult {
  stats: FilterStats;
  /** old commit oid -> new commit oid. */
  commitMap: Map<string, string>;
  /** old commit oids that no longer exist after the rewrite. */
  pruned: Set<string>;
  passes: number;
  remappedMessages: number;
  warnings: string[];
}

/** Maps abbreviated and full old hashes to their rewritten counterparts. */
class HashRemapper {
  private prefixes = new Map<string, string>();
  private full = new Map<string, string>();

  constructor(map: Map<string, string>, pruned: Set<string> = new Set()) {
    for (const [oldSha, newSha] of map) {
      this.full.set(oldSha, newSha);
      const max = Math.min(12, oldSha.length);
      for (let len = 7; len <= max; len++) {
        const key = oldSha.slice(0, len);
        this.prefixes.set(key, this.prefixes.has(key) ? "" : newSha);
      }
    }
    for (const oid of pruned) {
      const max = Math.min(12, oid.length);
      for (let len = 7; len <= max; len++) this.prefixes.set(oid.slice(0, len), "");
    }
  }

  knows(token: string): boolean {
    if (token.length < 7) return false;
    return this.full.has(token) || this.prefixes.has(token);
  }

  replace(message: string): string {
    return message.replace(/\b[0-9a-f]{7,40}\b/g, (tok) => {
      if (tok.length === 40) {
        const exact = this.full.get(tok);
        if (exact) return exact;
      }
      const hit = this.prefixes.get(tok);
      return hit && hit.length >= tok.length ? hit.slice(0, tok.length) : tok;
    });
  }
}

interface PassArgs {
  info: RepoInfo;
  marksFile: string;
  pass: number;
  matchPath(path: string): boolean;
  pruneEmpty: boolean;
  baseMessageFilter(message: string): string;
  remapper: HashRemapper | null;
  candidates: Set<string>;
  log(m: string): void;
}

/**
 * Stream `git fast-export` through the filter into `git fast-import`.
 */
function runPass(args: PassArgs): Promise<{ stats: FilterStats; markToSha: Map<number, string> }> {
  const { info, marksFile } = args;

  return new Promise((resolve, reject) => {
    const exporter = spawn(
      "git",
      ["-c", "core.quotePath=false", "fast-export", ...FAST_EXPORT_FLAGS, "--all"],
      { cwd: info.root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const importer = spawn(
      "git",
      [
        "-c",
        "core.ignorecase=false",
        "fast-import",
        "--date-format=raw-permissive",
        "--force",
        "--quiet",
        `--export-marks=${marksFile}`,
      ],
      { cwd: info.root, stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
    );

    const errors: string[] = [];
    exporter.stderr.on("data", (c: Buffer) => {
      const s = c.toString("utf8").trim();
      if (s) errors.push("fast-export: " + s);
    });
    importer.stderr.on("data", (c: Buffer) => {
      const s = c.toString("utf8").trim();
      if (s) errors.push("fast-import: " + s);
    });

    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      try {
        exporter.kill();
      } catch {
        /* ignore */
      }
      try {
        importer.kill();
      } catch {
        /* ignore */
      }
      reject(e);
    };
    exporter.on("error", fail);
    importer.on("error", fail);

    const filter = new FastExportFilter(exporter.stdout!, importer.stdin!, {
      matchPath: args.matchPath,
      filterMessage: (message) => {
        const base = args.baseMessageFilter(message);
        return args.remapper ? args.remapper.replace(base) : base;
      },
      pruneEmpty: args.pruneEmpty,
      onWarn: (m) => args.log("warning: " + m),
      onMessageHashCandidate: (h) => {
        if (args.candidates.size < 50000) args.candidates.add(h);
      },
    });

    // The filter consumes the export stream; resolve once import is done.
    const filterDone = filter.run();

    importer.on("close", async (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`git fast-import exited with code ${code}\n${errors.join("\n")}`));
        return;
      }
      try {
        await filterDone;
        const stats = filter.result;
        const markToSha = await readMarks(marksFile);
        settled = true;
        args.log(
          `pass ${args.pass + 1}: ${stats.commits} commits seen, ${stats.prunedCommits} pruned, ` +
            `${stats.removedFileChanges} file changes removed, ${stats.rewrittenMessages} messages rewritten` +
            (stats.droppedTags ? `, ${stats.droppedTags} tags dropped` : ""),
        );
        resolve({ stats, markToSha });
      } catch (e) {
        fail(e as Error);
      }
    });
  });
}

async function readMarks(file: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(" ");
    if (sp < 0) continue;
    // Depending on the git version the mark is written as `12` or as `:12`.
    const mark = Number(trimmed.slice(0, sp).replace(/^:/, ""));
    if (!Number.isFinite(mark)) continue;
    map.set(mark, trimmed.slice(sp + 1).trim());
  }
  return map;
}

const ZERO = "0".repeat(40);

/**
 * Rewrite the whole history of `info` with the native engine.
 */
export async function nativePurge(
  info: RepoInfo,
  opts: NativePurgeOptions,
): Promise<NativePurgeResult> {
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];
  await mkdir(opts.workDir, { recursive: true });

  const baseMessageFilter = opts.filterMessage ?? defaultMessageFilter;
  const candidates = new Set<string>();

  const marks1 = join(opts.workDir, "marks-1");
  const first = await runPass({
    info,
    marksFile: marks1,
    pass: 0,
    matchPath: opts.matchPath,
    pruneEmpty: opts.pruneEmpty,
    baseMessageFilter,
    remapper: null,
    candidates,
    log,
  });

  let commitMap = new Map<string, string>();
  const pruned = new Set<string>();
  for (const [mark, oid] of first.stats.markToOid) {
    const sha = first.markToSha.get(mark);
    if (sha) commitMap.set(oid, sha);
    else pruned.add(oid);
  }

  let passes = 1;
  let remappedMessages = 0;

  if (opts.remapHashes) {
    const remapper = new HashRemapper(commitMap, pruned);
    const needed = [...candidates].some((c) => remapper.knows(c));
    if (needed) {
      log("commit messages reference rewritten hashes — running a second, message-only pass");
      const marks2 = join(opts.workDir, "marks-2");
      const second = await runPass({
        info,
        marksFile: marks2,
        pass: 1,
        matchPath: () => false,
        pruneEmpty: false,
        baseMessageFilter,
        remapper,
        candidates: new Set(),
        log,
      });
      passes = 2;
      remappedMessages = second.stats.rewrittenMessages;
      const second_ = new Map<string, string>();
      for (const [mark, oid] of second.stats.markToOid) {
        const sha = second.markToSha.get(mark);
        if (sha) second_.set(oid, sha);
      }
      const composed = new Map<string, string>();
      for (const [old, mid] of commitMap) composed.set(old, second_.get(mid) ?? mid);
      commitMap = composed;
      // Commits pruned in pass 1 do not exist in the intermediate repository,
      // so they stay pruned — pass 2 cannot resurrect them.
    }
  }

  await writeFile(join(opts.workDir, "commit-map"), renderCommitMap(commitMap, pruned));

  return {
    stats: first.stats,
    commitMap,
    pruned,
    passes,
    remappedMessages,
    warnings,
  };
}

function renderCommitMap(map: Map<string, string>, pruned: Set<string>): string {
  const lines = ["old\tnew"];
  const keys = [...new Set([...map.keys(), ...pruned])].sort();
  for (const k of keys) lines.push(`${k}\t${map.get(k) ?? ZERO}`);
  return lines.join("\n") + "\n";
}