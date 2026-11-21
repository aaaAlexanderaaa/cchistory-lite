/**
 * Role: Pure canonical tool/command pattern aggregation and tight-window polling-loop
 * clustering over causally attributed per-call usage rows.
 * Excludes raw adapter parsing, anomaly ranking, and CLI/TUI rendering.
 */

import type { ToolLoopCluster, ToolPatternRow, UsageToolSummary } from "@cchistory/domain";
import { stableId } from "@cchistory/domain";
import { compareEvaluatedRows, type EvaluatedUsageRow } from "./usage-call-evaluation.js";

const LOOP_MAX_GAP_MS = 3 * 60 * 1_000;

interface ToolExecOccurrence {
  toolName: string;
  targetSignature: string;
  sample?: string;
  status: UsageToolSummary["status"];
  durationMs: number;
  outputBytes: number;
  timestampMs: number;
  timestampIso: string;
  sessionId: string;
  sessionLabel: string;
  turnId: string | null;
  subagentKey?: string;
  threadKey: string;
  callSeq?: number;
  attributedRow: EvaluatedUsageRow;
}

export interface ComputedToolPatternsResult {
  tool_patterns: ToolPatternRow[];
  loops: ToolLoopCluster[];
  loopRowIndicesById: Map<string, Set<number>>;
}

