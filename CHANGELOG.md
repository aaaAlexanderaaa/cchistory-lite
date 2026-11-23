# Changelog

All notable changes to CC History Lite are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- DeepSeek Harness source adapter (`deepseek_harness`, experimental): reads the
  current `session.v4.jsonl` / `session.v4.jsonl.zstd` durability log under
  `$DSH_HOME/sessions` (default `~/.dsh/sessions`). Concatenated Zstandard
  frames are decoded in-process with a truncated-tail recovery diagnostic;
  assistant messages supply per-call usage, native tool error status, and
  reasoning; injected harness context stays collapsed as injected user
  messages; tagged fork-seed prefixes are not projected twice; parent
  `subagent/catalog` evidence links delegated child sessions; unsupported
  physical format versions and malformed records are reported instead of
  guessed.
- OpenCode native SQLite history: reads the current
  `session_v2`/`session_message`/`session_part` store, the pre-split v2 store
  (metadata in `session`, no `seq`), and the 1.2-era
  `session`/`message`/`part` store read-only beside the legacy JSON tree, maps
  parts to text/reasoning/tool evidence with token usage, links `parent_id`
  delegated sessions, and suppresses a leftover JSON session only when the
  SQLite store carries the same native session id, so empty or partial stores
  leave JSON history readable.
- Hermes Agent source adapter (`hermes`, experimental): reads read-only
  `$HERMES_HOME/state.db` and `profiles/<name>/state.db` stores. Live message
  rows supply user/assistant/tool evidence, OpenAI-style tool calls, collapsed
  reasoning and `display_kind` filtering; per-model session usage keeps session
  granularity; `model_config` lineage markers link delegated children while
  branch and compression continuations stay top-level. Older stores without
  title/model-config/usage tables still project their transcript.

## [0.8.3] - 2026-11-21

### Added

- Per-call `SessionUsageEvent` telemetry across `codex`, `claude_code`, and
  `antigravity` with causal tool summaries (`preceding_tool_results` and
  `emitted_tool_calls`, masked and capped per call), native tool error status
  (`tool_result.is_error` and Codex exit codes), step/tool duration (`duration_ms`),
  compaction boundaries, and Claude Code sidecar `subagent_key` isolation.
- Canonical usage diagnostics (`usage-call-evaluation.ts`, `usage-tool-patterns.ts`,
  `usage-anomalies.ts`, `usage-trace.ts`): per-call cache-hit distribution
  (`≥90%` / `50–90%` / `<50%` with `0%`-hit counts), Main vs Subagents role split,
  family rollups, normalized tool/command pattern & tight-window polling-loop
  clustering, 6 typed anomalies (`cache_miss_cliff`, `polling_loop`,
  `context_bloat`, `subagent_fanout`, `high_context_cliff`, `tool_error_loop`),
  and single-session/turn call waterfall tracing with honest `usage_granularity`
  reporting (`call` | `turn` | `session` | `unavailable`).
- CLI `cchistory-lite trace <session_ref|turn_ref>` command (`--include-subagents`,
  `--only-anomalies`, `--limit`, `--offset`, `--json`), `stats` extensions
  (`--session <ref>`, `--by family|tool|turn`, `--anomalies`, and default
  `Cache dist` / `Role split` / top-5 `Anomalies` overview lines), compact
  masked `context.tool_summaries` in `show turn --json`, and `diagnose` / `trace`
  operations in `query` and `shell --json`.
- Finite SQL `calls` collection (`SELECT ... FROM calls ... LIMIT N`) exposing
  per-call usage, cache-hit status, miss cause, subagent role, masked primary
  tool signature, and anomaly tags with full parity against `stats` and `trace`,
  plus an editable `docs/guide/queries/anomaly-calls.sql` template.
- TUI interactive diagnostics (`a:Anom` with `g` cycling `Anomalies`, `Families`,
  and `Tools & Loops`) and full-screen `Trace` call waterfall view (`Enter` from
  Anomalies, `T` from `S:Sessions` or the main browser, `f` anomalies-only, `u`
  subagent toggle, `←/→` narrow column paging, `O` jump to session conversation,
  and a pinned 2-line Selected Call Inspector showing causal tool I/O); TUI date/time
  quadrants now display per-bucket `Hit` cache-hit ratios, `R` is renamed to `Reas`
  (Reasoning), and a fixed bottom abbreviation legend stays pinned across views and filters.
