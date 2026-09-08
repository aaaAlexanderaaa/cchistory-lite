# Context retention fixtures

Hand-authored native-shaped evidence, containing no real history or credentials.

The Claude sessions deliberately share a title across different workspaces. The answered session
contains a repeated message id across thinking/text chunks, a tool-only billed message before a
later reply, a trailing thinking-only billed message, a model switch, and an assistant error.
Its first turn has 32 tokens after chunk deduplication. Its next turn has a tool call with usage
but no visible reply, exercising the current unanchored-usage limitation. The other session has
an unanswered prompt. The native tool result also has `is_error: true` without an error-prefix
string; this exposes the current parser's loss of that flag independently of assistant errors.

Assistant and ordinary tool bodies contain unique paths that are absent from structured workspace
evidence, so tests can distinguish current path search from a new body-search feature. The fake
`<MASKING_TEST_CREDENTIAL>` placeholder is replaced with a known fake credential only in test
scratch space to exercise masking in full detail without weakening the credential scanner. Runtime tests compare retained-detail modes against
the same query results; these fixtures do not constitute a performance benchmark.


The retention matrix adds nonempty native-shaped Gemini, OpenClaw, Antigravity, LobeChat, Kimi,
and ZCode evidence to the established adapter fixtures. Gemini and Kimi files are copied into
native directory layouts in temporary roots; ZCode's SQL schema and rows create a temporary
SQLite database. Antigravity combines an objective with a later assistant walkthrough under the
same conversation identity. LobeChat shares a title across sessions; ZCode includes parent and
child sessions. All modes must resolve identical query projections with zero projection issues.

`canonical-evidence.json` is a hand-authored parsed-evidence fixture for the canonical entry. It
covers a user/injected submission, a leading usage signal, a reply with a tool result, and a later
unanswered submission. Its expected total is 6 tokens; the later unanchored 10-token signal retains
the documented limitation. Its evidence arrays are deeply frozen during repeat interpretation.
