/**
 * Role: Pure ANSI visualization components (proportion bars, cost-mix bar, quota pace gauge,
 * sparkline, cache-hit badges) and the Top Sessions drill-down table for the Lite TUI stats overlay.
 * Excludes stats state reducers (stats-state.ts) and main 2x2/matrix/calibration layout (stats-render.ts).
 */

import type {
  QuotaPaceProjection,
  UsageCostBreakdown,
  UsageCostShares,
  UsageEfficiencyMetrics,
  UsageHourlyProfileCell,
  UsageStatsRollupRow,
  UsageTimeBucket,
} from "@cchistory/domain";
import {
  activeItem,
  activeSectionTitle,
  blue,
  bold,
  cursor as cursorColor,
  cyan,
  danger,
  dim,
  green,
  isColorEnabled,
  magenta,
  muted,
  warning,
  yellow,
} from "./colors.js";
import { viewportWindow } from "./render.js";
import type { LiteStatsResolvedViewData, LiteStatsState } from "./stats-state.js";
import { clipLine, compact, displayWidth, formatCompactCount, padLine } from "./text.js";

const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const EIGHTH_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

export function formatTuiUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTuiMultiplier(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  const rounded = Math.round(ratio * 100) / 100;
  if (Number.isInteger(rounded)) return `${rounded}.0x`;
  return `${rounded.toFixed(2).replace(/0+$/u, "")}x`;
}

export function formatTuiTimeLabel(label: string, bucket: UsageTimeBucket): string {
  if (bucket === "hour") {
    // "2026-11-19 22:00" -> "11-19 22:00" (11 cols: keeps month, day, and hour without clipping)
    const m = /^\d{4}-(\d{2}-\d{2} \d{2}:\d{2})$/u.exec(label);
    return m ? m[1]! : label;
  }
  if (bucket === "hour_of_day") {
    return label;
  }
  if (bucket === "week") {
    const isoMatch = /^(\d{4}-W\d{2})\b/u.exec(label);
    if (isoMatch) return isoMatch[1]!;
    const rangeMatch = /^\d{4}-(\d{2}-\d{2})\.\.\d{4}-(\d{2}-\d{2})/u.exec(label);
    if (rangeMatch) return `${rangeMatch[1]}..${rangeMatch[2]}`;
  }
  return label;
}

export function padRightTui(text: string, width: number): string {
  const clipped = clipLine(text, width);
  const gap = Math.max(0, width - displayWidth(clipped));
  return `${" ".repeat(gap)}${clipped}`;
}

export function renderTuiBar(
  ratio: number,
  width: number,
  fillStyle: (text: string) => string = cyan,
): string {
  const w = Math.max(2, Math.floor(width));
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  let filled = Math.round(clamped * w);
  if (clamped > 0 && filled === 0) filled = 1;
  const empty = Math.max(0, w - filled);
  return `${fillStyle("█".repeat(filled))}${dim("░".repeat(empty))}`;
}

/**
 * High-resolution 1/8th-cell horizontal bar (8 * width visual levels) padded to exact `width`
 * columns with clean spaces so max-normalized rows ($200 vs $3) are visually unmistakable.
 */
export function renderTuiFractionalBar(
  ratio: number,
  width: number,
  fillStyle: (text: string) => string = cyan,
): string {
  const w = Math.max(2, Math.floor(width));
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  let eighths = Math.round(clamped * w * 8);
  if (clamped > 0 && eighths === 0) eighths = 1;
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const barChars = `${"█".repeat(full)}${rem > 0 ? EIGHTH_BLOCKS[rem]! : ""}`;
  const usedCols = full + (rem > 0 ? 1 : 0);
  const padCols = Math.max(0, w - usedCols);
  return `${barChars ? fillStyle(barChars) : ""}${" ".repeat(padCols)}`;
}

