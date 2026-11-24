/**
 * Role: Pure canonical per-call usage evaluation (pricing, cache-hit classification,
 * thread-isolated continuity deltas), cache-hit distribution, Main vs Subagent role split,
 * and session family rollups. Excludes anomaly synthesis and CLI/TUI rendering.
 */

import type {
  CacheHitBucketSummary,
  CacheHitDistribution,
  CacheMissCause,
  CallCacheStatus,
  FamilyUsageRow,
  SessionFamilyProjection,
  SessionProjection,
  SessionRelatedWorkProjection,
  UsageAnomalyKind,
  UsageRoleSplit,
  UsageRoleStats,
} from "@cchistory/domain";
import type { UsageAggregationRow, UsageFilters, UsageSourceData } from "./usage.js";
import {
  addResolvedModelUsageToCostBreakdown,
  createEmptyCostBreakdown,
  resolveModelPricing,
  type ResolvedModelPricing,
} from "./usage-pricing.js";

const IDLE_TTL_GAP_MS = 5 * 60 * 1_000;

export interface EvaluatedUsageRow {
  rowIndex: number;
  row: UsageAggregationRow;
  listCostUsd: number;
  adjustedCostUsd: number;
  highContextTier: boolean;
  cacheAdjustedSavingsUsd: number;
  totalInputTokens: number;
  contextInputTokens: number;
  cacheHitRatio: number | null;
  threadKey: string;
  parentSessionId?: string;
  isSubagent: boolean;
  agentKey?: string;
  gapMs: number | null;
  contextDeltaTokens: number | null;
  cacheStatus: CallCacheStatus;
  missCause?: CacheMissCause;
  missExtraCostUsd: number;
  anomalyKinds: UsageAnomalyKind[];
}

export interface DelegationIndex {
  parentByChild: Map<string, string>;
  agentKeyByChild: Map<string, string>;
  childrenByParent: Map<string, Set<string>>;
  sidecarKeysByParent: Map<string, Set<string>>;
}

export function buildDelegationIndex(
  sessions: readonly SessionProjection[],
  families: readonly SessionFamilyProjection[] = [],
  relatedWork: readonly SessionRelatedWorkProjection[] = [],
): DelegationIndex {
  const sessionIds = new Set(sessions.map((s) => s.id));
  const parentByChild = new Map<string, string>();
  const agentKeyByChild = new Map<string, string>();
  const childrenByParent = new Map<string, Set<string>>();
  const sidecarKeysByParent = new Map<string, Set<string>>();

  const link = (parentId: string, childId: string, agentKey?: string) => {
    if (!parentId || !childId || parentId === childId) return;
    if (!sessionIds.has(parentId) || !sessionIds.has(childId)) return;
    if (!parentByChild.has(childId)) parentByChild.set(childId, parentId);
    if (agentKey && !agentKeyByChild.has(childId)) agentKeyByChild.set(childId, agentKey);
    const children = childrenByParent.get(parentId) ?? new Set<string>();
    children.add(childId);
    childrenByParent.set(parentId, children);
  };

  for (const family of families) {
    for (const child of family.children) {
      if (child.identity_kind === "session" && child.child_session_ref) {
        link(family.parent_session_ref, child.child_session_ref, child.agent_key);
      } else if (child.identity_kind === "sidecar" && child.agent_key) {
        const set = sidecarKeysByParent.get(family.parent_session_ref) ?? new Set<string>();
        set.add(child.agent_key);
        sidecarKeysByParent.set(family.parent_session_ref, set);
      }
    }
  }

  for (const rel of relatedWork) {
    if (rel.relation_kind !== "delegated_session") continue;
    if (rel.parent_session_ref && rel.child_session_ref) {
      link(rel.parent_session_ref, rel.child_session_ref, rel.child_agent_key);
    }
  }

  return { parentByChild, agentKeyByChild, childrenByParent, sidecarKeysByParent };
}

export function compareEvaluatedRows(left: EvaluatedUsageRow, right: EvaluatedUsageRow): number {
  const lt = left.row.timestamp_ms;
  const rt = right.row.timestamp_ms;
  if (Number.isFinite(lt) && Number.isFinite(rt) && lt !== rt) return lt - rt;
  const ls = left.row.seq ?? left.rowIndex;
  const rs = right.row.seq ?? right.rowIndex;
  return ls - rs;
}

