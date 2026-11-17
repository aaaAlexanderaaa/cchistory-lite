import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectIdentity, SessionProjection, SourceStatus, UserTurnProjection } from "@cchistory/domain";
import {
  computeUsageBreakdown,
  computeUsageMatrix,
  computeUsageOverview,
  computeUsageRollup,
  parseDateOrRelativeStart,
  parseUsagePricingInput,
  resolveModelPricing,
  resolveTimeWindowBounds,
  resolveWeekBucket,
} from "./index.js";

function createSource(overrides: Partial<SourceStatus> = {}): SourceStatus {
  const slotId = overrides.slot_id ?? "antigravity";
  return {
    id: overrides.id ?? `src-${slotId}`,
    slot_id: slotId,
    family: "local_runtime_sessions",
    platform: overrides.platform ?? "antigravity",
    display_name: overrides.display_name ?? "Antigravity",
    base_dir: overrides.base_dir ?? "/workspace/.gemini/antigravity",
    host_id: overrides.host_id ?? "host-test",
    last_sync: "2026-11-17T00:00:00.000Z",
    sync_status: "healthy",
    total_blobs: 1,
    total_records: 1,
    total_fragments: 1,
    total_atoms: 1,
    total_sessions: 1,
    total_turns: 1,
    ...overrides,
  };
}

function createProject(id: string, name: string): ProjectIdentity {
  return {
    project_id: id,
    project_revision_id: `${id}:r1`,
    display_name: name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
    linkage_state: "committed",
    confidence: 1,
    link_reason: "repo_root_match",
    manual_override_status: "none",
    primary_workspace_path: `/workspace/${name.toLowerCase()}`,
    source_platforms: ["antigravity"],
    host_ids: ["host-test"],
    committed_turn_count: 1,
    candidate_turn_count: 0,
    session_count: 1,
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-17T00:00:00.000Z",
    project_last_activity_at: "2026-11-17T00:00:00.000Z",
  };
}

function createSession(source: SourceStatus, overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    id: overrides.id ?? `session-${source.slot_id}`,
    source_id: source.id,
    source_platform: source.platform,
    host_id: source.host_id,
    title: overrides.title ?? "Usage test session",
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-17T00:00:00.000Z",
    turn_count: 1,
    model: overrides.model ?? "gemini-4-carbon",
    working_directory: overrides.working_directory ?? "/workspace/alpha",
    sync_axis: "current",
    ...overrides,
  };
}

function createTurn(
  source: SourceStatus,
  session: SessionProjection,
  overrides: Partial<UserTurnProjection> = {},
): UserTurnProjection {
  const id = overrides.id ?? "turn-1";
  const startedAt = overrides.submission_started_at ?? "2026-11-16T10:00:00.000Z";
  return {
    id,
    revision_id: `${id}:r1`,
    turn_id: id,
    turn_revision_id: `${id}:r1`,
    user_messages: [
      {
        id: `msg-${id}`,
        raw_text: "Prompt",
        canonical_text: "Prompt",
        display_segments: [{ type: "text", content: "Prompt" }],
        sequence: 0,
        is_injected: false,
        created_at: startedAt,
        atom_refs: [`atom-${id}`],
      },
    ],
    raw_text: "Prompt",
    canonical_text: "Prompt",
    display_segments: [{ type: "text", content: "Prompt" }],
    created_at: startedAt,
    submission_started_at: startedAt,
    last_context_activity_at: startedAt,
    session_id: session.id,
    source_id: source.id,
    project_id: overrides.project_id,
    link_state: overrides.project_id ? "committed" : "unlinked",
    sync_axis: "current",
    value_axis: "active",
    retention_axis: "keep_raw_and_derived",
    context_ref: `ctx-${id}`,
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 0,
      token_usage: { input_tokens: 1_000_000, output_tokens: 100_000, total_tokens: 1_100_000 },
      total_tokens: 1_100_000,
      primary_model: session.model ?? "gemini-4-carbon",
      has_errors: false,
    },
    lineage: {
      atom_refs: [`atom-${id}`],
      candidate_refs: [],
      fragment_refs: [],
      record_refs: [],
      blob_refs: [],
    },
    ...overrides,
  };
}

