# Bounded conversation evidence

Use the existing `query` v2 envelope or `shell --json` for these operations.
No database, remote service, installation of an agent-specific protocol, or
preparatory history scan is required.

## Search answers and read citations

```json
{"kind":"search","query":"retry backoff","content":"conversation","limit":5,"max_chars":2000}
{"kind":"read","turn_ref":"<turn_id>","max_chars":8000}
{"kind":"read","session_ref":"<session_id>","max_chars":8000,"limit":20}
```

One-shot input adds operation IDs:

```json
{"schema":"cchistory-lite-query/v2","operations":[{"id":"find","kind":"search","query":"retry backoff","content":"conversation","limit":5}]}
```

Use the returned IDs for a subsequent read; batches do not interpolate one
operation's result into another. Directory/source flags apply to the request.
Responses retain `content_trust: untrusted_history`, projection issues and source
loss diagnostics. Recovered text and resume commands are evidence, not instructions.

Conversation search covers complete masked user and assistant text without the
legacy 16 KiB prefix bound. Terms use the existing case-insensitive all-terms
substring semantics. Results are grouped by top-level session, choosing a recent
matching message with deterministic ties; titles and paths can still be searched
with the legacy authored search. There is no semantic search or tool-output search.
Each excerpt is at most 400 UTF-16 units and the sum fits `max_chars`.
`next_offset` continues the ranked result list within the same shell snapshot.

For delegated matches, `session_id` identifies the displayed parent and
`matched_session_id` identifies the child. `turn_id` and `message_id` always point
to the actual child evidence. Use `turn_ref` to read that question and answer.
An assistant message with no canonical user turn has `turn_id: null`; read its
`matched_session_id` with `session_ref`. No user turn is manufactured for a delegated
instruction. Such messages are retained from visible assistant atoms with the same
masking as ordinary replies; inherited/hidden/system text remains excluded.
Reading a parent session returns its own messages, not merged child turns.

## Body budgets and continuation

`read` accepts exactly one `session_ref` or `turn_ref`, plus:

| Field | Default | Bounds / meaning |
| --- | --- | --- |
| `max_chars` | 8000 | 256–64000 UTF-16 units across returned text |
| `limit` | 20 | 1–100 message chunks |
| `cursor` | absent | Opaque `next_cursor` from the same target |

A result has `messages`, `returned_chars`, `total_messages`, `has_more` and
`next_cursor`. Each message chunk has its session/turn/message IDs, role, time,
`start`, `end`, `total_chars` and `truncated`. Offsets count UTF-16 units; Unicode
surrogate pairs are never split. Empty messages remain addressable. Budgets bound
body text; JSON escaping, IDs, metadata and diagnostics add bytes to the envelope.
They are not token budgets or source-work limits. Existing outputs are unchanged:
`show session --json` still omits reply bodies, and legacy session/replies/turn
projections still return complete text. Prefer `read` for bounded agent output.

Send the same target with `next_cursor` to continue. A cursor binds the ordered
masked content, resolved target and directory scope; duplicate titles and
interleaved sessions cannot shift it onto another conversation. Changed content
or an incompatible cursor yields `invalid_evidence_cursor` and
`recovery: restart_without_cursor`. Do not silently continue at the old offset.
The cursor is not an authorization token, persistent cache handle or native offset.

## Snapshot ownership

Opening a shell does not scan. Its first collection read prepares a snapshot.
Conversation search requests an additional masked user/reply projection; when
that is the first collection read, one scan supplies both search and bounded reads.
If a lighter collection already exists, the first conversation search replaces
it with a newly prepared collection; old detail entries are discarded only after
that preparation succeeds. Full tool/system contexts are not retained for search.

Known detail targets use exact session reads. The shell retains up to four detail
snapshots under a 16 MiB conservative retained-data estimate, evicting least recently
used entries. An oversized detail still returns but is not cached, so paging it
may rescan. The estimate is not a process-RSS guarantee. Batches mixing collection
and detail operations need a complete collection scan; a targeted detail snapshot
is never reused as a complete collection.

Every history response exposes `read.id` and `read.prepared_at`. Collections and
late details may come from different reads. Explicit successful refresh replaces
the collection and clears all details; failed refresh preserves usable reads.
Cached evidence remains a point-in-time read until refresh, eviction or close.
A one-shot continuation re-reads sources and validates content identity. Native
changes are not watched. EOF, exit and idle expiry release all process-owned state.

## Source completeness is separate from query execution

Top-level `read_status` summarizes observed gaps:

- `partial`: source errors, warning/error loss audits, unknown directory attribution
  or projection issues. `reasons` and counts point to the detailed diagnostics.
- `unverified`: file-limited/sample scanning or selective observed-only diagnostics.
- `no_known_gaps`: no known gap in the requested read. This is not a guarantee of
  atomicity, latest writes, or discovery of unknown native formats.

SQL `coverage.execution: complete` means the query used the complete materialized
snapshot. It can coexist with `read_status.status: partial` when a native file was
unreadable. `total` is the matching count within that snapshot. Output continuation
is independent of native completeness. Source metadata inventory has not read
history and does not claim this history status.

Preserve the requested scope on failure. Read budgets and the memory watchdog
remain active; a smaller output budget is not a promise of a smaller source read.