export function renderTuiSparkline(
  values: readonly number[],
  options: { zeroChar?: string; activeStyle?: (text: string) => string; zeroStyle?: (text: string) => string } = {},
): string {
  if (values.length === 0) return "";
  const zeroChar = options.zeroChar ?? "·";
  const max = values.reduce((best, value) => (Number.isFinite(value) && value > best ? value : best), 0);
  if (max <= 0) {
    const empty = zeroChar.repeat(values.length);
    return options.zeroStyle ? options.zeroStyle(empty) : dim(empty);
  }
  return values
    .map((value) => {
      const safe = Number.isFinite(value) && value > 0 ? value : 0;
      if (safe === 0) return options.zeroStyle ? options.zeroStyle(zeroChar) : dim(zeroChar);
      const idx = Math.min(
        SPARK_BLOCKS.length - 1,
        Math.max(0, Math.round((safe / max) * (SPARK_BLOCKS.length - 1))),
      );
      const ch = SPARK_BLOCKS[idx]!;
      return options.activeStyle ? options.activeStyle(ch) : cyan(ch);
    })
    .join("");
}

export function renderTuiHourlyProfileBadge(profile: readonly UsageHourlyProfileCell[] | undefined): string {
  if (!profile || profile.length !== 24) return "";
  const hasCost = profile.some((c) => c.adjusted_cost_usd > 0);
  const hasTokens = profile.some((c) => c.total_tokens > 0);
  if (!hasCost && !hasTokens) return "";
  const values = profile.map((c) => (hasCost ? c.adjusted_cost_usd : c.total_tokens));
  const spark = renderTuiSparkline(values, { zeroChar: "·", activeStyle: cyan, zeroStyle: dim });
  return `00-23h [${spark}]`;
}

export function renderTuiCacheHit(ratio: number | null, compactForm = false): string {
  if (ratio === null || !Number.isFinite(ratio)) return dim("—");
  const pct = compactForm ? `${Math.round(ratio * 100)}%` : `${(ratio * 100).toFixed(0)}%`;
  const text = ratio < 0.4 ? `${pct}!` : pct;
  if (ratio >= 0.7) return green(text);
  if (ratio >= 0.4) return yellow(text);
  return danger(text);
}

export function renderTuiCostMixBar(
  cost: UsageCostBreakdown | undefined,
  shares: UsageCostShares | null | undefined,
  barWidth: number,
): string {
  if (!cost || !shares) return "";
  const allSegments: Array<{
    label: string;
    share: number;
    usd: number;
    char: string;
    plainChar: string;
    style: (s: string) => string;
  }> = [
    { label: "In", share: shares.input, usd: cost.input_adjusted_cost_usd, char: "█", plainChar: "█", style: blue },
    { label: "CR", share: shares.cache_read, usd: cost.cache_read_adjusted_cost_usd, char: "█", plainChar: "▓", style: green },
    { label: "CW", share: shares.cache_write, usd: cost.cache_write_adjusted_cost_usd, char: "▓", plainChar: "▒", style: yellow },
    { label: "Out", share: shares.output, usd: cost.output_adjusted_cost_usd, char: "█", plainChar: "░", style: cyan },
    { label: "Reas", share: shares.reasoning, usd: cost.reasoning_adjusted_cost_usd, char: "▒", plainChar: "·", style: magenta },
  ];
  const segments = allSegments.filter((seg) => seg.usd > 0 && seg.share > 0);
  if (segments.length === 0) return "";

  const widths = segments.map((seg) => Math.max(1, Math.round(seg.share * barWidth)));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > barWidth) {
    let maxIdx = 0;
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i]! > widths[maxIdx]!) maxIdx = i;
    }
    if (widths[maxIdx]! <= 1) break;
    widths[maxIdx]! -= 1;
    total -= 1;
  }
  while (total < barWidth && widths.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < segments.length; i += 1) {
      if (segments[i]!.share > segments[maxIdx]!.share) maxIdx = i;
    }
    widths[maxIdx]! += 1;
    total += 1;
  }

  const colorOn = isColorEnabled();
  const bar = segments
    .map((seg, i) => seg.style((colorOn ? seg.char : seg.plainChar).repeat(widths[i]!)))
    .join("");
  const legend = segments
    .map((seg) => `${seg.style(seg.label)} ${Math.round(seg.share * 100)}%`)
    .join(" ");
  return `[${bar}] ${legend}`;
}

