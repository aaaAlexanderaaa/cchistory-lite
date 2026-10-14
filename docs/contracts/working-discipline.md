---
doc_type: contract
status: current
authority: normative
contract_role: governance
implementation: implemented
verification_status: partial
last_reconciled: 2026-10-13
---

# Working discipline

## Purpose and authority

CC History Lite helps people and agents recover useful information from local coding-agent
conversations. The owner identified the primary current use case as an Agent finding past answers,
decisions, and context so it can continue a task. Judge project improvements against that outcome,
including the effort needed to find, read, qualify, and cite the evidence.

This document owns reasoning, work selection, and execution discipline. It does not select a new
runtime design, resource threshold, public interface, or roadmap. The owner retains direction,
priority, and risk acceptance. The [repository instructions](../../AGENTS.md) retain the product
invariants, visual approval, native-history access, fixtures, and release gates.
[Architecture](../../ARCHITECTURE.md) owns structure; schemas and accepted design contracts own
public behavior; [PLAN.md](../../PLAN.md) owns execution state and order. Historical research
supports claims within its stated conditions and does not authorize new implementation.

## Task context and value

Before a consequential assessment or change, recover the original request, accepted interpretation,
current facts, authority, applicable boundaries, and completion evidence. Use the existing request,
code, contracts, and relevant plan. Investigate facts before asking the owner to supply them.
Read deeper context when it could change the decision; ordinary local work needs no new interview,
standalone plan, or complete rereading of the documentation.

Treat later corrections as refinements of the ongoing outcome unless the owner replaces it. Before
closing, check the combined request rather than only the latest example. Keep these distinct:
what the owner stated; a proposal the owner accepted; an implementer choice or inference; and an
unresolved question. Recommendations and risk labels are not authorization to implement them.
A diagnosis authorizes investigation and explanation, not an unrequested product change.

For substantive priority recommendations, identify the affected task and stakeholder, mechanism,
evidence, expected benefit, implementation and verification cost, continuing maintenance cost,
opportunity cost, and conditions under which the change would not matter. Compare the strongest
feasible alternative, including retaining current behavior when credible. State important
unexamined directions and what evidence would change the choice. Do not manufacture weak options
or numerical ROI estimates when frequency, impact, or cost is unknown.

Distinguish necessity, importance, and ROI. A missing capability can prevent the core task; a
failure's importance depends on impact, frequency, and recovery; ROI compares expected useful
outcomes with whole-life cost. Technical severity alone does not establish product priority.
Explicit invariants still bind even when their repair has little visible feature value. A direct,
authorized local repair needs no portfolio exercise.

## Causal investigation

Identify the conditions, causal mechanism, affected outcome, applicability limit, and observation
that could distinguish plausible explanations. Apply that explanation to actual inputs. Source
code establishes a mechanism; it does not establish its frequency or the cause of an unobserved
installed-version failure. A user report is evidence of experienced failure; retain uncertainty
about attribution until the relevant build and operation are observed.

An example exposes a possible problem class, not its entire scope. For a broad assessment, inspect
shared preparation, parsing, interpretation, materialization, queries, lifecycle, and surfaces as
well as source-specific behavior. For a bounded repair, examine plausible sibling failures without
expanding into unrelated implementation. Preserve a deliberately narrow owner-approved scope.
Do not require the owner to enumerate every omission before investigating the whole requested task.

For consequential uncertainty or recurring corrections, run a bounded comparison capable of
changing the judgment. Compare genuinely different evidence, data shapes, approaches, or
stakeholder questions while holding the goal and binding constraints fixed. Record first results,
shared evidence origins, limitations, and the stopping basis in the existing task record. Another
role name or another reading of the same material is not independent evidence. Use a separate
review context when the accepted change requires independence; do not claim it from self-review.

