/**
 * A streaming `git fast-export` filter.
 *
 * This is the heart of `kick-claude`: it sits between `git fast-export` and
 * `git fast-import` and does what `git filter-repo`'s Python filter does — but
 * in a single streaming pass, without a Python runtime, and with in-stream
 * empty-commit pruning (no second pass, no buffered commit map).
 *
 * Design notes
 * ------------
 * * We export with `--no-data`, so the stream contains no `blob` commands and
 *   no inline file data. Unmodified blobs are referenced by their existing SHA
 *   and are therefore bit-identical after the rewrite — nothing is decoded or
 *   re-encoded except commit messages that actually contain a Claude marker.
 * * `M <mode> <dataref> <path>` and `D <path>` are the only per-file commands
 *   we ever see (we deliberately do not pass `-M`/`-C`, so renames surface as
 *   delete+modify pairs and never as `R`/`C` directives that would reference a
 *   dropped blob).
 * * Because fast-export emits parents before children and assigns them marks,
 *   we can decide *inline* whether a commit becomes empty. Pruned marks map to
 *   the mark of their nearest surviving ancestor, so later `from`/`merge`/`tag`
 *   references are rewritten within the same pass.
 */
import type { Readable, Writable } from "node:stream";

export interface FileCmd {
  /** `M` (modify/add), `D` (delete) or `deleteall`. */
  type: "M" | "D" | "deleteall";
  path: string;
  raw: string;
}

export interface FilterOptions {
  /** Return true for paths that must disappear from all history. */
  matchPath(path: string): boolean;
  /** Return a cleaned commit/tag message. */
  filterMessage(message: string): string;
  /** Drop commits whose every file change was filtered out. */
  pruneEmpty: boolean;
  onWarn?(message: string): void;
  /** Collect a hex-looking token from a message (for the hash-remap pass). */
  onMessageHashCandidate?(hash: string): void;
}

export interface CommitInfo {
  mark: number;
  oid: string;
  ref: string;
  pruned: boolean;
  fileChanges: number;
  removedFileChanges: number;
  messageChanged: boolean;
}

export interface FilterStats {
  commits: number;
  prunedCommits: number;
  removedFileChanges: number;
  rewrittenMessages: number;
  droppedTags: number;
  droppedResets: number;
  hashCandidates: Set<string>;
  /** mark -> original commit oid */
  markToOid: Map<number, string>;
  marks: Set<number>;
  prunedMarks: Set<number>;
  commits_: CommitInfo[];
}

const COMMAND_RE = /^(commit|reset|tag|blob|done|checkpoint|progress|feature|option)\b/;
const HASH_TOKEN_RE = /\b[0-9a-f]{7,40}\b/g;

/** Characters that force a path to be C-quoted in the fast-import stream. */
const NEEDS_QUOTING = /[\s"\\]/;

export function unquotePath(p: string): string {
  if (!p.startsWith('"')) return p;
  // git emits one `\NNN` escape per *byte*, so escaped bytes have to be
  // re-assembled and decoded as UTF-8 rather than mapped to Latin-1 chars.
  const bytes: number[] = [];
  const pushUtf8 = (s: string) => {
    for (const b of Buffer.from(s, "utf8")) bytes.push(b);
  };

  let i = 1;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '"') break;
    if (c !== "\\") {
      pushUtf8(c);
      i++;
      continue;
    }
    const n = p[++i];
    if (n === undefined) break;
    if (n >= "0" && n <= "7") {
      const oct = /^[0-7]{1,3}/.exec(p.slice(i, i + 3));
      if (oct) {
        bytes.push(parseInt(oct[0], 8) & 0xff);
        i += oct[0].length;
        continue;
      }
    }
    switch (n) {
      case "n": pushUtf8("\n"); break;
      case "t": pushUtf8("\t"); break;
      case "r": pushUtf8("\r"); break;
      case "a": pushUtf8("\x07"); break;
      case "b": pushUtf8("\b"); break;
      case "f": pushUtf8("\f"); break;
      case "v": pushUtf8("\x0b"); break;
      default: pushUtf8(n);
    }
    i++;
  }
  return Buffer.from(bytes).toString("utf8");
}

