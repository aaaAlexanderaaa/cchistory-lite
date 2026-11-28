/**
 * Role: Pure canonical usage anomaly synthesis (6 typed anomaly classes) and top-level
 * diagnostics report assembly over evaluated per-call rows, families, and tool loop clusters.
 * Excludes raw adapter parsing, pricing catalog storage, and CLI/TUI rendering.
 */

import type {
  FamilyUsageRow,
  ToolLoopCluster,
  UsageAnomaly,
  UsageAnomalyKind,
  UsageDiagnosticsReport,
  UsageToolSummary,
} from "@cchistory/domain";
import { nowIso, stableId } from "@cchistory/domain";
import type { UsageAggregationRow, UsageFilters, UsageSourceData } from "./usage.js";
import {
  buildDelegationIndex,
  compareEvaluatedRows,
  computeCacheHitDistribution,
  computeFamilyUsageRows,
  computeUsageRoleSplit,
  evaluateUsageRowsForDiagnostics,
  type DelegationIndex,
  type EvaluatedUsageRow,
} from "./usage-call-evaluation.js";
import { computeToolPatternsAndLoops } from "./usage-tool-patterns.js";

export {
  CALL_CACHE_HIT_DEGRADED_RATIO,
  CALL_CACHE_HIT_HEALTHY_RATIO,
  COMPACTION_DROP_MAX_RETAINED_RATIO,
  COMPACTION_DROP_MIN_CONTEXT_TOKENS,
  DEEPSEEK_DISK_CACHE_IDLE_GAP_MS,
  DEFAULT_IDLE_TTL_GAP_MS,
  buildDelegationIndex,
  computeCacheHitDistribution,
  computeFamilyUsageRows,
  computeUsageRoleSplit,
  evaluateUsageRowsForDiagnostics,
  resolveProviderIdleTtlGapMs,
  type DelegationIndex,
  type EvaluatedUsageRow,
} from "./usage-call-evaluation.js";
export { computeToolPatternsAndLoops } from "./usage-tool-patterns.js";

/** Single-source diagnostic thresholds shared with CLI and TUI surfaces. */
export const CACHE_MISS_LOW_HIT_RATIO = 0.2;
export const CACHE_MISS_MIN_CONTEXT = 10_000;
export const CONTEXT_BLOAT_MIN_DELTA = 20_000;
export const CONTEXT_BLOAT_MIN_OUTPUT_BYTES = 32 * 1024;
export const CONTEXT_BLOAT_LARGE_OUTPUT_BYTES = 64 * 1024;
export const TOOL_OUTPUT_NOTABLE_BYTES = 16 * 1024;
/** Aggregate session/day/rollup cache-hit display bands (averages sit lower than warm per-call ≥90%). */
export const AGGREGATE_CACHE_HIT_GOOD_RATIO = 0.7;
export const AGGREGATE_CACHE_HIT_WARN_RATIO = 0.4;

