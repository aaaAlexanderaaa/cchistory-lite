---
doc_type: evidence
status: historical
authority: evidence
last_reconciled: 2026-10-13
---

# Project improvement assessment

This records the assessment before the authorized runtime implementation, against
0.6.0 baseline `f9d84a5`. Linked code now includes later changes. The
[delivery record](2026-10-13-useful-history-capacity.md) owns their implementation,
measurements and verification; the findings below retain their original context.

This is an assessment, not an approved implementation plan. The owner requested a deep review,
identified Agent recovery of historical answers, decisions and context as the primary use case,
and raised ordinary-machine refusals, 100 MB+ sessions and observability. ZCode was an example,
not the boundary. [PLAN.md](../../PLAN.md) owns authorized execution; the existing product,
source-safety and visual-approval rules remain binding.

## Outcome and decision basis

A useful result lets an unfamiliar Agent locate the relevant evidence in the intended scope,
read enough surrounding conversation to distinguish a decision from a later mention or reversal,
cite the actual evidence, qualify gaps and freshness, and continue the task. Reading a file,
returning rows, passing projection checks or producing an artifact establishes only part of that
outcome. The journey includes first search, refinement, detail/pagination, related work, refresh,
failure recovery and release of process-owned state.

The user reports establish experienced refusal and the importance of availability. They do not
supply the failing build, command, selected inputs, actual heap/RSS, budget diagnostic or frequency.
Those missing facts limit attribution and numeric ROI; they do not erase the reported failure.
Current code shows mechanisms and tradeoffs. Sanitized observations show behavior under their
specific conditions. Historical measurements support hypotheses within their recorded build and
shape, not current machine-capacity promises.

