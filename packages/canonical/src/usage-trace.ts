/**
 * Role: Pure canonical single-session / single-turn usage trace builder producing
 * family summaries, per-turn efficiency rows, tool loops, anomalies, and a paginated
 * step-by-step call waterfall. Excludes I/O and CLI/TUI rendering.
 */

import type {
  CallTraceRow,
  SessionProjection,
  SessionTraceFamilyMember,
  SessionTraceReport,
  SessionTraceTurnRow,
  UsageAnomaly,
  UsageGranularity,
  UserTurnProjection,
} from "@cchistory/domain";
import { nowIso } from "@cchistory/domain";
import { compareTurnsByChronology } from "./read-order.js";
import { extractUnfilteredUsageRows, filterUsageRows, type UsageFilters, type UsageSourceData } from "./usage.js";
import {
  computeCacheHitDistribution,
  computeUsageDiagnosticsReport,
  type EvaluatedUsageRow,
} from "./usage-anomalies.js";

export interface SessionTraceOptions {
  sessionId: string;
  turnId?: string;
  includeSubagents?: boolean;
  onlyAnomalies?: boolean;
  limit?: number;
  offset?: number;
  filters?: UsageFilters;
}

export function buildSessionTraceReport(
  sourceData: UsageSourceData,
  options: SessionTraceOptions,
): SessionTraceReport | undefined {
  const sessions = sourceData.listResolvedSessions();
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  const targetSession = sessionsById.get(options.sessionId);
  if (!targetSession) return undefined;

  const filters: UsageFilters = options.filters ?? {};
  const includeSubagents = options.includeSubagents === true;
  const onlyAnomalies = options.onlyAnomalies === true;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? 100);

  const families = sourceData.listSessionFamilies?.() ?? [];
  const relatedWork = sourceData.listRelatedWork?.() ?? [];
  const sourcesById = new Map(sourceData.listSources().map((s) => [s.id, s]));
  const projectsById = new Map(sourceData.listProjects().map((p) => [p.project_id, p]));

  // Discover all child session IDs belonging to targetSession (and parent if target is a child).
  const childSessionIds = new Set<string>();
  let parentSessionId: string | undefined;
  const childAgentKeyBySessionId = new Map<string, string>();
  const childByParentToolRef = new Map<string, string>();

  for (const fam of families) {
    if (fam.parent_session_ref === targetSession.id) {
      for (const child of fam.children) {
        if (child.child_session_ref) {
          childSessionIds.add(child.child_session_ref);
          if (child.agent_key) childAgentKeyBySessionId.set(child.child_session_ref, child.agent_key);
          if (child.parent_tool_ref) childByParentToolRef.set(child.parent_tool_ref, child.child_session_ref);
        }
      }
    }
    for (const child of fam.children) {
      if (child.child_session_ref === targetSession.id && !parentSessionId) {
        parentSessionId = fam.parent_session_ref;
      }
    }
  }
  for (const rel of relatedWork) {
    if (rel.relation_kind !== "delegated_session") continue;
    if (rel.parent_session_ref === targetSession.id && rel.child_session_ref && sessionsById.has(rel.child_session_ref)) {
      childSessionIds.add(rel.child_session_ref);
      if (rel.child_agent_key) childAgentKeyBySessionId.set(rel.child_session_ref, rel.child_agent_key);
      if (rel.parent_tool_ref) childByParentToolRef.set(rel.parent_tool_ref, rel.child_session_ref);
    }
    if (rel.child_session_ref === targetSession.id && rel.parent_session_ref && !parentSessionId) {
      parentSessionId = rel.parent_session_ref;
    }
  }

  const familySessionIds = new Set<string>([targetSession.id, ...childSessionIds]);
  const allBaseRows = extractUnfilteredUsageRows(sourceData, filters);
  const familyRows = filterUsageRows(
    allBaseRows,
    { ...filters, session_ids: [...familySessionIds] },
    sessionsById,
  );

  const diag = computeUsageDiagnosticsReport({
    rows: familyRows,
    filters,
    sourceData,
  });

  // Mark calls belonging to polling loops so `--only-anomalies` highlights them cleanly.
  markLoopCalls(diag.evaluated, diag.report.loops);

  const scopeEvaluated = includeSubagents
    ? diag.evaluated
    : diag.evaluated.filter((item) => item.row.session_id === targetSession.id);
  const turnFiltered = options.turnId
    ? scopeEvaluated.filter((item) => item.row.turn_id === options.turnId)
    : scopeEvaluated;

  // Chronological turns for target session (and children when includeSubagents).
  const allTurns = sourceData
    .listResolvedTurns()
    .filter((t) => (includeSubagents ? familySessionIds.has(t.session_id) : t.session_id === targetSession.id))
    .sort(compareTurnsByChronology);
  const turnIndexById = new Map<string, number>();
  const turnById = new Map<string, UserTurnProjection>();
  allTurns.forEach((turn, idx) => {
    turnIndexById.set(turn.id, idx + 1);
    turnById.set(turn.id, turn);
  });

  // Build family member summary (main thread + each subagent session + each sidecar subagent).
  const familyMembers = buildFamilyMembers(
    targetSession,
    diag.evaluated,
    diag.report.anomalies,
    sessionsById,
    childAgentKeyBySessionId,
  );

  // Build per-turn breakdown rows.
  const turnRows = buildTraceTurnRows(turnFiltered, allTurns, turnById, turnIndexById, options.turnId);

  // Build chronological call waterfall.
  const sortedCalls = [...turnFiltered].sort(compareWaterfallRows);
  const anomaliesInScope = filterAnomaliesForScope(diag.report.anomalies, targetSession.id, includeSubagents, options.turnId);
  const allCallRows = sortedCalls.map((item, idx): CallTraceRow => {
    const turnIdx = item.row.turn_id ? turnIndexById.get(item.row.turn_id) : undefined;
    const spawnedRefs = collectSpawnedSubagents(item, childByParentToolRef);
    return {
      seq: item.row.seq ?? idx + 1,
      event_id: item.row.event_id ?? `${item.row.session_id}:row:${idx + 1}`,
      session_id: item.row.session_id,
      ...(item.row.subagent_key ? { subagent_key: item.row.subagent_key } : {}),
      turn_id: item.row.turn_id,
      turn_label: turnIdx !== undefined ? `T${turnIdx}` : "—",
      created_at: item.row.created_at ?? new Date(item.row.timestamp_ms || 0).toISOString(),
      gap_ms: item.gapMs,
      model: item.row.model,
      ...(item.row.stop_reason ? { stop_reason: item.row.stop_reason } : {}),
      context_input_tokens: item.contextInputTokens,
      context_delta_tokens: item.contextDeltaTokens,
      input_tokens: item.row.input_tokens,
      cache_read_tokens: item.row.cache_read_input_tokens,
      cache_write_tokens: item.row.cache_creation_input_tokens,
      output_tokens: item.row.output_tokens,
      reasoning_tokens: item.row.reasoning_output_tokens,
      total_tokens: item.row.total_tokens,
      cache_hit_ratio: item.cacheHitRatio,
      list_cost_usd: item.listCostUsd,
      adjusted_cost_usd: item.adjustedCostUsd,
      high_context_tier: item.highContextTier,
      cache_status: item.cacheStatus,
      ...(item.missCause ? { miss_cause: item.missCause } : {}),
      ...(item.row.compaction_before ? { compaction_before: true } : {}),
      preceding_tools: [...(item.row.preceding_tool_results ?? [])],
      emitted_tools: [...(item.row.emitted_tool_calls ?? [])],
      ...(spawnedRefs.length > 0 ? { spawned_subagent_refs: spawnedRefs } : {}),
      anomaly_kinds: [...item.anomalyKinds],
    };
  });

  const visibleCalls = onlyAnomalies
    ? allCallRows.filter((row) => row.anomaly_kinds.length > 0 || row.cache_status === "miss")
    : allCallRows;
  const pagedCalls = visibleCalls.slice(offset, offset + limit);

  const summaryEvaluated = turnFiltered;
  let totalTokens = 0;
  let listCost = 0;
  let adjustedCost = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let minHit: number | null = null;
  for (const item of summaryEvaluated) {
    totalTokens += item.row.total_tokens;
    listCost += item.listCostUsd;
    adjustedCost += item.adjustedCostUsd;
    totalInput += item.totalInputTokens;
    totalCacheRead += item.row.cache_read_input_tokens;
    if (item.cacheHitRatio !== null) {
      minHit = minHit === null ? item.cacheHitRatio : Math.min(minHit, item.cacheHitRatio);
    }
  }

  // Sources that only record session/model aggregates attach every call event
  // to no turn; report session granularity instead of pretending each aggregate
  // row is one call.
  const aggregateRows = summaryEvaluated.filter((item) => item.row.total_tokens > 0);
  const aggregateOnly =
    aggregateRows.length > 0
    && aggregateRows.every((item) => item.row.is_call_event && !item.row.turn_id);
  const usageGranularity: UsageGranularity =
    summaryEvaluated.length === 0
      ? "unavailable"
      : aggregateOnly
        ? "session"
        : summaryEvaluated.some((item) => item.row.is_call_event)
          ? "call"
          : "turn";

  const source = sourcesById.get(targetSession.source_id);
  const project = targetSession.primary_project_id ? projectsById.get(targetSession.primary_project_id) : undefined;
  const loopsInScope = diag.report.loops.filter((l) =>
    (includeSubagents || l.session_id === targetSession.id) &&
    (!options.turnId || l.turn_id === options.turnId),
  );
  const patternsInScope = diag.report.tool_patterns.filter((p) =>
    includeSubagents ? true : p.session_ids.includes(targetSession.id),
  );

  return {
    generated_at: nowIso(),
    session_id: targetSession.id,
    ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
    title: targetSession.canonical_title ?? targetSession.title ?? targetSession.source_session_id ?? targetSession.id,
    source_platform: targetSession.source_platform,
    source_label: source ? `${source.display_name} (${source.slot_id})` : targetSession.source_platform,
    project_label: project?.display_name ?? "Unassigned",
    usage_granularity: usageGranularity,
    total_calls: visibleCalls.length,
    shown_calls: pagedCalls.length,
    offset,
    limit,
    total_tokens: totalTokens,
    list_cost_usd: listCost,
    adjusted_cost_usd: adjustedCost,
    cache_hit_ratio: totalInput > 0 ? totalCacheRead / totalInput : null,
    min_cache_hit_ratio: minHit,
    cache_distribution: computeCacheHitDistribution(summaryEvaluated),
    family: familyMembers,
    turns: turnRows,
    tool_patterns: patternsInScope,
    loops: loopsInScope,
    anomalies: anomaliesInScope,
    calls: pagedCalls,
  };
}

