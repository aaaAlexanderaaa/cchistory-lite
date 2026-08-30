# Changelog

All notable changes to CC History Lite are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Container sources (zcode, lobechat, and the SQLite parts of hybrid sources)
  no longer attribute the whole database file to one session and 0B to the
  rest. A shared blob's bytes are split proportionally to each session's raw
  record bytes — no extra queries, the records are already in memory from
  parsing — and contributions carry `shared_storage` with the estimated share
  and the container total. SQLite blobs are marked shared even when the
  snapshot currently contains only one session from that store, so Zcode and
  single-composer Cursor workspace DBs render as `≈12KB of 10.0MB db` instead
  of an exact-looking exclusive file size. A filtered leftover session keeps
  its own proportion rather than inheriting the whole database. Session cards
  keep the `≈` marker when the parent also has subagents. Sessions with zero
  bytes omit the storage hint instead of showing `0B`. Atom-based stats (tool
  calls) for container sessions also stay on their own session instead of
  collapsing onto the first record owner.
- Codex session titles no longer take the injected
  `<recommended_plugins>` catalog as the first 72 characters of the user
  turn. That envelope is classified as injected scaffolding, same as
  AGENTS.md and `<environment_context>`, so the card title is the actual
  request.

### Changed

- Human-readable CLI collections replace the bold-title/all-gray cards with
  semantic field colors: the title is the only bold field and carries green
  on the identity line after the model; the identity line shows the source
  tool in blue with the model in magenta; working directories are white,
  including the `cd` target inside a resume command; counts, timestamps,
  session references, and the rest of a resume command stay gray. Cursor
  prompt-history fallback sessions omit the truncated `session prompt-h…`
  id and `tokens n/a`. The renderers emit styles directly instead of the old
  regex post-painter, and non-TTY / `NO_COLOR=1` output remains pure text.

## [0.4.2] - 2026-08-29

### Added

- `@cchistory/lite` is the public npm package for this release closure.
  `npx @cchistory/lite` and `npm install -g @cchistory/lite` install the same
  CLI/TUI as the extract-and-run tarball. Workspace packages stay private.
  The `lite` bin is an alias of `cchistory-lite`.

### Changed

- The standalone tarball stem is `cchistory-lite-<version>.tgz` (no
  `standalone` suffix). Extract-and-run launchers are unchanged.

## [0.4.1] - 2026-08-28

### Added

- `cchistory-lite sample [N]` previews at most N top-level sessions per source
  (default 50) with the same row shape as `latest sessions`. Delegated children
  are replaced by their parent. JSON sets `sampled: true`. This is not a complete
  host scan and does not change `latest` recency.
- Grok `updates.jsonl` `turn_completed.usage` is parsed into turn token totals
  (including `cachedReadTokens` / `reasoningTokens`). Chat-history lines still
  have no native timestamp; turn clocks come from those update events. The
  sidecar is streamed; thought/tool/status events are never materialized as
  raw records.
- Read-only delegated-session family inventory: `ls families`, compact session
  rows with `storage_bytes` / `delegated_child_count` / `family_storage_bytes`,
  and `show session` / `query` family blocks with per-child input/output
  previews, origin paths, token totals, and tool success/error counts. Codex
  and Grok children remain separate sessions; Claude `/subagents/` transcripts
  and Cursor nested `agent-transcripts/<parent>/subagents/` files are inventoried
  as sidecar or path-linked children. Lite still does not delete native history.
- `cchistory-lite shell` holds one directory-scoped snapshot in memory. TTY
  sessions use human subcommands; `--json` or a non-TTY stdin uses JSON-lines
  (`search` / `latest` / `list` / `session` / `replies`, plus `refresh` and
  `exit`). Refresh is explicit.
- `query` operations `latest` and `list` batch recency and collection reads
  into the same scan as search, session, and replies.
- `--no-dir` opts out of the JSON/query/shell current-directory default.
- Vendor-neutral agent skill `skills/using-cchistory-lite/` plus lookup
  recipes in the Lite guide. Copy or symlink the skill directory into a
  host agent’s skill path for auto-discovery.
- Experimental `cursor_agent` adapter reads Cursor Agent CLI transcripts from
  `~/.cursor/projects/<slug>/agent-transcripts/*.jsonl`. It is opt-in via
  `--source cursor_agent` so a default scan does not duplicate the same
  transcripts already merged by stable `cursor`.
- Experimental `grok` adapter reads official Grok CLI sessions from
  `~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl`, using
  `summary.json` for title/model/cwd. `signals.json` and subagent
  `meta.json` stay companion evidence; `updates.jsonl` is streamed for
  `turn_completed` usage/clocks and is not captured as a whole-file blob.
  Sibling subagent sessions are linked through `parent/subagents/*/meta.json`
  (and a `session_kind` of `subagent` / `subagent_resume` / `subagent_fork`
  only when that summary also names the parent). Synthetic user rows
  (`project_instructions`, `system_reminder`, …) stay out of UserTurns.

### Fixed

- Targeted `show session sess:…` on source-boundary adapters (Grok, Factory,
  Cursor, OpenClaw, …) probes matching files again instead of parsing the
  whole source. `sample --dir` on Codex applies the first-line cwd preflight
  before the per-source cap, so older in-scope sessions are not dropped in
  favor of newer files outside the directory.
- `sample` ranking inspects at most four candidate files at a time and reads
  each Grok `summary.json` once. `perSource < 1` selects nothing.
- Grok `updates.jsonl` no longer loads the whole event stream into one string
  and then one raw record per line before dropping non-usage events. It is
  also omitted from whole-file companion blob capture; usage still comes from
  the streamed `turn_completed` records.
- Compact family `input_preview` / `output_preview` mask the full spawn text
  before the 240-character cut, so secrets that straddle that cut still match
  the compact templates.
- Targeted `show session` on a delegated parent keeps child sessions
  addressable so family `child_session_ref` resolves, while children stay out
  of top-level collections.
- Family listings overlay the richer child-session contribution when
  parent-side spawn stats are incomplete.
- `cchistory-lite` / `cchistory-lite-tui` launchers report dynamic-import and
  heap-relaunch failures instead of exiting 1 with an empty stderr.
- Compact family `input_preview` / `output_preview` use the same mask templates
  as other compact JSON. `show session` on a delegated child no longer renders
  the parent family's storage and sibling list.
- `ls families` no longer treats Claude message `parentUuid` / sidecar
  `isSidechain` fragments as parent sessions. Sidecar children stay under the
  real parent; unresolved related-work parents stay internal for child-only
  merge and are omitted from family listings.
- The Node `ExperimentalWarning` for built-in `node:sqlite` is documented in
  the README and suppressed before adapters load. Lite still does not create a
  SQLite store; Cursor / Antigravity / ZCode native databases stay read-only.
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
- GitHub Actions governance job sets `package-manager-cache: false` so
  setup-node v5 does not fail when that job never installs pnpm packages.

### Changed

- `--dir` rejects Claude / Factory project folders, Cursor `agent-transcripts`
  slugs, and Grok encoded-cwd trees from the path (relative to each adapter
  root) before opening conversation bodies. Codex `--dir` preflight uses the
  first session cwd line instead of streaming the whole JSONL. Parent project
  folders and later Codex cwd lines are not opened: retry `--dir` at the repo
  root or `--no-dir` if a subdirectory listing is empty.
  `show session sess:…` (including a unique id prefix) no longer does a
  whole-source resolution scan first.
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
