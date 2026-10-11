/**
 * Read-only detection of Claude Code artifacts.
 *
 * Independent probes, cheapest first:
 *   1. working tree  – filesystem walk
 *   2. .gitignore    – ignore rules Claude Code appends on its own
 *   3. history paths – one `git rev-list --objects --all` pass
 *   4. history msgs  – one `git log --all` pass over commit messages
 *
 * Nothing here mutates the repository.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  DEFAULT_MESSAGE_RULES,
  DEFAULT_RULES,
  SECRET_PATTERNS,
  compileRule,
  type CompiledRule,
  type MessageRule,
} from "./rules.ts";
import { git, type RepoInfo } from "./git.ts";

export type Scope = "worktree" | "history" | "message" | "gitignore" | "secret";

export interface Finding {
  scope: Scope;
  ruleId: string;
  label: string;
  path?: string;
  /** First commit that introduced the path / the commit carrying the trailer. */
  introducedIn?: string;
  excerpt?: string;
}

export interface ScanReport {
  repo: {
    root: string;
    head: string | null;
    branch: string | null;
    shallow: boolean;
  };
  activeRules: CompiledRule[];
  messageRules: MessageRule[];
  findings: Finding[];
  /** Unique artifact paths seen anywhere (worktree or history). */
  paths: string[];
  counts: Record<Scope, number>;
  hasSecrets: boolean;
  durationMs: number;
}

export interface ScanOptions {
  /** Rule ids to keep. Defaults to every non-`extra` rule. */
  include?: string[];
  /** Rule ids to drop. */
  exclude?: string[];
  /** Extra path specs (`dir:`/`file:`/`glob:`/`regex:`/bare path). */
  extraSpecs?: string[];
  /** Also look at reflog-only objects (slower, more thorough). */
  includeReflog?: boolean;
  /** Skip history probes entirely (working tree only). */
  worktreeOnly?: boolean;
  /** Inspect `.mcp.json` / `settings*.json` for credentials. */
  secrets?: boolean;
  /** Scan commit messages for Claude trailers. Default true. */
  messages?: boolean;
  /** Use the much cheaper `rev-list --objects` path inventory (may miss paths
   *  whose blob content is shared with another artifact). */
  fast?: boolean;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".gradle",
  "target",
]);

export function resolveRules(opts: ScanOptions = {}): CompiledRule[] {
  const include = new Set(opts.include ?? []);
  const exclude = new Set(opts.exclude ?? []);
  const all: CompiledRule[] = DEFAULT_RULES.map(compileRule);

  for (const spec of opts.extraSpecs ?? []) {
    const kind = /^(dir|file|glob|regex):/.exec(spec)?.[1] as
      | "dir"
      | "file"
      | "glob"
      | "regex"
      | undefined;
    const pattern = kind ? spec.slice(kind.length + 1) : spec;
    all.push(
      compileRule({
        id: `user:${spec}`,
        kind: kind ?? "regex",
        pattern,
        label: spec,
        reason: "user supplied",
        severity: "core",
      }),
    );
  }

  return all.filter((r) => {
    if (exclude.has(r.id)) return false;
    if (include.size > 0) return include.has(r.id);
    return r.severity !== "extra";
  });
}

export function makePathMatcher(rules: CompiledRule[]) {
  return (path: string): CompiledRule | undefined => rules.find((r) => r.test(path));
}

async function walkWorkTree(
  root: string,
  maxDepth: number,
  visit: (rel: string, isDir: boolean) => void,
): Promise<void> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      if (e.isDirectory()) {
        visit(rel, true);
        if (depth + 1 < maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() || e.isSymbolicLink()) {
        visit(rel, false);
      }
    }
  }
}

