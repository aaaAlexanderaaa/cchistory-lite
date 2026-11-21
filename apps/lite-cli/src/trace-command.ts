/**
 * Role: CLI `trace` command option parsing, exact-session/turn lookup, and human-readable
 * call-by-call waterfall rendering (family, turns, loops, anomalies, and step trace).
 * Excludes canonical trace math (canonical via live-runtime) and ANSI primitives (stats-visuals.ts).
 */

import type {
  CallTraceRow,
  SessionTraceReport,
  UsageAnomaly,
  UsageToolSummary,
} from "@cchistory/domain";
import {
  resolveUsageTimezone,
  type LiveHistorySnapshot,
  type UsageFilters,
} from "@cchistory/live-runtime";
import type { JsonOutputMode } from "./json-v2.js";
import { loadCliPricingConfig, type ParsedStatsArgs, type StatsCliIo, type StatsCommandDeps } from "./stats-command.js";
import {
  clipVisible,
  createStatsPalette,
  formatCacheHitText,
  formatCompactTokens as formatCompact,
  formatDurationBrief as formatDuration,
  formatVisualUsd,
  renderAlignedTable as renderTable,
  styleCacheHit,
  type StatsVisualPalette,
} from "./stats-visuals.js";

function formatSignedCompact(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatCompact(Math.abs(value))}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function formatLocalTime(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(11, 19) || iso;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return iso.slice(11, 19);
  }
}

function parseOptionalInt(
  parsed: ParsedStatsArgs,
  name: string,
  min: number,
  UsageError: StatsCommandDeps["UsageError"],
): number | undefined {
  const list = parsed.values.get(name) ?? [];
  if (list.length > 1) throw new UsageError(`--${name} may only be specified once.`);
  const raw = list[0];
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < min) {
    throw new UsageError(`--${name} must be an integer >= ${min}.`);
  }
  return num;
}

export async function runTraceCommand(options: {
  ref: string;
  parsed: ParsedStatsArgs;
  snapshot: LiveHistorySnapshot;
  io: StatsCliIo;
  jsonMode: JsonOutputMode;
  deps: Pick<StatsCommandDeps, "UsageError" | "renderMeta" | "renderDashRow" | "emitOutput" | "jsonSchema">;
}): Promise<void> {
  const { ref, parsed, snapshot, io, jsonMode, deps } = options;
  const { UsageError, renderMeta, renderDashRow, emitOutput, jsonSchema } = deps;

  const { config: pricingConfig } = await loadCliPricingConfig({
    parsed,
    cwd: io.cwd,
    homeDir: io.homeDir,
    envPricingPath: process.env.CCHISTORY_PRICING_CONFIG,
    UsageError,
  });
  const timeZone = resolveUsageTimezone(pricingConfig.timezone);
  const filters: UsageFilters = {
    timezone: timeZone,
    pricing: pricingConfig,
    now_ms: io.now?.() ?? Date.now(),
  };

  const limit = parseOptionalInt(parsed, "limit", 1, UsageError) ?? 100;
  const offset = parseOptionalInt(parsed, "offset", 0, UsageError) ?? 0;
  const onlyAnomalies = parsed.booleans.has("only-anomalies");
  const includeSubagents = parsed.booleans.has("include-subagents");

  const session = snapshot.getSession(ref);
  const turn = session ? undefined : snapshot.getTurn(ref);
  if (!session && !turn) {
    throw new UsageError(`Session or UserTurn not found: ${ref}.`, "reference_not_found");
  }

  const trace = snapshot.getSessionTrace({
    sessionId: session ? session.id : turn!.session_id,
    turnId: turn?.id,
    includeSubagents,
    onlyAnomalies,
    limit,
    offset,
    filters,
  });
  if (!trace) {
    throw new UsageError(`Unable to build trace for ${ref}.`, "reference_not_found");
  }

  const useColor =
    io.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  const rendered = renderTraceReport(trace, {
    timeZone,
    columns: io.columns ?? 120,
    useColor,
    onlyAnomalies,
    renderMeta,
    renderDashRow,
  });

  emitOutput(
    io,
    jsonMode,
    {
      schema: jsonSchema,
      kind: "trace",
      trace,
    },
    rendered,
    snapshot,
  );
}