export function renderTuiQuotaGauge(
  cost: UsageCostBreakdown | undefined,
  pace: QuotaPaceProjection | undefined,
  barWidth = 10,
): string {
  if (!cost || cost.quota_limit_usd === undefined || cost.quota_percent === undefined) {
    return dim("$ quota");
  }
  const color =
    pace?.status === "over_limit" || cost.quota_percent >= 100
      ? danger
      : pace?.status === "fast" || cost.quota_percent >= 85
        ? warning
        : green;
  const bar = renderTuiBar(cost.quota_percent / 100, barWidth, color);
  const core = `[${bar}] ${bold(color(`${cost.quota_percent.toFixed(1)}%`))} of ${formatTuiUsd(cost.quota_limit_usd)}`;
  if (!pace) return core;
  if (pace.status === "over_limit") return `${core} ${danger("OVER")}`;
  if (pace.elapsed_ratio < 0.999 && pace.projected_period_cost_usd !== null) {
    return `${core} ${dim(`(t:${Math.round(pace.elapsed_ratio * 100)}% est ${formatTuiUsd(pace.projected_period_cost_usd)})`)}`;
  }
  return core;
}

export function renderTuiDiagnosticsBar(
  data: LiteStatsResolvedViewData,
  width: number,
): string | undefined {
  const eff: UsageEfficiencyMetrics | undefined =
    data.breakdown.efficiency ?? data.breakdown.overview.efficiency;
  const cost = data.breakdown.overview.cost;
  if (!eff && !cost) return undefined;

  const parts: string[] = [];
  if (eff) {
    if (eff.cache_hit_ratio !== null) {
      const barColor =
        eff.cache_hit_ratio >= 0.7 ? green : eff.cache_hit_ratio >= 0.4 ? yellow : danger;
      parts.push(`Hit ${renderTuiCacheHit(eff.cache_hit_ratio)} [${renderTuiBar(eff.cache_hit_ratio, 5, barColor)}]`);
    }
    if (eff.cache_adjusted_savings_usd > 0) {
      parts.push(`Saved ~${green(formatTuiUsd(eff.cache_adjusted_savings_usd))}`);
    }
    if (eff.high_context_call_count > 0) {
      parts.push(warning(`>200K: ${eff.high_context_call_count}c`));
    }
  }
  const anomCount = data.anomalies.length;
  if (anomCount > 0) {
    parts.push(warning(`⚠ ${anomCount} anom(a)`));
  }
  if (width < 100 && cost?.quota_limit_usd !== undefined) {
    parts.push(`Quota ${renderTuiQuotaGauge(cost, data.breakdown.quota_pace, 6)}`);
  }
  const mix = width >= 94 ? renderTuiCostMixBar(cost, eff?.cost_shares, width >= 115 ? 14 : 10) : "";
  if (mix) parts.push(`Mix ${mix}`);
  if (width >= 120 && data.breakdown.hourly_profile) {
    const hod = renderTuiHourlyProfileBadge(data.breakdown.hourly_profile);
    if (hod) parts.push(hod);
  }
  if (parts.length === 0) return undefined;
  return clipLine(`  ${parts.join(" · ")}`, width);
}

