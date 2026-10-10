#!/usr/bin/env bun
/**
 * Fails when the committed action bundle was not built from the current
 * sources. The bundle cannot be compared byte-for-byte across platforms - Bun
 * renames identifiers differently per host and the emitted `debugId` changes
 * with the output - so `scripts/build.ts` stamps it with `hashSources(src)` and
 * this compares that stamp instead.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashSources } from "./source-hash.ts";

const root = resolve(import.meta.dirname, "..");
const expected = await hashSources(root);
const contents = await readFile(join(root, "action", "cli.js"), "utf8");
const match = /^\/\/ kick-claude-source-hash: ([0-9a-f]{16})$/m.exec(contents);

if (!match) {
  console.error("action/cli.js has no source-hash stamp. Run: bun run build");
  process.exit(1);
}
if (match[1] !== expected) {
  console.error(
    `action/cli.js is stale: built from ${match[1]}, sources are ${expected}\n` +
      "  Run: bun run build && git add action/cli.js"
  );
  process.exit(1);
}
console.log(`action/cli.js matches the current sources (${expected})`);