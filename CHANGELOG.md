# Changelog

All notable changes to CC History Lite are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Lite CLI now has `latest [sessions|turns] [N]`, default 20-row limits for `ls`, `--all`,
  and lexical `--dir <path>` filtering across session/project lists, latest results, search,
  stats, and `tree projects`.
- Human-readable list and detail output now uses responsive columns, relative times,
  actionable short references, structured metadata, turn/context summaries, and explicit
  truncation counts. Existing `show --json` payloads remain unchanged.

### Changed

- CC History Lite now ships as an independent repository. It was extracted from the CC History
  monorepo, which continues to host the Full CLI/TUI, the managed API/web surfaces, and the
  persistent store. The Lite pipeline — `domain`, `canonical`, `source-adapters`,
  `live-runtime`, `lite-cli`, `lite-tui` — carries over unchanged.
- `@cchistory/live-runtime` no longer has a dev dependency on the Full store package. Its test
  suite asserts Lite behavior directly and cross-checks the two Lite entry points
  (`scanLiteHistory` and `buildLiveSnapshot`) against each other, instead of comparing against a
  persisted store. Full/Lite parity remains guarded in the monorepo.
- Architecture rules were trimmed to the four that apply to this repository; the rule covering
  the API/presentation client contract moved out with those packages.
- `show session` with a complete canonical id now scans only that native session. Fuzzy session
  and turn references retain full context only for resolver candidates in a single scan. All
  adapters declare and test file, container, or hybrid targeting, and target misses fail loudly.

### Fixed

- Directory-scoped Codex and Claude Code commands now preflight logical-session metadata and
  avoid fully parsing resolved non-matching sessions, while uncertain cwd evidence falls back to
  the complete read-only probe.

- `runSourceProbe restores Codex checkpoint baselines across appended JSONL` no longer depends on
  wall-clock timing. The incremental-append path is skipped when an appended file reports an
  unchanged `file_modified_at`; a sub-millisecond append lands in the same ISO millisecond, so
  the test now advances the file's mtime explicitly rather than relying on how long the preceding
  probe happened to take.
- `Lite scans explicit roots without creating or reading a Full store` no longer fails on
  case-insensitive filesystems. The test probes a `.CCHistory` case variant and then created
  `.cchistory` non-recursively, which is guaranteed `EEXIST` on macOS and Windows.

## [0.3.0]

Baseline inherited from the CC History monorepo at the time of extraction. See that repository's
history for changes prior to this point.
