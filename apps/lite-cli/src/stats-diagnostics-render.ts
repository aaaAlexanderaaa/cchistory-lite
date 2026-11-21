/**
 * Role: Human-readable CLI table renderers for cache-hit distribution, Main vs Subagent
 * role split, ranked anomalies, family rollups, tool/command patterns, and per-turn diagnostics.
 * Excludes usage math (canonical) and core stats overview layout (stats-render.ts).
 */

import type {
  FamilyUsageRow,
  SessionTraceTurnRow,
  ToolPatternRow,
  UsageAnomaly,
  UsageDiagnosticsReport,
} from "@cchistory/domain";
import {
  formatCacheHitText,
  formatCompactTokens as formatCompact,
  formatDurationBrief as formatDuration,
  formatVisualUsd,
  renderAlignedTable as renderTable,
  styleCacheHit,
  type StatsVisualPalette,
} from "./stats-visuals.js";
import { formatCacheDistributionLine } from "./trace-command.js";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export function renderDiagnosticsHeaderLines(
  diagnostics: UsageDiagnosticsReport | undefined,
  palette: StatsVisualPalette,
  renderDashRow: (line: string) => string,
): string[] {
  if (!diagnostics) return [];
  const lines: string[] = [];
  const distLine = formatCacheDistributionLine(diagnostics.cache_distribution, palette);
  if (distLine) {
    lines.push(renderDashRow(`- Cache dist: ${distLine}`));
  }
  const { main, subagents } = diagnostics.role_split;
  if (main.call_count > 0 || subagents.call_count > 0) {
    const mainHit = styleCacheHit(formatCacheHitText(main.cache_hit_ratio), main.cache_hit_ratio, palette);
    const subHit = styleCacheHit(formatCacheHitText(subagents.cache_hit_ratio), subagents.cache_hit_ratio, palette);
    const mainLabel = `${main.session_count} session${main.session_count === 1 ? "" : "s"}`;
    const subLabel = `${subagents.session_count} session${subagents.session_count === 1 ? "" : "s"}`;
    const mainPart = `Main ${mainLabel} ${formatVisualUsd(main.adjusted_cost_usd)} (hit ${mainHit})`;
    const subPart =
      subagents.call_count > 0
        ? `Subagents ${subLabel} ${formatVisualUsd(subagents.adjusted_cost_usd)} (hit ${subHit})`
        : palette.dim("Subagents 0");
    lines.push(renderDashRow(`- Role split: ${mainPart} · ${subPart}`));
  }
  return lines;
}

export function renderAnomaliesSection(
  anomalies: readonly UsageAnomaly[],
  options: { wide: boolean; columns: number; palette: StatsVisualPalette; limit?: number; title?: string },
): string[] {
  const { wide, columns, palette, limit } = options;
  const shown = limit !== undefined && anomalies.length > limit ? anomalies.slice(0, limit) : anomalies;
  const title =
    options.title ??
    (limit !== undefined && anomalies.length > limit
      ? `Anomalies (top ${shown.length} of ${anomalies.length}; run --anomalies for all)`
      : `Anomalies (${anomalies.length})`);
  const lines = [title];
  if (shown.length === 0) {
    lines.push("  (no anomalies detected)");
    return lines;
  }
  const locWidth = wide ? 28 : 24;
  const evWidth = Math.max(36, columns - (wide ? 60 : 52));
  const headers = [
    { title: "Kind", width: 16 },
    { title: "Impact", width: 8, right: true },
    { title: "Session / Location", width: locWidth },
    { title: "Evidence", width: evWidth },
  ];
  const compactSessionRef = (sessionId: string): string => {
    const parts = sessionId.split(":");
    if (parts.length >= 3 && parts[0] === "sess") {
      const platform = parts[1]!;
      const tail = parts.slice(2).join(":");
      return `${platform}:${tail.slice(0, 8)}`;
    }
    return sessionId.slice(0, 18);
  };
  const rows = shown.map((a) => {
    const kindCell = a.severity === "high" ? palette.red(a.kind) : palette.yellow(a.kind);
    const impactCell =
      a.impact_usd && a.impact_usd > 0
        ? formatVisualUsd(a.impact_usd)
        : a.impact_tokens
          ? `${formatCompact(a.impact_tokens)} tok`
          : "—";
    const stepSuffix =
      a.call_seq !== undefined
        ? ` #${a.call_seq}${a.call_seq_end && a.call_seq_end !== a.call_seq ? `..#${a.call_seq_end}` : ""}`
        : "";
    const loc = `${compactSessionRef(a.session_id)}${stepSuffix}`;
    return [kindCell, impactCell, loc, a.summary];
  });
  lines.push(...renderTable(headers, rows));
  if (limit !== undefined && anomalies.length > limit) {
    lines.push(`  ... ${anomalies.length - limit} more anomalies (use --anomalies or trace <session_id>)`);
  }
  return lines;
}