export function renderTraceReport(
  trace: SessionTraceReport,
  options: {
    timeZone: string;
    columns: number;
    useColor: boolean;
    onlyAnomalies?: boolean;
    renderMeta: (line: string) => string;
    renderDashRow: (line: string) => string;
  },
): string {
  const { timeZone, columns, useColor, onlyAnomalies, renderMeta, renderDashRow } = options;
  const palette = createStatsPalette(useColor);
  const wide = columns >= 112;
  const subagentCount = trace.family.filter((m) => m.role === "subagent").length;
  const selfMember = trace.family.find((m) => m.role === "main");
  const subCost = trace.family
    .filter((m) => m.role === "subagent")
    .reduce((sum, m) => sum + m.adjusted_cost_usd, 0);

  const hitSummary = `${styleCacheHit(formatCacheHitText(trace.cache_hit_ratio), trace.cache_hit_ratio, palette)} (min ${styleCacheHit(formatCacheHitText(trace.min_cache_hit_ratio), trace.min_cache_hit_ratio, palette)})`;
  const costDetail =
    subagentCount > 0 && selfMember
      ? `${formatVisualUsd(selfMember.adjusted_cost_usd + subCost)} (self ${formatVisualUsd(selfMember.adjusted_cost_usd)} + sub ${formatVisualUsd(subCost)})`
      : formatVisualUsd(trace.adjusted_cost_usd);

  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const lines: string[] = [
    renderMeta(`Trace: ${trace.session_id} (${JSON.stringify(trace.title)}) · ${trace.source_platform} · granularity=${trace.usage_granularity}`),
    renderDashRow(
      `- Summary: ${plural(trace.total_calls, "call")} · ${plural(trace.turns.length, "turn")} · ${plural(subagentCount, "subagent")} · ${formatCompact(trace.total_tokens)} tok · ${costDetail} · hit ${hitSummary}`,
    ),
  ];

  if (trace.parent_session_id) {
    lines.push(renderDashRow(`- Parent session: ${trace.parent_session_id}`));
  }

  const distLine = formatCacheDistributionLine(trace.cache_distribution, palette);
  if (distLine) {
    lines.push(renderDashRow(`- Cache dist: ${distLine}`));
  }

  // 1. Family breakdown (when subagents exist)
  if (trace.family.length > 1) {
    lines.push("", `Family (self + ${plural(subagentCount, "subagent")})`);
    const famHeaders = wide
      ? [
          { title: "Role", width: 8 },
          { title: "Session / Agent", width: 26 },
          { title: "Model", width: 16 },
          { title: "Calls", width: 5, right: true },
          { title: "Dur", width: 7, right: true },
          { title: "Tokens", width: 8, right: true },
          { title: "Hit", width: 6, right: true },
          { title: "MinHit", width: 6, right: true },
          { title: "Adj$", width: 8, right: true },
        ]
      : [
          { title: "Role", width: 8 },
          { title: "Agent", width: 20 },
          { title: "Calls", width: 5, right: true },
          { title: "Hit", width: 6, right: true },
          { title: "MinHit", width: 6, right: true },
          { title: "Adj$", width: 8, right: true },
        ];
    const famRows = trace.family.map((m) => {
      const label = m.agent_key ? `${m.agent_key} (${m.subagent_key ?? m.session_id.slice(-8)})` : m.title;
      const hitCell = styleCacheHit(formatCacheHitText(m.cache_hit_ratio), m.cache_hit_ratio, palette);
      const minCell = styleCacheHit(formatCacheHitText(m.min_cache_hit_ratio), m.min_cache_hit_ratio, palette);
      if (wide) {
        return [
          m.role,
          label,
          m.model ?? "—",
          String(m.calls),
          formatDuration(m.duration_ms),
          formatCompact(m.total_tokens),
          hitCell,
          minCell,
          formatVisualUsd(m.adjusted_cost_usd),
        ];
      }
      return [m.role, label, String(m.calls), hitCell, minCell, formatVisualUsd(m.adjusted_cost_usd)];
    });
    lines.push(...renderTable(famHeaders, famRows));
  }

  // 2. Per-turn breakdown
  if (trace.turns.length > 0) {
    lines.push("", `Turns (${trace.turns.length})`);
    const turnHeaders = wide
      ? [
          { title: "Turn", width: 5 },
          { title: "Time", width: 8 },
          { title: "Calls", width: 5, right: true },
          { title: "Tools(Err)", width: 10, right: true },
          { title: "PeakCtx", width: 8, right: true },
          { title: "AvgHit", width: 6, right: true },
          { title: "MinHit", width: 6, right: true },
          { title: "Adj$", width: 8, right: true },
          { title: "Prompt", width: Math.max(18, columns - 76) },
        ]
      : [
          { title: "Turn", width: 5 },
          { title: "Calls", width: 5, right: true },
          { title: "AvgHit", width: 6, right: true },
          { title: "MinHit", width: 6, right: true },
          { title: "Adj$", width: 8, right: true },
          { title: "Prompt", width: Math.max(16, columns - 42) },
        ];
    const turnRows = trace.turns.map((t) => {
      const tag = t.turn_index !== null ? `T${t.turn_index}` : "—";
      const avgCell = styleCacheHit(formatCacheHitText(t.avg_cache_hit_ratio), t.avg_cache_hit_ratio, palette);
      const minCell = styleCacheHit(formatCacheHitText(t.min_cache_hit_ratio), t.min_cache_hit_ratio, palette);
      const toolText = t.tool_error_count > 0 ? `${t.tool_call_count}(${palette.red(String(t.tool_error_count))})` : String(t.tool_call_count);
      if (wide) {
        return [
          tag,
          formatLocalTime(t.created_at, timeZone),
          String(t.calls),
          toolText,
          formatCompact(t.peak_context_tokens),
          avgCell,
          minCell,
          formatVisualUsd(t.adjusted_cost_usd),
          t.prompt_preview,
        ];
      }
      return [tag, String(t.calls), avgCell, minCell, formatVisualUsd(t.adjusted_cost_usd), t.prompt_preview];
    });
    lines.push(...renderTable(turnHeaders, turnRows));
  }

  // 3. Loops & Top Tools
  if (trace.loops.length > 0 || trace.tool_patterns.length > 0) {
    lines.push("", "Loops & Top Tools");
    for (const loop of trace.loops.slice(0, 5)) {
      const hitStr = formatCacheHitText(loop.avg_cache_hit_ratio);
      const minStr = formatCacheHitText(loop.min_cache_hit_ratio);
      lines.push(
        `  - ${palette.yellow("[loop]")} ${loop.tool_name}("${loop.target_signature}") ×${loop.exec_count}${loop.error_count > 0 ? ` (${palette.red(`${loop.error_count}err`)})` : ""} in ${formatDuration(loop.duration_ms)} · ${loop.attributed_call_count} calls · ${formatCompact(loop.attributed_tokens)} tok · ${formatVisualUsd(loop.attributed_cost_usd)} · hit ${hitStr} (min ${minStr})`,
      );
    }
    const nonLoopTools = trace.tool_patterns.filter((p) => !p.is_loop).slice(0, 5);
    for (const tool of nonLoopTools) {
      const outTag = tool.max_output_bytes >= 16 * 1024 ? ` · maxOut ${formatBytes(tool.max_output_bytes)}` : "";
      const errTag = tool.error_count > 0 ? ` · ${palette.red(`${tool.error_count}err`)}` : "";
      lines.push(
        `  - ${tool.tool_name}("${tool.target_signature}") ×${tool.exec_count}${errTag}${outTag} · ${tool.attributed_call_count} calls · ${formatCompact(tool.attributed_tokens)} tok · ${formatVisualUsd(tool.attributed_cost_usd)} · minHit ${formatCacheHitText(tool.min_cache_hit_ratio)}`,
      );
    }
  }

  // 4. Anomalies
  if (trace.anomalies.length > 0) {
    lines.push("", `Anomalies (${trace.anomalies.length})`);
    for (const anomaly of trace.anomalies.slice(0, 10)) {
      lines.push(`  - ${formatAnomalyBrief(anomaly, palette)}`);
    }
    if (trace.anomalies.length > 10) {
      lines.push(`  … and ${trace.anomalies.length - 10} more anomalies`);
    }
  }

  // 5. Call Waterfall
  const headingSuffix = onlyAnomalies
    ? `anomalies only · showing ${trace.shown_calls} of ${trace.total_calls}`
    : `showing ${trace.shown_calls} of ${trace.total_calls}${trace.total_calls > trace.shown_calls ? " · use --offset/--limit or --only-anomalies" : ""}`;
  lines.push("", `Call Waterfall (${headingSuffix})`);
  if (trace.calls.length === 0) {
    lines.push("  (no matching calls)");
  } else {
    const wfHeaders = wide
      ? [
          { title: "#", width: 4, right: true },
          { title: "Time", width: 8 },
          { title: "Δt", width: 7, right: true },
          { title: "Turn", width: 4 },
          { title: "Model", width: 15 },
          { title: "CtxIn", width: 7, right: true },
          { title: "ΔCtx", width: 7, right: true },
          { title: "CR", width: 7, right: true },
          { title: "CW", width: 7, right: true },
          { title: "Out", width: 6, right: true },
          { title: "Hit", width: 6, right: true },
          { title: "Adj$", width: 7, right: true },
          { title: "Cause / Tools", width: Math.max(20, columns - 108) },
        ]
      : [
          { title: "#", width: 4, right: true },
          { title: "Time", width: 8 },
          { title: "Δt", width: 6, right: true },
          { title: "CtxIn", width: 6, right: true },
          { title: "Hit", width: 6, right: true },
          { title: "Adj$", width: 7, right: true },
          { title: "Cause / Tools", width: Math.max(36, columns - 48) },
        ];
    const subagentLabelBySessionId = new Map<string, string>();
    for (const member of trace.family) {
      if (member.role === "subagent" && member.session_id !== trace.session_id) {
        const raw = member.agent_key || member.session_id.split(":").at(-1) || member.session_id;
        subagentLabelBySessionId.set(member.session_id, raw.replace(/^agent-/u, "").slice(0, 8));
      }
    }
    const wfRows = trace.calls.map((call) =>
      formatWaterfallRow(call, wide, timeZone, palette, trace.session_id, subagentLabelBySessionId),
    );
    lines.push(...renderTable(wfHeaders, wfRows));
  }

  return `${lines.join("\n")}\n`;
}

