# Query architecture work plan

Updated: 2026-09-08. Owner: Codex in the current task.

This is the single execution checklist for this work. Design notes explain choices; research
reports preserve evidence. Their open questions and experiment lists are not additional committed
tasks. Update this file when completing work or changing scope, instead of appending another
untracked “next step” to a conversation reply.

## Goal and current assessment

Deliver a small, familiar query language over read-only native history, borrowing an existing
syntax/parser without adopting a database engine. Common commands and editable query templates
should share the same logical operations. A query session should reuse prepared data, close
explicitly or on idle expiry, and allow a proven common query to avoid unnecessary interpretation.

**The agreed M0–M3 delivery is complete in the working tree.** The reviewed query frontend,
shared execution, shell lifetime, and one selective Codex latest plan are implemented and validated.
The sanitized reports include the proof, measured benefits and limits, and final acceptance.
Changes have not been committed or released. Universal memory bounds and low-memory deployment
capacity are not established. **The first-use follow-up failed the user-owned U1 trial
on 2026-09-08.** The finite memory correction below is complete. In a subsequent independent
run the user reported that an HTML artifact was delivered, with result quality explicitly
unevaluated and workflow detours still present. U1 acceptance remains with the user.

## Completed foundation — M0

- [x] Inspect current execution and all 16 source capabilities; establish cost observations and
  record their limitations in the [sanitized research reports](docs/research/README.md).
- [x] Share a validated file read plan between estimation and execution, including declared
  companions and SQLite sidecars.
- [x] Reuse unchanged preparation metadata within one attempt, with measured repeated-work savings
  and explicit invalidation.
- [x] Establish a canonical interpretation entry and nonempty full/none/matching regression cases
  for every registered adapter.
- [x] Validate the implementation: 607 package tests, build, dependency and architecture checks,
  and extracted release-artifact execution passed at the M0 checkpoint. See the
  [verification record](docs/research/2026-09-06-canonical-interpretation-seam.md).

M0 is implemented and validated in the working tree; it has not been committed or released.
It can be reviewed and closed independently. Optional detail construction is not an unfinished
requirement of M0. The current `none` path still constructs complete contexts before discarding them.

M2 extended the existing JSON batch and shell entries with the reviewed SQL frontend and idle
expiry. Existing input/output forms remain; their replaced collection selection paths were
removed. No legacy collection executor is retained.

## Delivery milestones — complete

These define the completed first product delivery. Concrete public syntax, field choices, result
format, and interaction behavior were reviewed at M1 before surface implementation.

| ID | Status | Deliverable | Completion condition |
| --- | --- | --- | --- |
| M1 | Approved: direction A and one shared implementation | [Finite query contract](docs/design/2026-09-06-query-contract-v1.md), [parser decision](docs/research/2026-09-06-query-parser-selection.md), and [fixed review oracle](mock_data/fixtures/query-contract/review.json) | The recommended dialect/parser, fields/operators/exclusions, totals/coverage/order/text/null semantics, and idle behavior are specified. The user approved A, requiring observable compatibility through replacement rather than parallel old/new execution mechanisms. |
| M2 | Implemented and validated; uncommitted | [Shared execution and acceptance record](docs/research/2026-09-06-shared-query-execution.md), [user guide](docs/guide/query.md) | Supported query text, bound-parameter templates, and the common commands selected at M1 use the same operations; collection queries reuse the snapshot; explicit close and idle expiry work; current command/JSON behavior remains compatible. |
| M3 | Implemented and validated; uncommitted | [Selective Codex latest and final acceptance](docs/research/2026-09-06-selective-latest.md) | Exact complete-reference parity, conservative fallback and changed-evidence rejection are covered. The larger synthetic fixture avoids 50 of 60 canonical interpretations with a lower elapsed median; inventory still reads every file. Q1–Q8 and final repository/release-artifact gates passed. This delivery stops here. |