export async function scan(info: RepoInfo, opts: ScanOptions = {}): Promise<ScanReport> {
  const started = Date.now();
  const rules = resolveRules(opts);
  const match = makePathMatcher(rules);
  const findings: Finding[] = [];
  const pathSet = new Set<string>();
  const messageRules = DEFAULT_MESSAGE_RULES;

  const push = (f: Finding) => {
    findings.push(f);
    if (f.path) pathSet.add(f.path);
  };

  // ---------------------------------------------------------------- worktree
  await walkWorkTree(info.root, 8, (rel) => {
    const rule = match(rel);
    if (rule) push({ scope: "worktree", ruleId: rule.id, label: rule.label, path: rel });
  });

  if (info.shallow) {
    findings.push({
      scope: "history",
      ruleId: "shallow-clone",
      label: "shallow clone — history scan is incomplete",
      excerpt: "run `git fetch --unshallow` for a complete audit",
    });
  }

  // --------------------------------------------------------------- gitignore
  for (const gi of [".gitignore", ".git/info/exclude"]) {
    let text: string;
    try {
      text = await readFile(join(info.root, gi), "utf8");
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const bare = t.replace(/^[/!]+/, "").replace(/^\*\*\//, "");
      if (/\.claude|claude\.md|\.mcp\.json/i.test(bare)) {
        push({
          scope: "gitignore",
          ruleId: "gitignore-entry",
          label: `${gi}:${i + 1}`,
          excerpt: t,
        });
      }
    });
  }

  if (opts.worktreeOnly) {
    return finish(started, info, rules, messageRules, findings, pathSet);
  }

  // ------------------------------------------------------------ history paths
  // Every path that has ever existed, on any ref. `rev-list --objects` is much
  // faster but deduplicates identical blobs, so a path whose content matches
  // another artifact (e.g. two files both containing `{}`) can be missed; the
  // log-based walk below is authoritative.
  const historyPaths = new Set<string>();

  if (opts.fast) {
    const revArgs = ["rev-list", "--objects", "--all"];
    if (opts.includeReflog) revArgs.push("--reflog");
    const rev = await git(revArgs, info.root);
    if (rev.code === 0) {
      for (const line of rev.stdout.split("\n")) {
        const sp = line.indexOf(" ");
        if (sp < 0) continue;
        const p = line.slice(sp + 1);
        if (p) historyPaths.add(p);
      }
    }
  } else {
    const logArgs = [
      "log",
      "--all",
      "--name-only",
      "--no-renames",
      "--diff-filter=ADMR",
      "--pretty=format:%x00",
      "--no-color",
    ];
    if (opts.includeReflog) logArgs.push("--reflog");
    const logRun = await git(logArgs, info.root);
    if (logRun.code === 0) {
      // `--pretty=format:%x00` emits a bare NUL per commit as the separator, so
      // the stream is `\0\npath\npath\n\0\npath…`. Splitting on `\n` alone
      // leaves that sentinel as a "path" line, and a user rule broad enough to
      // match it (`--path regex:.`) made us hand the NUL to `git log -- …`,
      // where Node rejects it: `must be a string without null bytes`. Cut the
      // stream on the sentinel first, then take whole lines from each record.
      for (const record of logRun.stdout.split("\0")) {
        for (const line of record.split("\n")) {
          const p = line.trim();
          if (p) historyPaths.add(p);
        }
      }
    }
  }

  for (const p of historyPaths) {
    const rule = match(p);
    if (rule) push({ scope: "history", ruleId: rule.id, label: rule.label, path: p });
  }

  // ------------------------------------------------------------ history msgs
  if (opts.messages !== false) {
    const raw = await git(["log", "--all", "--format=%H%x1f%B%x1e", "--no-color"], info.root);
    if (raw.code === 0) {
      const seen = new Set<string>();
      for (const chunk of raw.stdout.split("\u001e")) {
        const rec = chunk.replace(/^\n+/, "");
        if (!rec) continue;
        const sepIdx = rec.indexOf("\u001f");
        if (sepIdx < 0) continue;
        const oid = rec.slice(0, sepIdx).trim();
        const msg = rec.slice(sepIdx + 1);
        for (const mr of messageRules) {
          mr.regex.lastIndex = 0;
          const hit = mr.regex.exec(msg);
          if (!hit) continue;
          const key = oid + "|" + mr.id;
          if (seen.has(key)) continue;
          seen.add(key);
          push({
            scope: "message",
            ruleId: mr.id,
            label: mr.label,
            introducedIn: oid,
            excerpt: hit[0].trim().slice(0, 120),
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------ secrets
  if (opts.secrets) {
    const candidates = [...pathSet].filter((p) =>
      /(^|\/)(\.mcp\.json|settings(\.local)?\.json)$/i.test(p),
    );
    for (const p of candidates) {
      const shown = await showAtHead(info, p);
      if (shown === null) continue;
      for (const sp of SECRET_PATTERNS) {
        sp.regex.lastIndex = 0;
        const m = sp.regex.exec(shown);
        if (!m) continue;
        push({
          scope: "secret",
          ruleId: sp.id,
          label: sp.label,
          path: p,
          excerpt: redact(m[0]),
        });
      }
    }
  }

  // Attribute an introducing commit to each matched history path. Only a
  // handful of paths match, so this stays cheap.
  for (const f of findings) {
    if (f.scope !== "history" || !f.path || f.introducedIn) continue;
    const r = await git(
      ["log", "--all", "--diff-filter=A", "--format=%H", "-1", "--", f.path],
      info.root,
    );
    if (r.code === 0 && r.stdout.trim()) f.introducedIn = r.stdout.trim().split("\n")[0]!;
  }

  return finish(started, info, rules, messageRules, findings, pathSet);
}

function redact(s: string): string {
  if (s.length <= 12) return `${s.slice(0, 4)}…`;
  return `${s.slice(0, 8)}…${s.slice(-2)}`;
}

async function showAtHead(info: RepoInfo, path: string): Promise<string | null> {
  const r = await git(["show", `HEAD:${path}`], info.root);
  if (r.code !== 0) return null;
  if (r.stdout.includes("\u0000")) return null; // binary-ish / huge
  return r.stdout;
}

function finish(
  started: number,
  info: RepoInfo,
  rules: CompiledRule[],
  messageRules: readonly MessageRule[],
  findings: Finding[],
  pathSet: Set<string>,
): ScanReport {
  const counts: Record<Scope, number> = {
    worktree: 0,
    history: 0,
    message: 0,
    gitignore: 0,
    secret: 0,
  };
  for (const f of findings) counts[f.scope]++;
  return {
    repo: { root: info.root, head: info.head, branch: info.branch, shallow: info.shallow },
    activeRules: rules,
    messageRules: [...messageRules],
    findings,
    paths: [...pathSet].sort(),
    counts,
    hasSecrets: counts.secret > 0,
    durationMs: Date.now() - started,
  };
}