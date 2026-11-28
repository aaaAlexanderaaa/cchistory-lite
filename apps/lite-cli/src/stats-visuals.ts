/**
 * Role: Pure terminal visualization primitives (proportion bars, stacked cost-mix bars,
 * dual-marker quota pace gauges, sparklines, and cache-hit badges) for CLI `stats`.
 * Excludes usage arithmetic (canonical) and table/section layout (stats-render.ts).
 */

import type {
  QuotaPaceProjection,
  UsageCostBreakdown,
  UsageCostShares,
  UsageEfficiencyMetrics,
  UsageHourlyProfileCell,
} from "@cchistory/domain";
import {
  AGGREGATE_CACHE_HIT_GOOD_RATIO,
  AGGREGATE_CACHE_HIT_WARN_RATIO,
} from "@cchistory/live-runtime";

export interface StatsVisualPalette {
  useColor: boolean;
  dim: (text: string) => string;
  bold: (text: string) => string;
  blue: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  red: (text: string) => string;
  cyan: (text: string) => string;
  magenta: (text: string) => string;
}

const ANSI_PALETTE: StatsVisualPalette = {
  useColor: true,
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
  blue: (s) => `\u001b[34m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  cyan: (s) => `\u001b[36m${s}\u001b[0m`,
  magenta: (s) => `\u001b[35m${s}\u001b[0m`,
};

const PLAIN_PALETTE: StatsVisualPalette = {
  useColor: false,
  dim: (s) => s,
  bold: (s) => s,
  blue: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  red: (s) => s,
  cyan: (s) => s,
  magenta: (s) => s,
};

const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const EIGHTH_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

export function createStatsPalette(useColor: boolean): StatsVisualPalette {
  return useColor ? ANSI_PALETTE : PLAIN_PALETTE;
}

export function formatVisualUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function renderProportionBar(
  ratio: number,
  width: number,
  fillStyle?: (text: string) => string,
  emptyStyle?: (text: string) => string,
): string {
  const clampedWidth = Math.max(2, Math.floor(width));
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  let filled = Math.round(clamped * clampedWidth);
  if (clamped > 0 && filled === 0) filled = 1;
  const empty = Math.max(0, clampedWidth - filled);
  const filledStr = "█".repeat(filled);
  const emptyStr = "░".repeat(empty);
  return `${fillStyle ? fillStyle(filledStr) : filledStr}${emptyStyle ? emptyStyle(emptyStr) : emptyStr}`;
}

/**
 * High-resolution 1/8th-cell horizontal comparison bar (8 * width visual steps).
 * Intended for max-normalized row comparisons so $200 vs $3 shows an unmistakable visual ratio.
 */
export function renderFractionalBar(
  ratio: number,
  width: number,
  fillStyle?: (text: string) => string,
): string {
  const clampedWidth = Math.max(2, Math.floor(width));
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  let eighths = Math.round(clamped * clampedWidth * 8);
  if (clamped > 0 && eighths === 0) eighths = 1;
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const barChars = `${"█".repeat(full)}${rem > 0 ? EIGHTH_BLOCKS[rem]! : ""}`;
  const usedCols = full + (rem > 0 ? 1 : 0);
  const padCols = Math.max(0, clampedWidth - usedCols);
  return `${barChars ? (fillStyle ? fillStyle(barChars) : barChars) : ""}${" ".repeat(padCols)}`;
}

export function renderSparkline(
  values: readonly number[],
  options: { zeroChar?: string; activeStyle?: (text: string) => string; zeroStyle?: (text: string) => string } = {},
): string {
  if (values.length === 0) return "";
  const zeroChar = options.zeroChar ?? "·";
  const max = values.reduce((best, value) => (Number.isFinite(value) && value > best ? value : best), 0);
  if (max <= 0) {
    const empty = zeroChar.repeat(values.length);
    return options.zeroStyle ? options.zeroStyle(empty) : empty;
  }
  return values
    .map((value) => {
      const safe = Number.isFinite(value) && value > 0 ? value : 0;
      if (safe === 0) return options.zeroStyle ? options.zeroStyle(zeroChar) : zeroChar;
      const idx = Math.min(
        SPARK_BLOCKS.length - 1,
        Math.max(0, Math.round((safe / max) * (SPARK_BLOCKS.length - 1))),
      );
      const ch = SPARK_BLOCKS[idx]!;
      return options.activeStyle ? options.activeStyle(ch) : ch;
    })
    .join("");
}

export function formatEffectiveMultiplier(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  const rounded = Math.round(ratio * 100) / 100;
  if (Number.isInteger(rounded)) return `${rounded}.0x`;
  return `${rounded.toFixed(2).replace(/0+$/u, "")}x`;
}

export function renderHourlyProfileLines(
  profile: readonly UsageHourlyProfileCell[],
  timezone: string,
  palette: StatsVisualPalette,
): string[] {
  if (profile.length !== 24) return [];
  const hasCost = profile.some((c) => c.adjusted_cost_usd > 0);
  const hasTokens = profile.some((c) => c.total_tokens > 0);
  if (!hasCost && !hasTokens) return [];
  const values = profile.map((c) => (hasCost ? c.adjusted_cost_usd : c.total_tokens));
  const spark = renderSparkline(values, {
    zeroChar: "·",
    activeStyle: palette.cyan,
    zeroStyle: palette.dim,
  });
  let peakHour = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i]! > values[peakHour]!) peakHour = i;
  }
  const peakCell = profile[peakHour]!;
  const peakLabel = `${String(peakHour).padStart(2, "0")}:00`;
  const peakMetric = hasCost
    ? formatVisualUsd(peakCell.adjusted_cost_usd)
    : `${new Intl.NumberFormat("en-US").format(peakCell.total_tokens)} tok`;
  const prefix = `- Hour of day (00-23, ${timezone}): `;
  const ruler = "00    06    12    18  23";
  return [
    `${prefix}${spark}  ${palette.dim(`peak ${peakLabel} (${peakMetric})`)}`,
    `${" ".repeat(prefix.length)}${palette.dim(ruler)}`,
  ];
}

export function formatCacheHitText(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  const pct = `${(ratio * 100).toFixed(1)}%`;
  return ratio < AGGREGATE_CACHE_HIT_WARN_RATIO ? `${pct}!` : pct;
}

export function styleCacheHit(text: string, ratio: number | null, palette: StatsVisualPalette): string {
  if (ratio === null || !Number.isFinite(ratio)) return palette.dim(text);
  if (ratio >= AGGREGATE_CACHE_HIT_GOOD_RATIO) return palette.green(text);
  if (ratio >= AGGREGATE_CACHE_HIT_WARN_RATIO) return palette.yellow(text);
  return palette.red(text);
}

export function renderQuotaLine(
  cost: UsageCostBreakdown,
  pace: QuotaPaceProjection | undefined,
  palette: StatsVisualPalette,
): string | undefined {
  if (cost.quota_limit_usd === undefined || cost.quota_percent === undefined) return undefined;
  const barWidth = 14;
  const ratio = cost.quota_percent / 100;
  const statusColor =
    pace?.status === "over_limit" || cost.quota_percent >= 100
      ? palette.red
      : pace?.status === "fast" || cost.quota_percent >= 85
        ? palette.yellow
        : palette.green;
  const bar = renderProportionBar(ratio, barWidth, statusColor, palette.dim);
  const head = `[${bar}] ${statusColor(`${cost.quota_percent.toFixed(1)}%`)} of ${formatVisualUsd(cost.quota_limit_usd)}`;
  if (!pace) return head;

  const details: string[] = [];
  if (pace.elapsed_ratio < 0.999) {
    details.push(`time ${(pace.elapsed_ratio * 100).toFixed(0)}%`);
  }
  if (pace.projected_period_cost_usd !== null && pace.elapsed_ratio < 0.999) {
    details.push(`est ${formatVisualUsd(pace.projected_period_cost_usd)}/${pace.period_label}`);
  }
  if (pace.status === "over_limit") {
    details.push(palette.red("over limit"));
  } else if (pace.estimated_days_to_limit !== null && pace.estimated_days_to_limit < 365) {
    const daysText =
      pace.estimated_days_to_limit < 1
        ? `${(pace.estimated_days_to_limit * 24).toFixed(1)}h to limit`
        : `${pace.estimated_days_to_limit.toFixed(1)}d to limit`;
    details.push(pace.status === "fast" ? palette.yellow(`${daysText} (fast)`) : palette.dim(daysText));
  }
  return details.length > 0 ? `${head}  ${palette.dim("│")}  ${details.join(" · ")}` : head;
}

export function renderCostMixSummary(
  cost: UsageCostBreakdown,
  shares: UsageCostShares,
  palette: StatsVisualPalette,
  barWidth = 24,
): string {
  const allSegments: Array<{
    key: keyof UsageCostShares;
    label: string;
    share: number;
    usd: number;
    char: string;
    plainChar: string;
    style: (s: string) => string;
  }> = [
    { key: "input", label: "In", share: shares.input, usd: cost.input_adjusted_cost_usd, char: "█", plainChar: "█", style: palette.blue },
    { key: "cache_read", label: "CacheR", share: shares.cache_read, usd: cost.cache_read_adjusted_cost_usd, char: "█", plainChar: "▓", style: palette.green },
    { key: "cache_write", label: "CacheW", share: shares.cache_write, usd: cost.cache_write_adjusted_cost_usd, char: "▓", plainChar: "▒", style: palette.yellow },
    { key: "output", label: "Out", share: shares.output, usd: cost.output_adjusted_cost_usd, char: "█", plainChar: "░", style: palette.cyan },
    { key: "reasoning", label: "Reason", share: shares.reasoning, usd: cost.reasoning_adjusted_cost_usd, char: "▒", plainChar: "·", style: palette.magenta },
  ];
  const segments = allSegments.filter((seg) => seg.usd > 0 && seg.share > 0);

  if (segments.length === 0) return "";

  // Allocate integer columns summing to barWidth, giving every active segment at least 1 cell when space allows.
  const widths = segments.map((seg) => Math.max(1, Math.round(seg.share * barWidth)));
  let sum = widths.reduce((a, b) => a + b, 0);
  while (sum > barWidth) {
    let maxIdx = 0;
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i]! > widths[maxIdx]!) maxIdx = i;
    }
    if (widths[maxIdx]! <= 1) break;
    widths[maxIdx]! -= 1;
    sum -= 1;
  }
  while (sum < barWidth && widths.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < segments.length; i += 1) {
      if (segments[i]!.share > segments[maxIdx]!.share) maxIdx = i;
    }
    widths[maxIdx]! += 1;
    sum += 1;
  }

  const bar = segments
    .map((seg, i) => seg.style((palette.useColor ? seg.char : seg.plainChar).repeat(widths[i]!)))
    .join("");
  const legend = segments
    .map((seg) => `${seg.style(seg.label)} ${(seg.share * 100).toFixed(0)}% (${formatVisualUsd(seg.usd)})`)
    .join(" · ");
  return `[${bar}]  ${legend}`;
}

export function renderEfficiencySummary(
  efficiency: UsageEfficiencyMetrics,
  palette: StatsVisualPalette,
): string {
  const parts: string[] = [];
  if (efficiency.cache_hit_ratio !== null) {
    const barColor =
      efficiency.cache_hit_ratio >= 0.7
        ? palette.green
        : efficiency.cache_hit_ratio >= 0.4
          ? palette.yellow
          : palette.red;
    const hitBar = renderProportionBar(efficiency.cache_hit_ratio, 8, barColor, palette.dim);
    const pctText = styleCacheHit(formatCacheHitText(efficiency.cache_hit_ratio), efficiency.cache_hit_ratio, palette);
    parts.push(`Cache Hit ${pctText} [${hitBar}]`);
  } else {
    parts.push(`Cache Hit ${palette.dim("—")}`);
  }
  if (efficiency.cache_adjusted_savings_usd > 0) {
    parts.push(`Saved ~${palette.green(formatVisualUsd(efficiency.cache_adjusted_savings_usd))}`);
  }
  if (efficiency.reasoning_share_ratio !== null && efficiency.reasoning_share_ratio > 0) {
    parts.push(`Reasoning ${(efficiency.reasoning_share_ratio * 100).toFixed(0)}% of out`);
  }
  if (efficiency.high_context_call_count > 0) {
    parts.push(
      palette.yellow(
        `Long-context tier: ${efficiency.high_context_call_count}/${efficiency.priced_call_count} calls (${formatVisualUsd(efficiency.high_context_adjusted_cost_usd)})`,
      ),
    );
  }
  return parts.join(" · ");
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/gu;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function isWideCode(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0x33bf) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const ch of stripAnsi(value)) {
    width += isWideCode(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

export function clipVisible(value: string, maxWidth: number): string {
  if (displayWidth(value) <= maxWidth) return value;
  if (maxWidth <= 1) return "…";
  let width = 0;
  let result = "";
  let idx = 0;
  while (idx < value.length) {
    if (value[idx] === "\u001b" && value[idx + 1] === "[") {
      const end = value.indexOf("m", idx);
      if (end !== -1) {
        result += value.slice(idx, end + 1);
        idx = end + 1;
        continue;
      }
    }
    const cp = value.codePointAt(idx) ?? 0;
    const ch = String.fromCodePoint(cp);
    const chW = isWideCode(cp) ? 2 : 1;
    if (width + chW > maxWidth - 1) {
      result += "…";
      break;
    }
    result += ch;
    width += chW;
    idx += ch.length;
  }
  return result.includes("\u001b[") ? `${result}\u001b[0m` : result;
}

export function padCell(value: string, width: number, rightAlign = false): string {
  const clipped = clipVisible(value, width);
  const gap = Math.max(0, width - displayWidth(clipped));
  return rightAlign ? `${" ".repeat(gap)}${clipped}` : `${clipped}${" ".repeat(gap)}`;
}

export function renderAlignedTable(
  headers: readonly { title: string; width: number; right?: boolean }[],
  rows: ReadonlyArray<readonly string[]>,
): string[] {
  const lines = [
    `  ${headers.map((h) => padCell(h.title, h.width, h.right)).join("  ")}`,
    `  ${headers.map((h) => "-".repeat(h.width)).join("  ")}`,
  ];
  for (const row of rows) {
    lines.push(`  ${headers.map((h, i) => padCell(row[i] ?? "", h.width, h.right)).join("  ")}`);
  }
  return lines;
}

export function formatCompactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function formatDurationBrief(ms: number | null | undefined): string {
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
