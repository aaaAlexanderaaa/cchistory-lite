# CC History Lite Guide

CC History Lite is a single-machine, zero-store history reader. It reads
registered tools' native history through the adapters and canonical derivation
pipeline in this repository, keeps the resulting snapshot only in process
memory, and releases it on exit.

Lite does not read or create `~/.cchistory`, does not accept `--store` or
`--db`, and has no sync, import, merge, backup, restore, GC, migration, API, or
background-service surface. Upstream tools' own SQLite databases remain valid
source data and are opened by their adapters read-only.

## Build And Run

```bash
pnpm --filter @cchistory/lite-cli build
pnpm --filter @cchistory/lite-tui build

# One-shot CLI
pnpm lite sources
pnpm lite ls projects
pnpm lite search "parser regression"

# Process-lifetime terminal browser
pnpm lite:tui
```

The package binaries are:

- `cchistory-lite`
- `cchistory-lite-tui`

To use them from any directory without the `pnpm lite` wrapper, link them
globally:

```bash
pnpm run lite:link      # installs cchistory-lite
pnpm run lite:tui:link  # installs cchistory-lite-tui (needed for `cchistory-lite tui`)
```

Re-run the link commands after rebuilding to pick up changes; remove them with
`npm unlink -g @cchistory/lite-cli` / `npm unlink -g @cchistory/lite-tui`.

For a receiving machine without this repository or its private workspace links,
build the self-contained two-binary artifact:

```bash
pnpm run lite:artifact
pnpm run verify:lite-artifact
```

Extract `dist/lite-artifacts/cchistory-lite-standalone-<version>.tgz` and run
`bin/cchistory-lite` or `bin/cchistory-lite-tui`. The artifact vendors the
complete Lite runtime dependency closure.

## Source Selection

With no source flags, Lite scans registered adapters whose default roots exist
on the current machine. Override one adapter root with a repeatable qualified
value:

```bash
cchistory-lite sources \
  --source-root codex=/mnt/history/.codex/sessions \
  --source-root claude_code=/mnt/history/.claude/projects
```

An override replaces that adapter's default root while other discovered
defaults remain enabled. To scan only selected adapters, add repeatable
`--source` flags:

```bash
cchistory-lite search "migration" \
  --source-root codex=/mnt/history/.codex/sessions \
  --source codex
```

Lite rejects `.cchistory`, `cchistory.sqlite`, and recognizable Full bundle
roots before probing them.

## CLI Commands

```text
sources
ls [projects|sessions|sources] [--limit <n>|--all] [--dir <path>]
latest [sessions|turns] [N] [--dir <path>]
tree [projects|project <ref>|session <ref>] [--dir <path>]
search <query> [--project <ref>] [--source <ref>] [--dir <path>] [--limit <n>]
show project|session|turn|source <ref>
stats [--by source|project|model|day] [--dir <path>]
export --format jsonl|json|markdown [--out <file>|-]
tui
```

Use `--json` for structured read output. Each one-shot command performs a fresh
canonical scan; use the TUI when you want to amortize one scan across repeated
browse, search, detail, source, and stats operations.

`ls` shows 20 rows by default. Pass `--limit <n>` or `--all`; JSON collection
payloads include the untruncated `total` and returned `shown` counts. `latest`
defaults to the 20 newest sessions and takes its count positionally, for example
`latest 50` or `latest turns 50`.

`latest sessions` emits one record per session, ordered by the session's newest
UserTurn. Each row includes aggregate turn count, model summary, and total tokens.
Sessions with no UserTurns are omitted; Gemini sessions with no assistant reply
are omitted as well. `latest turns` emits one record per UserTurn and includes
its session reference, model, and token total. Use `latest sessions 50` or
`latest turns 50` when the default 20 rows are not enough.

`--dir` is a canonical history scope, not a source-root override. It expands `~`,
resolves relative paths from the current directory, and matches lexical path
segments. Sessions without `working_directory` are excluded. It applies to
`latest`, `ls projects`, `ls sessions`, `search`, `stats`, and `tree projects`;
the latter keeps projects as containers but removes non-matching sessions,
turns, and empty projects. Codex and Claude Code first inspect lightweight
session metadata and skip full parsing only for resolved non-matching cwd signals;
uncertain metadata falls back to the full read-only probe. Use `--source-root
<slot>=<path>` when the native history itself is in a non-default location.