- Official OpenAI `gpt-6.2-sol` (`$2/$10/$0.10`) and `gpt-6.2-astra`
  (`$8/$40/$0.40`) list rates per 1M input/output/cache-read tokens
  (2,565 priced models). `codex-auto-review` stays unpriced: ChatGPT-login
  Codex auto-review is free and has no published independent API unit price.

## [0.8.2] - 2026-11-20

### Added

- Canonical usage diagnostics (`usage-diagnostics.ts`) computing cache hit rate,
  estimated cache savings (list and adjusted USD), `>200K` long-context tier call
  counts, 5-component cost shares, dual-marker period quota pace projection
  (actual spend vs elapsed time), 24-hour activity profiles, effective cost
  multipliers, and enriched `by_session` rollups with subagent and tool counts.
- Hourly and 24-hour clock bucketing (`--by hour`, `--by hour_of_day`, TUI
  `hour` / `hour_of_day` buckets) with automatic switch from `day` to gap-filled
  `hour` on `today`, `24h`, and custom windows within 48 hours, `00–23` clock
  activity charts, plus `--by session` session-level spend/token rankings.
- Terminal visualizations in CLI `stats` and the TUI stats dashboard (`i`):
  5-component cost-mix bar, dual-marker quota pace gauge, cache hit rate/savings
  and `>200K` diagnostics strip, gap-filled time trend sparkline, fixed-column
  TUI quadrants with max-normalized 1/8th-block comparison bars, and a redesigned
  TUI Matrix view (`g` grouping presets, unclipped time labels, `In`/`CR`/`CW`/`Out`/`Hit`/`Mult`/`List$`/`Adj$`,
  narrow `←/→` column paging, and a pinned 2-line selected-row inspector).
- TUI Top Sessions drill-down view (`S`, `Enter` to open the session and `i` to
  return to stats), in-memory pricing config export (`E` with store/source/symlink
  destination checks), clipboard copy (`y` resume command, `Y` turn Q&A via OSC 52
  with native clipboard fallback), exit-and-print resume command (`R`), `--dir`,
  `--stats`, and `--since` startup options, on-demand full-conversation search
  (`Ctrl+F`), and 2-character auto-search for CJK queries.
- CLI flags `--content conversation|prompts`, `--prompts-only`, and
  `--group-by session|message` on `search`; `--full` and `--compact` on `show`;
  and full option forwarding on `cchistory-lite tui` (resolving the sibling TUI
  build directly before falling back to `PATH`).
- Official Google `gemini-4-neon` pricing (`$3/$15/$0.15` per 1M
  input/output/cache-read tokens from `models.dev`, 2,563 models total).

### Changed

- CLI `search` now defaults to full conversation search (titles, user prompts, and
  assistant replies) while staying context-light (`--prompts-only` restores
  prompt/title-only mode; `query`/`shell` retain legacy default unless
  `content: "conversation"` is set).
- CLI `stats` now defaults to machine-wide scope (`--dir <path>` narrows to one
  directory; collection commands remain `--dir=$PWD`).
- `show turn` wraps and prints full assistant replies plus `Resume` commands by
  default (`--compact` restores single-line previews); `export --format markdown`
  includes full user prompts and assistant replies grouped by session while
  remaining context-light.
- No-argument `cchistory-lite` and `cchistory-lite help` print a concise
  human-first command overview, delegating detailed flags to `help <command>`
  (generated from the single-source `agent-contract.ts`) and the machine contract
  to `agent`.

## [0.8.1] - 2026-11-18

### Added

- Refreshed 2,562-model offline pricing catalog with pinned LiteLLM additions
  and official Grok 4.7 Build Fast
  rates, including its distinct long-context prices.