The working tree is anchored at `f9d84a5`, package version 0.6.0; changes in this learning step
are documentation only. The authorized independent reviewer started without the parent's reasoning
history, followed AGENTS, and returned a roughly six-minute assessment. Its new pure-function
observations were subsequently reproduced by the parent. Both readers used the same repository
and fixture origins; this is independent judgment, not independent native data. See the
[trial record](2026-10-13-working-discipline.md#fresh-consumer-trial).

## Priority judgments

Importance depends on impact, frequency and recovery; necessity depends on whether the core task
or an invariant is blocked; ROI includes implementation, validation, maintenance and displaced work.
The ratings below are conditional judgments, not measured returns or authorized milestones.

| Direction | Necessity and importance | Cost and expected return | What would change the choice |
| --- | --- | --- | --- |
| Useful reads under ordinary-machine constraints | Core availability is blocked for the reported affected use. High impact; population frequency unknown. | High potential value. Native selection can be medium scope; general bounded interpretation is substantially more expensive. | Observe failing operation/build and largest processing unit. A heap-ownership issue needs a different remedy from avoidable complete-container work. |
| Find older decisions within a long conversation | Essential outcome; current grouping is an intentional tradeoff with a demonstrated retrieval limitation, not a proven failed user task. | A small task trial is cheap; changing match/paging semantics has medium compatibility and identity cost. | Compare precise query and whole-session reading against multiple matches with context. Short, uniquely worded histories may need no change. |
| Explain execution and recovery to an Agent | Important for long reads and refusals; existing final diagnostics already cover part of the need. | Reusing events/work counts is cheaper than a new monitoring platform. Interruptible synchronous phases cost more. | Determine which decisions an Agent cannot make from existing errors, read identity and gaps; measure actual stalls/retries. |
| Bound retained state and avoid repeated page work | Improves sustained searches and long evidence reads; not every short task requires it. | Cache policies and snapshot-bound revision reuse are comparatively contained candidates; correctness/refresh validation still matters. | Query diversity, paging frequency, cache bytes and end-to-end time may make savings insignificant. |
| Close demonstrated evidence/state and verification gaps | Supported defects deserve focused repair at their owners; broader expansion remains conditional. | Local regressions can be relatively cheap. Sweeping refactors or new CI machinery have less supported return. | Establish affected user journey and public contract before broadening each repair. |

The most useful first slice combines diagnosis of one reported blocker with a representative
decision-recovery task and enough existing diagnostics to measure them. Availability and relevance
are both required; improving one cannot establish the other. Broad rewrites should follow evidence
that this smaller route cannot meet the accepted outcome.

## Capacity: price the requested work

[ZCode's reader](../../packages/source-adapters/src/platforms/zcode/runtime.ts) opens SQLite
read-only and selects session/message/part rows, restricting by known session IDs when available.
Without them, those result sets are complete. The shared
[SQLite budget helper](../../packages/source-adapters/src/core/read-budget.ts) estimates selected
value lengths plus row overhead within the transaction, then collects the iterator with
`Array.from`. It protects an estimated input allocation, not total process RSS.

Current [probe handling](../../packages/source-adapters/src/core/probe.ts) allows path-backed
SQLite and supported incremental JSONL past the generic oversized-file skip. Preflight estimates
warn and proceed; the [runtime](../../packages/live-runtime/src/index.ts) still admits individual
inputs using live system/heap headroom and the 4/8 profiles. It is therefore inaccurate to attribute
the reported current ZCode refusal solely to the database's on-disk size.

Other growth mechanisms remain:

- The [streaming JSONL collector](../../packages/source-adapters/src/core/jsonl-records.ts) retains
  all raw records. A partial line grows by buffer concatenation; a huge record is another unit.
- Logical-session processing releases groups, but a logical session itself can be arbitrarily
  large. A 100 MB+ session must be examined separately from many small sessions.
- [Canonical interpretation](../../packages/canonical/src/session-interpreter.ts) eagerly builds
  complete contexts; runtime selection drops unwanted contexts afterward.
- Conversation text, complete snapshots, ranking caches, TUI overlays and temporary refresh
  generations contribute retained or overlapping state. Output budgets do not bound that work.

The [historical capacity experiment](2026-09-08-2000-turn-memory-capacity.md) observed roughly
254 MiB of tool-heavy input at 186.5 MiB peak Node RSS over 100 sessions, versus 1018.4 MiB in one
session. Those runs were sequential, synthetic, single observations under a 3.6 GiB Linux limit.
The [detail experiment](2026-09-05-detail-construction.md) reduced formatting work in some shapes
but demonstrated no material peak-RSS reduction. Optional detail is a plausible CPU optimization;
it is insufficient evidence for solving the reported capacity gap.

Compare conservative native selection and compact preparation with the complete reference path
before generalizing. Known-ID detail already exists, but first search does not know the ID.
Selection must preserve canonical scope, identity, recency, linking, delegated work and honest
coverage. General bounded processing also has to handle one huge value/session and retained
search text; merely switching `all` to an iterator cannot satisfy it. Relaxing protection or
making users tune heap flags is not an adequate default remedy.

Acceptance should name operation, artifact, source shape, largest unit, environment, input and
retained work, peak memory, success/coverage, abort and recovery. Cover large containers, large
sessions/records, repeated search/read/refresh and relevant concurrency with isolated sanitized
experiments. The native 16 GB report remains unclosed until its environment can be observed.

## Retrieval: a hit is not necessarily the needed decision

[Conversation search](../../packages/canonical/src/conversation-evidence.ts) searches full masked
user/assistant text, but keeps only the most recent matching message per top-level session.
Pagination advances those session results. This avoids duplicate sessions and controls output;
it also makes older matching messages inaccessible through search continuation.

The independent reviewer checked the existing
[parent fixture](../../mock_data/fixtures/agent-evidence/parent.jsonl): `fixture` matches two
messages, while search returns only the later follow-up, `total: 1` and `next_offset: null`.
The parent reproduced that result. It is a contract-consistent tradeoff, not an adapter loss or
proof that the real user's desired decision cannot be found by a narrower query.

Compare three journeys on sanitized old-decision/later-mention/reversal and delegated cases:
refined keywords, bounded reading of the session, and access to multiple matching messages with
adjacent context. Judge correct decision and citation, mistaken currentness, reading/query burden,
coverage and processing cost. Include paraphrases and ambiguous titles before concluding that
lexical search is adequate or semantic search is necessary. This trial should determine whether
a public match/pagination change buys enough value to justify its compatibility cost.

## Lifecycle and observability

The existing [history reader](../../packages/live-runtime/src/history-reader.ts) provides
process-owned collection reuse, bounded detail retention, read identities and refresh replacement.
An oversized detail is not cached and can be scanned again on continuation. Legacy ranking caches
in the runtime and the TUI's [search cache/overlay](../../apps/lite-tui/src/model.ts) have no
entry/byte eviction policy. A preceding local fixture probe retained 100 runtime and 100 TUI
entries after 100 distinct spellings of one query. This demonstrates growth, not an OOM or a
universal cache slope.

Evidence pages hash the entire target on every call. Using the parent fixture's four messages,
repeating text 37 times gives 8,806 UTF-16 units; a 257-unit budget with two chunks per page
reconstructs all text over 35 pages and serializes the four full messages 140 times. Both reviewers
observed this. Revision reuse within an immutable snapshot is a contained alternative to repeating
the work; target/content/order and refresh invalidation must remain intact. No latency saving or
numeric return was measured.

Existing read identity, read_status, source loss diagnostics and resource errors should be reused.
The [CLI progress callback](../../apps/lite-cli/src/index.ts) is wired only for non-JSON TTY output
and handles only a few stages. SQL runtime supplies
[work accounting](../../packages/live-runtime/src/selective-query.ts), while the
[result adapter](../../apps/lite-cli/src/query.ts) omits that work. These are concrete seams for
Agent diagnostics; they do not mean observability is absent everywhere.

Useful observations answer: which scope/read is running; which path and phase; what unit is being
processed; why preparation repeated or data was skipped; which budget limited the attempt; what
the caller can safely do next. Keep machine output contracts and privacy, label estimates versus
measurements, and avoid fabricated percentages. Long synchronous phases need real checkpoints
or independent supervision for cancellation; an event-loop timer cannot prove interruption.

## Evidence quality and engineering costs

Prior sanitized adversarial probes on this unchanged production tree exposed narrower issues:

| Probe | Observed result | Limit / responsible seam |
| --- | --- | --- |
| TUI detail across appends | Base summary retained one reply; first overlay held two; a later fresh detail had three but overlay still held two. | TUI overlay only inserts absent IDs. Base projection audit remained zero; mixed read freshness needs a coherent contract. |
| Unlinked activity | Synthetic unlinked bucket displayed 10:02 while latest turn activity was 10:06. | TUI takes the last element of a recency-ordered list. Canonical semantic ownership should be preserved. |
| Native error/usage evidence | Fixture Claude tool error projected success; an unanchored 10-token signal projected unknown total. | Adapter tool-result facts and canonical usage association. Supported shapes need explicit retained evidence/diagnostics, not a blanket interpretation rewrite. |
| Terminal text | A harmless fixture OSC title sequence survived both TTY and non-TTY text output. | Human text rendering boundary; JSON and application-added styling are different contracts. No native attack or damage was tested. |
| Architecture harness | A disposable domain copy importing the TUI was accepted by the manifest checker. | The forbidden-pattern list omits that higher layer. This is a checker gap, not an observed forbidden import in production. |

The probes used existing sanitized fixtures, disposable roots, explicit mtime advancement and
cleanup, or pure in-memory projections. They ran against the earlier successful local build in
this assessment; production source did not change afterward. They are not checked-in regression
tests, release verification, native-failure attribution or estimates of defect frequency.

These findings show why count/identity parity and green gates cannot establish full evidence
quality. Source-private schemas, malformed/unknown inputs, error/usage retention and delegated
identity still deserve task-specific coverage. Sixteen registered sources does not measure recall
coverage. The eight historical missing Gemini fixture paths remain visible debt, not a reason
to dismiss unrelated checks.

Build/release and boundary validation already have owners. Measure repeated compilation if it
meaningfully slows delivery, close demonstrated rule gaps locally, and validate the supported
artifact/platform when making compatibility claims. New adapters, broad file-splitting, a new
governance framework, a daemon/MCP transport and vector search currently have weaker evidence of
benefit than the preceding directions. They remain alternatives if task observations reveal that
existing retrieval, process reuse or the supported sources cannot meet the need.

## Remaining uncertainty and completion

No current native capacity certification, real-history recall rate, stall frequency, verified
cost savings, published artifact parity for these new probes or user-owned U1 acceptance was
obtained. The ordinary read-only countercase supports proportional behavior in one warm context;
the independent project assessment supports uptake in one fresh context, not a causal before/after
comparison or reliable future compliance.

The assessment and discipline reconciliation are delivered at their stated evidence layers.
Recommended product changes remain proposals. Runtime memory, retrieval, diagnostics and other
observed defects were not changed by this documentation work.