M1 compared two candidates and selected `pgsql-ast-parser` 12.0.2. Both parsed all 13 positive
review queries; their isolated imports passed. This verifies parser suitability, not query
execution. The fixed corpus also records 17 rejection inputs, three generated budget cases,
and controlled-clock lifecycle journeys. The implemented shell idle default is 300 seconds, with
zero disabling it. Existing commands retain exact totals; new SQL requests them with `--complete`.

M1 limits parser selection to at most two credible candidates and one decision. It is not an
open-ended survey of SQL, JQ, ESQL, or every possible data-query system. The proposed first syntax
scope is single-collection session/turn reads, public field selection, bounded conditions,
ordering, and limit. Existing detail, ranked search, project/family, and usage operations remain
available without requiring general joins or aggregation in the new language.

M2 can use the complete snapshot as its reference executor. Avoiding detail formatting, creating
a unit cache, or redesigning generation-bound detail is **not a prerequisite for query syntax**.
M2 includes the parser dependency/license closure in the release artifact. SQL passed execution
from both the extracted standalone artifact and the packed local npm installation.
M3 depends on M1's answer and coverage contract, not on those optimizations. It initially targets
Codex and the contract's one-shot latest-sessions SQL template, not universal early pruning
across 16 adapters. Unsupported sources retain the
complete path; their semantic regression coverage remains required.

For M3, counters must distinguish discovery, metadata reads, source decoding, interpretation,
and retained state. An inventory that reads every file cannot be reported as avoided source I/O.
Exact totals, exhaustive diagnostics, ties, split sessions, and delegated eligibility must follow
the M1 contract rather than being silently weakened to enable early stopping.

If the single-source experiment cannot prove correctness or useful avoided work, record a no-go
and bring back the concrete tradeoff. Do not silently count the optimization as complete, try
source after source, or make a general planner the next prerequisite. Shipping a reduced scope
would then require an explicit scope decision.

## Fixed acceptance journeys for M1–M3

M1's linked contract and review oracle supply query text and expected fixture results for these eight cases. These are
the bounded acceptance corpus, not an invitation to add every query feature.

1. Latest ten top-level, nonempty sessions, with canonical recency and deterministic ties.
2. Session selection combining source and a time range, with a result limit.
3. Turn selection combining project identity and a time range; project is not merely cwd.
4. Public field selection and a bound-parameter template, with defined missing-value behavior.
5. Equivalent latest/list command and query requests produce identical ordered rows.
6. Unsupported syntax, invalid fields, and excessive expression complexity fail before scanning.
7. Repeated collection queries use one prepared snapshot; explicit refresh replaces it; failed
   refresh preserves the previous usable snapshot. Existing detail rescans remain explicit.
8. Explicit exit/EOF and idle expiry release session ownership; active queries are not expired.

M3 adds the existing adversarial latest cases to journey 1: misleading mtime, equal activity,
missing metadata, split sessions, empty sessions, delegated parents, changed evidence, and exact
total/diagnostic requests. Each has a complete-reference answer and an expected fallback or work
counter. Timing-dependent tests use controlled clocks; native measurements are not CI fixtures.

## Deferred work — not prerequisites for this delivery

| ID | Item | Reopen only when |
| --- | --- | --- |
| D1 | Optional detail formatting from one semantic result | A separate performance slice is selected with a measured CPU/allocation target. The canonical seam is ready, but the split is not implemented. |
| D2 | General large-unit processing, retained-state budgets, low-memory qualification | A separately scoped capacity target and workload are chosen. Existing guards remain; no arbitrary-history or 4 GiB capacity claim is made by M0–M3. |
| D3 | Version-bound late detail, concurrent refresh generations, cache admission/eviction | A feature needs to reuse detail across changing evidence or retain concurrent generations. Existing late-detail freshness limitations stay documented. |
| D4 | Cross-process reuse, background service, broader query language, optimization across all sources | A concrete workload justifies a new product increment. |
| D5 | Unanchored usage, Claude tool-result error evidence, legacy duplicate edges | A separate semantic correction is selected with independent expected results. Structural parity does not certify these behaviors as correct. |
| D6 | Eight missing Gemini paths in the old scenario manifest | A focused fixture-maintenance task repairs those scenario claims. Current nonempty Gemini tests use independent checked-in input. Full mock-data validation remains red for this known reason. |