test("resolveModelPricing maps user gemini aliases, normalized suffixes, and unpriced models", () => {
  const pro = resolveModelPricing("gemini-pro-orchestrator");
  assert.equal(pro.resolved_model, "gemini-4-carbon");
  assert.equal(pro.match_kind, "alias");
  assert.equal(pro.unit_prices?.input, 2);
  assert.equal(pro.unit_prices?.cache_read, 0.1);
  assert.equal(pro.unit_prices?.output, 10);

  const flash = resolveModelPricing("gemini-flash-worker-agy");
  assert.equal(flash.resolved_model, "gemini-4-hydrogen");
  assert.equal(flash.match_kind, "alias");
  assert.equal(flash.unit_prices?.input, 1.5);
  assert.equal(flash.unit_prices?.cache_read, 0.075);
  assert.equal(flash.unit_prices?.output, 7.5);

  const opus = resolveModelPricing("claude-opus-5-5-high");
  assert.equal(opus.resolved_model, "claude-opus-5-5");
  assert.equal(opus.match_kind, "normalized");
  assert.equal(opus.unit_prices?.input, 4);
  assert.equal(opus.unit_prices?.cache_write, 5);
  assert.equal(opus.unit_prices?.output, 20);

  const tiered = resolveModelPricing("gemini-3.8-flash-tiered");
  assert.equal(tiered.resolved_model, "gemini-3.8-flash");
  assert.equal(tiered.match_kind, "normalized");
  assert.equal(tiered.unit_prices?.input, 0.75);

  const unknown = resolveModelPricing("private-local-llm-v9");
  assert.equal(unknown.match_kind, "unpriced");
  assert.equal(unknown.unit_prices, undefined);
});

test("cost computation separates cache read/write, avoids reasoning double-count, and applies dual-layer multipliers", () => {
  const source = createSource();
  const project = createProject("proj-a", "Alpha");
  // Case 1 (Antigravity/Codex style): reasoning_output_tokens included inside output_tokens -> total = input + cache_read + cache_write + output
  // 1M input ($2) + 10M cache_read ($1) + 1M cache_write (default none -> input fallback or cache_write price) + 1M output ($10)
  // Using claude-opus-5-5-high (in:$4, cache_read:$0.2, cache_write:$5, out:$20)
  const sessionA = createSession(source, { id: "s-a", model: "claude-opus-5-5-high" });
  const turnIncludedReasoning = createTurn(source, sessionA, {
    id: "turn-a",
    project_id: project.project_id,
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 0,
      primary_model: "claude-opus-5-5-high",
      has_errors: false,
      total_tokens: 13_000_000,
      token_usage: {
        input_tokens: 1_000_000,
        cache_read_input_tokens: 10_000_000,
        cache_creation_input_tokens: 1_000_000,
        cached_input_tokens: 11_000_000,
        output_tokens: 1_000_000,
        reasoning_output_tokens: 400_000, // already inside output_tokens (1+10+1+1 = 13M)
        total_tokens: 13_000_000,
      },
    },
  });

  // Case 2 (OpenCode style): output_tokens excludes reasoning, total = input + output + reasoning
  const sessionB = createSession(source, { id: "s-b", model: "gemini-4-hydrogen" });
  const turnAddedReasoning = createTurn(source, sessionB, {
    id: "turn-b",
    project_id: project.project_id,
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 0,
      primary_model: "gemini-4-hydrogen", // in:$1.5, out:$7.5
      has_errors: false,
      total_tokens: 1_500_000,
      token_usage: {
        input_tokens: 1_000_000,
        output_tokens: 300_000,
        reasoning_output_tokens: 200_000, // 1M + 300k + 200k = 1.5M
        total_tokens: 1_500_000,
      },
    },
  });

  const pricing = parseUsagePricingInput({
    schema: "cchistory-lite-pricing/v1",
    multipliers: {
      "claude-opus-5-5": {
        model: 2,
        cache_read: 1.5,
      },
    },
    quota: {
      weekly_usd: 100,
    },
  });

  const overview = computeUsageOverview({
    filters: { pricing, time_preset: "week" },
    listResolvedTurns: () => [turnIncludedReasoning, turnAddedReasoning],
    listResolvedSessions: () => [sessionA, sessionB],
    listSources: () => [source],
    listProjects: () => [project],
  });

  // turnA list cost: in=4, cache_read=10*0.2=2, cache_write=5, out=20 => 31
  // turnA adj cost (model=2, cache_read=1.5): in=8, cache_read=2*2*1.5=6, cache_write=10, out=40 => 64
  // turnB list cost: in=1.5, non_reasoning_out=0.3*7.5=2.25, reasoning=0.2*7.5=1.5 => 5.25 (adj=5.25)
  assert.ok(Math.abs((overview.cost?.list_cost_usd ?? 0) - 36.25) < 1e-6);
  assert.ok(Math.abs((overview.cost?.adjusted_cost_usd ?? 0) - 69.25) < 1e-6);
  assert.ok(Math.abs((overview.cost?.quota_percent ?? 0) - 69.25) < 1e-6);
  assert.equal(overview.total_cache_read_input_tokens, 10_000_000);
  assert.equal(overview.total_cache_creation_input_tokens, 1_000_000);
  assert.equal(overview.total_billable_output_tokens, 1_500_000);
});