function formatWaterfallRow(
  call: CallTraceRow,
  wide: boolean,
  timeZone: string,
  palette: StatsVisualPalette,
  rootSessionId: string,
  subagentLabelBySessionId: ReadonlyMap<string, string>,
): string[] {
  const hitCell = styleCacheHit(formatCacheHitText(call.cache_hit_ratio), call.cache_hit_ratio, palette);
  const gapStr = call.gap_ms === null ? "—" : `+${formatDuration(call.gap_ms)}`;
  const causeAndTools = formatCallAnnotation(call, palette, rootSessionId, subagentLabelBySessionId);
  if (wide) {
    return [
      String(call.seq),
      formatLocalTime(call.created_at, timeZone),
      gapStr,
      call.turn_label,
      call.model,
      formatCompact(call.context_input_tokens),
      formatSignedCompact(call.context_delta_tokens),
      formatCompact(call.cache_read_tokens),
      formatCompact(call.cache_write_tokens),
      formatCompact(call.output_tokens),
      hitCell,
      formatVisualUsd(call.adjusted_cost_usd),
      causeAndTools,
    ];
  }
  return [
    String(call.seq),
    formatLocalTime(call.created_at, timeZone),
    gapStr,
    formatCompact(call.context_input_tokens),
    hitCell,
    formatVisualUsd(call.adjusted_cost_usd),
    causeAndTools,
  ];
}