For large archives, ordinary read commands materialize one
canonical logical session at a time and release full assistant/tool context
after deriving the turn and session projections. `show session` with a complete
canonical session id performs one direct full-context scan of that session.
Fuzzy session references and turn references perform one scan that retains full
context only for resolver candidates, then fail explicitly if the reference is
missing or ambiguous. JSON/JSONL export retains all context and therefore has a
larger memory envelope. The TUI startup and refresh snapshots are context-light;
the TUI's `--turn <ref>` entry point opens Detail, and pressing Enter there (or
drilling into Detail) performs a targeted full-context scan for only that logical
session.

Human-readable collection output adapts to terminal width. Session rows include
an actionable short reference, title, directory, model summary, and aggregate
token count; Turn rows include session/turn references, model, token count, and
prompt. Use `--json` for stable machine-readable output. Every standard JSON
response includes `projection_issues`, which is empty for a coherent snapshot.
Human-readable commands report the same issues on `stderr`; the TUI shows them
in its counts line and Sources overlay. Session collection JSON rows add
`model_summary` and numeric `total_tokens` fields; `total_tokens` is `null` when
no usage is known. ANSI color is enabled only for TTY output and can be disabled
with `NO_COLOR=1`.

Lite entrypoints calculate the default Node old-space ceiling as
`min(host memory / 2, 4096 MiB)`. This replaces the former fixed 1024 MiB cap
that caused large local TUI launches to fail before the canonical scan finished.

## Lite TUI

`cchistory-lite-tui` is a full-screen, keyboard-driven browser over one
context-light snapshot held for the process lifetime. It accepts
`--source-root`, `--source`, `--limit-files`, and `--safe`, and can open directly
at one focused object or search query:

```bash
cchistory-lite-tui --project <ref>
cchistory-lite-tui --session <ref>
cchistory-lite-tui --turn <ref>
cchistory-lite-tui --search "parser regression"
```

Only one of `--project`, `--session`, and `--turn` may be supplied. References
accept a full id, slug or display name, workspace path, or unique id prefix.
`--color` and `--no-color` force or suppress ANSI styling.

```text
Up/Down or j/k   move cursor          Tab / Shift+Tab   next / previous pane
PgUp/PgDn        page                 Enter             drill into the focused pane
g / G             first / last         Esc               back or close an overlay
p / S             projects / sessions  t / d             turns / detail pane
/                 search              i                 usage stats
s                 source status       ?                 help
r                 refresh from disk    q                 quit and release snapshot
```

The interactive TUI uses the alternate screen and raw keyboard input. Search
queries of one to three characters wait for Enter; queries of four or more
characters run automatically as you type. Startup and refresh scans are
context-light. Press Enter on the Detail pane to load full conversation context
for only that session. A failed refresh keeps the previous complete snapshot
available. When stdout is not interactive, the TUI renders one fixed snapshot
frame and exits 0.

## One-Way Export

Lite export is normalized output, not a backup:

```bash
cchistory-lite export --format jsonl --out history.jsonl
cchistory-lite export --format json --out history.json
cchistory-lite export --format markdown --out history.md
cchistory-lite export --format jsonl --out -
```

JSON and JSONL output carry the schema marker
`cchistory-lite-export/v1`. Lite has no import command, and Full must not treat
this output as a restorable evidence bundle because it does not contain copied
raw parser input.

## Canonical Semantics Contract

Adapter registration, logical-session assembly, `UserTurn`/context derivation,
built-in masks, fallback project observations, project linking, read ordering,
search matching/ranking, and usage aggregation all live in `packages/canonical`
and `packages/source-adapters`. Related-work projection is derived there too:
delegated-session and automation-run rows are built before Lite releases
`session_relation` fragments. Lite never simplifies a parser or turn builder to
obtain speed — the surfaces render what this shared pipeline derives.

The fixture matrix in `packages/live-runtime` exercises that pipeline across
every registered adapter and verifies sources, projects, sessions, turns,
contexts, search results, and stats, including that the two Lite entry points —
`scanLiteHistory` (scan from disk) and `buildLiveSnapshot` (materialize a probe
payload) — produce identical snapshots.

This code originated in the CC History monorepo, which also hosts the
persistent-store "Full" profile. Cross-profile parity — that a clean Full
materialization reads back the same canonical objects as a Lite snapshot — is
verified there, against the store implementation. It cannot be checked from this
repository, which contains no store. Two fields are materializer-specific and
were never expected to match: an incremented `project_revision_id` and the
first-seen `ProjectIdentity.created_at`, both of which reflect the order in
which a store persisted source payloads. Lite derives one complete ephemeral
snapshot, so those lifecycle values stay at the clean snapshot revision.

Run the focused gate with:

```bash
pnpm run verify:lite
pnpm run verify:lite-artifact
```
