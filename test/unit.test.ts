import { describe, expect, test } from "bun:test";
import { compileRule, DEFAULT_RULES, SECRET_PATTERNS, DEFAULT_MESSAGE_RULES } from "../src/rules.ts";
import { defaultMessageFilter, quotePath, unquotePath } from "../src/purge/stream.ts";
import { resolveRules } from "../src/detect.ts";
import { stripMentionLines } from "../src/purge/index.ts";

const matchers = DEFAULT_RULES.map(compileRule);
const match = (p: string) => matchers.find((r) => r.test(p));

describe("artifact rules", () => {
  test("matches .claude directories at any depth", () => {
    expect(match(".claude")?.id).toBe("claude-dir");
    expect(match(".claude/settings.json")?.id).toBe("claude-dir");
    expect(match("packages/api/.claude/agents/reviewer.md")?.id).toBe("claude-dir");
  });

  test("matches CLAUDE.md at any depth, case-insensitively", () => {
    expect(match("CLAUDE.md")?.id).toBe("claude-md");
    expect(match("claude.md")?.id).toBe("claude-md");
    expect(match("services/api/CLAUDE.md")?.id).toBe("claude-md");
  });

  test("matches CLAUDE.local.md, .mcp.json and .claude.json", () => {
    expect(match("CLAUDE.local.md")?.id).toBe("claude-local-md");
    expect(match(".mcp.json")?.id).toBe("mcp-json");
    expect(match("apps/web/.mcp.json")?.id).toBe("mcp-json");
    expect(match(".claude.json")?.id).toBe("claude-home-json");
  });

  test("does not touch unrelated files", () => {
    for (const p of [
      "src/claude.ts",
      "docs/CLAUDE.md.md",
      "src/.claudefoo/x.ts",
      "README.md",
      ".github/workflows/ci.yml",
      "myclaude.md",
    ]) {
      expect(match(p)).toBeUndefined();
    }
  });

  test("opt-in rules are excluded by default", () => {
    const ids = resolveRules().map((r) => r.id);
    expect(ids).not.toContain("anthropic-rules");
    expect(resolveRules({ include: ["anthropic-rules"] }).map((r) => r.id)).toEqual([
      "anthropic-rules",
    ]);
  });

  test("user supplied specs", () => {
    const rules = resolveRules({ extraSpecs: ["docs/ai-guide.md", "glob:**/*.prompt"] });
    const m = rules.map(compileRule);
    expect(m.some((r) => r.test("docs/ai-guide.md"))).toBe(true);
    expect(m.some((r) => r.test("docs/nested/ai-guide.md"))).toBe(false);
    expect(m.some((r) => r.test("a/b/c.prompt"))).toBe(true);
    expect(m.some((r) => r.test("c.promptx"))).toBe(false);
  });
});

describe("message rules", () => {
  test("strips Co-Authored-By trailers", () => {
    const msg = "feat: add thing\n\nSome body.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n";
    expect(defaultMessageFilter(msg)).toBe("feat: add thing\n\nSome body.\n");
  });

  test("strips Generated with Claude Code footers", () => {
    const msg = "fix: thing\n\n🤖 Generated with [Claude Code](https://claude.ai/code)\n";
    expect(defaultMessageFilter(msg)).toBe("fix: thing\n");
  });

  test("leaves unrelated messages untouched", () => {
    const msg = "feat: x\n\nCo-Authored-By: A Human <a@b.c>\n";
    expect(defaultMessageFilter(msg)).toBe(msg);
  });

  test("detector regexes find markers", () => {
    const msg = "chore: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n";
    const hits = DEFAULT_MESSAGE_RULES.filter((r) => {
      r.regex.lastIndex = 0;
      return r.regex.test(msg);
    });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("path quoting", () => {
  test("round-trips unusual paths", () => {
    for (const p of [
      "src/a.ts",
      "src/with space.ts",
      'src/quote".ts',
      "src/back\\slash.ts",
      "docs/中文.md",
      "a\tb.txt",
    ]) {
      expect(unquotePath(quotePath(p))).toBe(p);
    }
  });

  test("decodes octal escapes like git emits", () => {
    expect(unquotePath('"caf\\303\\251.md"')).toBe("café.md");
  });
});

describe("message mention scrubbing", () => {
  test("keeps the subject line instead of promoting a body line", () => {
    const msg = "docs: 重写 README.md 并新增 CLAUDE.md\n\n- CLAUDE.md: 新增指引文件\n";
    const out = stripMentionLines(msg, ["CLAUDE.md"]);
    expect(out.split("\n")[0]).toBe("docs: 重写 README.md 并新增");
    expect(out).not.toContain("- CLAUDE.md:");
  });

  test("does not eat the space in an unrelated dotted filename", () => {
    // Regression: a naive "tidy the punctuation" pass turned this into
    // "Update.gitignore".
    expect(stripMentionLines("Update .gitignore\n", ["CLAUDE.md"])).toBe("Update .gitignore\n");
    expect(stripMentionLines("bump v1.2.3 and .mcp.json\n", [".mcp.json"])).toBe(
      "bump v1.2.3 and\n"
    );
  });

  test("does not touch a longer identifier that merely ends with the name", () => {
    expect(stripMentionLines("add MY_CLAUDE.md helper\n", ["CLAUDE.md"])).toBe(
      "add MY_CLAUDE.md helper\n"
    );
  });

  test("keeps prose that merely mentions the artifact", () => {
    // Regression: dropping every mentioning line deleted a sentence that also
    // described files which still exist.
    const msg =
      "refactor: decouple modules\n\nUpdate docs (AGENTS.md, CLAUDE.md, architecture) for the new packages.\n";
    expect(stripMentionLines(msg, ["CLAUDE.md"])).toBe(msg);
  });

  test("leaves unrelated messages alone", () => {
    const msg = "feat(core): 添加中国象棋人机对弈系统核心功能\n";
    expect(stripMentionLines(msg, ["CLAUDE.md"])).toBe(msg);
  });
});

describe("secret patterns", () => {
  test("detects Anthropic keys and JSON credentials", () => {
    const text = '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-abcdefghijklmnop"}}';
    expect(
      SECRET_PATTERNS.some((p) => {
        p.regex.lastIndex = 0;
        return p.regex.test(text);
      }),
    ).toBe(true);
  });
});