/**
 * Post-rewrite verification.
 *
 * The contract of a *lossless* purge is: every non-artifact blob must still be
 * present, byte-identical, at the same path on every ref. We check that by
 * fingerprinting each ref's tree with the artifact paths removed and comparing
 * before/after.
 */
import { createHash } from "node:crypto";
import { git, gitOrThrow, type RepoInfo } from "../git.ts";

export interface RefFingerprint {
  ref: string;
  count: number;
  digest: string;
}

export interface FingerprintResult {
  refs: Map<string, RefFingerprint>;
  errors: string[];
}

export async function fingerprintRefs(
  info: RepoInfo,
  isArtifact: (path: string) => boolean,
  refs?: string[],
): Promise<FingerprintResult> {
  const target =
    refs ??
    (await gitOrThrow(["for-each-ref", "--format=%(refname)"], info.root))
      .split(/\r?\n/)
      .filter(Boolean);

  const out = new Map<string, RefFingerprint>();
  const errors: string[] = [];

  for (const ref of target) {
    const r = await git(["ls-tree", "-r", "--full-tree", "-z", ref], info.root);
    if (r.code !== 0) {
      errors.push(`${ref}: ${r.stderr.trim()}`);
      continue;
    }
    const hash = createHash("sha256");
    let count = 0;
    for (const rec of r.stdout.split("\0")) {
      if (!rec) continue;
      // `<mode> SP <type> SP <oid> TAB <path>`
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const path = rec.slice(tab + 1);
      if (isArtifact(path)) continue;
      hash.update(rec.slice(0, tab)).update("\t").update(path).update("\0");
      count++;
    }
    out.set(ref, { ref, count, digest: hash.digest("hex").slice(0, 16) });
  }
  return { refs: out, errors };
}

export interface VerifyReport {
  ok: boolean;
  fsck: { ok: boolean; output: string };
  treeDiff: Array<{ ref: string; before: RefFingerprint; after: RefFingerprint }>;
  missingRefs: string[];
  commitsBefore: number;
  commitsAfter: number;
  notes: string[];
}

export async function verifyRewrite(
  info: RepoInfo,
  before: FingerprintResult,
  commitsBefore: number,
  isArtifact: (path: string) => boolean,
): Promise<VerifyReport> {
  const fsckRun = await git(["fsck", "--no-progress", "--no-dangling"], info.root);
  const fsckOk = fsckRun.code === 0;
  const fsckOut = (fsckRun.stdout + fsckRun.stderr).trim();

  const after = await fingerprintRefs(info, isArtifact);
  const treeDiff: VerifyReport["treeDiff"] = [];
  const missingRefs: string[] = [];

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

  const notes: string[] = [];
  if (commitsAfter > commitsBefore) {
    notes.push(
      `commit count increased (${commitsBefore} -> ${commitsAfter}); this should not happen`,
    );
  }

  return {
    ok: fsckOk && treeDiff.length === 0 && missingRefs.length === 0 && notes.length === 0,
    fsck: { ok: fsckOk, output: fsckOut },
    treeDiff,
    missingRefs,
    commitsBefore,
    commitsAfter,
    notes,
  };
}