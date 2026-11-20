# Project work

## Current work — 2026-11-19 Usability, diagnostics, and terminal visualization

Status: implementation and full repository verification complete; commit and push to `origin/main` authorized.

Owner requests (verbatim):
> 我在考虑易用性、可用性这一块
>
> A/B 还有别的：我作为一个用户，我用它最可能的场景是什么？我让AI来用它我期望用它做什么？它能做到哪些明明已经可以做到的但是只是因为默认配置而没做到的？比如把时间从天变成小时。 在这个工具交付的结果中，怎样的可视化是恰当的？怎样让用户更加地所见即所得？比如，你给我展示数字不如给我额外展示图像，来显示那个所谓的程度，比如，你给我计算了缓存命中率，那把它展现出来明显要比不展现更好。 去想如何更好地服务用户，而不是只摘低垂的果实
>
> 同意，我都认可，除了HTML报告导出以外，你都出方案吧

Approved design & visual/interaction choices (2026-11-19):
- **A1 (CLI `search` default)**: Default to full conversation search (titles + user prompts + assistant replies) on a context-light scan (`retainConversationEvidence: true`), with `--prompts-only` / `--content prompts` for prompt/title-only mode and `--group-by session|message`. `query`/`shell` JSON search keeps legacy default unless `content: "conversation"` is specified.
- **A2 (`stats` / `tui` scope defaults)**: CLI `stats` and `tui` default to machine-wide scope (`--dir <path>` narrows to one directory; `--no-dir` remains accepted). Collection commands (`ls`, `latest`, `sample`, `search`, `tree projects`, `query`, `shell`) retain `--dir=$PWD`.
- **A3 (CLI `help` layout)**: No-arg `cchistory-lite` and `help` print a concise ~25–30 line human-first command synopsis; `help <command>` renders full per-command flags from `agent-contract.ts`; `agent` remains the machine JSON contract.
- **A4 (Hybrid terminal visualization)**: Full terminal visuals in CLI `stats` and TUI stats dashboard (`i`) — 5-component stacked cost-mix bar, dual-marker quota pace gauge, cache hit rate + bar + estimated savings + `>200K` tier call count, time trend sparkline, and inline share bars + cache-hit column on rollup tables (responsive to terminal width, `NO_COLOR=1`/non-TTY safe).
- **A5 (Execution plan & boundaries)**: Approved visual/interaction mockups for Stage 1 (diagnostics, hourly/session dimensions, terminal visualization, Top Sessions drill-down, TUI pricing export) and Stage 2 (full-conversation CLI search, full reply `show` & Markdown export, unified CLI/TUI entry & forwarding, TUI clipboard/exit-print-resume/CJK search, concise help). Static HTML report export explicitly excluded; zero-store, read-only source, one-way layering, and canonical semantics invariants preserved.

Pre-code judgment:
- Executor: preserve zero-store, read-only sources, offline pricing, `auditProjectionConsistency`, and additive JSON compatibility while delivering both stages end-to-end.
- Collaborator: turn already-computed canonical signals (local hours, per-call cache savings, `>200K` context tiers, 5-part cost shares, session families/tools, masked conversation evidence) into default-on, immediately visible outputs and one-keystroke workflows.
- Architect: keep all usage diagnostics, time-bucket selection, quota pace math, session enrichment, and search matching in `packages/canonical` (pure, storage-neutral); keep `apps/lite-cli` and `apps/lite-tui` strictly presentation/interaction layers (`stats-visuals.ts`, `help.ts`, `clipboard.ts`).

Scope & module ownership:
- `packages/domain/src/index.ts`, `packages/domain/src/usage-pricing.ts`: `"hour"` / `"session"` dimensions, `UsageEfficiencyMetrics`, `UsageCostShares`, `QuotaPaceProjection`, `UsageSessionRollupMeta`, `UsageHourlyProfileCell`, and additive `UsageCostBreakdown` savings/tier counters.
- `packages/canonical/src/usage-time.ts`, `packages/canonical/src/usage-pricing.ts`, `packages/canonical/src/usage.ts`, `packages/canonical/src/usage-diagnostics.ts`, `packages/canonical/src/usage-breakdown.ts`, `packages/canonical/src/conversation-evidence.ts`: hourly bucketing & `resolveDefaultTimeBucket`, per-call cache savings & `>200K` tier counting, efficiency/quota pace/24h profile/enriched `by_session` computation, and `sourceIds` filtering on conversation evidence search.
- `packages/live-runtime/src/index.ts`: passes session contributions & families into usage aggregations, wires `sourceIds` through `searchConversation`, and re-exports canonical diagnostics helpers.
- `apps/lite-cli/src/stats-visuals.ts`, `apps/lite-cli/src/stats-command.ts`, `apps/lite-cli/src/stats-render.ts`, `apps/lite-cli/src/help.ts`, `apps/lite-cli/src/json-v2.ts`, `apps/lite-cli/src/agent-contract.ts`, `apps/lite-cli/src/index.ts`: terminal visuals, auto-hourly & session stats, machine-wide `stats` default, conversation-default `search`, full reply `show` & Markdown `export`, sibling TUI launching & option forwarding, and concise single-source help.
- `apps/lite-tui/src/stats-visuals.ts`, `apps/lite-tui/src/clipboard.ts`, `apps/lite-tui/src/stats-state.ts`, `apps/lite-tui/src/stats-query.ts`, `apps/lite-tui/src/stats-render.ts`, `apps/lite-tui/src/model.ts`, `apps/lite-tui/src/state.ts`, `apps/lite-tui/src/input.ts`, `apps/lite-tui/src/render.ts`, `apps/lite-tui/src/index.ts`: dashboard visuals, `hour` bucket, `S` Top Sessions drill-down, `E` guarded pricing export, `y`/`Y`/`R` copy & exit-print-resume, `--dir`/`--stats`/`--since`, `Ctrl+F` on-demand conversation search, and 2-char CJK auto-search.

Follow-up (2026-11-20) — official GPT-6.2 Sol / Astra list rates:

> 下面是价格,你更新一下本地的cchistory-lite 然后 commit and push
>
> gpt-6.2-sol $2 / $0.10 / $10；gpt-6.2-astra $8 / $0.40 / $40（Astra 为 Sol 的 4 倍）。Sol 和 Astra 均有官方定价。codex-auto-review 通过 ChatGPT 账号登录 Codex 时免费，且不消耗套餐额度；OpenAI 未公布其独立 API 单价。

Approved follow-up choices:
- Add `gpt-6.2-sol` (`$2 / $10 / $0.10` per 1M input/output/cache-read) and `gpt-6.2-astra` (`$8 / $40 / $0.40`) as official-price supplements; upstream catalog entries retain precedence.
- Keep `codex-auto-review` unpriced rather than a $0 API row.
- Leave 272k long-context multipliers and cache-write rates for a later upstream refresh; the owner table listed the three headline rates.

Verification (2026-11-20 GPT-6.2 pricing):
- `pnpm run build:lite` passed.
- `pnpm test` passed: 875 package tests (`@cchistory/domain` 103, `@cchistory/canonical` 181, `@cchistory/source-adapters` 283, `@cchistory/live-runtime` 132, `@cchistory/lite-cli` 76, `@cchistory/lite-tui` 100), 4 catalog-refresh tests, and `verify-lite-boundaries.mjs`.
- `pnpm run verify:governance` passed: 14 JS governance tests, 5 Python doc-checker tests, `verify-architecture-boundaries.mjs` (5 rules across 144 matches), and `scripts/check_docs.py` (37 docs, 17 adapters).
- `pnpm run verify:lite-artifact` passed (temporary npm cache) for the standalone tarball and `npm pack` + local prefix install.

