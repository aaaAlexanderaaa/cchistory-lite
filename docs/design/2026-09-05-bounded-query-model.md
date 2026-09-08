# A bounded, composable query model

> Status: file planning, metadata reuse, and the canonical interpretation seam are implemented;
> optional detail construction, selective plans, grammar, and surfaces remain proposals. Supporting evidence is recorded in
> [sanitized research reports](../research/README.md); raw history and machine-specific research
> artifacts remain outside the repository. This document contains design choices and open decisions.

Execution scope and completion conditions are maintained in [the work plan](../../PLAN.md).
That plan supersedes the broad implementation sequence below: a finite query frontend can use
the complete snapshot before optional detail construction or general cache/generation work.
The [M1 review contract](2026-09-06-query-contract-v1.md) now specifies the proposed dialect,
parser, fields, templates, result guarantees, and shell lifetime for the first delivery. Its
concrete decisions supersede this document's deferred syntax choices, pending user review.

## Intent

Borrow a familiar query syntax so users can combine a small set of conditions without learning a
separate flag for every question. Reusing syntax does not require adopting a database engine.
Convenience commands remain useful: `latest` should express a common query and benefit from its
specialized execution plan, rather than own a separate implementation of history semantics.

The proposed model is a constrained query service over canonical history. It is not a general SQL
database, a persistent index, or a commitment to a background daemon. The existing read-only source
and zero-store promises remain in force.

## Three separate responsibilities

```text
convenience command / supported query syntax / structured client request
                              |
                    validated logical query
                              |
              source capabilities + resource budget
                              |
                    physical read plan
                              |
           canonical projection + query execution
                              |
               result rows + evidence of coverage
```

The syntax frontend validates names, types, supported constructs, and expression complexity. A
maintained parser for a chosen dialect is preferable if it fits the shipped artifact; the public
subset must be explicit. Unsupported syntax fails before source preparation. Parser choice and
the exact dialect are deferred until a small query corpus establishes the required constructs.

The logical query describes the collection, selected fields, predicates, ordering, result limit,
and required guarantees. Canonical semantics define identity, project membership, related work,
usage, and recency. The physical planner decides which native evidence must be read and when a
result is ready. Adapters expose evidence and capabilities; they do not decide query semantics.

Equivalent command and syntax inputs must normalize to the same logical query. Different physical
plans must preserve the same answer and guarantees. No package split is prescribed yet.

## Recommended candidate to develop

Use a complete compact generation as the reference read model within an explicit operating
envelope. Add selective execution for individual query shapes only when source evidence proves
the requested result. Both paths belong to one query service. Do not require universal lazy loading
or a new transport before the first useful optimization.

The query service should own three distinct objects:

- **Preparation inventory:** selected primary files, supplemental and companion evidence, logical
  grouping, evidence versions, uncertainty, and costs already incurred. Estimation and execution
  share it for one attempt. It is not an indefinitely reusable directory cache.
- **Unit result:** the compact interpretation of a safe source unit, keyed by source identity,
  evidence version, interpretation version, and available fields. This is reusable computation,
  not an independently complete answer about projects or families.
- **Published generation:** the immutable set of unit results plus their canonical relationships,
  coverage, and query-visible ordering. Queries and pagination bind to this object.

A unit cache is optional and budgeted. Start by reusing work within one preparation. Extending
coverage or refreshing evidence publishes a replacement generation; it must not silently change
the meaning of an already issued generation identifier. Reusing a parsed unit does not exempt
global project and family relationships from recomputation when their evidence changes.

Keep compact semantic extraction separate from detail presentation. Usage attribution, models,
errors, and delegated-work summaries can require assistant/tool evidence even
when full replies and tool payloads are not retained. The compact path must preserve those facts
without presenting an incomplete detail object as a complete one. Reducing detail construction
does not by itself bound record/fragment/atom memory or the size of the retained turn collection.
The [semantic/detail boundary](2026-09-05-semantic-detail-boundary.md) specifies current consumers,
the inactive assistant-reference search branch, the implemented canonical interpretation entry,
and the nonempty 16-source parity matrix. Complete contexts are still eagerly constructed.

For each optimized plan, report separately what is avoided: discovery, native bytes read, JSON
decoding, canonical projection, or retained state. Computing an activity upper bound by reading an
entire transcript may avoid projection but cannot justify a claim of sublinear source reads.

Prefer this sequence for the first implementation slices, after their contracts are reviewed:

1. Share and validate one physical inventory between risk estimation and execution, including
   companion evidence and invalidation. Preserve existing command results.