export function renderTopSessionsView(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
  budget: number,
): string[] {
  const rows: readonly UsageStatsRollupRow[] = data.sessionRows;
  const lines: string[] = [
    clipLine(
      `${activeSectionTitle(`▸ Top Sessions (${rows.length})`)}  ${dim(
        `o sort (${stats.sortBy}) · Enter open · T trace · S/Esc back`,
      )}`,
      width,
    ),
  ];

  const wide = width >= 112;
  const headerLine = wide
    ? `  ${"Session".padEnd(26)} ${"Project".padEnd(14)} ${"Bar & Share".padEnd(15)} ${"Hit".padStart(5)} ${"Signals".padEnd(12)} ${"Tokens".padStart(7)} ${"Adj$".padStart(8)}`
    : `  ${"Session".padEnd(20)} ${"Bar & Share".padEnd(13)} ${"Hit".padStart(5)} ${"Tok".padStart(6)} ${"Adj$".padStart(8)}`;
  lines.push(dim(clipLine(headerLine, width)));

  if (rows.length === 0) {
    lines.push(`  ${muted("(no sessions match active filters)")}`);
    return lines;
  }

  const totalCost = rows.reduce((sum, r) => sum + (r.cost?.adjusted_cost_usd ?? 0), 0);
  const totalTokens = rows.reduce((sum, r) => sum + r.total_tokens, 0);
  const useCost = totalCost > 0;
  const denom = useCost ? totalCost : totalTokens;
  const maxVal = rows.reduce((best, r) => Math.max(best, useCost ? (r.cost?.adjusted_cost_usd ?? 0) : r.total_tokens), 0);

  const bodyH = Math.max(1, budget - lines.length);
  const cursorIdx = Math.min(stats.cursors.sessions, rows.length - 1);
  const win = viewportWindow(rows.length, cursorIdx, bodyH);
  for (let idx = win.start; idx < win.end; idx += 1) {
    const r = rows[idx]!;
    const isCursor = idx === cursorIdx;
    const prefix = isCursor ? cursorColor("❯") : dim("·");
    const meta = r.session_meta;
    const val = useCost ? (r.cost?.adjusted_cost_usd ?? 0) : r.total_tokens;
    const barRatio = maxVal > 0 ? val / maxVal : 0;
    const shareRatio = denom > 0 ? val / denom : 0;
    const hitText = renderTuiCacheHit(r.efficiency?.cache_hit_ratio ?? null, true);
    const tokText = formatCompactCount(r.total_tokens) || "0";
    const adjText = formatTuiUsd(r.cost?.adjusted_cost_usd ?? 0);

    if (wide) {
      const shareStr = `${renderTuiFractionalBar(barRatio, 10, cyan)} ${String(Math.round(shareRatio * 100)).padStart(3)}%`;
      const signals: string[] = [];
      if (meta && meta.delegated_child_count > 0) signals.push(`${meta.delegated_child_count}sub`);
      if (meta && (meta.miss_call_count ?? 0) > 0) signals.push(danger(`${meta.miss_call_count}miss`));
      if (meta && meta.tool_error_count > 0) signals.push(danger(`${meta.tool_error_count}err`));
      else if (meta && meta.tool_call_count > 0 && signals.length < 2) signals.push(dim(`${meta.tool_call_count}tool`));
      const sigStr = signals.length > 0 ? signals.join(" ") : dim("—");
      const titleCell = padLine(compact(meta?.title ?? r.label, 26), 26);
      const cells = [
        isCursor ? activeItem(titleCell) : titleCell,
        padLine(compact(meta?.project_label ?? "—", 14), 14),
        padLine(shareStr, 15),
        padRightTui(hitText, 5),
        padLine(sigStr, 12),
        padRightTui(tokText, 7),
        padRightTui(adjText, 8),
      ];
      lines.push(clipLine(`${prefix} ${cells.join(" ")}`, width));
    } else {
      const shareStr = `${renderTuiFractionalBar(barRatio, 8, cyan)} ${String(Math.round(shareRatio * 100)).padStart(3)}%`;
      const titleCell = padLine(compact(meta?.title ?? r.label, 20), 20);
      const cells = [
        isCursor ? activeItem(titleCell) : titleCell,
        padLine(shareStr, 13),
        padRightTui(hitText, 5),
        padRightTui(tokText, 6),
        padRightTui(adjText, 8),
      ];
      lines.push(clipLine(`${prefix} ${cells.join(" ")}`, width));
    }
  }
  return lines;
}