export function computeToolPatternsAndLoops(
  evaluated: readonly EvaluatedUsageRow[],
): ComputedToolPatternsResult {
  // Group evaluated rows per thread so we can causally attribute a tool call to the call that consumed its result.
  const byThread = new Map<string, EvaluatedUsageRow[]>();
  for (const item of evaluated) {
    const list = byThread.get(item.threadKey) ?? [];
    list.push(item);
    byThread.set(item.threadKey, list);
  }

  const occurrences: ToolExecOccurrence[] = [];
  for (const thread of byThread.values()) {
    thread.sort(compareEvaluatedRows);
    // Map call_id -> consuming call (via preceding_tool_results on a subsequent call).
    const consumerByCallId = new Map<string, EvaluatedUsageRow>();
    for (const item of thread) {
      for (const tool of item.row.preceding_tool_results ?? []) {
        if (tool.call_id && !consumerByCallId.has(tool.call_id)) {
          consumerByCallId.set(tool.call_id, item);
        }
      }
    }

    const seenCallIds = new Set<string>();
    for (let i = 0; i < thread.length; i += 1) {
      const item = thread[i]!;
      const nextItem = thread[i + 1];
      for (const tool of item.row.emitted_tool_calls ?? []) {
        if (tool.call_id) seenCallIds.add(tool.call_id);
        const attributed = (tool.call_id ? consumerByCallId.get(tool.call_id) : undefined) ?? nextItem ?? item;
        occurrences.push(makeOccurrence(tool, item, attributed));
      }
      for (const tool of item.row.preceding_tool_results ?? []) {
        if (tool.call_id && seenCallIds.has(tool.call_id)) continue;
        if (tool.call_id) seenCallIds.add(tool.call_id);
        occurrences.push(makeOccurrence(tool, item, item));
      }
    }
  }

  // Detect tight-window polling/retry loop clusters per (thread, tool_name, target_signature).
  const byThreadTool = new Map<string, ToolExecOccurrence[]>();
  for (const occ of occurrences) {
    const key = `${occ.threadKey}\0${occ.toolName}\0${occ.targetSignature}`;
    const list = byThreadTool.get(key) ?? [];
    list.push(occ);
    byThreadTool.set(key, list);
  }

  const loops: ToolLoopCluster[] = [];
  const loopCountsByPatternKey = new Map<string, number>();
  const loopRowIndicesById = new Map<string, Set<number>>();

  for (const group of byThreadTool.values()) {
    if (group.length < 3) continue;
    group.sort((a, b) => a.timestampMs - b.timestampMs || (a.callSeq ?? 0) - (b.callSeq ?? 0));
    let cluster: ToolExecOccurrence[] = [group[0]!];
    const flushCluster = () => {
      if (cluster.length >= 3) {
        const first = cluster[0]!;
        const last = cluster.at(-1)!;
        const uniqueRows = new Map<number, EvaluatedUsageRow>();
        let errCount = 0;
        for (const occ of cluster) {
          uniqueRows.set(occ.attributedRow.rowIndex, occ.attributedRow);
          if (occ.status === "error") errCount += 1;
        }
        const metrics = summarizeAttributedRows([...uniqueRows.values()]);
        const patternKey = `${first.toolName}:${first.targetSignature}`;
        loopCountsByPatternKey.set(patternKey, (loopCountsByPatternKey.get(patternKey) ?? 0) + 1);
        const id = stableId("loop", first.sessionId, first.threadKey, patternKey, first.timestampIso, String(cluster.length));
        loopRowIndicesById.set(id, new Set(uniqueRows.keys()));
        loops.push({
          id,
          session_id: first.sessionId,
          session_title: first.sessionLabel,
          turn_id: first.turnId,
          ...(first.subagentKey ? { subagent_key: first.subagentKey } : {}),
          tool_name: first.toolName,
          target_signature: first.targetSignature,
          ...(first.sample ? { sample: first.sample } : {}),
          exec_count: cluster.length,
          error_count: errCount,
          first_at: first.timestampIso,
          last_at: last.timestampIso,
          duration_ms:
            Number.isFinite(first.timestampMs) && Number.isFinite(last.timestampMs)
              ? Math.max(0, last.timestampMs - first.timestampMs)
              : 0,
          first_call_seq: first.callSeq,
          last_call_seq: last.callSeq,
          attributed_call_count: uniqueRows.size,
          attributed_tokens: metrics.tokens,
          attributed_cost_usd: metrics.cost,
          avg_cache_hit_ratio: metrics.avgHit,
          min_cache_hit_ratio: metrics.minHit,
        });
      }
      cluster = [];
    };

    for (let i = 1; i < group.length; i += 1) {
      const prev = cluster.at(-1)!;
      const cur = group[i]!;
      const sameTurn = prev.turnId !== null && cur.turnId === prev.turnId;
      const closeInTime =
        Number.isFinite(prev.timestampMs) &&
        Number.isFinite(cur.timestampMs) &&
        cur.timestampMs - prev.timestampMs <= LOOP_MAX_GAP_MS;
      if (sameTurn || closeInTime) {
        cluster.push(cur);
      } else {
        flushCluster();
        cluster = [cur];
      }
    }
    flushCluster();
  }

  loops.sort((a, b) => b.attributed_cost_usd - a.attributed_cost_usd || b.exec_count - a.exec_count);

  // Aggregate across the full scope by (tool_name, target_signature).
  const byPattern = new Map<
    string,
    {
      toolName: string;
      targetSignature: string;
      sample?: string;
      execCount: number;
      errorCount: number;
      pendingCount: number;
      minTs: number;
      maxTs: number;
      firstIso?: string;
      lastIso?: string;
      totalDurationMs: number;
      totalOutputBytes: number;
      maxOutputBytes: number;
      rows: Map<number, EvaluatedUsageRow>;
      sessions: Set<string>;
    }
  >();

  for (const occ of occurrences) {
    const key = `${occ.toolName}:${occ.targetSignature}`;
    let entry = byPattern.get(key);
    if (!entry) {
      entry = {
        toolName: occ.toolName,
        targetSignature: occ.targetSignature,
        sample: occ.sample,
        execCount: 0,
        errorCount: 0,
        pendingCount: 0,
        minTs: Number.POSITIVE_INFINITY,
        maxTs: Number.NEGATIVE_INFINITY,
        totalDurationMs: 0,
        totalOutputBytes: 0,
        maxOutputBytes: 0,
        rows: new Map(),
        sessions: new Set(),
      };
      byPattern.set(key, entry);
    }
    entry.execCount += 1;
    if (occ.status === "error") entry.errorCount += 1;
    else if (occ.status === "pending") entry.pendingCount += 1;
    if (Number.isFinite(occ.timestampMs)) {
      if (occ.timestampMs < entry.minTs) {
        entry.minTs = occ.timestampMs;
        entry.firstIso = occ.timestampIso;
      }
      if (occ.timestampMs > entry.maxTs) {
        entry.maxTs = occ.timestampMs;
        entry.lastIso = occ.timestampIso;
      }
    }
    entry.totalDurationMs += occ.durationMs;
    entry.totalOutputBytes += occ.outputBytes;
    if (occ.outputBytes > entry.maxOutputBytes) entry.maxOutputBytes = occ.outputBytes;
    entry.rows.set(occ.attributedRow.rowIndex, occ.attributedRow);
    entry.sessions.add(occ.sessionId);
  }

  const tool_patterns: ToolPatternRow[] = [...byPattern.entries()]
    .map(([key, entry]): ToolPatternRow => {
      const metrics = summarizeAttributedRows([...entry.rows.values()]);
      const loopClusters = loopCountsByPatternKey.get(key) ?? 0;
      return {
        key,
        tool_name: entry.toolName,
        target_signature: entry.targetSignature,
        ...(entry.sample ? { sample: entry.sample } : {}),
        exec_count: entry.execCount,
        error_count: entry.errorCount,
        pending_count: entry.pendingCount,
        first_at: entry.firstIso,
        last_at: entry.lastIso,
        span_ms:
          Number.isFinite(entry.minTs) && Number.isFinite(entry.maxTs) ? Math.max(0, entry.maxTs - entry.minTs) : 0,
        total_duration_ms: entry.totalDurationMs,
        attributed_call_count: entry.rows.size,
        attributed_tokens: metrics.tokens,
        attributed_cost_usd: metrics.cost,
        avg_cache_hit_ratio: metrics.avgHit,
        min_cache_hit_ratio: metrics.minHit,
        total_output_bytes: entry.totalOutputBytes,
        max_output_bytes: entry.maxOutputBytes,
        is_loop: loopClusters > 0,
        loop_cluster_count: loopClusters,
        session_ids: [...entry.sessions],
      };
    })
    .sort((a, b) => b.attributed_cost_usd - a.attributed_cost_usd || b.attributed_tokens - a.attributed_tokens || b.exec_count - a.exec_count);

  return { tool_patterns, loops, loopRowIndicesById };
}

