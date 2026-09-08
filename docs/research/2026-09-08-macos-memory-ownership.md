# macOS memory ownership after failed first-use acceptance

Date: 2026-09-08. Stage: correction G1–G3 after the user-owned U1 evaluation failed.
This report records aggregate OS telemetry and synthetic verification. It contains
no native history, source paths, project/session identifiers or raw process output.
The independent agent's timeline task is not reproduced or judged automatically.

## Failure and attribution

The user reported another directory-history trial. A 64 GiB macOS machine was
reported as having tens of MiB available; a complete read estimated roughly 11.2 GiB
and included a roughly 2.4 GiB Cursor container. The agent repeatedly changed guard,
heap and subset settings, encountered OOM, and delivered a partial-coverage timeline.
This fails U1. It is not a successful trial with merely inconvenient setup.

Two Lite policies contributed: the guard treated Node's available-memory reading as
portable process capacity, and the launcher re-executed Node with half that reading
as its old-space cap. The internal `CCHISTORY_ADAPTIVE_NODE_MEMORY_MB` marker was
written by Lite. It was not evidence of a sandbox-injected quota. Removing a fixed
512 MiB minimum in F3 exposed a more damaging tiny-heap path; the tests exercised the
formula without verifying the OS signal's meaning or the actual launched process.

On the installed Node v22.22.2 / libuv 1.51.0, Darwin's
[`uv_get_available_memory`](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/darwin.c#L92-L123)
returns `uv_get_free_memory`, calculated from free pages. The same source describes
a zero constraint result as unknown. It cannot independently prove the absence of
a sandbox or OS limit. Attribution of Lite's heap cap comes from its own launcher
code, not from that zero value.

During this correction, local telemetry confirmed 64 GiB total, an unchanged bare
Node heap ceiling of about 4 GiB, and equal Node available/free readings. Those free
readings changed from about 244 MiB to 977 MiB between observations. At the latter
observation, free + inactive pages yielded about 17.4 GiB. These are observations on
a loaded machine, not stable capacity measurements or a guarantee of reclaimability.
No native history was opened for these telemetry checks.

## One replacement policy

Delete adaptive heap selection and re-execution from workspace CLI/TUI entry points
and generated release launchers. Use Node's default or the operator's explicit
Node flags / `NODE_OPTIONS`. The old internal marker has no effect. There is no
second compatibility implementation or replacement automatic floor/cap.

Memory admission samples platform-specific availability:

- Darwin: `vm_stat` free + inactive pages, following the accounting used by
  [psutil's macOS implementation](https://github.com/giampaolo/psutil/blob/master/psutil/arch/osx/mem.c#L67-L80).
  Respect the reported page size. Do not add speculative, purgeable, file-backed or
  compressor counters again. The command is bounded by timeout/output size and
  sampled at most once per second in process memory. On missing or malformed data,
  system availability is unknown; do not fall back to the same free-page-only error.
- Linux: `MemAvailable`, intersected with Node's current cgroup headroom when a
  constraint is known. Keep actual exhaustion as zero. A total quota is not remaining
  quota; available Node signals account for current group use.
- Other platforms: Node's available-memory signal, with OS free memory as fallback.

Preflight and cumulative native-byte admission use the smaller of the system
estimate and remaining V8 heap. Existing 4/8 expansion factors and 50%/75% thresholds
remain heuristics. Errors name both quantities, the signal and limiting resource;
the effective minimum is not described as total machine memory. If macOS telemetry
is unknown, the remaining-heap check still applies. The watchdog uses the same OS
estimate with its initial proportional reserve.

Routine errors and agent instructions no longer recommend disabling the guard.
The operator guide retains the explicit diagnostic escape hatch and explains that
it changes no Node/OS limit. A resource failure preserves scope and is reported;
agents should not try permutations of environment overrides and source/file limits.

## Verification and limits

Synthetic `mock_data/fixtures/system-memory` inputs cover few free pages with many
inactive pages, 4 KiB/16 KiB pages, overlapping counters, malformed/unavailable data,
true exhaustion, Linux cgroup headroom and separate system/heap refusal causes.
They do not contain captured user telemetry. Existing history fixtures exercise
guard-enabled queries and canonical projection contracts.

Release verification preloads a trace that records the heap ceiling on process exit.
It compares actual workspace CLI/TUI entry points, standalone launchers and npm bins
with bare Node in the same environment. Cases cover default heap, `NODE_OPTIONS`,
explicit command-line precedence and an inherited obsolete marker. Exactly one Node
process must run per entry point. The trace reads no history and is removed afterward.
This tests the launcher, rather than just accepting a synthetic budget calculation.

All G1–G3 implementation gates passed, including actual launcher checks in both
release forms. Final counts are maintained in [PLAN.md](../../PLAN.md). The user owns the
independent U1 rerun. Neither fixture success nor correct heap ownership proves that
the original complete directory query now succeeds. In particular, an 11.2 GiB
estimated read can still correctly refuse against a roughly 4 GiB default heap.
Whole-container estimates may also overstate the work a particular subset needs.
Container pushdown and arbitrary-history capacity remain D2; this correction does
not silently disable admission, claim general OOM prevention or widen query scope.
