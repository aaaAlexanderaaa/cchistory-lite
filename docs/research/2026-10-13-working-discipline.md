---
doc_type: evidence
status: historical
authority: evidence
last_reconciled: 2026-10-13
---

# Working-discipline learning and validation

This record supports the [current working discipline](../contracts/working-discipline.md).
It records the learning comparison, verification actually performed, and limitations; it does not
own rules or authorize product implementation. The [current task](../../PLAN.md#project-work)
owns the remaining execution state.

## Learning comparison

### Source and authorization

The owner requested learning from `template-project` and updating this project's discipline on
2026-10-13 after repeated corrections to the assessment. The direct project clarification was the
Agent recall use case; resource failures, a large database, and a large session were examples of
broader concerns, and the owner explicitly rejected narrowing the problem to ZCode. The owner
also raised observability. These are project instructions/reports, not measured capacity limits
or acceptance of the implementer's suggested runtime design.

The template was read at revision `1099ddc6568af5bb2e4a1d080dfc315653cbff58`, with a clean working
tree. Its current authority map, contracts, concern owners, and five behavior guides were opened.
The engineering-judgment contract was a target draft; its useful comparison methods are selected
here, without claiming the draft was an already enforced source rule. Template norms are method
sources; their reported history is not independent proof of effectiveness in Lite.

### Rule survey and landing

Rules sharing applicability and a local owner are grouped below. Existing product boundaries
continue at their original owners; this learning does not migrate the template's harness.

| Source rules/methods | Comparison with this repository | Local result and owner |
|---|---|---|
| Authority map, task context, language, document lifecycle | Existing architecture, query contracts, PLAN, and research have distinct roles; the entrypoint lacked a judgment/learning route. | Applies, gap addressed by this owner and its AGENTS link; legacy document metadata is not migrated. |
| Development: outcomes, attribution, scope, causal inquiry | The assessment began with technical findings and narrowed broad feedback to examples without enough task/value evidence. | Applies, previously unsatisfied; task context and causal investigation now state the required reasoning. |
| Development: one owner, coherent end state, content fidelity | AGENTS and architecture already assign canonical semantics, parser boundaries, source safety, and one-way layering; unknown evidence must remain visible. | Applies, existing declared boundaries retained; implementation compliance still uses their guards. |
| Development: category repair, experience, durable recording | The conversation repeatedly corrected goal, scope, resource assumptions, and verification strength; those cues were absent from normal entry. | Applies, previously unsatisfied; this owner and AGENTS supply the retrieval path. Subsequent uptake is unobserved. |
| Governance: direction, advice, authority, blockers, uncertainty, Grill questions | Explicit product constraints and visual approval exist; the assessment treated technical priorities too readily as product priorities. | Applies, preserved boundaries plus task/value and execution rules; no new blanket approval gate. |
| Agent execution: proportionate route, evidence, layered completion, reuse, scale | Package/artifact gates and historical measurements exist; passing gates did not settle user quality acceptance or general resource behavior. | Applies, partial existing coverage; capacity and verification now require claim-specific evidence. |
| Agent execution: independent review, coordination, bounded delegation | This is one bounded documentation update with one writer, no runtime or privileged change, and no requested independent review. | Conditional; no delegation/review machinery is activated for this edit. Required independence cannot later be claimed from self-review. |
| Agent execution: billed/account resources | Native history reads require no paid upstream account; investigation/CI can still consume finite resources. | Conditional; bound costly experiments and obey tool/account limits, without inventing a billing subsystem. |
| Engineering judgment target: complexity, alternatives, reuse, standpoint, rule limits | Long files and reproducible risks were used as priority signals without sufficient comparison of user benefit and whole-life cost. | Applies as selected methods; task/value, investigation, and ownership replace those shortcuts. |
| Adoption/onboarding: survey, preserve owners, authorship, current vs target | This is an existing Git product with source code, tests, releases, and project-specific rules; the request is learning and discipline updates. | Applies; additive local reconciliation. Wholesale copying, CI enforcement adoption, and product-code changes are outside this task. |
| Documentation harness: links, projections, mechanical limits, stages | Lite already has its own architecture manifest/harness; it has no template docs policy/checker or style manifest. | Ownership/link honesty applies; template-specific stage, aging, template inventory, and style-checker rules are not adopted. |
| Foundational runtime: scope recognition and time | Canonical recency, source timestamps, SQL time predicates, clocks/expiry, and usage periods already have owners. | Applies to relevant changes; preserve existing meaning and controlled-time tests. No timezone policy cutover in this task. |
| Foundational runtime: visible demo data and mutating scene lifecycle | mock_data is sanitized historical test input, not a product scene-refresh service. | Historical/sample labeling remains relevant; daily refresh, reset, and production/demo mutation rules have no such runtime here. |
| Autonomous operation: charter, wakes, cadence, taste corpus, independent closure | No standing autonomous objective, charter, scheduler, or private taste corpus was supplied for this task. | Does not apply to this bounded update; no autonomous operation is enabled or claimed. |
| Data analysis: scope, record accountability, parameters, fallible metrics | Usage and search rankings exist; this review also relied on fixture and cost observations. | Applies when making analytical claims: state bases, method and scope, expose losses. No dashboard is required; old algorithms may be comparison evidence without parallel production executors. |
| Research and information access guides | Existing local code and sanitized reports can answer many facts; reported installation failures remain unobserved. | Applies; source checks, capability-preserving fallback, discriminating comparisons, and precise evidence limits at causal investigation. |
| Project operation and Grill guides | Useful review must challenge task selection and claims, including the interpretation that generated them. | Applies as conditional methods; compare original goal with artifacts, preserve supported no-findings, and keep review distinct from implementation authority. |

The development concern table was also followed into its owners. Compatibility applies to public
CLI/JSON/schema/artifact changes; ephemeral state integrity applies to snapshots, refresh and
caches, while persistent history migrations remain forbidden. Security/privacy applies to native
read-only sources and untrusted content; capacity and operations apply to the reported resource
and diagnostic problems; dependencies/build apply to the release closure; experience applies to
Agent tasks and approved CLI/TUI changes. Time and sample-data concerns follow the existing
canonical/fixture owners above. Analytical claims apply to usage, ranking, and measurement.
Production-learning assumptions require an observation and correction decision when claimed.
This document changes none of those runtime policies and adds no untriggered checklist or gate.

### First-draft completion boundary

This update lands the local discipline and its normal entrypoint. It preserves the prior AGENTS
instructions, product code, schemas, CI, release procedure, and historical delivery records.
Structural checks and scenario inspection can verify the written route; effectiveness in a fresh
continuation remains unverified. The original project assessment is still pending a corrected,
goal-grounded evaluation. Capacity, observability, and Agent usability are not fixed by this edit.

First-draft verification on 2026-10-13:

- `git diff --check` passed. All 10 local file/heading links in the two changed documents resolved;
  required contract metadata was present and no template placeholders remained.
- A comparison with `HEAD:AGENTS.md` confirmed that removing only the new entry section recovers
  the original instructions exactly. Product invariants and existing gates were not rewritten.
- `pnpm run verify:governance` passed: 13 harness tests and 5 rules across 116 production matches.
  This verifies that existing governance still runs; it does not mechanically enforce judgment.
- Same-context text inspection compared the broad assessment, a bounded resource repair, and an
  ordinary documentation correction. The first preserves the whole task and tests examples beyond
  one adapter; the second activates cost/diagnostic evidence and bounded scale experiments; the
  third does not activate stress tests, a full template migration, or new approval checkpoints.
  These are checks of the written instructions, not observations of a fresh Agent applying them.
- Product code and shipped artifacts were unchanged, so build/package/artifact gates were not
  repeated for this documentation edit. Their earlier results are not offered as evidence of
  improved discipline or capacity. No commit or release was made.

## Adequacy recheck

The owner challenged whether the first update was sufficient. That challenge exposed a concrete
integration gap: the current contract said the original assessment was pending, while PLAN still
opened with the earlier completed delivery. A new consumer following the execution owner could
therefore select stale work. The current task has now been reconciled in PLAN; dated delivery
records remain intact with only their opening label clarified.

The learning comparison was also separated from the current normative document. Rules and their
conditional triggers stay in the working-discipline owner; source survey and validation history
stay here. AGENTS routes to relevant sections and this evidence instead of carrying an expanding
incident account. The rule owner now explicitly requires observing induced behavior and checking
both a relevant task and a normal burden countercase when changing discipline or defaults.

The recheck verified all 26 local file/heading references in AGENTS, PLAN, the working discipline,
and this record. Removing the new AGENTS entry still recovers HEAD's original instructions
exactly. PLAN's previous record remains verbatim apart from the H1-to-H2 change and replacing its
old "Current work" label with "Delivery record". `git diff --check` passed. Production inputs to
the existing governance gate were unchanged, so its first-draft result remains applicable to those
inputs; this is not new behavioral evidence.

A bounded fresh-consumer trial has been proposed using the normal AGENTS entrypoint, original
project-assessment task, actual repository sources, and no producer reasoning trace. Explicit
permission to invoke a sub-agent is required by this chat's tool policy. At the first recheck that
permission was pending, so no worker was dispatched and no independent verdict was claimed.
The owner subsequently authorized the bounded read-only trial on 2026-10-13. Its protocol required
preserving the first result, inspection path and evidence limits; execution results follow.

## Fresh-consumer trial

The owner explicitly authorized one bounded read-only independent Agent trial. The worker was
`/root/discipline_trial`, spawned with `fork_turns: none`, without a model override or the
parent's earlier reasoning/probes. It received the original assessment request, the owner's
primary use case and examples, repository path, normal AGENTS entry, permitted effects and
bounds. It was free to challenge the discipline. No desired ranking or code finding was supplied.

The worker reported about six minutes of inspection. It read AGENTS, applicable working-discipline
sections, current PLAN, README, Architecture and Agent guidance, then SQLite/JSONL preparation,
ZCode/Cursor, snapshot/cache, evidence search/paging, CLI diagnostics and relevant fixtures/reports.
This inspection path is the worker's returned account; the parent did not independently trace
every tool action. It reported no file edits, native-history access, builds, full suite or extra
workers, and unchanged start/end git status.

### First returned judgment

The first response was retained before feedback or further checks; its original wording is in
the authorized trial's chat output and a local raw copy outside the repository. The following
English summary preserves the judgment and its limits, rather than replacing it with later
reconciliation:

- Prioritize the cost/reliability of locating and reading needed evidence. Availability failures
  can block the core task, but do not yet justify universally relaxed thresholds, a complete
  rewrite or new storage.
- Inspect containers, one large session/value and cumulative retained state around a concrete
  operation. Current ZCode estimates selected values, so the user's disk-size report does not
  identify the failing current mechanism. Known-ID reads are useful but do not solve first search.
- Test the one-hit-per-top-level-session tradeoff for old decisions. In the existing parent
  fixture, two messages matched `fixture`, while only the later one was returned; total was one
  and no search continuation existed. This is observable retrieval behavior, not a proven failed
  real task. Compare refined keywords/full-session reading with multiple matches/context.
- Consider immutable-target revision reuse: 8,806 UTF-16 units, four messages and 257-unit pages
  yielded 35 pages and 140 complete message serializations. This demonstrates repeated work,
  not measured latency savings or ROI.
- Reuse existing read/gap/resource diagnostics and events for Agent-visible execution explanations.
  Non-JSON TTY progress and omitted SQL work counts are concrete seams. A monitoring platform is
  unsupported; synchronous interruption needs more than a timer.
- Do not prioritize more adapters, MCP/daemon, vectors or detail formatting above these findings
  without evidence. Historical formatting savings did not establish a capacity solution.

The worker initially suspected a conflict between an older memory report and the current guide.
Source, CHANGELOG and commit `4a94fdc` resolved it: conditional heap growth returned later.
That contrary observation is preserved. Historical delivery evidence cannot stand in for current
runtime behavior; the dated PLAN route helped, but the long historical record added reading cost.

The worker attributed useful actions to goal/value, broad-scope and evidence-limit rules. Those
are its own account of influence. A single trial without a no-rule/before comparison supports
observed uptake, not a causal claim that these edits improved the Agent versus an earlier baseline.
Its first verdict explicitly left ordinary-task burden, native refusal attribution, published
artifact parity, real recall quality/frequency and general 8/16/64 GB capacity unverified.

### Ordinary-task countercase and reconciliation

After retaining the first verdict, the same worker received a small real read-only task: check
the README's Agent skill link and matching frontmatter name. It located the link with `rg`,
checked directory/file existence and read the first nine skill lines. The target exists and
`name: using-cchistory-lite` matches the directory. It reported reusing repository/entry/safety
context, without rereading assessment documents, questions, edits or expanding the task.
This is an observed proportional check in a warm context, not a second fresh-context control or
proof about all ordinary edits.

The parent reproduced both new pure-function observations using the existing parent fixture and
local built canonical functions: two matches reduced to the latest one, and 35 pages performed
140 full-message serializations while reconstructing all text. Source and built functions were
inspected; no released-package claim follows. These repeated observations share evidence origins.

The new retrieval limitation changed the parent's assessment: useful availability alone is
insufficient if long-conversation grouping hides the needed historical decision. The
[corrected project assessment](2026-10-13-project-improvement-assessment.md) now compares feasibility,
retrieval, lifecycle, diagnostics, evidence quality and engineering costs with real alternatives.
PLAN's current task is reconciled, and its runtime locator distinguishes current Architecture/source
from dated records. No product code, public match contract or visual behavior was changed.

The written discipline, normal entrypoint and one fresh assessment/one warm countercase have been
checked. Behavioral verification remains partial: no causal comparison, durable repetition,
cold ordinary-work control, actual history-user success or native capacity closure was obtained.
This closes the authorized bounded trial, not U1 acceptance or recommended product implementation.