export function quotePath(p: string): string {
  if (!NEEDS_QUOTING.test(p) && !Array.from(p).some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)) {
    return p;
  }
  return (
    '"' +
    p
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

export class FastExportFilter {
  private buf: Buffer = Buffer.alloc(0);
  private eof = false;
  private pushback: string | null = null;

  /**
   * The export stream is consumed through its async iterator rather than
   * `on("data")` listeners: a flowing stream would keep emitting (and emit
   * `end`) while we have no listener attached, silently dropping data.
   */
  private readonly chunks: AsyncIterator<Buffer | string>;

  /** mark -> reference usable by later commands (`:N`, a raw sha, or ""). */
  private resolved = new Map<number, string>();

  private readonly stats: FilterStats = {
    commits: 0,
    prunedCommits: 0,
    removedFileChanges: 0,
    rewrittenMessages: 0,
    droppedTags: 0,
    droppedResets: 0,
    hashCandidates: new Set(),
    markToOid: new Map(),
    marks: new Set(),
    prunedMarks: new Set(),
    commits_: [],
  };

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly opts: FilterOptions,
  ) {
    this.chunks = input[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  }

  get result(): FilterStats {
    return this.stats;
  }

  async run(): Promise<FilterStats> {
    for (;;) {
      const line = await this.nextLine();
      if (line === null) break;
      if (line === "") continue;
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
      if (line === "done") continue; // emitted once at the very end
      await this.write(line + "\n");
    }
    await this.write("done\n");
    return this.stats;
  }

  // ------------------------------------------------------------------ commit

  private async handleCommit(header: string): Promise<void> {
    const ref = header.slice("commit ".length).trim();
    const filecmds: FileCmd[] = [];
    const preamble: string[] = [];
    const passthrough: string[] = [];
    const parents: string[] = [];
    let mark = 0;
    let oid = "";
    let message: Buffer | null = null;

    for (;;) {
      const line = await this.nextLine();
      if (line === null) break;
      if (line === "") continue;
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
    if (mark && oid) this.stats.markToOid.set(mark, oid);

    const kept = filecmds.filter(
      (fc) => fc.type === "deleteall" || !this.opts.matchPath(fc.path),
    );
    const removed = filecmds.length - kept.length;
    this.stats.removedFileChanges += removed;

    const resolvedParents = parents.map((p) => this.resolveRef(p));
    const survivingParents = resolvedParents.filter((p) => p !== "");

    const becomesEmpty = filecmds.length > 0 && kept.length === 0;
    const wouldOrphanBranch = survivingParents.length === 0;
    const prune = this.opts.pruneEmpty && becomesEmpty && !wouldOrphanBranch;

    if (prune) {
      this.stats.prunedCommits++;
      if (mark) this.prunedMark(mark, survivingParents[0] ?? "");
      return;
    }

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
      messageChanged: changed,
    });

    await this.write(`commit ${quotePath(ref)}\n`);
    if (mark) await this.write(`mark :${mark}\n`);
    if (oid) await this.write(`original-oid ${oid}\n`);
    for (const l of preamble) await this.write(l + "\n");
    for (const l of passthrough) await this.write(l + "\n");
    await this.write(`data ${msgBytes.length}\n`);
    await this.write(msgBytes);
    if (resolvedParents[0]) await this.write(`from ${resolvedParents[0]}\n`);
    for (const p of resolvedParents.slice(1)) {
      if (p) await this.write(`merge ${p}\n`);
    }
    for (const fc of kept) await this.write(fc.raw + "\n");
  }

  // ------------------------------------------------------------------- reset

  private async handleReset(header: string): Promise<void> {
    const ref = header.slice("reset ".length).trim();
    let from: string | null = null;
    for (;;) {
      const line = await this.nextLine();
      if (line === null) break;
      if (line === "") continue;
      if (COMMAND_RE.test(line)) {
        this.pushback = line;
        break;
      }
      if (line.startsWith("from ")) {
        from = line.slice(5).trim();
        continue;
      }
      await this.write(line + "\n"); // `original-oid`, `filecopy`, …
    }

    const resolved = from === null ? null : this.resolveRef(from);
    if (resolved === "") {
      // The target commit was pruned away entirely; the ref would dangle.
      this.stats.droppedResets++;
      this.warn(`ref ${ref} pointed only at removed commits — dropped`);
      return;
    }
    await this.write(`reset ${quotePath(ref)}\n`);
    if (resolved) await this.write(`from ${resolved}\n`);
  }

  // --------------------------------------------------------------------- tag

  private async handleTag(header: string): Promise<void> {
    const name = header.slice("tag ".length).trim();
    const preamble: string[] = [];
    let from: string | null = null;
    let message: Buffer | null = null;

    for (;;) {
      const line = await this.nextLine();
      if (line === null) break;
      if (line === "") continue;
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
    await this.write(`tag ${quotePath(name)}\n`);
    for (const l of preamble) await this.write(l + "\n");
    await this.write(`data ${bytes.length}\n`);
    await this.write(bytes);
    if (resolved) await this.write(`from ${resolved}\n`);
  }

  // -------------------------------------------------------------------- blob

  /** With `--no-data` we never see blobs; kept for safety. */
  private async copyBlob(): Promise<void> {
    for (;;) {
      const line = await this.nextLine();
      if (line === null) return;
      if (line === "") continue;
      if (COMMAND_RE.test(line)) {
        this.pushback = line;
        return;
      }
      await this.write(line + "\n");
      if (line.startsWith("data ")) {
        const n = Number(line.slice(5).trim() || "0");
        if (n > 0) await this.write(await this.readExactly(n));
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private prunedMark(mark: number, replacement: string): void {
    this.resolved.set(mark, replacement);
    this.stats.prunedMarks.add(mark);
    this.stats.commits_.push({
      mark,
      oid: this.stats.markToOid.get(mark) ?? "",
      ref: "",
      pruned: true,
      fileChanges: 0,
      removedFileChanges: 0,
      messageChanged: false,
    });
  }

  private resolveRef(ref: string): string {
    if (!ref.startsWith(":")) return ref; // raw sha or zero oid
    const mark = Number(ref.slice(1));
    if (!Number.isFinite(mark)) return ref;
    const r = this.resolved.get(mark);
    return r === undefined ? ref : r;
  }

  private cleanMessage(message: Buffer | null): { bytes: Buffer; changed: boolean } {
    if (message === null) return { bytes: Buffer.alloc(0), changed: false };
    const original = message;
    const text = message.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(message)) {
      // Not valid UTF-8 — leave it byte-for-byte alone.
      return { bytes: original, changed: false };
    }
    for (const tok of text.match(HASH_TOKEN_RE) ?? []) {
      this.opts.onMessageHashCandidate?.(tok);
      if (this.stats.hashCandidates.size > 20000) break;
    }
    const cleaned = this.opts.filterMessage(text);
    if (cleaned === text) return { bytes: original, changed: false };
    let bytes = Buffer.from(cleaned, "utf8");
    if (bytes.length === 0) bytes = Buffer.from("\n", "utf8");
    this.stats.rewrittenMessages++;
    return { bytes, changed: true };
  }

  private warn(message: string): void {
    this.opts.onWarn?.(message);
  }

  private async write(chunk: string | Buffer): Promise<void> {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (!this.output.write(buf)) {
      await new Promise<void>((resolve) => this.output.once("drain", () => resolve()));
    }
  }

  private async nextLine(): Promise<string | null> {
    if (this.pushback !== null) {
      const l = this.pushback;
      this.pushback = null;
      return l;
    }
    for (;;) {
      const i = this.buf.indexOf(0x0a);
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

  private async readExactly(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.eof) throw new Error(`unexpected EOF in fast-export stream (wanted ${n} bytes)`);
      await this.fill();
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  private async fill(): Promise<void> {
    if (this.eof) return;
    const next = await this.chunks.next();
    if (next.done) {
      this.eof = true;
      return;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value, "utf8");
    if (chunk.length === 0) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }
}

/** Strip Claude Code markers from a commit/tag message. */
export function defaultMessageFilter(message: string): string {
  let m = message;
  m = m.replace(/^[ \t]*Co-Authored-By:[ \t]*Claude[^\n]*\n?/gim, "");
  m = m.replace(
    /^[ \t]*(?:\u{1F916}[ \t]*)?Generated with[ \t]+\[?Claude Code\]?[^\n]*\n?/gimu,
    "",
  );
  m = m.replace(
    /^[ \t]*(?:\u{1F916}[ \t]*)?(?:Written|Created|Generated) by Claude[^\n]*\n?/gimu,
    "",
  );
  // Collapse the blank-line pile-up left behind by removed trailers/footers.
  m = m.replace(/\n{3,}/g, "\n\n");
  m = m.replace(/^\n+/, "").replace(/\n+$/, "\n");
  return m;
}