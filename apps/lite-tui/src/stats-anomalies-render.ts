/**
 * Role: Pure ANSI renderer for the Lite TUI Statistics Diagnostics view (`a:Anomalies`),
 * displaying cache-hit distribution, Main vs Subagent role split, switchable sub-tabs (`g`:
 * Anomalies / Families / Tools & Loops), and a pinned 2-line selected-row inspector.
 * Excludes usage math (canonical) and stats state transitions (stats-state.ts).
 */

import type {
  CacheHitDistribution,
  FamilyUsageRow,
  ToolPatternRow,
  UsageAnomaly,
  UsageRoleSplit,
} from "@cchistory/domain";
import {
  activeItem,
  activeSectionTitle,
  bold,
  cursor as cursorColor,
  cyan,
  danger,
  dim,
  green,
  muted,
  warning,
  yellow,
} from "./colors.js";
import { viewportWindow } from "./render.js";
import type { LiteStatsResolvedViewData, LiteStatsState } from "./stats-state.js";
import { formatTuiUsd, padRightTui, renderTuiCacheHit } from "./stats-visuals.js";
import { clipLine, compact, formatCompactCount, padLine } from "./text.js";

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function compactSessionRef(sessionId: string): string {
  const parts = sessionId.split(":");
  if (parts.length >= 3 && parts[0] === "sess") {
    return `${parts[1]}:${parts.slice(2).join(":").slice(0, 8)}`;
  }
  return sessionId.slice(0, 16);
}

export function formatTuiCacheDist(dist: CacheHitDistribution | undefined): string {
  if (!dist || dist.evaluated_call_count === 0) return "";
  return dist.buckets
    .map((b) => {
      const zeroTag =
        b.bucket === "cold_or_miss" && (b.zero_hit_call_count ?? 0) > 0
          ? `[${b.zero_hit_call_count}×0%]`
          : "";
      const text = `${b.label} ${b.call_count}c${zeroTag}(${Math.round(b.cost_share * 100)}%)`;
      if (b.bucket === "healthy") return green(text);
      if (b.bucket === "degraded") return yellow(text);
      return b.call_count > 0 ? danger(text) : dim(text);
    })
    .join(" · ");
}

function formatTuiRoleSplit(split: UsageRoleSplit | undefined): string {
  if (!split) return "";
  const { main, subagents } = split;
  if (main.call_count === 0 && subagents.call_count === 0) return "";
  const mainStr = `Main ${main.session_count}s ${formatTuiUsd(main.adjusted_cost_usd)}(${renderTuiCacheHit(main.cache_hit_ratio, true)})`;
  const subStr =
    subagents.call_count > 0
      ? `Sub ${subagents.session_count}s ${formatTuiUsd(subagents.adjusted_cost_usd)}(${renderTuiCacheHit(subagents.cache_hit_ratio, true)})`
      : dim("Sub 0");
  return `${mainStr} · ${subStr}`;
}

export function renderAnomaliesView(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
  budget: number,
): string[] {
  const diag = data.breakdown.diagnostics;
  const tab = stats.anomaliesTab;
  const aTab = tab === "anomalies" ? bold(cyan(`[Anomalies ${data.anomalies.length}]`)) : dim(`Anomalies ${data.anomalies.length}`);
  const fTab = tab === "families" ? bold(cyan(`[Families ${data.families.length}]`)) : dim(`Families ${data.families.length}`);
  const tTab = tab === "tools" ? bold(cyan(`[Tools ${data.toolPatterns.length}]`)) : dim(`Tools ${data.toolPatterns.length}`);

  const lines: string[] = [
    clipLine(
      `${activeSectionTitle("▸ Diagnostics")}  ${aTab} ${fTab} ${tTab}  ${dim("g tab · Enter trace · O open · Esc back")}`,
      width,
    ),
  ];

  const distStr = formatTuiCacheDist(diag?.cache_distribution);
  const roleStr = formatTuiRoleSplit(diag?.role_split);
  const summaryParts = [distStr ? `Cache: ${distStr}` : "", roleStr].filter(Boolean);
  if (summaryParts.length > 0 && budget >= 7) {
    lines.push(clipLine(`  ${summaryParts.join("  │  ")}`, width));
  }

  const remainingBudget = Math.max(2, budget - lines.length);
  if (tab === "families") {
    lines.push(...renderFamiliesTable(data.families, stats.cursors.families, width, remainingBudget));
  } else if (tab === "tools") {
    lines.push(...renderToolsTable(data.toolPatterns, stats.cursors.tools, width, remainingBudget));
  } else {
    lines.push(...renderAnomaliesTable(data.anomalies, stats.cursors.anomalies, width, remainingBudget));
  }

  return lines.slice(0, budget);
}