export function evaluateUsageRowsForDiagnostics(
  rows: readonly UsageAggregationRow[],
  filters: UsageFilters,
  delegation: DelegationIndex,
): EvaluatedUsageRow[] {
  const pricingCache = new Map<string, ResolvedModelPricing>();
  const evaluated: EvaluatedUsageRow[] = rows.map((row, rowIndex) => {
    let resolved = pricingCache.get(row.model);
    if (!resolved) {
      resolved = resolveModelPricing(row.model, filters.pricing);
      pricingCache.set(row.model, resolved);
    }
    const cost = createEmptyCostBreakdown();
    addResolvedModelUsageToCostBreakdown(cost, resolved, row);
    const totalInput = row.input_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens;
    const contextInput = row.context_input_tokens ?? totalInput;
    const cacheHitRatio = totalInput > 0 ? row.cache_read_input_tokens / totalInput : null;
    const parentSessionId = delegation.parentByChild.get(row.session_id);
    const isSubagent = Boolean(row.subagent_key || parentSessionId);
    return {
      rowIndex,
      row,
      listCostUsd: cost.list_cost_usd,
      adjustedCostUsd: cost.adjusted_cost_usd,
      highContextTier: (cost.high_context_call_count ?? 0) > 0,
      cacheAdjustedSavingsUsd: cost.cache_adjusted_savings_usd ?? 0,
      totalInputTokens: totalInput,
      contextInputTokens: contextInput,
      cacheHitRatio,
      threadKey: `${row.session_id}::${row.subagent_key ?? "__main__"}`,
      parentSessionId: row.subagent_key ? row.session_id : parentSessionId,
      isSubagent,
      agentKey: row.subagent_key ?? delegation.agentKeyByChild.get(row.session_id),
      gapMs: null,
      contextDeltaTokens: null,
      cacheStatus: totalInput > 0 ? "hit" : "no_input",
      missExtraCostUsd: 0,
      anomalyKinds: [],
    };
  });

  // Group by execution thread (session + main/sidecar) so interleaved sidecar calls never corrupt continuity.
  // Session-aggregate rows (e.g. Hermes per-model session totals) are excluded from per-call continuity.
  const byThread = new Map<string, EvaluatedUsageRow[]>();
  for (const item of evaluated) {
    if (item.row.usage_scope === "session") continue;
    const list = byThread.get(item.threadKey) ?? [];
    list.push(item);
    byThread.set(item.threadKey, list);
  }

  for (const thread of byThread.values()) {
    thread.sort(compareEvaluatedRows);
    let prev: EvaluatedUsageRow | undefined;
    for (let idx = 0; idx < thread.length; idx += 1) {
      const cur = thread[idx]!;
      if (prev) {
        if (Number.isFinite(cur.row.timestamp_ms) && Number.isFinite(prev.row.timestamp_ms)) {
          cur.gapMs = Math.max(0, cur.row.timestamp_ms - prev.row.timestamp_ms);
        }
        if (cur.totalInputTokens > 0 && prev.totalInputTokens > 0) {
          cur.contextDeltaTokens = cur.contextInputTokens - prev.contextInputTokens;
        }
      }

      if (cur.totalInputTokens === 0) {
        cur.cacheStatus = "no_input";
      } else if (!prev) {
        cur.cacheStatus = cur.cacheHitRatio !== null && cur.cacheHitRatio >= 0.5 ? "hit" : "cold_start";
        if (cur.cacheStatus === "cold_start") cur.missCause = "cold_start";
      } else if (cur.cacheHitRatio !== null && cur.cacheHitRatio >= 0.9) {
        cur.cacheStatus = "hit";
      } else if (cur.cacheHitRatio !== null && cur.cacheHitRatio >= 0.5) {
        cur.cacheStatus = "degraded";
      } else {
        cur.cacheStatus = "miss";
        cur.missCause = classifyCacheMissCause(prev, cur);
        cur.missExtraCostUsd = estimateMissExtraCostUsd(cur, filters);
      }
      prev = cur;
    }
  }

  return evaluated;
}

function classifyCacheMissCause(prev: EvaluatedUsageRow, cur: EvaluatedUsageRow): CacheMissCause {
  if (cur.row.compaction_before) return "compaction";
  if (prev.contextInputTokens >= 20_000 && cur.contextInputTokens <= prev.contextInputTokens * 0.65) {
    return "compaction";
  }
  if (prev.row.model !== "unknown" && cur.row.model !== "unknown" && prev.row.model !== cur.row.model) {
    return "model_switch";
  }
  if (cur.gapMs !== null && cur.gapMs >= IDLE_TTL_GAP_MS) {
    return "idle_ttl_gap";
  }
  return "prefix_invalidation";
}

