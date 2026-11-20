import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProjectIdentity,
  SessionContributionProjection,
  SessionFamilyProjection,
  SessionProjection,
  SourceStatus,
  UserTurnProjection,
} from "@cchistory/domain";
import { computeUsageBreakdown } from "./usage-breakdown.js";
import {
  buildDenseTimeSeries,
  computeQuotaPace,
  computeUsageEfficiency,
  densifyShortHourlyRollupRows,
} from "./usage-diagnostics.js";
import { resolveDefaultTimeBucket } from "./usage-time.js";

function makeTurn(overrides: Partial<UserTurnProjection> & { id: string; session_id: string }): UserTurnProjection {
  return {
    turn_id: overrides.id,
    turn_revision_id: `${overrides.id}-rev`,
    revision_id: `${overrides.id}-rev`,
    user_messages: [],
    raw_text: "prompt",
    canonical_text: "prompt",
    display_segments: [],
    created_at: overrides.submission_started_at ?? "2026-11-18T10:00:00.000Z",
    submission_started_at: overrides.submission_started_at ?? "2026-11-18T10:00:00.000Z",
    last_context_activity_at: overrides.submission_started_at ?? "2026-11-18T10:00:00.000Z",
    source_id: "src:codex",
    link_state: "committed",
    sync_axis: "current",
    value_axis: "active",
    retention_axis: "keep_raw_and_derived",
    context_ref: `ctx:${overrides.id}`,
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 1,
      has_errors: false,
      primary_model: "grok-4.6",
    },
    lineage: { atom_refs: [], candidate_refs: [], fragment_refs: [], record_refs: [], blob_refs: [] },
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionProjection> & { id: string }): SessionProjection {
  return {
    source_id: "src:codex",
    source_platform: "codex",
    host_id: "host:local",
    title: "Session title",
    created_at: "2026-11-18T00:00:00.000Z",
    updated_at: "2026-11-18T12:00:00.000Z",
    turn_count: 1,
    model: "grok-4.6",
    sync_axis: "current",
    ...overrides,
  };
}

const SOURCE: SourceStatus = {
  id: "src:codex",
  slot_id: "codex",
  family: "local_coding_agent",
  platform: "codex",
  display_name: "Codex",
  base_dir: "/mock/.codex",
  host_id: "host:local",
  last_sync: "2026-11-18T12:00:00.000Z",
  sync_status: "healthy",
  total_blobs: 1,
  total_records: 2,
  total_fragments: 2,
  total_atoms: 2,
  total_sessions: 2,
  total_turns: 2,
};

const PROJECT: ProjectIdentity = {
  project_id: "proj:alpha",
  project_revision_id: "proj:alpha-r1",
  display_name: "Alpha",
  slug: "alpha",
  linkage_state: "committed",
  confidence: 1,
  link_reason: "repo_root_match",
  manual_override_status: "none",
  source_platforms: ["codex"],
  host_ids: ["host:local"],
  committed_turn_count: 2,
  candidate_turn_count: 0,
  session_count: 2,
  project_last_activity_at: "2026-11-18T12:00:00.000Z",
  created_at: "2026-11-18T00:00:00.000Z",
  updated_at: "2026-11-18T12:00:00.000Z",
};

test("resolveDefaultTimeBucket selects hour for short windows and day for multi-day windows", () => {
  assert.equal(resolveDefaultTimeBucket({ preset: "today" }), "hour");
  assert.equal(resolveDefaultTimeBucket({ preset: "24h" }), "hour");
  assert.equal(resolveDefaultTimeBucket({ preset: "7d" }), "day");
  assert.equal(resolveDefaultTimeBucket({ preset: "all" }), "day");
  const base = Date.parse("2026-11-18T00:00:00.000Z");
  assert.equal(resolveDefaultTimeBucket({ after_ts: base, before_ts: base + 12 * 3_600_000 }), "hour");
  assert.equal(resolveDefaultTimeBucket({ after_ts: base, before_ts: base + 48 * 3_600_000 }), "hour");
  assert.equal(resolveDefaultTimeBucket({ after_ts: base, before_ts: base + 49 * 3_600_000 }), "day");
});

test("computeUsageEfficiency returns null ratios when denominators are zero", () => {
  const eff = computeUsageEfficiency(
    {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      billable_output_tokens: 0,
    },
    undefined,
  );
  assert.equal(eff.cache_hit_ratio, null);
  assert.equal(eff.reasoning_share_ratio, null);
  assert.equal(eff.cost_shares, null);
  assert.equal(eff.cache_adjusted_savings_usd, 0);
  assert.equal(eff.high_context_call_count, 0);
});

