# Selective Codex latest: implementation and acceptance

Date: 2026-09-06. Stage: M3, after the shared M2 executor. This is the final bounded milestone in
[PLAN.md](../../PLAN.md), with final repository gates recorded below. All new input and measurements
use hand-authored fixtures. No native user history was accessed for this slice.

## Decision and scope

Adopt a narrow physical read plan for one one-shot Codex latest-sessions SQL operation. The plan
returns exactly the complete executor's selected `id`, `title`, and `last_message_at` rows, while
it can avoid full interpretation of older logical sessions. It uses the existing adapter probe,
canonical interpretation, group collector, and canonical query executor. Complete execution is
another read policy for that mechanism; no old collection executor or compatibility switch exists.

Eligibility requires one Codex source, the published top-level/nonempty predicate, descending
last-message order with nulls last, those three selected fields in that order, offset zero, and
limit 1–1000. Complete totals, different shapes, other/multiple sources, sample/session targeting,
and multiple-operation batches use the complete reader without an activity inventory. A warm
shell already owns a complete snapshot and uses it. Equivalent syntax that does not lower to the
same template shape can still run completely; there is no general query optimizer.

## Evidence and stopping proof

The existing attempt-local plan discovers files, reads grouping identity metadata, and versions
admitted primary/companion evidence. The Codex adapter supplies an additional native-fact inventory:
the first record's session identity, maximum top-level timestamp across every record, encountered
tool names, and work counts. It streams lines with the existing 1 MiB metadata line cap. It does
not materialize snapshots or decide session eligibility.

For admitted record types, the Codex parser assigns fragment time from that top-level timestamp.
Missing/invalid timestamps could fall back to observation time, so they cannot certify a bound.
Unknown shapes, malformed or oversized lines, inconsistent identity, and possible delegation
metadata/path evidence cause complete execution. Tool names are bounded to 256 names of at most
256 characters per file. Canonical's existing family-link tool registry is consulted; it is not
duplicated in the adapter. Native shapes outside this conservative allowlist remain supported by
the ordinary parser where it already supports them, without selective execution.

All files of a logical session stay in one group. The maximum of their timestamp bounds bounds
the group's canonical message recency. Groups are read by descending bound. After each complete
group interpretation, canonical evaluates the actual template. Reading stops only when the next
unread bound is **strictly older** than the Nth selected row. Equal timestamps must be read, as
must newer empty sessions before they can be excluded. Filesystem mtime and the last line's
timestamp are not valid substitutes for this bound. Possible cross-session dependencies disable
the narrow independence proof and retain the complete path.

Admitted evidence is revalidated before/after inventory and before publishing a selective answer,
including skipped files. A changed version aborts this attempt; it does not mix versions or silently
reuse a stale bound. This is not an atomic native transaction: files newly appearing outside the
admitted inventory and changes after final validation have the same limits as the complete reader.

A selective read returns query rows, observed diagnostics and a process-local read identity. It
does not expose its temporary partial materialization as a reusable `LiveHistorySnapshot`.
`total` remains null; coverage reports selective/exact/observed. If every group was interpreted,
coverage is complete. `complete: true` always supplies the complete matching total and diagnostics.

## Correctness acceptance

The checked-in [fixture corpus](../../mock_data/fixtures/selective-latest/README.md) provides fixed
timestamps and duplicate titles, two tied nonempty sessions, an older session with a misleadingly
new file mtime, and an even newer empty session. Tests copy it to disposable roots and apply only
the checked-in variant records. Mtime changes are explicit; elapsed timing is not a test assertion.

| Case | Verified behavior |
| --- | --- |
| Latest two / ties / empty / misleading mtime | Same ordered rows as complete; interprets empty and both tied groups, skips one strictly older group |
| Split old session gains newer messages in a second file | Both files interpreted together; same newest session and values as complete |
| New real message followed by old metadata | Maximum timestamp protects the result; no last-line shortcut |
| Missing timestamp/identity, unknown shape, malformed JSON, oversized line | Complete fallback; reference rows and diagnostic counts preserved |
| Native child metadata or family-link tool, including whitespace in its name | Complete fallback; child eligibility and tool-name normalization follow the canonical reference |
| Changed skipped file after inventory | Attempt fails with `source_read_plan_changed` before returning rows |
| Complete totals, changed fields/offset, multiple sources | Complete reference behavior; no activity inventory |
| Matching and excluding directory scope | Same rows as the complete scoped executor |
| Fewer eligible rows than LIMIT | Reads all groups and reports complete coverage |
| Actual CLI template / complete / old latest / batch | Identical ordered IDs/values; old exact totals retained; mixed batch uses complete execution |

