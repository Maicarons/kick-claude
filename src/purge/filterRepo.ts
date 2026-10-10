/**
 * Secondary engine: delegate to `git filter-repo`.
 *
 * Useful when you want parity with the reference implementation, or as a
 * cross-check when validating `kick-claude`'s native engine.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, type RepoInfo } from "../git.ts";
import { DEFAULT_RULES } from "../rules.ts";

export interface FilterRepoOptions {
  /** Regex path specs (git-filter-repo syntax, without the `regex:` prefix). */
  pathSpecs: string[];
  /** Expressions applied to commit/tag messages. */
  messageReplacements?: Array<[RegExp, string]>;
  force: boolean;
  partial?: boolean;
}

export interface FilterRepoResult {
  ok: boolean;
  command: string;
  output: string;
}

/** Translate our rule set into git-filter-repo path regexes. */
export function rulesToPathSpecs(extraSpecs: string[] = []): string[] {
  const specs: string[] = [
    "(^|/)\\.claude(/|$)",
    "(^|/)CLAUDE\\.md$",
    "(^|/)CLAUDE\\.local\\.md$",
    "(^|/)\\.claude\\.json$",
    "(^|/)\\.mcp\\.json$",
  ];
  for (const spec of extraSpecs) {
    if (/^(dir|file|glob):/.test(spec)) {
      // Convert simple forms into an equivalent regex.
      const kind = spec.slice(0, spec.indexOf(":"));
      const pattern = spec.slice(spec.indexOf(":") + 1);
      if (kind === "dir") specs.push(`(^|/)${escapeRe(pattern)}/?($|/)`);
      else if (kind === "file") specs.push(`(^|/)${escapeRe(pattern)}$`);
      else specs.push(`(^|/)${escapeRe(pattern).replace(/\*/g, "[^/]*")}$`);
    } else if (/^regex:/.test(spec)) {
      specs.push(spec.slice("regex:".length));
    } else {
      specs.push(`(^|/)${escapeRe(spec.replace(/\/+$/, ""))}(/|$)`);
    }
  }
  return specs;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function defaultMessageReplacements(): Array<[RegExp, string]> {
  return [
    [/^[ \t]*Co-Authored-By:[ \t]*Claude[^\n]*\n?/gim, ""],
    [/^[ \t]*(?:\u{1F916}[ \t]*)?Generated with[ \t]+\[?Claude Code\]?[^\n]*\n?/gimu, ""],
    [/^[ \t]*(?:\u{1F916}[ \t]*)?(?:Written|Created|Generated) by Claude[^\n]*\n?/gimu, ""],
  ];
}

export async function runFilterRepo(
  info: RepoInfo,
  opts: FilterRepoOptions,
): Promise<FilterRepoResult> {
  const dir = await mkdtemp(join(tmpdir(), "kick-claude-"));
  try {
    const pathsFile = join(dir, "paths.txt");
    await writeFile(
      pathsFile,
      opts.pathSpecs.map((s) => `regex:${s}`).join("\n") + "\n",
      "utf8",
    );

    const args = ["filter-repo", "--invert-paths", "--paths-from-file", pathsFile];
    if (opts.force) args.push("--force");
    if (opts.partial) args.push("--partial");

    if (opts.messageReplacements?.length) {
      const msgFile = join(dir, "messages.txt");
      // git-filter-repo's expressions file is line-based, so multi-line
      // patterns are approximated by matching the marker line itself.
      const lines = [
        "regex:^[ \\t]*Co-Authored-By:[ \\t]*Claude[^\\n]*\\n?",
        "regex:^[ \\t]*(?:\\U0001F916[ \\t]*)?Generated with[ \\t]+\\[?Claude Code\\]?[^\\n]*\\n?",
        "regex:^[ \\t]*(?:\\U0001F916[ \\t]*)?(?:Written|Created|Generated) by Claude[^\\n]*\\n?",
        "==>",
      ];
      await writeFile(msgFile, lines.join("\n") + "\n", "utf8");
      args.push("--replace-message", msgFile);
    }

    const r = await git(args, info.root);
    return {
      ok: r.code === 0,
      command: `git ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
      output: (r.stdout + r.stderr).trim(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rules that git-filter-repo would remove, for documentation/help output. */
export const KNOWN_ARTIFACT_PATTERNS = DEFAULT_RULES.map((r) => ({
  id: r.id,
  kind: r.kind,
  pattern: r.pattern,
  label: r.label,
}));