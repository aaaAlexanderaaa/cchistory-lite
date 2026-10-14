---
doc_type: evidence
status: historical
authority: evidence
last_reconciled: 2026-10-13
---

# Useful history capacity and recall

This record describes the capacity/recall checkpoint before the subsequently approved
[read-speed delivery](2026-10-14-read-speed.md). Its measurements and remaining-work statements
retain that checkpoint's scope; current behavior is owned by architecture and public contracts.

The authorized integrated implementation is complete. It makes several previously
refused fixture shapes readable, exposes optional read diagnostics, and lets an
Agent recover older matching decisions instead of only the latest hit in a session.
The primary outcome is answer/context recovery with stable citations in the requested
scope. This is implementation and fixture evidence, not acceptance of the owner's
unobserved native database or the separate user-owned U1 quality trial.

## Implementation and boundaries

The source-read unit was the demonstrated availability mechanism. ZCode previously
admitted/materialized whole message and part results; it now retains a compact part
inventory, reads messages per session and admits each part's native value lengths
before retrieving its body in one read-only SQLite transaction. Native part ordering,
session targeting and relation evidence are preserved; a WITHOUT ROWID fixture checks
the primary-key locator fallback. A single message's parts, session's normalized
evidence and complete canonical state can still grow. This is not a universal
constant-memory parser or project-predicate pushdown.

Lite requests metadata-only raw records: original JSON is released after parsing or
required native reconciliation, while identity/provenance/native byte lengths remain.
The probe's default raw-record contract is unchanged. Contribution accounting uses
retained byte lengths. Metadata-only previous payloads receive a fresh native read
instead of attempting incremental reconciliation from missing bodies.

Codex/Claude/Factory large JSONL uses bounded blocks and linear line assembly, feeding
records directly into the existing parser. Small admitted files keep buffered I/O
to avoid the initially observed small-file regression. Growing records are admitted
during checksum capture as well as parsing, before a whole record is decoded. Whole-file
formats keep their whole-file allocation admission; guarded reads no longer treat the
unguarded 64 MiB fallback as machine capacity. Explicit whole-file caps remain binding.
Admission multipliers and the watchdog remain enabled. No persistent store, source
write, new mutation command or alternative semantic executor is introduced.

Conversation `group_by: "message"` exposes each matching user/assistant message,
including older decisions and delegated evidence. Default session grouping is unchanged.
The fixture journey pages an original decision, later mention and reversal, then reads
the original question/answer by its actual turn/message IDs in one shell scan. Child
answers with no user turn keep `turn_id: null` and their own session identity. This
does not infer which historical decision should govern today's task.

Prepared immutable evidence readers hash complete content once using bounded UTF-16
chunks. The snapshot's page-reader cache is limited to 32 entries / 100,000 message/key
units; authored rank caches in runtime and TUI to 32 / 20,000 row/highlight/key units.
These are additional-state limits, not RSS or underlying-text quotas. Eviction can
repeat work without losing answers. Authored search uses snapshot preparation time
so scores do not drift on eviction. Successful refresh replaces ownership; failure
preserves usable snapshots, and close releases it. Full canonical contexts are still
constructed before context-light materialization discards them. TUI context overlays
and broader generation/freshness work are not certified by these cache checks.

