/**
 * Role: Pure ANSI renderer for the Lite TUI interactive Call Waterfall (`Trace`) view,
 * showing per-call timing, context growth, cache hit, cost, subagent tags, narrow-screen
 * column paging (`←/→`), and a pinned 2-line Selected Call Inspector with full tool causality.
 * Excludes trace computation (canonical via model) and state transitions (stats-state.ts).
 */

import type { CallTraceRow, SessionTraceReport, UsageToolSummary } from "@cchistory/domain";
import {
  activeItem,
  activeSectionTitle,
  bold,
  cursor as cursorColor,
  cyan,
  danger,
  dim,
  green,
  magenta,
  muted,
  warning,
  yellow,
} from "./colors.js";
import { viewportWindow } from "./render.js";
import { formatTuiCacheDist } from "./stats-anomalies-render.js";
import type { LiteStatsResolvedViewData, LiteStatsState } from "./stats-state.js";
import { formatTuiUsd, padRightTui, renderTuiCacheHit } from "./stats-visuals.js";
import { clipLine, compact, formatCompactCount, padLine } from "./text.js";

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h${remMins}m` : `${hrs}h`;
}

function formatSignedCompact(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatCompactCount(Math.abs(value)) || "0"}`;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function formatLocalTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return iso.slice(11, 19);
  }
}

function shortSubagentTag(
  call: CallTraceRow,
  report: SessionTraceReport,
  subLabelBySessionId: ReadonlyMap<string, string>,
): string | undefined {
  if (call.subagent_key) return call.subagent_key.replace(/^agent-/u, "").slice(0, 8);
  if (call.session_id !== report.session_id) {
    return subLabelBySessionId.get(call.session_id) ?? (call.session_id.split(":").at(-1) ?? call.session_id).slice(-8);
  }
  return undefined;
}

function formatToolBrief(tool: UsageToolSummary): string {
  const target = tool.target_signature ? `(${compact(tool.target_signature, 18)})` : "";
  const err = tool.status === "error" ? danger("!") : "";
  const out = tool.output_bytes && tool.output_bytes >= 16 * 1024 ? `[${formatBytes(tool.output_bytes)}]` : "";
  return `${tool.tool_name}${target}${err}${out}`;
}

function formatToolFull(tool: UsageToolSummary): string {
  const target = tool.target_signature ? `("${compact(tool.target_signature, 32)}")` : "";
  const meta: string[] = [];
  if (tool.status === "error") meta.push(danger("ERR"));
  else if (tool.status === "pending") meta.push(yellow("PENDING"));
  if (tool.duration_ms !== undefined && tool.duration_ms >= 1000) meta.push(formatDuration(tool.duration_ms));
  if (tool.output_bytes && tool.output_bytes >= 1024) meta.push(formatBytes(tool.output_bytes));
  const metaStr = meta.length > 0 ? `[${meta.join(" ")}]` : "";
  return `${tool.tool_name}${target}${metaStr}`;
}

function formatCallAnnotation(
  call: CallTraceRow,
  report: SessionTraceReport,
  subLabelBySessionId: ReadonlyMap<string, string>,
): string {
  const tags: string[] = [];
  const subTag = shortSubagentTag(call, report, subLabelBySessionId);
  if (subTag) tags.push(cyan(`[sub:${subTag}]`));
  if (call.cache_status === "cold_start") tags.push(dim("[cold]"));
  else if (call.cache_status === "miss") tags.push(danger(`[miss:${call.miss_cause ?? "?"}]`));
  if (call.anomaly_kinds.includes("context_bloat")) tags.push(yellow("[bloat]"));
  if (call.anomaly_kinds.includes("polling_loop")) tags.push(yellow("[loop]"));
  if (call.anomaly_kinds.includes("tool_error_loop")) tags.push(danger("[err_loop]"));
  if (call.high_context_tier) tags.push(magenta("[>200K]"));

  const emitted = call.emitted_tools.slice(0, 2).map(formatToolBrief);
  const extra = call.emitted_tools.length > 2 ? ` +${call.emitted_tools.length - 2}` : "";
  const emittedStr = emitted.length > 0 ? `→ ${emitted.join(", ")}${extra}` : "";
  const parts = [...tags, emittedStr].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : dim(call.stop_reason ?? "—");
}

