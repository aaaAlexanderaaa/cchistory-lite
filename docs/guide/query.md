# Querying history with SQL

Use a finite PostgreSQL-style SELECT to combine conditions over canonical history. `sessions`
contains every addressable session, including empty sessions and delegated children. `turns`
contains every resolved turn, including a child's work on its own session. The source and directory
options establish the scope; SQL filters that scope. The default directory is the current directory.

```sh
cchistory-lite query --sql 'SELECT id, title, last_message_at FROM sessions WHERE is_top_level = TRUE AND turn_count > 0 ORDER BY last_message_at DESC NULLS LAST LIMIT $1' --params '[10]'
cchistory-lite query --sql 'SELECT id, session_id, text FROM turns WHERE project_id = $1 AND submitted_at >= $2 ORDER BY submitted_at DESC LIMIT 10' --params '["project-id", "2026-04-15T00:00:00Z"]'
```

Use complete canonical IDs for equality. A project can share a working directory with another
project, and a session can contain turns from several projects. `primary_project_id` on a session
is not an exhaustive list of its projects. `is_top_level` uses the same child eligibility as the
existing browser: a delegated child with a resolving parent is false; orphan work remains visible.

## Templates and values

[Latest sessions](queries/latest-sessions.sql), [list sessions](queries/list-sessions.sql), and
[latest turns](queries/latest-turns.sql) are ordinary editable SQL files. After saving a template:

```sh
cchistory-lite query --sql-file latest-sessions.sql --params '[10]'
cchistory-lite query --sql-file list-sessions.sql --params '[20, 0]'
```

Choose exactly one of `--sql`, `--sql-file`, and `--request`. A file argument of `-` reads stdin.
`--params` is a JSON array of values for `$1` through `$N`. Bindings must match those contiguous
positions exactly; reuse a position where its type is the same. Values are strings, finite
numbers, booleans, or null. Array/object values and identifier substitution are unsupported.

## Fields

`SELECT *` expands to the following public fields. Selecting named fields preserves their order.
Missing selected values are explicit JSON nulls. Text and titles are canonical masked content.

| Collection | Fields |
| --- | --- |
| sessions | `id`, `source_id`, `source_platform`, `title`, `created_at`, `last_message_at`, `turn_count`, `is_top_level`, `primary_project_id`, `working_directory`, `model`, `total_tokens` |
| turns | `id`, `session_id`, `source_id`, `source_platform`, `project_id`, `submitted_at`, `last_message_at`, `text`, `model`, `total_tokens`, `has_errors`, `link_state` |

Timestamps are RFC3339 strings with a timezone, accepting up to millisecond precision and returning
normalized UTC values. `submitted_at` is submission recency; `last_message_at` is real-message
activity. An empty session has null `last_message_at` even if its file metadata is recent.
`created_at` is canonical session creation time.

`turn_count` and `total_tokens` are numbers. Token totals use canonical option-B accounting:
session totals sum available values for their own turns, without adding child totals. A total
of null means no known value; a numeric value does not certify complete native reporting.
`is_top_level` and `has_errors` are booleans. `has_errors` follows the existing assistant-stop
summary, not every native tool error. The other fields are strings, with null for unavailable
session title/model/directory/project, turn model/project, and token values. `link_state` is
`committed`, `candidate`, or `unlinked`.

## Supported conditions and bounds

A query selects one collection and requires `LIMIT` from 1 to 1000. `OFFSET` is optional, from
0 to 100000. Both accept integer bindings. Use up to three `ORDER BY` fields with ASC/DESC and
NULLS FIRST/LAST. Without explicit order, canonical order applies; ties also use canonical order.
ASC defaults to nulls last, DESC to nulls first. Latest templates explicitly use NULLS LAST.

Combine field-to-value comparisons with AND, OR, NOT, and parentheses. Equality (`=`, `!=`, `<>`),
IN/NOT IN, and IS NULL/IS NOT NULL work with typed scalar values. Numeric and timestamp fields
also support `<`, `<=`, `>`, `>=`, BETWEEN, and NOT BETWEEN. There is no implicit string/number
conversion. Quoted identifiers match exactly; unquoted names fold to lowercase.