test("independent turn_id=null usage events contribute to cost and rollup without inventing user turns", () => {
  const source = createSource();
  const project = createProject("proj-null", "OrphanCheck");
  const session = createSession(source, {
    id: "s-orphan",
    primary_project_id: project.project_id,
    model: "gemini-3.8-flash-tiered",
    usage_events: [
      {
        id: "evt-background-1",
        turn_id: null,
        created_at: "2026-11-16T08:00:00.000Z",
        model: "gemini-3.8-flash-tiered",
        token_usage: {
          input_tokens: 2_000_000,
          output_tokens: 1_000_000,
          total_tokens: 3_000_000,
        },
      },
    ],
  });
  const zeroTurn = createTurn(source, session, {
    id: "turn-zero",
    project_id: project.project_id,
    submission_started_at: "2026-11-16T07:59:00.000Z",
    context_summary: {
      assistant_reply_count: 0,
      tool_call_count: 0,
      zero_token_reason: "no_assistant_reply",
      has_errors: false,
    },
  });

  const modelRollup = computeUsageRollup({
    dimension: "model",
    filters: { pricing: { quota: { weekly_usd: 10.5 } }, time_preset: "week" },
    listResolvedTurns: () => [zeroTurn],
    listResolvedSessions: () => [session],
    listSources: () => [source],
    listProjects: () => [project],
  });

  assert.equal(modelRollup.rows.length, 1);
  assert.equal(modelRollup.rows[0]?.key, "gemini-3.8-flash-tiered");
  assert.equal(modelRollup.rows[0]?.turn_count, 0);
  assert.equal(modelRollup.rows[0]?.usage_event_count, 1);
  assert.equal(modelRollup.rows[0]?.total_tokens, 3_000_000);
  // gemini-3.8-flash: in 0.75/1M * 2M = 1.50, out 3.75/1M * 1M = 3.75 => 5.25 USD -> 50% of 10.50
  assert.ok(Math.abs((modelRollup.rows[0]?.cost?.list_cost_usd ?? 0) - 5.25) < 1e-6);
  assert.ok(Math.abs((modelRollup.rows[0]?.cost?.quota_percent ?? 0) - 50) < 1e-6);
});

test("multi-dimension matrix and cross-filtered breakdown filter across Project × Model × Source × Time", () => {
  const srcAgy = createSource({ id: "src-agy", slot_id: "antigravity", platform: "antigravity", display_name: "Antigravity" });
  const srcClaude = createSource({ id: "src-cc", slot_id: "claude_code", platform: "claude_code", display_name: "Claude Code" });
  const projA = createProject("proj-a", "Alpha");
  const projB = createProject("proj-b", "Beta");

  const s1 = createSession(srcAgy, { id: "s1", model: "gemini-pro-orchestrator" });
  const s2 = createSession(srcClaude, { id: "s2", model: "claude-opus-5-5-high" });

  const t1 = createTurn(srcAgy, s1, {
    id: "t1",
    project_id: projA.project_id,
    submission_started_at: "2026-11-16T10:00:00.000Z", // 2026-11-16
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 0,
      primary_model: "gemini-pro-orchestrator",
      has_errors: false,
      token_usage: { input_tokens: 1_000_000, output_tokens: 100_000, total_tokens: 1_100_000 },
      total_tokens: 1_100_000,
    },
  });
  const t2 = createTurn(srcClaude, s2, {
    id: "t2",
    project_id: projB.project_id,
    submission_started_at: "2026-11-17T01:00:00.000Z",
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 0,
      primary_model: "claude-opus-5-5-high",
      has_errors: false,
      token_usage: { input_tokens: 500_000, output_tokens: 50_000, total_tokens: 550_000 },
      total_tokens: 550_000,
    },
  });

  const data = {
    listResolvedTurns: () => [t1, t2],
    listResolvedSessions: () => [s1, s2],
    listSources: () => [srcAgy, srcClaude],
    listProjects: () => [projA, projB],
  };

  const matrix = computeUsageMatrix({
    ...data,
    dimensions: ["project", "model", "source", "day"],
    filters: { timezone: "UTC" },
    sortBy: "tokens",
  });
  assert.equal(matrix.rows.length, 2);
  assert.deepEqual(matrix.rows[0]?.keys, ["proj-a", "gemini-pro-orchestrator", "src-agy", "2026-11-16"]);
  assert.equal(matrix.rows[0]?.labels[0], "Alpha");
  assert.equal(matrix.rows[0]?.total_tokens, 1_100_000);

  const breakdown = computeUsageBreakdown({
    ...data,
    filters: {
      timezone: "UTC",
      project_ids: ["proj-a"],
      source_ids: ["src-agy"],
      time_keys: ["2026-11-16"],
    },
    time_dimension: "day",
    matrix_dimensions: ["project", "model", "source", "day"],
  });
  assert.equal(breakdown.overview.total_tokens, 1_100_000);
  assert.equal(breakdown.by_model.rows.length, 1);
  assert.equal(breakdown.by_model.rows[0]?.key, "gemini-pro-orchestrator");
  assert.equal(breakdown.model_resolutions[0]?.resolved_model, "gemini-4-carbon");
});

