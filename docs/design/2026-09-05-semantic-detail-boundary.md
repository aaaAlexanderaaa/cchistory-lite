# Semantic evidence and optional detail

> Status: canonical interpretation entry and nonempty 16-source regression matrix implemented;
> optional detail construction is not implemented. This refines slice 3 of [the bounded query proposal](2026-09-05-bounded-query-model.md).
> [Sanitized measurements](../research/2026-09-05-detail-construction.md) document the evidence.
> Raw native history, private harnesses, and unsanitized profiles remain outside the repository.

Delivery status and priority are tracked in [the work plan](../../PLAN.md). The optional-detail
split described here is deferred; it is not a prerequisite for the finite query frontend.
The remaining large-architecture questions below qualify broader guarantees, not M1 prerequisites.

## Decision

Treat detail retention as independent of query semantics. A scan that omits detail must still
answer the same collection, identity, ordering, search, usage, project, family, and diagnostic
questions over the same evidence. It may omit complete context objects; it may not substitute
empty assistant/tool fields into an object typed as a complete context.

Use one semantic interpretation for both paths. Detail formatting consumes that interpretation
and the source evidence it references. Do not maintain a second token-association, activity,
masking, or family-attribution algorithm for compact queries.

This is a CPU/allocation boundary, not a memory-capacity guarantee. Avoiding formatted context
objects does not avoid native reads, JSON decoding, raw records, fragments, atoms, or the full
user text and lineage currently retained on every turn. A bounded generation still needs limits
for large units and for the aggregate retained collection.

## Current execution boundary

`scanLiteHistory` supplies canonical `interpretSessionEvidence` to the adapter collector. After
cross-file reconciliation and native signal normalization, `processCollectedSessions` passes
borrowed `ParsedSessionEvidence` to that entry. Canonical builds submission groups, project
observations, sessions, turns, usage associations, and complete contexts. Runtime
`compactSourcePayload` then derives
related work and the canonical family inventory while contexts, records, atoms, and blobs are
still available. It retains project observations, turns, family summaries, questions, and loss
audits, then keeps all, no, or matching contexts according to `contextMode`.

Consequently, `none` currently means **do not retain detail**, not **do not construct detail**.
`matching` likewise filters fully constructed contexts after interpretation. Neither mode is a
source-read limit. The existing complete path remains the reference during this separation.

## Required evidence by consumer

| Consumer | Evidence that must survive interpretation | Presentation that may be deferred |
| --- | --- | --- |
| Identity | Source/session identity, submission groups, stable turn/context identities, provenance | Rendered context body |
| Lists and recency | Real conversation activity and submission time; counts; empty sessions; project and delegated relationships | Reply previews, system messages, tool body formatting |
| Turn summary and usage | Visible assistant/tool counts, token signal association and deduplication, structured totals, model selection, stop reasons, known-zero classification | Assistant text, tool input/output display segments |
| Search | Canonical user text, canonical title, structured path evidence, project observations, existing ranking rules | Ordinary assistant/tool body text |
| Family contributions | Ownership of blobs/records/atoms, shared-container attribution, tool outcomes, option-B usage, relationships | Ordinary tool payload rendering |
| Delegated task I/O | Exact parent/child aliases, call/result correspondence, prompt/output evidence and fallback precedence | Complete delegated tool context after equivalent summary evidence exists |
| User questions | Parsed questions, options, answers, and their identities | The surrounding full tool context |
| Diagnostics | Parse loss, uncertain evidence, and canonical projection issues | Nothing solely because detail was not requested |

The output already called compact still includes complete `UserTurnProjection` objects. Their
user text, display segments, user-message arrays, and lineage arrays are not bounded previews.

## Semantics that a split must preserve

### Usage and models

The reply builder associates usage signals with reply identities before constructing the turn
summary. Claude message chunks can share one billed usage record. Signals can precede their text
reply, follow another reply, or belong to tool-only/thinking-only calls. Codex delta signals and
cumulative checkpoints have different accumulation rules. Dropping assistant text objects must
not remove this association state.