A deferred item becomes required only if it directly prevents an agreed acceptance journey or is
a regression caused by the new work. State that dependency explicitly; do not promote every
discovered issue into an architecture prerequisite.

## Stopping and reporting

- M0 ends with the verified foundation above. No more foundational refactoring is queued before M1.
- The proposed product delivery ends when M1–M3 meet their conditions. Further improvements go to
  deferred work rather than becoming another automatic phase.
- Each progress report names the milestone, completed acceptance conditions, remaining conditions,
  and any actual blocker. “One more cleanup” is not a new milestone.
- A material scope change must name what it adds, why existing acceptance cannot finish without
  it, and what is removed or deferred. Do not silently expand this checklist.
- Verification belongs to the final code state: run the repository gates after implementation,
  retain sanitized evidence, and report known limitations separately. Commit/release status is
  distinct from implementation and is not implied by a passing build.

M1 is approved and M2 is implemented and validated under the user's explicit compatibility constraint: preserve
command syntax, output, and semantics while replacing the old execution mechanism. SQL,
templates, CLI commands, shell commands, and v2 requests must converge on one logical executor;
remove the replaced selection paths. Independent input/output adapters do not justify duplicated
filtering, ordering, pagination, or a legacy execution fallback. M3 is the final completed milestone.


Final implementation checks: **624 package tests** and dependency boundaries passed (domain 103,
canonical 33, adapters 245, runtime 107, CLI 49, TUI 87). `build:lite` and governance passed
(13 governance tests; 5 rules, 110 rule-file matches). Standalone extraction and local npm
installation both executed SQL and the shipped selective template against complete reference rows.
The final artifact check used the final rebuilt package outputs. Mock-data layout/content checks
passed for all 151 files; full scenario validation still has the original eight missing Gemini
paths tracked in D6. No new milestone or prerequisite has been added. There is no remaining
required implementation work in this delivery; commits, publication, and D1–D6 are not implied.

Review follow-through: the shipped `skills/using-cchistory-lite/SKILL.md` now documents the
SQL/v3 entries, typed templates, coverage/totals and selective-read limits, and shell lifecycle.
Its direct SQL, v3 request and shell SQL/refresh/exit examples passed against sanitized fixtures;
skill format validation passed. Artifact verification now compares both the installed skill file
and `agent skill` output byte-for-byte with the repository source in standalone and npm installs.
This closes the reported release-documentation gap without changing runtime behavior or adding
a new milestone.

## Approved follow-up — first use and memory admission

The user's cold-agent trial exposed a separate, bounded defect slice after M0–M3. A directory
history query must not require a preliminary history scan just to discover the tool, and sample
or exact-reference reads must not escape resource admission. This reopens the relevant part of
D2; it does not promise arbitrary-history capacity or introduce a second query engine.

- [x] F1: Source discovery reads adapter/root metadata only. Explicit `--complete` retains the
  counted source report through the existing scan. Help gives a direct scoped query entry.
- [x] F2: Shell opening, help, invalid requests and exit do not prepare history. The first valid
  read prepares once; refresh publishes only on success; idle expiry still releases ownership.
- [x] F3: Remove the fixed 512 MiB floors, use process-available memory and remaining heap,
  initially accept a launch budget once (failed U1; superseded by G1), and apply resource checks to sample/exact reads. Admit SQLite
  result bytes before retrieving values; budget failures propagate instead of becoming empty data.
- [x] F4: Report observed sessions with unknown directory attribution and read losses alongside
  scoped results. Never widen scope automatically or describe resource refusal as an exact empty result.
- [x] F5: Align shipped skill, help, agent contract and guides; pass fixture-based regressions and
  repository/release gates. Record remaining capacity limits, then close implementation here.
