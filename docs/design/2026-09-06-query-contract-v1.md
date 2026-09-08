# Query contract v1 — approved direction A

Status: direction A approved on 2026-09-06, with one shared implementation required; M2–M3 implemented and validated, including final artifact gates. This document
resolves the first delivery's public choices. [PLAN.md](../../PLAN.md) owns its remaining work.
It supersedes broader syntax and sequencing suggestions in the earlier design notes for M1–M3.

## Approved direction

Borrow a finite PostgreSQL `SELECT` syntax, parsed by **`pgsql-ast-parser` 12.0.2**, and execute a
validated logical query against canonical history. No PostgreSQL server, SQL storage engine,
persistent index, or new history store is introduced. The
[two-candidate experiment](../research/2026-09-06-query-parser-selection.md) supports this choice.

The approved interaction direction, **A**, extends the existing `query` and `shell` entries.
Existing commands and v2 JSON retain their behavior. SQL returns selected public columns as JSON.
The user approved A and clarified that compatibility means preserving observable behavior,
not retaining the old implementation. Old commands, v2 input, SQL, and templates converge on
one logical query and executor. Remove replaced filtering, ordering, and pagination paths;
version-specific input decoding and rendering are thin boundary adapters. A legacy executor,
feature flag, dual-run production path, or fallback to old command semantics is not acceptable.

```sh
cchistory-lite query --sql 'SELECT id, title, last_message_at FROM sessions WHERE is_top_level = TRUE AND turn_count > 0 ORDER BY last_message_at DESC NULLS LAST LIMIT $1' --params '[10]'
cchistory-lite query --sql-file latest-sessions.sql --params '[10]'
cchistory-lite shell --idle-timeout 300
```

The same SQL can be entered as one complete line in the existing human shell. Existing `latest`,
`ls`, `search`, `show`, `refresh`, `exit`, and `quit` remain available. There is no multiline editor,
SQL prompt redesign, TUI view, or saved-template registry in this delivery. Templates are ordinary
editable `.sql` files shipped with the documentation; JSON arrays supply values, never SQL fragments.

Two choices are particularly consequential:

- `LIMIT` bounds returned rows, not scan work. New SQL omits an exact total by default;
  `--complete` requests an exact total and exhaustive diagnostics. Existing `latest` still asks
  for its exact total, so it retains the complete path when that total cannot be proven cheaply.
- A shell prepares once and reuses that snapshot. It closes after **300 seconds of idle time**,
  or explicitly. `--idle-timeout 0` disables expiry. This changes existing idle behavior and is
  part of the interaction approval, not an invisible implementation change.

## Collections and fields

`sessions` contains every addressable resolved session in the prepared scope, including empty
sessions and delegated children. `is_top_level` makes the existing browser eligibility explicit:
a child with a resolving, different parent is false; orphan work remains true. Latest/list
templates request top-level rows. Querying all sessions does not change top-level browser trees.

`turns` contains all resolved turns, including delegated work on its own child session. Each
turn retains its canonical project identity. A session can span projects; directory equality is
not project equality. Scope is fixed by the existing CLI source/directory options or shell opening
scope; predicates cannot widen it. M2 evaluates filters over that scope's complete snapshot and
does not promise that a `source_platform` predicate avoids reading other selected sources.

The tables below are also the ordered expansion of `*`. IDs are complete canonical identifiers;
there is no prefix, fuzzy-title, or cwd substitution in equality predicates.

| Session field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Canonical session ID |
| `source_id` | string | Canonical source instance ID |
| `source_platform` | string | Registered platform identifier |
| `title` | string or null | Canonical masked title; no raw-title fallback |
| `created_at` | timestamp | Canonical session creation time |
| `last_message_at` | timestamp or null | Latest real-message activity from the canonical turn index |
| `turn_count` | number | Canonical count of this session's turns |
| `is_top_level` | boolean | Canonical top-level session eligibility |
| `primary_project_id` | string or null | Canonical primary project; not every project used by the session |
| `working_directory` | string or null | Canonical session working directory |
| `model` | string or null | Session's model metadata, not a family aggregate |
| `total_tokens` | number or null | Canonical option-B total for this session's own turns |