The turn's primary model is the first resolved reply model, with the existing session fallback.
Individual replies can use different models. `has_errors` currently follows assistant stop
reasons; family tool-error counts are derived separately from tool evidence. Neither is a
replacement for the other. Public usage totals continue through canonical option-B projection.

There is an existing limitation: if a turn has no visible text reply anywhere, pending usage
signals have no reply to attach to and are not represented in its token total. Its summary is
classified as `no_assistant_reply`. Preserve this behavior during structural refactoring and
address the accounting change separately with explicit expected results. Parity does not prove
that the current usage model captures every billed call.

There is also a distinct error-evidence gap: the Claude tool-result parser currently omits the
native `is_error` flag from its atom payload. Without a recognized textual error signature,
canonical family tool-error counts remain zero even when a later assistant has an error stop
reason. The adversarial fixture records this distinction; fixing lost native error evidence is
a separate semantic correction, not permission to equate the two counters.

### Search and masking

Current search does not search arbitrary assistant text or tool bodies. `path_text` uses session
workspace/project fields and structured path fields on atoms. The turn builder also accepts
assistant display segments of type `reference`, but `applyMaskTemplates` currently emits text,
masked, or injected segments, not reference segments. Plain file paths in assistant prose do not
therefore become searchable through that branch.

Do not invent a new path recognizer while removing detail formatting. If reference extraction is
introduced later, make it an explicit semantic capability with tests; do not present that future
capability as an active dependency of current native scans.

Masking remains necessary for user canonical text and public previews. Family preview masking
must precede the final compact cut so truncation cannot turn a recognizable credential into an
unmasked prefix. Full detail preserves its existing raw/display distinction.

### Delegated work

Canonical family construction consumes both raw atoms and projected spawn-tool calls. The
projected path is observable when raw evidence lacks a matching child/call, and can contribute an
input summary when no prompt/description is present. Projected output previews can also take
precedence over complete output. Related-work metadata and child instruction/assistant atoms are
further fallbacks. Exact alias matching, candidate order, and fallback precedence matter.

Preserve these facts in named semantic evidence before omitting projected spawn details. Do not
assume all adapters always supply enough raw atoms to replace the context path. The family test
includes an unrelated raw spawn and matching projected spawn to make this requirement observable.
Precomputing family summaries after full context construction, as runtime does today, preserves
the answer but does not avoid that construction cost.

### Detail availability and freshness

An absent context means it was not retained. A complete context with empty reply/tool arrays means
those arrays are actually empty. These states must remain distinguishable.

For a future generation-bound API, detail requests need a turn identity, native locator, expected
evidence versions, and interpretation version. Return complete detail, unavailable detail, or
changed evidence explicitly. Do not combine newly scanned context with old summary/usage merely
because the stable turn id still resolves.

This is not a guarantee of today's TUI: it performs a targeted full scan and inserts returned
contexts into its existing model. Attempt-local file validation checks the new scan; it does not
bind that scan to the earlier snapshot. Generation-bound detail requires a runtime contract and
a separately reviewed interaction for changed evidence.

## Ownership and implementation direction

The repository rule puts history interpretation in `canonical`. The turn/context algorithms now
live in `canonical/src/session-interpreter.ts`, reached through one explicit `InterpretParsedSession`
callback chosen by runtime. There is no adapter-side default or second compact implementation.
Adapters do not import canonical, and canonical does not import adapters. Test-only composition
uses the same canonical implementation while retaining the existing expected-value assertions.

The shared domain contract names reconciled session metadata, ordered atoms/edges, record/fragment/
blob provenance, and already collected git evidence. Parser cumulative checkpoints remain in the
adapter draft extension. Domain also supplies the existing deterministic masking, token-value,
atom-predicate, and normalization operations used by both native hydration and interpretation;
the move keeps single definitions rather than copying their behavior between layers. Domain reads
no native files. Canonical decides submission boundaries, token-to-reply association, session/turn
projections, search fields, and complete context construction.

This is an intermediate seam, not a complete source-unit execution design. The collector still
reconciles entire source/session groups, hydrates native draft metadata, deduplicates source token
signals, decodes source-specific question schemas, and assembles the full probe payload. Source
losses and orphan evidence remain in that payload. The callback is a dependency seam, not a user
configuration or query-language extension point. A reconciled session is not necessarily a safe,
bounded, independently releasable source unit.