- [ ] U1 (user-owned, manual; latest run delivered an artifact, quality not yet evaluated): An ordinary agent with no task context receives the original
  cclite-only directory-history-to-HTML-timeline request. The user dispatches and evaluates it
  independently. Do not automate this judgment, generate its timeline here, or mark it passed
  based on implementation tests. Evaluation-only restrictions are not new product restrictions.


F1–F5 implementation closed on 2026-09-07. Final `pnpm test` passed **634 package
tests** (domain 103, canonical 33, adapters 247, runtime 110, CLI 54, TUI 87) and
dependency boundaries. `build:lite`, governance (13 tests; 5 rules across 112 matches),
standalone extraction and local npm artifact checks passed. Shipped skill equality,
metadata-only discovery and skill format validation passed. Layout/content validation
passed for all 154 mock files; the same eight pre-existing Gemini scenario paths
remain D6. No new native measurement or low-memory capacity qualification was made.

U1 failed on 2026-09-08: the cold agent hit false tiny-memory refusals, repeatedly
changed resource settings and scope, and still OOMed. The timeline used partial
coverage. The previous F1–F5 tests did not validate macOS signal semantics or the
actual launcher's heap ownership. G1–G3 below corrected that defect; passing their gates does not mark U1 passed.

## Memory correction after failed U1 — finite scope

- [x] G1: Delete adaptive heap/re-exec policy from CLI, TUI and release launchers.
  Preserve Node defaults and explicit flags / NODE_OPTIONS. Use macOS free + inactive
  pages with unknown fallback; retain Linux MemAvailable / known cgroup headroom.
- [x] G2: Distinguish system estimate, remaining heap and limiting resource in errors.
  Remove advice to bypass the guard from routine error/agent guidance. Align the
  contract, shipped skill, guides and sanitized failure report with the one implementation.
- [x] G3: Validate OS-signal regressions, real launcher ownership (default and explicit
  settings, standalone and npm), guard-enabled fixture queries and repository/release gates.
  Record the remaining complete-container estimate limitation; close this correction here.

U1 remains the user-owned manual acceptance after G1–G3. No automatic cold-agent
judgment or timeline generation is part of this task. General container pushdown
and arbitrary-history capacity remain D2, not hidden follow-on implementation.
Changes remain uncommitted and unreleased.

G1–G3 closed on 2026-09-08. `pnpm test` passed **635 package tests** (domain 103,
canonical 33, adapters 247, runtime 111, CLI 54, TUI 87) and production dependency
boundaries. Build, governance (13 tests; 5 rules across 111 matches) and the final
standalone/local-npm artifact checks passed. Actual workspace and release entry
points preserved bare Node's default/explicit heap limits without adaptive children;
fixture SQL reads ran with the guard enabled. Skill validation and shipped-skill
equality passed. Mock layout/content checks passed for 156 files; the same eight
pre-existing Gemini scenario omissions remain D6. `git diff --check` passed.
The [sanitized failure/correction record](docs/research/2026-09-08-macos-memory-ownership.md)
includes aggregate local OS observations, the wrong initial assumption and remaining
capacity limits. No native full-query success or U1 acceptance is claimed.

## Independent-trial reassessment and 3.6 GiB observation — complete

The latest user report establishes artifact delivery; it does not establish complete
coverage or explain the SQL fallback. The skill's evaluation-specific timeline
workflow and alias example were removed. Runtime behavior was not specialized for
that task. Skill validation and standalone/local-npm shipped-skill checks passed.

A bounded Linux cgroup experiment used 3.6 GiB total hard memory, no swap and normal
Node/guard settings. Four distinct 2000-turn light reads succeeded with zero projection
issues; a full read was refused before parsing. The actual CLI's two-page SQL batch
reached all 2000 unique turns. Workload definitions, observed RSS (125.5–1018.4 MiB
for successful reads), guard refusal and limitations are in the
[capacity report](docs/research/2026-09-08-2000-turn-memory-capacity.md).
This qualifies those observations only. General D2 capacity work is not started by
this investigation, and U1 quality acceptance is not inferred from its results.
