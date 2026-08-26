# Lite `sample` mode

Date: 2026-08-27
Status: approved for implementation
Branch: `audit/adapter-parse-quality`

## Problem

On a busy host, every `latest` / `search` / `show` rebuilds a full in-memory snapshot. That can
mean thousands of session files (this machine: ~2k Claude jsonl, ~1k Codex jsonl, ~270 Grok
sessions). Developers and users cannot iterate on “what will Lite show on *this* machine?” at that
cost.

`--limit-files` is the wrong bound: it is alphabetical, does not promote delegated children to
their parents, and does not look like `latest`.

## Goal

`cchistory-lite sample` is a **fast approximation of `latest sessions`**: same fields, same
top-level-session rule, bounded work. Timestamps inside the sample may differ slightly from a
full scan. It is not a health report, not random, not alphabetical, and not a new recency
contract.

## Command

```
cchistory-lite sample [N] [--source <slot>] [--dir <path>] [--json]
```

- `N` defaults to 50 and is a **per-source cap on top-level sessions shown**.
- Default scope is the whole machine (no `--dir`). `--dir` / `--source` / `--source-root` work as
  elsewhere.
- Not wired into the TUI, `query`, or `shell` in this change.
- `--json` / `--json=canonical` use the existing session list shape.

Human output reuses the `latest sessions` renderer. One banner above it states that this is a
sample, not a complete host scan. JSON is `cchistory-lite/v2` with `kind: "sessions"` plus:

- `sampled: true`
- `sample_per_source: N`
- `sample_notes` (optional short strings: files skipped by cwd, parents promoted)

Callers must not treat a sample snapshot as a full projection-contract census.

## Selection (cheap, then parse)

Semantics stay in `live-runtime` + adapters. The CLI does not pick files.

For each selected source:

1. List native session files from the adapter `base_dir` (custom `--source-root` / `GROK_HOME`
   already flow through `getSourceRoots`). No hardcoded homedir paths.
2. Cheap `--dir` rejection without opening conversation bodies, when the layout allows it
   (Grok URI-encoded cwd; Claude/Factory sanitized project folder; Cursor transcript slug).
   Uncertain encodings are kept. Codex has no cwd in the path: read the first `session_meta`
   line only.
3. Cheap rank that tracks **conversation activity**, not protocol noise:
   - Grok: `summary.json` `last_active_at` (session envelope clock). Do not use
     `updates.jsonl` / `events.jsonl` / `signals.json` mtime.
   - Claude / Codex / others with a conversation jsonl: that file’s mtime. Do not use SQLite
     WAL, companion blobs, or terminal logs.
   - Missing clock → keep the candidate but sort it after timed ones (still not random, not
     alpha-as-primary).
4. Walk that ranked list until **N top-level sessions** are filled:
   - If the file is a delegated child (Grok `summary.session_kind` in
     `subagent|subagent_resume|subagent_fork` + parent id; Codex first-line
     `thread_spawn.parent_thread_id`; Claude `…/subagents/` path), **parse and display the
     parent** instead. The child may still be probed as family evidence for that parent.
   - The parent consumes one slot of N.
   - If the parent cannot be resolved, keep the child and mark it in `sample_notes`.
5. `runSourceProbe` only those files (parents + attached children). Then the normal canonical
   snapshot + `orderSessionsByLastMessage` **within the sample**.

Allowed error: a session that is globally newer can be missing if its cheap clock lagged; a
session in the sample can sort a few seconds off a full scan. Not allowed: showing 50 subagents
and zero parents; claiming the list is complete.

## Out of scope

- Changing `latest` to this bound.
- Ranking `latest` by filesystem mtime (rejected: live Grok subagents, Claude sidecar appends,
  2026-06-29 bulk mtime clobber, Cursor WAL).
- Sampling search/stats/TUI.
- Persistent index (zero-store).

## Tests

- Fixture: a source whose newest cheap-clock files are all delegated children → sample shows the
  parent, omits the child from top-level rows, parses both.
- Fixture: `--dir` + sample does not open files whose encoded/sanitized layout cannot match.
- JSON: `sampled: true`; human banner present.
- Existing `latest` tests unchanged.

## Implementation sketch

- `ScanLiteHistoryOptions.sample?: { perSource: number }`
- Adapter helpers for cheap session catalog (cwd preview, grok summary clocks/kind, first-line
  Codex cwd/parent). Keep them in `source-adapters`; ranking + cap in `live-runtime`.
- CLI: new command, reuse `runLatest` rendering.