The new entry does not mutate borrowed evidence; submission edges are constructed in a fresh
array. It temporarily preserves the old payload's duplicate edge multiplicity, caused by the old
in-place builder being flattened twice. Correcting that evidence count is separate from the
ownership move. Frozen-input and repeat-interpretation tests guard against accumulated edges.

The intended flow is:

```text
adapters: native files -> parsed unit evidence + source loss
                                      |
canonical: one interpretation -> turn/session facts + related/family evidence
                                      |                         |
                              query projections          optional full detail
                                      \                         /
runtime: read-plan validation + ownership + publication + detail availability
```

Use a parsed-unit contract to cross the adapter boundary. Keep native decoding, source-specific
signal recognition, and source losses in adapters. Move source-neutral submission/usage/activity
interpretation and presentation-independent projections behind canonical entry points. Runtime
orchestrates the two; adapters must not import canonical to call back up the dependency graph.

Keep three concepts distinct in that contract:

- **Parsed unit evidence:** native session metadata, ordered atoms/edges, provenance and loss;
  sufficient to interpret one safe unit, without claiming global project/family completeness.
- **Semantic result:** stable identities, turn summaries and search fields, question evidence,
  family inputs/contributions, and diagnostics. It is explicitly not a `TurnContextProjection`.
- **Optional complete detail:** full system/reply/tool projections for requested turns. A missing
  detail result carries no claim that the turn had no assistant or tool activity.

The canonical interpretation seam now preserves unchanged full results. When the deferred detail
work is selected, make formatting optional against the same semantic result. Keep the
existing token fixtures and explicit expected-value tests as independent checks; comparing two
modes that share a bug is insufficient. Do not duplicate the reply builder into a second
production implementation or introduce query grammar to select detail work.

## Verification boundary and remaining prerequisites

The context-retention matrix compares `full`, `none`, and `matching` over all sixteen registered
adapters, and requires at least one turn and one assistant reply for every adapter. It checks source counts, ordered sessions/turns/projects, related work, families,
questions, diagnostics, usage dimensions, and ordered search hits; retained matching contexts
must equal their complete counterparts. Observation time is fixed because some native fixture
formats lack timestamps. Native conversation timestamps are not discarded from comparisons.

The dedicated Claude fixture checks chunk deduplication, leading/trailing usage signals,
tool-only usage, model changes, assistant errors, masking, duplicate titles across projects, and
the absence of body-text search. Existing token tests cover Codex deltas and cumulative branches.
The canonical family test covers projected I/O fallback when matching raw atoms are absent.

These checks establish a retention contract, not equivalence of an optimized extractor that has
not been implemented. Hand-authored Gemini, OpenClaw, Antigravity, LobeChat, Kimi, and ZCode cases
fill the former matrix gaps. Native layouts that contain ignored scratch directory names, and
SQLite databases, are assembled from checked-in fixture inputs in cleaned temporary directories.
The matrix explicitly compares its platform set to the adapter registry.

A private comparison also checked complete snapshots before and after the interpretation move
using the same 16 fixture roots, file identities, host, and fixed observation clock: all snapshots
were equal. The [sanitized verification record](../research/2026-09-06-canonical-interpretation-seam.md)
distinguishes that structural check from native cost measurements and records remaining fixture
manifest limitations.

Before claiming general bounded-memory and generation-bound-detail guarantees, also resolve:

- whether a safe parsed unit can be interpreted/released without retaining the entire source;
- the retained size of user text, lineage, diagnostic and relationship collections;
- large-container/large-session decoding limits and refusal behavior;
- generation and detail version matching, including refresh overlap and unavailable evidence;
- admission and eviction rules for any later unit/detail cache;
- exact top-N, totals, and diagnostic coverage for the first selective read plan.

The finite SQL-like frontend can initially execute against the complete snapshot. It needs an
explicit logical query and result contract, but not the general capacity, cache, or late-detail
guarantees above. It must not expose parser intermediates or require callers to understand retention
modes. Selective execution separately requires a correctness proof for its chosen query shape.