test("parseUsagePricingInput handles raw models.dev/api.json dumps and timezone week modes", () => {
  const parsed = parseUsagePricingInput({
    anthropic: {
      id: "anthropic",
      models: {
        "claude-test-1": {
          id: "claude-test-1",
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        },
      },
    },
  });
  const hit = resolveModelPricing("claude-test-1", parsed);
  assert.equal(hit.match_kind, "custom");
  assert.equal(hit.unit_prices?.input, 3);
  assert.equal(hit.unit_prices?.cache_write, 3.75);

  // Verify Asia/Shanghai timezone shifts 2026-11-16T20:00:00Z to 2026-11-17 04:00 local time
  const nowMs = Date.parse("2026-11-17T12:00:00+08:00");
  const isoWeek = resolveWeekBucket(Date.parse("2026-11-16T20:00:00Z"), {
    timeZone: "Asia/Shanghai",
    weekMode: "iso_week",
    nowMs,
  });
  assert.equal(isoWeek.key, "2026-W47");

  const rollingBounds = resolveTimeWindowBounds("week", {
    timezone: "Asia/Shanghai",
    week_mode: "rolling_7d",
    now_ms: nowMs,
  });
  assert.equal(rollingBounds.after_date, "2026-11-10");
  assert.equal(rollingBounds.before_date, "2026-11-17");

  const relative7d = parseDateOrRelativeStart("7d", { timezone: "UTC", now_ms: nowMs });
  assert.equal(relative7d.preset, "7d");
  assert.ok((relative7d.after_ts ?? 0) < nowMs);
});

test("Grok Build alias uses the current xAI catalog with explicit long-context rates", () => {
  for (const name of ["grok-4.6-build", "xai/grok-4.6-build", "x-ai/grok-4.6-build", "grok-4.7-build", "xai/grok-4.7-build", "x-ai/grok-4.7-build"]) {
    const pricing = resolveModelPricing(name);
    assert.equal(pricing.resolved_model, name.includes("4.7") ? "grok-4.7" : "grok-4.6");
    assert.equal(pricing.unit_prices!.input, 2);
    assert.equal(pricing.unit_prices!.output, 6);
    assert.equal(pricing.unit_prices!.cache_read, 0.5);
    assert.deepEqual(pricing.unit_prices!.context_tiers, [{ above_input_tokens: 200000, input: 4, output: 12, cache_read: 1 }]);
  }
  const custom = resolveModelPricing("grok-4.6-build", parseUsagePricingInput({
    prices: { "grok-4.6-build": { input: 3, output: 9 } },
  }));
  assert.equal(custom.match_kind, "custom");
  assert.equal(custom.unit_prices!.input, 3);
});

