/**
 * Knowledge base: every artifact Claude Code can leave inside a git repository.
 *
 * Sources (official Anthropic documentation, fetched 2026-10):
 *  - https://docs.claude.com/en/docs/claude-code/settings
 *      .claude/settings.json, .claude/settings.local.json, <project>/.mcp.json
 *      Claude Code appends a global exclude for
 *      ".claude/settings.local.json" when it first writes that file.
 *  - https://docs.claude.com/en/docs/claude-code/memory
 *      CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md, .claude/rules/*.md,
 *      plus any of those in sub-directories (loaded on demand).
 *
 * Everything here is matched against repo-relative paths (always `/` separated,
 * no leading `./`) unless stated otherwise.
 */

export type RuleKind = "dir" | "file" | "glob" | "regex";

export interface ArtifactRule {
  /** Stable identifier, also used in the CLI (`--exclude @id`). */
  id: string;
  kind: RuleKind;
  /** For `dir`/`file`: the segment/base name. For `glob`/`regex`: the pattern. */
  pattern: string;
  label: string;
  reason: string;
  /**
   * `core`   — written by Claude Code itself, safe to purge wholesale.
   * `secret` — may embed credentials; always worth purging from history.
   * `extra`  — adjacent tooling conventions, opt-in.
   */
  severity: "core" | "secret" | "extra";
}

/**
 * The default rule set. Ordered from most to least specific.
 *
 * Note that `.claude/` covers settings.json, settings.local.json, CLAUDE.md,
 * rules/, commands/, agents/, skills/, hooks/ and plugins/ in one shot, at any
 * depth — so the remaining entries only need to cover files that live
 * *outside* the `.claude` directory.
 */
export const DEFAULT_RULES: readonly ArtifactRule[] = [
  {
    id: "claude-dir",
    kind: "dir",
    pattern: ".claude",
    label: ".claude/ directory",
    reason: "Project-scoped Claude Code configuration: settings, rules, commands, agents, skills, hooks, plugins.",
    severity: "core",
  },
  {
    id: "claude-md",
    kind: "file",
    pattern: "CLAUDE.md",
    label: "CLAUDE.md",
    reason: "Project memory / instruction file read by Claude Code at session start (also in sub-directories).",
    severity: "core",
  },
  {
    id: "claude-local-md",
    kind: "file",
    pattern: "CLAUDE.local.md",
    label: "CLAUDE.local.md",
    reason: "Personal, machine-local Claude Code memory; explicitly documented as “do not commit”.",
    severity: "core",
  },
  {
    id: "claude-home-json",
    kind: "file",
    pattern: ".claude.json",
    label: ".claude.json",
    reason: "User-level Claude Code state (sessions, OAuth, per-project state). Must never be committed.",
    severity: "secret",
  },
  {
    id: "mcp-json",
    kind: "file",
    pattern: ".mcp.json",
    label: ".mcp.json",
    reason: "Project MCP server definitions; frequently contains API keys in `env`.",
    severity: "secret",
  },
  {
    id: "anthropic-rules",
    kind: "dir",
    pattern: ".anthropic",
    label: ".anthropic/ directory",
    reason: "Anthropic tooling scratch space (skills/plugins caches) occasionally committed by mistake.",
    severity: "extra",
  },
];

/** Rule ids that are enabled unless the user opts out. */
export const DEFAULT_ENABLED = DEFAULT_RULES.filter(
  (r) => r.severity !== "extra",
).map((r) => r.id);

export interface CompiledRule extends ArtifactRule {
  regex: RegExp;
  test(path: string): boolean;
}

const cache = new Map<string, CompiledRule>();

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` collapses to “any number of path segments (including none)”
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

export function compileRule(rule: ArtifactRule): CompiledRule {
  const hit = cache.get(rule.id);
  if (hit) return hit;

  let regex: RegExp;
  let test: (p: string) => boolean;
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

  const compiled: CompiledRule = { ...rule, regex, test };
  cache.set(rule.id, compiled);
  return compiled;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A user-supplied `--exclude` / `--only` specification. */
export interface PathFilter {
  id: string;
  matcher: CompiledRule;
}

export function parsePathSpec(spec: string): PathFilter {
  const m = /^(dir|file|glob|regex):(.*)$/s.exec(spec);
  if (m) {
    return {
      id: spec,
      matcher: compileRule({
        id: spec,
        kind: m[1] as RuleKind,
        pattern: m[2]!,
        label: spec,
        reason: "user supplied",
        severity: "core",
      }),
    };
  }
  // Bare `foo` behaves like `--path foo` in git-filter-repo: a file or a
  // directory, matched exactly at the repository root.
  return {
    id: `path:${spec}`,
    matcher: compileRule({
      id: `path:${spec}`,
      kind: "regex",
      pattern: `^${escapeRe(spec.replace(/\/+$/, ""))}(/|$)`,
      label: spec,
      reason: "user supplied",
      severity: "core",
    }),
  };
}

/**
 * Commit-message markers left by Claude Code. Removing the files but keeping
 * `Co-Authored-By: Claude …` trailers leaves a repository that still advertises
 * itself as Claude-assisted, so these are stripped as well.
 */
export interface MessageRule {
  id: string;
  label: string;
  regex: RegExp;
}

export const DEFAULT_MESSAGE_RULES: readonly MessageRule[] = [
  {
    id: "coauthored-by-claude",
    label: "Co-Authored-By: Claude … trailer",
    regex: /^[ \t]*Co-Authored-By:[ \t]*Claude[^\n]*\n?/gim,
  },
  {
    id: "generated-with-claude-code",
    label: "“Generated with Claude Code” footer",
    regex: /^[ \t]*(?:🤖[ \t]*)?Generated with[ \t]+\[?Claude Code\]?[^\n]*\n?/gim,
  },
  {
    id: "written-by-claude",
    label: "“Written by Claude” footer",
    regex: /^[ \t]*(?:🤖[ \t]*)?(?:Written|Created|Generated) by Claude[^\n]*\n?/gim,
  },
];

export interface SecretPattern {
  id: string;
  label: string;
  regex: RegExp;
}

/**
 * Credentials that Claude Code tends to persist inside the artifacts we remove.
 * Reported separately because the user may want to *revoke* them, not merely
 * delete the file.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: "anthropic-key", label: "Anthropic API key", regex: /sk-ant-[A-Za-z0-9_\-]{16,}/ },
  { id: "openai-key", label: "OpenAI-style API key", regex: /sk-(?:proj-)?[A-Za-z0-9_\-]{24,}/ },
  {
    id: "generic-json-secret",
    label: "credential-looking JSON value",
    regex: /"(?:api[_-]?key|apikey|token|secret|password|passwd|authorization)"\s*:\s*"(?!\$\{)([^"\\\n]{8,})"/gi,
  },
  {
    id: "bearer-token",
    label: "Bearer token",
    regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/g,
  },
];