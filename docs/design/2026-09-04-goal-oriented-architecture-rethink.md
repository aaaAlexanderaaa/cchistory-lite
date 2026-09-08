# Goal-oriented architecture rethink

> **Status:** Working note, not an approved design, contract, or implementation plan.
> It records questions raised by real use of CC History Lite and deliberately treats the current
> architecture as evidence rather than a constraint.

The active execution checklist and stopping conditions are in [the work plan](../../PLAN.md).
This note's experiments and open questions do not independently add work to that checklist.

## Why this note exists

CC History Lite exists to help people and agents browse and search conversations produced by AI
agents. Architecture, contracts, package boundaries, zero-store, scan guards, and test processes
are means to that end. They are not the end itself, and a decision that was reasonable for v0 is
not automatically the right permanent decision.

A 4 GiB VPS becoming unresponsive while Lite processed roughly 2,000 turns exposed a serious
resource failure. That incident is a forcing function for better reasoning, not a claim that
memory is the project's only problem. A single reported failure should trigger a broader review
of the user journeys and the assumptions behind the system. Requiring users to enumerate every
problem would waste their time and would make project quality depend on how thoroughly they can
debug the implementation for us.

The earlier idea of introducing a requirements registry was the wrong response. It added a new
governance system without directly improving time-to-answer, correctness, resource safety, or the
ability to complete useful work. The useful record is a short, readable statement of goals,
observed gaps, architectural options, and falsifiable experiments.

## Start from the workload, not the commands

The representative workload is not one isolated CLI invocation. It is a task such as:

1. A user or agent opens one project or source scope.
2. The system prepares the relevant conversation data once.
3. The caller performs many searches, latest/list/stat queries, and a few detail reads.
4. Native history may change and the caller may request or expect a refresh.
5. The task ends, the state expires, and the memory is released.

Scanning, parsing, canonicalizing, linking, and materializing dominate the cost. Searching and
aggregating an already prepared compact view are comparatively cheap. Repeating the dominant
work for every query is therefore an execution-model problem, not merely an implementation that
needs a larger heap or a more conservative refusal threshold.

A useful north-star statement is:

> Within one browsing task and one source/scope generation, perform at most one expensive cold
> preparation; answer subsequent reads from bounded derived state; refresh consistently; remain
> useful under resource pressure; and release all derived state after the task is idle.

## Separate goals, promises, decisions, and artifacts

These categories must not be allowed to collapse into one another:

- **Goal:** help users and agents find and understand their AI-agent conversations.
- **Product promises:** correctness, useful browse/search behavior, source safety, honest
  completeness, and a stated operating envelope.
- **Trade-offs:** ephemeral versus durable derived state, freshness policy, accuracy versus
  availability, and cold-start cost.
- **Current design decisions:** one-shot CLI scans, complete in-memory snapshots, explicit refresh,
  no background service, and selected logical-session boundaries.
- **Implementation artifacts:** current packages, payload shapes, flags, multipliers, caches, and
  tests.

Goals and accepted product promises deserve stability. Trade-offs must remain reviewable. Current
design decisions and implementation artifacts are replaceable when evidence shows they no longer
serve the goal.

## What the current system has taught us

Useful experience to preserve:

- One canonical interpretation of identity, ordering, project linking, usage, related work, and
  search avoids surface-specific drift.
- Native sources should remain read-only and malformed evidence should remain visible.
- A complete logical session is the minimum safe unit for canonical projection when evidence spans
  multiple files.
- Detail context can be loaded separately from the data needed for browse and search.
- Immutable replacement is safer than mutating the snapshot being served.
- Sanitized adapter fixtures and projection audits catch real semantic failures.

Assumptions to reopen:

- zero persistent history storage implies one fresh scan per command;
- CLI commands should own the scan lifecycle;
- a complete monolithic snapshot is the only useful read model;
- full refresh is the only safe freshness mechanism;
- a background or shared process belongs only to the Full product;
- fixed raw-byte multipliers can stand in for a measured resource envelope;
- an output limit, file limit, or sample count necessarily bounds the work for every adapter;
- refusing a risky complete operation is sufficient even when a bounded useful result is possible.

The aim is to reuse hard-won parsing and semantic knowledge, not to preserve every current data
structure or package boundary.

The companion [bounded query model proposal](2026-09-05-bounded-query-model.md) explores a finite,
composable query vocabulary using familiar syntax, with convenience commands sharing logical plans
and source-specific execution optimizations. It does not assume a database engine or an approved
replacement surface. [Sanitized research and measurement reports](../research/README.md) preserve
the supporting evidence; raw native history, identifiers, and machine-specific artifacts remain
outside the repository.

## A greenfield runtime model

Native agent history remains the source of truth. The runtime maintains a derived, immutable
generation for a selected source and project/directory scope.

```text
native histories
      |
cheap inventory and change detection
      |
bounded logical-session parsing and canonicalization
      |
immutable generation
      +-- compact hot view: sessions, turns, project links, usage, searchable text
      +-- native locators: enough information to load detail on demand
      +-- bounded detail cache: replies, tools, and raw evidence for recently opened sessions
      |
leased query session
      +-- CLI
      +-- TUI
      +-- agent JSON/stdio/local client
```