function compareWaterfallRows(left: EvaluatedUsageRow, right: EvaluatedUsageRow): number {
  const lt = left.row.timestamp_ms;
  const rt = right.row.timestamp_ms;
  if (Number.isFinite(lt) && Number.isFinite(rt) && lt !== rt) return lt - rt;
  return (left.row.seq ?? left.rowIndex) - (right.row.seq ?? right.rowIndex);
}

function markLoopCalls(
  evaluated: readonly EvaluatedUsageRow[],
  loops: readonly { session_id: string; subagent_key?: string; first_call_seq?: number; last_call_seq?: number }[],
): void {
  for (const loop of loops) {
    if (loop.first_call_seq === undefined || loop.last_call_seq === undefined) continue;
    for (const item of evaluated) {
      if (item.row.session_id !== loop.session_id) continue;
      if ((item.row.subagent_key ?? "") !== (loop.subagent_key ?? "")) continue;
      const seq = item.row.seq;
      if (seq !== undefined && seq >= loop.first_call_seq && seq <= loop.last_call_seq) {
        if (!item.anomalyKinds.includes("polling_loop")) item.anomalyKinds.push("polling_loop");
      }
    }
  }
}

function buildFamilyMembers(
  targetSession: SessionProjection,
  evaluated: readonly EvaluatedUsageRow[],
  anomalies: readonly UsageAnomaly[],
  sessionsById: ReadonlyMap<string, SessionProjection>,
  agentKeyBySessionId: ReadonlyMap<string, string>,
): SessionTraceFamilyMember[] {
  const grouped = new Map<string, EvaluatedUsageRow[]>();
  for (const item of evaluated) {
    const key = item.row.subagent_key
      ? `sidecar:${item.row.session_id}:${item.row.subagent_key}`
      : `session:${item.row.session_id}`;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }

  const members: SessionTraceFamilyMember[] = [];
  for (const [, rows] of grouped.entries()) {
    const sample = rows[0]!;
    const isSidecar = Boolean(sample.row.subagent_key);
    const isMain = sample.row.session_id === targetSession.id && !isSidecar;
    const session = sessionsById.get(sample.row.session_id);
    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = Number.NEGATIVE_INFINITY;
    let tokens = 0;
    let cost = 0;
    let input = 0;
    let cacheRead = 0;
    let minHit: number | null = null;
    const modelTok = new Map<string, number>();

    for (const r of rows) {
      tokens += r.row.total_tokens;
      cost += r.adjustedCostUsd;
      input += r.totalInputTokens;
      cacheRead += r.row.cache_read_input_tokens;
      if (r.cacheHitRatio !== null) {
        minHit = minHit === null ? r.cacheHitRatio : Math.min(minHit, r.cacheHitRatio);
      }
      if (r.row.model && r.row.model !== "unknown") {
        modelTok.set(r.row.model, (modelTok.get(r.row.model) ?? 0) + r.row.total_tokens);
      }
      if (Number.isFinite(r.row.timestamp_ms)) {
        if (r.row.timestamp_ms < minTs) minTs = r.row.timestamp_ms;
        if (r.row.timestamp_ms > maxTs) maxTs = r.row.timestamp_ms;
      }
    }

    let primaryModel = session?.model;
    let maxM = -1;
    for (const [m, t] of modelTok.entries()) {
      if (t > maxM) {
        maxM = t;
        primaryModel = m;
      }
    }

    const memberAnomalies = anomalies.filter((a) =>
      isSidecar
        ? a.session_id === sample.row.session_id && a.subagent_key === sample.row.subagent_key
        : a.session_id === sample.row.session_id && !a.subagent_key,
    );

    const agentKey = sample.row.subagent_key ?? agentKeyBySessionId.get(sample.row.session_id);
    members.push({
      role: isMain ? "main" : "subagent",
      session_id: sample.row.session_id,
      ...(sample.row.subagent_key ? { subagent_key: sample.row.subagent_key } : {}),
      ...(agentKey ? { agent_key: agentKey } : {}),
      title: isSidecar
        ? agentKey ?? "subagent"
        : session?.canonical_title ?? session?.title ?? agentKey ?? sample.row.session_id,
      model: primaryModel,
      calls: rows.length,
      duration_ms: Number.isFinite(minTs) && Number.isFinite(maxTs) ? Math.max(0, maxTs - minTs) : 0,
      total_tokens: tokens,
      adjusted_cost_usd: cost,
      cache_hit_ratio: input > 0 ? cacheRead / input : null,
      min_cache_hit_ratio: minHit,
      anomaly_count: memberAnomalies.length,
    });
  }

  return members.sort((a, b) => {
    if (a.role !== b.role) return a.role === "main" ? -1 : 1;
    return b.adjusted_cost_usd - a.adjusted_cost_usd || b.total_tokens - a.total_tokens;
  });
}