Inspect primary local evidence first and authoritative external sources when needed. Check the
assertion and inference, not merely that its citation exists. If a tool fails, try a permitted
fallback that observes the required property without weakening safety, scope, or evidence. A
successful extraction that omitted decisive material remains partial. Stop blind retries and
retain contrary or inconclusive results. Use the existing history-access skill for native history.

## Authorized execution and ownership

Within the authorized outcome, investigate technical uncertainty, make reversible implementation
choices, integrate, verify, and correct discrepancies through the requested end. Internal
checkpoints do not create new approval gates. Ask only for genuinely missing intent, authority,
accepted risk, or a decision that materially changes the outcome. Pause the affected path and
continue independent authorized work. The existing visual approval rule remains binding.

Use the smallest credible route. A routine repair updates its existing owner when behavior changes
and uses focused verification. A material change first describes one coherent end state, affected
owners and consumers, compatibility, failure/recovery, and acceptance at the existing contract and
plan. An unresolved technical fact may use a disposable experiment with a question, resource and
time bound, abort condition, cleanup, and explicit evidence limits. An experiment does not silently
become shipped behavior or grant new permissions.

Inspect existing code and dependencies before adding a capability or abstraction. Refactoring
requires a concrete mechanism such as change amplification, repeated expensive work, an unclear
ownership boundary, or an obsolete assumption. File length and taste alone do not justify it.
Name what complexity the change introduces and what useful outcome it buys. Keep canonical
semantics at their current owner and cut over producers and consumers coherently; do not retain
parallel production executors to avoid completing an authorized replacement.

When concurrent work is authorized, use the existing plan or handoff to declare scope, shared
changes, and integration ownership; re-read affected files before editing. Delegation uses the
parent outcome, original requirements, current authority, permitted effects, baseline, evidence,
and stop conditions. It creates no new work register, privacy permission, or standing autonomy.

## Capacity and observability

Activate these requirements when evaluating or changing a material resource assumption, guard,
read plan, retained state, query execution, or failure/recovery behavior. They do not require a
stress suite for an unrelated documentation edit or local rendering correction.

Distinguish source inventory size, selected native bytes, simultaneous input, parsed object growth,
semantic state, searchable text, indexes, caches, output, and any worker/launcher allocations.
Also distinguish system availability, V8 heap headroom, process RSS, and external/native memory.
Name the allocation or retained unit the guard actually protects and calibrate it to the operation.
A file's disk size or a multiplier alone is not proof that a useful query cannot run.

Test the growth mechanism, not only counts. Relevant axes include many files or sessions, one large
container, one large logical session, one large record/value, accumulated reads and refreshes, and
concurrent callers. A session is a semantic boundary, not a proven memory bound. Streaming I/O,
an iterator collected into an array, a small output page, and an empty context array after
construction do not by themselves establish bounded processing. Account for repeated work during
search, detail retrieval, pagination, hashing, and cache eviction.

Keep identity, ordering, linking, usage, masking, and delegated evidence correct while changing
physical processing. Do not silently truncate or drop evidence, widen scope, invent turns, disable
guards, or present a partial result as complete to make a resource test pass. Required contract
changes are reconciled with the projection audit and fixture matrix before dependent delivery.
Capacity observations name source shape, largest unit, requested operation, artifact version,
resource environment, measured result, and failure/coverage limits. An operating envelope remains
unqualified outside those conditions; 8/16/64 GB hosts are reported usage contexts, not guarantees
that an arbitrary history fits.

Observability is part of accepting the affected behavior. Reuse the runtime's existing events and
diagnostic owners to explain request/read identity and scope, selected execution path, current
stage and meaningful progress, cold preparations and repeated reads, cache decisions, resource
assessment/decision, skipped evidence, and failure/recovery. Select fields that answer an actual
user or engineering question; do not create a monitoring platform or new registry by default.
Absence of a known total must not produce a fabricated progress percentage.