function renderSelectedCallInspector(
  call: CallTraceRow,
  report: SessionTraceReport,
  subLabelBySessionId: ReadonlyMap<string, string>,
  timeZone: string,
  width: number,
): string[] {
  const subTag = shortSubagentTag(call, report, subLabelBySessionId);
  const roleTag = subTag ? cyan(`sub:${subTag}`) : green("main");
  const gapStr = call.gap_ms === null ? "first" : `+${formatDuration(call.gap_ms)}`;
  const missTag = call.miss_cause ? ` · ${danger(`cause:${call.miss_cause}`)}` : "";
  const anomTag = call.anomaly_kinds.length > 0 ? ` · ${warning(call.anomaly_kinds.join(","))}` : "";
  const line1 = clipLine(
    `  ${cyan(`#${call.seq}`)} ${formatLocalTime(call.created_at, timeZone)} (${gapStr}) · ${call.turn_label} · ${roleTag} · ${call.model} · Ctx ${formatCompactCount(call.context_input_tokens) || "0"} (${formatSignedCompact(call.context_delta_tokens)}) · CR ${formatCompactCount(call.cache_read_tokens) || "0"} · CW ${formatCompactCount(call.cache_write_tokens) || "0"} · Out ${formatCompactCount(call.output_tokens) || "0"} · Hit ${renderTuiCacheHit(call.cache_hit_ratio)} · ${formatTuiUsd(call.adjusted_cost_usd)}${missTag}${anomTag}`,
    width,
  );

  const prec = call.preceding_tools.map(formatToolFull);
  const emit = call.emitted_tools.map(formatToolFull);
  const toolParts: string[] = [];
  if (prec.length > 0) toolParts.push(`← ${prec.join(", ")}`);
  if (emit.length > 0) toolParts.push(`→ ${emit.join(", ")}`);
  if (call.spawned_subagent_refs?.length) toolParts.push(`⇒ ${call.spawned_subagent_refs.join(",")}`);
  const line2 = clipLine(
    `  ${toolParts.length > 0 ? toolParts.join("  │  ") : dim("(no tool calls attached to this step)")}`,
    width,
  );
  return [dim("─".repeat(Math.max(10, width))), line1, line2];
}