| Turn field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Canonical turn ID |
| `session_id` | string | Owning session ID, including a child session |
| `source_id` | string | Owning source instance ID |
| `source_platform` | string | Owning source platform |
| `project_id` | string or null | This turn's canonical project link |
| `submitted_at` | timestamp | Canonical `submission_started_at` |
| `last_message_at` | timestamp | Canonical `last_context_activity_at` |
| `text` | string | Canonical masked user text |
| `model` | string or null | Context summary's primary model |
| `total_tokens` | number or null | `resolveTurnUsage` option-B total |
| `has_errors` | boolean | Existing assistant-stop error summary; not all native tool errors |
| `link_state` | string | `committed`, `candidate`, or `unlinked` |

Missing values are emitted as JSON `null`, not omitted or replaced with zero. Session token totals
sum available canonical turn totals; a numeric sum does not certify complete native token
reporting. No known values yields null. Children are not added to their parent's own total.
Existing evidence gaps remain visible as limitations; this frontend does not fix deferred D5.

`last_message_at` must use `buildSessionLastMessageIndex` directly: the current convenience
`getSessionActivityAt` falls back to native `updated_at` for empty sessions. New SQL does not call
that fallback a real message. Existing JSON fields retain their current meanings.

## Syntax and value semantics

One statement, one collection, explicit limit:

```sql
SELECT id, session_id, project_id
FROM turns
WHERE project_id = $1 AND submitted_at >= $2
ORDER BY submitted_at DESC
LIMIT 10;
```

Supported syntax is PostgreSQL-shaped, not a claim of PostgreSQL execution compatibility:

| Construct | Accepted subset |
| --- | --- |
| Projection | Bare public fields, or `*` alone; no duplicate fields or aliases |
| Source | Exactly `sessions` or `turns`; no aliases or qualified names |
| Conditions | `AND`, `OR`, `NOT`, parentheses; a public field compared with a literal or parameter |
| Comparisons | `=`, `!=`, `<>`; `<`, `<=`, `>`, `>=` for numbers and timestamps |
| Membership/range | `IN`, `NOT IN` with a finite value list; `BETWEEN`, `NOT BETWEEN` for numbers/timestamps |
| Missing values | `IS NULL`, `IS NOT NULL` |
| Text patterns | `LIKE`, `NOT LIKE`, case-sensitive, applied to strings |
| Ordering | Up to three distinct public fields, `ASC`/`DESC`, optional `NULLS FIRST`/`LAST` |
| Page | Required `LIMIT` integer 1–1000; optional `OFFSET` integer 0–100000; literals or bound integers |
| Parameters | Positional `$1`…`$N`, bound from a JSON scalar array |

No joins, subqueries, CTEs, aggregates, grouping, functions, expressions in projections, casts,
arithmetic, `DISTINCT`, set operations, mutations, locking, regex, `ILIKE`, or custom `ESCAPE`
clauses. Unrecognized AST properties and nodes are rejected, even if the parser accepts them.
SQL comments and a trailing semicolon are allowed; the entire input is parsed and must yield
exactly one statement. Never use `parseFirst` and ignore a suffix.

Unquoted names fold to lowercase; quoted identifiers match exactly. Literals are strings,
finite numbers, booleans, and null. Bindings are values, not identifiers or lists to interpolate.
Referenced parameter numbers must be contiguous from 1 and the array must contain exactly that
many entries, at most 32. An omitted array means `[]`. Repeated references are allowed if their
required types agree. There is no implicit string-to-number or boolean coercion.

Timestamp operands accept full RFC3339 strings with a timezone and at most millisecond precision,
then compare normalized UTC milliseconds. Reject timezone-free values, invalid calendar dates,
leap seconds, and invalid offsets. Outputs use UTC ISO strings with milliseconds. Timestamp
conversion is determined by the field type, not applied to arbitrary text.