Follow-up polish (2026-11-20) — `gemini-4-neon` pricing + stats visualization & Matrix redesign:
> gemini-4-neon的价格补一下
>
> 那个颜色的条带太短了以至于没有区分懂，200美金和3美金看起来差不多；而且没对齐, 而且hour没有考虑hour of the day，22:00和1:00竟然是连在一起画图的, 而且matrix 视图有一种，我不知道你想让我看什么的感觉，细节都被遮住了或者漏掉了，time被遮得只剩下月份，in/out/cr/cw/ mit都不展示？

Approved follow-up choices:
- Max-normalized 10–12 column 1/8th-block bars (`▏▎▍▌▋▊▉█`, 80–96 levels) and strict fixed column widths across CLI and TUI quadrants (`$200` full bar vs `$3` thin 1/8th sliver; zero column jitter).
- Gap-filled chronological `hour`/`day` series (`buildDenseTimeSeries` / `densifyShortHourlyRollupRows` so empty hours `23:00`/`00:00` between `22:00` and `01:00` never collapse) plus `hour_of_day` (`00:00`–`23:00`) bucket & 24-hour clock rhythm charts across CLI and TUI.
- Redesigned TUI Matrix view (`apps/lite-tui/src/stats-matrix-render.ts`) defaulting to `Project × Model` with `g` grouping cycle (`Project × Model` / `Model × Time` / `Project × Time` / `All 4`), unclipped bucket-aware time formatting, full `In / CR / CW / Out / Hit / Mult / List$ / Adj$` columns (plus `←/→` column paging on narrow screens), and a pinned 2-line selected-row detail inspector; CLI Matrix also adds `CacheW` and `Mult`.
- Added official Google `gemini-4-neon` pricing (`$3 / $15 / $0.15` per 1M input/output/cache-read tokens, verified against `models.dev/api.json` & Google AI pricing) to `model-pricing-catalog.ts` (2,563 models) and `refresh-models-dev-pricing.mjs` supplements.

Verification (2026-11-20):
- `pnpm run build:lite` passed across all 6 workspace packages.
- `pnpm test` passed: 874 package tests (`@cchistory/domain` 103, `@cchistory/canonical` 180, `@cchistory/source-adapters` 283, `@cchistory/live-runtime` 132, `@cchistory/lite-cli` 76, `@cchistory/lite-tui` 100), 4 catalog-refresh tests, and `verify-lite-boundaries.mjs` (zero store/server leaks).
- `pnpm run verify:governance` passed: 14 JS governance tests, 5 Python doc-checker tests, `verify-architecture-boundaries.mjs` (5 rules across 144 matches), and `scripts/check_docs.py` (37 docs, 17 adapters, 0 errors).
- `pnpm run verify:lite-artifact` passed (with temporary npm cache) for both the standalone tarball and `npm pack` + local prefix install.
- `pnpm run mock-data:validate` passed across 198 fixture files; `git diff --check` passed.
- Direct built-binary fixture checks verified CLI `stats` (1/8th fractional bars, gap-filled trend, `Hour of day (00-23)` + ruler, `--by hour_of_day`, Matrix `CacheW`/`Mult`), TUI 130×28 Quad alignment, and TUI 120×22 Matrix (`Project × Model` default, `g` grouping cycle, unclipped `MM-DD HH:00` time, narrow `←/→` column paging, and pinned 2-line `Selected` inspector).

## Previous work — 2026-11-18 General model-name pricing resolution

Status: implementation and verification complete. Commit and push to `origin/main` authorized;
the owner will run the GitHub Release workflow for `0.8.1`.

Owner request (verbatim):
> 那就把 ccusage 的通用模型名称匹配逻辑也学过来，覆盖这类后缀和别名，别每个模型都手动补映射。Fast 这种独立费率要区分清楚，验证后 commit and push。

Pre-code judgment:
- Executor: preserve offline/read-only execution, current CLI/TUI presentation and pricing-config contracts; deliver generic matching and verify actual costs before commit/push.
- Collaborator: replace per-version Grok Build aliases with catalog-driven rules and preserve opaque Gemini routing aliases and explicit user overrides.
- Architect: keep name matching and rate-variant boundaries in one pure canonical owner, separate from cost arithmetic and source I/O; preserve numeric model versions and deterministic results.

Reference: ccusage `58866ba681343634ab6e5add61f18f3b70aa98f7` / 20.0.51, re-fetched on 2026-11-18. Inspect `pricing.rs` (`find_with_fallbacks`, `find_entry_with_fallback`, `pricing_key_matches`, `contains_pricing_key`, `suffix_starts_with_numeric_model_version`, exact-only catalog rules) and `model_aliases.rs` (configured aliases preserve Fast suffixes). Use normalized separators and bounded longest-key matching, with exact/explicit precedence and separate billing variants. Keep incomplete/ambiguous matches unpriced with their raw model evidence.

Acceptance: fixture-based matching/version/alias/variant counterexamples, per-call Fast and standard cost comparisons, CLI JSON pricing explanations, bounded comparison with the upstream binary, all four repository gates, fresh-context review for the repeated model-price concern, and a clean committed/pushed main branch.

Implementation: `model-name-matching.ts` owns catalog-driven names, input suffix normalization,
provider prefixes, alias chains, numeric boundaries and independent rate qualifiers. Removed
the three manual Grok Build/Fast aliases from both snapshot and generator; retained actual Fast
prices and opaque Gemini aliases. Exact authored spelling precedes equivalent separators, and
ambiguous/missing rates keep unpriced tokens. Per-aggregation model resolutions avoid repeated
catalog scans while later in-memory calibration reads the current config.

Evidence: the fixture's 13-case replay through ccusage 20.0.51 agrees on ordinary Build,
provider/date/alias prices ($0.0085 per 1k input + 1k cache + 1k output) and the 4.70 version
boundary. The replay preserves contrary evidence: ccusage falls back to ordinary rates for
4.7/4.6 Fast, while Lite uses the official 4.7 Fast supplement ($0.017) and retains 4.6 Fast as
unpriced. Built CLI mixed-call output is 603,031 tokens / $1.500366 / 3,000 unpriced tokens,
with separate standard/Fast explanations. A Node 22.23.5 / 256-MiB-heap synthetic run of
100,000 calls across four raw model names took 19 ms for cost aggregation (86 MiB process RSS);
225M priced plus 75M unpriced tokens were retained. This measures that bounded fixture shape.

Independent review: fresh context `model_matching_review` first judged goal alignment, pure
canonical ownership, offline/source boundaries, per-call context prices and docs consistent.
It then recorded two P2 findings: normalization of alias keys widened a specific `private-high`
alias to sibling inputs; old `preview/latest` alias fallbacks were lost. Both findings remain
part of the review record: the fix normalizes only the request's suffixes, retains full alias
keys, and restores preview/latest compatibility. Additional author counterexamples cover
suffix-only/numeric-only names, a separately priced normalized preview entry, and nested
gateway/provider names retaining their most specific price or alias. The reviewer subsequently
found a third P2: inherited Fast aliases with colliding separator spellings depended on object
insertion order. Inheritance now prefers authored prefixes and collects all equally specific
normalized targets; conflicting targets remain unpriced. Every synthetic case reverses both
catalog and alias insertion order. Canonical's 174 tests pass after these repairs. The original
reviewer closed all three P2 findings, independently passed 96 synthetic cases, confirmed
source/dist agreement across 119 cases and 132 matching/pricing tests, and rechecked the built
CLI's 200,312 tokens / $0.3505255 with matching model/day totals. No findings remain open.
Final full gates pass: `build:lite`, `pnpm test` (858 package tests + 4 catalog tests),
`verify:governance`, and `verify:lite-artifact` with a temporary npm cache. All 198 fixture
files pass sanitization/layout validation, and `git diff --check` passes. Source inputs,
offline execution and CLI/TUI presentation retain their existing contracts. The GitHub
Release workflow owns the `0.8.1` version bump and tag.

