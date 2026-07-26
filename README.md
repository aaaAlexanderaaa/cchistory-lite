# CC History Lite

Read your local AI coding agents' native history **in place** — 14 source adapters, one
canonical pipeline — through a CLI and a terminal browser backed by an ephemeral in-memory
snapshot that is never written to disk.

```
$ cchistory-lite search "retry backoff" --source codex --limit 3
Search "retry backoff" (3 matches)
  2026-03-09T06:12:44Z · api-gateway / session 9f31c2 · turn 41ab0c
    make the retry backoff jittered so the workers stop synchronising
  ...
```

- **Zero-store.** Lite never creates or reads a `~/.cchistory` database. `--store` and `--db`
  are rejected at argument-parse time.
- **Ephemeral.** The canonical snapshot lives only in process memory. Each CLI command scans
  fresh and drops it on exit.
- **Read-only.** Adapters only read native history; SQLite-backed sources are opened with
  `readOnly: true`. Nothing is ever written back to a source root.
- **No mutation surface.** There is no sync, import, backup, restore, merge, GC, or migration
  command — by construction, not by convention.

## Requirements

- Node.js >= 22 (uses the built-in `node:sqlite` module)
- pnpm >= 10 < 11 (for building from source)

## Install

```bash
git clone <this-repo> cchistory-lite
cd cchistory-lite
pnpm install
pnpm run build:lite
```

Link both binaries onto your `PATH`:

```bash
pnpm run lite:link       # cchistory-lite
pnpm run lite:tui:link   # cchistory-lite-tui
```

Or run them straight out of the workspace without linking:

```bash
pnpm lite -- sources
pnpm lite:tui
```

### Standalone release artifact

`pnpm run lite:artifact` produces a self-contained closure under `dist/lite-artifacts/` —
both binaries plus every workspace package they need, with no `workspace:*` specifiers and no
pnpm workspace required at runtime. Extract the tarball anywhere and run `bin/cchistory-lite`
(or `bin\cchistory-lite.cmd` on Windows).

## Supported sources

Lite scans every registered adapter whose default root exists on the machine. Each adapter is
referenced by its slot id.

| Slot | Tool | Default root | Tier |
| --- | --- | --- | --- |
| `codex` | Codex | `~/.codex/sessions` | stable |
| `claude_code` | Claude Code | `~/.claude/projects` | stable |
| `factory_droid` | Factory Droid | `~/.factory/sessions` | stable |
| `amp` | AMP | `~/.local/share/amp/threads` | stable |
| `cursor` | Cursor | `~/.cursor/projects`, platform Cursor `User` dir | stable |
| `antigravity` | Antigravity | platform Antigravity `User` dir, `~/.gemini/antigravity/brain` | stable |
| `gemini` | Gemini CLI | `~/.gemini` | stable |
| `openclaw` | OpenClaw | `~/.openclaw/agents` | stable |
| `opencode` | OpenCode | `~/.local/share/opencode/storage` | stable |
| `codebuddy` | CodeBuddy | `~/.codebuddy` | stable |
| `lobechat` | LobeChat | `~/.config/lobehub-storage` | experimental |
| `accio` | Accio Work | `~/.accio/accounts/<id>/agents` | experimental |
| `zcode` | ZCode | `~/.zcode` | experimental |
| `kimi` | Kimi Code | `~/.kimi-code` | experimental |

Point an adapter somewhere else with `--source-root <slot>=<path>`, e.g.
`--source-root claude_code=/mnt/history/.claude/projects`.

## CLI

```
cchistory-lite <command> [options]
```

| Command | What it does |
| --- | --- |
| `sources` | List resolved adapters with sync status, session/turn counts, and root |
| `ls [projects\|sessions\|sources]` | Flat list of one collection (default `projects`) |
| `tree [projects\|project <ref>\|session <ref>]` | Hierarchical view including Related Work |
| `search <query>` | Search canonical turn text and paths |
| `show project\|session\|turn\|source <ref>` | Full detail for exactly one object |
| `stats [--by source\|project\|model\|day]` | Token and usage aggregation |
| `export [--format jsonl\|json\|markdown]` | One-way canonical export |
| `tui` | Launch the terminal browser (spawns `cchistory-lite-tui`) |
| `help [command]` | Command synopsis |

