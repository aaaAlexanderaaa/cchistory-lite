# Changelog

All notable changes to CC History Lite are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `cchistory-lite shell` holds one directory-scoped snapshot in memory. TTY
  sessions use human subcommands; `--json` or a non-TTY stdin uses JSON-lines
  (`search` / `latest` / `list` / `session` / `replies`, plus `refresh` and
  `exit`). Refresh is explicit.
- `query` operations `latest` and `list` batch recency and collection reads
  into the same scan as search, session, and replies.
- `--no-dir` opts out of the JSON/query/shell current-directory default.
- Experimental `cursor_agent` adapter reads Cursor Agent CLI transcripts from
  `~/.cursor/projects/<slug>/agent-transcripts/*.jsonl`. It is opt-in via
  `--source cursor_agent` so a default scan does not duplicate the same
  transcripts already merged by stable `cursor`.
- Experimental `grok` adapter reads official Grok CLI sessions from
  `~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl`, using
  `summary.json` for title/model/cwd and keeping updates, signals, and
  subagent meta as companion evidence. Sibling subagent sessions are
  linked through `parent/subagents/*/meta.json` (and a `session_kind` of
  `subagent` / `subagent_resume` / `subagent_fork` only when that summary
  also names the parent). Synthetic user rows
  (`project_instructions`, `system_reminder`, …) stay out of UserTurns.

### Changed

- CLI / `--json` / `query` search now returns one row per top-level session
  (title, `resume_command`, best matching turn). `total`, `shown`, `limit`,
  and `offset` count sessions. The TUI still lists matching turns.
- `--json`, `query`, and `shell` default to `--dir=$PWD`. Human-readable CLI
  without `--json` still scans every selected source. `sources`, `show`,
  `export`, and `tui` do not take that default.
- Grok `--dir` skips sessions whose encoded cwd is known not to match before
  parsing chat history. Uncertain paths still take the full read-only probe.
- Grok `<user_info>` / `<skill_information>` / `<user_query>` envelopes keep
  only the inner query as user-authored text. Session titles participate in
  search matching. Query requests/results are `cchistory-lite-query/v2`.

### Fixed

- `FORCE_COLOR=0` no longer forces TUI color. Only a non-zero `FORCE_COLOR`
  value forces ANSI.
- Cursor Agent `store.db` recovery no longer treats binary blob-graph nodes as
  the user turn. Readable JSON `user_query` messages (or protobuf-style prompt
  fragments when JSON is absent) are projected instead, sibling `meta.json`
  supplies cwd, and the native agent id is shared with matching
  `agent-transcripts` so a default scan does not emit a duplicate garbage
  session. Transcript recency now follows file mtime instead of scan time.
- Delegated child sessions are no longer a Codex-only collection rule. Any
  resolved inbound `delegated_session` whose parent is present in the snapshot
  is kept addressable under that parent and omitted from top-level lists and
  project-browser session rows. Child turns stay on the child and remain
  visible in the parent project bucket. A bare `parent_session_id` on an
  ordinary Grok session is not treated as lineage.

## [0.4.0] - 2026-08-11

### Added

- The JSON-only `query --request <file|->` command batches ordered search, session, and assistant
  reply reads into one scan. Operation failures remain local to their result while successful
  operations are preserved.
- Public schemas for compact reads, canonical reads, batch requests/results, and structured
  errors now ship in the standalone release artifact.
- The Lite CLI now has `latest [sessions|turns] [N]`, default 20-row limits for `ls`, `--all`,
  and lexical `--dir <path>` filtering across session/project lists, latest results, search,
  stats, and `tree projects`.
- Human-readable list and detail output now uses responsive columns, relative times,
  actionable short references, structured metadata, turn/context summaries, and explicit
  truncation counts.

### Changed

- Bare `--json` now emits the breaking compact `cchistory-lite/v2` contract for agents;
  `--json=canonical` retains full canonical evidence under `cchistory-lite-canonical/v1`.
  Compact and query results mark archived content as `untrusted_history` and omit parser internals,
  tool payloads, system messages, and lineage.
- Codex-injected Skills, permissions, and collaboration metadata are classified as masks instead
  of user-authored request text. Assistant replies now carry complete masked `canonical_text` for
  read-only review workflows.
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