Null follows three-valued logic: comparisons to null yield unknown, `NOT unknown` remains unknown,
and `WHERE` retains only true. In particular, `x = NULL` matches nothing and `NOT IN (..., NULL)`
does not mean “everything else.” These familiar rules follow
[PostgreSQL's comparison semantics](https://www.postgresql.org/docs/current/functions-comparison.html).

Text equality is exact and case-sensitive. Explicit string ordering compares Unicode code points,
independent of host locale. `LIKE` matches the whole string: `%` is zero or more code points, `_`
is one code point, and a backslash escapes the next pattern character; a dangling escape is an
invalid value. Ordinary SQL string quoting uses doubled single quotes. Literal backslashes in
patterns must survive JSON/shell escaping; bound parameters are preferred. Match masked canonical
text, not raw history or a truncated display preview. Ranked `search` remains a separate operation.
The limited pattern choice borrows the familiar
[PostgreSQL LIKE form](https://www.postgresql.org/docs/current/functions-matching.html), without
locale-dependent case folding or the parser's unsupported custom `ESCAPE` clause.

Without `ORDER BY`, use the existing canonical collection order. Explicit ordering uses the given
keys and then canonical order for ties. Default null placement follows PostgreSQL: ASC puts nulls
last, DESC puts nulls first. The latest template explicitly specifies `NULLS LAST`. Canonical
session order puts real-message sessions first, then compares message recency, creation time,
and ID; empty sessions retain their existing metadata/creation/ID order at the end. Canonical
turn order compares submission time, creation time, then ID. Pagination happens after filtering
and ordering. These ties are not arrival order or a new CLI sorting rule.

## Input bounds and failure behavior

The v1 policy limits are 16 KiB UTF-8 SQL, 16 KiB serialized parameters, 32 bindings, 32 values in
one `IN` list, 64 predicate leaves, and eight levels of Boolean operators along any AST path.
The total v3 request is capped at 1 MiB and 16 operations. These are explicit product bounds,
not measurements of machine capacity. Parentheses alone do not increase AST depth.

Parse in an isolated worker with a one-second execution deadline after worker readiness; admit
one parse job at a time. Terminate the worker on timeout. Byte bounds are checked before parsing,
then a positive AST allowlist, field/type checks, and expression bounds produce a typed logical
query. This avoids relying on a depth check that only runs after an unbounded synchronous parse.
No parser worker receives history or native file access. No `eval` or generated executable code.

Validate every operation in a new batch before any source estimation, discovery, or scan. On
invalid input, return `invalid_query_request` with operation ID when known and a reason:
`syntax`, `unsupported`, `field`, `parameter`, `type`, or `budget`. Invalid bound values are
`parameter`; mismatched operand types are `type`. Errors in a shell request do not close it.
Preparation failures preserve the existing scan-guard/error behavior; a refused or failed scan
must not become a successful empty result. The zero-read rejection guarantee concerns reads
caused by that request; an already-open shell has performed its initial preparation.

## Entry points, requests, and results

`query` accepts exactly one of `--request <file|->`, `--sql <text>`, or `--sql-file <file|->`.
`--params <JSON-array>` and `--complete` apply to the two SQL forms only. Existing v2 request
files continue to work. New v3 files contain SQL operations only; v2 commands need not be
migrated. Reject unknown envelope/operation keys and duplicate or empty operation IDs.

```json
{
  "schema": "cchistory-lite-query/v3",
  "operations": [{
    "id": "recent",
    "kind": "sql",
    "sql": "SELECT id FROM sessions WHERE is_top_level = TRUE LIMIT $1",
    "params": [10],
    "complete": false
  }]
}
```

`params` defaults to `[]` and `complete` to false. Direct CLI SQL and human-shell SQL become one
operation with ID `query`. JSON-lines shell accepts the v3 envelope or one SQL operation;
existing v2 operations and refresh/exit control lines keep their current forms. Human-shell SQL
has no separate parameter-setting state; use literals there and bound templates through CLI or
JSON-lines. SQL results use the new JSON envelope in all three entry points.

The proposed result envelope has `schema: cchistory-lite-query-result/v3`, `kind: query_result`,
the existing `content_trust` declaration, `read`, `operations`, `projection_issues`, and
`diagnostics`. `read` contains an opaque process-local `id`, `prepared_at`, and
`scope: {directory, source_ids}`. A warm shell reuses the ID; successful refresh replaces it.
This is an execution identity, not a native atomic transaction, persistent handle, or a promise
that existing late-detail reads come from the same generation.

Each successful operation contains `id`, `kind: sql`, `status: ok`, and `result`:

| Result field | Contract |
| --- | --- |
| `columns` | Selected fields in order, each `{name, type, nullable}`; types are string/number/boolean/timestamp |
| `rows` | Objects containing exactly those fields; missing selected values are explicit null |
| `shown`, `limit`, `offset` | Returned row count and resolved paging values |
| `total` | Null when not requested; otherwise exact matching count before limit/offset |
| `coverage.execution` | `complete` or `selective`, the plan actually executed |
| `coverage.rows` | `exact`: same selected rows as complete canonical reference execution in this scope |
| `coverage.diagnostics` | `complete` for all planned evidence, or `observed` for inspected evidence only |

`diagnostics` retains source statuses and loss audits in their existing canonical shapes
(`sources` from `snapshot.data.sources`, and `loss_audits`); `projection_issues` retains the audit output. Errors and losses
are observable, non-fatal evidence where the existing pipeline treats them that way. “Complete”
means the complete reference path ran over the declared scope; it does not claim corrupt or
unreadable source data was understood. A subset with no observed issues cannot claim there are
no issues in unseen evidence.

M2 established complete execution; M3 adds the narrow one-shot plan specified below. `total`
stays null unless requested. `complete: true` requires both an
exact total and exhaustive diagnostics. All operations in a batch use one complete snapshot;
M3 does not optimize mixed batches. A selective one-shot read never enters the shell's complete
`LiveHistorySnapshot` cache. Partial results must not masquerade as a complete projection.

## Shared templates and compatibility

These selections become named internal template builders. Migration is complete only when
the old selection implementations have been removed from CLI, shell, and v2 execution. The shipped SQL files express the
same logical queries. Commands use the builders directly rather than serialize values into SQL.

| Existing operation | Shared selection | Legacy requirements |
| --- | --- | --- |
| `latest sessions N`, v2 latest sessions | `sessions`, top-level and nonempty, last-message DESC NULLS LAST, limit N | Exact total and current enriched summary |
| `latest turns N`, v2 latest turns | `turns`, submission DESC, limit N | Exact total and current enriched summary |
| `ls sessions`, v2 list sessions | `sessions`, top-level including empty, last-message DESC NULLS LAST, limit/offset | Exact total and current enriched summary |

Command/query parity means identical ordered canonical IDs and equal shared field values for the
same scope and page. Legacy output can contain additional summary fields. Existing limits/defaults
remain valid even where old commands accept values outside the new SQL input cap; trusted command
builders validate their existing contract. The SQL parser is not the mandatory entry for all APIs.
Search ranking, detail, projects, families, and stats keep their current operations in this slice.

The latest-sessions SQL is the first example in this document. The list template is:

```sql
SELECT id FROM sessions
WHERE is_top_level = TRUE
ORDER BY last_message_at DESC NULLS LAST
LIMIT $1 OFFSET $2;
```

## Shell ownership and expiry

Startup prepares one complete snapshot. Collection queries reuse it; explicit refresh prepares
a full replacement and publishes it only on success. Failed refresh emits the existing error
and leaves the previous snapshot usable. Existing refresh control replies remain compatible;
the next SQL result exposes the unchanged or replaced read ID. Native changes are not watched.
Existing detail commands still perform their documented fresh targeted reads.

`--idle-timeout` accepts whole seconds 0–86400, default 300, for human and JSON-lines shells.
Idle means waiting for input with no accepted queued request, active query, refresh, or pending
output. Arm the timer after initial preparation and after work/output finishes. Input activity,
including a partial line, resets it; query work and pending output suspend it. A shell transport
line above 1 MiB closes input with a budget error; ordinary invalid queries leave the shell open. Do not
expire an active query because its execution took longer than the idle interval.

Exit/quit stops accepting later commands. EOF finishes already accepted requests in order and
then closes. Idle close behaves like EOF and adds no unsolicited JSON result; a human terminal
can receive a short expiry notice on stderr. All close paths release readline, timer, parser
worker, and snapshot ownership. Process exit status retains existing shell error behavior.

## Implementation ownership and release closure

- `domain`: query/value/coverage types, without parser or I/O dependencies.
- `canonical`: public field projections, eligibility, usage, filter/order/page evaluation, and
  shared command selection builders. SQL adds no competing definition of history semantics.
- `live-runtime`: parser worker, AST validation/lowering, scope preparation, execution requirements,
  complete/selective plan dispatch, and in-memory read identity. It invokes canonical semantics.
- CLI: input routing, compatible rendering, and shell lifetime. Adapters retain the parse boundary.

No new package or general engine is required. Parser validation yields a finite typed predicate
tree and selection plan; the reference executor evaluates that over existing canonical rows.
The release builder currently vendors internal packages without their external dependencies.
M2 must ship the pinned parser's resolved runtime closure and license files, and verify SQL from
an extracted artifact with no workspace dependency fallback. This is part of M2 completion.

## Eight acceptance journeys and the stopping boundary

The hand-authored [review oracle](../../mock_data/fixtures/query-contract/review.json) is the
fixed M1 corpus: six sessions, six turns, 13 positive queries, 17 concrete rejection cases,
three generated budget cases, and lifecycle events. It is not native history or a running query
implementation. Both parser candidates parse all 13 positive queries. Runtime semantics,
zero-read rejection, and lifecycle assertions passed in
[M2 acceptance](../research/2026-09-06-shared-query-execution.md).

| Journey | Concrete fixture result |
| --- | --- |
| Q1 latest ten | `latest_sessions`: s2, s1, s3, s6; exclude newer delegated s4 and empty s5; deterministic s2/s1 tie |
| Q2 source and time | `source_time`, codex and [Apr 13, Apr 16): s2, s1, s6 |
| Q3 project and time | `project_time`, project-one since Apr 15: t5, t3, t1; child t5 stays on s4; shared cwd does not admit project-two |
| Q4 fields/parameters/null | `projection_null`: s6 with explicit null model/project; `bound_text`: s3; null equality, null-bearing NOT IN, and injected-looking bound text: no rows |
| Q5 template parity | `list_sessions`: s2, s1, s3, s6, s5; `latest_turns`: t5, t3, t1, t2, t4, t6; commands use the same ordered selections |
| Q6 reject before reads | Mutations, extra statements, joins, functions, unknown fields, bad parameters/dates and budgets: explicit rejection, zero request-triggered native reads |
| Q7 reuse/refresh | Two warm reads share g1; successful refresh publishes g2; failed refresh retains g2; three scan attempts, two successful preparations |
| Q8 expiry/close | Ready at 0: open at 299, closed at 300; work started at 299 and completed at 601 expires at 901; exit/EOF and disabled expiry also covered |

M3 targets **Codex only**, with one SQL operation matching the published latest-sessions template:
`id, title, last_message_at`, top-level/nonempty predicates, canonical recency, limit, zero offset,
no exact total, no exhaustive diagnostics, no additional filters. Use the existing source scope
option to select Codex. Warm shells already own complete data and need no selective scan.

Eligibility, cross-file grouping, real activity, and ties need conservative evidence before a
unit can be skipped. Unknown event shapes, uncertain bounds, changed evidence, split sessions,
and unresolved delegation must enlarge the read or fall back. File mtime is not a proof of
message recency. Reading/decoding every transcript to calculate bounds may avoid interpretation;
it is not avoided source I/O. Count those phases separately against complete execution.

The [M3 implementation report](../research/2026-09-06-selective-latest.md) records exact parity,
work counters, conditional cost savings, and the conservative fallback rules. The M1 requirement
was to demonstrate exact parity and useful avoided work
for the one shape, or report a no-go and request a concrete reduced-scope decision. It does not
automatically become an all-source optimizer. After reviewed M1, implemented M2, and accepted
M3 plus release gates, this delivery ends; PLAN's deferred items remain deferred.