function makeOccurrence(
  tool: UsageToolSummary,
  sourceRow: EvaluatedUsageRow,
  attributedRow: EvaluatedUsageRow,
): ToolExecOccurrence {
  const sig = tool.target_signature ?? tool.tool_name;
  return {
    toolName: tool.tool_name,
    targetSignature: sig,
    sample: tool.sample,
    status: tool.status,
    durationMs: tool.duration_ms ?? 0,
    outputBytes: tool.output_bytes ?? 0,
    timestampMs: sourceRow.row.timestamp_ms,
    timestampIso: sourceRow.row.created_at ?? new Date(sourceRow.row.timestamp_ms || 0).toISOString(),
    sessionId: sourceRow.row.session_id,
    sessionLabel: sourceRow.row.session_label,
    turnId: sourceRow.row.turn_id,
    subagentKey: sourceRow.row.subagent_key,
    threadKey: sourceRow.threadKey,
    callSeq: attributedRow.row.seq ?? sourceRow.row.seq,
    attributedRow,
  };
}

function summarizeAttributedRows(rows: readonly EvaluatedUsageRow[]) {
  let tokens = 0;
  let cost = 0;
  let totalInput = 0;
  let cacheRead = 0;
  let minHit: number | null = null;
  for (const r of rows) {
    tokens += r.row.total_tokens;
    cost += r.adjustedCostUsd;
    totalInput += r.totalInputTokens;
    cacheRead += r.row.cache_read_input_tokens;
    if (r.cacheHitRatio !== null) {
      minHit = minHit === null ? r.cacheHitRatio : Math.min(minHit, r.cacheHitRatio);
    }
  }
  return {
    tokens,
    cost,
    avgHit: totalInput > 0 ? cacheRead / totalInput : null,
    minHit,
  };
}
