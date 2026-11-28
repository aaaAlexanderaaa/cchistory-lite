---
doc_type: contract
status: current
authority: normative
contract_role: governance
implementation: implemented
verification_status: partial
last_reconciled: 2026-11-16
template_discipline_version: "2026.11"
---

# Working discipline

## Purpose and authority

CC History Lite helps people and agents recover useful information from local coding-agent
conversations. The owner identified the primary current use case as an Agent finding past answers,
decisions, and context so it can continue a task. Judge project improvements against that outcome,
including the effort needed to find, read, qualify, and cite the evidence.

This document owns reasoning, work selection, review, and execution discipline, aligned with
`template-project` (`discipline_version = "2026.11"`). Authority splits by owner:

| Concern | Authoritative owner |
| --- | --- |
| Product invariants, visual gate, history access, fixtures, projection contract, release gates | [AGENTS.md](../../AGENTS.md) |
| System chain, runtime flow, failure paths, state ownership, context discipline | [Architecture](../../ARCHITECTURE.md) |
| Public schemas and accepted feature contracts | [schemas/](../../schemas) and [docs/design/](../design) |
| Current execution state, milestones, and active owner decisions | [PLAN.md](../../PLAN.md) |
| Empirical multipliers, thresholds, cache bounds, and upstream spec constants | [Empirical constants registry](empirical-constants.md) |
| Historical benchmarks and learning comparisons | [docs/research/](../research/README.md) |

## Priority order and pre-code judgment

Apply these priorities in order whenever goals or constraints pull against each other:

1. **Data safety and requested outcome**: Keep zero-store and read-only source invariants intact,
   and deliver working verified results rather than empty process checklists.
2. **Single vocabulary and single source of truth**: Keep canonical history semantics in
   `packages/canonical` and assign every shared threshold, schema, or state value one owner.
3. **Plain direct prose and clean module boundaries**: Explain behavior plainly, keep dependency
   layers one-way, keep new modules focused, and declare file responsibilities clearly.
4. **Stage- and mode-matched verification**: Run real execution checks proportional to maturity
   stage, boundary risk, and collaboration mode.
5. **Plan and architecture synchronization**: Update `PLAN.md`, `ARCHITECTURE.md`, or owning
   contracts when settled facts change, without creating parallel progress logs.

### Three-perspective pre-code check

Before changing non-trivial behavior, check the task from three perspectives at once:

- **Executor**: Separate settled owner requirements and product invariants from open choices. Follow
  settled constraints directly; challenge one only when concrete evidence shows a clearly stronger
  alternative.
- **Collaborator**: Match structure and ceremony to design stability. Keep early exploration light
  so working slices move fast; once behavior settles, write explicit boundaries into the owning doc.
- **Senior Architect**: Check the affected area's maturity stage (`stable` core vs `experimental`
  adapter or exploratory slice) and proactively supply mature engineering structure—runtime control
  flow, single-owner state, error/fallback paths, and forbidden couplings—rather than mirroring an
  informal owner prompt straight into code structure.

### Maturity stages and object triggers

Core packages (`domain`, `canonical`, `live-runtime`, `lite-cli`, `lite-tui`), public JSON/SQL
schemas, `stable` adapters, and release artifacts are **`stable` (`1 -> N`)**: guard public
compatibility, projection consistency, and dependency boundaries strictly. Adapters marked
`tier: experimental` and exploratory prototypes stay agile without multi-agent review ceremony,
while still honoring zero-store, read-only source access, parse-boundary stops, and the projection
contract.

Apply the corresponding rule whenever work touches these concrete objects or effects:

| Object or effect touched | Required rule |
| --- | --- |
| Any human- or agent-read text (`README.md`, `ARCHITECTURE.md`, `PLAN.md`, `docs/`, `skills/`, CLI help/errors, TUI copy) | [Plain language and verbatim lineage](#plain-language-and-verbatim-lineage) |
| System or subsystem design and boundary descriptions | [Architecture clarity and module boundaries](#architecture-clarity-and-module-boundaries) |
| Shared state, counts, rankings, or configuration across callers or surfaces | [Single source of state](#single-source-of-state) and `packages/canonical` |
| CLI/TUI layout, hierarchy, styling, labels, or interaction flow | [AGENTS.md Visual changes](../../AGENTS.md#visual-changes) |
| New source files or substantial additions to oversized files | [Pragmatic modularity and role headers](#pragmatic-modularity-and-role-headers) |
| Substantive owner direction changes or architectural trade-offs | [Plain language and verbatim lineage](#plain-language-and-verbatim-lineage) |
| Resource limits, read plans, caches, query execution, or failure/recovery | [Capacity and observability](#capacity-and-observability) |
| High-risk boundaries, breaking changes, accumulated changes, or `/grill` requests | [Verification and completion](#verification-and-completion) |

## Task context and value

Before a consequential assessment or change, recover the original request, accepted interpretation,
current facts, authority, applicable boundaries, and completion evidence from existing code,
contracts, and `PLAN.md`. Investigate checkable facts locally before asking the owner to supply
them. Ordinary local repairs need no new interview, standalone plan, or full documentation reread.

Treat later owner corrections as refinements of the ongoing outcome unless the owner replaces it.
Before closing, check the combined request rather than only the latest example. Keep these distinct:
what the owner stated; a proposal the owner accepted; an implementer choice or inference; and an
open question. Recommendations and risk labels remain advisory until authorized; diagnosis authorizes
investigation and explanation rather than an unrequested product change.

For substantive priority recommendations, state the affected task and stakeholder, mechanism,
evidence, expected benefit, implementation and verification cost, continuing maintenance cost,
opportunity cost, and conditions under which the change would not matter. Compare the strongest
feasible alternative, including keeping current behavior when credible. Name important unexamined
directions and the evidence that would change the choice; omit invented numerical ROI estimates when
frequency, impact, or cost is unknown.

Distinguish necessity, importance, and ROI: a missing capability can block the core task, failure
importance depends on impact, frequency, and recovery, and ROI compares expected useful outcomes
against whole-life cost. Technical severity counts as one input alongside product value; explicit
invariants bind regardless of visible feature value. Direct authorized repairs need no portfolio
exercise.

## Plain language and verbatim lineage

Write repository docs, CLI help/errors, TUI labels, and shipped skills in plain, direct English (keep
verbatim owner quotes in their original language):

- State what the object is, how it works, and what problem it solves before caveats or background.
- Avoid coined jargon, theatrical metaphors, conflicting numbering on the same page, and raw
  internal codes or enums in human-facing copy.
- Avoid stacked defensive disclaimer phrasing (`"does not by itself"`, `"alone is not proof"`,
  `"cannot establish"`). When a scope boundary matters, state in one or two direct sentences what
  the artifact covers and what belongs elsewhere.
- Keep substantive direction-shaping owner requests, constraints, and rejections verbatim in `PLAN.md`
  or the owning design record, alongside links to superseded approaches so intent stays traceable.
- Maintain active execution state in `PLAN.md` rather than spawning ad-hoc `progress-*.md` files.

## Architecture clarity and module boundaries

### Five-part architecture standard

Keep [Architecture](../../ARCHITECTURE.md) and major subsystem design contracts clear enough for an
unfamiliar reader or fresh agent session to understand without reverse-engineering source files.
Cover five parts:

1. Positioning, core promises, and explicit out-of-scope boundaries.
2. End-to-end runtime and control flow with failure/fallback paths (`mermaid` flowcharts or sequence
   diagrams; static package-dependency boxes show coupling only).
3. Bounded layers/subsystems, maturity stages, narrow interfaces, and forbidden couplings.
4. Single authoritative owner for each shared state item and hard invariants.
5. Package entrypoints, responsibility expectations, and automated fitness checks.

### Single source of state

Assign one authoritative owner to every state, count, threshold, or ranking used across places, and
compute downstream summaries mechanically in `packages/canonical`. Keep lower-to-higher imports
forbidden (`architecture-rules.json`, `scripts/verify-lite-boundaries.mjs`). Pass explicit UTC
timestamps or injected clocks across boundaries, and keep test fixtures strictly isolated under
`mock_data/`.

### Pragmatic modularity and role headers

- Give new modules a concise top-of-file responsibility comment stating owned duty and excluded scope.
- Keep new production modules focused and under roughly 500 lines where practical, and avoid
  creating catch-all directories (`utils/`, `helpers/`, `common/`, `misc/`); name shared modules
  by concrete capability.
- Existing files above 500 lines need no speculative rewrite. Before making a substantial addition to
  an already large production file, check whether extracting a cohesive unit reduces change
  amplification or clarifies ownership; file length or taste alone still justifies no refactor.
- CSS modularization rules (`tokens.css`, 300-line style cap) apply only if Lite adds an HTML/CSS
  surface; CLI and ANSI TUI surfaces have no stylesheet layer.

## Causal investigation

Identify the conditions, causal mechanism, affected outcome, applicability limit, and discriminating
observation for plausible explanations, then test the explanation against real inputs. Source code
establishes a mechanism; frequency and installed-version causes require runtime observation of the
relevant build and operation. Treat a user failure report as direct evidence of experienced failure
while keeping root-cause attribution provisional until the matching build and path are observed.

An example exposes a candidate problem class rather than its full boundary. Broad assessments inspect
shared preparation, parsing, interpretation, materialization, queries, lifecycle, and surfaces as
well as source-specific adapters. Bounded repairs inspect plausible sibling failures without widening
into unrelated product changes, and preserve deliberately narrow owner-approved scopes without
requiring the owner to list every omission.

For consequential uncertainty or recurring corrections, run a bounded comparison capable of changing
the decision across genuinely different data shapes, approaches, or questions while holding the goal
and binding constraints fixed. Record initial findings, shared evidence origins, limitations, and the
stopping basis in the existing task record. Independent evidence requires a separate context rather
than re-reading the same material under another role label.

Inspect primary local code, fixtures, and reports first, and authoritative external docs when needed.
Verify assertions and inferences directly rather than citing existence alone. If a tool fails, use a
permitted fallback of comparable evidence quality without weakening safety, scope, or accuracy. Stop
blind retries and retain contrary or inconclusive findings. Use `skills/using-cchistory-lite/SKILL.md`
for native-history lookups.

## Authorized execution and ownership

Within an authorized outcome, resolve technical uncertainty, make reversible implementation choices,
integrate, verify, and fix discrepancies through completion. Internal checkpoints create no new
approval gates. Pause only the affected path and ask the owner when genuinely missing intent,
authority, accepted risk, or a choice that materially alters the outcome; continue independent
authorized work in parallel. Visual approval rules in [AGENTS.md](../../AGENTS.md#visual-changes)
remain binding: unapproved drafts and existing layout code never count as implied consent, and
proposed options must differ structurally rather than cosmetically.

Take the smallest credible route. Routine repairs update their existing owner and use focused checks.
Material changes define one coherent end state, affected owners and consumers, compatibility,
failure/recovery, and acceptance at the existing contract and plan. Unresolved technical questions
may use a disposable experiment with an explicit question, resource/time cap, abort condition,
cleanup, and stated evidence bounds; experiments require explicit promotion before shipping.

Inspect existing code and dependencies before adding abstractions. Refactoring requires a concrete
mechanism such as change amplification, repeated expensive work, an unclear ownership boundary, or
an obsolete assumption. Keep canonical semantics at their single owner and cut over producers and
consumers together rather than leaving parallel production executors behind.

When concurrent work is authorized, use `PLAN.md` or the delegation handoff to declare scope, shared
edits, and integration ownership, and re-read modified files before editing. Delegation passes the
parent outcome, original requirements, authority, permitted effects, baseline, evidence expectations,
and stop conditions without inventing new work registers or standing autonomy.

## Capacity and observability

Apply these requirements when evaluating or changing resource thresholds, read plans, retained
state, query execution, or failure/recovery behavior; unrelated docs or layout edits need no scale
suite.

Distinguish source inventory size, selected native bytes, simultaneous input, parsed object growth,
semantic state, searchable text, indexes, caches, output, and launcher/worker allocations, along with
system availability, V8 heap headroom, process RSS, and external/native memory. Name the exact
allocation or retained unit a guard bounds and calibrate it to the operation; disk size or a static
multiplier alone leaves actual query feasibility unmeasured.

Test the growth mechanism across many files/sessions, one large container, one large logical session,
one large record/value, accumulated reads/refreshes, and concurrent callers. A logical session is a
semantic unit rather than a memory bound; streaming I/O, collected iterators, small output pages, and
post-build cleared contexts leave intermediate allocation unbounded unless verified end to end.
Account for repeated work in search, detail retrieval, pagination, hashing, and cache eviction.

Keep identity, ordering, linking, usage, masking, and delegated evidence exact while optimizing
physical execution. Never silently truncate or drop evidence, widen scope, invent turns, disable
guards, or mislabel partial reads as complete. Reconcile contract changes with
`auditProjectionConsistency` and the fixture matrix before dependent delivery. Capacity records must
name source shape, largest unit, operation, artifact version, host environment, measured result, and
coverage limits; reported 8/16/64 GiB contexts describe test hosts rather than universal guarantees.

Treat observability as part of acceptance. Reuse existing runtime events and diagnostic owners to
report read identity and scope, selected execution path, stage progress, cold preparation vs cache
reuse, resource assessments, skipped evidence, and failure/recovery. Pick fields that answer concrete
user or agent questions without building a separate monitoring platform, and omit fabricated
progress percentages when totals are unknown.

Separate estimated demand from actual measurements, and distinguish guard refusal, skipped input,
abort, parse failure, timeout, and genuinely empty history. Long synchronous phases need checkable
processing boundaries or independent supervision; a timer on the same blocked event loop remains
uninterruptible during CPU saturation. Diagnostics must preserve machine output contracts, keep
transcript bodies and credentials out of default logs, avoid persistent history, and suggest a
permitted next step without normalizing guard bypass.

Run scale experiments against sanitized fixture-derived inputs with enforced memory/time caps,
bounded controller overhead, read-only sources, worker cleanup, and a no-progress stop so runaway
work fails safely. Retain failed runs alongside successes. Synthetic capacity measurements qualify
synthetic shapes; real-environment failures require verification in that environment when accessible,
or explicit disclosure of the remaining gap.

## Verification and completion

Verify bidirectionally before claiming readiness:

1. **Promise to observation**: Exercise real entrypoints (`cli`, `tui`, built release artifacts) for
   promised user outcomes and inspect exit status, rendered output, and bounds.
2. **Observation to unintended side effects**: Inspect `git status`, temp-root cleanup, unmatched or
   skipped inputs, missing/undeclared/excessive/suppressed behavior, stale snapshots, repeated scans,
   and failure/recovery.

Use the smallest evidence that proves each claim (sanitized fixture regression, integration path,
built artifact, bounded instrumented run, or consumer exercise), recording exact provenance: raw
input source, command, filters/exclusions, artifact version, and observed counts/losses. Distinguish
automated readiness (`ready_for_check` / implementation verified) from owner-owned usability
acceptance (such as `U1`).

Preserve all mandatory pre-commit and release gates (`build:lite`, `pnpm test`, `verify:governance`,
`verify:lite-artifact`). Reuse prior check results only while code, dependencies, and criteria stay
valid; never extrapolate unrun checks or attribute failures to the environment without evidence.
Report the exact achieved layer—reproduced defect, written rule, verified code change, completed
user task, or release—without implied expansion into portfolio work or unattended background jobs.

### Environment-aware review and independent review protocol

- **Interactive collaboration with a strong reasoning model**: Do not automatically spawn multi-agent
  reviews on ordinary tasks. Reserve fresh-context independent review for cross-boundary or breaking
  interface changes, security/data-safety edges, recurring owner doubts, or explicit owner requests.
- **Change-based `/grill` cue**: Judge review accumulation by commits or distinct subsystems changed
  since the last holistic review rather than elapsed calendar days.
- **Unattended autonomous operation**: Never run unattended multi-wake loops without an explicit
  owner-approved charter defining authorized goal, write/effect bounds, resource caps, independent
  milestone review, auto-dormancy on repeated failure/blockers/completion, and zero self-editing of
  charter, budgets, or approvals.
- **Independent review requirements (all four must hold)**:
  1. **Fresh context, withheld rationale**: Run in a context that did not author the deliverable,
     supplying owner requests, standing agreements, and target artifacts while withholding author
     explanations until the reviewer records its first judgment.
  2. **Open-ended holistic mandate first**: Start with an open question covering goal alignment,
     architecture/boundaries, cross-document consistency, and real consumer usability before any
     narrow targeted checks.
  3. **Preserve first judgments**: Keep initial findings and contrary observations visible without
     overwriting them with later synthesis.
  4. **Closed-loop re-verification**: Send fixes back to the original reviewer context (when open)
     to confirm root flaws vanished, and run a fresh unprimed pass when structural changes are
     substantial.

## Learning and rule health

When corrections recur, fix the smallest responsible default, interface, example, context route, or
rule while preserving working methods and their invalidation conditions. Record durable principles
rather than growing incident checklists.

Whenever a rule is skipped, gamed, or slows healthy work, diagnose which cause occurred before
stacking more reminders:

1. **Delivery gap**: The rule mattered but surfaced too late — place the cue where affected work starts.
2. **Vague trigger**: Broad labels allowed overconfident skipping — bind triggers to concrete objects or effects.
3. **Habitual corner-cutting**: Repeated shortcuts in practice — add a deterministic check or clear exemplar.
4. **Faulty or Goodhart metric**: Optimizing the proxy harms the real goal — revise or delete the rule against owner intent.

For discipline or entrypoint changes, inspect induced behavior on both a task that should benefit
and an ordinary task that should stay light, using a fresh consumer through the normal entrypoint when
claiming cross-context effectiveness. Update existing owners (`AGENTS.md`, this contract, `PLAN.md`,
and evidence records) rather than adding redundant ledgers. Supporting evidence and source
comparisons live in [2026-10-13 learning and validation](../research/2026-10-13-working-discipline.md)
and [2026-11-16 discipline sync](../research/2026-11-16-working-discipline-sync.md).
