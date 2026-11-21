/**
 * Role: Pure domain contracts for per-call usage telemetry, causal tool summaries,
 * cache-hit distributions, family/subagent rollups, tool/command loop clusters,
 * usage anomalies, and single-session call waterfall traces.
 * Excludes aggregation, anomaly detection, and CLI/TUI rendering (owned by canonical and surfaces).
 */

import type { SourcePlatform } from "./index.js";
import type { AssistantStopReason } from "./parsed-session.js";

export type UsageGranularity = "call" | "turn" | "session" | "unavailable";
export type UsageToolStatus = "success" | "error" | "pending";
export type CacheHitBucketKey = "healthy" | "degraded" | "cold_or_miss";
export type CallCacheStatus = "cold_start" | "hit" | "degraded" | "miss" | "no_input";
export type CacheMissCause =
  | "idle_ttl_gap"
  | "model_switch"
  | "compaction"
  | "prefix_invalidation"
  | "cold_start";
export type UsageAnomalyKind =
  | "cache_miss_cliff"
  | "polling_loop"
  | "context_bloat"
  | "subagent_fanout"
  | "high_context_cliff"
  | "tool_error_loop";
export type UsageAnomalySeverity = "high" | "medium" | "low";

export interface UsageToolSummary {
  tool_name: string;
  /** Masked, normalized target/command signature (<= 80 chars) for loop & pattern grouping. */
  target_signature?: string;
  /** Short masked sample of the actual target/command (<= 80 chars). */
  sample?: string;
  status: UsageToolStatus;
  duration_ms?: number;
  input_bytes?: number;
  output_bytes?: number;
  call_id?: string;
  subagent_ref?: string;
}

export interface CacheHitBucketSummary {
  bucket: CacheHitBucketKey;
  label: string;
  call_count: number;
  /** Calls inside this bucket with cache_read === 0 (only populated for cold_or_miss). */
  zero_hit_call_count?: number;
  call_share: number;
  total_tokens: number;
  adjusted_cost_usd: number;
  cost_share: number;
}

export interface CacheHitDistribution {
  evaluated_call_count: number;
  buckets: CacheHitBucketSummary[];
}

export interface UsageRoleStats {
  session_count: number;
  call_count: number;
  total_tokens: number;
  adjusted_cost_usd: number;
  cost_share: number;
  cache_hit_ratio: number | null;
}

export interface UsageRoleSplit {
  main: UsageRoleStats;
  subagents: UsageRoleStats;
}

