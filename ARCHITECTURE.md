# Architecture

CC History Lite is a read-only pipeline. It turns native on-disk agent history into a canonical
in-memory snapshot, and never persists anything of its own.

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
and has no dependencies.

### `@cchistory/canonical`

Storage-neutral semantics shared by every reader:

- project linking and fallback project observations (`project-linker.ts`, `fallback-projects.ts`)
- read ordering (`read-order.ts`)
- search matching and ranking (`search.ts`)
- related-work projection (`related-work.ts`)
- usage aggregation (`usage.ts`)

This layer decides *what history means*. It must never learn where history is stored.

### `@cchistory/source-adapters`

The 14 adapters, plus the probe that drives them. Each adapter knows one tool's on-disk layout
and normalizes it into atoms, blobs, sessions, and candidates. The layer **stops at the parse
boundary**: it produces a probe payload and hands it off. It never materializes a snapshot and
never reaches forward into the runtime.

Sources are scanned one at a time so each raw payload is released before the next begins.
Adapters declaring `logicalSessionGrouping: "source_session_id"` (Codex, Claude Code) are
projected one logical session at a time.

### `@cchistory/live-runtime`

Materializes a probe payload into a `LiveHistorySnapshot` — the in-memory equivalent of a
queryable store. It applies the canonical layer's linking, ordering, search, and usage logic
and exposes the read API the surfaces consume (`listProjects`, `listResolvedSessions`,
`listResolvedTurns`, `getTurnContext`, `search`, `getUsageOverview`, …).

It also owns two runtime policies:

- **Adaptive memory** (`node-memory.ts`): computes `min(host memory / 2, 4096 MiB)` and re-execs
  the process with `--max-old-space-size`, guarded by an env marker so it respawns only once.
- **Source-root guarding** (`assertLiteSourceRoot`): refuses any path containing a `.cchistory`
  segment, any `cchistory.sqlite`, any path overlapping `~/.cchistory`, and any Full bundle root
  (a directory holding both `manifest.json` and `payloads`).

### `@cchistory/lite-cli` and `@cchistory/lite-tui`

Two thin surfaces over the same runtime. The CLI is one-shot: scan, render, exit. The TUI holds
exactly one snapshot for the process lifetime and pages over it. Neither contains history
semantics of its own — anything they compute would be a bug in layering.

## Context discipline

Reading full assistant/tool context for every turn is the expensive path, so it is opt-in:

| Caller | Context mode |
| --- | --- |
| `sources`, `ls`, `tree`, `search`, `stats`, TUI startup | `none` — context dropped after deriving turns |
| `show session`, `show turn`, JSON/JSONL `export` | `full` |
| TUI `turn <ref>` | targeted `full` rescan of that one logical session |

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