2. Reuse unchanged metadata within the preparation attempt and measure the saved work.
3. Separate compact semantic evidence from detail presentation where the benefit warrants it;
   preserve the complete path as an equivalence reference.
4. Introduce one selective plan with an explicit proof and fallback. Keep exact totals and
   exhaustive diagnostics available even when they require completing preparation.
5. Add the finite syntax frontend once the logical operations and result guarantees are stable.

The generation's memory envelope, cache admission policy, and large-unit strategy still require
capacity evidence. This candidate does not commit to a fixed idle timeout, automatic background
service, persistent derived index, or claimed capacity for arbitrary native histories.

### First implementation boundary

The runtime now prepares one attempt-local file plan from adapter discovery and existing scope,
sample, and session selection. The guard estimates from that plan and the probe consumes it.
It covers primary files across declared supplemental roots, declared companion capture, and
SQLite WAL/SHM dependencies, including WAL/SHM when safe mode disables companion capture. Shared
companions count once per source. Logical-group fallback and delegated-session expansion must
reassess any expanded read plan before reading it.
Source-level identity lookups that may read whole JSON files retain all candidate files in the
budget and run only after assessment; finding one session does not make that preparation free.
Grok companion discovery caps its summary inspection at 1 MiB and retains possible parent
evidence when the summary is larger, changing, or unreadable.

File identity, size, and modification/change times validate the planned evidence before use.
Metadata used to exclude files remains part of the validation evidence. A detected change ends
the attempt with an explicit retry error; a new scan builds a new plan. New primary files are
discovered on the next scan. This is neither a native transaction nor protection against every
change between a stat and a read.

The byte estimate remains a heuristic. It does not yet account for parser-internal metadata
lookups outside declared companions, live API collection, preparation I/O already incurred, or
container extraction peaks. Those dependencies and costs still need explicit contracts before
claiming complete cost accounting or a bounded generation. No syntax, engine, session transport,
or cross-request cache is introduced by this slice.

### Preparation metadata reuse

One scan attempt owns the logical-session metadata it has inspected. Entries are keyed by source,
platform, path, and inspection contract: identity only, first workspace signal, or full workspace
metadata. These contracts stay separate because their directory answers can differ. Repeated
scope/sample/group preparation and delegated-session expansion can reuse the same contract over
unchanged files. Requests retain their own order, including duplicates and subsets.

Validate file versions before admitting inspected metadata and before reusing it. A changed or
newly appearing file invalidates the attempt; do not silently replace one cached answer while
earlier decisions still depend on the old version. Reused results retain their original evidence
plan, including files excluded by earlier selection. Uncertainty remains explicit. Caller-owned
copies prevent later changes to a returned object from changing the reusable result.

The retained objects contain metadata and file versions, not transcript buffers. A refresh owns a
new preparation. This does not introduce a persistent index, cross-request cache, or cache memory
capacity guarantee. It also leaves Codex's separate sample-parent identity lookup and Grok catalog
reads unchanged. Benefits depend on repeated inspection of the same contract; a one-pass workload
has no redundant metadata reads to remove.

## Initial expressive boundary

Start with a single named collection per query, selected public fields, bound parameters, scalar
comparisons, ranges, membership, null checks, bounded boolean composition, ordering, and a result
limit. Decide text-predicate semantics explicitly. Nested queries, arbitrary joins, user-defined
functions, arbitrary aggregation, and mutations are outside the initial proposed scope.

Choose public collections around useful canonical meanings: top-level browsing sessions, all
addressable sessions, turns, projects, and related work. Keep exact detail retrieval and canonical
usage operations available through the query service without requiring a general join or aggregate
language. A project predicate must not silently become a working-directory predicate.

Define null/missing values, timestamp normalization, string matching, and deterministic tie-breaking
before choosing example syntax. Do not expose internal payload fields merely because they exist.
Related-work and usage projections must not force callers to reconstruct canonical rules.

Ranked search and a text predicate are distinct operations. Preserve existing search semantics
through a typed search operation during migration; do not replace ranking with substring matching
and claim equivalence. Whether the syntax also exposes ranked search is an explicit scope decision.

Query templates are ordinary supported query text plus bound parameters. They are examples users
can inspect and adjust, not another template language or another independently interpreted API.

## Result requirements belong in the query

Distinguish these requests:

- exact first N rows under a defined ordering;
- exact number of all matching rows;
- complete evidence and diagnostics for the selected scope;
- best available partial rows within a work budget.