- Generic model-name pricing resolution adapted from ccusage: provider prefixes,
  separator spellings, dates, tool suffixes and configured alias chains resolve against
  the catalog, including Grok Build names without per-version mappings. Fast/Flex prices
  and numeric model versions remain distinct; unknown or ambiguous rates retain unpriced tokens.

### Fixed

- Codex statistics retain calls without assistant text or a user turn, cumulative-only
  counters, and separately billed context compactions. Counter resets, repeated
  notifications and inherited summaries preserve independent-call totals.
- Active Codex rollouts take precedence over matching archived copies; default
  discovery includes archived history while explicit source roots retain their scope.
- Usage date filters follow native call timestamps. Growing checkpoints resolve to
  one complete call before model pricing and context-tier selection.

## [0.8.0] - 2026-11-17

### Added

- Multi-dimensional token, cost, multiplier, and quota statistics across CLI `stats`
  and TUI (`i` overlay), correlating Project × Model × Source × Time (`day`/`week`/`month`)
  with separated cache read/write totals, reasoning double-count reconciliation, and
  `turn_id: null` usage event attribution.
- Bundled offline `models.dev/api.json` pricing catalog snapshot with built-in Gemini
  aliases (`gemini-pro-orchestrator` → `gemini-4-carbon`, `gemini-flash-worker-agy` →
  `gemini-4-hydrogen`), model-name suffix normalization, dual-layer cost output
  (`list_cost_usd` vs multiplier-adjusted `adjusted_cost_usd`), period `quota_percent`,
  and `scripts/refresh-models-dev-pricing.mjs` for manual offline catalog updates.
- CLI `stats` multi-axis `--by` matrix output (`--by project,model,source,day`),
  `--model`, `--since`/`--from`/`--to`, `--tz`, `--week-mode`, `--sort`, repeatable
  `--pricing` / `CCHISTORY_PRICING_CONFIG`, inline `--alias`, `--multiplier`,
  `--cache-read-multiplier`, `--cache-write-multiplier`, `--quota`, `--explain-pricing`,
  `--export-pricing`, explicit working-directory scope notices, and additive `--json` v2
  `matrix`/`breakdown`/`model_resolutions` payloads.
- Lite TUI Plan A interactive `2×2` stats dashboard (`Space`/`Enter` cross-filtering,
  `v` full-width matrix breakdown, `m` live in-memory multiplier/alias calibration
  drawer, `$` inline quota editor, `t`/`b`/`w`/`o` window/bucket/week/sort toggles,
  and `--pricing` / `--quota` startup flags forwarded from `cchistory-lite tui`).
- Direct read-only Antigravity 2.32.1 SQLite history and per-model token usage
  (`~/.gemini/antigravity/conversations/*.db`), including cache reads/writes,
  reasoning output, tool-only turns, and assistant-only delegated sub-sessions.
- Independent native model-call usage events on sessions (`usage_events`) so
  mixed-model user turns attribute token spend to each recorded model in
  `stats --by model` and TUI model rollups while preserving unique turn counts.
- Experimental `grok_bot` source for Grok Bot sidebar agents (`~/agent-data` /
  `~/sand-data`), with SQLite conversation evidence preferred over duplicate JSONL.
- Grok Bot titles prefer `profile.json`, then `SAND_AGENT_PROFILE_UPDATE`, then
  the first real user message; hidden prompts remain injected evidence.

### Fixed

- Lower workspace packages (`domain`, `canonical`, `source-adapters`, `live-runtime`)
  are now explicitly blocked from importing `lite-cli` or `lite-tui` in both
  `architecture-rules.json` and `verify-lite-boundaries.mjs`.
- Lite TUI `contextOverlay` uses a bounded LRU cache that refreshes stale
  overlay entries on targeted rescans, and unlinked bucket activity derives from
  canonical `resolveLatestTurnActivityAt` instead of turn-array tail order.
- Anchored root `tmp/` in `.gitignore` and restored the eight missing sanitized
  Gemini CLI fixture files under `mock_data/.gemini/tmp/`.

- Grok Bot canonical titles use shared masking before truncation for user, profile
  and recovered names. Fully masked titles do not fall back to raw evidence.
