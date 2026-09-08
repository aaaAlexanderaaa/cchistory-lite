# Preparation metadata reuse measurements

Date: 2026-09-05. Baseline: the completed shared-file-plan slice before metadata reuse. Candidate:
attempt-local `PreparationMetadata` reuse. These are successive uncommitted 0.4.4 working tree
stages, not two published releases. See the [research index](README.md) for provenance.

## Method and coverage

Private copies of the two runtime builds used the same instrumented adapter copy; canonical and
CLI code were otherwise identical. Counters added no filesystem reads. A metadata inspection
counted an actual single-file inspection or a file assigned to a worker batch; worker-local
counts were not counted again. Counts are work units, not native bytes or physical I/O operations.

Each scenario had six pairs, alternating baseline/candidate execution order, for 48 successful
runs. Preparation time ran from scan entry to the first `source_start` event; scan time included
materialization. These are wall-clock durations, not CPU profiles. The RSS metric is one process's
maximum from `resourceUsage`, including work outside the timed scan; it is not process-tree RSS.

The paired comparison included sessions, turns, usage, and projection issues, excluding only the
usage report's generated timestamp. All pairs matched and all projection issue counts were zero.
This is narrower than equality of every possible detail/family/diagnostic projection. Native CLI
content was discarded by the harness rather than saved as a transcript.

Fixture cases used 64 independently identified sanitized sessions: a directory-scoped sample of
50 for Claude and Codex, plus a non-repeating 64-file Codex scan as control. Fixture sample pairs
used a 768 MiB old-space cap. Control and native pairs used 256 MiB. Each child had a 45-second
timeout. Only the tiny control corpus used a 64 MiB watchdog floor because the machine-wide
default blocked it under host memory pressure; its estimate and other guards remained enabled.
This override is not a safe setting inferred for native histories.

The native case was read-only CLI sample 1, Codex only, safe mode, scoped to one project directory.
No adapter roots were inspected outside the ordinary CLI path.

## Results

Durations and RSS are medians of six runs per branch. Inspection counts were constant within each
scenario/branch. Each cell reads baseline → candidate.

| Scenario | Metadata inspections | Preparation ms | Scan ms | Max RSS MiB |
| --- | --- | --- | --- | --- |
| Claude fixture, sample 50 of 64 | 114 → 64 | 86.11 → 55.32 | 113.30 → 82.11 | 119.1 → 117.6 |
| Codex fixture, sample 50 of 64 | 178 → 128 | 89.92 → 60.81 | 115.18 → 86.16 | 124.9 → 117.2 |
| Codex fixture, non-repeating control | 64 → 64 | 53.26 → 52.66 | 82.82 → 81.65 | 117.1 → 117.4 |
| Native scoped Codex, sample 1 | 424 → 423 | 154.11 → 151.02 | 172.11 → 169.66 | 156.8 → 156.9 |

For the Codex sample fixture, first-workspace inspections fell from 114 to 64; the separate
64-file identity pass remained. The fixture benefit primarily came from avoiding a second worker
batch. The native case removed only one repeated inspection; the small timing change does not
demonstrate a meaningful general native speedup. The non-repeating control shows why reuse needs
repeated work to be useful. No confidence interval or latency SLO is inferred from six pairs.

## Failures and scope limits

Two exploratory control runs were excluded from the paired set: an invocation used unsupported
`--no-dir`, and the next hit the machine-wide watchdog floor. They were not treated as successful
scans or silently folded into the medians.

The implementation reuses metadata only within one attempt and validates file versions before
admission and reuse. Identity, first-workspace, and full-workspace contracts remain separate.
Changed evidence invalidates the attempt; a refresh gets a new owner. The
[implementation contract](../design/2026-09-05-bounded-query-model.md#preparation-metadata-reuse)
and fixture regressions cover these behaviors independently of timing.

The result establishes a benefit for repeated preparation work in the measured shapes. It does
not establish cross-request caching, bounded parser memory, cheaper first-time discovery, a
recency proof for latest, or a capacity envelope for arbitrary histories.