test("computeUsageBreakdown computes hourly buckets, cache hit/savings, >200K tier count, and enriched by_session", () => {
  const s1 = makeSession({
    id: "sess:1",
    title: "Expensive long-context refactor",
    primary_project_id: "proj:alpha",
    usage_events: [
      {
        id: "ev:1",
        turn_id: "turn:1",
        created_at: "2026-11-18T15:30:00.000Z", // 23:30 Asia/Shanghai
        model: "grok-4.7-build-fast",
        token_usage: {
          input_tokens: 50_000,
          cache_read_input_tokens: 200_000, // total input = 250K -> triggers >200K tier!
          cache_creation_input_tokens: 0,
          output_tokens: 20_000,
          reasoning_output_tokens: 5_000,
          total_tokens: 270_000,
        },
      },
    ],
  });
  const s2 = makeSession({
    id: "sess:2",
    title: "Small follow-up",
    primary_project_id: "proj:alpha",
    usage_events: [
      {
        id: "ev:2",
        turn_id: "turn:2",
        created_at: "2026-11-18T16:15:00.000Z", // 00:15 next day Asia/Shanghai
        model: "grok-4.6",
        token_usage: {
          input_tokens: 10_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 2_000,
          reasoning_output_tokens: 0,
          total_tokens: 12_000,
        },
      },
    ],
  });
  const turns = [
    makeTurn({ id: "turn:1", session_id: "sess:1", project_id: "proj:alpha", submission_started_at: "2026-11-18T15:30:00.000Z" }),
    makeTurn({ id: "turn:2", session_id: "sess:2", project_id: "proj:alpha", submission_started_at: "2026-11-18T16:15:00.000Z" }),
  ];
  const contributions: SessionContributionProjection[] = [
    {
      session_ref: "sess:1",
      source_id: "src:codex",
      source_platform: "codex",
      stats: {
        storage_bytes: 50_000,
        blob_count: 1,
        turn_count: 1,
        assistant_reply_count: 1,
        tool_call_count: 10,
        tool_success_count: 7,
        tool_error_count: 3,
        tool_pending_count: 0,
      },
    },
  ];
  const families: SessionFamilyProjection[] = [
    {
      parent_session_ref: "sess:1",
      source_id: "src:codex",
      source_platform: "codex",
      child_count: 2,
      parent: contributions[0]!.stats,
      children: [],
      combined: contributions[0]!.stats,
    },
  ];

  const breakdown = computeUsageBreakdown({
    listResolvedTurns: () => turns,
    listResolvedSessions: () => [s1, s2],
    listSources: () => [SOURCE],
    listProjects: () => [PROJECT],
    listSessionContributions: () => contributions,
    listSessionFamilies: () => families,
    filters: {
      timezone: "Asia/Shanghai",
      time_preset: "24h",
      now_ms: Date.parse("2026-11-18T17:00:00.000Z"),
    },
  });

  // 24h auto-selects hourly bucketing and preserves cross-midnight Asia/Shanghai hour keys
  assert.equal(breakdown.time_dimension, "hour");
  assert.deepEqual(
    breakdown.by_time.rows.map((r) => r.key),
    ["2026-11-18 23:00", "2026-11-19 00:00"],
  );

  // Efficiency metrics
  const eff = breakdown.efficiency!;
  assert.ok(eff);
  // cache_hit = 200_000 / (50_000 + 200_000 + 10_000) = 200/260
  assert.ok(Math.abs((eff.cache_hit_ratio ?? 0) - 200_000 / 260_000) < 1e-6);
  // grok-4.7-build-fast >200K: input $6/M, cache_read $1.5/M -> savings = 0.2M * (6 - 1.5) = $0.90
  assert.ok(Math.abs(eff.cache_adjusted_savings_usd - 0.9) < 1e-6);
  assert.equal(eff.high_context_call_count, 1);
  assert.equal(eff.priced_call_count, 2);
  assert.ok(eff.high_context_adjusted_cost_usd > 0);
  // Cost shares sum to 1
  const shares = eff.cost_shares!;
  const sum = shares.input + shares.cache_read + shares.cache_write + shares.output + shares.reasoning;
  assert.ok(Math.abs(sum - 1) < 1e-9);

  // Enriched by_session ranking
  const sessions = breakdown.by_session!.rows;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]!.key, "sess:1");
  assert.equal(sessions[0]!.session_meta?.delegated_child_count, 2);
  assert.equal(sessions[0]!.session_meta?.tool_call_count, 10);
  assert.equal(sessions[0]!.session_meta?.tool_error_count, 3);
  assert.equal(sessions[0]!.session_meta?.primary_model, "grok-4.7-build-fast");

  // 24-hour profile sums match overview
  const profile = breakdown.hourly_profile!;
  assert.equal(profile.length, 24);
  assert.equal(profile[23]!.total_tokens, 270_000);
  assert.equal(profile[0]!.total_tokens, 12_000);
  assert.equal(
    profile.reduce((acc, cell) => acc + cell.total_tokens, 0),
    breakdown.overview.total_tokens,
  );
});