export function detectUsageAnomalies(params: {
  evaluated: readonly EvaluatedUsageRow[];
  loops: readonly ToolLoopCluster[];
  families: readonly FamilyUsageRow[];
  delegation?: DelegationIndex;
  loopRowIndicesById?: ReadonlyMap<string, ReadonlySet<number>>;
}): UsageAnomaly[] {
  const { evaluated, loops, families, delegation, loopRowIndicesById } = params;
  const anomalies: UsageAnomaly[] = [];
  const byRowIndex = new Map(evaluated.map((item) => [item.rowIndex, item]));

  const byThread = new Map<string, EvaluatedUsageRow[]>();
  for (const item of evaluated) {
    if (item.row.usage_scope === "session") continue;
    const list = byThread.get(item.threadKey) ?? [];
    list.push(item);
    byThread.set(item.threadKey, list);
  }

  for (const thread of byThread.values()) {
    thread.sort(compareEvaluatedRows);
    let consecutiveToolErrors = 0;
    let errorStartIdx = -1;
    let errorTokens = 0;
    let errorCost = 0;
    let errorToolSample = "";

    const flushErrorRun = (endIdx: number) => {
      if (consecutiveToolErrors >= 3 && errorStartIdx >= 0) {
        const first = thread[errorStartIdx]!;
        const last = thread[endIdx]!;
        for (let k = errorStartIdx; k <= endIdx; k += 1) {
          pushAnomalyKind(thread[k]!, "tool_error_loop");
        }
        anomalies.push({
          id: stableId("anom", "tool_error_loop", first.row.session_id, String(first.row.seq ?? errorStartIdx)),
          kind: "tool_error_loop",
          severity: errorCost >= 0.5 || consecutiveToolErrors >= 6 ? "high" : "medium",
          session_id: first.row.session_id,
          session_title: first.row.session_label,
          parent_session_id: first.parentSessionId,
          subagent_key: first.row.subagent_key,
          turn_id: first.row.turn_id,
          call_seq: first.row.seq,
          call_seq_end: last.row.seq,
          timestamp: first.row.created_at,
          impact_usd: errorCost,
          impact_tokens: errorTokens,
          summary: `${errorToolSample || "tool"} failed ${consecutiveToolErrors} times consecutively`,
          evidence: {
            error_count: consecutiveToolErrors,
            sample_tool: errorToolSample || undefined,
            tokens: errorTokens,
            cost_usd: errorCost,
          },
        });
      }
      consecutiveToolErrors = 0;
      errorStartIdx = -1;
      errorTokens = 0;
      errorCost = 0;
      errorToolSample = "";
    };

    for (let idx = 0; idx < thread.length; idx += 1) {
      const cur = thread[idx]!;
      const prev = idx > 0 ? thread[idx - 1] : undefined;

      // 1. Cache miss cliff
      if (
        prev &&
        cur.cacheStatus === "miss" &&
        cur.cacheHitRatio !== null &&
        cur.cacheHitRatio < CACHE_MISS_LOW_HIT_RATIO &&
        (prev.contextInputTokens >= CACHE_MISS_MIN_CONTEXT || cur.totalInputTokens >= CACHE_MISS_MIN_CONTEXT) &&
        (prev.cacheHitRatio === null || prev.cacheHitRatio >= 0.5 || cur.row.input_tokens + cur.row.cache_creation_input_tokens >= CACHE_MISS_MIN_CONTEXT)
      ) {
        pushAnomalyKind(cur, "cache_miss_cliff");
        const slowTool = findLongestTool(cur.row.preceding_tool_results);
        const cause = cur.missCause ?? "prefix_invalidation";
        const prevHitPct = prev.cacheHitRatio !== null ? `${Math.round(prev.cacheHitRatio * 100)}%` : "n/a";
        const curHitPct = `${Math.round(cur.cacheHitRatio * 100)}%`;
        const detail =
          cause === "idle_ttl_gap"
            ? `idle ${formatDurationBrief(cur.gapMs ?? 0)}${slowTool ? ` after ${formatToolLabel(slowTool)}` : ""}`
            : cause === "model_switch"
              ? `model ${prev.row.model} → ${cur.row.model}`
              : cause === "compaction"
                ? `compaction ${formatTokBrief(prev.contextInputTokens)} → ${formatTokBrief(cur.contextInputTokens)}`
                : `prefix invalidation (${formatDurationBrief(cur.gapMs ?? 0)} gap, same model)`;
        const hitTransition =
          prev.cacheHitRatio !== null && prev.cacheHitRatio < CACHE_MISS_LOW_HIT_RATIO
            ? `hit ${curHitPct} (still cold)`
            : `hit ${prevHitPct}→${curHitPct}`;
        anomalies.push({
          id: stableId("anom", "cache_miss_cliff", cur.row.session_id, cur.row.event_id ?? String(idx)),
          kind: "cache_miss_cliff",
          severity: cur.missExtraCostUsd >= 0.25 || cur.totalInputTokens >= 80_000 ? "high" : "medium",
          session_id: cur.row.session_id,
          session_title: cur.row.session_label,
          parent_session_id: cur.parentSessionId,
          subagent_key: cur.row.subagent_key,
          turn_id: cur.row.turn_id,
          call_seq: cur.row.seq,
          timestamp: cur.row.created_at,
          impact_usd: cur.missExtraCostUsd > 0 ? cur.missExtraCostUsd : cur.adjustedCostUsd,
          impact_tokens: cur.row.input_tokens + cur.row.cache_creation_input_tokens,
          summary: `${hitTransition} · ${detail}`,
          evidence: {
            prev_hit_ratio: prev.cacheHitRatio,
            cur_hit_ratio: cur.cacheHitRatio,
            miss_cause: cause,
            gap_ms: cur.gapMs,
            prev_model: prev.row.model,
            cur_model: cur.row.model,
            prev_context_tokens: prev.contextInputTokens,
            cur_context_tokens: cur.contextInputTokens,
            uncached_and_write_tokens: cur.row.input_tokens + cur.row.cache_creation_input_tokens,
            extra_cost_usd: cur.missExtraCostUsd,
            preceding_tool: slowTool ? formatToolLabel(slowTool) : undefined,
          },
        });
      }

      // 2. Context bloat from a giant tool output or sudden context jump
      const biggestOutputTool = findLargestOutputTool(cur.row.preceding_tool_results);
      const delta = cur.contextDeltaTokens ?? 0;
      const bigOutputBytes = biggestOutputTool?.output_bytes ?? 0;
      if (
        delta >= CONTEXT_BLOAT_MIN_DELTA ||
        bigOutputBytes >= CONTEXT_BLOAT_LARGE_OUTPUT_BYTES ||
        (bigOutputBytes >= CONTEXT_BLOAT_MIN_OUTPUT_BYTES && delta >= 8_000)
      ) {
        pushAnomalyKind(cur, "context_bloat");
        let remainingCalls = 0;
        for (let r = idx + 1; r < thread.length; r += 1) {
          if (thread[r]!.missCause === "compaction") break;
          remainingCalls += 1;
        }
        const estAmplification = delta > 0 ? delta * remainingCalls : 0;
        const toolText = biggestOutputTool
          ? `${formatToolLabel(biggestOutputTool)} out ${formatBytesBrief(bigOutputBytes)}`
          : "context jump";
        anomalies.push({
          id: stableId("anom", "context_bloat", cur.row.session_id, cur.row.event_id ?? String(idx)),
          kind: "context_bloat",
          severity: delta >= 50_000 || bigOutputBytes >= 128 * 1024 ? "high" : "medium",
          session_id: cur.row.session_id,
          session_title: cur.row.session_label,
          parent_session_id: cur.parentSessionId,
          subagent_key: cur.row.subagent_key,
          turn_id: cur.row.turn_id,
          call_seq: cur.row.seq,
          timestamp: cur.row.created_at,
          impact_usd: cur.adjustedCostUsd,
          impact_tokens: delta > 0 ? delta : Math.round(bigOutputBytes / 4),
          summary: `${toolText} → +${formatTokBrief(Math.max(0, delta))} ctx${remainingCalls > 0 ? ` (×${remainingCalls} later calls)` : ""}`,
          evidence: {
            context_delta_tokens: delta,
            output_bytes: bigOutputBytes || undefined,
            tool: biggestOutputTool?.tool_name,
            target_signature: biggestOutputTool?.target_signature,
            remaining_calls_in_prefix: remainingCalls,
            estimated_amplification_tokens: estAmplification,
          },
        });
      }

      // 3. Long-context tier cliff
      if (cur.highContextTier && (!prev || !prev.highContextTier)) {
        pushAnomalyKind(cur, "high_context_cliff");
        let tierCalls = 0;
        let tierCost = 0;
        for (let r = idx; r < thread.length && thread[r]!.highContextTier; r += 1) {
          tierCalls += 1;
          tierCost += thread[r]!.adjustedCostUsd;
        }
        anomalies.push({
          id: stableId("anom", "high_context_cliff", cur.row.session_id, cur.row.event_id ?? String(idx)),
          kind: "high_context_cliff",
          severity: tierCost >= 1 ? "high" : "medium",
          session_id: cur.row.session_id,
          session_title: cur.row.session_label,
          parent_session_id: cur.parentSessionId,
          subagent_key: cur.row.subagent_key,
          turn_id: cur.row.turn_id,
          call_seq: cur.row.seq,
          timestamp: cur.row.created_at,
          impact_usd: tierCost,
          impact_tokens: cur.contextInputTokens,
          summary: `crossed long-context tier at ${formatTokBrief(cur.contextInputTokens)} (${tierCalls} calls)`,
          evidence: {
            context_input_tokens: cur.contextInputTokens,
            tier_call_count: tierCalls,
            tier_cost_usd: tierCost,
            model: cur.row.model,
          },
        });
      }

      // 4. Consecutive tool error loop tracking
      const errTools = (cur.row.preceding_tool_results ?? []).filter((t) => t.status === "error");
      if (errTools.length > 0) {
        if (errorStartIdx === -1) errorStartIdx = idx;
        consecutiveToolErrors += errTools.length;
        errorTokens += cur.row.total_tokens;
        errorCost += cur.adjustedCostUsd;
        if (!errorToolSample) errorToolSample = formatToolLabel(errTools[0]!);
      } else {
        flushErrorRun(idx - 1);
      }
    }
    flushErrorRun(thread.length - 1);
  }

  // 5. Polling / repeated-command loop clusters
  for (const loop of loops) {
    if (loop.exec_count < 4 && loop.attributed_cost_usd < 0.05 && loop.attributed_tokens < 50_000) continue;
    for (const rowIndex of loopRowIndicesById?.get(loop.id) ?? []) {
      const target = byRowIndex.get(rowIndex);
      if (target) pushAnomalyKind(target, "polling_loop");
    }
    const parentSessionId = loop.subagent_key
      ? loop.session_id
      : delegation?.parentByChild.get(loop.session_id);
    anomalies.push({
      id: stableId("anom", "polling_loop", loop.id),
      kind: "polling_loop",
      severity: loop.exec_count >= 10 || loop.attributed_cost_usd >= 0.5 ? "high" : "medium",
      session_id: loop.session_id,
      session_title: loop.session_title,
      ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
      subagent_key: loop.subagent_key,
      turn_id: loop.turn_id,
      call_seq: loop.first_call_seq,
      call_seq_end: loop.last_call_seq,
      timestamp: loop.first_at,
      impact_usd: loop.attributed_cost_usd,
      impact_tokens: loop.attributed_tokens,
      summary: `${loop.tool_name}("${loop.target_signature}") ×${loop.exec_count} in ${formatDurationBrief(loop.duration_ms)} (${loop.attributed_call_count} calls)`,
      evidence: {
        tool_name: loop.tool_name,
        target_signature: loop.target_signature,
        exec_count: loop.exec_count,
        error_count: loop.error_count,
        duration_ms: loop.duration_ms,
        attributed_call_count: loop.attributed_call_count,
        attributed_tokens: loop.attributed_tokens,
        attributed_cost_usd: loop.attributed_cost_usd,
        avg_cache_hit_ratio: loop.avg_cache_hit_ratio,
        min_cache_hit_ratio: loop.min_cache_hit_ratio,
      },
    });
  }

  // 6. Subagent fan-out / cold-start tax
  for (const fam of families) {
    if (fam.subagent_count === 0) continue;
    const subCostShare = fam.total_cost_usd > 0 ? fam.subagent_cost_usd / fam.total_cost_usd : 0;
    const subTokenShare = fam.total_tokens > 0 ? fam.subagent_tokens / fam.total_tokens : 0;
    const hitDrop =
      fam.self_cache_hit_ratio !== null && fam.subagent_cache_hit_ratio !== null
        ? fam.self_cache_hit_ratio - fam.subagent_cache_hit_ratio
        : 0;
    const lowSubHit = fam.subagent_cache_hit_ratio !== null && fam.subagent_cache_hit_ratio < 0.6;
    if (
      (fam.subagent_count >= 3 && (subCostShare >= 0.4 || subTokenShare >= 0.4)) ||
      (fam.subagent_count >= 2 && lowSubHit && hitDrop >= 0.15)
    ) {
      const sharePct = Math.round(Math.max(subCostShare, subTokenShare) * 100);
      const subHitText =
        fam.subagent_cache_hit_ratio !== null ? `${Math.round(fam.subagent_cache_hit_ratio * 100)}%` : "n/a";
      anomalies.push({
        id: stableId("anom", "subagent_fanout", fam.parent_session_id),
        kind: "subagent_fanout",
        severity: fam.subagent_cost_usd >= 1 || fam.subagent_count >= 8 ? "high" : "medium",
        session_id: fam.parent_session_id,
        session_title: fam.title,
        timestamp: fam.last_activity_at,
        impact_usd: fam.subagent_cost_usd,
        impact_tokens: fam.subagent_tokens,
        summary: `${fam.subagent_count} subagents = ${sharePct}% of family · subagent hit ${subHitText}`,
        evidence: {
          subagent_count: fam.subagent_count,
          self_cost_usd: fam.self_cost_usd,
          subagent_cost_usd: fam.subagent_cost_usd,
          self_cache_hit_ratio: fam.self_cache_hit_ratio,
          subagent_cache_hit_ratio: fam.subagent_cache_hit_ratio,
        },
      });
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  anomalies.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      (b.impact_usd ?? 0) - (a.impact_usd ?? 0) ||
      (b.impact_tokens ?? 0) - (a.impact_tokens ?? 0),
  );
  return anomalies;
}

export function computeUsageDiagnosticsReport(params: {
  rows: readonly UsageAggregationRow[];
  filters: UsageFilters;
  sourceData: UsageSourceData;
}): { report: UsageDiagnosticsReport; evaluated: EvaluatedUsageRow[]; delegation: DelegationIndex } {
  const { rows, filters, sourceData } = params;
  const delegation = buildDelegationIndex(
    sourceData.listResolvedSessions(),
    sourceData.listSessionFamilies?.() ?? [],
    sourceData.listRelatedWork?.() ?? [],
  );
  const evaluated = evaluateUsageRowsForDiagnostics(rows, filters, delegation);
  const cache_distribution = computeCacheHitDistribution(evaluated);
  const role_split = computeUsageRoleSplit(evaluated);
  const { tool_patterns, loops, loopRowIndicesById } = computeToolPatternsAndLoops(evaluated);
  const families = computeFamilyUsageRows(evaluated, sourceData, delegation);
  const anomalies = detectUsageAnomalies({ evaluated, loops, families, delegation, loopRowIndicesById });

  // Attach anomaly counts & loop badges onto family rows.
  const anomaliesByFamily = new Map<string, UsageAnomaly[]>();
  for (const anomaly of anomalies) {
    const familyId = anomaly.parent_session_id ?? anomaly.session_id;
    const list = anomaliesByFamily.get(familyId) ?? [];
    list.push(anomaly);
    anomaliesByFamily.set(familyId, list);
  }
  for (const fam of families) {
    const famAnomalies = anomaliesByFamily.get(fam.parent_session_id) ?? [];
    fam.anomaly_count = famAnomalies.length;
    const topLoop = loops.find(
      (l) => (delegation.parentByChild.get(l.session_id) ?? l.session_id) === fam.parent_session_id,
    );
    if (topLoop) fam.signals.push(`loop:${topLoop.tool_name}×${topLoop.exec_count}`);
  }

  return {
    evaluated,
    delegation,
    report: {
      generated_at: nowIso(),
      cache_distribution,
      role_split,
      families,
      tool_patterns,
      loops,
      anomalies,
    },
  };
}

function pushAnomalyKind(row: EvaluatedUsageRow, kind: UsageAnomalyKind): void {
  if (!row.anomalyKinds.includes(kind)) row.anomalyKinds.push(kind);
}

function findLongestTool(tools: readonly UsageToolSummary[] | undefined): UsageToolSummary | undefined {
  if (!tools?.length) return undefined;
  let best: UsageToolSummary | undefined;
  for (const t of tools) {
    if (!best || (t.duration_ms ?? -1) > (best.duration_ms ?? -1)) best = t;
  }
  return best;
}

function findLargestOutputTool(tools: readonly UsageToolSummary[] | undefined): UsageToolSummary | undefined {
  if (!tools?.length) return undefined;
  let best: UsageToolSummary | undefined;
  for (const t of tools) {
    if (!best || (t.output_bytes ?? -1) > (best.output_bytes ?? -1)) best = t;
  }
  return best;
}

function formatToolLabel(tool: UsageToolSummary): string {
  const sig = tool.target_signature ? `("${tool.target_signature.slice(0, 32)}")` : "";
  return `${tool.tool_name}${sig}`;
}

function formatDurationBrief(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
}

function formatTokBrief(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

function formatBytesBrief(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