function estimateMissExtraCostUsd(item: EvaluatedUsageRow, filters: UsageFilters): number {
  const resolved = resolveModelPricing(item.row.model, filters.pricing);
  const prices = resolved.unit_prices;
  if (!prices) return 0;
  const mult = resolved.multipliers;
  const cacheReadRate = (prices.cache_read ?? prices.input) * mult.model * mult.cache_read;
  const inputRate = prices.input * mult.model * mult.input;
  const cacheWriteRate = (prices.cache_write ?? prices.input) * mult.model * mult.cache_write;
  const extraFromUncached = Math.max(0, inputRate - cacheReadRate) * (item.row.input_tokens / 1_000_000);
  const extraFromWrite = Math.max(0, cacheWriteRate - cacheReadRate) * (item.row.cache_creation_input_tokens / 1_000_000);
  return extraFromUncached + extraFromWrite;
}

export function computeCacheHitDistribution(evaluated: readonly EvaluatedUsageRow[]): CacheHitDistribution {
  const buckets = {
    healthy: { count: 0, zeroCount: 0, tokens: 0, cost: 0 },
    degraded: { count: 0, zeroCount: 0, tokens: 0, cost: 0 },
    cold_or_miss: { count: 0, zeroCount: 0, tokens: 0, cost: 0 },
  };
  let evaluatedCount = 0;
  let totalCost = 0;

  for (const item of evaluated) {
    if (item.row.usage_scope === "session" || item.cacheHitRatio === null) continue;
    evaluatedCount += 1;
    totalCost += item.adjustedCostUsd;
    const key =
      item.cacheHitRatio >= 0.9 ? "healthy" : item.cacheHitRatio >= 0.5 ? "degraded" : "cold_or_miss";
    const bucket = buckets[key];
    bucket.count += 1;
    if (item.row.cache_read_input_tokens === 0) bucket.zeroCount += 1;
    bucket.tokens += item.row.total_tokens;
    bucket.cost += item.adjustedCostUsd;
  }

  const make = (bucket: "healthy" | "degraded" | "cold_or_miss", label: string): CacheHitBucketSummary => {
    const b = buckets[bucket];
    return {
      bucket,
      label,
      call_count: b.count,
      ...(bucket === "cold_or_miss" ? { zero_hit_call_count: b.zeroCount } : {}),
      call_share: evaluatedCount > 0 ? b.count / evaluatedCount : 0,
      total_tokens: b.tokens,
      adjusted_cost_usd: b.cost,
      cost_share: totalCost > 0 ? b.cost / totalCost : 0,
    };
  };

  return {
    evaluated_call_count: evaluatedCount,
    buckets: [make("healthy", "≥90%"), make("degraded", "50–90%"), make("cold_or_miss", "<50%")],
  };
}

export function computeUsageRoleSplit(evaluated: readonly EvaluatedUsageRow[]): UsageRoleSplit {
  const init = () => ({
    sessions: new Set<string>(),
    calls: 0,
    tokens: 0,
    cost: 0,
    inputTotal: 0,
    cacheRead: 0,
  });
  const main = init();
  const sub = init();

  for (const item of evaluated) {
    const target = item.isSubagent ? sub : main;
    target.sessions.add(item.row.subagent_key ? `${item.row.session_id}#${item.row.subagent_key}` : item.row.session_id);
    target.calls += 1;
    target.tokens += item.row.total_tokens;
    target.cost += item.adjustedCostUsd;
    target.inputTotal += item.totalInputTokens;
    target.cacheRead += item.row.cache_read_input_tokens;
  }

  const totalCost = main.cost + sub.cost;
  const toStats = (s: ReturnType<typeof init>): UsageRoleStats => ({
    session_count: s.sessions.size,
    call_count: s.calls,
    total_tokens: s.tokens,
    adjusted_cost_usd: s.cost,
    cost_share: totalCost > 0 ? s.cost / totalCost : 0,
    cache_hit_ratio: s.inputTotal > 0 ? s.cacheRead / s.inputTotal : null,
  });

  return { main: toStats(main), subagents: toStats(sub) };
}