Clean fixtures assert zero projection issues; fallback cases compare those issues and loss-audit
counts with complete execution. The M2 Q1–Q8 acceptance and all 16-source projection regressions
remain part of the final package gate. Structural parity continues to carry the semantic limits
already recorded under PLAN D5.

## Cost observations

The experiment ran in the previously recorded macOS arm64 / Node 22.22.2 environment. Each read
used a fresh process. Three pairs alternated complete/selective order; OS caches were uncontrolled.
SQL compilation finished before timing `scanLiteQuery`. Setup and fixture generation were outside
that interval; preparation, inventory, payload processing, interpretation and query execution were
inside it. All twelve runs asserted identical selected rows across the paired modes. The complete
mode requested a total; both modes use the same filtering and sorting, so count calculation adds no
extra scan. No guard bypass or capacity qualification was used.

The tiny corpus is the five checked-in JSONL files (2,020 bytes), selecting two rows. The larger
corpus deterministically expands the ordinary-tool seeds into 60 sessions, one day apart from
2026-01-01. Each has a metadata record, user message, 32 call/result pairs, and a final reply (67
records). Each result repeats the fixture's ordinary output 140 times. IDs/call IDs are unique;
record times advance within the day and the reply is at +120 seconds. It totals 4,020 records and
9,226,620 bytes, selecting ten rows. Generated files and raw measurement logs remained temporary.

| Larger corpus work | Complete | Selective |
| --- | ---: | ---: |
| Discovered / planned primary files | 60 / 60 | 60 / 60 |
| Unique grouping-metadata evidence files | 60 | 60 |
| Additional activity inventory files | 0 | 60 |
| Activity inventory bytes actually read | 0 | 9,226,620 |
| Activity inventory JSON records decoded | 0 | 4,020 |
| Files through full payload processing | 60 | 10 |
| Native records through full payload processing | 4,020 | 670 |
| Canonical session interpretations | 60 | 10 |
| Retained session / turn rows | 60 / 60 | 10 / 10 |
| Files skipped before full payload interpretation | 0 | 50 |

Discovery counts entries returned by the source listing, after any explicit file limit. Metadata
counts unique evidence files, not read calls or bytes. Payload record counts are collected native
records, not literal `JSON.parse` invocations. Inventory bytes/decodes are measured separately.
Retained row counts describe the temporary materialization before query return, not a heap budget.
The inventory reads and JSON-decodes **every admitted file**; there is no avoided source-I/O claim
and no claim of fewer total JSON decodes. The demonstrated saving is 83.3% of full payload records
and canonical session interpretations on this larger fixture.

| Read elapsed time (ms) | Complete median (range) | Selective median (range) |
| --- | ---: | ---: |
| Tiny, latest two | 16.36 (14.80–18.90) | 17.63 (15.79–30.76) |
| Larger, latest ten | 126.77 (123.84–133.61) | 96.75 (91.63–100.45) |

The larger fixture's elapsed median decreased about 23.7%, while the tiny median increased about
7.8%. Larger-fixture CPU medians were 268.63 / 222.48 ms. Process maximum RSS medians were
130,096 / 129,888 KiB, which do not establish a meaningful peak-memory reduction despite fewer
retained rows. These are fixture observations from three pairs, not a native performance estimate,
confidence interval, startup benchmark, cold-cache experiment, or universal benefit. Conservative
fallback can add inventory overhead before complete parsing. No adaptive threshold was invented
from these two samples, and no other-source optimization was added to compensate.

## Final validation

The final state passed **624 package tests**: domain 103, canonical 33, adapters 245, runtime 107,
CLI 49, and TUI 87. M3 added six runtime tests (multiple adversarial cases) and one CLI test.
The package dependency gate, `build:lite`, and governance passed; governance ran 13 harness tests
and checked five architecture rules across 110 rule-file matches.

Release validation built/extracted the standalone artifact and installed its packed npm package
into a temporary prefix. Both executed SQL, then ran the shipped latest-sessions SQL file in
selective and complete modes with equal rows and the required coverage/totals. A final artifact
check repeated extraction/installation using the final rebuilt outputs after the tool-name
normalization regression fix. No package was published.

Mock-data layout and content validation passed for all 151 files. Full scenario validation still
reports the same eight missing Gemini paths tracked as PLAN D6; it is not claimed to pass. The
new report contains no workstation paths, real transcript content, native IDs, credentials or
raw profiles. It preserves observed aggregate results and the reproduction recipe.

M0–M3 acceptance is complete in the uncommitted working tree. The experiment proves a useful,
conditional interpretation saving for this one source/query shape. Optional detail construction,
general memory/capacity bounds, broader syntax and other-source optimization remain deferred;
none is a new prerequisite or automatic follow-up to this delivery.