### Bounded cold construction

Canonicalize one complete logical session or another proven bounded unit, merge its compact result
into the generation under construction, and release raw buffers, records, fragments, atoms, and
full contexts before moving to the next unit. Global relationships should be resolved from compact
identities and references rather than by retaining all parser intermediates.

Adapters unable to expose a safe logical-session boundary need an explicit fallback and are a
known resource risk; the fallback must not be described as bounded merely because it selected one
file. A single SQLite database or JSON container may represent thousands of sessions.

### Hot and cold data

Keep only data needed by frequent operations in the hot view: session and turn identity, user
search text, timestamps, project relations, usage, diagnostics, and native locators. Assistant
replies, tool payloads, raw JSON, and other large evidence are cold. Load cold data for a targeted
session and retain it only in a byte-bounded LRU when reuse is valuable.

`contextMode: none` must mean that full context is not constructed, not that it is constructed and
then discarded.

### A query session owns the lifecycle

The primary runtime concept should be a leased query session rather than a one-shot command. It is
keyed by the selected roots, source set, scope, canonical rules, and runtime version. It provides:

- single-flight cold construction so concurrent callers share one build;
- an immutable generation so every query sees a consistent point in time;
- atomic refresh, retaining the previous usable generation until its replacement succeeds;
- idle expiry and reference tracking;
- a total memory budget plus bounded detail and query caches;
- release under memory pressure rather than retention until the host is already swapping.

The TUI can use this lifecycle in-process. An agent capable of holding a child process can use a
stdio session. Independent CLI invocations may connect to an on-demand local process that exits
after its idle lease. The transport is secondary; callers should not need to know an internal
performance trick in order to avoid repeated scans.

### Refresh should be incremental where evidence permits

For append-oriented files, inventory can use identity, size, mtime, and a verified byte offset. For
native SQLite, an adapter may use stable row identifiers or native update markers. Only changed
logical sessions should be rebuilt when the source provides enough evidence. A source that cannot
prove a safe delta must fall back to rebuilding that source, not every unrelated source.

A refresh constructs a new generation and swaps it into service atomically. It must not expose a
mixture of old and new relationships.

### Persistence is a trade-off, not a moral rule

The product goal does not itself require zero-store. A leased in-memory engine avoids disk residue
and solves repeated work within one task, but pays a cold start after process exit. A compact durable
derived index provides better reuse across tasks and restarts, but adds freshness, migration,
cleanup, disk-usage, and privacy responsibilities.

The first experiment should favor a leased in-memory engine because it addresses the observed
continuous-query workload with less operational machinery. A durable derived index must remain an
open option if cold starts remain a dominant user cost. It should not be rejected solely because a
v0 design selected zero-store.

## Useful work under pressure

Resource pressure should have three outcomes:

- **Continue:** the current bounded plan can complete within its budget.
- **Degrade:** omit cold detail, reduce concurrency, stop at a session/source boundary, or return an
  explicitly partial useful result while preserving everything already derived.
- **Refuse:** only when no safe bounded unit exists, the caller explicitly requires complete output
  that cannot be produced within budget, or the host is already below the reserve needed to do even
  minimal useful work.

Refusal and emergency abort remain last-resort safety mechanisms. They are not substitutes for
bounded construction, reuse, or graceful degradation. An expert override that disables safety is
not a normal product path.

## Readable promises to evaluate

The project needs a short human-readable list, not a requirements registry. The list should cover
at least:

### Functional

- discover and interpret supported native histories;
- browse, search, list recent work, inspect details, and aggregate usage;
- preserve canonical identity, ordering, linking, and delegated work;
- support repeated reads without repeating unchanged preparation;
- refresh changed history without exposing mixed generations;
- return useful bounded results when a complete operation is unsafe;
- expose completeness, staleness, skipped evidence, and diagnostics honestly.

### Non-functional

- never mutate native history;
- operate inside a stated memory and time envelope on constrained hosts;
- avoid work proportional to the number of queries when the source generation is unchanged;
- isolate corrupt files, adapters, and refresh failures;
- release leased state and bounded caches predictably;
- keep query latency stable as the number of preceding distinct searches grows;
- remain usable from SSH and from agents that issue either persistent or independent requests;
- make installation and the shipped artifact behave like the tested code.

Each promise should be backed by a small number of user journeys and observable outcomes. The
document need not invent identifiers, schemas, registries, or a second governance language.

## Detecting promise/delivery drift

For each user journey, observe stdout/results, stderr/errors, exit status, source-root changes,
scan and refresh counts, elapsed time, progress, peak process-tree RSS, and cleanup. This detects:

1. an expected result or effect that never occurs;
2. an undeclared output, mutation, scan, subprocess, or other effect;
3. duplicate results, repeated scans, excess resource use, or another effect occurring too often;
4. lost results, suppressed diagnostics, incomplete refresh, or another effect occurring too
   rarely.