- Empty, malformed and non-conversation-only Grok Bot stores allow JSONL fallback
  while retaining unexpected evidence and parse diagnostics. Store preference is
  based on the current parse, so WAL inserts/deletes are visible after refresh.
- Grok Bot hidden-prompt and title cleanup rules apply only to that source;
  other sources preserve literal markers, turn tags and timestamp text.
- Grok Bot store messages with missing or unsupported roles retain unknown
  evidence and diagnostics without suppressing JSONL fallback.
- Opaque Grok Bot `conversation-blobs.db` caches are excluded from companion capture.
- Grok Bot fixtures participate in layout and sanitization validation.

## [0.7.0] - 2026-10-14

### Added

- Agent `read` operations return bounded user/assistant evidence with stable session,
  turn and message references, Unicode-safe continuation and content-bound cursors.
- Query/shell `search` accepts `content: "conversation"` to search full masked user
  and assistant text. Delegated hits appear under the parent while citing the child.
- History JSON responses expose `read` identity and `read_status`, separating known
  source losses, unknown directory attribution and scan limits from SQL coverage.
- Optional `--diagnostics` on CLI history reads and shell emits structured progress,
  stage/attempt timings, live allocation decisions and cache/read identity on stderr,
  preserving stdout results and excluding transcript/tool bodies and query text.
- Conversation search accepts `group_by: "message"` to page older matching answers,
  decisions and reversals within a session while preserving delegated citation identity.

### Changed

- Shell reuses bounded detail snapshots and directly targets sessions resolved from
  the collection. Successful refresh clears detail reuse; failed refresh preserves it.
- Agent guidance leads with bounded evidence retrieval and loads advanced details on demand.
- Evidence pagination prepares immutable content once; bounded page/rank caches and
  stable snapshot-time scores reduce repeated work during a recall session.
- Context-light reads omit discarded tool/system display formatting while preserving
  assistant masking, canonical identity, linking, ordering, tool association and usage.
- AMP and ZCode reuse decoded records with exact byte accounting, and large JSONL uses
  faster delimiter lookup and bounded buffer/tail retention to reduce first-read work.

### Fixed

- A missing session reference in a query/shell detail batch returns an operation-level
  error while preserving valid results; genuine scan failures still propagate.
- Large ZCode databases admit a compact inventory and individual native values instead
  of materializing whole-source message/part bodies. Inventory admission avoids repeated
  body-length calculation and sorting; native sources remain read-only.
- Large Codex, Claude and Factory JSONL parses records as they arrive and checks growing
  record admission during checksum capture and parsing. Small files keep buffered reads.
- Guarded whole-file reads use live allocation headroom instead of the unguarded 64 MiB
  fallback cap; explicit limits and memory protection remain binding.
- The agent schema now agrees with the existing adaptive launcher and live-headroom
  memory policy, without changing the launcher policy.

## [0.6.0] - 2026-09-17

### Changed

- Concurrent native writers are treated as normal. JSONL appends and SQLite
  WAL/SHM updates no longer abort a scan. Version-dependent query
  optimizations fall back to an ordinary read when selection evidence
  changes; the snapshot may lag the writer.
- Preflight memory estimates warn and proceed instead of refusing the whole
  scan. Each payload read is priced against live headroom (temporary input
  bytes are not charged for the rest of the scan). An input that exceeds
  that budget leaves diagnostics; other readable history is retained. The
  watchdog reserve is capped at 512 MiB.
- CLI and TUI launchers grow Node's default heap to half the
  available-memory estimate when that materially exceeds the current
  default. Explicit Node heap flags and `NODE_OPTIONS` are preserved;
  library callers keep the caller heap.

### Fixed

- Reading Cursor / ZCode SQLite while the host app is writing no longer
  fails the scan with `source_read_plan_changed`.
- A large aggregate estimate (for example a 1 GiB file ×4) no longer
  prevents startup. Oversized individual inputs are skipped with
  diagnostics instead of blocking the rest of the read.

## [0.5.0] - 2026-09-08

### Added

