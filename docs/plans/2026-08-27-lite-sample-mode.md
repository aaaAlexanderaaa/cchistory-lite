# Lite sample mode implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `cchistory-lite sample` — a bounded, latest-shaped preview (default 50 top-level sessions per source) that promotes delegated children to parents.

**Architecture:** Cheap catalog + cap live in `live-runtime`; path/sidecar clocks live in `source-adapters`; CLI reuses the `latest sessions` renderer and marks JSON `sampled: true`. No store. Do not change `latest` recency.

**Tech Stack:** TypeScript workspace packages, node:test, existing Lite CLI JSON v2.

**Design:** `docs/plans/2026-08-27-lite-sample-mode-design.md`

---

### Task 1: Cheap session catalog helpers (adapters)

**Files:**
- Modify: `packages/source-adapters/src/platforms/grok.ts` (summary last_active_at, session_kind, parent id; already has cwd preview)
- Modify: `packages/source-adapters/src/core/session-grouping.ts` (first-line cwd only when sample/dir skip does not need full-file scan)
- Modify: `packages/source-adapters/src/platforms/claude-code.ts` or a small `native-layout.ts` for sanitize-folder skip relative to `base_dir`
- Test: `packages/source-adapters/src/platforms/grok.test.ts`, `packages/source-adapters/src/core/session-grouping.test.ts`

**Step:** Tests first for: Grok child summary → parent id; Grok last_active_at without reading chat_history; Claude folder sanitize of `--dir` does not open other project trees; Codex first-line cwd matches `--dir` without streaming the rest of the file.

---

### Task 2: Sample scan planner (live-runtime)

**Files:**
- Modify: `packages/live-runtime/src/index.ts` (`ScanLiteHistoryOptions.sample?: { perSource: number }`)
- Test: `packages/live-runtime/src/index.test.ts`

**Step:** Fixture where the cheapest-clock files are all delegated children → sample of 1 returns the parent as the only top-level session and still parses the child as family evidence. Cap is per source. `orderSessionsByLastMessage` still applies inside the sample.

---

### Task 3: CLI `sample`

**Files:**
- Modify: `apps/lite-cli/src/index.ts` (command, help, default no `--dir`, reuse latest renderer + banner)
- Modify: `apps/lite-cli/src/json-v2.ts` (`sampled`, `sample_per_source`)
- Test: `apps/lite-cli/src/index.test.ts`

**Step:** `sample` / `sample 10` / `sample --json` / `sample --dir <fixture cwd>`. Human output matches latest session rows plus one sample banner. JSON has `sampled: true`. Existing `latest` tests unchanged.

---

### Task 4: Docs

**Files:**
- Modify: `README.md`, `docs/guide/lite.md`, `CHANGELOG.md`, `skills/using-cchistory-lite/SKILL.md`

**Step:** Document sample as a bounded latest preview, not a complete scan.

---

### Task 5: Verify

```bash
pnpm test
pnpm run verify:governance
```
