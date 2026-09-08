# Architecture

CC History Lite is a read-only pipeline. It turns native on-disk agent history into a canonical
in-memory snapshot, and never persists anything of its own.

This file describes the current working-tree architecture; commit/release status is recorded in
`PLAN.md`. The historical goal-oriented working note
[`docs/design/2026-09-04-goal-oriented-architecture-rethink.md`](docs/design/2026-09-04-goal-oriented-architecture-rethink.md)
re-examines assumptions from observed user workloads. The approved finite query contract is
[`docs/design/2026-09-06-query-contract-v1.md`](docs/design/2026-09-06-query-contract-v1.md);
broader ideas in the earlier notes are not additional approved requirements.

Current delivery status, remaining milestones, and stopping conditions are tracked in
[`PLAN.md`](PLAN.md). Open questions in design notes are not an automatic implementation queue.

## The chain

```
apps/lite-cli ─┐
               ├─→ packages/live-runtime ─→ packages/source-adapters ─┐
apps/lite-tui ─┘             │                                        ├─→ packages/domain
                             └────────────→ packages/canonical ───────┘
```

Dependencies point one way only. Nothing below depends on anything above it, and no package in
the chain depends on a persistent store.

### `@cchistory/domain`

Canonical type definitions and projections — `SessionProjection`, `UserTurnProjection`,
`ProjectIdentity`, source status, usage shapes. Pure types and pure functions; performs no I/O
and has no dependencies. `ParsedSessionEvidence` and `SessionInterpretation` define the borrowed
evidence boundary; shared masking and token-value operations retain one implementation here.
`LogicalQuery` and `CanonicalQueryResult` define the finite collection-query boundary.

### `@cchistory/canonical`

Storage-neutral semantics shared by every reader:

- session interpretation, submission boundaries, token-to-reply association, and complete contexts
  (`session-interpreter.ts`)
- project linking and fallback project observations (`project-linker.ts`, `fallback-projects.ts`)
- read ordering (`read-order.ts`)
- collection row projection, predicates, ordering, pagination and common templates (`query.ts`)
- search matching and ranking (`search.ts`)
- related-work projection (`related-work.ts`)
- usage aggregation (`usage.ts`)

This layer decides *what history means*. It must never learn where history is stored.

### `@cchistory/source-adapters`

The 16 adapters, plus the probe that drives them. Each adapter knows one tool's on-disk layout
and normalizes it into parsed session metadata, atoms, edges, and provenance. Runtime explicitly
supplies the canonical interpreter when calling `runSourceProbe`; the collector invokes it after
native reconciliation and assembles its results with source diagnostics into a probe payload.
There is no adapter-owned projection implementation or default interpreter, and neither sibling
package imports the other. It never materializes a snapshot or imports the runtime.

The collector still hydrates native draft metadata, performs source-specific cross-file
reconciliation, and decodes question schemas. The interpretation boundary currently builds full
contexts eagerly; `contextMode: "none"` drops them later. It is not yet a bounded parsed-unit
contract or a guarantee that optional detail construction has been implemented.

Sources are scanned one at a time so each raw payload is released before the next begins.
Adapters declaring `logicalSessionGrouping: "source_session_id"` (Codex, Claude Code) are
projected one logical session at a time.

Codex also supplies bounded-line native activity evidence for one selective query plan: session
identity, timestamp upper bounds and tool names. These are facts for runtime planning, not an
adapter-owned interpretation of latest or delegated eligibility.

### `@cchistory/live-runtime`

Materializes a probe payload into a `LiveHistorySnapshot` — the in-memory equivalent of a
queryable store. It applies the canonical layer's linking, ordering, search, and usage logic
and exposes the read API the surfaces consume (`listProjects`, `listResolvedSessions`,
`listResolvedTurns`, `getTurnContext`, `search`, `getUsageOverview`, …).

The finite SQL frontend parses in an isolated worker and positively validates into `LogicalQuery`.
`scanLiteQuery` chooses complete reads or the single proven Codex latest read policy; both use
the same probe, canonical interpreter and query executor. Selective execution checks every admitted
file's activity bound, then can skip older groups before full payload interpretation. It does not
avoid inventory I/O and never exposes a partial materialization as a reusable full snapshot.
Uncertain evidence uses the complete read policy; changed admitted evidence aborts the attempt.

