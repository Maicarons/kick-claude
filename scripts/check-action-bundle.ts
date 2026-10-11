#!/usr/bin/env bun
/**
 * Fails when the committed action bundle was not built from the current
 * sources. The bundle cannot be compared byte-for-byte across platforms - Bun
 * renames identifiers differently per host and the emitted `debugId` changes
 * with the output - so `scripts/build.ts` stamps it with `hashSources(src)` and
 * this compares that stamp instead.
 *
 * The bundle is read out of git (`git show HEAD:action/cli.js`), not off disk,
 * and that is the whole point: CI runs this after `bun run build`, and the
 * build overwrites `action/cli.js`, so a check against the working tree only
 * ever compares the bundle with itself and can never fail. What ships is the
 * committed copy - it is what `uses: Maicarons/kick-claude@v1` downloads - so
 * the committed copy is what has to match.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashSources } from "./source-hash.ts";

const root = resolve(import.meta.dirname, "..");
// `\r?` because a checkout on Windows can hand back CRLF line endings.
const stampRe = /^\/\/ kick-claude-source-hash: ([0-9a-f]{16})\r?$/m;
const stampOf = (contents: string): string | null =>
  stampRe.exec(contents)?.[1] ?? null;

const expected = await hashSources(root);

const shown = spawnSync("git", ["show", "HEAD:action/cli.js"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
if (shown.error || shown.status !== 0) {
  console.error(
    `cannot read the committed action/cli.js (git show HEAD:action/cli.js): ${
      shown.stderr?.trim() || shown.error?.message || "unknown error"
    }\n  Run this from inside a checkout of the repository.`,
  );
  process.exit(1);
}

const committedStamp = stampOf(shown.stdout);
if (!committedStamp) {
  console.error(
    "the committed action/cli.js has no source-hash stamp.\n" +
      "  Run: bun run build && git add action/cli.js",
  );
  process.exit(1);
}
if (committedStamp !== expected) {
  console.error(
    `the committed action/cli.js is stale: built from ${committedStamp}, sources are ${expected}\n` +
      "  Run: bun run build && git add action/cli.js",
  );
  process.exit(1);
}

// A fresh `bun run build` in this working tree has to land on the same stamp as
// the committed copy. The working tree is allowed to be missing (nothing built
// yet) - the committed copy above is the one that has to be right.
let onDiskStamp: string | null = null;
try {
  onDiskStamp = stampOf(await readFile(join(root, "action", "cli.js"), "utf8"));
} catch {
  onDiskStamp = null;
}
if (onDiskStamp !== null && onDiskStamp !== committedStamp) {
  console.error(
    `action/cli.js on disk was built from ${onDiskStamp} but the committed copy was built from ${committedStamp}.\n` +
      "  Run: bun run build && git add action/cli.js",
  );
  process.exit(1);
}

console.log(`action/cli.js matches the current sources (${expected})`);