function renderAnomaliesTable(
  rows: readonly UsageAnomaly[],
  cursorIdx: number,
  width: number,
  budget: number,
): string[] {
  const wide = width >= 108;
  const kindW = 16;
  const impW = 8;
  const locW = wide ? 24 : 18;
  const evW = Math.max(16, width - 2 - kindW - impW - locW - 3);
  const lines: string[] = [
    dim(
      clipLine(
        `  ${padLine("Kind", kindW)} ${padRightTui("Impact", impW)} ${padLine("Location", locW)} ${padLine("Evidence", evW)}`,
        width,
      ),
    ),
  ];
  if (rows.length === 0) {
    lines.push(`  ${muted("(no anomalies detected in active window)")}`);
    return lines;
  }

  const showInspector = budget >= 6;
  const bodyH = Math.max(1, budget - lines.length - (showInspector ? 3 : 0));
  const clamped = Math.min(cursorIdx, rows.length - 1);
  const win = viewportWindow(rows.length, clamped, bodyH);

  for (let idx = win.start; idx < win.end; idx += 1) {
    const a = rows[idx]!;
    const isCursor = idx === clamped;
    const prefix = isCursor ? cursorColor("❯") : dim("·");
    const kindRaw = padLine(a.kind, kindW);
    const kindCell = isCursor ? activeItem(kindRaw) : a.severity === "high" ? danger(kindRaw) : warning(kindRaw);
    const impText =
      a.impact_usd && a.impact_usd > 0
        ? formatTuiUsd(a.impact_usd)
        : a.impact_tokens
          ? `${formatCompactCount(a.impact_tokens)}t`
          : "—";
    const step =
      a.call_seq !== undefined
        ? ` #${a.call_seq}${a.call_seq_end && a.call_seq_end !== a.call_seq ? `..#${a.call_seq_end}` : ""}`
        : "";
    const loc = `${compactSessionRef(a.session_id)}${step}`;
    lines.push(
      clipLine(
        `${prefix} ${kindCell} ${padRightTui(impText, impW)} ${padLine(compact(loc, locW), locW)} ${padLine(compact(a.summary, evW), evW)}`,
        width,
      ),
    );
  }

  if (showInspector) {
    const sel = rows[clamped];
    if (sel) {
      lines.push(dim("─".repeat(Math.max(10, width))));
      const subTag = sel.subagent_key ? ` · sub:${sel.subagent_key}` : "";
      lines.push(
        clipLine(
          `  ${cyan("Selected:")} ${bold(sel.kind)} [${sel.severity}] · ${sel.session_id}${subTag} · ${compact(sel.session_title ?? "", 40)}`,
          width,
        ),
      );
      lines.push(
        clipLine(
          `  ${sel.summary}  ${dim("(Enter: call waterfall · O: open session)")}`,
          width,
        ),
      );
    }
  }
  return lines;
}

function renderFamiliesTable(
  rows: readonly FamilyUsageRow[],
  cursorIdx: number,
  width: number,
  budget: number,
): string[] {
  const wide = width >= 106;
  const nameW = wide ? 24 : 20;
  const hdr = wide
    ? `  ${padLine("Family", nameW)} ${"Sub".padStart(3)} ${"Self$".padStart(8)} ${"Sub$".padStart(8)} ${"Total$".padStart(8)} ${"SelfHit".padStart(7)} ${"SubHit".padStart(7)} Signals`
    : `  ${padLine("Family", nameW)} ${"Sub".padStart(3)} ${"Total$".padStart(8)} ${"Hit".padStart(6)} Signals`;
  const lines: string[] = [dim(clipLine(hdr, width))];
  if (rows.length === 0) {
    lines.push(`  ${muted("(no session families match active filters)")}`);
    return lines;
  }

  const showInspector = budget >= 6;
  const bodyH = Math.max(1, budget - lines.length - (showInspector ? 3 : 0));
  const clamped = Math.min(cursorIdx, rows.length - 1);
  const win = viewportWindow(rows.length, clamped, bodyH);

  for (let idx = win.start; idx < win.end; idx += 1) {
    const f = rows[idx]!;
    const isCursor = idx === clamped;
    const prefix = isCursor ? cursorColor("❯") : dim("·");
    const titleCell = padLine(compact(f.title, nameW), nameW);
    const styledTitle = isCursor ? activeItem(titleCell) : titleCell;
    const sigStr = f.signals.length > 0 ? warning(f.signals.join(" ")) : dim("—");
    if (wide) {
      lines.push(
        clipLine(
          `${prefix} ${styledTitle} ${String(f.subagent_count).padStart(3)} ${padRightTui(formatTuiUsd(f.self_cost_usd), 8)} ${padRightTui(formatTuiUsd(f.subagent_cost_usd), 8)} ${padRightTui(formatTuiUsd(f.total_cost_usd), 8)} ${padRightTui(renderTuiCacheHit(f.self_cache_hit_ratio, true), 7)} ${padRightTui(renderTuiCacheHit(f.subagent_cache_hit_ratio, true), 7)} ${sigStr}`,
          width,
        ),
      );
    } else {
      lines.push(
        clipLine(
          `${prefix} ${styledTitle} ${String(f.subagent_count).padStart(3)} ${padRightTui(formatTuiUsd(f.total_cost_usd), 8)} ${padRightTui(renderTuiCacheHit(f.combined_cache_hit_ratio, true), 6)} ${sigStr}`,
          width,
        ),
      );
    }
  }

  if (showInspector) {
    const sel = rows[clamped];
    if (sel) {
      lines.push(dim("─".repeat(Math.max(10, width))));
      lines.push(
        clipLine(
          `  ${cyan("Family:")} ${sel.parent_session_id} · ${sel.project_label} · ${sel.source_label} · ${sel.self_calls} main + ${sel.subagent_calls} sub calls`,
          width,
        ),
      );
      lines.push(
        clipLine(
          `  Self ${formatTuiUsd(sel.self_cost_usd)} (${renderTuiCacheHit(sel.self_cache_hit_ratio)}) · Subagents(${sel.subagent_count}) ${formatTuiUsd(sel.subagent_cost_usd)} (${renderTuiCacheHit(sel.subagent_cache_hit_ratio)}) · ${dim("Enter: Trace · O: Open")}`,
          width,
        ),
      );
    }
  }
  return lines;
}

