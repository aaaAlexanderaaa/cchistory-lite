# 2000 turns under a 3.6 GiB Linux memory limit

Date: 2026-09-08. This is a bounded synthetic capacity observation, not a universal
turn-count limit or the independent agent's product acceptance. No native history
was read. Production query or memory policy was not changed to pass these cases.

## Why this check was needed

The user's latest independent agent run produced an HTML artifact, with result
quality explicitly left unevaluated. Its narration still included extra guide
discovery, increasing Node heap, sequential source reads, abandoning SQL and reading
200 of 202 turns from one source. This establishes delivery of a file, not complete
history coverage or a cause for the SQL fallback; the exact failed SQL and errors
were not supplied. Sequential source reads can preserve the requested scope, but
their coverage and any combined canonical relationships must still be accounted for.

The shipped skill had named the evaluation's timeline task and guided its workflow.
That was documentation tailored to the evaluation and reduced the independence of
the trial. Those references and the task-specific alias example were removed. The
skill retains general query, scope, evidence, resource and shell contracts. There is
no timeline-specific query plan; the previously approved selective Codex latest plan
serves a general recent-session query and is not exercised by these complete scans.

## Environment and method

Fresh Linux containers used the official `node:22.22.2-bookworm-slim` image, pinned
at manifest digest `sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e`.
Each had two CPUs, a **3.6 GiB total memory hard limit**, no swap, no network, read-only
root and bind mounts, a small writable temporary filesystem and a non-root user.
The observed cgroup v2 values were `memory.max = 3865468928` and
`memory.swap.max = 0`. A total hard limit is distinct from the user's wording of
3.6 GiB currently available on a VPS with unspecified total RAM.

No Node heap override, guard bypass or injected memory signal was used. Node chose
a heap ceiling of **1983119360 bytes, about 1.85 GiB** under this constraint. The
runtime correctly selected the Linux process/cgroup signal. This is already
different from the roughly 4 GiB default heap observed on the 64 GiB macOS host.

Four synthetic corpora expanded the sanitized
[Codex parent fixture](../../mock_data/.codex/sessions/2026/04/12/rollout-2026-04-12T09-00-00-codex-delegation-parent.jsonl).
Every case contained 2000 distinct turn contexts, user submissions, tool calls and
outputs, and assistant messages. All used one synthetic directory, distinct session
and call identities, deterministic timestamps and numbered text lines. Tool output
and assistant text contained only invented fixture paths and content.

| Corpus | Session layout | Tool output per turn | Assistant text per turn | Native JSONL MiB |
| --- | --- | --- | --- | --- |
| Small | 100 × 20 turns | 1 KiB | 256 bytes | 4.06 |
| Tool-heavy | 100 × 20 turns | 128 KiB | 256 bytes | 254.23 |
| One long session | 1 × 2000 turns | 128 KiB | 256 bytes | 254.22 |
| Large replies | 100 × 20 turns | 1 KiB | 128 KiB | 255.70 |

A measurement process imported the built runtime and called `scanLiteHistory` with
an explicit Codex fixture root, the common directory scope, safe mode and the scan
guard enabled. `contextMode: none` used the light profile; `full` used the full
profile. Successful runs required the exact expected session count, **2000 turns**
and **zero projection issues**. The process measured scan time and its own
`process.resourceUsage().maxRSS`; the latter is a lifetime high-water mark including
startup, not just the returned snapshot's retained memory. Dataset generation was
outside the measured process. No post-scan GC was requested.

Each case below ran once, sequentially, in a fresh container. These are observations,
not medians or latency SLOs. Containers were removed after exit and generated corpora were removed after the
checks. Raw logs and the machine-specific harness stayed outside the repository.

## Observations

| Corpus / read | Outcome | Scan ms | Node peak RSS MiB | cgroup peak MiB |
| --- | --- | ---: | ---: | ---: |
| Small / light | 2000 turns, zero projection issues | 286.6 | 125.5 | 175.3 |
| Tool-heavy / light | 2000 turns, zero projection issues | 1399.0 | 186.5 | 466.5 |
| One long session / light | 2000 turns, zero projection issues | 1425.8 | 1018.4 | 1226.2 |
| Large replies / light | 2000 turns, zero projection issues | 1386.3 | 172.0 | 379.3 |
| Tool-heavy / full | Refused before any file-start event | 62.8 | 86.8 | 40.2 |

All five runs reported zero cgroup OOM events. The full-read refusal exited 1 with
`ScanGuardRefusedError`: about 254 MiB of source bytes ×8 exceeded 75% of roughly
1.84 GiB remaining heap. It produced no complete snapshot. This is a conservative
admission decision, not a measurement proving that the full read would exhaust RAM.

Process RSS and cgroup memory are different metrics. Shared pages may appear in a
process's RSS while being charged elsewhere; cgroup accounting also includes other
memory categories. File-cache ownership and reuse across runs can affect the latter.
Do not read the two columns as interchangeable measurements or add them together.
The [kernel's cgroup memory documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory)
describes the hard limit, current/peak accounting and OOM behavior.

A separate run in the same constrained environment executed the actual CLI with one
v3 batch containing two SQL operations over the small corpus:

```sql
SELECT id, session_id, submitted_at FROM turns
ORDER BY submitted_at DESC, id ASC LIMIT $1 OFFSET $2
```

Bindings were `[1000, 0]` and `[1000, 1000]`, with `complete: true`, the same directory
and fixture source. Both operations succeeded in one query read, each reported total
2000, and their union contained exactly **2000 unique turn IDs**. This verifies that
the general SQL pagination path works here. It does not explain the independent
agent's SQL failure or replace that evaluation.

## What this establishes

2000 turns alone is not a memory budget. Even at essentially equal native byte
counts, placing the tool-heavy data in one session increased observed Node peak RSS
from about 186 MiB to 1018 MiB. Retaining full context changed an admitted read into
a preflight refusal. Native format, maximum unit size, retained projections and the
requested detail level are part of the capacity model.

These four light reads fit under the tested 3.6 GiB hard limit using the normal
policy. Arbitrary 2000-turn histories are not qualified. Whole SQLite containers,
multimedia, denser event/masking shapes, mixed sources, concurrent work and real VPS
filesystem/CPU behavior were not measured. Some processing is incremental, but
whole-session/container paths and an in-memory canonical snapshot remain. Existing
4/8 expansion heuristics and checkpoint checks are not hard allocation bounds;
large synchronous/native allocations can still OOM. A Linux cgroup limit can kill
the process when memory cannot be reclaimed, so an application error response is
not guaranteed on every such path.

The [work plan](../../PLAN.md) records this completed investigation and the separate,
user-owned acceptance status. No capacity implementation phase is silently added.
