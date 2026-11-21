import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProjectIdentity,
  SessionFamilyProjection,
  SessionProjection,
  SessionUsageEvent,
  SourceStatus,
  UserTurnProjection,
} from "@cchistory/domain";
import { normalizeToolTargetSignature } from "./tool-call-summary.js";
import { computeUsageBreakdown } from "./usage-breakdown.js";
import { buildSessionTraceReport } from "./usage-trace.js";

function makeSource(): SourceStatus {
  return {
    id: "src-claude",
    slot_id: "claude_code",
    family: "local_coding_agent",
    platform: "claude_code",
    display_name: "Claude Code",
    base_dir: "/mock/.claude",
    host_id: "host-1",
    last_sync: "2026-11-20T14:00:00.000Z",
    sync_status: "healthy",
    total_blobs: 2,
    total_records: 40,
    total_fragments: 80,
    total_atoms: 80,
    total_sessions: 2,
    total_turns: 2,
  };
}

function makeProject(): ProjectIdentity {
  return {
    project_id: "proj-1",
    project_revision_id: "proj-1:r1",
    display_name: "prod-api",
    slug: "prod-api",
    linkage_state: "committed",
    confidence: 1,
    link_reason: "repo_root_match",
    manual_override_status: "none",
    source_platforms: ["claude_code"],
    host_ids: ["host-1"],
    committed_turn_count: 2,
    candidate_turn_count: 0,
    session_count: 2,
    created_at: "2026-11-20T14:00:00.000Z",
    updated_at: "2026-11-20T14:20:00.000Z",
  };
}

function makeTurn(id: string, sessionId: string, createdAt: string, text: string, totalTokens: number): UserTurnProjection {
  return {
    id,
    turn_id: id,
    revision_id: `${id}:r1`,
    turn_revision_id: `${id}:r1`,
    user_messages: [],
    raw_text: text,
    canonical_text: text,
    display_segments: [{ type: "text", content: text }],
    created_at: createdAt,
    submission_started_at: createdAt,
    last_context_activity_at: createdAt,
    session_id: sessionId,
    source_id: "src-claude",
    project_id: "proj-1",
    link_state: "committed",
    sync_axis: "current",
    value_axis: "active",
    retention_axis: "keep_raw_and_derived",
    context_ref: `ctx:${id}`,
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 1,
      total_tokens: totalTokens,
      primary_model: "claude-sonnet-4-5",
      has_errors: false,
    },
    lineage: { atom_refs: [], candidate_refs: [], fragment_refs: [], record_refs: [], blob_refs: [] },
  };
}

test("normalizeToolTargetSignature masks secrets and clusters dynamic pod/hex IDs", () => {
  const secretCmd = normalizeToolTargetSignature("Bash", {
    command: `curl -H "Authorization: Bearer sk-${"A".repeat(24)}" https://api.example.com/v1/pods`,
  });
  assert.ok(secretCmd.target_signature);
  assert.doesNotMatch(secretCmd.target_signature, /sk-AAAA/u);
  assert.doesNotMatch(secretCmd.sample ?? "", /sk-AAAA/u);

  const pod1 = normalizeToolTargetSignature("Bash", {
    command: "cd /srv/app && kubectl get pod api-7f8a9b2c-xk2pq -n prod",
  });
  const pod2 = normalizeToolTargetSignature("Bash", {
    command: "kubectl get pod api-9e1d4c3a-mn8rt -n prod",
  });
  assert.equal(pod1.target_signature, pod2.target_signature);
  assert.match(pod1.target_signature ?? "", /^kubectl get pod api-<id> -n prod$/u);
});