- Finite PostgreSQL-style `SELECT` over canonical history: `query --sql`,
  `query --sql-file`, and one complete SQL line in `shell`. Bind `$1…$N`
  with `--params` (a JSON array of scalars). `LIMIT` is required (1–1000);
  `OFFSET`, typed comparisons, `IN`, `BETWEEN`, `LIKE`, and up to three
  `ORDER BY` fields are supported. There is no join, subquery, aggregate,
  mutation, or native SQL execution — the AST is allowlisted and lowered
  into the in-memory collection executor. Guide and bound templates:
  [`docs/guide/query.md`](docs/guide/query.md).
- Query contract `cchistory-lite-query/v3` / `cchistory-lite-query-result/v3`.
  Existing v2 operation batches remain valid. SQL returns selected public
  columns; default `total` is null. `--complete` requests the exact matching
  total and exhaustive diagnostics. `coverage` reports complete vs selective
  execution.
- Shell `--idle-timeout` (default 300 seconds, maximum 86400; `0` disables).
  The timer runs only while waiting for input. A shell opens without scanning
  and prepares on the first valid collection read or explicit `refresh`.
- Native-byte read budgets and `read_budget_exceeded` on the error envelope
  when an admitted source file or SQLite container exceeds the scan budget.
- Metadata-only `sources` (and `ls sources`) by default, emitting
  `cchistory-lite-source-inventory/v1`. `--complete` still runs the counted
  sources report.

### Changed

- Collection commands (`latest`, `ls`, `sample`, `search`, and SQL) share
  one logical query executor. Observable output of existing commands and v2
  JSON is preserved; replaced filtering/ordering/pagination paths are gone.
- One Codex latest-sessions SQL shape can skip full interpretation of older
  sessions after native timestamp bounds are established. Other predicates,
  sources, and `--complete` still take the complete path. File mtime is never
  a conversation-time bound.
