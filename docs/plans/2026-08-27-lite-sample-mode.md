# Lite scan, sample, and Grok usage implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Lite fast to iterate on a busy host, and make Grok usage/time come from native clocks instead of empty assistant rows.

**Architecture:** Cheap `--dir` rejection and sample selection live in `live-runtime` using adapter layout helpers (relative to each source `base_dir`, never hardcoded homes). Grok `updates.jsonl` is a sidecar parse stream for `turn_completed.usage` and unix timestamps. `sample` is a bounded latest-shaped preview. `latest` recency stays last-real-message.

**Tech Stack:** TypeScript workspace packages, node:test, Lite CLI JSON v2.

**Design:** `docs/plans/2026-08-27-lite-sample-mode-design.md`

---

## Scope (all of it)

1. Portable `--dir` skip (Claude/Factory project folders, Cursor transcript slugs, Codex first-line cwd).
2. `show session sess:…` probes the matching files only (no whole-source resolution scan).
3. `cchistory-lite sample [N]` — per-source cap of top-level sessions, parent promotion, latest-shaped output.
4. Grok `updates.jsonl`: token usage + real timestamps.

Out of scope: ranking `latest` by mtime; TUI sample; persistent index.

---

### Task 1: Directory-layout preview helpers

**Files:**
- Create: `packages/source-adapters/src/core/directory-preview.ts`
- Modify: `packages/source-adapters/src/platforms/grok.ts` (keep decode helper; preview can call shared API)
- Modify: `packages/source-adapters/src/index.ts` (export)
- Test: `packages/source-adapters/src/core/directory-preview.test.ts`

**Behavior:**
- `sanitizeClaudeProjectFolder(dir)` = replace `[^A-Za-z0-9]` with `-` (matches live `~/.claude/projects` names; `_` and `.` become `-`).
- `sourceFileMayMatchDirectoryScope({ platform, baseDir, filePath, directoryScope })` → `"yes" | "no" | "uncertain"`.
- Grok: decode `sessions/<encodeURIComponent(cwd)>/`; `"yes"` iff `pathMatchesDirectoryScope`.
- Claude / factory_droid: first path segment relative to `baseDir`; `"yes"` if folder === encode(scope) or starts with encode(scope)+`-`; else `"no"`. Files directly under `baseDir` → `"uncertain"`.
- Cursor / cursor_agent transcripts: `encodeCursorProjectDirectoryName`; sqlite/chat db → `"uncertain"`.
- Codex and everyone else → `"uncertain"` (must open).

No hardcoded `/root` or `~/.claude`. `--source-root` is just `baseDir`.

---

### Task 2: Use preview in live-runtime; Codex first-line cwd

**Files:**
- Modify: `packages/live-runtime/src/index.ts` (`scanSourceWithCollector`, `scanLogicalSessionGroups`)
- Modify: `packages/source-adapters/src/core/session-grouping.ts` (Codex stop after first non-empty jsonl line when collecting cwd)
- Test: `packages/source-adapters/src/core/session-grouping.test.ts` (Codex first-line cwd; a later `turn_context` cwd change is ignored for `--dir` preflight)
- Test: `packages/live-runtime/src/index.test.ts` (Claude `--dir` does not require opening other project folders — fixture with two project dirs)

---

### Task 3: Targeted `show session`

**Files:**
- Modify: `apps/lite-cli/src/index.ts` `runShowWithContext` — if ref is `sess:<platform>:<id>`, one scan with `sessionRefs: [ref]` (platforms already filtered by `exactCanonicalSessionPlatforms`). Do not scan the whole host first.
- Modify: `packages/source-adapters/src/core/probe.ts` `targetRefMatchesSession` and `packages/live-runtime/src/index.ts` group/payload targeting — unique `sess:<platform>:<prefix>` and native-id prefixes must locate the same files as a full id. After the probe, resolve the prefix through `getSession` and filter the payload to that canonical id plus delegated family.
- Test: `apps/lite-cli/src/index.test.ts` — show with `sess:` ref calls scan once with `sessionRefs`; `show session sess:openclaw:11111111` still returns outbound `automation_run` related work.
- Test: `packages/live-runtime/src/index.test.ts` — unique canonical prefixes target Codex logical sessions and OpenClaw related work.

---

### Task 4: Grok updates.jsonl usage + clocks

**Files:**
- Modify: `packages/source-adapters/src/core/token-usage.ts` — aliases `cachedReadTokens`, `reasoningTokens`
- Modify: `packages/source-adapters/src/platforms/grok.ts` — sidecar `updates.jsonl` pointer `updates`
- Modify: `packages/source-adapters/src/platforms/grok/runtime.ts` — parse `session/update` / `turn_completed.usage`; ignore other update kinds without loss-audit spam
- Modify: `packages/source-adapters/src/core/parser.ts` — interleave `turn_completed` after each user turn so existing token attribution works; map unix seconds *or* ms onto `observed_at`
- Test: `packages/source-adapters/src/platforms/grok.test.ts` — live-shaped chat_history **without** line timestamps + updates.jsonl `turn_completed.usage` → reply `token_usage.total_tokens`; two turns get two usage totals; session recency uses update/summary clocks not scan time
- Test: `packages/source-adapters/src/core/tokens.test.ts` if needed for aliases

---

### Task 5: Sample planner + CLI

**Files:**
- Modify: `packages/live-runtime/src/index.ts` — `sample?: { perSource: number }`
- Cheap rank: Grok `summary.json` `last_active_at` + `session_kind` / parent; Claude/Codex conversation file mtime
- Child → parse parent instead; parent fills one of N top-level slots
- Modify: `apps/lite-cli/src/index.ts` — command `sample [N]`, default N=50, default no `--dir`, reuse latest renderer + one banner
- Modify: `apps/lite-cli/src/json-v2.ts` — `sampled`, `sample_per_source`
- Test: live-runtime child-newest fixture; CLI sample json flag

---

### Task 6: Docs

**Files:** `README.md`, `docs/guide/lite.md`, `CHANGELOG.md`, `skills/using-cchistory-lite/SKILL.md`

---

### Task 7: Verify

```bash
cd /root/coding/cchistory-lite/.worktrees/adapter-parse-quality
pnpm test
pnpm run verify:governance
```