Additional runtime policies include:

- **Memory admission** (`system-memory.ts`, `scan-guard.ts`): Node owns its heap limit;
  launchers never resize it or create an adaptive child. macOS estimates available memory
  from free + inactive pages; Linux combines MemAvailable with known cgroup headroom.
  Preflight and native-byte admission consider the smaller of that estimate and remaining
  V8 heap; refusal diagnostics distinguish both. The watchdog reserves 25% of the initial
  system estimate. Unavailable macOS telemetry stays unknown; heap admission still applies.
- **Source-root guarding** (`assertLiteSourceRoot`): refuses any path containing a `.cchistory`
  segment, any `cchistory.sqlite`, any path overlapping `~/.cchistory`, and any Full bundle root
  (a directory holding both `manifest.json` and `payloads`).

### `@cchistory/lite-cli` and `@cchistory/lite-tui`

Two thin surfaces over the same runtime. The CLI is one-shot: read, render, exit. The TUI and `shell`
each own one current snapshot and page over it; shell prepares on its first valid read; successful refresh replaces it. The shell closes
on exit/EOF or configurable idle expiry (300 seconds by default). CLI/shell latest/list selections,
v2 operations and SQL use shared canonical templates/execution; compatibility is input/output
adaptation, with the replaced selection branches removed. Neither surface contains history
semantics of its own — anything they compute would be a bug in
layering. CLI `search` projects matching turns into one row per top-level session; the TUI
search pane still lists turns.

## Context discipline

Reading full assistant/tool context for every turn is the expensive path, so it is opt-in:

| Caller | Context mode |
| --- | --- |
| `sources`, `ls`, `latest`, `tree`, `search`, SQL `query`, `show project`, `show source`, `stats`, markdown `export`, `shell` startup, TUI startup | `none` — context dropped after deriving turns |
| `show session <complete-canonical-id>` | targeted `full` scan of that one logical session |
| `show session <fuzzy-ref>`, `show turn <ref>` | one `matching` scan; context retained only for possible resolver matches |
| JSON/JSONL `export` | `full` |
| TUI `turn <ref>` | targeted `full` rescan of that one logical session |

Every adapter declares whether session targeting happens by file, within a
multi-session container, or as a hybrid. File-capable adapters narrow the file
set before parsing; container adapters filter native rows/seeds before canonical
projection. Target misses are errors and never fall back to a full result.

Directory scope remains canonical semantics, but the runtime may use adapter
metadata as a conservative scan plan. Codex and Claude Code inspect session ids,
cwd fields, and their canonical ordering keys in a bounded worker pool before
projection. A resolved non-matching logical session is skipped; missing,
malformed, cross-file conflicting, or otherwise uncertain cwd evidence always
falls back to the full read-only probe.

## Enforced boundaries

The layering above is checked mechanically, not trusted:

- **`architecture-rules.json`** + `scripts/verify-architecture-boundaries.mjs` — scans production
  sources (tests excluded) for forbidden imports per rule. A rule matching zero files fails as a
  *vacuous rule*, so rules cannot silently rot into no-ops.
- **`scripts/verify-lite-boundaries.mjs`** — walks the production dependency graph from
  `live-runtime`, `lite-cli`, and `lite-tui`, and rejects any dependency on a persistent store or
  server application, at both the manifest and the import level.

Both run in CI. `pnpm run verify:governance` runs the first; `pnpm test` runs the second.

## Zero-store guarantees

| Guarantee | Where it is enforced |
| --- | --- |
| No store is created or read | `assertLiteSourceRoot`, plus tests asserting `~/.cchistory` never appears |
| `--store` / `--db` are impossible | Rejected at argument-parse time in both binaries |
| Sources are never written | SQLite sources opened `readOnly: true`; adapters have no write path |
| Export cannot masquerade as a backup | Schema `cchistory-lite-export/v1`, no import command, destination validated against source roots and store paths |
| No mutation commands exist | `sync`, `import`, `backup`, `restore`, `merge`, `gc`, `migration`, `agent` are explicitly blocked |

## Fixtures

`mock_data/` holds sanitized transcripts for every adapter, and is the sole input to the test
suite. Tests must never depend on real user history, and real history must never be committed.
