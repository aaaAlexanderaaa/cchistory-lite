# Finite SQL parser selection

Date: 2026-09-06. Stage: M1 design experiment after the canonical interpretation seam.
Decision: propose `pgsql-ast-parser` **12.0.2** for the
[v1 query contract](../design/2026-09-06-query-contract-v1.md). This experiment inspected two
parsers, not database engines. No parser dependency or SQL execution has been added to production.

## Method and limits

Install the exact published packages in a disposable directory with lifecycle scripts disabled,
using Node v22.22.2. Read each installed manifest and recursively follow declared `dependencies`.
Copy those packages into a separate directory per candidate, then import and parse from an ESM
entry without repository dependency resolution. Count all installed regular-file bytes in that
closure, including source, maps, documentation, and metadata. Both isolated probes produced one
SELECT AST and exited successfully.

The first install attempt failed because the restricted process could not reach its configured
proxy. A subsequently approved public-registry install succeeded. No package manifest, lockfile,
native history, or source root was changed by these installs. The successful runs used no private
data; temporary paths, install logs, and machine-specific harnesses remain outside the repository.

First try eight syntax shapes: projections, source/time bindings, project/time bindings, null
checks, LIKE with IN and offset, NOT/OR/inequality, BETWEEN, and quoted identifiers. Then parse all
13 positive SQL statements in the checked-in
[review oracle](../../mock_data/fixtures/query-contract/review.json), asserting a single SELECT
AST per input. The latter is the fixed acceptance input for M2, not a production conformance test.

No startup latency, query execution latency, peak RSS, compressed artifact size, native read
performance, or parser adversarial-complexity guarantee was measured. Installing a declared
dependency closure is not proof that the existing release builder includes it.

## Observations

| Observation | pgsql-ast-parser 12.0.2 | node-sql-parser 5.4.0 |
| --- | ---: | ---: |
| Initial syntax cases parsed | 8 / 8 | 8 / 8 |
| Review-oracle positive cases parsed | 13 / 13 | 13 / 13 |
| Isolated ESM import and SELECT | Passed | Passed, PostgreSQL-specific entry |
| Package license | MIT | Apache-2.0 |
| Own installed bytes | 1,715,138 | 92,373,153 |
| Declared dependency closure, including package | 8 packages | 3 packages |
| Closure installed bytes | 1,979,398 | 92,557,270 |

These byte counts are uncompressed installed files, **not memory consumption**. The second parser
was used through its PostgreSQL entry, but its published package also includes other dialects
and assets. A custom pruned bundle could be smaller; no such bundle was built. Selecting a small
existing distribution avoids making that custom packaging another prerequisite.

The first parser's resolved closure was: `pgsql-ast-parser` 12.0.2 (MIT), `moo` 0.5.3 (BSD-3-Clause),
`nearley` 2.20.1 (MIT), `commander` 2.20.3 (MIT), `railroad-diagrams` 1.0.0 (CC0-1.0), `randexp`
0.4.6 (MIT), `discontinuous-range` 1.0.0 (MIT), and `ret` 0.1.15 (MIT). The second closure was
`node-sql-parser` 5.4.0 (Apache-2.0), `@types/pegjs` 0.10.6 (MIT), and `big-integer` 1.6.52
(Unlicense). These are published-manifest/resolution observations, not a license audit or a
claim that each dependency is needed on every parse path. M2 must pin the resolution and retain
the actual license files in the release closure.

`pgsql-ast-parser` provides a typed PostgreSQL AST and an API for parsing the complete input.
Its AST directly distinguishes references, parameters, comparisons, Boolean operations, lists,
ordering, and limits. That is a suitable boundary for the small logical model; parser acceptance
alone is intentionally broader than the product. See its
[upstream API](https://github.com/oguimbal/pgsql-ast-parser) and
[AST types](https://github.com/oguimbal/pgsql-ast-parser/blob/master/src/syntax/ast.ts).
The alternative also supports a dedicated PostgreSQL parser; its broader supported dialects
are useful capabilities but not required for this delivery. See the
[node-sql-parser documentation](https://github.com/taozhi8833998/node-sql-parser).

Direct negative-shape probes found that `pgsql-ast-parser` accepts DELETE, multiple statements,
COUNT, SELECT FOR UPDATE, and ILIKE. The contract must reject all five independently of parsing.
`LIKE ... ESCAPE '!'` fails in this parser version, so v1 excludes a custom escape clause.
`IS DISTINCT FROM` also fails at parsing and is recorded as a syntax rejection in the oracle.
`NOT LIKE`, `NOT BETWEEN`, `NOT IN`, and quoted identifiers have usable AST representations;
`<>` is normalized to `!=`. No handwritten SQL grammar is needed to lower these nodes.

## Decision and follow-through

Choose `pgsql-ast-parser` for its direct typed AST and the smaller measured package closure.
Keep the public contract narrower than its grammar through a positive validator. Parse the
whole input; never use a first-statement API to bypass trailing input. Validate names, flags,
types, bindings, Boolean depth, and operation counts before preparing native sources. Use a
bounded parser worker so post-parse checks do not serve as the only execution bound.

The existing `scripts/build-lite-artifact.mjs` vendors four workspace packages and writes
manifests without external dependencies. Consequently the isolated import success above does
**not** certify the release artifact. M2 must include the pinned closure and licenses, and test
the extracted artifact's SQL path. This is one explicit completion condition inside M2, not a
new packaging research milestone.

The review corpus also specifies expected selected IDs/nulls, unsupported-input rejections, and
refresh/expiry events. Parsing its positive inputs does not test those semantics, zero native
reads on rejection, command parity, or timers. Those remain the fixed implementation acceptance
journeys in [PLAN.md](../../PLAN.md). No further parser survey is queued.

M1 document/fixture checks: all 13 hand-authored selection expectations agree with their public
rows and fixed canonical ordering; all eight journeys are represented; relative documentation
links resolve. The mock-data layout/content check passes for 144 files. The full scenario
validator still reports the same eight previously recorded missing Gemini paths (PLAN D6).
No production code changed in this M1 slice, and the prior 607-test implementation checkpoint
was not rerun or recharacterized as SQL acceptance.