function shortSubagentTag(
  call: CallTraceRow,
  rootSessionId: string,
  subagentLabelBySessionId: ReadonlyMap<string, string>,
): string | undefined {
  if (call.subagent_key) {
    return call.subagent_key.replace(/^agent-/u, "").slice(0, 8);
  }
  if (call.session_id !== rootSessionId) {
    return subagentLabelBySessionId.get(call.session_id) ?? (call.session_id.split(":").at(-1) ?? call.session_id).slice(-8);
  }
  return undefined;
}

function formatCallAnnotation(
  call: CallTraceRow,
  palette: StatsVisualPalette,
  rootSessionId: string,
  subagentLabelBySessionId: ReadonlyMap<string, string>,
): string {
  const tags: string[] = [];
  const subTag = shortSubagentTag(call, rootSessionId, subagentLabelBySessionId);
  if (subTag) tags.push(palette.cyan(`[sub:${subTag}]`));
  if (call.cache_status === "cold_start") tags.push(palette.dim("[cold_start]"));
  else if (call.cache_status === "miss") {
    tags.push(palette.red(`[miss:${call.miss_cause ?? "unknown"}]`));
  }
  if (call.anomaly_kinds.includes("context_bloat")) {
    const big = call.preceding_tools.reduce<UsageToolSummary | undefined>(
      (best, t) => (!best || (t.output_bytes ?? 0) > (best.output_bytes ?? 0) ? t : best),
      undefined,
    );
    const fromTool = big?.output_bytes ? ` ← ${big.tool_name} ${formatBytes(big.output_bytes)}` : "";
    tags.push(palette.yellow(`[bloat${fromTool}]`));
  }
  if (call.anomaly_kinds.includes("polling_loop")) tags.push(palette.yellow("[loop]"));
  if (call.anomaly_kinds.includes("tool_error_loop")) tags.push(palette.red("[err_loop]"));
  if (call.high_context_tier) tags.push(palette.magenta("[>200K]"));

  const emitted = call.emitted_tools.slice(0, 2).map((t) => formatShortTool(t, palette));
  const extraTools = call.emitted_tools.length > 2 ? ` +${call.emitted_tools.length - 2}` : "";
  const emittedStr = emitted.length > 0 ? `→ ${emitted.join(", ")}${extraTools}` : "";
  const spawned = call.spawned_subagent_refs?.length
    ? `⇒ ${call.spawned_subagent_refs.join(",")}`
    : "";

  const parts = [...tags, emittedStr, spawned].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : palette.dim(call.stop_reason ?? "—");
}

