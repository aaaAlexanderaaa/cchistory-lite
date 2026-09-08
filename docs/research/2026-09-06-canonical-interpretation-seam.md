# Canonical interpretation seam: verification record

This records the uncommitted implementation stage after the semantic/detail contract, based on
commit `2a36d1e` and version 0.4.4. It is a structural equivalence check on sanitized fixtures,
not a new native-history performance measurement. No real history was read for this check.

## Change and reference

Runtime now supplies `interpretSessionEvidence` from canonical to the adapter collector. The
entry receives reconciled session evidence and performs the existing submission, project,
turn/session, usage-association, and complete-context interpretation. The adapter collector
retains native reconciliation and source diagnostics. Shared pure value operations have one
implementation in domain; no sibling imports or additional production dependencies were added.

Before moving the algorithms, a private harness retained complete `LiveHistorySnapshot.data`
values for the fixture matrix. After the move, the same harness compared complete values using
the same source roots and identities. Temporary databases were reused rather than regenerated
between comparisons. Host identity and observation time were fixed; native timestamps were
preserved. All 16 snapshots were deeply equal, totaling 35 turns and 52 assistant replies.

The checked-in runtime matrix independently compares `full`, `none`, and `matching` retention:
source counts, ordered sessions/turns/projects, related work, family contributions, questions,
diagnostics, usage dimensions, search hits, and retained complete contexts. Its platform set must
equal the registered adapter set, and each source must produce both a turn and assistant evidence.
Projection audits report zero issues for all modes and sources.

New hand-authored cases fill the former Gemini, OpenClaw, Antigravity, LobeChat, Kimi, and ZCode
coverage gaps. Kimi/Gemini native layouts and ZCode SQLite state are assembled from repository
fixtures in temporary roots and removed after tests. Canonical tests use frozen parsed evidence
and explicit expected values for repeated interpretation, submission edges, usage, activity,
tool correspondence, unanswered turns, and empty-session suppression.

## Validation

- `pnpm run build:lite`: passed.
- `pnpm test`: 607 package tests passed, followed by dependency-boundary verification.
- `pnpm run verify:governance`: passed; five rules cover 104 production rule/file matches.
- `pnpm run verify:lite-artifact`: passed, including extracted CLI and TUI execution.
- Fixture layout and content sanitization: passed, including the new evidence files.

The separate full mock-data validator still reports eight pre-existing missing Gemini paths in
`mock_data/scenarios.json`, under `.gemini/tmp/`. Its unchanged scenario check produces the same
findings at the commit anchor. The new runtime matrix uses checked-in Gemini input assembled in
scratch space and does not depend on those absent paths. This does not repair or validate those
older scenario claims. The credential scanner remains unchanged; the Claude masking fixture
contains a placeholder expanded into a known fake credential only in test scratch space.

## Limits

The new entry still constructs full detail before runtime retention filtering. No avoided read,
decode, allocation, peak-memory reduction, or capacity improvement is claimed here. A whole
reconciled session is not necessarily a bounded or independently releasable source unit.

Structural parity preserves existing behavior, including unanchored token signals when no visible
assistant reply exists, the Claude tool-result error-evidence gap, and duplicate edge multiplicity
in the legacy probe payload. These require separate expected-result changes, not silent repairs
during relocation. Frozen-input checks prevent the new entry from accumulating more edges when
called repeatedly; they do not claim that legacy edge counts were already correct.

Generation-bound detail freshness, optional detail construction, large-unit admission, retained
collection bounds, and selective-query completeness remain open. The next implementation should
separate semantic reply/tool facts from formatting within this canonical entry before introducing
the proposed query syntax. See the [current contract](../design/2026-09-05-semantic-detail-boundary.md).
