# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**The version number is taken from the git tag, not from `package.json`.** A tag
is what makes a release; `package.json` is kept in sync with it by a CI gate, so
the two always agree at release time. Sections below are ordered newest first,
using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories:
`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

## [Unreleased]

Nothing yet.

## [1.0.1] - 2026-10-10

Marketplace metadata and self-test fixes for the GitHub Action.

### Fixed

- Action marketplace metadata: shortened the description, applied the orange
  branding, and moved the runtime to node24
  (`cbb5c29`, `fix(action): marketplace metadata - short description, orange branding, node24`).
- Action self-test assertion corrected so it validates the real report
  (`9297efc`, `ci: fix the action self-test assertion`).
- Self-test JSON report is quoted with single quotes so the shell no longer
  mangles it (`bc05048`, `ci: quote the JSON report with single quotes in the self-test`).

This release is also tagged `v1`, which floats to the newest 1.x release.

## [1.0.0] - 2026-10-10

First release: a native, lossless purge engine plus the marketplace GitHub Action.

### Added

- GitHub Action for the marketplace, including the committed action bundle and
  its entrypoint (`740a223`, `feat(action): ship a GitHub Action for the marketplace`).
- `workflow_dispatch` on the action checks so they can be run on demand
  (`527091d`, `ci: allow workflow_dispatch so the action checks can be run on demand`).

### Changed

- Action bundle verification switched from a byte diff to a source-hash stamp,
  so a rebuild that only changes incidental bytes no longer reads as drift
  (`865796b`, `ci: verify the action bundle by source hash instead of byte diff`).

### Fixed

- Dropped the leading `./` from the `bin` path in `package.json`, which kept the
  installed CLI from resolving (`f7adf2c`, `fix(pkg): drop the leading ./ from the bin path`).
- Removed stray scratch files left over from manual pipe testing
  (`ce7430d`, `chore: drop stray scratch files left over from manual pipe testing`).

### Added (initial)

- The whole tool, in one commit: streaming `git fast-export` → byte filter →
  `git fast-import` purge pipeline, artifact detection and rules, backup,
  worktree handling, verification, the CLI, and the end-to-end suite
  (`7c6cf9c`, `feat: kick-claude - lossless Claude Code artifact purge for git`).

## Notes on reconstructing history

The 1.0.0 and 1.0.1 sections were reconstructed after the fact from git history,
so the grouping reflects what each tag actually shipped rather than a changelog
kept commit by commit. Both tags were cut with `package.json` still reading
`0.1.0`; that mismatch was corrected after release, and CI now prevents it from
recurring. From this point on, entries are maintained as changes land.

[Unreleased]: https://github.com/Maicarons/kick-claude/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Maicarons/kick-claude/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Maicarons/kick-claude/releases/tag/v1.0.0
