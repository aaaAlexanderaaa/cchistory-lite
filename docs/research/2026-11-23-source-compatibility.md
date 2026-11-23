---
doc_type: evidence
status: current
authority: evidence
last_reconciled: 2026-11-23
---

# Source compatibility research

This report owns upstream format observations and their applicability to Lite. The owner's
request, source ratings, delivery order, and execution state belong to [PLAN.md](../../PLAN.md).
The target outcome is useful conversation recovery with trustworthy usage where the native
source supplies it.

## Evidence and current coverage

The inspected reference is [tokscale 4.23.1, revision
`b265e836c58f085f50a836525aa60b8d45bd8d57`](https://github.com/junhoyeo/tokscale/tree/b265e836c58f085f50a836525aa60b8d45bd8d57),
committed on 2026-11-22. Its [MIT license](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/LICENSE)
permits reuse with its notice. These observations came from reading its source; producer-version
qualification and execution against expected Lite projections are subsequent checks.

Lite's [adapter registry](../../packages/source-adapters/src/platforms/registry.ts) currently
contains 17 sources: 10 stable and 7 experimental. Seven of the 19 products in the owner's revised scope have
registered adapters: OpenCode, Claude Code, Codex CLI, Cursor IDE, Google Antigravity, OpenClaw,
and Gemini CLI. The other 12 are candidates. Product ratings describe the supplied research;
Lite support tier describes Lite's own implementation and validation.

### Compatibility of existing sources

| Source | Local implementation fact | Reference observation and next comparison |
| --- | --- | --- |
| OpenCode | `platforms/opencode.ts` discovers legacy storage/project roots and matches JSON under `storage/session/`. | Tokscale's `sessions/opencode.rs` and `sessions/opencode_schema.rs` also handle native SQLite. Establish producer schema/version coverage, then read both layouts with native identity-based copy precedence. |
| OpenClaw | `platforms/openclaw.ts` matches session and cron JSONL and reads companion metadata. | Tokscale's scanner also discovers `*/agent/openclaw-agent.sqlite`. Check native tables, legacy roots and overlap with session JSONL before extending discovery. |
| Codex CLI | Lite reads plain JSONL from active and archived roots and reconciles calls/compactions. | Tokscale also reads compressed rollouts. Evaluate compressed-read limits and archive-copy identity in the same bounded-compression work as DeepSeek Harness. |
| Claude Code, Cursor IDE, Google Antigravity, Gemini CLI | Existing native adapters remain the local owners. | Compare recorded producer versions, environment/root overrides, schema variants and duplicate evidence. Tokscale's Cursor API and Antigravity sync caches illustrate a different acquisition path; Lite retains direct native reads. |

The OpenCode and OpenClaw observations identify concrete coverage gaps in the file matcher.
Their impact on a user's machine depends on the installed producer version and actual layout.

## New candidate evidence

Parser paths below are relative to `crates/tokscale-core/src/sessions/` in the pinned reference.
Each row identifies evidence to verify against the producer before implementing a Lite adapter.

| Candidate | Reference path and local input | Important compatibility work |
| --- | --- | --- |
| Hermes Agent | `hermes.rs`; `$HERMES_HOME/state.db`, default `~/.hermes/state.db`, and profile `state.db` files. | The reference reads session/per-model usage aggregates and optionally agent logs for dates. Producer storage docs also describe full `messages` rows with roles, tools, timestamps and reasoning; qualify their version/compression/lineage handling for Lite. Preserve aggregate usage as session-granular and keep profile identities distinct. Log timing enrichment needs its own identity and coverage evidence. |
| Pi | `pi.rs`; `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`. | Session/message/tree records, model switches, user versus tool results, input/cache/reasoning components, compaction and fork evidence. Message `parentId` and explicit delegated-session evidence require separate interpretation. |
| Oh My Pi | `omp.rs` delegates to `pi.rs`; `~/.omp/agent/sessions/**/*.jsonl`. | Reuse the proven Pi format reader while retaining its own source identity. Cover title metadata before the header, renamed headers, nested subagent/advisor transcripts and overlapping explicit roots. Pi and OMP share an environment override in the producer family; deduplicate or require explicit source selection when a root is ambiguous. |
| Cline | `cline.rs`, `roocode.rs`; VS Code task `ui_messages.json` with `api_conversation_history.json`; a separate Cline CLI path also exists. | Pair files by native task identity, separate UI/API copies, preserve real submissions and tools, and validate each protocol's cache semantics. IDE and CLI layouts need explicit version/profile coverage. |
| Mistral Vibe | `vibe.rs`; `$VIBE_HOME/logs/session/<session>/meta.json`, sibling `messages.jsonl`, and legacy flat session JSON. | Tokscale currently reads aggregate metadata. Inspect the producer transcript separately for conversation recovery. Keep session-granular totals separate from message identities/timestamps; resolve a model only from recorded evidence and explicit configuration. |
| Goose | `goose.rs`; `sessions/sessions.db` under native XDG, macOS and Windows app-data roots, with `GOOSE_PATH_ROOT` support. | The reference reads current/accumulated session counters. Inspect native message storage and parent-child relations, schema versions, model changes and cache fields; choose one authoritative aggregate when both counter forms exist. |
| Crush | `crush.rs`; project registry `projects.json` resolves per-project `crush.db`. | The reference preserves session cost and distributes it across days while reporting zero token buckets. Lite should read native conversation evidence and record available cost separately; token availability and timestamp scope need explicit qualification. Avoid copying proportional day allocations into canonical event evidence. |
| Cherry Studio | `cherrystudio.rs`; app-data `Data/Agents/.claude/projects` and legacy transcript roots, plus built-in chat SQLite. | Agent transcripts can reuse Claude-format parsing after request/message alias deduplication is verified. Built-in chat is a separate format profile. Cover streaming updates with different UUIDs and the same request identity, across migrated paths. |
| DeepSeek Harness | `dsh.rs`, `dsh_reader.rs`; `$DSH_HOME/sessions/**/session.jsonl[.zstd]`, including versioned names. | Native event stream carries session/cwd, request routing, assistant usage, compaction calls and fork seed boundaries. Select decompression by magic and bound physical bytes, decoded bytes, record bytes and decoder allocation. Preserve the Node 22/release closure contract. |
| OpenCodeReview | `opencodereview.rs`; `~/.opencodereview/sessions/<encoded-repo>/<session>.jsonl`. | The producer's viewer docs describe `llm_request.messages`, responses and tool calls. Qualify review-run reconstruction and distinguish machine-generated review instructions from real user submissions. Retain assistant-only calls with null turn IDs where real user submissions are absent. Review-run lineage remains distinct from interactive conversation lineage. |
| Warp / Oz | `warp.rs`; `tokscale-cli/src/warp.rs` obtains account/workspace aggregate requests and spend, then writes a Tokscale usage cache. | A Warp issue reports a native `warp.sqlite` with `agent_conversations` metadata and `ai_queries` user inputs. Investigate that path early; assistant bodies and complete request links still need schema evidence. Qualify Warp Local separately from Oz cloud history. Account aggregates carry their recorded scope. The reference sync cache is outside Lite's current native-history acquisition contract. |
| Hindsight | `hindsight.rs`; `tokscale-cli/src/hindsight.rs` synchronizes the service's LLM request API into monthly usage ledgers. | Establish whether the producer offers a usable native offline trace or read-only local data path. This is memory-service telemetry with its own retention and operation identities. Keep API acquisition and ledger creation as a separately authorized product decision. |

Useful pinned reference entrypoints:

- [Scanner and root handling](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-core/src/scanner.rs).
- [Pi shared parser](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-core/src/sessions/pi.rs)
  and [Oh My Pi profile](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-core/src/sessions/omp.rs).
- [Cline task/CLI profiles](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-core/src/sessions/cline.rs).
- [Hermes aggregates](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-core/src/sessions/hermes.rs),
  and [Vibe metadata](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-core/src/sessions/vibe.rs).
- [DeepSeek compressed reader](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-core/src/sessions/dsh_reader.rs),
  [Warp aggregate parser](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-core/src/sessions/warp.rs),
  and [Hindsight acquisition](https://github.com/junhoyeo/tokscale/blob/b265e836c58f085f50a836525aa60b8d45bd8d57/crates/tokscale-cli/src/hindsight.rs).

## Ask ChatGPT research and producer checks

Ask ChatGPT completed an independent research conversation on 2026-11-23 using the supplied
owner shortlist, local architecture facts, registered-source inventory and pinned reference
observations. The research covered the original shortlist; the current candidate table and
delivery order apply the owner's subsequent scope revision recorded in `PLAN.md`. Within this
scope, its recommendations prioritize Pi/OMP and Hermes, followed by Cline task formats, with
early Warp Local schema research, separate Warp/Oz identities, and explicit machine-generated
review task semantics. These retained findings refine the proposed delivery order in `PLAN.md`;
source-specific verification remains to complete.

The owner's subsequent follow-up places DeepSeek Harness in the first new-source batch alongside
Pi, Oh My Pi and Hermes. Its versioned plain/zstd inputs, fork/seed boundaries, independent
compaction usage and compressed/plain copy identity belong to that batch's acceptance, together
with bounded decoding and Node 22 artifact verification.

The following producer materials were checked after receiving that recommendation:

- [Hermes session storage](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md)
  documents full native message history, isolated profile roots, roles, tools, timestamps,
  reasoning and schema evolution. This supports conversation-adapter work beyond the reference's
  aggregate usage parser.
- [Oh My Pi's session model](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)
  supplies a producer-owned entry, persistence and reconstruction contract for the shared family.
- [DeepSeek's persistence package](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md)
  supplies a producer reference for the first-batch version/compression/fork qualification.
- [OpenCodeReview's viewer contract](https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/viewer.md)
  describes native request message arrays, responses, tools and review/compression lanes.
- [Warp issue 12314](https://github.com/warpdotdev/warp/issues/12314) contains a user's local
  SQLite observations. It is a promising schema lead; a versioned native schema and complete
  assistant-message recovery remain the qualification work.

The research also flagged newer Vibe harness layouts and Goose usage-ledger migration/backfill
as producer-version checks. Their exact applicability to a future Lite adapter remains open.
Implementation should pin the relevant producer revisions; the producer links above were
checked as current documentation on this report's date.

## Reuse and local ownership

Reuse upstream root knowledge, schema/version probes, counter semantics, identity edge cases and
test ideas. For substantial copied or translated implementation, retain the upstream copyright
and license notice and record the pinned source. Write new sanitized fixture text and expected
Lite projections from the producer format contract. Expected projections should be established
independently of the adapter under test.

The strongest alternative is broad support for Tokscale's normalized usage exports. That would
reach more usage sources quickly, with third-party acquisition/cache provenance and aggregate
rows rather than native conversation evidence. Native adapters better serve Lite's current
conversation-recovery purpose and existing acquisition contract. Revisit export compatibility
when the owner selects that product outcome and its provenance contract.

Format sharing stays inside `source-adapters`, behind explicit source profiles. Each source owns
its root discovery and identity. A shared reader handles only demonstrated common syntax;
canonical remains the single owner of turn interpretation, delegation, ordering, request
identity, usage reconciliation, diagnostics and snapshot projections.

Per-source qualification records should state producer version, native root/schema, observed
conversation coverage, tools and delegation, model/provider evidence, usage granularity, cache
and reasoning semantics, native cost scope, malformed/unsupported evidence, and known gaps.
Qualify cost-only and session-only records as such; keep real user-turn counts based on native
submissions. Add diagnostics for unreadable/unsupported records and preserve evidence the
current contract can represent.

## Priority rationale and changing conditions

Existing-format repairs protect people already using the seven listed supported sources.
Pi/Oh My Pi offer two independent sources through one well-evidenced format family. Hermes has
a high owner-supplied visibility rating and native profile databases, with conversation-schema
qualification still to complete. Cline has native task-file evidence requiring paired-file
identity checks and explicit format profiles.
DeepSeek Harness enters the first batch under the owner's follow-up, with its compressed-read
resource work included in that delivery. Aggregate-only reference parsers need separate evidence
for detailed history. Warp Local merits an early schema check because native
database evidence offers a more direct route than the reference's synchronized usage cache.

The order should change when actual user installations, a reproducible missing-history case,
producer version/fixtures, or a ready native schema show a more useful and cheaper slice.
Popularity and the source rating help choose where to investigate; acceptance comes from
versioned native evidence, independent expected projections and the shipped Lite entrypoints.
