# Initial query cost baseline

Date: 2026-09-05. Stage: initial 0.4.4 working tree anchored at `2a36d1e`, before shared file planning
and preparation metadata reuse. See the [research index](README.md) for environment and redaction
policy. All timings below are individual instrumented observations, not medians or percentiles.

## Method

The installed CLI resolved to the workspace build. The pinned pnpm bootstrap initially failed
before compilation; direct builds with the existing TypeScript compiler succeeded in dependency
order. No dependency installation or configuration change was needed for these observations.

An external harness called the real `runLiteCli` through its dependency-injection boundary and
delegated scans to the real runtime. It preserved adaptive startup and native scan guards,
recorded progress events, and wrapped query methods for timing. Optional module-load hooks timed
named functions without editing repository source or retaining extra source object graphs.

A supervisor sampled process-tree RSS roughly every 150 ms plus process-list overhead, with
90-second total, 25-second no-progress, 1.5 GiB sampled-RSS, and 32 MiB output ceilings. It owned
the process group and used TERM followed by KILL for shutdown. These are supervisory limits, not
a hard memory quota. The initial sandbox attempt could not inspect processes and cleaned up its
child; it is excluded from source results. Later observations had process-inspection permission.

Short scans can finish between RSS samples; their memory is **unobserved**, not zero. Reported
source bytes come from file-size progress events, not physical disk-I/O counters. They omit some
preparation and companion reads and do not account for OS cache hits. Phase timings are inclusive
and must not be added as if disjoint. No filesystem write tracer or allocation profiler was run
in this initial round.

## Observations

"Scoped" means one project-directory scope with its identity removed. "Cross-project" means the
same adapter over a broader scope. The table retains unsuccessful and deliberately stopped cases.

| Journey | Scan ms | Parsed files | Sampled process-tree RSS MiB | Exit |
| --- | --- | --- | --- | --- |
| Claude cross-project sample 2 | 47.6 | 2 | unobserved | 0 |
| Claude scoped sample 2 | 12.9 | 0 | unobserved | 0 |
| Codex exact session detail | 437.5 | 1 | 458.5 | 0 |
| Codex cross-project sample 10 | 259.3 | 10 | 207.3 | 0 |
| Codex scoped latest 1 | 334.0 | 4 | 198.8 | 0 |
| Codex scoped latest 10 | 344.2 | 4 | 210.4 | 0 |
| Codex with detailed phase hooks | 405.1 | 4 | 194.6 | 0 |
| Codex scoped sample 2 | 212.8 | 2 | 158.0 | 0 |
| Codex shell, distinct searches | 360.0 | 4 | 209.9 | 0 |
| Codex shell, initial build and refresh | 344.8, 290.7 | 4, 4 | 235.1 | 0 |
| Codex shell, browse then replies | 350.3, 296.7 | 4, 4 | 238.4 | 0 |
| Codex shell, repeated warm queries | 355.1 | 4 | 208.6 | 0 |
| Grok sample 2 | 4.3 | 0 | unobserved | 0 |
| Mixed sources, file cap 1 per source | incomplete | 5 | 679.8 | 128 |
| Mixed-source preflight-only diagnostic | incomplete | 0 | unobserved | 1 |

The mixed-source run failed with V8 OOM while processing a ZCode container. The last source-size
event reported 321,089,536 bytes, approximately 306.2 MiB, with a roughly 512 MiB child heap cap.
A subsequent preflight-only diagnostic recorded a 30-byte estimate for that source and deliberately
exited before any payload parsing. The generic root walk and adapter discovery had selected
different files: a small root file versus the database in the adapter's subdirectory. Changing a
multiplier cannot correct that selection mismatch. This explains one concrete guard defect, not
every possible OOM cause. The [file-plan implementation](../design/2026-09-05-bounded-query-model.md#first-implementation-boundary)
subsequently addressed the mismatch.

The latest 1 and latest 10 cases both parsed the same four files and found three top-level nonempty
sessions. The result limit was not passed down as a top-N preparation requirement. Exact totals,
family fields, and exhaustive diagnostics also constrain when preparation can end.

One deeply instrumented scoped query enumerated 415 candidates twice and inspected metadata for
415 candidates twice, taking about 271 ms across the two metadata inspections. Risk assessment
took about 167 ms, including one of those inspections; final snapshot materialization took about
1.9 ms. Twelve contexts were constructed and zero retained in `none` mode. Subsequent investigation
clarified that the assistant-reference search branch was inactive; see the
[semantic/detail contract](../design/2026-09-05-semantic-detail-boundary.md#search-and-masking).

## Query journeys and missing coverage

| Journey | Required meaning | Evidence and limits |
| --- | --- | --- |
| Latest one versus ten | Top-level nonempty sessions, last-real-message order, stable ties | Same four parsed files; exact total returned |
| Search and refine | Existing canonical user-text/title/path matching | Five ordinary shell queries shared one build |
| Distinct and repeated searches | Stable generation and bounded query state | Twelve distinct searches plus a repeat shared one build; distinct queries took about 0.06–1.20 ms, repeat about 0.001 ms; twelve complete ranking-cache entries remained |
| Related work | Child addressability without duplicate top-level rows | Delegated relationships present; completed snapshots had zero projection issues |
| Exact session detail | Exact identity and complete targeted evidence | One parsed file, six returned turns; discovery still incurred work; process roles within the tree were not individually traced |
| Turn replies after browsing | Correct identity and generation | Initial `none` and subsequent `matching` scans each parsed four files; one context retained on the second scan |
| Refresh | Consistent replacement and freshness | Two full builds; no source mutation induced, so append/delete/truncate/failure behavior was not established |
| Scope changes | Correct directory/source selection | Broader previews had data; the scoped Claude result was empty; no shared-scope reuse proof |
| Usage slice | Canonical option-B totals; unknown differs from zero | Code contract inspected; native aggregate parity not measured in this round |
| Container under a file cap | Honest resource and completeness behavior | OOM followed by preflight-only evidence of the selection mismatch |
| Exit, idle, interruption | Release ownership without interrupting active work on idle expiry | Explicit exit observed; no idle expiry by code inspection; supervisor cleaned process groups |

The warm-query figures are too small and too few to define an SLO or a cache-growth slope. Native
sessions could continue changing in their original applications; small cross-run output changes
were not classified as refresh bugs. No native corruption, deletion, truncation, or append was
manufactured. Loss audits remained visible and are distinct from projection issues.

This baseline supports sharing preparation before choosing query syntax. It does not establish
maximum history capacity, a default idle timeout, an eviction policy, cross-source completeness,
or sublinear first-read latest queries. The broader code survey is [recorded separately](2026-09-05-source-capabilities.md).