export interface UsageAnomaly {
  id: string;
  kind: UsageAnomalyKind;
  severity: UsageAnomalySeverity;
  session_id: string;
  session_title?: string;
  parent_session_id?: string;
  subagent_key?: string;
  turn_id?: string | null;
  call_seq?: number;
  call_seq_end?: number;
  timestamp?: string;
  /** Estimated extra or attributed USD impact for ranking. */
  impact_usd?: number;
  /** Token impact (e.g. uncached/rebuilt input, loop tokens, or context delta). */
  impact_tokens?: number;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface ToolPatternRow {
  key: string;
  tool_name: string;
  target_signature: string;
  sample?: string;
  exec_count: number;
  error_count: number;
  pending_count: number;
  first_at?: string;
  last_at?: string;
  /** Wall-clock span between first and last observed execution in ms. */
  span_ms: number;
  /** Sum of known individual tool execution durations in ms. */
  total_duration_ms: number;
  /** Deduplicated model calls associated with executing or consuming this tool pattern. */
  attributed_call_count: number;
  attributed_tokens: number;
  attributed_cost_usd: number;
  avg_cache_hit_ratio: number | null;
  min_cache_hit_ratio: number | null;
  total_output_bytes: number;
  max_output_bytes: number;
  is_loop: boolean;
  loop_cluster_count: number;
  session_ids: string[];
}

export interface ToolLoopCluster {
  id: string;
  session_id: string;
  session_title?: string;
  turn_id: string | null;
  subagent_key?: string;
  tool_name: string;
  target_signature: string;
  sample?: string;
  exec_count: number;
  error_count: number;
  first_at: string;
  last_at: string;
  duration_ms: number;
  first_call_seq?: number;
  last_call_seq?: number;
  attributed_call_count: number;
  attributed_tokens: number;
  attributed_cost_usd: number;
  avg_cache_hit_ratio: number | null;
  min_cache_hit_ratio: number | null;
}

export interface FamilyUsageRow {
  parent_session_id: string;
  title: string;
  project_label: string;
  source_label: string;
  subagent_count: number;
  self_calls: number;
  self_tokens: number;
  self_cost_usd: number;
  self_cache_hit_ratio: number | null;
  subagent_calls: number;
  subagent_tokens: number;
  subagent_cost_usd: number;
  subagent_cache_hit_ratio: number | null;
  total_calls: number;
  total_tokens: number;
  total_cost_usd: number;
  combined_cache_hit_ratio: number | null;
  signals: string[];
  anomaly_count: number;
  last_activity_at?: string;
}

export interface UsageDiagnosticsReport {
  generated_at: string;
  cache_distribution: CacheHitDistribution;
  role_split: UsageRoleSplit;
  families: FamilyUsageRow[];
  tool_patterns: ToolPatternRow[];
  loops: ToolLoopCluster[];
  anomalies: UsageAnomaly[];
}

export interface SessionTraceFamilyMember {
  role: "main" | "subagent";
  session_id: string;
  subagent_key?: string;
  agent_key?: string;
  title: string;
  model?: string;
  calls: number;
  duration_ms: number;
  total_tokens: number;
  adjusted_cost_usd: number;
  cache_hit_ratio: number | null;
  min_cache_hit_ratio: number | null;
  anomaly_count: number;
}

export interface SessionTraceTurnRow {
  turn_id: string | null;
  turn_index: number | null;
  created_at: string;
  prompt_preview: string;
  calls: number;
  tool_call_count: number;
  tool_error_count: number;
  peak_context_tokens: number;
  total_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  adjusted_cost_usd: number;
  avg_cache_hit_ratio: number | null;
  min_cache_hit_ratio: number | null;
  anomaly_count: number;
}

export interface CallTraceRow {
  seq: number;
  event_id: string;
  session_id: string;
  subagent_key?: string;
  turn_id: string | null;
  turn_label: string;
  created_at: string;
  gap_ms: number | null;
  model: string;
  stop_reason?: AssistantStopReason;
  context_input_tokens: number;
  context_delta_tokens: number | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cache_hit_ratio: number | null;
  list_cost_usd: number;
  adjusted_cost_usd: number;
  high_context_tier: boolean;
  cache_status: CallCacheStatus;
  miss_cause?: CacheMissCause;
  compaction_before?: boolean;
  preceding_tools: UsageToolSummary[];
  emitted_tools: UsageToolSummary[];
  spawned_subagent_refs?: string[];
  anomaly_kinds: UsageAnomalyKind[];
}

export interface SessionTraceReport {
  generated_at: string;
  session_id: string;
  parent_session_id?: string;
  title: string;
  source_platform: SourcePlatform;
  source_label: string;
  project_label: string;
  usage_granularity: UsageGranularity;
  total_calls: number;
  shown_calls: number;
  offset: number;
  limit: number;
  total_tokens: number;
  list_cost_usd: number;
  adjusted_cost_usd: number;
  cache_hit_ratio: number | null;
  min_cache_hit_ratio: number | null;
  cache_distribution: CacheHitDistribution;
  family: SessionTraceFamilyMember[];
  turns: SessionTraceTurnRow[];
  tool_patterns: ToolPatternRow[];
  loops: ToolLoopCluster[];
  anomalies: UsageAnomaly[];
  calls: CallTraceRow[];
}