function buildTraceTurnRows(
  evaluated: readonly EvaluatedUsageRow[],
  turns: readonly UserTurnProjection[],
  turnById: ReadonlyMap<string, UserTurnProjection>,
  turnIndexById: ReadonlyMap<string, number>,
  onlyTurnId?: string,
): SessionTraceTurnRow[] {
  const byTurn = new Map<string | null, EvaluatedUsageRow[]>();
  for (const turn of turns) {
    if (onlyTurnId && turn.id !== onlyTurnId) continue;
    byTurn.set(turn.id, []);
  }
  for (const item of evaluated) {
    const key = item.row.turn_id;
    const list = byTurn.get(key) ?? [];
    list.push(item);
    byTurn.set(key, list);
  }

  const rows: SessionTraceTurnRow[] = [];
  for (const [turnId, items] of byTurn.entries()) {
    const turn = turnId ? turnById.get(turnId) : undefined;
    if (!turn && items.length === 0) continue;
    let totalTokens = 0;
    let inputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let outputTokens = 0;
    let cost = 0;
    let totalInput = 0;
    let peakCtx = 0;
    let minHit: number | null = null;
    let toolCalls = 0;
    let toolErrors = 0;
    let anomalyCount = 0;

    for (const item of items) {
      totalTokens += item.row.total_tokens;
      inputTokens += item.row.input_tokens;
      cacheRead += item.row.cache_read_input_tokens;
      cacheWrite += item.row.cache_creation_input_tokens;
      outputTokens += item.row.output_tokens;
      cost += item.adjustedCostUsd;
      totalInput += item.totalInputTokens;
      if (item.contextInputTokens > peakCtx) peakCtx = item.contextInputTokens;
      if (item.cacheHitRatio !== null) {
        minHit = minHit === null ? item.cacheHitRatio : Math.min(minHit, item.cacheHitRatio);
      }
      for (const tool of item.row.emitted_tool_calls ?? []) {
        toolCalls += 1;
        if (tool.status === "error") toolErrors += 1;
      }
      if (item.anomalyKinds.length > 0) anomalyCount += 1;
    }

    const fallbackToolCount = turn?.context_summary.tool_call_count ?? 0;
    const firstCreatedAt =
      turn?.submission_started_at ??
      items[0]?.row.created_at ??
      new Date(items[0]?.row.timestamp_ms || 0).toISOString();

    rows.push({
      turn_id: turnId,
      turn_index: turnId ? (turnIndexById.get(turnId) ?? null) : null,
      created_at: firstCreatedAt,
      prompt_preview: turn
        ? clipSingleLine(turn.canonical_text, 72)
        : "[unanchored / background / subagent calls]",
      calls: items.length,
      tool_call_count: Math.max(toolCalls, fallbackToolCount),
      tool_error_count: toolErrors,
      peak_context_tokens: peakCtx,
      total_tokens: totalTokens,
      input_tokens: inputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      output_tokens: outputTokens,
      adjusted_cost_usd: cost,
      avg_cache_hit_ratio: totalInput > 0 ? cacheRead / totalInput : null,
      min_cache_hit_ratio: minHit,
      anomaly_count: anomalyCount,
    });
  }

  return rows.sort((a, b) => {
    if (a.turn_index !== null && b.turn_index !== null) return a.turn_index - b.turn_index;
    return a.created_at.localeCompare(b.created_at);
  });
}

function filterAnomaliesForScope(
  anomalies: readonly UsageAnomaly[],
  sessionId: string,
  includeSubagents: boolean,
  turnId?: string,
): UsageAnomaly[] {
  return anomalies.filter((a) => {
    const matchSession = includeSubagents
      ? true
      : a.session_id === sessionId || a.parent_session_id === sessionId;
    if (!matchSession) return false;
    if (turnId && a.turn_id !== turnId) return false;
    return true;
  });
}

function collectSpawnedSubagents(
  item: EvaluatedUsageRow,
  childByParentToolRef: ReadonlyMap<string, string>,
): string[] {
  const refs = new Set<string>();
  for (const tool of item.row.emitted_tool_calls ?? []) {
    if (tool.subagent_ref) refs.add(tool.subagent_ref);
    if (tool.call_id) {
      const linked = childByParentToolRef.get(tool.call_id);
      if (linked) refs.add(linked);
    }
  }
  return [...refs];
}

function clipSingleLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}
