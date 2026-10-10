#!/usr/bin/env bun
/**
 * Build the published bundle.
 *
 * The CLI is compiled with `--target node` so the artifact runs on plain
 * Node.js (>=18.17) as well as Bun. That means the source must not use any
 * Bun-only runtime API (`Bun.spawn`, `Bun.file`, ...); `node:child_process`
 * and friends are used everywhere instead.
 */
import { rm, mkdir, chmod, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/cli.ts"), join(root, "src/index.ts")],
  outdir: dist,
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "[dir]/[name].js",
    chunk: "chunks/[name]-[hash].js",
    asset: "assets/[name]-[hash][ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Make the CLI directly executable on POSIX systems.
await chmod(join(dist, "cli.js"), 0o755);

// Ship hand-written type declarations for the programmatic entry point. The
// bundle itself is not type-checked, so `tsc` is the source of truth here.
const tsc = Bun.spawnSync({
  cmd: ["tsc", "-p", "tsconfig.build.json"],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (tsc.exitCode !== 0) {
  console.error("tsc failed while emitting declarations");
  process.exit(tsc.exitCode);
}
if (!existsSync(join(dist, "types", "index.d.ts"))) {
  console.error("expected dist/types/index.d.ts to be emitted");
  process.exit(1);
}

// A tiny marker so `kick-claude --version` can report the real package version
// even when the bundle is executed from a global install.
const pkg = await Bun.file(join(root, "package.json")).json();
await writeFile(
  join(dist, "version.js"),
  `export const VERSION = ${JSON.stringify(pkg.version)};\n`,
);

console.log("built ->", dist);