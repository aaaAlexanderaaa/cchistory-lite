# Query architecture research

Sanitized reports from the 2026-09-05 investigation and subsequent implementation checks. They retain methods, aggregate measurements,
failed runs, coverage limits, and the reasoning behind the architecture sequence. They are
historical evidence, not performance guarantees or CI benchmarks.

Current status and the finite delivery checklist live in [the work plan](../../PLAN.md). Research
recommendations describe the stage when they were written, not an ever-growing implementation queue.

| Report | Evidence and code stage |
| --- | --- |
| [2000 turns under a 3.6 GiB Linux limit](2026-09-08-2000-turn-memory-capacity.md) | Synthetic cgroup measurements, successful light reads, full-read refusal and actual CLI SQL pagination; no universal turn-count guarantee |
| [macOS memory ownership correction](2026-09-08-macos-memory-ownership.md) | Failed independent trial, local OS telemetry, removal of adaptive heap policy and platform-signal correction |
| [First use and memory admission](2026-09-07-first-use-and-memory-admission.md) | Approved follow-up, code diagnosis and synthetic regressions; no native performance or independent agent acceptance claim |
| [Initial cost baseline and query journeys](2026-09-05-query-cost-baseline.md) | Native CLI observations before the shared-file-plan implementation |
| [Source capability survey](2026-09-05-source-capabilities.md) | Code inspection of all 16 registered adapters at the initial baseline |
| [Early execution prototypes](2026-09-05-query-prototypes.md) | Private inventory reuse, compact context, and selective latest experiments |
| [Preparation metadata reuse](2026-09-05-preparation-metadata.md) | Paired comparison of the completed file-plan slice with attempt-local metadata reuse |
| [Detail construction and allocation](2026-09-05-detail-construction.md) | Paired compact-context experiment after metadata reuse, with allocation attribution |
| [Canonical interpretation seam](2026-09-06-canonical-interpretation-seam.md) | Nonempty 16-source fixtures, before/after snapshot comparison, and implementation gates; no new native cost measurement |
| [Shared query execution and shell lifetime](2026-09-06-shared-query-execution.md) | Approved single-executor migration, Q1–Q8, regression gates and standalone/npm SQL execution; no new native performance claim |
| [Selective Codex latest](2026-09-06-selective-latest.md) | One production physical plan, adversarial complete-reference parity and synthetic work/cost observations; all inventory I/O remains |
| [Finite SQL parser selection](2026-09-06-query-parser-selection.md) | Two pinned parsers, synthetic query syntax and isolated dependency closures; M1 recommendation, not implemented query semantics |

The commit anchor is `2a36d1e`, version 0.4.4. Later reports compare successive uncommitted working
tree stages, identified explicitly in each report; the anchor alone cannot reconstruct those
stages. The initial environment record is macOS 26.5 arm64, 64 GiB physical RAM, Node v22.22.2.
Heap caps and fixture-specific guard overrides are reported separately. This was not a 4 GiB
host qualification, an isolated machine, or a controlled cold-filesystem-cache experiment.

## Sanitization and reproducibility

These documents omit usernames, hostnames, absolute checkout, home, or temporary-directory paths, native session and
project identifiers, transcript titles and text, credentials, raw CLI output, process identifiers,
and content-derived hashes. Native cases are described by source, scope shape, and operation.
Repository paths refer only to code and sanitized fixtures. Counts, sizes, durations, and reported
precision are preserved; no measurements were rerun or invented during sanitization.

Raw native outputs, profiles containing local paths, private build copies, and machine-specific
research harnesses remain outside the repository. These reports document how comparisons were
made and provide fixture shapes for repeating the experiments, but are not a self-contained
benchmark harness. Native results cannot be exactly reproduced without the omitted private corpus.
All native access used the CLI/runtime adapter path; native history was not modified to manufacture
test cases. Future native investigations must follow the repository's history-access skill.

## Relationship to the design

The initial estimator/execution mismatch was addressed by the shared-file-plan slice. Preparation
metadata reuse is implemented. The [M1 query contract](../design/2026-09-06-query-contract-v1.md)
and parser choice were approved; M2 query execution and shell lifetime are implemented and
validated. M3 implements and validates one selective Codex latest plan, with its bounded proof,
costs and final release-artifact acceptance recorded. The agreed M0–M3 delivery is complete.
Compact extraction and generation-bound late detail are not delivered. Early
prototype results must not be read as measurements of those later production changes.

The evidence informs the [bounded query model](../design/2026-09-05-bounded-query-model.md) and
[semantic/detail boundary](../design/2026-09-05-semantic-detail-boundary.md). The useful sequence is
to share validated preparation, reuse repeated metadata work, establish one canonical semantic
interpretation, then implement the reviewed finite syntax on the complete reference executor
before the single-source optimization. PLAN.md owns that sequence; older experiments do not
make optional extraction or general caching a prerequisite.

Across reports, distinguish process-tree RSS, one process's maximum RSS, post-GC heap, serialized
JSON size, and sampled allocation. They measure different things. Phase timings can overlap;
zero projection issues do not establish source completeness; empty source results do not prove
that a tool has never been used.
