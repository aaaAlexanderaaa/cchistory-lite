# CC History Lite

**CC History** — browse and search your coding-agent **Conversations**
history across Claude Code, Cursor, Codex, Gemini CLI, and more.

CLI and TUI. No store. Works on a laptop, on a server, and as a
subprocess an agent can call.

Published as [`@cchistory/lite`](https://www.npmjs.com/package/@cchistory/lite).

| | **Lite** | [CCHV](https://github.com/jhlee0409/claude-code-history-viewer) | [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) |
| --- | :---: | :---: | :---: |
| CLI | ✓ | — | ✓ |
| TUI | ✓ | — | ✓ |
| Desktop / Web GUI | — | ✓ | — |
| SSH / no display | ✓ | Web server | ✓ |
| Agent `--json` | ✓ | — | ✓ |
| Own database | **0** | 0 | SQLite index |
| Semantic search | — | — | ✓ |
| Sources | **21** | 29 | ~24 |
| Search pays | every scan | GUI cache | disk index |

## Quick start

Requires Node.js >= 22.

| Who | Command |
| --- | --- |
| On your laptop | `npx @cchistory/lite tui` |
| Check token cost & quota | `npx @cchistory/lite stats` (or `tui --stats`) |
| Over SSH | `npx @cchistory/lite latest sessions 10` |
| From an agent | `npx @cchistory/lite search "retry backoff" --json` |

```bash
npx @cchistory/lite sources
npx @cchistory/lite search "retry backoff" --source codex --limit 3
npx @cchistory/lite stats --since today --quota 100
npx @cchistory/lite show session sess:codex:…
npx @cchistory/lite tui
```

`npm install -g @cchistory/lite` puts `cchistory-lite` and `cchistory-lite-tui`
on `PATH`.

CLI `search` checks titles, user prompts, and assistant replies by default (`--prompts-only`
limits matching to titles and prompts; `--group-by message` lists every matching message).
`stats` defaults to machine-wide usage, cost mix, cache hit rate, cache-hit distribution,
main vs subagent role split, ranked anomalies, and hourly, session, family, tool, or turn
rollups (`--dir <path>` scopes to one directory; `trace <session_ref|turn_ref>` inspects
one session or turn's per-call waterfall and causal tool summaries).

Agents: [`skills/using-cchistory-lite/SKILL.md`](skills/using-cchistory-lite/SKILL.md).
Copy-paste recipes: [`docs/guide/lite.md`](docs/guide/lite.md).

For questions about past decisions, open `cchistory-lite shell --dir /path/to/project --json`:

```json
{"kind":"search","query":"retry backoff","content":"conversation"}
{"kind":"read","turn_ref":"<turn_id from a result>","max_chars":8000}
{"kind":"exit"}
```

Conversation search includes masked user text and assistant answers. Reads return bounded
evidence with stable citations and continuation cursors. Inspect `read_status` for known gaps;
a successful query can still have unreadable native records or unattributed directories. See the
[agent evidence guide](docs/guide/agent-evidence.md) for paging and snapshot lifetime.

## Supported sources

Lite scans every registered adapter whose default root exists on the machine.
Each adapter is referenced by its slot id.

| Slot | Tool | Default root | Tier |
| --- | --- | --- | --- |
| `codex` | Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` | stable |
| `claude_code` | Claude Code | `~/.claude/projects` | stable |
| `factory_droid` | Factory Droid | `~/.factory/sessions` | stable |
| `amp` | AMP | `~/.local/share/amp/threads` | stable |
| `cursor` | Cursor | `~/.cursor/projects`, platform Cursor `User` dir, `~/.cursor/chats` | stable |
| `cursor_agent` | Cursor Agent | `~/.cursor/projects` | experimental |
| `antigravity` | Antigravity | `~/.gemini/antigravity/conversations/*.db` (history + token usage), platform Antigravity `User` dir, brain artifacts | stable |
| `gemini` | Gemini CLI | `~/.gemini` | stable |
| `openclaw` | OpenClaw | `~/.openclaw/agents` | stable |
| `opencode` | OpenCode | `~/.local/share/opencode` (SQLite), `~/.local/share/opencode/storage` (legacy JSON) | stable |
| `codebuddy` | CodeBuddy | `~/.codebuddy` | stable |
| `lobechat` | LobeChat | `~/.config/lobehub-storage` | experimental |
| `accio` | Accio Work | `~/.accio/accounts/<id>/agents` | experimental |
| `zcode` | ZCode | `~/.zcode` | experimental |
| `kimi` | Kimi Code | `~/.kimi-code` | experimental |
| `grok` | Grok CLI | `~/.grok` | experimental |
| `grok_bot` | Grok Bot | `~/agent-data`, `~/sand-data` | experimental |
| `deepseek_harness` | DeepSeek Harness | `$DSH_HOME/sessions`, `~/.dsh/sessions` | experimental |
| `hermes` | Hermes Agent | `$HERMES_HOME/state.db`, `~/.hermes` (profiles under `profiles/*`) | experimental |
| `pi` | Pi | `~/.pi/agent/sessions`, `$PI_CODING_AGENT_DIR/sessions` | experimental |
| `oh_my_pi` | Oh My Pi | `~/.omp/agent/sessions`, `profiles/*/agent/sessions` | experimental |

`cursor` still merges Agent CLI transcripts with composer/chat-store evidence
when they share a native agent id.
`antigravity` reads SQLite conversations and independent model-call usage
directly (verified against 2.32.1). Totals include cache reads/writes and output (including reasoning).
Assistant-only delegated work contributes usage while retaining zero user turns.
`stats --by model` assigns those calls to their recorded models, including model
switches within a user turn. Overview and source/project/day rollups count each
user turn once.
Legacy encrypted `.pb` histories use the local language server while the app runs.
`grok_bot` reads sidebar-agent `store.db` first. After a successful parse finds
conversation evidence, it skips that agent's duplicate `agent-transcripts` JSONL
within the current scan. Empty, unreadable and non-conversation-only stores allow
the JSONL fallback; malformed records and unsupported message roles retain evidence
and parse diagnostics. Each scan reads the current SQLite state, including WAL
commits. Titles prefer
`profile.json`, then `SAND_AGENT_PROFILE_UPDATE`, then the first real user message;
canonical titles apply the shared masking rules before display truncation.
Grok Bot hidden-prompt markers and native title tags are interpreted only for this source.

`deepseek_harness` reads the current `session.vN.jsonl` or `session.vN.jsonl.zstd`
generation (v4) under each session directory. Checksummed Zstandard frames are
decoded in-process; a truncated trailing frame from a crashed writer keeps its
complete predecessor records and records a read diagnostic. Assistant messages
carry per-call usage, so cache-hit and cost diagnostics keep call granularity.
Injected harness context, including skill and time reminders, stays collapsed
as injected conversation context instead of becoming real user turns. A tagged
fork-seed prefix belongs to the parent history and is not projected twice;
subagent children are linked from the parent's `subagent/catalog` evidence.
Older physical format versions are reported as unsupported rather than guessed.

`opencode` reads the current SQLite store (`session_v2` / `session_message` /
`session_part`), the pre-split v2 store (metadata still in `session`, no `seq`
yet), the 1.2-era store (`session` / `message` / `part`), and the
legacy `storage/{session,message,part}` JSON tree. When a migrated install still
has JSON copies beside `opencode.db`, the store is read first and a leftover
JSON session is skipped only when the store carries the same native session id,
so an empty, partial or unreadable store never hides JSON-only history. Parts supply assistant text, reasoning,
tool calls and results; session `parent_id` links delegated child sessions.

`hermes` reads Hermes Agent profile stores (`state.db`, including
`profiles/<name>/state.db`). Live transcript rows (`active = 1`) become
conversation evidence; `display_kind = 'hidden'` and rewound rows are omitted.
Reasoning columns stay collapsed as reasoning instead of becoming visible
assistant text, OpenAI-style `tool_calls` become tool calls paired with their
`role: tool` results, and `model_config` lineage markers distinguish delegated
children (`_delegate_from`, linked under the parent) from branch/compression
continuations (`_branched_from` / `_reset_from`, kept as their own top-level
sessions). Hermes records usage per session/model, not per call, so those totals
keep session granularity.

`pi` and `oh_my_pi` read the shared Pi-family session JSONL layout:
`<agent-dir>/sessions/<encoded-cwd>/<timestamp>_<session>.jsonl`. Entries form a
tree (`id`/`parentId`), so only the active branch — the last entry walked back to
its root — becomes conversation evidence; abandoned branches stay in the file as
raw evidence. Assistant messages keep per-call usage (call granularity), thinking
blocks stay collapsed, `toolCall` blocks pair with `toolResult` rows (including
`isError`), and compaction/branch-summary entries contribute their own model
usage instead of overwriting a reply. Oh My Pi additionally carries a fixed-width
title slot, `title_change`/`model_usage`/`reset_boundary` entries, named profile
stores, and task children linked through `parentSession` + `taskPromptCacheKey`;
ordinary forks keep their `parentSession` lineage as a top-level session. Both
sources honour `PI_CODING_AGENT_DIR`; a marker-less override is accepted only by
the product whose own root exists, so one installation is not indexed twice.

`cursor_agent` is opt-in (`--source cursor_agent`) so a default scan does not
emit those transcripts twice.

Point an adapter somewhere else with `--source-root <slot>=<path>`, e.g.
`--source-root claude_code=/mnt/history/.claude/projects`.

## Live reads and memory

Other agents can keep running while Lite reads their history. Appends and SQLite
WAL updates are normal; the snapshot may be slightly behind the writer. Changed
selection evidence falls back to an ordinary read. Unreadable or oversized inputs
leave diagnostics alongside the history that could be read.
Use `--diagnostics` on a CLI history read or shell for opt-in structured progress,
budget and cache events on stderr; stdout keeps its existing contract. For past
decisions, [message-grouped search](docs/guide/agent-evidence.md) also exposes older
matches within a session.

The CLI and TUI automatically grow Node's default heap when available system memory
allows, leaving half that capacity for other uses. Estimates warn; they do not
reject the whole scan. Per-read memory checks and the pressure watchdog remain on.
Explicit `NODE_OPTIONS='--max-old-space-size=8192'` selects an 8 GiB heap ceiling
while keeping those protections enabled. See the [memory guide](docs/guide/lite.md)
for details; disabling the guard is not required for normal use.

## More

- Finite SQL, bound templates, and shell lifetime: [`docs/guide/query.md`](docs/guide/query.md)
- CLI, flags, `--json`, `query`, from-source build: [`docs/guide/lite.md`](docs/guide/lite.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Releases: [`RELEASING.md`](RELEASING.md)

MIT — see [LICENSE](LICENSE).