An exact top-N result can sometimes be established without reading all evidence. An exact total
or exhaustive diagnostics can require further work even then. A row limit is not a scan budget.
Whether callers request an exact total belongs in the logical query. Preserve existing output
contracts until an explicit compatibility decision changes them; never populate a total with the
number of rows scanned so far.

Return generation identity, scope, coverage, freshness, and diagnostics alongside rows. Distinguish
an exact top-N answer over partially read evidence from an unproven partial answer. An interrupted
search cannot establish absence; a partial aggregate is not a complete total. The wire format and
surface presentation need separate review.

## Evidence required for early pruning

A capability must describe its cost, validity conditions, uncertainty behavior, and the evidence
that makes an optimization correct. Useful capabilities include logical-session inventory,
conservative scope exclusion, exact identity lookup, activity bounds, targeted detail access, and
change detection. File targeting alone proves neither cheap discovery nor bounded parsing.

For a latest query, prune before parsing only when remaining candidates cannot displace the current
N rows under the complete canonical ordering, including ties. File mtime and a native update field
are not automatically last-real-message bounds. Uncertain metadata remains a candidate. Filters,
empty sessions, delegated relationships, and cross-file evidence can change eligibility and must
participate in the proof. An explicit partial-result request permits different stopping behavior.

Risk estimation and execution must consume the same physical inventory, including supplemental
roots, companions, containers, and selected units. Revalidate evidence that changes before use.
Reuse discovery and metadata work within a preparation attempt rather than independently repeating
it for estimation and execution. A failed estimate must not be presented as a safe estimate.

The optimizer must distinguish reducing source reads, reducing parsing, and reducing retained
memory. A filter applied to already extracted container rows helps a later stage but does not bound
container extraction. Incremental reading likewise requires proof of changes, deletions, and
unchanged prefixes; otherwise rebuild the affected safe unit or source.

## Query-session lifecycle

The owner of a query session may be the CLI shell, TUI, or another client transport. Begin with
in-process ownership; transparent cross-process reuse is a later decision. Preparation, refresh,
cancel, and close are lifecycle operations, independent of the data-query syntax.

Queries bind to a generation. Refresh prepares a replacement and publishes it consistently; failure
keeps the previous usable generation and reports staleness. Detail loaded later must validate its
native locator against the expected evidence version. If that version is unavailable, report the
change or require refresh rather than silently mixing versions. This is an application-generation
guarantee, not a claim of a simultaneous native snapshot across unrelated files and databases.

An idle timeout starts only with no active request or pending result delivery. Active-query and
slow-client deadlines are separate budgets. Explicit close releases ownership; pinned generations
need bounded lifetimes. Do not promise both arbitrary retention and predictable memory release.

The budget includes inventory, parser intermediates, hot rows, query workspaces, output buffers,
detail caches, overlapping generations, and child processes. Large logical sessions need their own
bounded processing or refusal path. Decide whether to defer refresh, release readers, or decline
new work when replacement cannot fit; do not assume atomic replacement is free.

## Evidence needed before implementation

Prepare a small set of representative journeys covering latest, combined filters, repeated reads,
detail, related work, usage, refresh, scope changes, partial results, and exit. For each, specify the
answer, ordering, completeness, freshness, and resource expectations before optimizing it.

Then:

1. Establish discovery, preparation, query, detail, and refresh costs with private native inputs;
   retain sanitized methods and results in the research reports. Keep source capability inspection
   separate from proven native behavior and from unmeasured hypotheses.
2. Define the minimum logical query model independently of grammar and storage. Resolve exact
   totals, coverage, text semantics, and field availability before committing to syntax.
3. Use sanitized fixtures to compare optimized execution with a simple complete reference path.
   Include misleading mtimes, ties, split sessions, changing cwd, absent metadata, late-discovered
   parents, duplicate titles, empty sessions, missing detail, and multi-session containers. Assert
   work avoided as well as answer equivalence and the existing projection contract.
4. Review the proposed syntax, command mapping, lifecycle behavior, and result envelope before
   editing surfaces. Preserve legacy command behavior through an explicit migration path.
5. Implement one useful plan at a time. Demonstrate a real benefit before generalizing the planner
   or adding a new adapter capability. Use bounded artifact journeys for lifecycle checks; reserve
   stress profiles for enforced isolation rather than a developer's native history.

Remaining decisions include the dialect/parser, exact public fields, text matching and ranked
search exposure, count defaults, cache admission, cancellation, and generation pinning. These are
deliberate decision points, not permission to expose the entire parser's feature set by accident.
