# Detail construction and allocation measurements

Date: 2026-09-05. Baseline: the working runtime after file planning and metadata reuse. Candidate:
an external compact-context prototype applied to that same build. No production extraction path
was switched. No native history was read in this round. See [provenance](README.md).

## Method

Both branches returned `contextMode: none`. The prototype skipped visible system presentation
and ordinary tool body formatting, omitted raw event references and full reply display retention,
and preserved usage association, model/error facts, counts, and full spawn-tool details. It still
ran assistant masking. Its incomplete context-shaped intermediates are unsuitable as production
types; see the [semantic/detail boundary](../design/2026-09-05-semantic-detail-boundary.md).

Corpora were expanded from the sanitized
[Codex parent fixture](../../mock_data/.codex/sessions/2026/04/12/rollout-2026-04-12T09-00-00-codex-delegation-parent.jsonl).
Each session and turn had a distinct fixture identity. Tool output and assistant text used numbered
lines and fixture paths rather than one repeated constant. Four shapes were used:

- 32 sessions × 8 turns, with 1 KiB tool output and 128-byte assistant text per turn;
- 4 sessions × 8 turns, with 512 KiB tool output and 128-byte assistant text;
- 4 sessions × 8 turns, with 1 KiB tool output and 128 KiB assistant text;
- 1 session × 32 turns, with 512 KiB tool output and 128-byte assistant text.

For each shape, six alternating-order pairs ran in fresh Node processes with a 256 MiB old-space
cap, a 45-second child timeout, explicit GC, and fixed observation time. The returned snapshot
remained reachable during post-scan GC; its serialization and hashing were outside scan timing.
Generated corpora were cleaned in `finally`. All 48 timing runs succeeded with equal snapshot
hashes within each shape and zero projection issues.

One additional pair per shape used inspector allocation sampling at 32 KiB, including objects
collected by minor and major GC. All eight profile runs also passed equality and projection checks;
they were excluded from timing/RSS medians. Context timing wrapped the constructor; RSS sampling
occurred after that timer. Instrumentation added overhead to both branches. These tiny explicit
fixture scans used runtime without a `scanGuard` request, not a native guard bypass experiment.

## Results

Medians from six unprofiled runs per branch, baseline → prototype. Maximum RSS is process-level
`resourceUsage`, including startup and work outside the timed scan, not sampled process-tree RSS.

| Shape | Input MiB | Scan ms | Context construction ms | Max RSS MiB | Post-GC heap MiB |
| --- | --- | --- | --- | --- | --- |
| Many small sessions | 0.53 | 96.56 → 94.35 | 3.27 → 2.12 | 115.38 → 115.51 | 9.89 → 9.92 |
| Large tool outputs | 16.35 | 91.61 → 82.97 | 9.60 → 0.71 | 101.16 → 101.05 | 8.22 → 8.25 |
| Large assistant text | 4.12 | 50.31 → 51.78 | 3.20 → 3.09 | 80.55 → 80.49 | 8.23 → 8.26 |
| One larger session | 16.35 | 78.76 → 66.85 | 9.97 → 0.72 | 117.19 → 116.94 | 8.03 → 8.07 |

Allocation samples from the separate single pair per shape, in MiB:

| Shape | Total sampled allocation, baseline → prototype | Under context construction, baseline → prototype |
| --- | --- | --- |
| Many small sessions | 32.83 → 32.92 | 5.98 → 3.04 |
| Large tool outputs | 39.20 → 38.33 | 0.72 → 0.22 |
| Large assistant text | 14.54 → 13.90 | 0.82 → 0.63 |
| One larger session | 38.17 → 37.35 | 0.60 → 0.41 |

In the baseline large-tool case, buffer slicing and `parseRecord` accounted for approximately
16.54 and 16.16 MiB of sampled allocation respectively. They were also the largest contributors
in the assistant-text case. Sampling describes allocation, not simultaneous live memory, and
does not fully account for external buffers, native allocations, or child processes. A single
profile pair provides attribution evidence, not a precise capacity bound.

## Interpretation and limitations

Avoiding ordinary tool presentation reduced constructor work in the large-output shapes and
was accompanied by lower scan wall time. No material peak-RSS or retained-heap improvement was
demonstrated. The final compact snapshot was identical, so its serialized size could not improve.
Assistant masking still ran in the prototype; the assistant-text case showed no scan improvement.
The paths embedded in assistant prose did not exercise a reference extractor, because current
masking does not emit reference segments.

The fixture shapes do not model multimedia, large databases, dense masking patterns, concurrent
refresh, or arbitrary native histories. Results do not establish a latency SLO or a statistical
capacity envelope. They are consistent with a limited formatting-work optimization and motivate
separate investigation of record/fragment/atom lifetimes and large-unit handling.

The implementation direction remains one canonical interpretation with optional complete detail,
not a duplicated reply builder behind a compact flag. Family fallback can depend on projected
spawn summaries; generation-bound late detail is also still absent. Regression parity and these
dependency contracts must precede a production extraction switch.
