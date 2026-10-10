/**
 * Hash of every TypeScript source file, used to stamp the committed action
 * bundle so CI can tell whether it went stale. Kept in its own module because
 * importing it must not re-run the build.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function hashSources(root: string): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  await walk(join(root, "src"));
  // `relative` rather than slicing off `root.length`: callers pass roots with
  // different shapes (trailing slash, forward vs backslashes) and the hash must
  // not depend on that.
  files.sort((a, b) => (relative(root, a) < relative(root, b) ? -1 : 1));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file).replace(/\\/g, "/")).update("\0");
    hash.update(await readFile(file));
  }
  return hash.digest("hex").slice(0, 16);
}