export function renderFamilyUsageSection(
  families: readonly FamilyUsageRow[],
  wide: boolean,
  palette: StatsVisualPalette,
): string[] {
  const lines = [`By family (${families.length})`];
  if (families.length === 0) {
    lines.push("  (no matching session families)");
    return lines;
  }
  const headers = wide
    ? [
        { title: "Family", width: 24 },
        { title: "Sub", width: 3, right: true },
        { title: "Self$", width: 8, right: true },
        { title: "Sub$", width: 8, right: true },
        { title: "Total$", width: 8, right: true },
        { title: "SelfHit", width: 7, right: true },
        { title: "SubHit", width: 7, right: true },
        { title: "Signals", width: 24 },
      ]
    : [
        { title: "Family", width: 20 },
        { title: "Sub", width: 3, right: true },
        { title: "Total$", width: 8, right: true },
        { title: "Hit", width: 7, right: true },
        { title: "Signals", width: 20 },
      ];
  const rows = families.map((f) => {
    const selfHit = styleCacheHit(formatCacheHitText(f.self_cache_hit_ratio), f.self_cache_hit_ratio, palette);
    const subHit = styleCacheHit(formatCacheHitText(f.subagent_cache_hit_ratio), f.subagent_cache_hit_ratio, palette);
    const combHit = styleCacheHit(
      formatCacheHitText(f.combined_cache_hit_ratio),
      f.combined_cache_hit_ratio,
      palette,
    );
    const sigText = f.signals.length > 0 ? f.signals.join(" ") : palette.dim("—");
    if (wide) {
      return [
        f.title,
        String(f.subagent_count),
        formatVisualUsd(f.self_cost_usd),
        formatVisualUsd(f.subagent_cost_usd),
        formatVisualUsd(f.total_cost_usd),
        selfHit,
        subHit,
        sigText,
      ];
    }
    return [f.title, String(f.subagent_count), formatVisualUsd(f.total_cost_usd), combHit, sigText];
  });
  lines.push(...renderTable(headers, rows));
  return lines;
}