LIKE/NOT LIKE matches a whole string, case-sensitively: `%` matches any sequence, `_` one Unicode
code point, and backslash escapes the next pattern character. Prefer bindings to avoid shell/JSON
escaping mistakes. Ranked `search` remains available separately. Regex, ILIKE, and custom ESCAPE
clauses are unsupported.

Null has SQL three-valued semantics: `x = NULL` matches nothing; use `x IS NULL`. `NOT IN` with
null also produces unknown for nonmatching values, which WHERE excludes. Explicit string ordering
compares Unicode code points independent of locale.

There are no joins, subqueries, aliases, aggregates, functions, casts, arithmetic, grouping, CTEs,
set operations, mutations, or locking. Input is limited to 16 KiB SQL and 16 KiB parameters,
32 bindings, 32 IN values, 64 predicate leaves, and eight Boolean operator levels. A v3 batch is
at most 1 MiB and 16 operations. Comments and one trailing semicolon are accepted; extra statements
are rejected. Syntax, field, type, parameter, and budget errors fail before native reads for the
request. Invalid SQL does not become an empty result.

## Results and complete reads

SQL returns `cchistory-lite-query-result/v3` JSON. Each operation provides selected columns and
rows, shown/limit/offset, total, and coverage. **LIMIT bounds rows, not scan work.** A single
Codex latest-sessions template can skip full interpretation of older sessions after checking
native timestamp bounds. It still reads and decodes all admitted files to establish those bounds.
Selected rows match the complete reference executor.

This optimization applies to one SQL operation selecting `id, title, last_message_at`, with the
template's top-level/nonempty predicate and descending activity order, offset zero, and no
`--complete`. Select Codex with `--source codex`. Changed fields or predicates, other/multiple
sources, and multi-operation batches use complete reads. Unknown record shapes, uncertain time or
identity evidence, and possible delegated work also use complete reads. A changed admitted file
invalidates the attempt and requires a new read. File mtime is never a conversation-time bound.
This is a conditional reduction in interpretation work; small inputs can be slower.

By default `total` is null, including when the complete path happens to know the count. Pass
`--complete` to request the exact matching total before pagination and exhaustive diagnostics.
Existing commands such as `latest` retain their original totals and output. Their collection
selection uses the same mechanism as SQL.

`coverage.execution` reports complete/selective; `coverage.rows` reports exact rows relative to
the complete canonical reference. `coverage.diagnostics` distinguishes complete evidence from
observed evidence only. Source statuses, loss audits, and projection issues remain visible.
Complete execution does not mean corrupt or unreadable native data was understood.

## Reusing a shell or batching requests

```sh
cchistory-lite shell --idle-timeout 300
```

Enter SQL as one complete line, or use existing commands such as latest, ls, show, search, refresh,
and exit. SQL returns JSON; existing commands retain their presentation. The human shell has no
parameter-setting state; use literals there and bound parameters with CLI templates or JSON-lines.

For `shell --json`, send a SQL operation per line or a whole v3 batch:

```json
{"kind":"sql","sql":"SELECT id FROM sessions WHERE is_top_level = TRUE LIMIT $1","params":[10]}
{"kind":"refresh"}
{"kind":"exit"}
```

Batch requests for `query --request` have this shape:

```json
{
  "schema": "cchistory-lite-query/v3",
  "operations": [{
    "id": "recent",
    "kind": "sql",
    "sql": "SELECT id FROM sessions LIMIT $1",
    "params": [10],
    "complete": false
  }]
}
```

All operations are validated before one shared scan. Existing v2 operation requests remain valid.
A shell opens without scanning; it prepares on its first valid collection read or explicit
refresh. Help, invalid requests and cold exit do not scan. A warm shell reuses its SQL `read.id`; successful refresh replaces it, failed refresh reports an
error and preserves the old snapshot. The ID is process-local, not a native transaction or a
handle for existing detail rescans. Native changes require explicit refresh.

Idle expiry defaults to 300 seconds; `--idle-timeout 0` disables it, with positive values up to
86400. The timer runs only while waiting for input; partial input resets it and active work suspends
it. Exit closes explicitly, EOF finishes accepted requests then closes, and idle expiry closes
without adding a JSON result. Shell lines larger than 1 MiB close the input with a budget error.
EOF/expiry releases snapshot, parser, timer, and input ownership. No history is persisted.