Distinguish estimated demand from actual measurements and distinguish refusal from skipped input,
abort, parse failure, timeout, and genuinely empty history. A long synchronous phase needs a
checkable processing boundary or independent supervision; a timer on its blocked event loop is
not proof that it can be interrupted. Diagnostics must remain usable by Agents, preserve machine
output contracts, avoid default transcript/credential logging and implicit persistent history,
and name a permitted next action. Do not make disabling protection the normal recovery path.

Run scale experiments against sanitized fixture-derived data with enforced memory/time limits,
bounded controller overhead, read-only sources, process/worker cleanup, and a no-progress stop.
An experiment designed to find runaway behavior must fail without exhausting the developer host.
Preserve failures as well as successful cases. Synthetic or simulated capacity cannot close a
reported real-environment failure; verify there when accessible, otherwise retain that gap.

## Verification and completion

Choose acceptance from the user's task before selecting tests. Observe both promised results and
actual effects: missing, undeclared, excessive, or wrongly suppressed work; wrong identity/scope;
stale or partial data; repeated scans; retention and cleanup; and failure/recovery where relevant.
Inspect unmatched, rejected, and skipped inputs before treating an empty result as success.

Use the smallest evidence that can establish each claim: a regression fixture, integration path,
built artifact, instrumented bounded process, or actual consumer use. Identify its class, version,
conditions, and limits. Passing package, schema, architecture, and artifact checks establishes
their tested claims, not task success, native completeness, or general capacity.
Agent usability acceptance uses what an unfamiliar consumer would normally receive; do not tailor
instructions to a particular evaluation task or silently repair the consumer's result and call
that autonomous success. A same-context walkthrough does not prove fresh-context usability.

Run checks appropriate to the changed boundary; do not repeatedly rebuild unchanged code solely
for activity. Preserve the mandatory pre-commit and release gates. Reuse a result only while its
artifact, relevant dependencies, criteria, and conditions remain valid. Missing observations stay
unknown or not run. Attribute environment failures only with evidence.

Report the completion layer precisely: a reproduced defect, a written rule, a verified code
change, a successful user task, and a release are different claims. Finish all work authorized for
the claimed layer. Existing debt remains visible without blocking unrelated work. No bounded task
creates permission for ongoing portfolio work, unattended scheduling, or product expansion.

## Learning and documentation

When corrections recur, repair the smallest responsible default, interface, example, context
route, or rule. Preserve useful methods and their invalidation conditions, including successful
ones. Add a proportionate sibling guard where it can protect stable behavior; a review cue must
say what it cannot enforce. Record the principle rather than a growing incident checklist.

Put the locator where matching work begins and keep one owner per rule. Plans track execution,
guides explain use, and evidence supports claims; none silently replaces current authority.
Write repository rules and records in plain English. Preserve relevant decisions and history,
retire redundant advice, and add machinery only when its repeated benefit warrants the cost.
Written rules prove retention. Claim improved discipline only after subsequent authorized work
finds and applies them, including a relevant counterexample or changed condition.

For a discipline, default, or entrypoint change, inspect the behavior it will induce in later
work, not only its wording. Compare the standing rule with a local correction or conditional
trigger where credible. Exercise a task that should benefit and an ordinary task that should not
pay unrelated process cost. Observe the context actually read, actions, unnecessary questions,
evidence obtained, and outcome. Use a fresh consumer through the normal entrypoint when claiming
that the improvement survives a new context; supplied producer reasoning cannot establish that.
If that check is unavailable, retain the behavioral claim as partial while completing available
verification. Required review never becomes executor self-approval.

Repeated owner doubts about judgment or completion reopen the affected interpretation, evidence,
and operating method. Trace the failure to its responsible owner and repair that route; additional
rules or reassurance alone do not close it. Preserve first judgments and failed trials, reconcile
consequential findings, and update the current task at its existing owner before handing off.
The [learning and validation record](../research/2026-10-13-working-discipline.md) contains this
change's source comparison and observed checks; it is supporting evidence, not startup reading.