export function computeFamilyUsageRows(
  evaluated: readonly EvaluatedUsageRow[],
  sourceData: UsageSourceData,
  delegation: DelegationIndex,
): FamilyUsageRow[] {
  const sessionsById = new Map(sourceData.listResolvedSessions().map((s) => [s.id, s]));
  const seenSessionIds = new Set<string>();
  interface FamilyAcc {
    parentId: string;
    title: string;
    projectLabel: string;
    sourceLabel: string;
    subagents: Set<string>;
    selfCalls: number;
    selfTokens: number;
    selfCost: number;
    selfInput: number;
    selfCR: number;
    subCalls: number;
    subTokens: number;
    subCost: number;
    subInput: number;
    subCR: number;
    missCount: number;
    highCtxCount: number;
    latestTs: number;
  }

  const map = new Map<string, FamilyAcc>();
  for (const item of evaluated) {
    seenSessionIds.add(item.row.session_id);
    const parentId = item.parentSessionId ?? item.row.session_id;
    let acc = map.get(parentId);
    if (!acc) {
      const parentSession = sessionsById.get(parentId);
      acc = {
        parentId,
        title: parentSession?.canonical_title ?? parentSession?.title ?? item.row.session_label,
        projectLabel: item.row.project_label,
        sourceLabel: item.row.source_label,
        subagents: new Set<string>(),
        selfCalls: 0,
        selfTokens: 0,
        selfCost: 0,
        selfInput: 0,
        selfCR: 0,
        subCalls: 0,
        subTokens: 0,
        subCost: 0,
        subInput: 0,
        subCR: 0,
        missCount: 0,
        highCtxCount: 0,
        latestTs: Number.NEGATIVE_INFINITY,
      };
      map.set(parentId, acc);
    }
    if (item.isSubagent) {
      acc.subagents.add(item.row.subagent_key ? `sidecar:${item.row.subagent_key}` : item.row.session_id);
      acc.subCalls += 1;
      acc.subTokens += item.row.total_tokens;
      acc.subCost += item.adjustedCostUsd;
      acc.subInput += item.totalInputTokens;
      acc.subCR += item.row.cache_read_input_tokens;
    } else {
      acc.selfCalls += 1;
      acc.selfTokens += item.row.total_tokens;
      acc.selfCost += item.adjustedCostUsd;
      acc.selfInput += item.totalInputTokens;
      acc.selfCR += item.row.cache_read_input_tokens;
    }
    if (item.cacheStatus === "miss") acc.missCount += 1;
    if (item.highContextTier) acc.highCtxCount += 1;
    if (Number.isFinite(item.row.timestamp_ms) && item.row.timestamp_ms > acc.latestTs) {
      acc.latestTs = item.row.timestamp_ms;
    }
  }

  for (const [parentId, acc] of map.entries()) {
    for (const childId of delegation.childrenByParent.get(parentId) ?? []) {
      if (seenSessionIds.has(childId)) acc.subagents.add(childId);
    }
  }

  return [...map.values()]
    .map((acc): FamilyUsageRow => {
      const totalInput = acc.selfInput + acc.subInput;
      const signals: string[] = [];
      if (acc.subagents.size > 0) signals.push(`${acc.subagents.size}sub`);
      if (acc.missCount > 0) signals.push(`${acc.missCount}miss`);
      if (acc.highCtxCount > 0) signals.push(`>200K×${acc.highCtxCount}`);
      return {
        parent_session_id: acc.parentId,
        title: acc.title,
        project_label: acc.projectLabel,
        source_label: acc.sourceLabel,
        subagent_count: acc.subagents.size,
        self_calls: acc.selfCalls,
        self_tokens: acc.selfTokens,
        self_cost_usd: acc.selfCost,
        self_cache_hit_ratio: acc.selfInput > 0 ? acc.selfCR / acc.selfInput : null,
        subagent_calls: acc.subCalls,
        subagent_tokens: acc.subTokens,
        subagent_cost_usd: acc.subCost,
        subagent_cache_hit_ratio: acc.subInput > 0 ? acc.subCR / acc.subInput : null,
        total_calls: acc.selfCalls + acc.subCalls,
        total_tokens: acc.selfTokens + acc.subTokens,
        total_cost_usd: acc.selfCost + acc.subCost,
        combined_cache_hit_ratio: totalInput > 0 ? (acc.selfCR + acc.subCR) / totalInput : null,
        signals,
        anomaly_count: acc.missCount + acc.highCtxCount,
        last_activity_at: Number.isFinite(acc.latestTs) ? new Date(acc.latestTs).toISOString() : undefined,
      };
    })
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd || b.total_tokens - a.total_tokens);
}