test("diagnostics detects cache-miss causes, polling loops, context bloat, error loops, and isolates sidecar threads", () => {
  const mainSessionId = "sess:claude_code:main-1";
  const childSessionId = "sess:claude_code:child-1";
  const turn1 = makeTurn("turn-1", mainSessionId, "2026-11-20T14:00:00.000Z", "Investigate prod OOM", 0);
  const turn2 = makeTurn("turn-2", mainSessionId, "2026-11-20T14:30:00.000Z", "Check unrelated status", 0);

  const mainEvents: SessionUsageEvent[] = [
    // #1 cold start
    {
      id: "e1",
      seq: 1,
      turn_id: "turn-1",
      created_at: "2026-11-20T14:00:01.000Z",
      model: "claude-sonnet-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000, output_tokens: 300, total_tokens: 20_400 },
      emitted_tool_calls: [{ tool_name: "Bash", target_signature: "kubectl logs api-<id>", status: "success", duration_ms: 1200, output_bytes: 96 * 1024, call_id: "c1" }],
    },
    // #2 giant output -> context bloat (+30K ctx)
    {
      id: "e2",
      seq: 2,
      turn_id: "turn-1",
      created_at: "2026-11-20T14:00:05.000Z",
      model: "claude-sonnet-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 30_000, output_tokens: 200, total_tokens: 50_300 },
      preceding_tool_results: [{ tool_name: "Bash", target_signature: "kubectl logs api-<id>", status: "success", duration_ms: 1200, output_bytes: 96 * 1024, call_id: "c1" }],
      emitted_tool_calls: [{ tool_name: "Bash", target_signature: "npm test", status: "success", duration_ms: 370_000, output_bytes: 2048, call_id: "c2" }],
    },
    // Interleaved sidecar subagent call at 14:01:00 (15K ctx, 0% hit) — must NOT corrupt main thread continuity!
    {
      id: "e-sidecar-1",
      seq: 3,
      turn_id: null,
      subagent_key: "agent-explore-1",
      created_at: "2026-11-20T14:01:00.000Z",
      model: "claude-sonnet-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 15_000, output_tokens: 400, total_tokens: 15_500 },
    },
    // #3 idle TTL cache miss (6m12s after #2)
    {
      id: "e3",
      seq: 4,
      turn_id: "turn-1",
      created_at: "2026-11-20T14:06:17.000Z",
      model: "claude-sonnet-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 52_000, output_tokens: 250, total_tokens: 52_350 },
      preceding_tool_results: [{ tool_name: "Bash", target_signature: "npm test", status: "success", duration_ms: 370_000, output_bytes: 2048, call_id: "c2" }],
      emitted_tool_calls: [{ tool_name: "Bash", target_signature: "kubectl get pod api-<id>", status: "success", duration_ms: 400, output_bytes: 512, call_id: "p1" }],
    },
    // #4..#7 tight polling loop (4 repeats in 40s, high cache hit)
    ...[1, 2, 3, 4].map((n): SessionUsageEvent => ({
      id: `e-poll-${n}`,
      seq: 4 + n,
      turn_id: "turn-1",
      created_at: `2026-11-20T14:06:${String(20 + n * 8).padStart(2, "0")}.000Z`,
      model: "claude-sonnet-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 500, output_tokens: 150, total_tokens: 52_750 },
      preceding_tool_results: [{ tool_name: "Bash", target_signature: "kubectl get pod api-<id>", status: "success", duration_ms: 400, output_bytes: 512, call_id: `p${n}` }],
      emitted_tool_calls: n < 4 ? [{ tool_name: "Bash", target_signature: "kubectl get pod api-<id>", status: "success", duration_ms: 400, output_bytes: 512, call_id: `p${n + 1}` }] : [],
    })),
    // #8 short-gap prefix invalidation (3s later, same model, same context, 0% hit)
    {
      id: "e-prefix",
      seq: 9,
      turn_id: "turn-1",
      created_at: "2026-11-20T14:06:55.000Z",
      model: "claude-sonnet-4-5",
      token_usage: { input_tokens: 53_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 200, total_tokens: 53_200 },
    },
    // #9 model switch miss
    {
      id: "e-switch",
      seq: 10,
      turn_id: "turn-1",
      created_at: "2026-11-20T14:07:05.000Z",
      model: "claude-opus-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 54_000, output_tokens: 300, total_tokens: 54_400 },
    },
    // #10 compaction miss
    {
      id: "e-compact",
      seq: 11,
      turn_id: "turn-1",
      created_at: "2026-11-20T14:07:15.000Z",
      model: "claude-opus-4-5",
      compaction_before: true,
      token_usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 18_000, output_tokens: 200, total_tokens: 18_300 },
    },
    // #11..#13 consecutive tool error loop
    ...[1, 2, 3].map((n): SessionUsageEvent => ({
      id: `e-err-${n}`,
      seq: 11 + n,
      turn_id: "turn-1",
      created_at: `2026-11-20T14:07:${String(20 + n * 5).padStart(2, "0")}.000Z`,
      model: "claude-opus-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 18_000, cache_creation_input_tokens: 500, output_tokens: 150, total_tokens: 18_750 },
      preceding_tool_results: [{ tool_name: "Bash", target_signature: "pytest tests/api.py", status: "error", duration_ms: 500, output_bytes: 800, call_id: `err-${n}` }],
    })),
    // #14..#16 non-loop spread out `git status` calls across >10 min gaps in different turns
    {
      id: "e-git-1",
      seq: 15,
      turn_id: "turn-2",
      created_at: "2026-11-20T14:30:01.000Z",
      model: "claude-sonnet-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 19_000, cache_creation_input_tokens: 200, output_tokens: 100, total_tokens: 19_400 },
      emitted_tool_calls: [{ tool_name: "Bash", target_signature: "git status", status: "success", duration_ms: 50, call_id: "g1" }],
    },
  ];

  const childEvents: SessionUsageEvent[] = [
    {
      id: "c-e1",
      seq: 1,
      turn_id: null,
      created_at: "2026-11-20T14:02:00.000Z",
      model: "claude-sonnet-4-5",
      token_usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000, output_tokens: 500, total_tokens: 40_600 },
    },
  ];

  const mainSession: SessionProjection = {
    id: mainSessionId,
    source_id: "src-claude",
    source_platform: "claude_code",
    host_id: "host-1",
    title: "Investigate prod OOM",
    canonical_title: "Investigate prod OOM",
    created_at: "2026-11-20T14:00:00.000Z",
    updated_at: "2026-11-20T14:30:05.000Z",
    turn_count: 2,
    model: "claude-sonnet-4-5",
    primary_project_id: "proj-1",
    sync_axis: "current",
    usage_events: mainEvents,
  };
  const childSession: SessionProjection = {
    id: childSessionId,
    source_id: "src-claude",
    source_platform: "claude_code",
    host_id: "host-1",
    title: "Explore logs",
    canonical_title: "Explore logs",
    created_at: "2026-11-20T14:02:00.000Z",
    updated_at: "2026-11-20T14:02:05.000Z",
    turn_count: 0,
    model: "claude-sonnet-4-5",
    primary_project_id: "proj-1",
    sync_axis: "current",
    usage_events: childEvents,
  };

  const family: SessionFamilyProjection = {
    parent_session_ref: mainSessionId,
    source_id: "src-claude",
    source_platform: "claude_code",
    child_count: 1,
    parent: { storage_bytes: 1000, blob_count: 1, turn_count: 2, assistant_reply_count: 2, tool_call_count: 6, tool_success_count: 3, tool_error_count: 3, tool_pending_count: 0 },
    combined: { storage_bytes: 1500, blob_count: 2, turn_count: 2, assistant_reply_count: 2, tool_call_count: 6, tool_success_count: 3, tool_error_count: 3, tool_pending_count: 0 },
    children: [{
      id: "child-link-1",
      identity_kind: "session",
      parent_session_ref: mainSessionId,
      child_session_ref: childSessionId,
      source_id: "src-claude",
      source_platform: "claude_code",
      agent_key: "explore",
      title: "Explore logs",
      created_at: "2026-11-20T14:02:00.000Z",
      updated_at: "2026-11-20T14:02:05.000Z",
      origin_paths: [],
      stats: { storage_bytes: 500, blob_count: 1, turn_count: 0, assistant_reply_count: 0, tool_call_count: 0, tool_success_count: 0, tool_error_count: 0, tool_pending_count: 0 },
    }],
  };

  const sourceData = {
    listResolvedTurns: () => [turn1, turn2],
    listResolvedSessions: () => [mainSession, childSession],
    listSources: () => [makeSource()],
    listProjects: () => [makeProject()],
    listSessionFamilies: () => [family],
    listRelatedWork: () => [],
  };

  const breakdown = computeUsageBreakdown({
    ...sourceData,
    filters: { timezone: "UTC" },
  });
  const diag = breakdown.diagnostics;
  assert.ok(diag);

  // Bimodal cache distribution separates healthy (>=90%) from cold/miss (<50%)
  const healthy = diag.cache_distribution.buckets.find((b) => b.bucket === "healthy")!;
  const cold = diag.cache_distribution.buckets.find((b) => b.bucket === "cold_or_miss")!;
  assert.ok(healthy.call_count >= 7);
  assert.ok(cold.call_count >= 6);
  assert.ok((cold.zero_hit_call_count ?? 0) >= 6);

  // Role split separates main thread from BOTH delegated child session and sidecar subagent!
  assert.equal(diag.role_split.main.session_count, 1);
  assert.equal(diag.role_split.subagents.session_count, 2);
  assert.equal(diag.role_split.subagents.call_count, 2);

  // Family rollup combines parent + both subagents under mainSessionId
  assert.equal(diag.families.length, 1);
  assert.equal(diag.families[0]?.subagent_count, 2);
  assert.equal(diag.families[0]?.subagent_calls, 2);

  // Check all 4 cache-miss causes + context_bloat + polling_loop + tool_error_loop
  const missByEvent = new Map(
    diag.anomalies.filter((a) => a.kind === "cache_miss_cliff").map((a) => [a.call_seq, a.evidence.miss_cause]),
  );
  assert.equal(missByEvent.get(4), "idle_ttl_gap", "sidecar at #3 must not mask the 6m12s idle gap between #2 and #4");
  assert.equal(missByEvent.get(9), "prefix_invalidation");
  assert.equal(missByEvent.get(10), "model_switch");
  assert.equal(missByEvent.get(11), "compaction");

  assert.ok(diag.anomalies.some((a) => a.kind === "context_bloat" && a.call_seq === 2));
  assert.ok(diag.anomalies.some((a) => a.kind === "polling_loop" && a.evidence.target_signature === "kubectl get pod api-<id>"));
  assert.ok(diag.anomalies.some((a) => a.kind === "tool_error_loop"));
  assert.equal(diag.loops.some((l) => l.target_signature === "git status"), false);

  // Single-session trace report
  const trace = buildSessionTraceReport(sourceData, {
    sessionId: mainSessionId,
    includeSubagents: false,
    filters: { timezone: "UTC" },
  });
  assert.ok(trace);
  assert.equal(trace.usage_granularity, "call");
  assert.equal(trace.family.length, 3, "main + 1 delegated child + 1 sidecar subagent");
  assert.equal(trace.turns.length, 3, "T1 + T2 + unanchored sidecar bucket");
  assert.equal(trace.min_cache_hit_ratio, 0);

  // Verify --only-anomalies filtering on trace
  const anomaliesOnlyTrace = buildSessionTraceReport(sourceData, {
    sessionId: mainSessionId,
    onlyAnomalies: true,
    filters: { timezone: "UTC" },
  });
  assert.ok(anomaliesOnlyTrace);
  assert.ok(anomaliesOnlyTrace.calls.length > 0);
  assert.ok(anomaliesOnlyTrace.calls.length < trace.calls.length);
  assert.ok(anomaliesOnlyTrace.calls.every((c) => c.anomaly_kinds.length > 0 || c.cache_status === "miss"));
  assert.ok(anomaliesOnlyTrace.calls.some((c) => c.anomaly_kinds.includes("polling_loop")));
});

test("buildSessionTraceReport honestly reports turn granularity when session has no per-call usage_events", () => {
  const sessionId = "sess:cursor:turn-only";
  const turn = makeTurn("turn-cursor", sessionId, "2026-11-20T14:00:00.000Z", "Legacy turn", 5000);
  const session: SessionProjection = {
    id: sessionId,
    source_id: "src-claude",
    source_platform: "cursor",
    host_id: "host-1",
    title: "Turn only",
    created_at: "2026-11-20T14:00:00.000Z",
    updated_at: "2026-11-20T14:00:00.000Z",
    turn_count: 1,
    sync_axis: "current",
  };
  const trace = buildSessionTraceReport(
    {
      listResolvedTurns: () => [turn],
      listResolvedSessions: () => [session],
      listSources: () => [makeSource()],
      listProjects: () => [makeProject()],
    },
    { sessionId },
  );
  assert.ok(trace);
  assert.equal(trace.usage_granularity, "turn");
  assert.equal(trace.total_calls, 1);
});
