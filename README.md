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
| Sources | **16** | 29 | ~24 |
| Search pays | every scan | GUI cache | disk index |

## Quick start

Requires Node.js >= 22.

| Who | Command |
| --- | --- |
| On your laptop | `npx @cchistory/lite tui` |
| Over SSH | `npx @cchistory/lite latest sessions 10` |
| From an agent | `npx @cchistory/lite search "retry backoff" --json` |

```bash
npx @cchistory/lite sources
npx @cchistory/lite search "retry backoff" --source codex --limit 3
npx @cchistory/lite show session sess:codex:…
npx @cchistory/lite tui
```

`npm install -g @cchistory/lite` puts `cchistory-lite` and `cchistory-lite-tui`
on `PATH`.

Agents: [`skills/using-cchistory-lite/SKILL.md`](skills/using-cchistory-lite/SKILL.md).
Copy-paste recipes: [`docs/guide/lite.md`](docs/guide/lite.md).

## Supported sources

Lite scans every registered adapter whose default root exists on the machine.
Each adapter is referenced by its slot id.

| Slot | Tool | Default root | Tier |
| --- | --- | --- | --- |
| `codex` | Codex | `~/.codex/sessions` | stable |
| `claude_code` | Claude Code | `~/.claude/projects` | stable |
| `factory_droid` | Factory Droid | `~/.factory/sessions` | stable |
| `amp` | AMP | `~/.local/share/amp/threads` | stable |
| `cursor` | Cursor | `~/.cursor/projects`, platform Cursor `User` dir, `~/.cursor/chats` | stable |
| `cursor_agent` | Cursor Agent | `~/.cursor/projects` | experimental |
| `antigravity` | Antigravity | platform Antigravity `User` dir, `~/.gemini/antigravity/brain` | stable |
| `gemini` | Gemini CLI | `~/.gemini` | stable |
| `openclaw` | OpenClaw | `~/.openclaw/agents` | stable |
| `opencode` | OpenCode | `~/.local/share/opencode/storage` | stable |
| `codebuddy` | CodeBuddy | `~/.codebuddy` | stable |
| `lobechat` | LobeChat | `~/.config/lobehub-storage` | experimental |
| `accio` | Accio Work | `~/.accio/accounts/<id>/agents` | experimental |
| `zcode` | ZCode | `~/.zcode` | experimental |
| `kimi` | Kimi Code | `~/.kimi-code` | experimental |
| `grok` | Grok CLI | `~/.grok` | experimental |

`cursor` still merges Agent CLI transcripts with composer/chat-store evidence
when they share a native agent id.
`cursor_agent` is opt-in (`--source cursor_agent`) so a default scan does not
emit those transcripts twice.

Point an adapter somewhere else with `--source-root <slot>=<path>`, e.g.
`--source-root claude_code=/mnt/history/.claude/projects`.

## More

- CLI, flags, `--json`, `query`, from-source build: [`docs/guide/lite.md`](docs/guide/lite.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Releases: [`RELEASING.md`](RELEASING.md)

MIT — see [LICENSE](LICENSE).