function renderToolsTable(
  rows: readonly ToolPatternRow[],
  cursorIdx: number,
  width: number,
  budget: number,
): string[] {
  const wide = width >= 106;
  const sigW = wide ? 34 : 24;
  const hdr = wide
    ? `  ${padLine("Tool / Signature", sigW)} ${"Cnt".padStart(4)} ${"Err".padStart(3)} ${"Span".padStart(6)} ${"MaxOut".padStart(6)} ${"MinHit".padStart(6)} ${"Adj$".padStart(8)} Flags`
    : `  ${padLine("Tool / Signature", sigW)} ${"Cnt".padStart(4)} ${"Err".padStart(3)} ${"MinHit".padStart(6)} ${"Adj$".padStart(8)} Flags`;
  const lines: string[] = [dim(clipLine(hdr, width))];
  if (rows.length === 0) {
    lines.push(`  ${muted("(no tool usage patterns recorded in active window)")}`);
    return lines;
  }

  const showInspector = budget >= 6;
  const bodyH = Math.max(1, budget - lines.length - (showInspector ? 3 : 0));
  const clamped = Math.min(cursorIdx, rows.length - 1);
  const win = viewportWindow(rows.length, clamped, bodyH);

  for (let idx = win.start; idx < win.end; idx += 1) {
    const t = rows[idx]!;
    const isCursor = idx === clamped;
    const prefix = isCursor ? cursorColor("❯") : dim("·");
    const flags: string[] = [];
    if (t.is_loop) flags.push(warning("loop"));
    if (t.error_count > 0) flags.push(danger("err"));
    if (t.min_cache_hit_ratio !== null && t.min_cache_hit_ratio < 0.2) flags.push(danger("miss"));
    if (t.max_output_bytes >= 32 * 1024) flags.push(yellow("bloat"));
    const labelRaw = padLine(compact(`${t.tool_name}: ${t.target_signature}`, sigW), sigW);
    const labelCell = isCursor ? activeItem(labelRaw) : labelRaw;
    const errCell = t.error_count > 0 ? danger(String(t.error_count).padStart(3)) : dim("  0");
    if (wide) {
      lines.push(
        clipLine(
          `${prefix} ${labelCell} ${String(t.exec_count).padStart(4)} ${errCell} ${padRightTui(formatDuration(t.span_ms), 6)} ${padRightTui(formatBytes(t.max_output_bytes), 6)} ${padRightTui(renderTuiCacheHit(t.min_cache_hit_ratio, true), 6)} ${padRightTui(formatTuiUsd(t.attributed_cost_usd), 8)} ${flags.length ? flags.join(",") : dim("—")}`,
          width,
        ),
      );
    } else {
      lines.push(
        clipLine(
          `${prefix} ${labelCell} ${String(t.exec_count).padStart(4)} ${errCell} ${padRightTui(renderTuiCacheHit(t.min_cache_hit_ratio, true), 6)} ${padRightTui(formatTuiUsd(t.attributed_cost_usd), 8)} ${flags.length ? flags.join(",") : dim("—")}`,
          width,
        ),
      );
    }
  }

  if (showInspector) {
    const sel = rows[clamped];
    if (sel) {
      lines.push(dim("─".repeat(Math.max(10, width))));
      lines.push(
        clipLine(
          `  ${cyan("Pattern:")} ${sel.tool_name}("${sel.target_signature}") · ×${sel.exec_count} across ${sel.attributed_call_count} calls (${sel.session_ids.length} sessions)`,
          width,
        ),
      );
      lines.push(
        clipLine(
          `  Span ${formatDuration(sel.span_ms)} · TotalOut ${formatBytes(sel.total_output_bytes)} · MaxOut ${formatBytes(sel.max_output_bytes)} · ${formatCompactCount(sel.attributed_tokens)} tok · ${formatTuiUsd(sel.attributed_cost_usd)} · ${dim("Enter: Trace session")}`,
          width,
        ),
      );
    }
  }
  return lines;
}
