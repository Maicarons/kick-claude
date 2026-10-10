#!/usr/bin/env node

// src/cli.ts
import { parseArgs } from "node:util";

// src/git.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

class GitError extends Error {
  args;
  code;
  stderr;
  constructor(message, args, code, stderr) {
    super(message);
    this.args = args;
    this.code = code;
    this.stderr = stderr;
    this.name = "GitError";
  }
}
function baseEnv() {
  return {
    ...process.env,
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C"
  };
}
function spawnGit(args, options = {}) {
  return spawn("git", args, {
    cwd: options.cwd,
    env: baseEnv(),
    windowsHide: true,
    shell: false
  });
}
async function git(args, cwd) {
  return new Promise((res, rej) => {
    const child = spawnGit(args, { cwd });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", rej);
    child.on("close", (code) => res({
      code: code ?? -1,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8")
    }));
  });
}
async function gitOrThrow(args, cwd) {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed (${r.code})`, args, r.code, r.stderr.trim());
  }
  return r.stdout;
}
async function repoRoot(cwd = process.cwd()) {
  const r = await git(["rev-parse", "--show-toplevel"], cwd);
  if (r.code !== 0) {
    throw new GitError("not inside a git repository (or the repository has no worktree)", ["rev-parse", "--show-toplevel"], r.code, r.stderr.trim());
  }
  return r.stdout.trim();
}
async function repoInfo(cwd = process.cwd()) {
  const root = await repoRoot(cwd);
  const [gitDir, bare, head, branch, shallow, remotesRaw] = await Promise.all([
    git(["rev-parse", "--absolute-git-dir"], root),
    git(["rev-parse", "--is-bare-repository"], root),
    git(["rev-parse", "HEAD"], root),
    git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    git(["rev-parse", "--is-shallow-repository"], root),
    git(["remote", "-v"], root)
  ]);
  const remotes = {};
  for (const line of remotesRaw.stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (m && m[3] === "fetch")
      remotes[m[1]] = m[2];
  }
  return {
    root,
    gitDir: gitDir.stdout.trim(),
    bare: bare.stdout.trim() === "true",
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 && branch.stdout.trim() !== "HEAD" ? branch.stdout.trim() : null,
    shallow: shallow.stdout.trim() === "true",
    remotes
  };
}
var IN_PROGRESS_MARKERS = [
  ["rebase-merge", "rebase in progress"],
  ["rebase-apply", "rebase in progress"],
  ["MERGE_HEAD", "merge in progress"],
  ["CHERRY_PICK_HEAD", "cherry-pick in progress"],
  ["REVERT_HEAD", "revert in progress"],
  ["BISECT_LOG", "bisect in progress"]
];
async function repoState(info) {
  const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"], info.root);
  const lines = status.stdout.split(`
`).filter(Boolean);
  let untracked = 0;
  let dirty = false;
  for (const l of lines) {
    if (l.startsWith("??"))
      untracked++;
    else
      dirty = true;
  }
  const inProgress = [];
  for (const [marker, label] of IN_PROGRESS_MARKERS) {
    if (existsSync(join(info.gitDir, marker)))
      inProgress.push(label);
  }
  return { dirty: dirty || untracked > 0, inProgress, untracked };
}
async function listRefs(info) {
  const out = await gitOrThrow(["for-each-ref", "--format=%(refname)%09%(objectname)"], info.root);
  const map = new Map;
  for (const line of out.split(/\r?\n/)) {
    if (!line)
      continue;
    const [ref, oid] = line.split("\t");
    if (ref && oid)
      map.set(ref, oid);
  }
  return map;
}
async function commitCount(info) {
  const r = await git(["rev-list", "--all", "--count"], info.root);
  return r.code === 0 ? Number(r.stdout.trim() || "0") : 0;
}
async function hasFilterRepo(info) {
  const sub = await git(["filter-repo", "--version"], info.root);
  if (sub.code === 0) {
    return { available: true, via: "subcommand", version: sub.stdout.trim() };
  }
  const which = await new Promise((res) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, ["git-filter-repo"], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (c) => out += c);
    child.on("error", () => res(null));
    child.on("close", (code) => res(code === 0 ? out.split(/\r?\n/)[0].trim() : null));
  });
  if (which) {
    const v = await git(["filter-repo", "--version"], info.root);
    return { available: true, via: "PATH", version: v.code === 0 ? v.stdout.trim() : null };
  }
  return { available: false, via: null, version: null };
}

// src/detect.ts
import { readFile, readdir } from "node:fs/promises";
import { join as join2, relative, sep } from "node:path";

// src/rules.ts
var DEFAULT_RULES = [
  {
    id: "claude-dir",
    kind: "dir",
    pattern: ".claude",
    label: ".claude/ directory",
    reason: "Project-scoped Claude Code configuration: settings, rules, commands, agents, skills, hooks, plugins.",
    severity: "core"
  },
  {
    id: "claude-md",
    kind: "file",
    pattern: "CLAUDE.md",
    label: "CLAUDE.md",
    reason: "Project memory / instruction file read by Claude Code at session start (also in sub-directories).",
    severity: "core"
  },
  {
    id: "claude-local-md",
    kind: "file",
    pattern: "CLAUDE.local.md",
    label: "CLAUDE.local.md",
    reason: "Personal, machine-local Claude Code memory; explicitly documented as “do not commit”.",
    severity: "core"
  },
  {
    id: "claude-home-json",
    kind: "file",
    pattern: ".claude.json",
    label: ".claude.json",
    reason: "User-level Claude Code state (sessions, OAuth, per-project state). Must never be committed.",
    severity: "secret"
  },
  {
    id: "mcp-json",
    kind: "file",
    pattern: ".mcp.json",
    label: ".mcp.json",
    reason: "Project MCP server definitions; frequently contains API keys in `env`.",
    severity: "secret"
  },
  {
    id: "anthropic-rules",
    kind: "dir",
    pattern: ".anthropic",
    label: ".anthropic/ directory",
    reason: "Anthropic tooling scratch space (skills/plugins caches) occasionally committed by mistake.",
    severity: "extra"
  }
];
var DEFAULT_ENABLED = DEFAULT_RULES.filter((r) => r.severity !== "extra").map((r) => r.id);
var cache = new Map;
function globToRegExp(glob) {
  let out = "";
  for (let i = 0;i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$");
}
function compileRule(rule) {
  const hit = cache.get(rule.id);
  if (hit)
    return hit;
  let regex;
  let test;
  switch (rule.kind) {
    case "dir": {
      const seg = rule.pattern.toLowerCase();
      regex = new RegExp(`(^|/)${seg}(/|$)`, "i");
      test = (p) => regex.test(p);
      break;
    }
    case "file": {
      const base = rule.pattern.toLowerCase();
      regex = new RegExp(`(^|/)${escapeRe(base)}$`, "i");
      test = (p) => regex.test(p);
      break;
    }
    case "glob":
      regex = globToRegExp(rule.pattern);
      test = (p) => regex.test(p);
      break;
    case "regex":
      regex = new RegExp(rule.pattern);
      test = (p) => regex.test(p);
      break;
  }
  const compiled = { ...rule, regex, test };
  cache.set(rule.id, compiled);
  return compiled;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var DEFAULT_MESSAGE_RULES = [
  {
    id: "coauthored-by-claude",
    label: "Co-Authored-By: Claude … trailer",
    regex: /^[ \t]*Co-Authored-By:[ \t]*Claude[^\n]*\n?/gim
  },
  {
    id: "generated-with-claude-code",
    label: "“Generated with Claude Code” footer",
    regex: /^[ \t]*(?:🤖[ \t]*)?Generated with[ \t]+\[?Claude Code\]?[^\n]*\n?/gim
  },
  {
    id: "written-by-claude",
    label: "“Written by Claude” footer",
    regex: /^[ \t]*(?:🤖[ \t]*)?(?:Written|Created|Generated) by Claude[^\n]*\n?/gim
  }
];
var SECRET_PATTERNS = [
  { id: "anthropic-key", label: "Anthropic API key", regex: /sk-ant-[A-Za-z0-9_\-]{16,}/ },
  { id: "openai-key", label: "OpenAI-style API key", regex: /sk-(?:proj-)?[A-Za-z0-9_\-]{24,}/ },
  {
    id: "generic-json-secret",
    label: "credential-looking JSON value",
    regex: /"(?:api[_-]?key|apikey|token|secret|password|passwd|authorization)"\s*:\s*"(?!\$\{)([^"\\\n]{8,})"/gi
  },
  {
    id: "bearer-token",
    label: "Bearer token",
    regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/g
  }
];

// src/detect.ts
var SKIP_DIRS = new Set([
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
  "target"
]);
function resolveRules(opts = {}) {
  const include = new Set(opts.include ?? []);
  const exclude = new Set(opts.exclude ?? []);
  const all = DEFAULT_RULES.map(compileRule);
  for (const spec of opts.extraSpecs ?? []) {
    const kind = /^(dir|file|glob|regex):/.exec(spec)?.[1];
    const pattern = kind ? spec.slice(kind.length + 1) : spec;
    all.push(compileRule({
      id: `user:${spec}`,
      kind: kind ?? "regex",
      pattern,
      label: spec,
      reason: "user supplied",
      severity: "core"
    }));
  }
  return all.filter((r) => {
    if (exclude.has(r.id))
      return false;
    if (include.size > 0)
      return include.has(r.id);
    return r.severity !== "extra";
  });
}
function makePathMatcher(rules) {
  return (path) => rules.find((r) => r.test(path));
}
async function walkWorkTree(root, maxDepth, visit) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name))
        continue;
      const full = join2(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      if (e.isDirectory()) {
        visit(rel, true);
        if (depth + 1 < maxDepth)
          queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() || e.isSymbolicLink()) {
        visit(rel, false);
      }
    }
  }
}
async function scan(info, opts = {}) {
  const started = Date.now();
  const rules = resolveRules(opts);
  const match = makePathMatcher(rules);
  const findings = [];
  const pathSet = new Set;
  const messageRules = DEFAULT_MESSAGE_RULES;
  const push = (f) => {
    findings.push(f);
    if (f.path)
      pathSet.add(f.path);
  };
  await walkWorkTree(info.root, 8, (rel) => {
    const rule = match(rel);
    if (rule)
      push({ scope: "worktree", ruleId: rule.id, label: rule.label, path: rel });
  });
  if (info.shallow) {
    findings.push({
      scope: "history",
      ruleId: "shallow-clone",
      label: "shallow clone — history scan is incomplete",
      excerpt: "run `git fetch --unshallow` for a complete audit"
    });
  }
  for (const gi of [".gitignore", ".git/info/exclude"]) {
    let text;
    try {
      text = await readFile(join2(info.root, gi), "utf8");
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith("#"))
        return;
      const bare = t.replace(/^[/!]+/, "").replace(/^\*\*\//, "");
      if (/\.claude|claude\.md|\.mcp\.json/i.test(bare)) {
        push({
          scope: "gitignore",
          ruleId: "gitignore-entry",
          label: `${gi}:${i + 1}`,
          excerpt: t
        });
      }
    });
  }
  if (opts.worktreeOnly) {
    return finish(started, info, rules, messageRules, findings, pathSet);
  }
  const historyPaths = new Set;
  if (opts.fast) {
    const revArgs = ["rev-list", "--objects", "--all"];
    if (opts.includeReflog)
      revArgs.push("--reflog");
    const rev = await git(revArgs, info.root);
    if (rev.code === 0) {
      for (const line of rev.stdout.split(`
`)) {
        const sp = line.indexOf(" ");
        if (sp < 0)
          continue;
        const p = line.slice(sp + 1);
        if (p)
          historyPaths.add(p);
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
      "--no-color"
    ];
    if (opts.includeReflog)
      logArgs.push("--reflog");
    const logRun = await git(logArgs, info.root);
    if (logRun.code === 0) {
      for (const line of logRun.stdout.split(`
`)) {
        const p = line.trim();
        if (p)
          historyPaths.add(p);
      }
    }
  }
  for (const p of historyPaths) {
    const rule = match(p);
    if (rule)
      push({ scope: "history", ruleId: rule.id, label: rule.label, path: p });
  }
  if (opts.messages !== false) {
    const raw = await git(["log", "--all", "--format=%H%x1f%B%x1e", "--no-color"], info.root);
    if (raw.code === 0) {
      const seen = new Set;
      for (const chunk of raw.stdout.split("\x1E")) {
        const rec = chunk.replace(/^\n+/, "");
        if (!rec)
          continue;
        const sepIdx = rec.indexOf("\x1F");
        if (sepIdx < 0)
          continue;
        const oid = rec.slice(0, sepIdx).trim();
        const msg = rec.slice(sepIdx + 1);
        for (const mr of messageRules) {
          mr.regex.lastIndex = 0;
          const hit = mr.regex.exec(msg);
          if (!hit)
            continue;
          const key = oid + "|" + mr.id;
          if (seen.has(key))
            continue;
          seen.add(key);
          push({
            scope: "message",
            ruleId: mr.id,
            label: mr.label,
            introducedIn: oid,
            excerpt: hit[0].trim().slice(0, 120)
          });
        }
      }
    }
  }
  if (opts.secrets) {
    const candidates = [...pathSet].filter((p) => /(^|\/)(\.mcp\.json|settings(\.local)?\.json)$/i.test(p));
    for (const p of candidates) {
      const shown = await showAtHead(info, p);
      if (shown === null)
        continue;
      for (const sp of SECRET_PATTERNS) {
        sp.regex.lastIndex = 0;
        const m = sp.regex.exec(shown);
        if (!m)
          continue;
        push({
          scope: "secret",
          ruleId: sp.id,
          label: sp.label,
          path: p,
          excerpt: redact(m[0])
        });
      }
    }
  }
  for (const f of findings) {
    if (f.scope !== "history" || !f.path || f.introducedIn)
      continue;
    const r = await git(["log", "--all", "--diff-filter=A", "--format=%H", "-1", "--", f.path], info.root);
    if (r.code === 0 && r.stdout.trim())
      f.introducedIn = r.stdout.trim().split(`
`)[0];
  }
  return finish(started, info, rules, messageRules, findings, pathSet);
}
function redact(s) {
  if (s.length <= 12)
    return `${s.slice(0, 4)}…`;
  return `${s.slice(0, 8)}…${s.slice(-2)}`;
}
async function showAtHead(info, path) {
  const r = await git(["show", `HEAD:${path}`], info.root);
  if (r.code !== 0)
    return null;
  if (r.stdout.includes("\x00"))
    return null;
  return r.stdout;
}
function finish(started, info, rules, messageRules, findings, pathSet) {
  const counts = {
    worktree: 0,
    history: 0,
    message: 0,
    gitignore: 0,
    secret: 0
  };
  for (const f of findings)
    counts[f.scope]++;
  return {
    repo: { root: info.root, head: info.head, branch: info.branch, shallow: info.shallow },
    activeRules: rules,
    messageRules: [...messageRules],
    findings,
    paths: [...pathSet].sort(),
    counts,
    hasSecrets: counts.secret > 0,
    durationMs: Date.now() - started
  };
}

// src/worktree.ts
import { readFile as readFile2, rm, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";
var BLOCK_START = "# >>> kick-claude";
var BLOCK_END = "# <<< kick-claude";
function ignoreBlockLines() {
  return [
    BLOCK_START,
    "# Added by kick-claude — Claude Code collaboration files",
    ".claude/",
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".mcp.json",
    ".claude.json",
    BLOCK_END
  ];
}
async function readGitignore(info) {
  try {
    return await readFile2(join3(info.root, ".gitignore"), "utf8");
  } catch {
    return null;
  }
}
async function updateGitignore(info) {
  const current = await readGitignore(info);
  const block = ignoreBlockLines();
  if (current === null) {
    await writeFile(join3(info.root, ".gitignore"), block.join(`
`) + `
`, "utf8");
    return block.slice(2, -1);
  }
  let lines = current.split(/\r?\n/);
  const start = lines.indexOf(BLOCK_START);
  const end = lines.indexOf(BLOCK_END);
  if (start >= 0 && end > start) {
    lines = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
  } else {
    if (lines.length && lines[lines.length - 1] !== "")
      lines.push("");
    lines.push(...block);
  }
  const next = lines.join(`
`).replace(/\n{3,}/g, `

`).replace(/\n+$/, `
`);
  if (next !== current)
    await writeFile(join3(info.root, ".gitignore"), next, "utf8");
  return block.slice(2, -1);
}
async function removeIgnoreBlock(info) {
  const current = await readGitignore(info);
  if (current === null)
    return [];
  const lines = current.split(/\r?\n/);
  const start = lines.indexOf(BLOCK_START);
  const end = lines.indexOf(BLOCK_END);
  if (start < 0 || end <= start)
    return [];
  const removed = lines.slice(start + 2, end).filter((l) => l.trim());
  const next = [...lines.slice(0, start), ...lines.slice(end + 1)].join(`
`).replace(/\n{3,}/g, `

`);
  await writeFile(join3(info.root, ".gitignore"), next, "utf8");
  return removed;
}
async function cleanWorktree(info, opts) {
  const tracked = new Set((await git(["ls-files", "-z"], info.root)).stdout.split("\x00").filter(Boolean));
  const isTarget = (p) => opts.rules.some((r) => r.test(p));
  const targets = [...new Set(opts.paths.filter(isTarget))].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  const removed = [];
  const skipped = [];
  for (const rel of targets) {
    try {
      if (!opts.dryRun)
        await rm(join3(info.root, rel), { recursive: true, force: true });
      removed.push(rel);
    } catch (e) {
      const code = e.code;
      if (code === "ENOENT")
        continue;
      skipped.push(rel);
    }
  }
  let gitignoreAdded = [];
  if (opts.gitignore && !opts.dryRun)
    gitignoreAdded = await updateGitignore(info);
  let staged = false;
  if (opts.stage && !opts.dryRun && removed.some((p) => tracked.has(p))) {
    const args = ["rm", "-r", "--cached", "--ignore-unmatch", "--quiet"];
    for (const rel of removed) {
      if (tracked.has(rel))
        args.push("--", rel);
    }
    const r = await git(args, info.root);
    staged = r.code === 0;
  }
  return { removed, skipped, gitignoreAdded, staged };
}

// src/purge/native.ts
import { spawn as spawn2 } from "node:child_process";
import { mkdir, readFile as readFile3, writeFile as writeFile2 } from "node:fs/promises";
import { join as join4 } from "node:path";

// src/purge/stream.ts
var COMMAND_RE = /^(commit|reset|tag|blob|done|checkpoint|progress|feature|option)\b/;
var HASH_TOKEN_RE = /\b[0-9a-f]{7,40}\b/g;
var NEEDS_QUOTING = /[\s"\\]/;
function unquotePath(p) {
  if (!p.startsWith('"'))
    return p;
  const bytes = [];
  const pushUtf8 = (s) => {
    for (const b of Buffer.from(s, "utf8"))
      bytes.push(b);
  };
  let i = 1;
  while (i < p.length) {
    const c = p[i];
    if (c === '"')
      break;
    if (c !== "\\") {
      pushUtf8(c);
      i++;
      continue;
    }
    const n = p[++i];
    if (n === undefined)
      break;
    if (n >= "0" && n <= "7") {
      const oct = /^[0-7]{1,3}/.exec(p.slice(i, i + 3));
      if (oct) {
        bytes.push(parseInt(oct[0], 8) & 255);
        i += oct[0].length;
        continue;
      }
    }
    switch (n) {
      case "n":
        pushUtf8(`
`);
        break;
      case "t":
        pushUtf8("\t");
        break;
      case "r":
        pushUtf8("\r");
        break;
      case "a":
        pushUtf8("\x07");
        break;
      case "b":
        pushUtf8("\b");
        break;
      case "f":
        pushUtf8("\f");
        break;
      case "v":
        pushUtf8("\v");
        break;
      default:
        pushUtf8(n);
    }
    i++;
  }
  return Buffer.from(bytes).toString("utf8");
}
function quotePath(p) {
  if (!NEEDS_QUOTING.test(p) && !Array.from(p).some((ch) => (ch.codePointAt(0) ?? 0) < 32)) {
    return p;
  }
  return '"' + p.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
}

class FastExportFilter {
  input;
  output;
  opts;
  buf = Buffer.alloc(0);
  eof = false;
  pushback = null;
  chunks;
  resolved = new Map;
  refsWithPrunedTips = new Map;
  refsWithSurvivingCommits = new Set;
  deletedRefs = new Set;
  stats = {
    commits: 0,
    prunedCommits: 0,
    removedFileChanges: 0,
    rewrittenMessages: 0,
    droppedTags: 0,
    droppedResets: 0,
    droppedRefs: 0,
    hashCandidates: new Set,
    markToOid: new Map,
    marks: new Set,
    prunedMarks: new Set,
    commits_: []
  };
  constructor(input, output, opts) {
    this.input = input;
    this.output = output;
    this.opts = opts;
    this.chunks = input[Symbol.asyncIterator]();
  }
  get result() {
    return this.stats;
  }
  async run() {
    for (;; ) {
      const line = await this.nextLine();
      if (line === null)
        break;
      if (line === "")
        continue;
      if (line.startsWith("commit ")) {
        await this.handleCommit(line);
        continue;
      }
      if (line.startsWith("reset ")) {
        await this.handleReset(line);
        continue;
      }
      if (line.startsWith("tag ")) {
        await this.handleTag(line);
        continue;
      }
      if (line === "blob" || line.startsWith("blob ")) {
        await this.copyBlob();
        continue;
      }
      if (line === "done")
        continue;
      await this.write(line + `
`);
    }
    for (const [ref, info] of this.refsWithPrunedTips) {
      if (!info.pruned || this.refsWithSurvivingCommits.has(ref))
        continue;
      if (this.deletedRefs.has(ref))
        continue;
      this.deletedRefs.add(ref);
      if (info.fallback !== "") {
        await this.write(`reset ${quotePath(ref)}
from ${quotePath(info.fallback)}
`);
      } else {
        await this.write(`reset ${quotePath(ref)}
`);
        this.stats.droppedRefs++;
      }
    }
    await this.write(`done
`);
    return this.stats;
  }
  async handleCommit(header) {
    const ref = header.slice("commit ".length).trim();
    const filecmds = [];
    const preamble = [];
    const passthrough = [];
    const parents = [];
    let mark = 0;
    let oid = "";
    let message = null;
    for (;; ) {
      const line = await this.nextLine();
      if (line === null)
        break;
      if (line === "")
        continue;
      if (COMMAND_RE.test(line)) {
        this.pushback = line;
        break;
      }
      if (line.startsWith("mark :")) {
        mark = Number(line.slice(6).trim());
        continue;
      }
      if (line.startsWith("original-oid ")) {
        oid = line.slice(13).trim();
        continue;
      }
      if (line.startsWith("author ") || line.startsWith("committer ")) {
        preamble.push(line);
        continue;
      }
      if (line.startsWith("from ")) {
        parents.push(line.slice(5).trim());
        continue;
      }
      if (line.startsWith("merge ")) {
        parents.push(line.slice(6).trim());
        continue;
      }
      if (line === "deleteall") {
        filecmds.push({ type: "deleteall", path: "", raw: line });
        continue;
      }
      if (line.startsWith("M ")) {
        const sp1 = line.indexOf(" ", 2);
        const sp2 = sp1 < 0 ? -1 : line.indexOf(" ", sp1 + 1);
        const path = sp2 < 0 ? "" : unquotePath(line.slice(sp2 + 1));
        filecmds.push({ type: "M", path, raw: line });
        continue;
      }
      if (line.startsWith("D ")) {
        filecmds.push({ type: "D", path: unquotePath(line.slice(2).trim()), raw: line });
        continue;
      }
      if (line.startsWith("data ")) {
        message = await this.readExactly(Number(line.slice(5).trim() || "0"));
        continue;
      }
      passthrough.push(line);
    }
    this.stats.commits++;
    if (mark && oid)
      this.stats.markToOid.set(mark, oid);
    const kept = filecmds.filter((fc) => fc.type === "deleteall" || !this.opts.matchPath(fc.path));
    const removed = filecmds.length - kept.length;
    this.stats.removedFileChanges += removed;
    const resolvedParents = parents.map((p) => this.resolveRef(p));
    const survivingParents = resolvedParents.filter((p) => p !== "");
    const becomesEmpty = filecmds.length > 0 && kept.length === 0;
    const wouldOrphanBranch = survivingParents.length === 0;
    const prune = this.opts.pruneEmpty && becomesEmpty && !wouldOrphanBranch;
    this.refsWithPrunedTips.set(ref, { pruned: prune, fallback: resolvedParents[0] ?? "" });
    if (prune) {
      this.stats.prunedCommits++;
      if (mark)
        this.prunedMark(mark, survivingParents[0] ?? "");
      return;
    }
    this.refsWithSurvivingCommits.add(ref);
    if (mark) {
      this.resolved.set(mark, `:${mark}`);
      this.stats.marks.add(mark);
    }
    const { bytes: msgBytes, changed } = this.cleanMessage(message);
    this.stats.commits_.push({
      mark,
      oid,
      ref,
      pruned: false,
      fileChanges: kept.length,
      removedFileChanges: removed,
      messageChanged: changed
    });
    await this.write(`commit ${quotePath(ref)}
`);
    if (mark)
      await this.write(`mark :${mark}
`);
    if (oid)
      await this.write(`original-oid ${oid}
`);
    for (const l of preamble)
      await this.write(l + `
`);
    for (const l of passthrough)
      await this.write(l + `
`);
    await this.write(`data ${msgBytes.length}
`);
    await this.write(msgBytes);
    if (resolvedParents[0])
      await this.write(`from ${resolvedParents[0]}
`);
    for (const p of resolvedParents.slice(1)) {
      if (p)
        await this.write(`merge ${p}
`);
    }
    for (const fc of kept)
      await this.write(fc.raw + `
`);
  }
  async handleReset(header) {
    const ref = header.slice("reset ".length).trim();
    let from = null;
    for (;; ) {
      const line = await this.nextLine();
      if (line === null)
        break;
      if (line === "")
        continue;
      if (COMMAND_RE.test(line)) {
        this.pushback = line;
        break;
      }
      if (line.startsWith("from ")) {
        from = line.slice(5).trim();
        continue;
      }
      await this.write(line + `
`);
    }
    const resolved = from === null ? null : this.resolveRef(from);
    if (resolved === "") {
      this.stats.droppedResets++;
      this.warn(`ref ${ref} pointed only at removed commits — dropped`);
      return;
    }
    await this.write(`reset ${quotePath(ref)}
`);
    if (resolved)
      await this.write(`from ${resolved}
`);
  }
  async handleTag(header) {
    const name = header.slice("tag ".length).trim();
    const preamble = [];
    let from = null;
    let message = null;
    for (;; ) {
      const line = await this.nextLine();
      if (line === null)
        break;
      if (line === "")
        continue;
      if (COMMAND_RE.test(line)) {
        this.pushback = line;
        break;
      }
      if (line.startsWith("from ")) {
        from = line.slice(5).trim();
        continue;
      }
      if (line.startsWith("data ")) {
        message = await this.readExactly(Number(line.slice(5).trim() || "0"));
        continue;
      }
      preamble.push(line);
    }
    const resolved = from === null ? null : this.resolveRef(from);
    if (resolved === "") {
      this.stats.droppedTags++;
      this.warn(`tag ${name} pointed only at removed commits — dropped`);
      return;
    }
    const { bytes } = this.cleanMessage(message);
    await this.write(`tag ${quotePath(name)}
`);
    for (const l of preamble)
      await this.write(l + `
`);
    await this.write(`data ${bytes.length}
`);
    await this.write(bytes);
    if (resolved)
      await this.write(`from ${resolved}
`);
  }
  async copyBlob() {
    for (;; ) {
      const line = await this.nextLine();
      if (line === null)
        return;
      if (line === "")
        continue;
      if (COMMAND_RE.test(line)) {
        this.pushback = line;
        return;
      }
      await this.write(line + `
`);
      if (line.startsWith("data ")) {
        const n = Number(line.slice(5).trim() || "0");
        if (n > 0)
          await this.write(await this.readExactly(n));
      }
    }
  }
  prunedMark(mark, replacement) {
    this.resolved.set(mark, replacement);
    this.stats.prunedMarks.add(mark);
    this.stats.commits_.push({
      mark,
      oid: this.stats.markToOid.get(mark) ?? "",
      ref: "",
      pruned: true,
      fileChanges: 0,
      removedFileChanges: 0,
      messageChanged: false
    });
  }
  resolveRef(ref) {
    if (!ref.startsWith(":"))
      return ref;
    const mark = Number(ref.slice(1));
    if (!Number.isFinite(mark))
      return ref;
    const r = this.resolved.get(mark);
    return r === undefined ? ref : r;
  }
  cleanMessage(message) {
    if (message === null)
      return { bytes: Buffer.alloc(0), changed: false };
    const original = message;
    const text = message.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(message)) {
      return { bytes: original, changed: false };
    }
    for (const tok of text.match(HASH_TOKEN_RE) ?? []) {
      this.opts.onMessageHashCandidate?.(tok);
      if (this.stats.hashCandidates.size > 20000)
        break;
    }
    const cleaned = this.opts.filterMessage(text);
    if (cleaned === text)
      return { bytes: original, changed: false };
    let bytes = Buffer.from(cleaned, "utf8");
    if (bytes.length === 0)
      bytes = Buffer.from(`
`, "utf8");
    this.stats.rewrittenMessages++;
    return { bytes, changed: true };
  }
  warn(message) {
    this.opts.onWarn?.(message);
  }
  async write(chunk) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (!this.output.write(buf)) {
      await new Promise((resolve2) => this.output.once("drain", () => resolve2()));
    }
  }
  async nextLine() {
    if (this.pushback !== null) {
      const l = this.pushback;
      this.pushback = null;
      return l;
    }
    for (;; ) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString("utf8");
        this.buf = this.buf.subarray(i + 1);
        return line;
      }
      if (this.eof) {
        if (this.buf.length > 0) {
          const line = this.buf.toString("utf8");
          this.buf = Buffer.alloc(0);
          return line;
        }
        return null;
      }
      await this.fill();
    }
  }
  async readExactly(n) {
    while (this.buf.length < n) {
      if (this.eof)
        throw new Error(`unexpected EOF in fast-export stream (wanted ${n} bytes)`);
      await this.fill();
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async fill() {
    if (this.eof)
      return;
    const next = await this.chunks.next();
    if (next.done) {
      this.eof = true;
      return;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value, "utf8");
    if (chunk.length === 0)
      return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }
}
function defaultMessageFilter(message) {
  let m = message;
  m = m.replace(/^[ \t]*Co-Authored-By:[ \t]*Claude[^\n]*\n?/gim, "");
  m = m.replace(/^[ \t]*(?:\u{1F916}[ \t]*)?Generated with[ \t]+\[?Claude Code\]?[^\n]*\n?/gimu, "");
  m = m.replace(/^[ \t]*(?:\u{1F916}[ \t]*)?(?:Written|Created|Generated) by Claude[^\n]*\n?/gimu, "");
  m = m.replace(/\n{3,}/g, `

`);
  m = m.replace(/^\n+/, "").replace(/\n+$/, `
`);
  return m;
}

// src/purge/native.ts
var FAST_EXPORT_FLAGS = [
  "--no-data",
  "--show-original-ids",
  "--reference-excluded-parents",
  "--fake-missing-tagger",
  "--signed-tags=strip",
  "--tag-of-filtered-object=rewrite",
  "--use-done-feature",
  "--reencode=yes",
  "--mark-tags"
];

class HashRemapper {
  prefixes = new Map;
  full = new Map;
  constructor(map, pruned = new Set) {
    for (const [oldSha, newSha] of map) {
      this.full.set(oldSha, newSha);
      const max = Math.min(12, oldSha.length);
      for (let len = 7;len <= max; len++) {
        const key = oldSha.slice(0, len);
        this.prefixes.set(key, this.prefixes.has(key) ? "" : newSha);
      }
    }
    for (const oid of pruned) {
      const max = Math.min(12, oid.length);
      for (let len = 7;len <= max; len++)
        this.prefixes.set(oid.slice(0, len), "");
    }
  }
  knows(token) {
    if (token.length < 7)
      return false;
    return this.full.has(token) || this.prefixes.has(token);
  }
  replace(message) {
    return message.replace(/\b[0-9a-f]{7,40}\b/g, (tok) => {
      if (tok.length === 40) {
        const exact = this.full.get(tok);
        if (exact)
          return exact;
      }
      const hit = this.prefixes.get(tok);
      return hit && hit.length >= tok.length ? hit.slice(0, tok.length) : tok;
    });
  }
}
function runPass(args) {
  const { info, marksFile } = args;
  return new Promise((resolve2, reject) => {
    const exporter = spawn2("git", ["-c", "core.quotePath=false", "fast-export", ...FAST_EXPORT_FLAGS, "--all"], { cwd: info.root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const importer = spawn2("git", [
      "-c",
      "core.ignorecase=false",
      "fast-import",
      "--date-format=raw-permissive",
      "--force",
      "--quiet",
      `--export-marks=${marksFile}`
    ], { cwd: info.root, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    const errors = [];
    exporter.stderr.on("data", (c) => {
      const s = c.toString("utf8").trim();
      if (s)
        errors.push("fast-export: " + s);
    });
    importer.stderr.on("data", (c) => {
      const s = c.toString("utf8").trim();
      if (s)
        errors.push("fast-import: " + s);
    });
    let settled = false;
    const fail = (e) => {
      if (settled)
        return;
      settled = true;
      try {
        exporter.kill();
      } catch {}
      try {
        importer.kill();
      } catch {}
      reject(e);
    };
    exporter.on("error", fail);
    importer.on("error", fail);
    const filter = new FastExportFilter(exporter.stdout, importer.stdin, {
      matchPath: args.matchPath,
      filterMessage: (message) => {
        const base = args.baseMessageFilter(message);
        return args.remapper ? args.remapper.replace(base) : base;
      },
      pruneEmpty: args.pruneEmpty,
      onWarn: (m) => args.log("warning: " + m),
      onMessageHashCandidate: (h) => {
        if (args.candidates.size < 50000)
          args.candidates.add(h);
      }
    });
    const filterDone = filter.run();
    importer.on("close", async (code) => {
      if (settled)
        return;
      if (code !== 0) {
        fail(new Error(`git fast-import exited with code ${code}
${errors.join(`
`)}`));
        return;
      }
      try {
        await filterDone;
        const stats = filter.result;
        const markToSha = await readMarks(marksFile);
        settled = true;
        args.log(`pass ${args.pass + 1}: ${stats.commits} commits seen, ${stats.prunedCommits} pruned, ` + `${stats.removedFileChanges} file changes removed, ${stats.rewrittenMessages} messages rewritten` + (stats.droppedTags ? `, ${stats.droppedTags} tags dropped` : ""));
        resolve2({ stats, markToSha });
      } catch (e) {
        fail(e);
      }
    });
  });
}
async function readMarks(file) {
  const map = new Map;
  let text;
  try {
    text = await readFile3(file, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed)
      continue;
    const sp = trimmed.indexOf(" ");
    if (sp < 0)
      continue;
    const mark = Number(trimmed.slice(0, sp).replace(/^:/, ""));
    if (!Number.isFinite(mark))
      continue;
    map.set(mark, trimmed.slice(sp + 1).trim());
  }
  return map;
}
var ZERO = "0".repeat(40);
async function nativePurge(info, opts) {
  const log = opts.log ?? (() => {});
  const warnings = [];
  await mkdir(opts.workDir, { recursive: true });
  const baseMessageFilter = opts.filterMessage ?? defaultMessageFilter;
  const candidates = new Set;
  const marks1 = join4(opts.workDir, "marks-1");
  const first = await runPass({
    info,
    marksFile: marks1,
    pass: 0,
    matchPath: opts.matchPath,
    pruneEmpty: opts.pruneEmpty,
    baseMessageFilter,
    remapper: null,
    candidates,
    log
  });
  let commitMap = new Map;
  const pruned = new Set;
  for (const [mark, oid] of first.stats.markToOid) {
    const sha = first.markToSha.get(mark);
    if (sha)
      commitMap.set(oid, sha);
    else
      pruned.add(oid);
  }
  let passes = 1;
  let remappedMessages = 0;
  if (opts.remapHashes) {
    const remapper = new HashRemapper(commitMap, pruned);
    const needed = [...candidates].some((c) => remapper.knows(c));
    if (needed) {
      log("commit messages reference rewritten hashes — running a second, message-only pass");
      const marks2 = join4(opts.workDir, "marks-2");
      const second = await runPass({
        info,
        marksFile: marks2,
        pass: 1,
        matchPath: () => false,
        pruneEmpty: false,
        baseMessageFilter,
        remapper,
        candidates: new Set,
        log
      });
      passes = 2;
      remappedMessages = second.stats.rewrittenMessages;
      const second_ = new Map;
      for (const [mark, oid] of second.stats.markToOid) {
        const sha = second.markToSha.get(mark);
        if (sha)
          second_.set(oid, sha);
      }
      const composed = new Map;
      for (const [old, mid] of commitMap)
        composed.set(old, second_.get(mid) ?? mid);
      commitMap = composed;
    }
  }
  await writeFile2(join4(opts.workDir, "commit-map"), renderCommitMap(commitMap, pruned));
  return {
    stats: first.stats,
    commitMap,
    pruned,
    passes,
    remappedMessages,
    warnings
  };
}
function renderCommitMap(map, pruned) {
  const lines = ["old\tnew"];
  const keys = [...new Set([...map.keys(), ...pruned])].sort();
  for (const k of keys)
    lines.push(`${k}	${map.get(k) ?? ZERO}`);
  return lines.join(`
`) + `
`;
}

// src/purge/filterRepo.ts
import { mkdtemp, rm as rm2, writeFile as writeFile3 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join5 } from "node:path";
function rulesToPathSpecs(extraSpecs = []) {
  const specs = [
    "(^|/)\\.claude(/|$)",
    "(^|/)CLAUDE\\.md$",
    "(^|/)CLAUDE\\.local\\.md$",
    "(^|/)\\.claude\\.json$",
    "(^|/)\\.mcp\\.json$"
  ];
  for (const spec of extraSpecs) {
    if (/^(dir|file|glob):/.test(spec)) {
      const kind = spec.slice(0, spec.indexOf(":"));
      const pattern = spec.slice(spec.indexOf(":") + 1);
      if (kind === "dir")
        specs.push(`(^|/)${escapeRe2(pattern)}/?($|/)`);
      else if (kind === "file")
        specs.push(`(^|/)${escapeRe2(pattern)}$`);
      else
        specs.push(`(^|/)${escapeRe2(pattern).replace(/\*/g, "[^/]*")}$`);
    } else if (/^regex:/.test(spec)) {
      specs.push(spec.slice("regex:".length));
    } else {
      specs.push(`(^|/)${escapeRe2(spec.replace(/\/+$/, ""))}(/|$)`);
    }
  }
  return specs;
}
function escapeRe2(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function runFilterRepo(info, opts) {
  const dir = await mkdtemp(join5(tmpdir(), "kick-claude-"));
  try {
    const pathsFile = join5(dir, "paths.txt");
    await writeFile3(pathsFile, opts.pathSpecs.map((s) => `regex:${s}`).join(`
`) + `
`, "utf8");
    const args = ["filter-repo", "--invert-paths", "--paths-from-file", pathsFile];
    if (opts.force)
      args.push("--force");
    if (opts.partial)
      args.push("--partial");
    if (opts.messageReplacements?.length) {
      const msgFile = join5(dir, "messages.txt");
      const lines = [
        "regex:^[ \\t]*Co-Authored-By:[ \\t]*Claude[^\\n]*\\n?",
        "regex:^[ \\t]*(?:\\U0001F916[ \\t]*)?Generated with[ \\t]+\\[?Claude Code\\]?[^\\n]*\\n?",
        "regex:^[ \\t]*(?:\\U0001F916[ \\t]*)?(?:Written|Created|Generated) by Claude[^\\n]*\\n?",
        "==>"
      ];
      await writeFile3(msgFile, lines.join(`
`) + `
`, "utf8");
      args.push("--replace-message", msgFile);
    }
    const r = await git(args, info.root);
    return {
      ok: r.code === 0,
      command: `git ${args.map((a) => a.includes(" ") ? `"${a}"` : a).join(" ")}`,
      output: (r.stdout + r.stderr).trim()
    };
  } finally {
    await rm2(dir, { recursive: true, force: true });
  }
}
var KNOWN_ARTIFACT_PATTERNS = DEFAULT_RULES.map((r) => ({
  id: r.id,
  kind: r.kind,
  pattern: r.pattern,
  label: r.label
}));

// src/purge/backup.ts
import { mkdir as mkdir2, stat, writeFile as writeFile4 } from "node:fs/promises";
import { join as join6 } from "node:path";
function backupRoot(info, stamp) {
  return join6(info.gitDir, "kick-claude", stamp);
}
async function createBackup(info, stamp) {
  const dir = backupRoot(info, stamp);
  await mkdir2(dir, { recursive: true });
  const bundle = join6(dir, "history.bundle");
  await gitOrThrow(["bundle", "create", bundle, "--all"], info.root);
  await gitOrThrow(["bundle", "verify", bundle], info.root);
  const refs = Object.fromEntries(await listRefs(info));
  const refsFile = join6(dir, "refs.json");
  await writeFile4(refsFile, JSON.stringify(refs, null, 2) + `
`);
  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(bundle)).size;
  } catch {}
  return { dir, bundle, refsFile, createdAt: new Date().toISOString(), sizeBytes, refs };
}
function restoreHint(backup, info) {
  const target = join6(backup.dir, "restored");
  return [
    `git clone "${backup.bundle}" "${target}"`,
    `cd "${target}" && git remote add origin ${info.remotes.origin ?? "<your-remote-url>"}`,
    "git push --force --mirror origin"
  ];
}

// src/purge/verify.ts
import { createHash } from "node:crypto";
async function fingerprintRefs(info, isArtifact, refs) {
  const target = refs ?? (await gitOrThrow(["for-each-ref", "--format=%(refname)"], info.root)).split(/\r?\n/).filter(Boolean);
  const out = new Map;
  const errors = [];
  for (const ref of target) {
    const r = await git(["ls-tree", "-r", "--full-tree", "-z", ref], info.root);
    if (r.code !== 0) {
      errors.push(`${ref}: ${r.stderr.trim()}`);
      continue;
    }
    const hash = createHash("sha256");
    let count = 0;
    for (const rec of r.stdout.split("\x00")) {
      if (!rec)
        continue;
      const tab = rec.indexOf("\t");
      if (tab < 0)
        continue;
      const path = rec.slice(tab + 1);
      if (isArtifact(path))
        continue;
      hash.update(rec.slice(0, tab)).update("\t").update(path).update("\x00");
      count++;
    }
    out.set(ref, { ref, count, digest: hash.digest("hex").slice(0, 16) });
  }
  return { refs: out, errors };
}
async function verifyRewrite(info, before, commitsBefore, isArtifact) {
  const fsckRun = await git(["fsck", "--no-progress", "--no-dangling"], info.root);
  const fsckOk = fsckRun.code === 0;
  const fsckOut = (fsckRun.stdout + fsckRun.stderr).trim();
  const after = await fingerprintRefs(info, isArtifact);
  const treeDiff = [];
  const missingRefs = [];
  for (const [ref, beforeFp] of before.refs) {
    const afterFp = after.refs.get(ref);
    if (!afterFp) {
      missingRefs.push(ref);
      continue;
    }
    if (afterFp.digest !== beforeFp.digest) {
      treeDiff.push({ ref, before: beforeFp, after: afterFp });
    }
  }
  const countRes = await git(["rev-list", "--all", "--count"], info.root);
  const commitsAfter = countRes.code === 0 ? Number(countRes.stdout.trim() || "0") : -1;
  const notes = [];
  if (commitsAfter > commitsBefore) {
    notes.push(`commit count increased (${commitsBefore} -> ${commitsAfter}); this should not happen`);
  }
  return {
    ok: fsckOk && treeDiff.length === 0 && missingRefs.length === 0 && notes.length === 0,
    fsck: { ok: fsckOk, output: fsckOut },
    treeDiff,
    missingRefs,
    commitsBefore,
    commitsAfter,
    notes
  };
}

// src/ui.ts
function colorEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR !== undefined)
    return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0")
    return true;
  if (process.env.TERM === "dumb")
    return false;
  return Boolean(stream.isTTY);
}
var enabled = colorEnabled();
function setColor(on) {
  enabled = on;
}
function wrap(open, close) {
  return (s) => enabled ? `\x1B[${open}m${s}\x1B[${close}m` : s;
}
var bold = wrap(1, 22);
var dim = wrap(2, 22);
var red = wrap(31, 39);
var green = wrap(32, 39);
var yellow = wrap(33, 39);
var blue = wrap(34, 39);
var magenta = wrap(35, 39);
var cyan = wrap(36, 39);
var gray = wrap(90, 39);
var sym = {
  ok: (s = "✔") => enabled ? `\x1B[32m${s}\x1B[39m` : s,
  warn: (s = "!") => enabled ? `\x1B[33m${s}\x1B[39m` : s,
  err: (s = "✖") => enabled ? `\x1B[31m${s}\x1B[39m` : s,
  info: (s = "•") => enabled ? `\x1B[34m${s}\x1B[39m` : s,
  step: (s = "→") => enabled ? `\x1B[36m${s}\x1B[39m` : s
};
function out(msg = "") {
  process.stdout.write(msg + `
`);
}
function heading(text) {
  out();
  out(bold(text));
  out(gray("─".repeat(Math.min(72, Math.max(8, text.length)))));
}
function table(rows, opts = {}) {
  const all = opts.head ? [opts.head, ...rows] : rows;
  if (all.length === 0)
    return;
  const widths = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  const line = (row, style) => row.map((cell, i) => {
    const pad = " ".repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(cell)));
    return style ? style(cell + pad) : cell + pad;
  }).join("  ").trimEnd();
  if (opts.head)
    out(dim(line(opts.head)));
  for (const row of rows)
    out(line(row));
}
var ANSI_RE = /\u001B\[[0-9;]*m/g;
function visibleLength(s) {
  return s.replace(ANSI_RE, "").length;
}
function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
function shortOid(oid) {
  return oid.slice(0, 10);
}
async function confirm(question, defaultValue = false) {
  if (!process.stdin.isTTY)
    return defaultValue;
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  process.stdout.write(`${yellow("?")} ${question} ${dim(suffix)} `);
  return new Promise((resolve2) => {
    const stdin = process.stdin;
    const onData = (chunk) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      const answer = chunk.toString("utf8").trim().toLowerCase();
      const yes = answer === "" ? defaultValue : answer.startsWith("y");
      process.stdout.write((yes ? green("yes") : red("no")) + `
`);
      resolve2(yes);
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// src/purge/index.ts
async function planPurge(info, opts, filterRepoAvailable) {
  const rules = resolveRules(opts.scan);
  const report = await scan(info, opts.scan);
  const commits = await commitCount(info);
  const resolvedEngine = opts.engine === "filter-repo" && filterRepoAvailable ? "filter-repo" : "native";
  return {
    artifactPaths: report.paths,
    historyPathCount: report.findings.filter((f) => f.scope === "history").length,
    messageCount: report.findings.filter((f) => f.scope === "message").length,
    commits,
    rules,
    engine: opts.engine,
    resolvedEngine,
    hasWork: report.findings.length > 0
  };
}
async function purge(info, plan, opts) {
  const warnings = [];
  const matcher = (p) => plan.rules.some((r) => r.test(p));
  const state = await repoState(info);
  if (state.inProgress.length) {
    throw new Error(`refusing to rewrite: ${state.inProgress.join(", ")}. Finish or abort it first.`);
  }
  if (state.dirty && !opts.force) {
    throw new Error(`refusing to rewrite a repository with uncommitted changes.
` + "Commit, stash, or re-run with --force.");
  }
  if (info.shallow) {
    warnings.push("this is a shallow clone - old commits are missing and cannot be purged. " + "Run `git fetch --unshallow` first.");
  }
  opts.log(dim(`... fingerprinting refs`));
  const before = await fingerprintRefs(info, matcher);
  for (const e of before.errors)
    warnings.push(`fingerprint: ${e}`);
  let backup = null;
  if (opts.backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    opts.log(dim("... creating backup bundle"));
    backup = await createBackup(info, stamp);
    opts.log(`backup written to ${backup.bundle}`);
  }
  const workDir = `${info.gitDir}/kick-claude/rewrite`;
  let native = null;
  let filterRepoOutput = null;
  if (plan.resolvedEngine === "filter-repo") {
    opts.log(dim("... rewriting history with git filter-repo"));
    const r = await runFilterRepo(info, {
      pathSpecs: rulesToPathSpecs(opts.scan.extraSpecs ?? []),
      force: true
    });
    filterRepoOutput = r.output;
    if (!r.ok)
      throw new Error(`git filter-repo failed:
${r.output}`);
  } else {
    opts.log(dim("... rewriting history (native engine)"));
    native = await nativePurge(info, {
      matchPath: matcher,
      pruneEmpty: opts.pruneEmpty,
      remapHashes: opts.remapHashes,
      workDir,
      log: (m) => opts.log(dim(m))
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
  if (plan.resolvedEngine === "filter-repo" && info.remotes.origin) {
    await git(["remote", "add", "origin", info.remotes.origin], info.root);
  }
  opts.log(dim("... verifying"));
  const verify = await verifyRewrite(info, before, plan.commits, matcher);
  return { plan, backup, native, filterRepoOutput, verify, before, warnings };
}
function restoreInstructions(backup, info) {
  if (!backup)
    return [];
  return restoreHint(backup, info);
}

// src/cli.ts
var VERSION = "0.1.0";
var OPTION_SPEC = {
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
  engine: { type: "string" },
  "no-prune": { type: "boolean" },
  "no-remap": { type: "boolean" },
  "no-messages": { type: "boolean" }
};
function main() {
  return dispatch();
}
async function dispatch() {
  let parsed;
  try {
    parsed = parseArgs({
      options: OPTION_SPEC,
      allowPositionals: true,
      args: process.argv.slice(2)
    });
  } catch (e) {
    errPrint(e.message);
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
  if (v.json)
    setColor(false);
  const opts = {
    cwd: v.cwd,
    json: Boolean(v.json),
    verbose: Boolean(v.verbose),
    dryRun: Boolean(v["dry-run"]),
    assumeYes: Boolean(v.yes),
    force: Boolean(v.force) || Boolean(v["exit-zero"]),
    stage: Boolean(v.stage),
    noGitignore: Boolean(v["no-gitignore"]),
    scan: {
      include: v.include,
      exclude: v.exclude,
      extraSpecs: v.path,
      includeReflog: Boolean(v.reflog),
      worktreeOnly: Boolean(v.worktree),
      secrets: Boolean(v.secrets),
      messages: !v["no-messages"],
      fast: Boolean(v.fast)
    }
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
function errPrint(msg) {
  process.stderr.write(msg + `
`);
}
async function cmdScan(opts) {
  const info = await repoInfo(opts.cwd ?? process.cwd());
  const report = await scan(info, opts.scan);
  if (opts.json) {
    out(JSON.stringify({
      repo: report.repo,
      counts: report.counts,
      paths: report.paths,
      findings: report.findings,
      durationMs: report.durationMs
    }, null, 2));
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
  const groups = [
    ["worktree", "Working tree", cyan],
    ["history", "Git history (paths)", magenta],
    ["message", "Commit messages", yellow],
    ["gitignore", ".gitignore entries", blue],
    ["secret", "Credentials", red]
  ];
  for (const [scope, title, color] of groups) {
    const items = report.findings.filter((f) => f.scope === scope);
    if (items.length === 0)
      continue;
    out(color(title) + dim(`  (${items.length})`));
    table(items.slice(0, 40).map((f) => {
      const loc = f.introducedIn ? dim("first in " + shortOid(f.introducedIn)) : "";
      return ["  " + (f.path ?? f.excerpt ?? f.label), loc];
    }));
    if (items.length > 40)
      out(dim(`  ... and ${items.length - 40} more`));
    out();
  }
  if (report.hasSecrets) {
    out(`${sym.err()} Credentials were found inside Claude Code config files.
` + `  ${bold("Revoke/rotate them")} - deleting the files does not invalidate a leaked key.
`);
  }
  if (report.repo.shallow) {
    out(`${sym.warn()} Shallow clone: history results are incomplete. Run git fetch --unshallow.`);
  }
  out(`${sym.info()} Next: ${bold("kick-claude clean")} (working tree) or ${bold("kick-claude purge")} (full history).`);
  out(dim(`  scan took ${report.durationMs} ms`));
  return opts.force ? 0 : 1;
}
async function cmdClean(opts) {
  const info = await repoInfo(opts.cwd ?? process.cwd());
  const report = await scan(info, { ...opts.scan, worktreeOnly: true, messages: false });
  const result = await cleanWorktree(info, {
    paths: report.paths,
    rules: report.activeRules,
    stage: opts.stage,
    gitignore: !opts.noGitignore,
    dryRun: opts.dryRun
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
  if (result.staged)
    out(`${sym.ok()} Removals staged. Review with git status, then commit.`);
  if (opts.dryRun)
    out(dim("dry run - nothing was deleted"));
  return 0;
}
async function cmdInit(opts) {
  const info = await repoInfo(opts.cwd ?? process.cwd());
  const lines = opts.dryRun ? [] : await updateGitignore(info);
  heading(opts.dryRun ? "kick-claude init (dry run)" : "kick-claude init");
  table(ignoreBlockLines().map((l) => ["  " + dim(l)]));
  out();
  out(opts.dryRun ? `${sym.info()} dry run - .gitignore unchanged` : `${sym.ok()} .gitignore updated (${lines.length} patterns)`);
  return 0;
}
async function cmdPurge(opts, v) {
  const info = await repoInfo(opts.cwd ?? process.cwd());
  const fr = await hasFilterRepo(info);
  const engine = v.engine ?? "auto";
  if (engine === "filter-repo" && !fr.available) {
    errPrint("git filter-repo is not installed. Install it with: pipx install git-filter-repo");
    return 2;
  }
  const purgeOpts = {
    engine,
    pruneEmpty: !v["no-prune"],
    remapHashes: !v["no-remap"],
    backup: !v["no-backup"],
    assumeYes: opts.assumeYes,
    force: opts.force,
    keepOldObjects: Boolean(v["keep-old"]),
    scan: opts.scan,
    log: (m) => {
      if (opts.verbose)
        out(dim(m));
    }
  };
  const plan = await planPurge(info, purgeOpts, fr.available);
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
  out(`  paths        ${plan.artifactPaths.length} artifact path(s), ${plan.historyPathCount} historical occurrence(s)`);
  out(`  messages     ${plan.messageCount} commit message(s) with Claude markers`);
  out(`  options      prune-empty=${purgeOpts.pruneEmpty} remap-hashes=${purgeOpts.remapHashes} backup=${purgeOpts.backup}`);
  out();
  if (!plan.hasWork) {
    out(`${sym.ok()} Nothing to purge.`);
    return 0;
  }
  if (plan.artifactPaths.length) {
    table(plan.artifactPaths.slice(0, 25).map((p) => ["  " + red(p)]));
    if (plan.artifactPaths.length > 25) {
      out(dim(`  ... and ${plan.artifactPaths.length - 25} more`));
    }
    out();
  }
  if (opts.dryRun) {
    out(`${sym.info()} Dry run - no changes made.`);
    return 0;
  }
  out(`${sym.warn()} Rewriting history changes every commit id from the first removed file onwards.
` + dim("  Everyone with a clone must re-clone; a normal pull resurrects the old history.") + `
`);
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
    out(JSON.stringify({
      repo: info.root,
      engine: plan.resolvedEngine,
      stats: result.native ? {
        commits: result.native.stats.commits,
        prunedCommits: result.native.stats.prunedCommits,
        removedFileChanges: result.native.stats.removedFileChanges,
        rewrittenMessages: result.native.stats.rewrittenMessages,
        droppedTags: result.native.stats.droppedTags,
        droppedResets: result.native.stats.droppedResets,
        droppedRefs: result.native.stats.droppedRefs
      } : null,
      passes: result.native?.passes ?? null,
      remappedMessages: result.native?.remappedMessages ?? 0,
      backup: result.backup ? { bundle: result.backup.bundle, sizeBytes: result.backup.sizeBytes } : null,
      warnings: result.warnings,
      verification: {
        ok: verdict.ok,
        commitsAfter: verdict.commitsAfter,
        fsckOk: verdict.fsck.ok,
        treeDiff: verdict.treeDiff,
        notes: verdict.notes
      }
    }, null, 2));
    return verdict.ok ? 0 : 1;
  }
  heading("result");
  if (result.native) {
    const s = result.native.stats;
    out(`  commits seen         ${s.commits}`);
    out(`  commits pruned       ${green(String(s.prunedCommits))}`);
    out(`  file changes removed ${s.removedFileChanges}`);
    out(`  messages rewritten   ${s.rewrittenMessages}`);
    if (result.native.passes > 1)
      out(`  passes               ${result.native.passes}`);
  } else if (result.filterRepoOutput) {
    out("  " + dim(result.filterRepoOutput.split(`
`).slice(-3).join(`
  `)));
  }
  out();
  out(verdict.ok ? `  ${sym.ok()} verification passed: ${verdict.commitsAfter} commits, every non-artifact blob identical` : `  ${sym.err()} verification reported problems`);
  if (!verdict.fsck.ok) {
    out("  " + red("git fsck: " + verdict.fsck.output.split(`
`).slice(0, 5).join("; ")));
  }
  for (const d of verdict.treeDiff) {
    out("  " + red(`tree changed on ${d.ref}: ${d.before.count} -> ${d.after.count} entries`));
  }
  for (const n of verdict.notes)
    out(`  ${yellow("!")} ${n}`);
  for (const w of result.warnings)
    out(`  ${yellow("!")} ${w}`);
  if (result.backup) {
    out();
    out(`  ${sym.info()} backup bundle: ${result.backup.bundle} ${dim("(" + humanBytes(result.backup.sizeBytes) + ")")}`);
    out(`  ${dim("restore with:")}`);
    for (const line of restoreInstructions(result.backup, info))
      out(dim("    " + line));
  }
  out();
  out(bold("Next steps"));
  const remote = info.remotes.origin ?? "origin";
  const lines = [
    `git push --force --prune ${remote} refs/heads/*:refs/heads/* refs/tags/*:refs/tags/*`,
    "git reflog expire --expire=now --all && git gc --prune=now   # run on the remote/forks too",
    "tell collaborators to delete their clones and re-clone"
  ];
  for (const l of lines)
    out("  " + dim(l));
  return verdict.ok ? 0 : 1;
}
function printRules() {
  heading("artifact rules");
  table(DEFAULT_RULES.map((r) => ["  " + bold(r.id), r.kind, r.pattern, dim(r.severity)]), { head: ["  id", "kind", "pattern", "level"] });
  out();
  out(dim(`Use --include <id> / --exclude <id> to narrow the set and --path <spec> to add your own.
` + "Specs accept dir:, file:, glob: or regex: prefixes; a bare value matches a root path."));
}
function printHelp(topic) {
  if (topic === "rules") {
    printRules();
    return;
  }
  heading("kick-claude " + VERSION);
  out([
    "",
    "  " + bold("Detect and losslessly purge Claude Code collaboration files"),
    "  CLAUDE.md, CLAUDE.local.md, .claude/, .mcp.json, .claude.json",
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
    "    --engine <e>         auto | native | filter-repo  (default: auto -> native)",
    "    --no-prune           Keep commits that become empty",
    "    --no-remap           Do not rewrite hash references inside commit messages",
    "    --no-backup          Skip the pre-rewrite git bundle",
    "    --keep-old           Do not expire reflogs / gc after the rewrite",
    "    --dry-run            Print the plan and exit",
    "    -y, --yes            Do not ask for confirmation",
    "    --force              Rewrite even with a dirty working tree",
    "",
    "  " + bold("EXAMPLES"),
    "    kick-claude scan --secrets",
    "    kick-claude clean --stage",
    "    kick-claude purge --dry-run",
    "    kick-claude purge -y && git push --force --all",
    ""
  ].join(`
`));
  out(dim("Exit codes: 0 clean, 1 artifacts/problem found, 2 usage error, 130 aborted."));
}
main().then((code) => process.exit(code), (e) => {
  if (e instanceof GitError)
    errPrint(red("error: ") + e.message);
  else
    errPrint(red("error: ") + (e?.message ?? String(e)));
  if (process.env.KICK_CLAUDE_DEBUG)
    errPrint(String(e?.stack ?? ""));
  process.exit(2);
});

//# debugId=61044E296388120E64756E2164756E21