The owner explicitly approved optional structured stderr progress. `--diagnostics`
preserves stdout and emits metadata JSONL stages, attempt/read IDs, live heap/system
admission facts, sampled heap/RSS, SQL work and shell cache decisions. It does not log
transcript/tool bodies or query text; paths can occur. Counts carry units; file size
is not physical I/O. SQL work distinguishes inventory, collected records, interpretation
and retained rows. Every refused allocation remains evidence through source losses;
`read_done` may legitimately report partial history. Setup failures emit `read_error`.
The [guide](../guide/agent-evidence.md#observe-a-read) and public diagnostic schema own
the fields and limitations. No TUI visual redesign was implemented.

## Equal-input capacity observations

Baseline: isolated compiled checkout of commit
`f9d84a5eb0bed25b45153e53d0a7386e993569ec`, version 0.6.0. Candidate: the uncommitted
0.6.0 working-tree delivery on 2026-10-13. The
[experiment script](../../scripts/measure-read-capacity.mjs) builds only temporary,
native-shaped expansions of checked-in sanitized fixtures, then reads them without
writing their source roots. No developer/user history was accessed. Dataset and scan
lock are separate; worker processes and datasets are cleaned up.
The AMP expansion retains the fixture's text/tool-result path and removes its
original unsupported chart block at corpus creation, identically for both builds.
It isolates capacity for supported evidence rather than certifying that chart format;
unexpected-content loss handling remains covered by the ordinary fixture matrix.

Actual environment: macOS arm64, **16 GiB physical RAM**, Node **v22.18.0**. Workers use
explicit heap flags and the real OS availability signal, with the light guard enabled;
they call the library core, not a simulated 8/16/64 GiB host or adaptive launcher.
Each worker has a 60-second wall limit, 20-second no-progress limit and 1 MiB output
limit. RSS is sampled every 250 ms and exceeding the stated bound kills its own process
group; this is supervision, not a hard OS quota. Process-lifetime `maxRSS` also records
peaks between samples. The large case starts only above 3 GiB observed availability.
Its first successful supervised run began near 3.23 GiB available memory.

Both builds receive identical input/request per case. The task is a context-light,
masked-conversation scan followed by answer search and cited evidence reading. Success
requires the expected turn count, zero projection issues, `no_known_gaps` and the
expected assistant answer. The large ZCode case contains eight unrelated project
sessions plus the small parent/child project; the answer read stays scoped to the
latter, while all 514 turns are decoded. This does **not** claim avoided source I/O.
Path-backed SQLite capture hashes file metadata (size/mtime/ctime), not container
contents; full native inventories and payloads can still be read. JSONL capture
does perform a content-checksum pass before its parsing pass.

| Shape | Native MiB | Effective heap limit MiB / sampled RSS cap MiB | Baseline task | Current task | Current elapsed s / peak RSS MiB |
| --- | ---: | ---: | --- | --- | ---: |
| One Codex session, 512 turns, ~256 KiB tool values | 134.49 | 560 / 1280 | Partial, 0 turns, 1 loss | 512 turns, correct answer | 1.946 / 348.8 |
| 64 Codex sessions, same 512 turns and total evidence | 134.50 | 560 / 1280 | Success | Success | 1.786 / 149.8 |
| ZCode, 10 sessions, 514 turns, ~256 KiB tool values | 134.71 | 560 / 1280 | Partial, 0 turns, 1 loss | 514 turns, scoped answer | 2.281 / 284.4 |
| AMP whole JSON, one ~107 MiB tool-result value | 107.39 | 1072 / 1792 | Partial, 0 turns, 1 loss | 1 turn, correct answer | 2.549 / 842.4 |
| ZCode, same rows with ~2.6 MiB tool values | 1342.88 (~1.408 GB) | 2096 / 2560 | Partial, 0 turns, 1 loss | 514 turns, scoped answer | 24.117 / 1250.9 |

Every current case finished with zero projection issues and loss audits. The largest
observed admitted native unit was 4 MiB for streaming Codex, ~2.10 MiB for small buffered
Codex, 275,023 bytes for medium ZCode, 112,607,148 bytes for whole-file AMP, and
2,746,855 bytes for large ZCode. AMP demonstrates both removal of a false file-size
barrier and substantial remaining whole-file allocation cost. Large ZCode retained
10 sessions / 514 turns / 1,028 evidence messages (29,813 UTF-16 units), with zero
retained contexts; it processed 1,038 normalized collected records. That count is not
native SQL rows or JSON.parse calls. The
[aggregate measurements](2026-10-13-useful-history-capacity.json) retain both builds,
actual limits, admission maxima, semantic-state counts and checkpoint counts.

These are baseline-first paired observations, not randomized timing experiments or
cold filesystem-cache measurements. Other host work, GC and instrumentation affect
elapsed/RSS. An earlier successful large run recorded 17.847 s / 1774.4 MiB versus
baseline refusal at 10.032 s / 857.6 MiB. The final baseline refusal took 10.351 s /
906.2 MiB. Successful processing naturally consumes more than rejecting the task;
neither comparison establishes universal speed or memory improvements.

The retained contrary case is many small sessions. The initial always-streaming
candidate was 2.721 s / 154.1 MiB versus baseline 1.918 s / 121.5 MiB. That prompted
the bounded buffered preference. The final observation was 1.786 s / 149.8 MiB versus
baseline 1.714 s / 137.6 MiB: still some overhead, not a demonstrated speedup. One
supervised intermediate comparison was 2.032 s / 146.0 MiB versus 1.846 s / 140.3 MiB.
No numerical performance promise is derived from these single observations.

The first experiment could not sample RSS inside the sandbox (`ps` was denied).
Its self-reported peaks were observations only, not an enforced RSS claim. Later
runs used explicitly reviewed read-only child-process inspection. The first large
experiment's 6 GiB availability preflight declined before generation; a smaller
2 GiB old-space / 2.5 GiB sampled RSS envelope retained a 3 GiB availability check
and then succeeded. No guard bypass or substituted OS memory reading was used.

## Repeated work and failure evidence

Follow-up cost-attribution correction: the initial report and chat incorrectly
attributed part of SQLite scan time to a whole-container hash. Inspection of
`capturePathBackedBlob` disproved that explanation; the measured elapsed/RSS values
remain observations, but no stage share was established. Current ZCode instead
executes its part-inventory query once for aggregate metadata admission and again
for retrieval, and converts native JSON through parsed objects, serialized normalized
records and another parser. A read-only EXPLAIN over the checked-in fixture in a
temporary in-memory native-shaped database showed `SCAN part` and a temporary ORDER
BY tree for both inventory passes, plus `SCAN message` for a session query. These
plans depend on the fixture's indexes and do not establish a user's native plan
or elapsed bottleneck. They support focused measurement/optimization candidates,
not a promised speedup or authorization for a new implementation increment.

The original four-message fixture repeated 37 times contains 8,806 UTF-16 units.
With a 257-unit / two-chunk page budget, both builds reconstructed all text in 35
pages. Instrumented baseline `JSON.stringify` serialized whole message bodies
140 times, processing 308,210 body units; the prepared candidate serialized no
whole bodies during preparation/paging. It still hashes the complete owned evidence
once. This establishes eliminated repeated work, not a measured RSS reduction or
a cross-process cache. One-shot continuation necessarily prepares another read.

A first implementation regressed the sparse huge-record fixture: it performed a
checksum pass before record admission. One runtime test spent ~435 seconds on a
256 GiB sparse file; the test run was interrupted rather than accepted as success.
Admission was moved into checksum capture as well as parsing. The regression now
checks a 16 MiB sparse record is rejected within a 256 KiB read window with 128 KiB
unit headroom; runtime's larger sparse-file tests finish normally. No timing assertion
or real native history is used. A refused/corrupt input can lose its entire file
while other history remains readable; partial status stays explicit. Checkpoints
cannot interrupt every synchronous native allocation.

Full schema validation found pre-existing drift: the `agent` producer/launchers use
adaptive default heap policy, warning-only estimates, live per-read admission and
a capped watchdog reserve, while the schema still described older policy/fields.
The schema now matches the actual baseline behavior; launcher policy was not changed
by this delivery. Existing structural tests now compare those const fields and
closed property sets. Artifact message-search assertions also initially assumed
only the parent fixture; the complete adversarial corpus correctly contains four
matches across child/duplicate sessions. Verification now pages all four unique
IDs and reads the older parent citation.

## Verification and value

Final `pnpm test` passed **668 tests**: domain 103, canonical 40, source adapters 251,
runtime 118, CLI 69, TUI 87, followed by production dependency-boundary verification.
`build:lite` passed. Governance passed **13 tests** and **5 architecture rules across
118 production rule/file matches**. Standalone extraction and local npm installation
passed the artifact gate, including diagnostic JSONL, older message paging/citations,
delegated null-turn answers, continuation and shipped-skill equality. All 12 public
schemas passed Draft 2020-12 schema checks; actual fixture outputs for agent, message
search, old citation, continuation, compact/canonical collections, SQL, errors and
diagnostics passed their schemas (41 trace events in the conversation request).
The shipped skill passed `quick_validate.py`. JSON Schema/PyYAML QA dependencies were
isolated in a disposable temporary environment, not added to production dependencies.
Local links, original AGENTS/dated PLAN preservation and tracked/new-file whitespace
checks passed. `mock-data:validate` still reports the same eight pre-existing missing
Gemini scenario paths as the isolated baseline; no new fixture scenario failure was
introduced. This separate validator is not counted as a passing gate.

The implementation targets high-value mechanisms because the old behavior blocks
the identified recall task on ordinary inputs. It reuses existing interpretation,
evidence operations and progress/work owners, with a contained optional grouping
field and cache policy instead of a store, daemon or new retrieval engine. The
comparison changes four failed shapes into successful reads, while preserving the
already successful small-session control. Frequency, user time saved and ongoing
maintenance cost are not measured, so no numeric economic ROI is claimed.

This closes the authorized implementation and verification, not a general promise
that arbitrary history fits on 8/16/64 GiB machines. Unknown native schemas, large
single values/messages, huge inventories, eager canonical contexts, all-source
pushdown and generation-aware TUI overlays remain relevant limitations. The owner's
original native failure has no captured failing command/build/data here; its exact
cause and successful recovery cannot be certified from sanitized examples. U1 remains
user-owned. Changes are uncommitted and unreleased; CI owns any later release.
