# Working in this repository

CC History Lite is a read-only pipeline: native agent history on disk in, canonical snapshot in
memory out. Everything below follows from that.

## Invariants

These are not style preferences. Breaking one is a defect regardless of what it enables.

1. **Zero-store.** Lite never creates or reads a persistent history store. No code path may open,
   write, or infer `~/.cchistory`, `cchistory.sqlite`, or a Full bundle root.
2. **Read-only against sources.** Adapters read native history and nothing else. SQLite sources
   are opened `readOnly: true`. No source root is ever written to.
3. **One-way layering.** `lite-cli`/`lite-tui` → `live-runtime` → `source-adapters`/`canonical` →
   `domain`. A lower layer must never import a higher one.
4. **Semantics live in `canonical`.** The surfaces render; they do not decide what history means.
   If a CLI or TUI file starts computing linking, ordering, ranking, or usage, it is in the wrong
   package.
5. **Adapters stop at the parse boundary.** They emit probe payloads. They do not materialize
   snapshots.
6. **No mutation surface.** There is no sync, import, backup, restore, merge, GC, or migration
   command, and adding one is a product change, not an implementation detail.

## Before you commit

```bash
pnpm run build:lite
pnpm test                      # package tests + dependency-boundary verification
pnpm run verify:governance     # architecture rule manifest + its harness
pnpm run verify:lite-artifact  # release closure builds, extracts, and runs
```

`pnpm test` is the gate. It runs every package's tests and then
`scripts/verify-lite-boundaries.mjs`, which walks the production dependency graph and rejects
forbidden dependencies at both manifest and import level.

## Adding a source adapter

1. Implement it under `packages/source-adapters/src/platforms/`.
2. Register it, with its slot id, display name, tier, and default roots.
3. Add sanitized fixtures under `mock_data/` — **never** real user history.
4. Cover it in the adapter test matrix, including the empty-root and malformed-input paths.
5. Document it in the README's source table.

An adapter is done when it reads a fixture corpus correctly *and* degrades safely on a missing,
empty, or corrupt root. Sources are other tools' private data; treat unexpected shapes as
evidence to preserve, not as an error to swallow.

## Tests

- Fixtures in `mock_data/` are the only input. A test that needs the developer's own history is
  not a test.
- Tests must not depend on wall-clock timing or filesystem case sensitivity. Both have already
  produced failures here: the incremental-append path keys on `file_modified_at`, so a test that
  appends to a file must advance its mtime explicitly rather than assume the preceding work took
  a measurable amount of time; and `.CCHistory` and `.cchistory` are the same directory on macOS
  and Windows.
- Use `mkdtemp` for scratch state and clean up in `finally`.

### Projection contract

Every change that can affect adapter payloads, canonical linking/order, snapshot materialization,
or a CLI/TUI view must preserve the canonical projection contract. The contract is checked by
`auditProjectionConsistency` and includes:

- every source, project, session, turn, and context reference resolves within the snapshot;
- declared session/project counts equal the rows projected into those buckets;
- snapshot sessions and turns retain canonical recency order;
- a turn cannot point at a project while claiming to be unlinked; and
- every resolved turn remains reachable from exactly one session bucket and one project/unlinked
  bucket in the browser model.

The live-runtime fixture matrix must assert zero projection issues for every registered source.
Surface tests must also include adversarial shapes that ordinary history rarely produces but that
break identity if handled positionally: duplicate titles, interleaved sessions, empty/turn-less
sessions, cross-project selections, and search results. A new adapter is incomplete until its
sanitized fixture participates in that matrix; do not rely on a developer's personal history to
prove the projection.

Projection issues are non-fatal evidence, not permission to silently repair or drop source data.
Keep them on the in-memory snapshot, expose them in every read-only surface, and add a regression
test for each issue shape. If the contract changes, update the audit, fixture matrix, and this
section in the same change.

## Architecture rules

`architecture-rules.json` declares the forbidden-import rules; `verify-architecture-boundaries.mjs`
enforces them. A rule that matches zero production files fails as a *vacuous rule* — so if you
remove a package, remove or retarget its rule rather than leaving a dead one behind.
