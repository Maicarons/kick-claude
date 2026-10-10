/** Minimal ANSI helpers + consistent CLI output. No dependencies. */

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

let enabled = colorEnabled();

export function setColor(on: boolean): void {
  enabled = on;
}

function wrap(open: number, close: number) {
  return (s: string) => (enabled ? `\u001B[${open}m${s}\u001B[${close}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

export const sym = {
  ok: (s = "✔") => (enabled ? `\u001B[32m${s}\u001B[39m` : s),
  warn: (s = "!") => (enabled ? `\u001B[33m${s}\u001B[39m` : s),
  err: (s = "✖") => (enabled ? `\u001B[31m${s}\u001B[39m` : s),
  info: (s = "•") => (enabled ? `\u001B[34m${s}\u001B[39m` : s),
  step: (s = "→") => (enabled ? `\u001B[36m${s}\u001B[39m` : s),
};

export function out(msg = ""): void {
  process.stdout.write(msg + "\n");
}

export function errOut(msg = ""): void {
  process.stderr.write(msg + "\n");
}

export function heading(text: string): void {
  out();
  out(bold(text));
  out(gray("─".repeat(Math.min(72, Math.max(8, text.length)))));
}

/** Render a compact aligned table. */
export function table(rows: string[][], opts: { head?: string[] } = {}): void {
  const all = opts.head ? [opts.head, ...rows] : rows;
  if (all.length === 0) return;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  const line = (row: string[], style?: (s: string) => string) =>
    row
      .map((cell, i) => {
        const pad = " ".repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(cell)));
        return style ? style(cell + pad) : cell + pad;
      })
      .join("  ")
      .trimEnd();
  if (opts.head) out(dim(line(opts.head)));
  for (const row of rows) out(line(row));
}

const ANSI_RE = /\u001B\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

export function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export function shortOid(oid: string): string {
  return oid.slice(0, 10);
}

/** Ask a yes/no question. Returns `defaultValue` when stdin is not a TTY. */
export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultValue;
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  process.stdout.write(`${yellow("?")} ${question} ${dim(suffix)} `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (chunk: Buffer) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      const answer = chunk.toString("utf8").trim().toLowerCase();
      const yes = answer === "" ? defaultValue : answer.startsWith("y");
      process.stdout.write((yes ? green("yes") : red("no")) + "\n");
      resolve(yes);
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}