function formatShortTool(tool: UsageToolSummary, palette: StatsVisualPalette): string {
  const target = tool.target_signature ? `(${tool.target_signature.slice(0, 24)})` : "";
  const err = tool.status === "error" ? palette.red("!") : "";
  const out = tool.output_bytes && tool.output_bytes >= 16 * 1024 ? `[${formatBytes(tool.output_bytes)}]` : "";
  return `${tool.tool_name}${target}${err}${out}`;
}

export function formatCacheDistributionLine(
  dist: SessionTraceReport["cache_distribution"],
  palette: StatsVisualPalette,
): string | undefined {
  if (dist.evaluated_call_count === 0) return undefined;
  const parts = dist.buckets.map((b) => {
    const zeroTag =
      b.bucket === "cold_or_miss" && (b.zero_hit_call_count ?? 0) > 0
        ? ` [${b.zero_hit_call_count} zero-hit]`
        : "";
    const pct = `${Math.round(b.cost_share * 100)}%`;
    const body = `${b.label} ${b.call_count} calls${zeroTag} (${formatVisualUsd(b.adjusted_cost_usd)}, ${pct})`;
    if (b.bucket === "healthy") return palette.green(body);
    if (b.bucket === "degraded") return palette.yellow(body);
    return b.call_count > 0 ? palette.red(body) : palette.dim(body);
  });
  return parts.join(" · ");
}

function formatAnomalyBrief(anomaly: UsageAnomaly, palette: StatsVisualPalette): string {
  const kind =
    anomaly.severity === "high" ? palette.red(anomaly.kind) : palette.yellow(anomaly.kind);
  const loc = anomaly.call_seq !== undefined
    ? `#${anomaly.call_seq}${anomaly.call_seq_end && anomaly.call_seq_end !== anomaly.call_seq ? `..#${anomaly.call_seq_end}` : ""}`
    : anomaly.turn_id ?? "";
  const impact = anomaly.impact_usd && anomaly.impact_usd > 0
    ? formatVisualUsd(anomaly.impact_usd)
    : anomaly.impact_tokens
      ? `${formatCompact(anomaly.impact_tokens)} tok`
      : "";
  return [kind, impact, loc, anomaly.summary].filter(Boolean).join("  ");
}
