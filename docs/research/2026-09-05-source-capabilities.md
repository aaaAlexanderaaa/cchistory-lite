# Source capability survey

Date: 2026-09-05. Historical code survey at the initial `2a36d1e` / 0.4.4 anchor, before the
shared-file-plan and metadata-reuse slices. This classifies all 16 registered adapters; it is not
a claim of native performance or optimization equivalence for every adapter.

## Common findings

- Discovery walks default and supplemental roots, collects and sorts matching files, then applies
  the file cap. A cap on selected files does not bound directory inventory work.
- Exact targeting retains containers. Other paths use filename matches or identity inspection;
  generic JSON identity inspection may read the whole document.
- Only Codex and Claude declared logical-session projection independence. Being able to target a
  file does not establish independent canonical projection of that file.
- No adapter interface declared a proven canonical last-real-message upper bound or an exact count
  of eligible top-level nonempty sessions. Sample ordering does not prove latest ordering.
- Runtime refresh supplied no previous payload. Probe-level incremental support did not imply
  incremental refresh in the CLI shell.
- Directory exclusion is not canonical project-membership exclusion. Relationships can require
  evidence from additional units.

| Source | Targeting / projection boundary | Preparation opportunity | Limits or unverified capability |
| --- | --- | --- | --- |
| Codex | file / logical session | Bounded JSONL identity/cwd inspection, related refs, group merging before scope filtering | Metadata can inspect every candidate; first-workspace and uncertain evidence require parity; no recency bound |
| Claude Code | file / logical session | Encoded-directory prefilter, JSONL metadata, grouping | Directory encoding is lossy; cwd inspection may scan a whole file; no latest proof |
| Factory Droid | file / source | Encoded-directory prefilter and generic target selection | No proof of independent file projection or bounded companions |
| Amp | file / source | Generic exact identity selection | Identity helper reads JSON; no proven cheap project/recency bound |
| Cursor | hybrid / source | Transcript prefilter; preserve state databases/chat stores; seed filtering before canonical projection | VS Code seed extractor does not receive target refs; broad SQLite extraction and supplemental-root deduplication remain |
| Cursor Agent | file / source | Transcript-directory prefilter and generic targeting | No logical-session independence declared |
| Antigravity | hybrid / source | Artifact/path recognition and state/live/offline evidence | State extraction not passed target refs; live trajectory costs not separately measured |
| Gemini | file / source | JSON identity selection and seed filtering | Container extraction may precede filtering; no declared path-based directory rejection |
| OpenClaw | file / source | Generic targeting and special container preservation | Session indexes/containers retained; semantics remain source-wide |
| OpenCode | file / source | JSON identity selection | Identity reads JSON; session/message layout remains source-boundary evidence |
| LobeChat | container / source | Seed filtering after export extraction | Whole JSON export parsed first; one file can contain many sessions |
| CodeBuddy | file / source | Generic targeting | No cheap directory or recency capability declared |
| Accio | file / source | Generic targeting | Root layout and companion costs need targeted fixture work |
| ZCode | container / source | SQLite predicates on session/message/part IDs and relation endpoints | Untargeted `.all()` extraction; WAL/SHM dependencies; no exposed safe session iterator |
| Kimi | file / source | Main-wire targeting with companions | Companions can include global indexes, workspace/user-history files and subagent wires; one main file does not bound all evidence |
| Grok | file / source | Reversible directory encoding and summary catalog for sampling/parent resolution | Summary timestamps not proven canonical recency bounds; parent lookup may inspect sibling metadata |

The inspected entry points include the [adapter registry](../../packages/source-adapters/src/platforms/registry.ts),
[capability types](../../packages/source-adapters/src/platforms/types.ts),
[discovery utilities](../../packages/source-adapters/src/core/path-utils.ts),
[session grouping](../../packages/source-adapters/src/core/session-grouping.ts),
[probe](../../packages/source-adapters/src/core/probe.ts), and
[runtime](../../packages/live-runtime/src/index.ts). These links follow the working tree; the
table describes the historical inspection stage, not an immutable source permalink.

## Observed native coverage

Native reads went through the CLI/runtime adapters, without grepping source roots. Evidence was
primarily scoped and cross-project Codex previews, an empty scoped Claude preview and a nonempty
broader Claude preview, and an empty Grok preview. The mixed-source run stopped at ZCode OOM after
preceding adapters. Other scale or correctness claims remained code-only or unmeasured. Empty
results do not establish that a tool was never used.

Later slices share declared companion/file evidence with risk estimation and reuse metadata within
one attempt. They do not establish canonical recency bounds, independent projection for the other
adapters, bounded container decoding, or complete accounting of parser-internal/live API costs.
See the [implementation boundaries](../design/2026-09-05-bounded-query-model.md#first-implementation-boundary).