export function renderTraceView(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
  budget: number,
): string[] {
  const report = data.traceReport;
  if (!report) {
    return [
      clipLine(`${activeSectionTitle("▸ Trace")}  ${dim("Esc back")}`, width),
      `  ${muted("(requested session could not be traced in this snapshot)")}`,
    ];
  }

  const timeZone = data.breakdown.timezone;
  const subCount = report.family.filter((m) => m.role === "subagent").length;
  const selfMember = report.family.find((m) => m.role === "main");
  const subCost = report.family
    .filter((m) => m.role === "subagent")
    .reduce((sum, m) => sum + m.adjusted_cost_usd, 0);
  const anomFlag = stats.traceOnlyAnomalies ? bold(warning("[f:AnomOnly]")) : dim("f:All");
  const subFlag = stats.traceIncludeSubagents ? cyan(`[u:+Sub(${subCount})]`) : dim(`u:NoSub(${subCount})`);
  const wide = width >= 116;
  const pageFlag = wide
    ? ""
    : stats.traceColPage === 0
      ? ` ${cyan("←/→[Core]")}${dim("|Tok")}`
      : ` ${dim("←/→Core|")}${cyan("[Tok]")}`;

  const lines: string[] = [
    clipLine(
      `${activeSectionTitle("▸ Trace")} ${bold(compact(report.title, wide ? 36 : 22))} ${dim(`[${report.source_platform} · ${report.usage_granularity}]`)}  ${anomFlag} ${subFlag}${pageFlag} ${dim("O open · Esc back")}`,
      width,
    ),
  ];

  const costText =
    subCount > 0 && selfMember
      ? `${formatTuiUsd(selfMember.adjusted_cost_usd + subCost)} (self ${formatTuiUsd(selfMember.adjusted_cost_usd)} + sub ${formatTuiUsd(subCost)})`
      : formatTuiUsd(report.adjusted_cost_usd);
  const distStr = formatTuiCacheDist(report.cache_distribution);
  const turnsLabel = `${report.turns.length} turn${report.turns.length === 1 ? "" : "s"}`;
  const summaryLine = `  ${report.shown_calls}/${report.total_calls} calls · ${turnsLabel} · ${formatCompactCount(report.total_tokens) || "0"} tok · ${costText} · Hit ${renderTuiCacheHit(report.cache_hit_ratio)} (min ${renderTuiCacheHit(report.min_cache_hit_ratio, true)})${distStr && wide ? `  │  ${distStr}` : ""}`;
  lines.push(clipLine(summaryLine, width));

  const subLabelBySessionId = new Map<string, string>();
  for (const member of report.family) {
    if (member.role === "subagent" && member.session_id !== report.session_id) {
      const raw = member.agent_key || member.session_id.split(":").at(-1) || member.session_id;
      subLabelBySessionId.set(member.session_id, raw.replace(/^agent-/u, "").slice(0, 8));
    }
  }

  const hdr = wide
    ? `  ${"#".padStart(3)} ${"Time".padEnd(8)} ${"Δt".padStart(6)} ${"Turn".padEnd(4)} ${"Model".padEnd(14)} ${"CtxIn".padStart(6)} ${"ΔCtx".padStart(6)} ${"CR".padStart(6)} ${"CW".padStart(6)} ${"Out".padStart(5)} ${"Hit".padStart(5)} ${"Adj$".padStart(7)} Cause / Tools`
    : stats.traceColPage === 0
      ? `  ${"#".padStart(3)} ${"Time".padEnd(8)} ${"Δt".padStart(6)} ${"CtxIn".padStart(6)} ${"Hit".padStart(5)} ${"Adj$".padStart(7)} Cause / Tools`
      : `  ${"#".padStart(3)} ${"Time".padEnd(8)} ${"Turn".padEnd(4)} ${"Model".padEnd(14)} ${"CtxIn".padStart(6)} ${"ΔCtx".padStart(6)} ${"CR".padStart(6)} ${"CW".padStart(6)} ${"Out".padStart(5)} ${"Hit".padStart(5)}`;
  lines.push(dim(clipLine(hdr, width)));

  const calls = report.calls;
  if (calls.length === 0) {
    lines.push(
      `  ${muted(stats.traceOnlyAnomalies ? "(no anomalous calls — press f to show all calls)" : "(no call usage rows recorded for this session)")}`,
    );
    return lines.slice(0, budget);
  }

  const showInspector = budget >= 7;
  const bodyH = Math.max(1, budget - lines.length - (showInspector ? 3 : 0));
  const clamped = Math.min(stats.cursors.trace, calls.length - 1);
  const win = viewportWindow(calls.length, clamped, bodyH);

  for (let idx = win.start; idx < win.end; idx += 1) {
    const c = calls[idx]!;
    const isCursor = idx === clamped;
    const prefix = isCursor ? cursorColor("❯") : dim("·");
    const seqRaw = String(c.seq).padStart(3);
    const seqCell = isCursor ? activeItem(seqRaw) : seqRaw;
    const timeStr = formatLocalTime(c.created_at, timeZone);
    const gapStr = c.gap_ms === null ? "—" : `+${formatDuration(c.gap_ms)}`;
    const hitCell = padRightTui(renderTuiCacheHit(c.cache_hit_ratio, true), 5);
    const costCell = padRightTui(formatTuiUsd(c.adjusted_cost_usd), 7);
    const note = formatCallAnnotation(c, report, subLabelBySessionId);

    if (wide) {
      lines.push(
        clipLine(
          `${prefix} ${seqCell} ${padLine(timeStr, 8)} ${padRightTui(gapStr, 6)} ${padLine(c.turn_label, 4)} ${padLine(compact(c.model, 14), 14)} ${padRightTui(formatCompactCount(c.context_input_tokens) || "0", 6)} ${padRightTui(formatSignedCompact(c.context_delta_tokens), 6)} ${padRightTui(formatCompactCount(c.cache_read_tokens) || "0", 6)} ${padRightTui(formatCompactCount(c.cache_write_tokens) || "0", 6)} ${padRightTui(formatCompactCount(c.output_tokens) || "0", 5)} ${hitCell} ${costCell} ${note}`,
          width,
        ),
      );
    } else if (stats.traceColPage === 0) {
      lines.push(
        clipLine(
          `${prefix} ${seqCell} ${padLine(timeStr, 8)} ${padRightTui(gapStr, 6)} ${padRightTui(formatCompactCount(c.context_input_tokens) || "0", 6)} ${hitCell} ${costCell} ${note}`,
          width,
        ),
      );
    } else {
      lines.push(
        clipLine(
          `${prefix} ${seqCell} ${padLine(timeStr, 8)} ${padLine(c.turn_label, 4)} ${padLine(compact(c.model, 14), 14)} ${padRightTui(formatCompactCount(c.context_input_tokens) || "0", 6)} ${padRightTui(formatSignedCompact(c.context_delta_tokens), 6)} ${padRightTui(formatCompactCount(c.cache_read_tokens) || "0", 6)} ${padRightTui(formatCompactCount(c.cache_write_tokens) || "0", 6)} ${padRightTui(formatCompactCount(c.output_tokens) || "0", 5)} ${hitCell}`,
          width,
        ),
      );
    }
  }

  if (showInspector) {
    const sel = calls[clamped];
    if (sel) {
      lines.push(...renderSelectedCallInspector(sel, report, subLabelBySessionId, timeZone, width));
    }
  }
  return lines.slice(0, budget);
}