Static architecture checks remain useful for import and mutation boundaries. They cannot establish
runtime completeness, reuse, latency, or memory safety.

## A safety harness must fail safely

A test intended to discover runaway memory, repeated scanning, deadlock, or extreme latency must
not assume the implementation is healthy. Its failure behavior is part of the test design.

In particular, “one cold build followed by 50 searches” must **not** initially mean launching 50
unbounded real operations and waiting to see what happens. If reuse is broken, that could execute
50 cold scans, run for an hour, consume swap, and make the test host unavailable.

Use three layers:

### Control-path test

Inject or instrument the scan/build boundary, issue two or three queries, and assert immediately
that the build count remains one. If a second unexpected build starts, fail before processing a
large corpus. Also assert that concurrent initial requests join the same in-flight build.

This test proves the reuse property cheaply. It belongs on every change.

### Bounded artifact journey

Run the actual packaged binary against a modest sanitized fixture. Apply a strict total deadline,
no-progress deadline, process-tree RSS ceiling, and build-count ceiling. Stop as soon as any ceiling
is crossed. Only after the build-count assertion has passed should the harness exercise many warm
queries.

This test checks that packaging, process ownership, lifecycle, and cleanup match the in-process
model without turning normal CI into a stress environment.

### Isolated stress profile

Run the 4 GiB/large-history profile only inside an enforced resource boundary such as a cgroup or
container, with swap disabled or bounded independently from the host. It needs:

- a hard memory limit below the host's survival limit;
- a short phase deadline and a bounded total deadline measured in minutes, not hours;
- a no-progress watchdog;
- process-group ownership so every worker and launcher is terminated;
- graceful termination followed by forced termination after a short grace period;
- a read-only sanitized source mount and a disposable working directory;
- collection of peak RSS, termination reason, completed units, and last progress event;
- host headroom sufficient for the test controller even when the child hits its limit.

The test must fail inside its sandbox without taking the developer machine or CI worker with it.
The harness controller must use less memory and simpler code paths than the workload it controls.

Stress cases should distinguish count from shape: many small turns, fewer large tool outputs, one
large logical session, and many sessions inside one native container. “2,000 turns” alone is not a
complete workload description.

## Review beyond the reported memory incident

Memory is one example, not the scope of the review. Reassess the product through complete user
journeys across at least these dimensions:

- discovery: does the tool find the history users reasonably expect it to find?
- scope: do project, source, sample, and output limits bound the operation users think they bound?
- semantic correctness: are identity, ordering, linking, usage, and delegated work truthful?
- completeness: what is skipped, suppressed, duplicated, or silently repaired?
- freshness: when do results become stale, and how does a caller know?
- repeated work: what expensive work is repeated across queries, details, refreshes, and processes?
- resource behavior: memory, CPU, filesystem reads, startup time, query time, and concurrency;
- failure isolation: can one corrupt or huge input destroy all useful results?
- agent usability: can an unfamiliar agent choose a safe and effective path without internal
  knowledge or repeated trial and error?
- human usability: do CLI and TUI help users complete their task rather than merely expose the data
  model?
- privacy and side effects: what is read, retained, written, served, or left behind?
- installation and release: does the shipped artifact preserve the behavior that tests validate?
- observability and recovery: can a user tell what is happening and recover without disabling
  safety or rebooting the machine?

Prioritize findings by user harm, likelihood, and recoverability. A temporary coordination file is
not comparable to swap-death, silent data loss, repeated hour-long work, or a misleading complete
result.

## Decision filter

Work is justified when it measurably improves or protects at least one of:

- time to the first useful result;
- warm-query latency;
- cold-build and refresh frequency;
- peak RSS and host survivability;
- freshness;
- result correctness and completeness;
- recovery from bad inputs or interrupted work;
- safety of native source data;
- ability of an unfamiliar user or agent to finish a real task.

If a proposed contract, abstraction, test, or process cannot say which outcome it protects and how
that protection will be observed, it is likely process work rather than product work.

## Next experiments, not predetermined implementation

1. Instrument the current cold-build boundary and retained object categories without changing
   behavior. Establish where time and peak memory are actually spent.
2. Prove with two or three queries that one leased session performs one cold build; abort on an
   unexpected second build. Only then exercise a bounded warm-query loop.
3. Prototype per-logical-session canonicalization that retains only the hot view and locators.
   Compare its peak and final RSS with the current source payload path.
4. Compare explicit stdio session reuse with transparent on-demand process reuse for real agent
   clients. Measure completion rate and repeated scans rather than debating transport in the
   abstract.
5. Audit representative end-to-end journeys across all review dimensions above. Treat newly found
   issues as evidence about the architecture, not as exceptions to be hidden behind more guidance.
6. Revisit ephemeral versus durable derived state only after measuring cold-start frequency,
   session duration, and the memory cost of a useful hot view.

These experiments are allowed to reject the architecture proposed in this note. The purpose is to
find the simplest system that achieves the user goal, not to create another design that future work
must defend.