test("context pricing is selected per call and costs agree across grouped statistics", () => {
  const source = createSource({ slot_id: "codex", platform: "codex" });
  const session = createSession(source, { model: "grok-4.6-build" });
  const small = { input_tokens: 100000, cache_read_input_tokens: 100000, output_tokens: 10, total_tokens: 200010 };
  const large = { input_tokens: 100001, cache_read_input_tokens: 100000, output_tokens: 10, total_tokens: 200011 };
  const turn = createTurn(source, session);
  turn.context_summary.token_usage = { input_tokens: 300001, cache_read_input_tokens: 300000, output_tokens: 30, total_tokens: 600031 };
  session.usage_events = [small, small, large].map((token_usage, i) => ({ id: `call-${i}`, turn_id: turn.id,
    model: session.model, created_at: turn.created_at, token_usage }));
  const result = computeUsageBreakdown({ filters: { timezone: "UTC" },
    listResolvedSessions: () => [session], listResolvedTurns: () => [turn],
    listSources: () => [source], listProjects: () => [], matrix_dimensions: ["model", "day"] });
  // Two calls at exactly 200K use base rates; only the 200001-input call uses the tier.
  const expected = 2 * 0.25006 + 0.500124;
  assert.ok(Math.abs(result.overview.cost!.list_cost_usd - expected) < 1e-12);
  assert.equal(result.overview.total_turns, 1);
  assert.equal(result.overview.usage_event_count, 3);
  assert.ok(Math.abs(result.model_resolutions[0]!.list_cost_usd - expected) < 1e-12);
  assert.ok(Math.abs(result.matrix!.rows[0]!.cost.list_cost_usd - expected) < 1e-12);
});

test("models.dev and local pricing configs preserve validated context tiers", () => {
  const prices = { input: 1, output: 2, tiers: [
    { tier: { type: "context", size: 1000 }, input: 3, cache_read: 0.3, output: 4 },
    { tier: { type: "context", size: -1 }, input: 999 },
    { tier: { type: "output", size: 2000 }, output: 999 },
  ] };
  const config = parseUsagePricingInput({ xai: { models: { "fixture-model": { cost: prices } } } });
  const entry = config.catalog_overrides!["fixture-model"]!;
  assert.deepEqual(entry.prices.context_tiers, [{ above_input_tokens: 1000, input: 3, output: 4, cache_read: 0.3 }]);
  const roundTrip = parseUsagePricingInput({ catalog_overrides: { "fixture-model": entry } });
  assert.deepEqual(roundTrip.catalog_overrides, config.catalog_overrides);
});

test("Grok Build Fast keeps its own whole-request rates across aliases and context tiers", () => {
  for (const name of ["grok-4.7-build-fast", "xai/grok-4.7-build-fast", "x-ai/grok-4.7-build-fast", "grok-4.7-fast"]) {
    const resolved = resolveModelPricing(name);
    assert.equal(resolved.resolved_model, "grok-4.7-build-fast");
    assert.deepEqual(resolved.unit_prices, { input: 4, output: 12, cache_read: 1,
      context_tiers: [{ above_input_tokens: 200000, input: 6, output: 18, cache_read: 1.5 }] });
  }
  const source = createSource({ slot_id: "grok", platform: "grok" });
  const session = createSession(source, { model: "grok-4.7-build-fast" });
  const turn = createTurn(source, session);
  turn.context_summary.token_usage = { input_tokens: 200001, cache_read_input_tokens: 200000, output_tokens: 20, total_tokens: 400021 };
  session.usage_events = [
    { input_tokens: 100000, cache_read_input_tokens: 100000, output_tokens: 10, total_tokens: 200010 },
    { input_tokens: 100001, cache_read_input_tokens: 100000, output_tokens: 10, total_tokens: 200011 },
  ].map((token_usage, index) => ({ id: `fast-${index}`, turn_id: turn.id, model: session.model, created_at: turn.created_at, token_usage }));
  const result = computeUsageBreakdown({ filters: { timezone: "UTC" }, listResolvedSessions: () => [session],
    listResolvedTurns: () => [turn], listSources: () => [source], listProjects: () => [], matrix_dimensions: ["model"] });
  const expected = 0.50012 + 0.750186;
  assert.ok(Math.abs(result.overview.cost!.list_cost_usd - expected) < 1e-12);
  assert.ok(Math.abs(result.model_resolutions[0]!.list_cost_usd - expected) < 1e-12);
  const custom = resolveModelPricing("grok-4.7-build-fast", parseUsagePricingInput({
    prices: { "grok-4.7-build-fast": { input: 8, output: 24 } },
  }));
  assert.equal(custom.match_kind, "custom");
  assert.equal(custom.unit_prices!.input, 8);
});