- Scan admission prices remaining V8 heap and a corrected macOS memory
  signal (free + inactive pages, not libuv's free-pages-only reading).
  Adaptive heap re-execution and the internal
  `CCHISTORY_ADAPTIVE_NODE_MEMORY_MB` launcher marker are removed. Lite does
  not set the Node heap limit. `sample` and exact-id `show session` still
  bypass the advisory lock, but they no longer skip memory admission.
- Semantic masks, evidence atoms, parsed-session types, and token evidence
  live in `@cchistory/domain`. Adapters stop at the parse boundary;
  `canonical` owns interpretation.

### Fixed

- Directory-scoped JSON now reports `diagnostics.directory_scope`, including
  sessions excluded because they have no working directory. Surfaces do not
  widen scope to recover those rows.

## [0.4.5] - 2026-09-02

### Fixed

- `--dir` now bounds the pre-flight memory estimate to the source files a
  scan would probe for that working directory, including Codex first-cwd
  rejects. Unscoped commands (`sources`, `export`, `--no-dir`) still price
  every regular file under the selected roots.

## [0.4.4] - 2026-09-01

### Changed

- Agent-facing CLI teaching: `--help` now leads with `cchistory-lite agent`,
  `sample`, `--source <slot>`, and `ls sources --limit-files 1` so a
  `head -60` still sees the path. `help <command>` and `<command> --help`
  print that command's contract instead of dumping the full synopsis.
  `--dir` is described as a working-directory filter, not a memory bound;
  scan-guard refusals list the selected source roots and sizes, point at
  `sample` / `--source` / `--limit-files` / `ls sources --limit-files 1`,
  and say when `--dir` is already on. Unknown adapter errors list registered
  slots (`claude` → `claude_code`). `sources` rejects `--dir` / `--no-dir`
  with the next bounded command instead of a dead-end flag error.

## [0.4.3] - 2026-08-31

### Added

- `cchistory-lite agent` prints the versioned machine-readable contract
  (`cchistory-lite-agent/v1`): every command's flags, enums, and defaults, exit
  codes, environment variables, output schemas, the trust model, the
  cannot-do list, and the cost model — with the scan-guard numbers imported
  from the runtime so documentation cannot drift from implementation.
  `agent skill` / `agent guide` print the bundled agent docs. New long-form
  manual `docs/guide/for-agents.md` (data flow, cost model, concurrency
  discipline, error taxonomy, recipes); the guide and the agent skill now
  ship inside the npm package, and `--help` points agents at the contract.
- Scan guard: full scans now fail fast instead of pushing the host into
  swap-death. The V8 old-space ceiling derives from *available* memory (half,
  capped at 4 GiB, floored at 512 MiB, falling back to the old total/2 when
  availability is unknown); an advisory lock in `$XDG_RUNTIME_DIR` serializes
  full scans (30s bounded wait; `sample` and exact-id `show session` bypass);
  a watchdog aborts a scan when available memory drops below
  max(512 MiB, 5% of total); and a pre-flight estimate refuses scans whose
  conservative peak exceeds 75% of available memory (warning above 50%).
  Refusals exit 1 with `scan_guard_refused` / `scan_guard_aborted` in JSON
  mode and teach `--source` / `--dir` / `--limit-files` / `sample` /
  `shell` / `query`. `CCHISTORY_SCAN_GUARD=0` disables the lock, estimate,
  and watchdog.
- Releases are cut by the manually-dispatched Release GitHub Actions
  workflow: `scripts/release-prepare.mjs` validates the version (strict
  semver, strictly greater, no existing tag, non-empty Unreleased), bumps all
  7 package.json files and the baked CLI/TUI VERSION literals, and folds the
  changelog; the workflow runs the four gates, publishes with
  `npm publish --provenance`, then commits, tags,
  pushes, and creates a GitHub Release with the tarball. `RELEASING.md`
  documents the process, and the artifact package.json now carries
  `repository` / `homepage` / `bugs` so provenance links back to this repo.

### Changed

- README install and usage now lead with the published
  [`@cchistory/lite`](https://www.npmjs.com/package/@cchistory/lite) package
  (`npx` / `npm install -g`) now that 0.4.2 is on npm.

- Human CLI collection commands (`ls`, `latest`, `sample`, `search`, `stats`,
  `tree projects`) now default to the current working directory, same as
  `--json` / `query` / `shell`. `sample` no longer stays unscoped. Pass
  `--no-dir` for a whole-machine scan. Human (non-JSON) runs print the chosen
  scope on stderr before the scan starts, or a memory warning when `--no-dir`
  is set. TUI and `export` still scan every selected source.

### Fixed

- Markdown `export` used the full-scan memory estimate (×8) even though it
  discards turn context after projection. It now uses the light profile (×4),
  matching the actual scan; JSON/JSONL export still uses the full estimate.

- `cchistory-lite --help` now documents `--offset`, `--project`, `--by`,
  `--format` / `--out`, and `help [command]`, and no longer mentions a
  nonexistent `--total` flag. A two-way test audits documented flags against
  the real parser in both directions.

- Project last-activity clocks follow the last real turn, not scan-time
  empty-session observations. The TUI and CLI share one relative-time
  formatter; turn-group headers count the contiguous run instead of repeating
  the session-wide total; and the session pane hides 0-turn stubs that have
  no related work.

## [0.4.2] - 2026-08-30

### Added

- `@cchistory/lite` is the public npm package for this release closure.
  `npx @cchistory/lite` and `npm install -g @cchistory/lite` install the same
  CLI/TUI as the extract-and-run tarball. Workspace packages stay private.
  The `lite` bin is an alias of `cchistory-lite`.

### Changed

- The standalone tarball stem is `cchistory-lite-<version>.tgz` (no
  `standalone` suffix). Extract-and-run launchers are unchanged.
- Human-readable CLI collections replace the bold-title/all-gray cards with
  semantic field colors: the title is the only bold field and carries green
  on the identity line after the model; the identity line shows the source
  tool in blue with the model in magenta; working directories are white,
  including the `cd` target inside a resume command; counts, timestamps,
  session references, and the rest of a resume command stay gray. Cursor
  prompt-history fallback sessions omit the truncated `session prompt-h…`
  id and `tokens n/a`. The renderers emit styles directly instead of the old
  regex post-painter, and non-TTY / `NO_COLOR=1` output remains pure text.

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
