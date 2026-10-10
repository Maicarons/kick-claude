export {
  scan,
  resolveRules,
  makePathMatcher,
  type ScanReport,
  type ScanOptions,
  type Finding,
} from "./detect.ts";
export {
  DEFAULT_RULES,
  DEFAULT_MESSAGE_RULES,
  DEFAULT_ENABLED,
  SECRET_PATTERNS,
  compileRule,
  type ArtifactRule,
  type RuleKind,
} from "./rules.ts";
export {
  cleanWorktree,
  updateGitignore,
  removeIgnoreBlock,
  ignoreBlockLines,
} from "./worktree.ts";
export {
  purge,
  planPurge,
  type PurgeOptions,
  type PurgePlan,
  type PurgeResult,
} from "./purge/index.ts";
export { nativePurge, type NativePurgeResult } from "./purge/native.ts";
export { FastExportFilter, defaultMessageFilter } from "./purge/stream.ts";
export { fingerprintRefs, verifyRewrite, type VerifyReport } from "./purge/verify.ts";
export { repoInfo, repoRoot, type RepoInfo } from "./git.ts";