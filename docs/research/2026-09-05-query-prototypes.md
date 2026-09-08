# Early execution prototypes

Date: 2026-09-05. Stage: experiments following the initial baseline, before the production
shared-file-plan slice. External module-load hooks modified the loaded build in memory; product
source was not changed by these prototypes. No query grammar or database engine was introduced.
See the [research index](README.md) for provenance and sanitization.

## A. Reuse inventory and metadata within one preparation

The prototype cached discovery and metadata inspection for one scan. Metadata admission and reuse
validated device, inode, size, modification time, and change time; changed evidence was not admitted.
Different parameters had separate entries. Each scan created and then cleared its own experimental
cache. New primary files were outside that attempt's fixed enumeration and appeared on the next
attempt. This was a serial global-hook prototype, not an appropriate ownership API for production.

The same scoped Codex latest-ten command was observed in two orders:

| Execution order | Original scan ms | Shared-plan scan ms | Original second metadata pass ms | Reuse validation ms |
| --- | --- | --- | --- | --- |
| Original A1, then shared B1 | 393.27 | 252.36 | 110.78 | 1.28 |
| Shared B2, then original A2 | 386.75 | 305.26 | 114.42 | 1.51 |

Each inventory contained 415 candidates and each scan parsed four files. Both shared runs hit the
inventory and metadata caches. The observed scan reduction was about 81–141 ms. These are two
instrumented comparisons under background load, not a statistical benchmark; scan time excludes
launcher and process-exit costs.

Across five native runs, including the combined compact-context experiment, two inactive sessions
were field-for-field equal and projection audits had zero issues. An active session grew naturally
and was excluded from cross-run byte-equality claims. Sanitized-copy checks exercised content/mtime
changes, deletion, parameter changes, and a new preparation. A fixture-backed CLI check also passed.

A separate corrected preflight used the adapter's selected primary files rather than the generic
root walk. It estimated the ZCode container at 321,089,536 bytes, refused the scan, and deliberately
exited with code 1 before any payload parse. The database contents were not read again for that test.

This prototype did not settle companions, relationship expansion, cancellation, concurrent callers,
cross-process reuse, or stat/read races. The later
[file-plan and metadata contracts](../design/2026-09-05-bounded-query-model.md#first-implementation-boundary)
replace the prototype's ownership and evidence model; these timings are not measurements of that
production implementation.

## B. Separate semantic evidence from full detail

The compact-context prototype kept usage association, model and stop-reason facts, reply/tool
counts, and spawn-tool details used by delegated summaries. It omitted system presentation,
ordinary tool input/output formatting, and full reply display fields. Full and matching requests
used the original path. It still read and decoded native text and retained records, fragments,
atoms, and small reply/tool intermediates. Its incomplete context-shaped objects were experimental,
not a proposed public payload type.

It preserved the conditional handling of assistant reference segments. Later inspection found
that the current masking implementation does not generate those segments; this was not evidence
of an active assistant-path extractor.

Thirteen fixture-root comparisons produced equal complete snapshot data, equal results for three
searches, and zero projection issues. Gemini was empty, OpenClaw had no user turns, and Kimi,
ZCode, and LobeChat were absent from that comparison. Source count alone was not semantic coverage;
orphan usage, errors, masking and complex delegation needed further regression cases.

Each expanded fixture shape below was observed once per branch in a separate process. Temporary
corpora were derived from sanitized fixtures and cleaned in `finally`; observation time was fixed.

| Shape | Sessions / turns | Input MiB | Original / compact scan ms | Original / compact max RSS MiB | Original / compact post-GC heap MiB |
| --- | --- | --- | --- | --- | --- |
| Many small sessions | 32 / 256 | 1.29 | 91.50 / 89.96 | 116.52 / 115.92 | 9.818 / 9.817 |
| Large tool outputs | 4 / 16 | 16.55 | 85.91 / 76.95 | 101.00 / 100.67 | 8.072 / 8.071 |
| One larger session | 1 / 32 | 8.30 | 47.47 / 43.33 | 91.44 / 91.28 | 8.029 / 8.028 |

Snapshot hashes matched within each case and all projection audits were empty. Input consisted
of low-entropy ordinary tool text, not large multimedia or dense masking patterns. Max RSS came
from Node `resourceUsage`, included startup and small result-summary serialization, and is not the
process-tree RSS used in the initial baseline. The returned snapshot remained reachable at GC.

Serialized hot collections did not shrink; the many-small case retained about 662 KB of turn JSON.
Serialized bytes are not retained-object bytes. A combined native run took 289.51 ms, versus
252.36 ms for shared preparation alone in B1, but active data and insufficient repeats prevent
isolating an effect. These observations motivated the later
[allocation study](2026-09-05-detail-construction.md), rather than a claim that context dominates memory.

## C. Prove selective Codex latest projection on a constrained schema

The experiment asked only for the exact top-1 top-level nonempty session ID and canonical activity
time, without exact total, complete family presentation, or exhaustive loss diagnostics. It used
the maximum top-level record timestamp as a conservative upper bound for the permitted fixture
schema; missing valid timestamps meant an infinite bound. Files were grouped by complete logical
session. Stopping required remaining bounds to be strictly earlier than the current result so
equal-time candidates still participated in the canonical tie-break.

| Fixture scenario | Files read for timestamp inventory | Distinct files selected for projection | Outcome |
| --- | --- | --- | --- |
| mtime reverses real activity | 4 | 1 | Matches complete reference; mtime truncation chooses the wrong object |
| Equal timestamps | 4 | 2 | Canonical tie-break preserved |
| Missing timestamps | 4 | 1 | Uncertain candidate interpreted first; actual fallback time determines the answer |
| One session across files | 4 | 2 | Complete group interpreted |
| Newest metadata belongs to a turn-less session | 4 | 2 | Continue after excluding the empty session |
| Delegated relationships | 4 | 4 | Conservative fallback |
| Exact total requested | 4 | 4 | Complete execution |
| Evidence changes after inventory | 4 | 4 | Version check triggers experimental fallback |

Every answer matched the complete canonical reference and the selected result had zero projection
issues. The experiment first built a full reference and could repeat projection of selected files.
The table counts distinct selected files, not parse calls or measured performance. The prototype's
fallback on changed evidence is also distinct from the production file plan's attempt-invalidating
error; do not infer snapshot guarantees from this proof harness.

The timestamp phase still read and JSON-decoded **every fixture file**. This proves avoidance of
some canonical projection, not sublinear native reads. The timestamp bound was not proved across
all real Codex event versions. No independent reader was used against native roots.

## Architectural consequence

Use a complete compact generation as the equivalence reference within an explicit resource
envelope. Add selective plans only with source evidence, a stopping proof, and compatible result
requirements. Inventory ownership comes first, then measured reuse and semantic/detail separation.
Syntax and transport remain downstream. These experiments do not determine maximum capacity,
idle TTL, cache policy, concurrent refresh costs, or support for an extreme single session.