## Previous work — 2026-11-17 Model pricing refresh and Codex accounting comparison

Status: implementation and verification complete in the local working tree.

Owner request (verbatim):
> 更新一下模型，比如，grok-4.6-build之类的。从 [https://github.com/ccusage/ccusage](https://github.com/ccusage/ccusage) 进行学习和理解，获取它的数据源或沉淀的价格映射记录、代码路径和解析方式。纳入现有的统计模块。
>
> 另外，我注意到，现有的codex统计存在不准的情况，我大致算了一下，在另一台服务器上，比真实统计少了约10%计量 不知道是从哪里少的，你可以和ccusage做对比

Owner clarification (verbatim):
> token总量吧，因为我走API网关的，它没有阶梯计费，但是它统计的总量就是比我们多了一些些，它甚至还有按每次请求的token来对账的，所以我认为这里应该是我们这个项目的一些问题

Pre-code judgment:
- Executor: retain read-only sources, zero-store, existing CLI/TUI layout, canonical semantics, and compatible public projections.
- Collaborator: refresh model coverage and reproduce accounting gaps on sanitized fixtures; preserve server reconciliation as a separately observed outcome.
- Architect: adapters retain native usage and identity; canonical owns independent calls, compaction reconciliation, time attribution and cost; offline prices have reproducible upstream provenance.

Reference: ccusage `58866ba681343634ab6e5add61f18f3b70aa98f7` (2026-11-17), including its pinned LiteLLM revision and models.dev snapshot/rules. Initial local findings: cumulative-only Codex usage is discarded; reply-dependent accounting loses calls without text; last-only events are treated as checkpoints; per-turn time bucketing shifts calls across date filters. Inspect compaction records and archived roots as additional candidates. The owner clarified that the comparison concerns token totals from a flat-price API gateway with per-request accounting. The server's exact request ledger and time range remain external inputs.

Implementation: [ccusage accounting comparison](docs/research/2026-11-17-ccusage-accounting.md) records pinned source paths, 2,562 offline model prices, Grok Build alias and per-call context rates, Codex independent calls/compactions/counter resets, active/archive copy preference, and equal-input observations. The first independent reviewer's initial findings and closed-loop results remain in that record; a fresh second pass and both reviewers' closed-loop re-verifications are complete. All reported root flaws are resolved in their exact reproductions.

Acceptance: focused counterexamples and fixture projection audit, built CLI stats with matching filters, required build/test/governance/artifact gates, documented upstream paths and remaining scope. Runtime pricing stays offline; local config overrides retain priority.

Verification completed 2026-11-18 (Node 22.23.5, pnpm 10.30.3): `build:lite`, `pnpm test` (734 package tests + 3 catalog-refresh tests), `verify:governance`, and `verify:lite-artifact` all passed on the final implementation. Fixture layout/sanitization passed for 197 files; `git diff --check` passed. The artifact's initial npm-cache `EPERM` was resolved by using a temporary npm cache, then the complete extracted/installable artifact verification passed.

Built CLI and ccusage 20.0.51 agree on the synthetic corpus: 200,312 tokens, all token components and UTC dates, $0.3505255. Runtime counter/inheritance fixtures have zero projection issues, including whole-request checkpoint tier pricing. Equal-input native observation against prior HEAD `03d5752` covered 66 sessions / 102 real user turns: 603,577,610 prior tokens versus 681,222,584 corrected, recovering 77,644,974 (11.40% of corrected total). Source diagnostics retain 83 unsupported response-item warnings and zero projection issues. The owner's remote gateway ledger remains the input for exact server reconciliation. Source safety and the existing CLI/TUI layout are preserved.

Follow-up — 2026-11-18 commit and 0.8.1 preparation (verified; commit and push authorized):

Owner request (verbatim):
> grok-4.7-build呢，也有的话，就commit and push，我会去github发一个小版本，现在应该要发0.8.1了

Synchronized the published `v0.8.0` / `bed229c` release commit from `origin/main`, preserving
all accounting work. Added `grok-4.7-build` and distinct official Fast prices and updated
Unreleased notes. The combined tree passes `build:lite`, 735 package tests + 4 catalog tests,
`verify:governance`, `verify:lite-artifact`, 197-fixture validation, and the read-only
`release:prepare -- 0.8.1 --check-only` preflight. Delivery is authorized to `origin/main`. The owner will
run the GitHub Release workflow with `0.8.1`; that workflow owns the version bump and tag.

## Previous work — 2026-11-17 Multi-dimensional token stats, cross-filtering, pricing, and quota reconciliation

Status: implementation and verification complete in the local working tree.

Owner request (verbatim):
> 我需要优化一下token统计在CLI/TUI的展示，一方面是现在的布局和展示效果和用户体验，好像不能同时看到按项目*模型*工具*时间的统计，也不支持以上几个维度的filter，这是一个用户体验问题，需要你的思考。用户故事是，我想知道我烧的token值多少钱，我想知道我这个时间段大约用了多少额度（因为正好我的周限、月限用了xx%，我想对个帐），还要支持不同的模型用不同的模型倍率，因为如果我对不上帐，那有可能是某个模型的某种计价（比如缓存）是有额外的倍率的，模型价格参考models.dev/api.json ; gemini-pro那个现在是carbon，flash是hydrogen

Approved choices (2026-11-17):
- TUI layout & interaction: 2×2 four-dimension interactive dashboard (`Project`, `Model`, `Source`, `Time`) with `Space`/`Enter` cross-filtering, `v` full-width matrix breakdown view, and `m` in-memory multiplier/alias/quota calibration drawer.
- Pricing & multipliers: bundled offline `models.dev/api.json` snapshot + built-in aliases (`gemini-pro-orchestrator` → `gemini-4-carbon`, `gemini-flash-worker-agy` → `gemini-4-hydrogen`) + explicit local JSON overrides (`--pricing`, `CCHISTORY_PRICING_CONFIG`) and inline CLI flags; zero runtime network calls or persistent store writes; manual local catalog refresh script (`scripts/refresh-models-dev-pricing.mjs`) + `--export-pricing` config helper.
- Dual-layer cost & quota model: preserve raw `models.dev` list USD cost (`list_cost_usd`) alongside multiplier-adjusted cost (`adjusted_cost_usd` = `model_multiplier × component_multiplier`) and period quota percentage (`quota_percent`).
- Time & scope defaults: local timezone day/week/month bucketing, `rolling_7d` default week mode (switchable to `iso_week` / `custom_reset`), CLI `stats` preserves `--dir=$PWD` default with explicit scope notice and `--no-dir` hint.

Scope & module ownership:
- `packages/domain/src/usage-pricing.ts` & `packages/domain/src/index.ts`: pure usage, pricing, multiplier, matrix, and breakdown contracts.
- `packages/canonical/src/model-pricing-catalog.ts`, `packages/canonical/src/usage-pricing-config.ts`, `packages/canonical/src/usage-pricing.ts`, `packages/canonical/src/usage-time.ts`, `packages/canonical/src/usage.ts`, `packages/canonical/src/usage-breakdown.ts`: separated `cache_read` / `cache_write`, reasoning double-count reconciliation, timezone-aware bucketing, cross-filtering, matrix aggregation, and dual-layer cost/quota computation.
- `packages/live-runtime/src/index.ts`: snapshot APIs `getUsageMatrix` and `getUsageBreakdown` (with row caching) and re-exported canonical pricing/time helpers.
- `apps/lite-cli/src/stats-command.ts`, `apps/lite-cli/src/stats-render.ts`, `apps/lite-cli/src/json-v2.ts`, `apps/lite-cli/src/index.ts`, `apps/lite-cli/src/agent-contract.ts`: multi-dimension `--by`, `--model`, `--from`/`--to`/`--since`, `--tz`, `--week-mode`, `--sort`, `--pricing`, `--alias`, `--multiplier`, `--cache-read-multiplier`, `--cache-write-multiplier`, `--quota`, `--explain-pricing`, `--export-pricing`, tabular CLI output, and additive JSON output.
- `apps/lite-tui/src/stats-state.ts`, `apps/lite-tui/src/stats-query.ts`, `apps/lite-tui/src/stats-render.ts`, `apps/lite-tui/src/model.ts`, `apps/lite-tui/src/state.ts`, `apps/lite-tui/src/render.ts`, `apps/lite-tui/src/input.ts`, `apps/lite-tui/src/index.ts`: 2×2 interactive dashboard, full-column matrix view, and multiplier/alias/quota calibration drawer.

## Previous work — 2026-11-17 Maintenance fixes, Python doc governance, and 0.8.0 release prep

Status: implementation and verification complete in the local working tree; owner
authorized closeout, verification, and releasing `0.8.0`. Reused `template-project`
doc-governance principles via a focused zero-dependency Python checker
(`scripts/check_docs.py` + `scripts/test_check_docs.py`) and repaired identified
repository gaps:

- Closed reverse-layer import gaps by adding `@cchistory/lite-cli` and
  `@cchistory/lite-tui` to `architecture-rules.json` and `scripts/verify-lite-boundaries.mjs`,
  with a regression test in `scripts/verify-architecture-boundaries.test.mjs`.
- Bounded TUI `contextOverlay` via `BoundedCache` (refreshing stale overlay entries
  while keeping base snapshot priority) and moved unlinked bucket `lastActivityAt`
  derivation into canonical `resolveLatestTurnActivityAt`.
- Restored the eight missing sanitized Gemini fixture paths (`D6`) by anchoring
  `/tmp/` in `.gitignore`, bringing `mock_data` validation to 190/190 passing files.
- Updated `README.md` (`17` registered sources, plain-language `read_status` line),
  `CHANGELOG.md` `[Unreleased]` (Antigravity SQLite, per-model usage, and fixes),
  and `scripts/release-prepare.mjs` (accepting leading `--` from `pnpm run`).
- Evaluated `origin/feat/grok-bot-default-dir` (`54442d4`): deferred merging because
  matching cwd-less `grok_bot` sessions under every `--dir` leaks unrelated chats
  into project-scoped queries and token stats.
- `U1` remains owner-owned manual acceptance below.

## Previous work — 2026-11-16 Antigravity SQLite history and usage

Status: implementation is complete, built and verified. The owner authorized
committing and pushing this work on 2026-11-16; the destination is `origin/main`.

Commit preflight — 2026-11-16: all four required commands were rerun on the combined
tree with Node 24.22.1 and the pinned pnpm 10.30.3. `build:lite`, `pnpm test`
(709 tests plus dependency boundaries), `verify:governance` (13 tests, 5 rules,
125 matches), and `verify:lite-artifact` passed. All 182 fixture files pass layout
and sanitization; the eight previously recorded Gemini scenario omissions remain.

Follow-up — model breakdown and use: complete in the local working tree. The
owner asked to split consumption by model and use the local build. The existing
`stats --by model` and TUI model dimension are retained. Independent native calls
now use their recorded models within mixed-model user turns. Overview/source/
project/day rollups count unique turns so model switches preserve overall counts.
A sanitized generation fixture and actual CLI reads verify the split. Local
commands use the available Node runtime and built CLI directly.

The mixed-model fixture first reproduced incorrect attribution: a second model's
35 tokens were included in the first model's 1,223-token row. The same actual
runtime now reports 1,188 and 35 separately. Model-less calls retain `unknown`.
Model rows count each participating user turn once; overview/source/project/day
counts deduplicate those identities across models. Native CLI model totals sum
to the previously reconciled aggregate, with no observed read/projection issues.

Follow-up checks: recompiled canonical output; **709 package tests** (103 domain,
42 canonical, 280 adapters, 128 runtime, 69 CLI, 87 TUI) and dependency boundaries
passed. The final missing-model edge case passed focused canonical/runtime checks;
**13 governance tests / 5 rules / 125 matches** passed. Standalone extraction and
local npm installation passed against the current compiled output, reusing the
unchanged surface builds. Native model names and account totals stay outside the
repository. The usage guide documents `i` and the model dimension in the existing
TUI; CLI access remains `stats --by model`. The owner subsequently authorized
committing and pushing the combined adaptation and model-accounting changes.

Owner request: adapt Antigravity so the owner can inspect conversation history and
token consumption. The installed 2.32.1 uses per-conversation SQLite databases
under `~/.gemini/antigravity/conversations`, with protobuf steps and independent
generation records. The existing adapter covers older live/state/brain evidence.

Implement direct read-only SQLite parsing at the adapter boundary, preserving
canonical conversation identity, project attribution, related sessions and option-B
usage. Count each generation once through its explicit step indices/execution ID;
retain malformed or unsupported evidence and diagnostics. Reuse existing CLI/TUI
views. Preserve legacy inputs, zero-store behavior and source read-only access.

Native numeric reconciliation exposed two existing canonical accounting limits:
tool-only turns lose signals when there is no assistant text reply, and sessions
with no user turn fall outside turn-only aggregates. Preserve independent native
model calls on the canonical session, with nullable own-turn references. Sum the
assigned calls for turn usage and include unassigned calls in session/family and
aggregate usage while retaining actual user-turn counts. The projection audit,
fixture matrix and repository contract cover these identities and totals together.

Acceptance: sanitized SQLite fixtures, missing/empty/corrupt and malformed input,
cache/reasoning accounting, repeated generation metadata, assistant-only and
delegated identity, targeted reads and WAL refresh; zero projection issues through
the runtime and actual CLI reads. Run build, package/boundary, governance, fixture
and extracted-artifact checks. Native verification uses the adapter after schema
inspection and reports observed coverage separately. Commit and push are now
authorized by the owner.

Delivery verification: `build:lite` (including the artifact verifier's fresh build),
**707 package tests** (domain 103, canonical 41, adapters 280, runtime 127,
CLI 69, TUI 87), dependency boundaries and **13 governance tests / 5 architecture
rules / 125 matches** passed. Fresh standalone extraction and local npm
installation both read the SQLite fixture with correct parent, child and
assistant-only usage. All **182 fixture files** pass layout and content
sanitization. Full fixture validation retains exactly the eight previously
recorded missing Gemini scenario paths. Whitespace checks pass.

Native acceptance: actual CLI statistics, recent-session SQL and a bounded
question/answer page succeeded on the installed 2.32.1 data with zero observed
read losses or projection issues. An independent read-only sum of numeric
generation counters agreed with the canonical aggregate. Native files changed
during the comparison window, so this is an observed reconciliation rather than
an atomic-read claim. Native transcripts, identifiers and account totals remain
outside the repository and fixtures.

## Current work — 2026-10-15 Grok Bot review fixes

Status: complete. The experimental source and the reviewed repairs are integrated
into `main` following the owner's merge authorization. The recorded merge blockers
below are closed for the checked fixture cases. Repair commit `3c2993b` is on
`codex/grok-bot-source-fixes`, based on `origin/feat/grok-bot-source-0.7` at
`ae9a734`. The authorization includes merging and pushing; no release is part of
this work.

Preserve the experimental source's store-first behavior, source identity, read-only
access and canonical projection contract. Inventory both native shapes without
opening SQLite during discovery. Prefer a store only after its normal budgeted
parse yields conversation evidence, then skip the corresponding JSONL within that
attempt. Retain non-message and malformed store evidence, expose parse losses, and
use JSONL when the store cannot supply conversation evidence. Remove the process-wide
mtime cache so WAL changes are observed on the next scan. Apply the shared canonical
masking rules to the final selected title, including profile and recovered names,
before truncation.

Acceptance: regression fixtures for title masking, event/malformed/unsupported-only
stores, corrupt databases, both native shapes and WAL insert/delete refreshes;
zero runtime projection issues; Grok Bot fixture layout/content validation; build,
package/boundary tests, governance and standalone/local-npm artifact checks. Keep
the eight pre-existing missing Gemini scenario paths visible. Verification uses
sanitized fixtures only and makes no native-capacity claim.

Pre-fix evidence at `ae9a734`: all 686 package tests passed, but fixture-derived
event-only/malformed-only stores and a WAL delete returned zero sessions and no
loss audits despite valid JSONL. A synthetic maskable token appeared in an actual
CLI SQL title while the turn text was masked. Fixture validation added 12 layout
failures beyond the eight existing Gemini omissions. The repair adds regression
coverage at the adapter and actual reader/SQL projection boundaries; valid stores
still avoid reading their duplicate JSONL, rather than decoding both shapes on
every ordinary scan.

Initial repair verification, including the title-cut follow-up: `build:lite`, **691 package tests** (domain 103, canonical 40,
adapters 270, runtime 122, CLI 69, TUI 87) and dependency boundaries passed.
Governance passed **13 tests / 5 rules / 122 rule-file matches**. Standalone
extraction and local npm installation passed the artifact verifier, including a
Grok Bot SQL read over both native shapes with a synthetic maskable profile name
across the display-cut boundary.
All **175 fixture files**, including 13 Grok Bot files, passed layout and content
sanitization. Full `mock-data:validate` still reports exactly the eight pre-existing
missing Gemini scenario paths and no new findings. Whitespace checks passed.
The WAL regression observed inserts and deletes through actual reader refreshes
with unchanged main-file mtime; all fallback/SQL cases had zero projection issues.
Temporary test roots, package installs and the isolated npm cache were removed.
Changes are uncommitted and unpushed; no native-history or release claim is made.

The initial title regression set passed, but a further boundary check found that
masking an already truncated title left a short token fragment unrecognized.
The final repair applies the shared masking
function before truncation, matching the existing title-hydration discipline;
user, profile and recovered-name regressions cover the cut in both native shapes.
An empty canonical title stays empty instead of falling back to raw evidence.

Merge-readiness reassessment — 2026-10-15:

- P1: Grok Bot's `[SAND_HIDDEN_PROMPT]` prefix was added to the shared synthetic
  classifier without a platform boundary. The main branch's splitting function
  classifies the same literal input as authored. In the candidate's actual Codex
  fixture read, adding that prefix to the otherwise unchanged user request yields
  zero turns and zero authored-search hits, with no loss audits or projection issues;
  the ordinary control yields one turn and one hit. Shared title normalization also
  strips literal `[t123]` from a Codex title. Scope Grok-specific injection and title
  cleanup to the corresponding native source and add non-Grok countercases.
- P2: A Grok store message with a missing or unrecognized role is interpreted as
  assistant evidence. It then qualifies for store preference and suppresses valid
  JSONL. Fixture-derived missing-role and unknown-role cases each yielded zero turns,
  zero diagnostics and a skipped fallback. Keep unsupported role evidence with a
  diagnostic and allow fallback instead of treating an inferred actor as successful
  conversation parsing.

These are bounded sanitized counterexamples, not observations of native failure
frequency. Reused prior build/package/governance/artifact results still apply to the
unchanged production code, but the 691-test suite does not cover these cases. The
eight existing Gemini omissions remain separate from these merge blockers. A fresh
fetch confirmed `origin/main` at `d8725e8` and the Grok branch at `ae9a734`; all repair
changes are still local and uncommitted. This assessment changed only this task
record, without merging, committing, pushing or implementing the new findings.

Follow-up repair authorized by the owner: scope hidden-cue classification to Grok
Bot, preserving separate envelope parts until classification before joining real
authored text. Keep literal Grok marker and
timestamp text in shared title normalization; the Grok Bot title helper remains
responsible for its native cleanup. Preserve store messages with unsupported or
missing roles as unknown evidence with a parse-loss diagnostic, so they cannot
supersede usable JSONL. A genuine assistant-only store must still be preferred,
with its message retained under `turn_id: null` and no invented user turn.
Regression acceptance includes literal marker titles/search/evidence through the
actual Codex and Claude runtime, hidden cues in multiple text envelopes, retained
unsupported role payloads and the existing projection and artifact gates.

Follow-up result: the new source-isolation, shared-title and unsupported-role
regressions each failed against the earlier repair. They now pass, including
missing, unknown, empty and non-string roles with the original payload retained.
A mixed-envelope countercase also showed that joining hidden and real queries
before classification discarded the real request. Both envelope orders now keep
the real query; ordinary multiple queries retain their existing joined text.
The genuine assistant-only store remains preferred, with no invented turn.

Final verification after the follow-up: `build:lite`, **696 package tests**
(domain 103, canonical 40, adapters 272, runtime 125, CLI 69, TUI 87), dependency
boundaries and governance (**13 tests / 5 rules / 122 rule-file matches**) passed.
Fresh standalone extraction and local npm installation passed the artifact verifier,
including both installed Grok Bot SQL checks. Runtime cases assert zero projection
issues, preserved Codex/Claude literal-marker titles, search hits and message
identity, safe fallback and assistant-only evidence. All **175 fixture files**
(13 Grok Bot files) pass layout and sanitization; full fixture validation still
reports exactly the eight pre-existing missing Gemini paths. Whitespace checks
passed. Temporary fixture roots, installs and the isolated npm cache were removed.
Integration — 2026-10-15: combine repair commit `3c2993b` with `main` at `d8725e8`.
The only merge conflict was this task record; the complete 0.7.0 release-verification
record from `main` is retained below. The integrated tree matches the tested repair
outside this record, so the build, package, governance and artifact results above
remain applicable. Remote integration is confirmed through Git and the push-triggered
CI run. Fixture results do not establish native completeness or an independent
review, and no release is performed.

## Previous work — 2026-10-14

Status: complete and published as **0.7.0**. The owner authorized commit, push, a new tag and
npm publication, then manually started the existing Release workflow. Implementation commit
`4838268` is on `main`; its Linux/macOS, architecture and artifact
[CI run](https://github.com/aaaAlexanderaaa/cchistory-lite/actions/runs/38500987563) passed.
The [0.7.0 Release run](https://github.com/aaaAlexanderaaa/cchistory-lite/actions/runs/38545609407)
passed every release gate, published to npm, and created release commit
`14b901f040310a2eeeed285c6cc70831e9421070` and tag `v0.7.0` at that commit.
[npm](https://www.npmjs.com/package/@cchistory/lite/v/0.7.0) reports version/latest 0.7.0 and a
SLSA provenance attestation. The [GitHub Release](https://github.com/aaaAlexanderaaa/cchistory-lite/releases/tag/v0.7.0)
is public, final, and carries `cchistory-lite-0.7.0.tgz`.

Post-publication verification installed the exact npm version and separately downloaded the
GitHub tarball, matched its SHA-256 against release metadata, and exercised both actual packages:
CLI version, delegated identity, evidence cursor continuation, older-message citation, stage
diagnostics and shipped-skill equality passed. The local checkout fast-forwarded to the release
commit and fetched the tag; a local build passed and both CLI/TUI report 0.7.0. Temporary install,
archive and metadata-cache state is removed after verification.

The earlier automated dispatch returned HTTP 403 for the CLI token, and browser access was not
approved. The owner's manual dispatch resolved the blocker without changing credentials or
bypassing CI. The records below retain their pre-release measurement scope; publication does not
turn fixture capacity observations into native-history acceptance or universal performance claims.

Speed acceptance: compare the frozen pre-speed working-tree build and candidate on identical
fixture evidence and requests, including large SQLite, a large logical JSONL session, many small
sessions and whole JSON. Measure native-query/normalization/interpretation work and first-read
elapsed/RSS; preserve correct answers, citation identity, ordering, usage, scope and honest gaps.
First remove repeated expensive native-query work and JSON roundtrips; evaluate narrower source
selection and optional context formatting against their actual correctness/benefit. No blind project/cwd
filter, skipped evidence, relaxed guard, persistent cache, source write or visual redesign is
authorized by this work. Finish regression/projection matrices, repository/release gates and
evidence at the existing owners; do not create separate phase handoffs.

The owner requested a deep project assessment, clarified Agent recall of answers, decisions and
context as the primary outcome, and raised ordinary-machine resource failures, 100 MB+ sessions
and observability. ZCode was an example rather than the task boundary. The owner then asked for
learning from template-project, challenged the initial written discipline update, authorized one
fresh-context assessment, and accepted implementation through completion. The optional structured
stderr diagnostic direction was explicitly reviewed and approved; stdout remains compatible.

- Complete: template comparison and working discipline, preserving original product invariants,
  fixture/native-history boundaries, visual approval, projection requirements and release gates.
- Complete: one authorized independent first-context read-only assessment plus the small ordinary
  warm-context countercase. Their first verdicts and evidence limits remain at the evidence owner.
- Complete: goal-grounded project assessment with necessity/importance/ROI distinctions, shared
  mechanisms, strongest alternatives and limits. It records the preimplementation baseline.
- Complete: ZCode native allocation/retention repair; large Codex/Claude/Factory JSONL parsing
  and growing-record admission; guarded whole-file admission without the false fallback size cap.
- Complete: optional runtime/CLI/shell diagnostic JSONL, preserved result contracts, message-grouped
  older-answer search, immutable prepared paging, bounded derived caches and stable eviction scores.
- Complete: fixture decision/mention/reversal/citation journey, delegation/null-turn identity,
  cache/refresh/failure regressions, projection matrices and source-read-only checks.
- Complete: actual 16 GiB host baseline/current comparisons on five equal-input synthetic shapes,
  including a 134 MiB single logical session, 107 MiB whole JSON and ~1.408 GB SQLite database.
  All current cases recover the expected answer with zero projection issues and read losses;
  the small-session control and intermediate regressions remain explicit.
- Complete at the capacity/recall checkpoint: build, **668 package tests** plus dependency boundaries,
  **13 governance tests**, **5 architecture rules / 118 matches**, standalone/local-npm artifact checks, all **12 schema**
  checks with actual outputs, shipped-skill validation, link/preservation and whitespace checks.
- Complete: cheaper ZCode inventory admission, borrowed decoded AMP/ZCode records with exact
  byte ownership, shared AMP root decoding, canonical omission of discarded tool/system display
  formatting, and JSONL delimiter/buffer/tail improvements. Native project/cwd pushdown was
  evaluated and omitted because its proposed predicate did not prove canonical scope/closure.
- Complete: **13 equal-input pairs** against the frozen successful pre-speed build on an actual
  16 GiB host. All answers and semantic digests agree. First-answer medians improve by 11–54%
  in the named fixtures; the one 1.4 GB pair improves 21.84 → 10.43 seconds and 1673.9 → 965.8 MiB
  peak RSS. The small-session RSS increase, intermediate slowdown, unchanged-build control and
  declined memory preflight remain explicit in the evidence.
- Complete after speed changes: `build:lite`, **672 package tests** plus dependency boundaries,
  **13 governance tests**, **5 architecture rules / 119 matches**, standalone/local-npm artifact
  execution, all **12 schema definitions**, actual fixture requests/outputs for **10 current CLI
  contracts**, historical v1 rejection, shipped-skill validation and documentation checks.

Current facts and behavior owners: [Architecture](ARCHITECTURE.md), public schemas and
[Agent evidence/diagnostics guide](docs/guide/agent-evidence.md). Execution discipline remains at
[working discipline](docs/contracts/working-discipline.md). Evidence owners:
[discipline learning/validation](docs/research/2026-10-13-working-discipline.md),
[initial project assessment](docs/research/2026-10-13-project-improvement-assessment.md),
[integrated delivery/capacity record](docs/research/2026-10-13-useful-history-capacity.md), and
[read-speed delivery](docs/research/2026-10-14-read-speed.md).

This proves the implemented behavior and named fixture operating envelope. It does not establish
causal/repeated rule adoption, acceptance of the owner's unobserved native failure, the separate
user-owned U1 quality judgment, or arbitrary history capacity on 8/16/64 GiB hosts. Native values,
inventories and semantic state can still grow; semantic context nodes remain eagerly constructed
while discarded tool/system display formatting is skipped for `none`. Whole-file formats remain
expensive, and TUI overlay generations are not certified by bounded rank caches.
Those limits are visible, not hidden prerequisites or newly authorized work. Zero-store,
read-only source access and canonical ownership remain binding. No store, new transport, source
adapter expansion or background job was introduced. The subsequently authorized release changes
delivery status, not those runtime boundaries.

The records below preserve their dated scope and completion claims. They are historical evidence,
not current runtime authority, additional implementation queues or new permission.

## Agent evidence improvement and historical query work

Delivery record: 2026-10-03–2026-10-04. The user approved the agent usability assessment and implementation.
Baseline HEAD is the committed 0.6.0 release; the uncommitted/unreleased statements in the
2026-09-08 record below describe that historical checkpoint, not current release status.

This iteration delivers bounded conversation evidence, full user/reply text search with
delegated identity, process-local detail reuse, explicit read status, concise agent guidance
and fixture-based task journeys. It preserves existing command output fields and canonical
projection semantics. General source pushdown, a daemon/MCP transport, semantic search and
optional context construction remain separate future increments.

- [x] Canonical evidence pages, cursor identity and delegated search projection.
- [x] Runtime masked evidence retention and bounded process-owned detail snapshots.
- [x] Query/shell operations and read identity/status on history JSON.
- [x] Fixture journeys, complete repository gates and extracted artifact verification.
- [x] Documentation and shipped-skill validation.

Validation on 2026-10-04: `build:lite`, all 659 package tests, dependency boundaries,
13 governance tests and architecture rules passed. Extracted standalone and local npm
installations passed the artifact gate, including delegated answer search and one-shot
cursor continuation. The shipped skill passed `quick_validate.py`; all 11 JSON schemas
passed schema validation, with new request/evidence/continuation, SQL, compact and
canonical fixture outputs validated against their contracts.

The fixture journeys demonstrate two scans for latest → read → repeated replies → latest,
and one scan for conversation search → reading the matched turn. They also cover detail
eviction, failed/successful refresh, ambiguous aliases after caching, mixed legacy/evidence
reads, Unicode paging, long-text tail matches, directory scope and read-loss diagnostics.
Review follow-up adds missing-reference regressions for one-shot batches and cold/warm
shells. Exact-target misses fall back to matching reads so valid operations survive;
genuine scan failures still propagate without retry.
`mock-data:validate` still reports the same eight pre-existing missing Gemini scenario
paths; the new agent-evidence files pass layout and sanitization checks.

The independent U1 quality judgment remains user-owned; deterministic fixture checks do not
mark that manual acceptance complete.

## Historical query architecture work plan (2026-09-08)

Updated: 2026-09-08. Owner: Codex in the current task.

This is the single execution checklist for this work. Design notes explain choices; research
reports preserve evidence. Their open questions and experiment lists are not additional committed
tasks. Update this file when completing work or changing scope, instead of appending another
untracked “next step” to a conversation reply.

## Goal and current assessment

Deliver a small, familiar query language over read-only native history, borrowing an existing
syntax/parser without adopting a database engine. Common commands and editable query templates
should share the same logical operations. A query session should reuse prepared data, close
explicitly or on idle expiry, and allow a proven common query to avoid unnecessary interpretation.

**The agreed M0–M3 delivery is complete in the working tree.** The reviewed query frontend,
shared execution, shell lifetime, and one selective Codex latest plan are implemented and validated.
The sanitized reports include the proof, measured benefits and limits, and final acceptance.
Changes have not been committed or released. Universal memory bounds and low-memory deployment
capacity are not established. **The first-use follow-up failed the user-owned U1 trial
on 2026-09-08.** The finite memory correction below is complete. In a subsequent independent
run the user reported that an HTML artifact was delivered, with result quality explicitly
unevaluated and workflow detours still present. U1 acceptance remains with the user.

## Completed foundation — M0

- [x] Inspect current execution and all 16 source capabilities; establish cost observations and
  record their limitations in the [sanitized research reports](docs/research/README.md).
- [x] Share a validated file read plan between estimation and execution, including declared
  companions and SQLite sidecars.
- [x] Reuse unchanged preparation metadata within one attempt, with measured repeated-work savings
  and explicit invalidation.
- [x] Establish a canonical interpretation entry and nonempty full/none/matching regression cases
  for every registered adapter.
- [x] Validate the implementation: 607 package tests, build, dependency and architecture checks,
  and extracted release-artifact execution passed at the M0 checkpoint. See the
  [verification record](docs/research/2026-09-06-canonical-interpretation-seam.md).

M0 is implemented and validated in the working tree; it has not been committed or released.
It can be reviewed and closed independently. Optional detail construction is not an unfinished
requirement of M0. The current `none` path still constructs complete contexts before discarding them.

M2 extended the existing JSON batch and shell entries with the reviewed SQL frontend and idle
expiry. Existing input/output forms remain; their replaced collection selection paths were
removed. No legacy collection executor is retained.

## Delivery milestones — complete

These define the completed first product delivery. Concrete public syntax, field choices, result
format, and interaction behavior were reviewed at M1 before surface implementation.

| ID | Status | Deliverable | Completion condition |
| --- | --- | --- | --- |
| M1 | Approved: direction A and one shared implementation | [Finite query contract](docs/design/2026-09-06-query-contract-v1.md), [parser decision](docs/research/2026-09-06-query-parser-selection.md), and [fixed review oracle](mock_data/fixtures/query-contract/review.json) | The recommended dialect/parser, fields/operators/exclusions, totals/coverage/order/text/null semantics, and idle behavior are specified. The user approved A, requiring observable compatibility through replacement rather than parallel old/new execution mechanisms. |
| M2 | Implemented and validated; uncommitted | [Shared execution and acceptance record](docs/research/2026-09-06-shared-query-execution.md), [user guide](docs/guide/query.md) | Supported query text, bound-parameter templates, and the common commands selected at M1 use the same operations; collection queries reuse the snapshot; explicit close and idle expiry work; current command/JSON behavior remains compatible. |
| M3 | Implemented and validated; uncommitted | [Selective Codex latest and final acceptance](docs/research/2026-09-06-selective-latest.md) | Exact complete-reference parity, conservative fallback and changed-evidence rejection are covered. The larger synthetic fixture avoids 50 of 60 canonical interpretations with a lower elapsed median; inventory still reads every file. Q1–Q8 and final repository/release-artifact gates passed. This delivery stops here. |

M1 compared two candidates and selected `pgsql-ast-parser` 12.0.2. Both parsed all 13 positive
review queries; their isolated imports passed. This verifies parser suitability, not query
execution. The fixed corpus also records 17 rejection inputs, three generated budget cases,
and controlled-clock lifecycle journeys. The implemented shell idle default is 300 seconds, with
zero disabling it. Existing commands retain exact totals; new SQL requests them with `--complete`.

M1 limits parser selection to at most two credible candidates and one decision. It is not an
open-ended survey of SQL, JQ, ESQL, or every possible data-query system. The proposed first syntax
scope is single-collection session/turn reads, public field selection, bounded conditions,
ordering, and limit. Existing detail, ranked search, project/family, and usage operations remain
available without requiring general joins or aggregation in the new language.

M2 can use the complete snapshot as its reference executor. Avoiding detail formatting, creating
a unit cache, or redesigning generation-bound detail is **not a prerequisite for query syntax**.
M2 includes the parser dependency/license closure in the release artifact. SQL passed execution
from both the extracted standalone artifact and the packed local npm installation.
M3 depends on M1's answer and coverage contract, not on those optimizations. It initially targets
Codex and the contract's one-shot latest-sessions SQL template, not universal early pruning
across 16 adapters. Unsupported sources retain the
complete path; their semantic regression coverage remains required.

For M3, counters must distinguish discovery, metadata reads, source decoding, interpretation,
and retained state. An inventory that reads every file cannot be reported as avoided source I/O.
Exact totals, exhaustive diagnostics, ties, split sessions, and delegated eligibility must follow
the M1 contract rather than being silently weakened to enable early stopping.

If the single-source experiment cannot prove correctness or useful avoided work, record a no-go
and bring back the concrete tradeoff. Do not silently count the optimization as complete, try
source after source, or make a general planner the next prerequisite. Shipping a reduced scope
would then require an explicit scope decision.

## Fixed acceptance journeys for M1–M3

M1's linked contract and review oracle supply query text and expected fixture results for these eight cases. These are
the bounded acceptance corpus, not an invitation to add every query feature.

1. Latest ten top-level, nonempty sessions, with canonical recency and deterministic ties.
2. Session selection combining source and a time range, with a result limit.
3. Turn selection combining project identity and a time range; project is not merely cwd.
4. Public field selection and a bound-parameter template, with defined missing-value behavior.
5. Equivalent latest/list command and query requests produce identical ordered rows.
6. Unsupported syntax, invalid fields, and excessive expression complexity fail before scanning.
7. Repeated collection queries use one prepared snapshot; explicit refresh replaces it; failed
   refresh preserves the previous usable snapshot. Existing detail rescans remain explicit.
8. Explicit exit/EOF and idle expiry release session ownership; active queries are not expired.

M3 adds the existing adversarial latest cases to journey 1: misleading mtime, equal activity,
missing metadata, split sessions, empty sessions, delegated parents, changed evidence, and exact
total/diagnostic requests. Each has a complete-reference answer and an expected fallback or work
counter. Timing-dependent tests use controlled clocks; native measurements are not CI fixtures.

## Deferred work — not prerequisites for this delivery

| ID | Item | Reopen only when |
| --- | --- | --- |
| D1 | Optional detail formatting from one semantic result | A separate performance slice is selected with a measured CPU/allocation target. The canonical seam is ready, but the split is not implemented. |
| D2 | General large-unit processing, retained-state budgets, low-memory qualification | A separately scoped capacity target and workload are chosen. Existing guards remain; no arbitrary-history or 4 GiB capacity claim is made by M0–M3. |
| D3 | Version-bound late detail, concurrent refresh generations, cache admission/eviction | A feature needs to reuse detail across changing evidence or retain concurrent generations. Existing late-detail freshness limitations stay documented. |
| D4 | Cross-process reuse, background service, broader query language, optimization across all sources | A concrete workload justifies a new product increment. |
| D5 | Unanchored usage, Claude tool-result error evidence, legacy duplicate edges | A separate semantic correction is selected with independent expected results. Structural parity does not certify these behaviors as correct. |
| D6 | Eight missing Gemini paths in the old scenario manifest | Closed on 2026-11-17: `.gitignore` unanchored `tmp/` had dropped `mock_data/.gemini/tmp/`. Anchored `/tmp/` and restored the eight sanitized Gemini fixture paths matching `scenarios.json`; `mock-data:validate` now passes across all 190 files. |

A deferred item becomes required only if it directly prevents an agreed acceptance journey or is
a regression caused by the new work. State that dependency explicitly; do not promote every
discovered issue into an architecture prerequisite.

## Stopping and reporting

- M0 ends with the verified foundation above. No more foundational refactoring is queued before M1.
- The proposed product delivery ends when M1–M3 meet their conditions. Further improvements go to
  deferred work rather than becoming another automatic phase.
- Each progress report names the milestone, completed acceptance conditions, remaining conditions,
  and any actual blocker. “One more cleanup” is not a new milestone.
- A material scope change must name what it adds, why existing acceptance cannot finish without
  it, and what is removed or deferred. Do not silently expand this checklist.
- Verification belongs to the final code state: run the repository gates after implementation,
  retain sanitized evidence, and report known limitations separately. Commit/release status is
  distinct from implementation and is not implied by a passing build.

M1 is approved and M2 is implemented and validated under the user's explicit compatibility constraint: preserve
command syntax, output, and semantics while replacing the old execution mechanism. SQL,
templates, CLI commands, shell commands, and v2 requests must converge on one logical executor;
remove the replaced selection paths. Independent input/output adapters do not justify duplicated
filtering, ordering, pagination, or a legacy execution fallback. M3 is the final completed milestone.


Final implementation checks: **624 package tests** and dependency boundaries passed (domain 103,
canonical 33, adapters 245, runtime 107, CLI 49, TUI 87). `build:lite` and governance passed
(13 governance tests; 5 rules, 110 rule-file matches). Standalone extraction and local npm
installation both executed SQL and the shipped selective template against complete reference rows.
The final artifact check used the final rebuilt package outputs. Mock-data layout/content checks
passed for all 151 files; full scenario validation still has the original eight missing Gemini
paths tracked in D6. No new milestone or prerequisite has been added. There is no remaining
required implementation work in this delivery; commits, publication, and D1–D6 are not implied.

Review follow-through: the shipped `skills/using-cchistory-lite/SKILL.md` now documents the
SQL/v3 entries, typed templates, coverage/totals and selective-read limits, and shell lifecycle.
Its direct SQL, v3 request and shell SQL/refresh/exit examples passed against sanitized fixtures;
skill format validation passed. Artifact verification now compares both the installed skill file
and `agent skill` output byte-for-byte with the repository source in standalone and npm installs.
This closes the reported release-documentation gap without changing runtime behavior or adding
a new milestone.

## Approved follow-up — first use and memory admission

The user's cold-agent trial exposed a separate, bounded defect slice after M0–M3. A directory
history query must not require a preliminary history scan just to discover the tool, and sample
or exact-reference reads must not escape resource admission. This reopens the relevant part of
D2; it does not promise arbitrary-history capacity or introduce a second query engine.

- [x] F1: Source discovery reads adapter/root metadata only. Explicit `--complete` retains the
  counted source report through the existing scan. Help gives a direct scoped query entry.
- [x] F2: Shell opening, help, invalid requests and exit do not prepare history. The first valid
  read prepares once; refresh publishes only on success; idle expiry still releases ownership.
- [x] F3: Remove the fixed 512 MiB floors, use process-available memory and remaining heap,
  initially accept a launch budget once (failed U1; superseded by G1), and apply resource checks to sample/exact reads. Admit SQLite
  result bytes before retrieving values; budget failures propagate instead of becoming empty data.
- [x] F4: Report observed sessions with unknown directory attribution and read losses alongside
  scoped results. Never widen scope automatically or describe resource refusal as an exact empty result.
- [x] F5: Align shipped skill, help, agent contract and guides; pass fixture-based regressions and
  repository/release gates. Record remaining capacity limits, then close implementation here.
- [ ] U1 (user-owned, manual; latest run delivered an artifact, quality not yet evaluated): An ordinary agent with no task context receives the original
  cclite-only directory-history-to-HTML-timeline request. The user dispatches and evaluates it
  independently. Do not automate this judgment, generate its timeline here, or mark it passed
  based on implementation tests. Evaluation-only restrictions are not new product restrictions.


F1–F5 implementation closed on 2026-09-07. Final `pnpm test` passed **634 package
tests** (domain 103, canonical 33, adapters 247, runtime 110, CLI 54, TUI 87) and
dependency boundaries. `build:lite`, governance (13 tests; 5 rules across 112 matches),
standalone extraction and local npm artifact checks passed. Shipped skill equality,
metadata-only discovery and skill format validation passed. Layout/content validation
passed for all 154 mock files; the same eight pre-existing Gemini scenario paths
remain D6. No new native measurement or low-memory capacity qualification was made.

U1 failed on 2026-09-08: the cold agent hit false tiny-memory refusals, repeatedly
changed resource settings and scope, and still OOMed. The timeline used partial
coverage. The previous F1–F5 tests did not validate macOS signal semantics or the
actual launcher's heap ownership. G1–G3 below corrected that defect; passing their gates does not mark U1 passed.

## Memory correction after failed U1 — finite scope

- [x] G1: Delete adaptive heap/re-exec policy from CLI, TUI and release launchers.
  Preserve Node defaults and explicit flags / NODE_OPTIONS. Use macOS free + inactive
  pages with unknown fallback; retain Linux MemAvailable / known cgroup headroom.
- [x] G2: Distinguish system estimate, remaining heap and limiting resource in errors.
  Remove advice to bypass the guard from routine error/agent guidance. Align the
  contract, shipped skill, guides and sanitized failure report with the one implementation.
- [x] G3: Validate OS-signal regressions, real launcher ownership (default and explicit
  settings, standalone and npm), guard-enabled fixture queries and repository/release gates.
  Record the remaining complete-container estimate limitation; close this correction here.

U1 remains the user-owned manual acceptance after G1–G3. No automatic cold-agent
judgment or timeline generation is part of this task. General container pushdown
and arbitrary-history capacity remain D2, not hidden follow-on implementation.
Changes remain uncommitted and unreleased.

G1–G3 closed on 2026-09-08. `pnpm test` passed **635 package tests** (domain 103,
canonical 33, adapters 247, runtime 111, CLI 54, TUI 87) and production dependency
boundaries. Build, governance (13 tests; 5 rules across 111 matches) and the final
standalone/local-npm artifact checks passed. Actual workspace and release entry
points preserved bare Node's default/explicit heap limits without adaptive children;
fixture SQL reads ran with the guard enabled. Skill validation and shipped-skill
equality passed. Mock layout/content checks passed for 156 files; the same eight
pre-existing Gemini scenario omissions remain D6. `git diff --check` passed.
The [sanitized failure/correction record](docs/research/2026-09-08-macos-memory-ownership.md)
includes aggregate local OS observations, the wrong initial assumption and remaining
capacity limits. No native full-query success or U1 acceptance is claimed.

## Independent-trial reassessment and 3.6 GiB observation — complete

The latest user report establishes artifact delivery; it does not establish complete
coverage or explain the SQL fallback. The skill's evaluation-specific timeline
workflow and alias example were removed. Runtime behavior was not specialized for
that task. Skill validation and standalone/local-npm shipped-skill checks passed.

A bounded Linux cgroup experiment used 3.6 GiB total hard memory, no swap and normal
Node/guard settings. Four distinct 2000-turn light reads succeeded with zero projection
issues; a full read was refused before parsing. The actual CLI's two-page SQL batch
reached all 2000 unique turns. Workload definitions, observed RSS (125.5–1018.4 MiB
for successful reads), guard refusal and limitations are in the
[capacity report](docs/research/2026-09-08-2000-turn-memory-capacity.md).
This qualifies those observations only. General D2 capacity work is not started by
this investigation, and U1 quality acceptance is not inferred from its results.
