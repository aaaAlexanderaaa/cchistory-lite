---
doc_type: evidence
status: current
authority: evidence
last_reconciled: 2026-11-16
template_discipline_version: "2026.11"
---

# Working-discipline sync from template-project (2026.11)

This record documents the 2026-11-16 synchronization from `../template-project`
(`discipline_version = "2026.11"`) into [AGENTS.md](../../AGENTS.md),
[working discipline](../contracts/working-discipline.md), and [Architecture](../../ARCHITECTURE.md).
It builds on the [2026-10-13 learning and validation record](2026-10-13-working-discipline.md),
which remains preserved as historical evidence.

## Source reviewed and target inventory

- **Template source**: `../template-project` (`discipline_version = "2026.11"`, `AGENTS.md`,
  `docs/README.md`, `docs-policy.toml`, five contracts under `docs/contracts/`,
  `docs/guides/onboarding.md`, `docs/guides/grill.md`, `.agents/skills/`, `templates/`,
  `scripts/read_rules.py`, `scripts/project.py`, `scripts/check_docs.py`, `scripts/projectlib/`,
  and `docs/sources.toml` through `SRC-023` dated 2026-11-16).
- **Target repository state** (inspected at `7a9d636`, clean working tree):
  - **Codebase size**: `385` non-hidden non-ignored files, `64,932` code lines (`packages/`: `50,913`,
    `apps/`: `11,718`, `scripts/`: `2,100`, `mock_data/`: `201`).
  - **UI technology**: `0` HTML, CSS, or frontend component files (`has_ui_or_style_files = false`);
    surfaces are a headless CLI (`apps/lite-cli`) and an ANSI terminal TUI (`apps/lite-tui`).
  - **Directory structure and file sizes**: `0` catch-all directories (`utils/`, `helpers/`,
    `common/`, `misc/`); two `utils.ts` files exist (`packages/canonical/src/utils.ts` and
    `packages/source-adapters/src/core/utils.ts`). `34` source and test files exceed `500` lines
    (largest production files: `packages/source-adapters/src/core/probe.ts` at `2,583` lines,
    `apps/lite-cli/src/index.ts` at `2,415`, `packages/live-runtime/src/index.ts` at `2,106`,
    `packages/source-adapters/src/core/parser.ts` at `1,904`, `packages/domain/src/index.ts` at
    `1,395`).
  - **Maturity stage**: Core packages, public schemas, CLI/TUI, and `stable` adapters are at
    **`stable` (`1 -> N`)** (`@cchistory/lite` `0.7.0`), while adapters marked `tier: experimental`
    in `README.md` retain faster iteration inside existing invariants and projection contracts.
  - **Language**: Plain English for repository docs, CLI output, TUI copy, and shipped skill
    (`skills/using-cchistory-lite/SKILL.md`); verbatim owner quotes retain original language.

## Applicability classification

| Template practice (`2026.11`) | Classification | Local owner or concrete repository basis |
| --- | --- | --- |
| Data safety, zero-store, read-only sources, one-way layering, single canonical semantics | Applies & already covered locally | [AGENTS.md](../../AGENTS.md), `architecture-rules.json`, `scripts/verify-architecture-boundaries.mjs`, `scripts/verify-lite-boundaries.mjs` |
| Explicit pre-code visual approval and distinct option choices | Applies & updated locally | [AGENTS.md Visual changes](../../AGENTS.md#visual-changes) strengthened to clarify structural options and reject implied consent from drafts or old code |
| Priority order, three-perspective check, maturity-stage rigor, and concrete object triggers | Applies & adopted now | [working discipline](../contracts/working-discipline.md#priority-order-and-pre-code-judgment) and [AGENTS.md](../../AGENTS.md#outcome-judgment-and-execution) |
| Plain direct language (ban coined jargon, raw enums in copy, and stacked defensive disclaimers) | Applies & adopted now | Rewrote [working discipline](../contracts/working-discipline.md#plain-language-and-verbatim-lineage) in direct prose; dated historical reports stay untouched |
| Verbatim owner-quote preservation, superseded-approach links, single execution plan (`PLAN.md`) | Applies & adopted now (principle level) | [working discipline](../contracts/working-discipline.md#plain-language-and-verbatim-lineage); `PLAN.md` remains active owner |
| Five-part architecture standard with runtime/failure `mermaid` flow | Applies & adopted now | Added runtime & failure flowchart to [Architecture](../../ARCHITECTURE.md#runtime-flow-and-failure-paths) and rule in [working discipline](../contracts/working-discipline.md#five-part-architecture-standard) |
| Single source of state, explicit clocks, and isolated fixtures | Applies & already covered locally | `packages/canonical`, `auditProjectionConsistency`, `mock_data/`, explicit-time test rules in [AGENTS.md](../../AGENTS.md#tests) |
| Anti-monolith `500`-line limit, `# Role:` headers, catch-all ban | Applies & adopted pragmatically | Adopted top-of-file responsibility comments, ~500-line cohesive target for new modules, no catch-all dirs, and split-before-expanding check on existing large files without mass rewrites or a blocking LOC gate |
| Bidirectional verification, data/metric provenance, machine readiness vs human acceptance | Applies & updated locally | [working discipline](../contracts/working-discipline.md#verification-and-completion) |
| Environment-aware review (`interactive` vs `unattended`), change-based `/grill` cue, 4-condition open closed-loop independent review | Applies & adopted now | [working discipline](../contracts/working-discipline.md#environment-aware-review-and-independent-review-protocol) |
| Goodhart / friction 4-cause diagnosis for rule health | Applies & adopted now | [working discipline](../contracts/working-discipline.md#learning-and-rule-health) |
| Web CSS layering (`tokens.css`, `300`-line CSS cap), `@container` breakpoints, Tufte sidenotes, 4 web page archetypes | Not applicable currently | Repository has `0` HTML/CSS files (CLI + ANSI TUI only); guarded conditionally if a web/HTML surface is added later |
| Copying Python governance tooling (`docs-policy.toml`, `scripts/project.py`, `check_docs.py`, `projectlib/`, `.agents/skills/grill/`, `docs/sources.toml`, `docs/work.toml`, `docs/specs/`) | Tailored locally (`scripts/check_docs.py`) | Adopted a zero-dependency Python doc governance checker (`scripts/check_docs.py` + `scripts/test_check_docs.py`, wired into `verify:governance`) validating Markdown links/anchors, plain language, privacy hygiene, `README.md` vs `registry.ts` adapter sync, `docs/research/README.md` indexing, and non-blocking monolith advisories; omitted `project.py`'s web workbench, `docs/work.toml`, and `architecture-rules.toml` to keep `PLAN.md` and `architecture-rules.json` as single owners |

## Verification scope and limits

- **Applied checks**: Markdown link and heading-fragment verification across updated docs, plain-language
  scan for stacked disclaimers/jargon/placeholders, `git diff --check`, `node --test
  scripts/verify-architecture-boundaries.test.mjs scripts/release-prepare.test.mjs`,
  `node scripts/verify-architecture-boundaries.mjs`, and `node scripts/verify-lite-boundaries.mjs`
  after final edits (`pnpm` was not on the sandbox PATH, so the underlying governance and boundary
  scripts ran directly via Node).
- **Unchanged code/artifacts**: Product source code, schemas, `skills/using-cchistory-lite/SKILL.md`,
  and `mock_data/` were not modified, so package build/test and release artifact outputs from `7a9d636`
  remain unedited rather than rerun as new product claims.
- **Behavioral limit**: Fresh-context agent uptake of the `2026.11` wording has not yet been tested
  in an independent consumer session and remains partial until exercised on future authorized work.
