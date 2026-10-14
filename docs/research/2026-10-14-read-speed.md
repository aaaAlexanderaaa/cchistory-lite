---
doc_type: evidence
status: historical
authority: evidence
last_reconciled: 2026-10-14
---

# Useful history read speed

The authorized speed follow-up is implemented in the working tree. It reduces first-answer
latency on the measured large-session, SQLite and whole-JSON fixtures while preserving answers,
citation identity, canonical projections and admission. The comparator is the successful
capacity/recall delivery immediately before these speed edits, **not** Git HEAD's refusal path.
This record supports the implementation and named fixture envelope; it does not close the
owner's unobserved native failure or the separate user-owned U1 quality judgment.

## Changes and their costs

ZCode's inventory admission previously executed the ordered part query inside its byte aggregate,
evaluating body lengths and sorting before repeating that work for retrieval. Admission now
prices the retained locator/message-ID inventory directly, with a conservative numeric-field
allowance. It avoids body-length evaluation and sorting during that prepass. The actual inventory
still traverses parts and computes their sizes once, and every part remains admitted before
retrieval in the same read-only transaction. No source indexes are created. Per-session message
queries, inventory growth and native large-value decoding remain costs.

Metadata-only ZCode and AMP records lend their decoded objects to the parser. The collector
strips these private references before emitting probe records; the default full raw-record path
is unchanged. Exact normalized JSON byte ownership is preserved without a full large encoding:
native JSON serialization owns structure and scalar semantics, while large string values are
replaced with empty strings and their escaped UTF-8 byte lengths are counted in bounded chunks.
The accounting handles controls, quotes, backslashes, Unicode and unpaired surrogates. This adds
a small byte-counting helper and regression responsibility rather than a second JSON serializer.
AMP also shares its decoded root with native session identity extraction, eliminating another
whole-file decode. Missing IDs, primitive roots and malformed input retain fallback identity and
loss evidence. Whole-file AMP still reads and decodes its complete native file.

For `contextMode: "none"`, canonical omits tool/system display masking, previews and tool-input
serialization that would be discarded. Semantic context nodes, assistant masking/replies, tool
association, ordering, linking and usage are still computed. Full and matching reads retain their
complete display detail. This is optional formatting, not fully optional semantic construction or
skipped native decoding. The existing full/none/matching matrix covers every registered source.

Large JSONL uses native buffer delimiter searches instead of per-byte JavaScript iteration.
Checksum capture reuses its read block and copies only the bounded retained tail. Parsing keeps
fresh backing blocks where unfinished lines borrow slices. CR/LF, split CRLF and empty chunks
are covered. Checksum capture and parsing remain two passes because record identity requires
the completed digest; combining them would need a wider identity/ownership change.