test("computeQuotaPace evaluates calendar pace, rolling windows, and unbounded windows", () => {
  // Unbounded 'all' returns undefined
  assert.equal(
    computeQuotaPace({ spentUsd: 50, quotaLimitUsd: 100, filters: { time_preset: "all" } }),
    undefined,
  );

  // Calendar today at 12:00 UTC (50% elapsed): spent $80 of $100 -> fast, projected $160
  const noonUtc = Date.parse("2026-11-18T12:00:00.000Z");
  const fastPace = computeQuotaPace({
    spentUsd: 80,
    quotaLimitUsd: 100,
    filters: { time_preset: "today", timezone: "UTC", now_ms: noonUtc },
  });
  assert.ok(fastPace);
  assert.equal(fastPace.status, "fast");
  assert.ok(Math.abs(fastPace.elapsed_ratio - 0.5) < 1e-6);
  assert.ok(Math.abs((fastPace.projected_period_cost_usd ?? 0) - 160) < 1e-6);

  // Over limit
  const overPace = computeQuotaPace({
    spentUsd: 120,
    quotaLimitUsd: 100,
    filters: { time_preset: "today", timezone: "UTC", now_ms: noonUtc },
  });
  assert.equal(overPace?.status, "over_limit");
  assert.equal(overPace?.estimated_days_to_limit, 0);

  // Very early in day (<60s elapsed) -> null projection instead of exploding
  const earlyUtc = Date.parse("2026-11-18T00:00:30.000Z");
  const earlyPace = computeQuotaPace({
    spentUsd: 1,
    quotaLimitUsd: 100,
    filters: { time_preset: "today", timezone: "UTC", now_ms: earlyUtc },
  });
  assert.equal(earlyPace?.projected_period_cost_usd, null);
});

test("buildDenseTimeSeries and densifyShortHourlyRollupRows preserve empty gap hours between 22:00 and 01:00, and hour_of_day emits all 24 clock slots", () => {
  const s = makeSession({
    id: "sess:overnight",
    title: "Overnight coding",
    primary_project_id: "proj:alpha",
    usage_events: [
      {
        id: "ev:22",
        turn_id: "turn:22",
        created_at: "2026-11-18T14:15:00.000Z", // 22:15 Asia/Shanghai
        model: "grok-4.6",
        token_usage: { input_tokens: 100_000, output_tokens: 10_000, total_tokens: 110_000 },
      },
      {
        id: "ev:01",
        turn_id: "turn:01",
        created_at: "2026-11-18T17:15:00.000Z", // 01:15 next day Asia/Shanghai
        model: "grok-4.6",
        token_usage: { input_tokens: 50_000, output_tokens: 5_000, total_tokens: 55_000 },
      },
    ],
  });
  const turns = [
    makeTurn({ id: "turn:22", session_id: s.id, project_id: "proj:alpha", submission_started_at: "2026-11-18T14:15:00.000Z" }),
    makeTurn({ id: "turn:01", session_id: s.id, project_id: "proj:alpha", submission_started_at: "2026-11-18T17:15:00.000Z" }),
  ];

  const hourly = computeUsageBreakdown({
    listResolvedTurns: () => turns,
    listResolvedSessions: () => [s],
    listSources: () => [SOURCE],
    listProjects: () => [PROJECT],
    time_dimension: "hour",
    filters: { timezone: "Asia/Shanghai", pricing: { multipliers: { "grok-4.6": { model: 2 } } } },
  });

  // Effective multiplier reflects 2.0x adjusted / list ratio
  assert.ok(Math.abs((hourly.efficiency?.effective_multiplier ?? 0) - 2) < 1e-6);

  // Sparse hourly rollup has 22:00 and 01:00; dense series & short-span densifier fill 23:00 and 00:00 with zero
  const denseSeries = buildDenseTimeSeries(hourly.by_time.rows, "hour", { timezone: "Asia/Shanghai" });
  assert.deepEqual(
    denseSeries.map((pt) => [pt.key, pt.has_data]),
    [
      ["2026-11-18 22:00", true],
      ["2026-11-18 23:00", false],
      ["2026-11-19 00:00", false],
      ["2026-11-19 01:00", true],
    ],
  );
  const denseRows = densifyShortHourlyRollupRows(hourly.by_time.rows, { timezone: "Asia/Shanghai" });
  assert.deepEqual(
    denseRows.map((r) => [r.key, r.total_tokens]),
    [
      ["2026-11-18 22:00", 110_000],
      ["2026-11-18 23:00", 0],
      ["2026-11-19 00:00", 0],
      ["2026-11-19 01:00", 55_000],
    ],
  );

  // hour_of_day rollup emits all 24 clock slots 00:00..23:00 in order
  const hod = computeUsageBreakdown({
    listResolvedTurns: () => turns,
    listResolvedSessions: () => [s],
    listSources: () => [SOURCE],
    listProjects: () => [PROJECT],
    time_dimension: "hour_of_day",
    filters: { timezone: "Asia/Shanghai" },
  });
  assert.equal(hod.by_time.rows.length, 24);
  assert.equal(hod.by_time.rows[0]!.key, "00:00");
  assert.equal(hod.by_time.rows[1]!.total_tokens, 55_000);
  assert.equal(hod.by_time.rows[22]!.total_tokens, 110_000);
  assert.equal(hod.by_time.rows[23]!.key, "23:00");
  assert.equal(hod.by_time.rows[23]!.total_tokens, 0);
});