export function renderToolPatternSection(
  patterns: readonly ToolPatternRow[],
  wide: boolean,
  palette: StatsVisualPalette,
): string[] {
  const lines = [`By tool (${patterns.length})`];
  if (patterns.length === 0) {
    lines.push("  (no tool call usage observed in scope)");
    return lines;
  }
  const headers = wide
    ? [
        { title: "Tool / Signature", width: 32 },
        { title: "Cnt", width: 4, right: true },
        { title: "Err", width: 4, right: true },
        { title: "Span", width: 7, right: true },
        { title: "Calls", width: 5, right: true },
        { title: "Tokens", width: 8, right: true },
        { title: "AvgHit", width: 6, right: true },
        { title: "MinHit", width: 6, right: true },
        { title: "MaxOut", width: 7, right: true },
        { title: "Adj$", width: 8, right: true },
        { title: "Flags", width: 10 },
      ]
    : [
        { title: "Tool / Signature", width: 24 },
        { title: "Cnt", width: 4, right: true },
        { title: "Err", width: 4, right: true },
        { title: "MinHit", width: 6, right: true },
        { title: "Adj$", width: 8, right: true },
        { title: "Flags", width: 8 },
      ];
  const rows = patterns.slice(0, 50).map((p) => {
    const label = `${p.tool_name}: ${p.target_signature}`;
    const errCell = p.error_count > 0 ? palette.red(String(p.error_count)) : palette.dim("0");
    const avgHit = styleCacheHit(formatCacheHitText(p.avg_cache_hit_ratio), p.avg_cache_hit_ratio, palette);
    const minHit = styleCacheHit(formatCacheHitText(p.min_cache_hit_ratio), p.min_cache_hit_ratio, palette);
    const flags: string[] = [];
    if (p.is_loop) flags.push(palette.yellow("loop"));
    if (p.max_output_bytes >= 32 * 1024) flags.push(palette.magenta("bloat"));
    if (p.min_cache_hit_ratio !== null && p.min_cache_hit_ratio < 0.2) flags.push(palette.red("miss"));
    const flagStr = flags.length > 0 ? flags.join(",") : palette.dim("—");
    if (wide) {
      return [
        label,
        String(p.exec_count),
        errCell,
        formatDuration(p.span_ms),
        String(p.attributed_call_count),
        formatCompact(p.attributed_tokens),
        avgHit,
        minHit,
        formatBytes(p.max_output_bytes),
        formatVisualUsd(p.attributed_cost_usd),
        flagStr,
      ];
    }
    return [label, String(p.exec_count), errCell, minHit, formatVisualUsd(p.attributed_cost_usd), flagStr];
  });
  lines.push(...renderTable(headers, rows));
  if (patterns.length > 50) {
    lines.push(`  ... ${patterns.length - 50} more tool patterns`);
  }
  return lines;
}

export function renderTurnUsageSection(
  turns: ReadonlyArray<SessionTraceTurnRow & { session_id: string }>,
  wide: boolean,
  columns: number,
  palette: StatsVisualPalette,
): string[] {
  const lines = [`By turn (${turns.length})`];
  if (turns.length === 0) {
    lines.push("  (no matching turns)");
    return lines;
  }
  const headers = wide
    ? [
        { title: "Turn", width: 5 },
        { title: "Calls", width: 5, right: true },
        { title: "Tools", width: 7, right: true },
        { title: "PeakCtx", width: 8, right: true },
        { title: "Tokens", width: 8, right: true },
        { title: "AvgHit", width: 6, right: true },
        { title: "MinHit", width: 6, right: true },
        { title: "Adj$", width: 8, right: true },
        { title: "Prompt", width: Math.max(18, columns - 70) },
      ]
    : [
        { title: "Turn", width: 5 },
        { title: "Calls", width: 5, right: true },
        { title: "MinHit", width: 6, right: true },
        { title: "Adj$", width: 8, right: true },
        { title: "Prompt", width: Math.max(16, columns - 34) },
      ];
  const rows = turns.slice(0, 50).map((t) => {
    const tag = t.turn_index !== null ? `T${t.turn_index}` : "—";
    const avgHit = styleCacheHit(formatCacheHitText(t.avg_cache_hit_ratio), t.avg_cache_hit_ratio, palette);
    const minHit = styleCacheHit(formatCacheHitText(t.min_cache_hit_ratio), t.min_cache_hit_ratio, palette);
    const toolsText =
      t.tool_error_count > 0 ? `${t.tool_call_count}(${palette.red(`${t.tool_error_count}e`)})` : String(t.tool_call_count);
    if (wide) {
      return [
        tag,
        String(t.calls),
        toolsText,
        formatCompact(t.peak_context_tokens),
        formatCompact(t.total_tokens),
        avgHit,
        minHit,
        formatVisualUsd(t.adjusted_cost_usd),
        t.prompt_preview,
      ];
    }
    return [tag, String(t.calls), minHit, formatVisualUsd(t.adjusted_cost_usd), t.prompt_preview];
  });
  lines.push(...renderTable(headers, rows));
  return lines;
}
