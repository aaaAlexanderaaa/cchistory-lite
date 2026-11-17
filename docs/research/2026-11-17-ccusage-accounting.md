---
doc_type: evidence
status: current
authority: evidence
last_reconciled: 2026-11-18
---

# ccusage pricing and Codex accounting

The owner requested current model mappings, including `grok-4.6-build`, and a comparison
against ccusage after observing roughly 10% lower token totals than an API gateway. The gateway
records individual requests and uses flat pricing. Token coverage is the primary reconciliation
target; price coverage is a separate part of the same delivery. The verbatim request and
execution state live in [PLAN.md](../../PLAN.md).

## Upstream sources and paths

The inspected ccusage revision is
[`58866ba681343634ab6e5add61f18f3b70aa98f7`](https://github.com/ccusage/ccusage/tree/58866ba681343634ab6e5add61f18f3b70aa98f7),
with the published `ccusage` 20.0.51 binary used for the synthetic comparison.

| Concern | Upstream path and behavior | Lite owner |
| --- | --- | --- |
| Codex counters | `rust/adapters/codex/src/parser.rs`: `codex_token_count_usage`, normal cumulative/delta counters, repeated notifications and compaction request reconciliation | `source-adapters/src/platforms/codex/runtime.ts`, `canonical/src/codex-usage.ts` |
| Request identity | `parser.rs`: match `token_usage_record.payload.response_id` to `compacted.payload.compaction_response_id`; a normal cumulative advance can already cover local compaction | `canonical/src/codex-usage.ts` |
| Replay | `rust/adapters/codex/src/replay.rs`, `src/README.md`: inherited prefixes, fork boundaries and cross-file deduplication | Existing delegated-history ordinal evidence remains authoritative in Lite |
| Roots | `rust/adapters/codex/src/paths.rs`: active and archived session roots, compressed/plain preference | `source-adapters/src/platforms/codex.ts` |
| Prices | `rust/crates/ccusage-core/src/pricing.rs`: LiteLLM prices with models.dev fallback, provider/catalog rules, context rates and aliases | `canonical/src/model-pricing-catalog.ts`, `usage-pricing.ts` |
| Offline sources | `rust/crates/ccusage-pricing-snapshots/{build.rs,src/lib.rs}` and `flake.lock`: immutable LiteLLM revision plus committed models.dev prices/rules | `scripts/refresh-models-dev-pricing.mjs` |
| Grok usage | `rust/adapters/grok/src/parser.rs`: per-model `turn_completed` usage from session updates | Existing Grok adapter remains the input owner |

Paths in the final column are relative to `packages/` except the refresh script. The
[upstream Codex format notes](https://github.com/ccusage/ccusage/blob/58866ba681343634ab6e5add61f18f3b70aa98f7/rust/adapters/codex/src/README.md)
explain the distinction between per-call output, reasoning as a component of output, and
cumulative totals. Lite retains its option-B decomposition: uncached input + cache read +
cache creation + output. Reasoning already included in output contributes once.

## Pricing implementation

The bundled snapshot contains 2,562 priced models, refreshed on 2026-11-17. The baseline is
[models.dev/api.json](https://models.dev/api.json). Missing chat-model entries from direct
providers are filled from the exact
[LiteLLM revision pinned by ccusage](https://github.com/BerriAI/litellm/blob/9a1e3bde9453f9b1316790fc51e6c098d9447d7b/model_prices_and_context_window.json).
models.dev prices take precedence. Provider-prefixed model names and local overrides retain
the existing resolution order. CLI/TUI execution reads the bundled catalog entirely offline.

`grok-4.6-build` and `grok-4.7-build` are explicit local aliases to their matching public API
models, expressing API-equivalent estimates.
The [official xAI model page](https://docs.x.ai/developers/models/grok-4.6) lists $2 input,
$0.50 cached input and $6 output per million tokens; its
[release notes](https://docs.x.ai/developers/release-notes) document $4 / $1 / $12 above 200k
prompt tokens. Local price overrides express gateway-specific rates. The alias is a maintained
interpretation of the tool-facing name; models.dev and LiteLLM list the base model.

The 2026-11-18 follow-up verified [Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)
and added its Build alias. `grok-4.7-build-fast` has its own official-price supplement from
[xAI pricing](https://docs.x.ai/developers/pricing): $4 / $1 / $12 per million input/cache/output
below the context threshold, and $6 / $1.50 / $18 above 200k prompt tokens. `grok-4.7-fast`
aliases that Fast entry. The generator records this third source and preserves any matching
upstream entry; local overrides keep their priority. A cost regression exercises both sides of
the threshold to keep the standard and Fast variants distinct.

The refresh retains context tiers and converts LiteLLM per-token USD to USD per million tokens.
Rate selection uses each recorded native call's full input, including cached input, before
summing rows. A daily or model aggregate never triggers a context tier. Turn-only evidence
retains base-rate estimates because its individual request sizes are unavailable. Native
service-tier prices and historical price schedules remain explicit local calibration inputs.

Manual refresh:

```sh
node scripts/refresh-models-dev-pricing.mjs --update-builtin
```

For a reproducible offline refresh, supply the two downloaded public JSON inputs:

```sh
node scripts/refresh-models-dev-pricing.mjs \
  --from-file /path/to/models-dev-api.json \
  --litellm-file /path/to/litellm-prices.json --update-builtin
```

`--out /path/to/pricing.json` emits an existing-format local pricing override instead of replacing
the bundled catalog. Input JSON and the generator tests are isolated from native history.

## Token repairs and consumer behavior

Previously, Codex usage was largely recovered through assistant text replies. A session with
model calls and zero user turns had no path into aggregate usage. Tool-only and interrupted
work could also lack a reply. Compaction request records were unsupported. A cumulative-only
`token_count` was parsed but omitted from the emitted usage fragments. Last-only records were
assumed to be turn checkpoints rather than independent calls.

The adapter now retains counters and request identity at its parse boundary. Canonical resolves
independent calls using the existing session `usage_events` contract, assigns each call to its
own user turn or `null`, and includes every retained call in session/aggregate usage. Compaction
request IDs match markers in either order. Matching cumulative usage covers a local compaction
once; a remote compaction adds its separate request. Existing branch/checkpoint regressions and
explicit inherited-history ordinals remain covered. Growing checkpoints retain one call owner and its complete usage; the first observed checkpoint
anchors its timestamp. Append refreshes reconstruct the same call identities and totals as a fresh read.

Independent calls carry their recorded model and timestamp into all statistic dimensions.
Midnight and date filters follow request activity; user-turn counts still deduplicate actual
user submissions. Default discovery includes archived history when that directory exists.
Active copies take precedence over archive copies of the same relative rollout path.
An explicit `sessions` root retains its requested scope. The existing CLI/TUI layout is retained.

## Equal-input observations

The synthetic corpus in `mock_data/fixtures/codex-accounting/` was read by ccusage 20.0.51 with
`codex daily --offline --timezone UTC --speed standard --json`. `CODEX_HOME` pointed at a temporary
home containing copies of those synthetic JSONL files under `sessions/`. Its output is committed
as `mock_data/fixtures/ccusage-20.0.51.json`, outside the native-input directory. Lite's built `runLiteCli` entrypoint used an empty temporary home,
the fixture source root, `--no-dir`, UTC, and model/day grouping. This isolated verification
returned zero read warnings and zero projection issues.

| Measure | ccusage 20.0.51 | Lite |
| --- | ---: | ---: |
| Total tokens | 200,312 | 200,312 |
| Uncached input | 50,151 | 50,151 |
| Cache read | 150,110 | 150,110 |
| Output | 51 | 51 |
| Reasoning, already inside output | 12 | 12 |
| Nov 16 / Nov 17 tokens | 120 / 200,192 | 120 / 200,192 |
| API-equivalent USD | 0.3505255 | 0.3505255 |

The runtime regression compares the golden token components and cost, checks each dimension's
sum, date filtering, nullable turn references and zero projection issues. Existing interleaved
and inherited checkpoints, embedded reply usage and appended JSONL are separate regression inputs.

A native observation used one guarded CLI read of the existing active-session scope. A temporary
module loader ran the prior HEAD `03d5752` interpreter and changed interpreter against each identical borrowed
in-memory atom set. The old interpreter's input omitted cumulative-only fragments newly admitted
by the adapter and reconstructed the prior adapter's checkpoint deltas from the same raw counters. Results were keyed by session ID to account for repeated interpretation during
preparation. Native files remained read-only; the harness and private output stayed outside the
repository. This comparison measures interpretation on the observed readable corpus.

| Same native evidence | Observed value |
| --- | ---: |
| Sessions / real user turns | 66 / 102 |
| Prior logic tokens | 603,577,610 |
| Changed logic tokens | 681,222,584 |
| Recovered tokens | 77,644,974 |
| Calls without a user turn | 71,896,003 recovered tokens |
| Separate compaction requests | 6,208,543 recovered tokens across 14 calls |
| Normal counter reconciliation | −459,572 tokens net adjustment in the remaining assigned counters |

The recovered calls, compactions and normal-counter correction sum to the observed difference. Prior accounting missed
11.40% of the corrected total on this corpus. The read retained 83 unsupported response-item warnings and zero projection
issues. The final inherited-summary guard was active; this native corpus contained zero inherited
generic embedded-usage records. Earlier reads observed fewer child-session calls as the active
work continued; each reported pair used identical in-memory evidence internally. The owner's remote server still needs the matching gateway request records and date
range to establish its exact remaining delta. Earlier sequential native reads changed while the
active chat continued; the equal-input comparison above replaces them for causal attribution.

## Independent review

The first fresh-context reviewer reproduced these initial findings on synthetic evidence:

- Counter reset: 120 versus ccusage 131 tokens; unchanged cumulative totals with changed last
  usage: 180 versus 120.
- A completed remote compaction consumed a later equal-sized normal call: 131 versus 251.
- An active rollout copied into the archive was counted twice: 240 versus 120.
- Embedded usage from an earlier user turn vanished from the event-backed session total:
  aggregate 131 versus session total 11.

Fixes moved counter/checkpoint state entirely into canonical, retained unchanged-total and reset
semantics alongside the existing branch fixtures, closed compaction matching at the completion
marker, selected active native copies before read planning, and confined embedded-summary
supersession to its own user turn and message record. The original reviewer reran the same
reproductions: 131 / 120 / 251 / 120 tokens and the embedded 131 aggregate/session total all
matched the intended evidence, with zero projection issues. Inline counter model metadata was
also retained. The audit now checks positive turns missing assigned events in an otherwise
independent-event-backed session. The second fresh-context review found and reproduced a later counter reset reusing a prior
baseline, empty-content embedded usage, and context pricing based on checkpoint increments.
Those fixes clear prior request owners on a reset, retain text-less embedded calls, and merge
growing checkpoints into one complete call before pricing. The exact reproductions then returned
251 tokens, 120 tokens with own/null turn, and 250,002 tokens / one call / $1.000024 respectively.
A follow-up inherited-summary case initially returned 251 versus 131 tokens; preserving and
checking the inherited flag keeps the replay on its parent and the child's own 11-token call
on the child. These initial findings remain preserved alongside their fixes. Final re-verification
and gates are recorded in PLAN.md.

## Remaining coverage and verification

ccusage additionally handles compressed `.jsonl.zst` rollouts, more replay heuristics, Codex
service tiers and historical pricing schedules. This slice retains Lite's plain JSON/JSONL source
support and explicit inherited-history metadata. Those upstream capabilities remain separate
adapter/price coverage, and comparisons should use the same roots, timezone, dates and formats.

Final checks completed on 2026-11-18 with Node 22.23.5 / pnpm 10.30.3: build, 735 package tests and four catalog
refresh tests, governance and the extracted/installable Lite artifact. Fixture validation covered
197 files. The first artifact attempt hit npm cache `EPERM`; the complete rerun used a temporary
cache and passed. Both original reviewer contexts confirmed their findings resolved in the same
reproductions. [PLAN.md](../../PLAN.md) records execution status and owner direction. Synthetic equality
establishes the listed counter/compaction shapes. Native observations establish the described
readable local corpus; the remote gateway owns its per-request comparison.