Optional progress diagnostics now distinguish attempt `elapsed_ms` from producer
`stage_elapsed_ms`. Parent file/source stages include child work; adding every reported stage
duration would double-count it. The [guide](../guide/agent-evidence.md#observe-a-read) and
[diagnostic schema](../../schemas/cchistory-lite-diagnostic-v1.schema.json) own the public fields.

These changes target work that every cold Agent recall may pay and have bounded implementation
and compatibility cost. General native project/cwd pushdown was evaluated and left out: session
directory, message workspace evidence, canonical project linking and delegated relation closure
are not interchangeable. A direct native directory predicate could silently suppress evidence
and diagnostics. Existing exact-session reads remain available. Their correctness does not prove
a safe general first-search project filter. The measured reductions justify this delivery without
introducing that larger semantic risk or a persistent cache.

## Equal-input observations

Both builds are uncommitted 0.6.0 working-tree states anchored at
`f9d84a5eb0bed25b45153e53d0a7386e993569ec`. The pre-speed source/build was frozen before edits.
Compiled non-test JavaScript fingerprints for domain, canonical, source-adapters and runtime,
all worker observations and intermediate contrary results are retained in the
[aggregate record](2026-10-14-read-speed.json). Those fingerprints identify the local builds;
they are not reconstructible Git revisions. The final compiled candidate differs from the timed
candidate only in the interpreter's documentation comment; both fingerprints are retained. The
[fixture experiment](../../scripts/measure-read-capacity.mjs) expands checked-in sanitized data
into disposable native-shaped roots. Workers open them read-only; scan locks are outside those
roots. No developer or owner native history was accessed.

The operation is a core-library `none` scan retaining masked conversation evidence, followed by
searching the expected answer and reading its cited turn/session. Task elapsed includes all three;
scan elapsed is also retained. Success requires the expected turns, correct assistant answer,
zero projection issues/loss audits and `no_known_gaps`. Each pair also matches a digest of complete
sessions, turns, retained conversation, related work, contributions and canonical project counts
and activity. Generated fixture digests contain no private history. This verifies the measured
answers/projections, not source exhaustiveness or today's decision relevance.

Environment: actual **16 GiB macOS arm64**, **Node v22.18.0**, explicit worker heap flags and the
real OS availability signal with the light guard enabled. This exercises the core library rather
than the adaptive CLI launcher. Effective heap limits / sampled RSS caps are 560 / 1280 MiB for
Codex and medium ZCode, 1072 / 1792 MiB for AMP, and 2096 / 2560 MiB for large ZCode. Controller
old-space is 384 MiB for medium inputs and 128 MiB for the large-only run. Every worker has a
60-second wall limit, 20-second no-progress limit and 1 MiB output limit. Its process group is
killed if RSS sampled every 250 ms exceeds the cap; this is supervision, not a hard OS quota.
Process-lifetime maxRSS also records peaks between samples and can include verification work
after the timed task. Workers and generated roots are cleaned up.

The four medium inputs each use three pairs on the same generated corpus, alternating build
order baseline/current, current/baseline, baseline/current. The large input uses one baseline-first
pair. Filesystem cache was not reset and the host was not isolated; GC and other local work can
affect results. Medians below are descriptive observations, not confidence bounds or an SLA.

| Fixture shape | Native MiB | Paired runs | First-answer median s, before → after | Time reduction | Peak RSS median MiB, before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Codex, one logical session / 512 turns | 134.49 | 3 | 1.950 → 0.899 | 53.9% | 352.2 → 292.7 |
| Codex, 64 sessions / same 512 turns | 134.50 | 3 | 1.799 → 1.596 | 11.3% | 140.3 → 151.7 |
| ZCode, 10 sessions / 514 turns | 134.71 | 3 | 2.161 → 1.365 | 36.9% | 290.0 → 247.0 |
| AMP, one whole JSON / one large tool value | 107.39 | 3 | 2.492 → 1.299 | 47.9% | 935.5 → 377.1 |
| ZCode, same rows / ~2.6 MiB tool values | 1342.88 (~1.408 GB) | 1 | 21.836 → 10.434 | 52.2% | 1673.9 → 965.8 |

Both builds completed every final case; all 13 paired semantic digests agree. Large ZCode still
decodes all 514 turns across ten sessions, including eight unrelated project sessions and a
parent/child target. The answer read remains scoped to the target project. It retains 1,028
conversation messages / 29,813 UTF-16 units and no contexts. No avoided native project I/O is
claimed. The AMP corpus removes the fixture's original unsupported chart block during corpus
creation identically for both builds, preserving its supported text/tool-result path; ordinary
fixtures still test unexpected-content losses. This is no chart-format qualification.

Experiment-only counters time JSON inputs/outputs of at least 64 Ki UTF-16 units and SQLite
statement execution, identically for both builds. The verification digest uses the saved native
serializer and is excluded from production JSON counters. Large ZCode's measured large decode
calls decrease **1,024 → 512**, and large encoding calls **512 → 0**. Native inventory admission
statement time decreases **1,719 → 19 ms**; its ordered inventory and native value retrieval still
run. Canonical derive duration decreases **2,552 → 62 ms**. These nested durations are not
independent additive shares. AMP's large decode calls decrease **4 → 1** and large encoding
calls **2 → 0**. Zero large encoding calls does not mean no small JSON serialization.

The many-small-session result is a qualified benefit: elapsed median improves, while RSS median
increases by **11.4 MiB (8.1%)**. Its candidate task times are 1.596, 1.585 and 1.779 seconds;
the third observation is close to baseline. This delivery does not establish a universal memory
reduction or a stable percentage speedup for small inputs.

## Contrary results and stopping basis

An unchanged-build medium-ZCode control recorded 2.185 versus 2.084 seconds, illustrating local
variance. An intermediate candidate with borrowed decoding and the cheaper inventory preflight,
before large-string accounting/context-formatting/JSONL improvements, made the single large JSONL
session slower: 2.018 → 2.666 seconds. ZCode and AMP improved in that comparison, but it did not
justify declaring the whole task faster. The final three paired large-session observations reverse
that result; the intermediate is preserved in the aggregate evidence.

One optional large experiment declined when observed availability was **2,552,659,968 bytes**,
below its unchanged 3 GiB preflight. It measured no workers and cleaned generated inputs. The
successful large-only run began at **4,041,490,432 bytes** availability. No substituted OS signal,
guard bypass or relaxed cap was used. Earlier profiling accidentally counted the experiment's own
verification serialization as a production large encoding. The final measurement excludes it;
intermediate encoding counters are omitted rather than used as causal evidence. Their elapsed/RSS
observations remain retained.

The former explanation that ZCode hashes the entire database was incorrect: path-backed capture
hashes size/mtime/ctime metadata. This delivery does not claim a database content-hash optimization.
The earlier [capacity record](2026-10-13-useful-history-capacity.md) retains the correction and
original observations. JSONL does have its separate content-checksum pass.

The selected implementation removes measured redundant work without changing public query syntax,
layout, scope, source ownership or canonical meaning. It adds one byte-count helper, one optional
interpreter formatting choice and one conservative adapter admission query. Remaining costs are
native decoding, inventory/session growth, whole-file formats and full semantic state. A safe
native selection proof or optional semantic construction may buy more, but is a larger change;
this evidence does not authorize it or make it an unfinished prerequisite of this delivery.

## Verification and delivery state

- `pnpm run build:lite` and all **672 package tests**, including dependency-boundary verification.
- Every registered source's full/none/matching projection and searchable-evidence matrix;
  borrowed/full AMP and ZCode parity, exact byte ownership, malformed identity and JSONL boundary
  regressions. The new malformed-root comparison freezes observation time rather than depending
  on how fast sequential reads happen.
- **13 governance tests**, **5 architecture rules / 119 production rule-file matches**.
- Extracted standalone and local npm package verification, including actual launcher behavior,
  delegated answer/cursor identity, shipped skill equality and stage/attempt diagnostics.

- All **12 schema definitions** pass Draft 2020-12 checks. Actual fixture requests/outputs validate
  **10 current CLI contracts**, including 50 completed-stage progress events and evidence cursor
  continuation. Historical query v1 is rejected by the current CLI; its request schema was checked
  separately and its result schema is definition-only, not an observed current response.
- The shipped skill passes `quick_validate.py`; temporary pinned JSON Schema/PyYAML validators
  add no project dependency. Local documentation links, original instruction/history preservation
  and tracked/new-file whitespace checks pass.

Current delivery state is owned by [PLAN.md](../../PLAN.md).
The existing fixture-layout debt remains the same eight missing Gemini scenario paths identified
in the prior delivery; this speed follow-up adds no fixture files or adapter. Code and documents
remain uncommitted and unreleased. No persistent store, source write, new mutation command,
background job, transport or visual redesign was introduced.
