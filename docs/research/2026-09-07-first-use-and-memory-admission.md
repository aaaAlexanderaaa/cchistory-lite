# First use and memory admission

Stage: historical F1–F5 follow-up after the completed, uncommitted M0–M3 work.
**Superseded on 2026-09-08:** U1 failed. The initial memory-signal and adaptive-heap
choices below were defective on macOS. See the [failure and correction](2026-09-08-macos-memory-ownership.md).
This report contains code inspection and synthetic fixture verification, not a new
native performance measurement or a successful cold-agent product evaluation.

## Evidence and decisions

The user supplied a cold-agent journey: repeated help/guide reads, a source listing
refused by scan estimation, sample/container failures, then widening directory scope
to recover from empty results. The independent task was to use only a provided CLI
alias to recover one project's development history and produce an HTML timeline.
Evaluation restrictions prevent bypassing the CLI; they do not add product restrictions.
The user will dispatch and judge that task with a separate agent without context.

Code inspection identified specific causes:

- Source listing prepared a full snapshot before rendering adapter status/counts.
- Shell prepared at startup, before it could validate an input or accept exit.
- Sample and exact-reference reads skipped the memory estimate even though one
  container or one session may hold arbitrarily many/large records.
- Cursor blobs, VS Code values and ZCode tables crossed into JS with unbounded
  result reads, before any row-level admission.
- Heap and watchdog policies forced a 512 MiB minimum; the watchdog also used
  host total, which can exceed an entire container's allowance. Launchers recalculated
  availability before accepting their marker and could respawn after a changed reading.
- Missing working directory excluded a session without explaining the observed gap.

F1–F4 replace these paths. Source discovery is metadata-only; `--complete` requests
counted source status through the existing scanner. Shell prepares on first valid
read or explicit refresh and publishes only successful refreshes. Canonical code
counts unknown directory attribution; surfaces report it with observed read losses.
No fallback widens scope. Existing SQL, commands and sample row selection share
canonical execution, without a parallel compatibility implementation.

## Initial memory policy and limits — superseded

Node's [process.availableMemory](https://nodejs.org/docs/latest-v22.x/api/process.html#processavailablememory)
was treated as portable remaining capacity in this stage. That assumption was wrong:
installed libuv on Darwin returns free pages only, and its zero constraint means
unknown. Linux cgroup usage handling does not establish Darwin semantics.

The initial launcher chose half the availability, capped at 4096 MiB, rounded to positive
MiB. The child accepts that choice before sampling again. The integer minimum is
V8 flag granularity, not a minimum supported workload. If a new limit is too small
for the existing startup heap, discovery and read-admission errors run in the current
process. [Old space](https://nodejs.org/docs/latest-v22.x/api/cli.html#--max-old-space-sizesize-in-mib)
is not a bound on total RSS, native SQLite memory, buffers or workers.

Preflight and cumulative native-byte admission use the smaller of availability and
remaining V8 heap. Existing light/full expansion factors (4/8) and warning/refusal
fractions (50%/75%) remain heuristics. The watchdog reserves 25% of availability at
scan start; no fixed bytes or host-total fraction enter that reserve. SQLite readers
measure selected values and per-row overhead within a read transaction before JS
retrieval. Budget failures escape per-file recovery as errors with `complete: false`.
Sample/exact reads skip only the scan queue, not admission.

This does **not** establish universal OOM prevention. Whole-container preflight can
still conservatively refuse a query whose desired subset would fit. SQL admission
bounds native bytes with an estimated expansion allowance; it does not prove the
cost of every decoded object graph. Checkpoint sampling cannot interrupt synchronous
allocations, and an unavailable process signal leaves weaker OS fallbacks. General
container query pushdown and qualified low-memory capacity remain D2, outside this
bounded correction. No native speedup, peak-RSS reduction, or successful project
timeline reconstruction is claimed here.

## Verification and closure

Synthetic cases exercise process/host disagreement, zero/unknown readings, accepted
launch budgets without resampling, small SQLite values/large blobs/null rows and
cumulative admission, error propagation through ZCode and both Cursor container paths,
metadata-only discovery, cold-shell validation/exit, refresh/reuse, scoped empty results,
and structured resource failure without automatic retry. Existing projection fixtures
remain the semantic oracle. Temporary databases are read-only during probing and
removed after each test; no native user history enters these fixtures.

Final checks passed: 634 package tests and dependency boundaries, build, governance
(13 tests; 5 rules across 112 matches), standalone and local npm artifacts, and skill
format validation. Layout/content checks passed for 154 mock files; the eight known
Gemini scenario omissions remain D6. Details are recorded in [PLAN.md](../../PLAN.md). Release checks compare
the shipped skill byte-for-byte and execute the new discovery contract in both the
standalone extraction and local npm installation. The user-owned independent
cold-agent evaluation subsequently failed on 2026-09-08. Passing these automated
checks did not establish launcher correctness or complete that acceptance.