### Options

| Flag | Purpose |
| --- | --- |
| `--source <slot>` | Select adapters; repeatable. Default: every adapter with an existing root |
| `--source-root <slot>=<path>` | Override one adapter's root; repeatable |
| `--limit-files <n>` | Cap source files read per adapter |
| `--safe` | Safe mode: skip the Antigravity live probe, companion-evidence capture, and git evidence reads |
| `--json` | Machine-readable output, schema `cchistory-lite/v1` |
| `--project <ref>` | Scope to one project (`search`, `stats`) |
| `--limit <n>` / `--offset <n>` | Paging (`search`; default 50 / 0) |
| `--by <dimension>` | Usage rollup dimension (`stats`) |
| `--format` / `--out` | Export encoding and destination (`export`; default `jsonl`, stdout) |
| `--version` / `--help` | Version, or the synopsis |

References — sources, projects, sessions, turns — resolve by exact id, then by alias (slug,
display name, workspace path, source session id, …), then by unique id prefix. An ambiguous
reference is an explicit error rather than a silent pick.

Exit codes: `0` success, `2` usage error, `1` any other failure.

## TUI

`cchistory-lite-tui` is a line-oriented REPL browser over a single snapshot held for the
process lifetime. It accepts `--source`, `--source-root`, `--limit-files`, and `--safe`.

```
p | projects          list projects            n | next      next page
s | sessions          list sessions            b | prev      previous page
u | turns             list UserTurns           page <n>      jump to a page
/<query>              search turn text         o | sources   source status
project <ref>         project detail           t | stats     usage overview
session <ref>         session + turn detail    r | refresh   rescan
turn <ref>            turn + full context      h | help      show commands
                                               q | quit      release the snapshot
```

Startup does one context-light scan and prints a dashboard: counters, the first 8 projects,
and the 8 most recent turns. `turn <ref>` is the only command that goes back to disk — it runs
a targeted full-context rescan of just that session, so the resident snapshot stays light.
`refresh` keeps the previous snapshot if the rescan fails. On a non-interactive stdout the TUI
prints the dashboard and exits 0.

## Architecture

Six packages, a strict one-way dependency chain, and no persistent storage anywhere in it:

```
apps/lite-cli ─┐
               ├─→ packages/live-runtime ─→ packages/source-adapters ─┐
apps/lite-tui ─┘             │                                        ├─→ packages/domain
                             └────────────→ packages/canonical ───────┘
```

| Package | Role |
| --- | --- |
| `@cchistory/domain` | Canonical types and projections. No I/O |
| `@cchistory/canonical` | Storage-neutral semantics: project linking, read order, search, related work, usage |
| `@cchistory/source-adapters` | The 14 adapters. Stops at the parse boundary |
| `@cchistory/live-runtime` | Materializes a probe into an in-memory `LiveHistorySnapshot` |
| `@cchistory/lite-cli` | The `cchistory-lite` binary |
| `@cchistory/lite-tui` | The `cchistory-lite-tui` binary |

These boundaries are enforced, not just documented — see `architecture-rules.json` and
`scripts/verify-lite-boundaries.mjs`. See [ARCHITECTURE.md](ARCHITECTURE.md) for detail and
[docs/design/R43_CC_HISTORY_LITE_DESIGN.md](docs/design/R43_CC_HISTORY_LITE_DESIGN.md) for the
design rationale.

## Development

```bash
pnpm run build:lite            # build the whole chain
pnpm test                      # all package tests + dependency-boundary check
pnpm run verify:governance     # architecture rule manifest + its harness
pnpm run verify:lite-artifact  # build, extract, and exercise the release closure
```

Tests run against the committed fixture corpus in `mock_data/` — sanitized transcripts for
every adapter. No real user history is required, and none should ever be committed.

## License

MIT — see [LICENSE](LICENSE).
