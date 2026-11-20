/**
 * Role: Human-readable tabular, diagnostic, and terminal-visual rendering for CLI `stats`.
 * Excludes option parsing (stats-command.ts), visual primitives (stats-visuals.ts), and math (canonical).
 */

import path from "node:path";
import type {
  ModelPricingResolution,
  UsageBreakdownSnapshot,
  UsageCostBreakdown,
  UsageMatrixResult,
  UsageStatsOverview,
  UsageStatsRollup,
  UsageStatsRollupRow,
} from "@cchistory/domain";
import { buildDenseTimeSeries, densifyShortHourlyRollupRows } from "@cchistory/live-runtime";
import {
  createStatsPalette,
  formatCacheHitText,
  formatEffectiveMultiplier,
  formatVisualUsd,
  renderCostMixSummary,
  renderEfficiencySummary,
  renderFractionalBar,
  renderHourlyProfileLines,
  renderQuotaLine,
  renderSparkline,
  styleCacheHit,
  type StatsVisualPalette,
} from "./stats-visuals.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/gu;

function stripAnsi(value: string): string {
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

function displayWidth(value: string): number {
  let width = 0;
  for (const ch of stripAnsi(value)) {
    width += isWideCode(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function clipVisible(value: string, maxWidth: number): string {
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

function padCell(value: string, width: number, rightAlign = false): string {
  const clipped = clipVisible(value, width);
  const gap = Math.max(0, width - displayWidth(clipped));
  return rightAlign ? `${" ".repeat(gap)}${clipped}` : `${clipped}${" ".repeat(gap)}`;
}

function formatNum(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatCompact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNum(value);
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function formatQuotaPct(cost: UsageCostBreakdown | undefined): string {
  if (!cost || cost.quota_percent === undefined) return "—";
  return `${cost.quota_percent.toFixed(1)}%`;
}

function renderUsageTable(
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

function resolveRowShareMetric(rows: readonly UsageStatsRollupRow[]): {
  useCost: boolean;
  total: number;
  max: number;
} {
  const totalCost = rows.reduce((sum, r) => sum + (r.cost?.adjusted_cost_usd ?? 0), 0);
  if (totalCost > 0) {
    const max = rows.reduce((best, r) => Math.max(best, r.cost?.adjusted_cost_usd ?? 0), 0);
    return { useCost: true, total: totalCost, max };
  }
  const totalTokens = rows.reduce((sum, r) => sum + r.total_tokens, 0);
  const max = rows.reduce((best, r) => Math.max(best, r.total_tokens), 0);
  return { useCost: false, total: totalTokens, max };
}

function formatShareCell(
  barRatio: number,
  shareRatio: number,
  barWidth: number,
  palette: StatsVisualPalette,
): string {
  const bar = renderFractionalBar(barRatio, barWidth, palette.cyan);
  const pct = `${Math.round(shareRatio * 100)}%`.padStart(4);
  return `${bar} ${pct}`;
}

function rollupToTableRows(
  rows: readonly UsageStatsRollupRow[],
  wide: boolean,
  hasQuota: boolean,
  palette: StatsVisualPalette,
): string[][] {
  const { useCost, total, max } = resolveRowShareMetric(rows);
  const barWidth = wide ? 12 : 10;
  return rows.map((row) => {
    const value = useCost ? (row.cost?.adjusted_cost_usd ?? 0) : row.total_tokens;
    const barRatio = max > 0 ? value / max : 0;
    const shareRatio = total > 0 ? value / total : 0;
    const shareCell = formatShareCell(barRatio, shareRatio, barWidth, palette);
    const hitRatio = row.efficiency?.cache_hit_ratio ?? null;
    const hitCell = styleCacheHit(formatCacheHitText(hitRatio), hitRatio, palette);

    if (wide) {
      const base = [
        row.label,
        shareCell,
        String(row.turn_count),
        formatCompact(row.total_input_tokens),
        formatCompact(row.total_cache_read_input_tokens ?? 0),
        formatCompact(row.total_output_tokens),
        formatNum(row.total_tokens),
        hitCell,
        formatVisualUsd(row.cost?.list_cost_usd ?? 0),
        formatVisualUsd(row.cost?.adjusted_cost_usd ?? 0),
      ];
      return hasQuota ? [...base, formatQuotaPct(row.cost)] : base;
    }
    return [
      row.label,
      shareCell,
      formatCompact(row.total_tokens),
      hitCell,
      formatVisualUsd(row.cost?.list_cost_usd ?? 0),
      formatVisualUsd(row.cost?.adjusted_cost_usd ?? 0),
    ];
  });
}

function renderRollupSection(
  title: string,
  rows: readonly UsageStatsRollupRow[],
  wide: boolean,
  hasQuota: boolean,
  palette: StatsVisualPalette,
  limit?: number,
): string[] {
  const shown = limit !== undefined && rows.length > limit ? rows.slice(0, limit) : rows;
  const headers = wide
    ? [
        { title: "Name", width: hasQuota ? 20 : 22 },
        { title: "Bar (max) & Share", width: 17 },
        { title: "Turns", width: 5, right: true },
        { title: "Input", width: 8, right: true },
        { title: "CacheR", width: 8, right: true },
        { title: "Output", width: 8, right: true },
        { title: "Total", width: 11, right: true },
        { title: "Hit", width: 6, right: true },
        { title: "List$", width: 8, right: true },
        { title: "Adj$", width: 8, right: true },
        ...(hasQuota ? [{ title: "Quota", width: 6, right: true }] : []),
      ]
    : [
        { title: "Name", width: 18 },
        { title: "Bar & Share", width: 15 },
        { title: "Total", width: 9, right: true },
        { title: "Hit", width: 6, right: true },
        { title: "List$", width: 8, right: true },
        { title: "Adj$", width: 8, right: true },
      ];
  const lines = [title];
  if (shown.length === 0) {
    lines.push("  (no matching rows)");
    return lines;
  }
  lines.push(...renderUsageTable(headers, rollupToTableRows(shown, wide, hasQuota, palette)));
  if (limit !== undefined && rows.length > limit) {
    lines.push(`  ... ${rows.length - limit} more rows (use --by <dim> to view all)`);
  }
  return lines;
}

function renderSessionRollupSection(
  title: string,
  rows: readonly UsageStatsRollupRow[],
  wide: boolean,
  palette: StatsVisualPalette,
  limit?: number,
): string[] {
  const shown = limit !== undefined && rows.length > limit ? rows.slice(0, limit) : rows;
  const lines = [title];
  if (shown.length === 0) {
    lines.push("  (no matching sessions)");
    return lines;
  }
  const { useCost, total, max } = resolveRowShareMetric(rows);
  const headers = wide
    ? [
        { title: "Session", width: 24 },
        { title: "Project", width: 14 },
        { title: "Bar (max) & Share", width: 17 },
        { title: "Hit", width: 6, right: true },
        { title: "Signals", width: 14 },
        { title: "Tokens", width: 9, right: true },
        { title: "Adj$", width: 8, right: true },
      ]
    : [
        { title: "Session", width: 20 },
        { title: "Bar & Share", width: 15 },
        { title: "Hit", width: 6, right: true },
        { title: "Signals", width: 12 },
        { title: "Adj$", width: 8, right: true },
      ];
  const tableRows = shown.map((row) => {
    const value = useCost ? (row.cost?.adjusted_cost_usd ?? 0) : row.total_tokens;
    const barRatio = max > 0 ? value / max : 0;
    const shareRatio = total > 0 ? value / total : 0;
    const hitRatio = row.efficiency?.cache_hit_ratio ?? null;
    const hitCell = styleCacheHit(formatCacheHitText(hitRatio), hitRatio, palette);
    const meta = row.session_meta;
    const signals: string[] = [];
    if (meta && meta.delegated_child_count > 0) signals.push(`${meta.delegated_child_count}sub`);
    if (meta && meta.tool_error_count > 0) signals.push(palette.red(`${meta.tool_error_count}err`));
    else if (meta && meta.tool_call_count > 0) signals.push(palette.dim(`${meta.tool_call_count}tool`));
    const signalText = signals.length > 0 ? signals.join(" ") : palette.dim("—");
    const shareCell = formatShareCell(barRatio, shareRatio, wide ? 12 : 10, palette);
    if (wide) {
      return [
        meta?.title ?? row.label,
        meta?.project_label ?? "—",
        shareCell,
        hitCell,
        signalText,
        formatCompact(row.total_tokens),
        formatVisualUsd(row.cost?.adjusted_cost_usd ?? 0),
      ];
    }
    return [
      meta?.title ?? row.label,
      shareCell,
      hitCell,
      signalText,
      formatVisualUsd(row.cost?.adjusted_cost_usd ?? 0),
    ];
  });
  lines.push(...renderUsageTable(headers, tableRows));
  if (limit !== undefined && rows.length > limit) {
    lines.push(`  ... ${rows.length - limit} more sessions (use --by session to view all)`);
  }
  return lines;
}

function renderTrendLine(breakdown: UsageBreakdownSnapshot, palette: StatsVisualPalette): string | undefined {
  const dense = buildDenseTimeSeries(breakdown.by_time.rows, breakdown.time_dimension, {
    timezone: breakdown.timezone,
    maxPoints: 36,
  });
  if (dense.length < 2) return undefined;
  const useCost = dense.some((pt) => pt.adjusted_cost_usd > 0);
  const values = dense.map((pt) => (useCost ? pt.adjusted_cost_usd : pt.total_tokens));
  const spark = renderSparkline(values, {
    zeroChar: "·",
    activeStyle: palette.cyan,
    zeroStyle: palette.dim,
  });
  let peakIdx = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i]! > values[peakIdx]!) peakIdx = i;
  }
  const peakPt = dense[peakIdx]!;
  const peakMetric = useCost
    ? formatVisualUsd(peakPt.adjusted_cost_usd)
    : `${formatCompact(peakPt.total_tokens)} tok`;
  const rangeTag =
    dense.length >= 2 ? ` · ${dense[0]!.key}..${dense[dense.length - 1]!.key}` : "";
  return `Trend (${breakdown.time_dimension}): ${spark}  ${palette.dim(`peak ${peakPt.label} (${peakMetric})${rangeTag}`)}`;
}

export function renderEnhancedStats(params: {
  breakdown: UsageBreakdownSnapshot;
  rollup?: UsageStatsRollup;
  matrix?: UsageMatrixResult;
  directoryScope?: string;
  cwd: string;
  modelQueries: readonly string[];
  projectRefs: readonly string[];
  sourceIds: readonly string[];
  explainPricing: boolean;
  exportNotice?: string;
  useColor?: boolean;
  renderMeta: (line: string) => string;
  renderDashRow: (line: string) => string;
  columns: number;
}): string {
  const {
    breakdown,
    rollup,
    matrix,
    directoryScope,
    cwd,
    modelQueries,
    projectRefs,
    sourceIds,
    explainPricing,
    exportNotice,
    useColor = false,
    renderMeta,
    renderDashRow,
    columns,
  } = params;
  const ov: UsageStatsOverview = breakdown.overview;
  const cost = ov.cost;
  const efficiency = breakdown.efficiency ?? ov.efficiency;
  const palette = createStatsPalette(useColor);
  const wide = columns >= 108;
  const hasQuota = Boolean(breakdown.quota_limit_usd && breakdown.quota_limit_usd > 0);

  const lines: string[] = [renderMeta("Stats")];
  if (directoryScope) {
    const isCwd = path.resolve(directoryScope) === path.resolve(cwd);
    lines.push(
      renderDashRow(
        `- Scope: ${directoryScope}${isCwd ? " (current directory; omit --dir for whole-machine stats)" : ""}`,
      ),
    );
  } else {
    lines.push(renderDashRow("- Scope: machine-wide (pass --dir . to scope to current directory)"));
  }

  const filterBits = [
    `tz=${breakdown.timezone}`,
    `bucket=${breakdown.time_dimension}`,
    `week=${breakdown.week_mode}`,
    breakdown.effective_after_date || breakdown.effective_before_date
      ? `window=${breakdown.effective_after_date ?? "*"}..${breakdown.effective_before_date ?? "*"}`
      : undefined,
    projectRefs.length > 0 ? `projects=${projectRefs.join(",")}` : undefined,
    modelQueries.length > 0 ? `models=${modelQueries.join(",")}` : undefined,
    sourceIds.length > 0 ? `sources=${sourceIds.length}` : undefined,
  ].filter(Boolean);
  lines.push(
    renderDashRow(`- Filters: ${filterBits.join(" · ")}`),
    renderDashRow(`- Turns: ${ov.total_turns} (with tokens: ${ov.turns_with_token_usage}, ${formatPct(ov.turn_coverage_ratio)})`),
    renderDashRow(
      `- Input: ${formatNum(ov.total_input_tokens)} · Cache Read: ${formatNum(ov.total_cache_read_input_tokens ?? 0)} · Cache Write: ${formatNum(ov.total_cache_creation_input_tokens ?? 0)}`,
    ),
    renderDashRow(
      `- Output: ${formatNum(ov.total_output_tokens)} (Reasoning: ${formatNum(ov.total_reasoning_output_tokens)}) · Total: ${formatNum(ov.total_tokens)}`,
    ),
  );

  if (cost) {
    lines.push(
      renderDashRow(
        `- Cost: List ${formatVisualUsd(cost.list_cost_usd)} · Adjusted ${formatVisualUsd(cost.adjusted_cost_usd)}`,
      ),
    );
    const quotaLine = renderQuotaLine(cost, breakdown.quota_pace, palette);
    if (quotaLine) {
      lines.push(renderDashRow(`- Quota: ${quotaLine}`));
    }
    if (efficiency?.cost_shares) {
      const mix = renderCostMixSummary(cost, efficiency.cost_shares, palette, wide ? 24 : 16);
      if (mix) lines.push(renderDashRow(`- Cost Mix: ${mix}`));
    }
    if (efficiency) {
      const health = renderEfficiencySummary(efficiency, palette);
      if (health) lines.push(renderDashRow(`- Efficiency: ${health}`));
    }
    if (cost.unpriced_models.length > 0) {
      lines.push(
        renderDashRow(
          `- Unpriced models (${formatNum(cost.unpriced_tokens)} tokens): ${cost.unpriced_models.join(", ")}`,
        ),
      );
    }
  }
  const trendLine = renderTrendLine(breakdown, palette);
  if (trendLine) {
    lines.push(renderDashRow(`- ${trendLine}`));
  }
  if (breakdown.hourly_profile && breakdown.time_dimension !== "hour_of_day") {
    const profileLines = renderHourlyProfileLines(breakdown.hourly_profile, breakdown.timezone, palette);
    for (const [idx, line] of profileLines.entries()) {
      lines.push(idx === 0 ? renderDashRow(line) : line);
    }
  }
  if (ov.excluded_zero_token_turns) {
    lines.push(renderDashRow(`- Excluded zero-token turns: ${ov.excluded_zero_token_turns} (no usage data)`));
  }
  if (exportNotice) {
    lines.push(renderDashRow(`- Exported pricing config: ${exportNotice}`));
  }

  if (rollup) {
    if (rollup.dimension === "session") {
      lines.push("", ...renderSessionRollupSection("By session", rollup.rows, wide, palette));
    } else {
      const displayRows =
        rollup.dimension === "hour"
          ? densifyShortHourlyRollupRows(rollup.rows, { timezone: breakdown.timezone })
          : rollup.rows;
      lines.push("", ...renderRollupSection(`By ${rollup.dimension}`, displayRows, wide, hasQuota, palette));
    }
  } else if (matrix) {
    lines.push("", `Matrix (${matrix.dimensions.join(" × ")})`);
    if (matrix.rows.length === 0) {
      lines.push("  (no matching rows)");
    } else {
      const headers = [
        ...matrix.dimensions.map((d) => ({
          title: d === "hour_of_day" ? "HourOfDay" : d[0]!.toUpperCase() + d.slice(1),
          width: d === "hour" ? 16 : d === "hour_of_day" ? 9 : d === "day" || d === "month" ? 12 : 18,
        })),
        { title: "Turns", width: 5, right: true },
        { title: "Input", width: 8, right: true },
        { title: "CacheR", width: 8, right: true },
        { title: "CacheW", width: 8, right: true },
        { title: "Output", width: 8, right: true },
        { title: "Total", width: 9, right: true },
        { title: "Hit", width: 6, right: true },
        { title: "Mult", width: 5, right: true },
        { title: "List$", width: 8, right: true },
        { title: "Adj$", width: 8, right: true },
        ...(hasQuota ? [{ title: "Quota", width: 7, right: true }] : []),
      ];
      const matrixTableRows = matrix.rows.map((r) => {
        const hitRatio = r.efficiency?.cache_hit_ratio ?? null;
        return [
          ...r.labels,
          String(r.turn_count),
          formatCompact(r.total_input_tokens),
          formatCompact(r.total_cache_read_input_tokens),
          formatCompact(r.total_cache_creation_input_tokens),
          formatCompact(r.total_output_tokens),
          formatCompact(r.total_tokens),
          styleCacheHit(formatCacheHitText(hitRatio), hitRatio, palette),
          formatEffectiveMultiplier(r.efficiency?.effective_multiplier),
          formatVisualUsd(r.cost.list_cost_usd),
          formatVisualUsd(r.cost.adjusted_cost_usd),
          ...(hasQuota ? [formatQuotaPct(r.cost)] : []),
        ];
      });
      lines.push(...renderUsageTable(headers, matrixTableRows));
    }
  } else {
    const timeLimit = breakdown.time_dimension === "hour" || breakdown.time_dimension === "hour_of_day" ? 24 : 14;
    const timeRows =
      breakdown.time_dimension === "hour"
        ? densifyShortHourlyRollupRows(breakdown.by_time.rows, { timezone: breakdown.timezone })
        : breakdown.by_time.rows;
    lines.push(
      "",
      ...renderRollupSection("By project", breakdown.by_project.rows, wide, hasQuota, palette, 10),
      "",
      ...renderRollupSection("By model", breakdown.by_model.rows, wide, hasQuota, palette, 10),
      "",
      ...renderRollupSection("By source", breakdown.by_source.rows, wide, hasQuota, palette, 10),
      "",
      ...renderRollupSection(`By ${breakdown.time_dimension}`, timeRows, wide, hasQuota, palette, timeLimit),
    );
    if (breakdown.by_session && breakdown.by_session.rows.length > 0) {
      lines.push(
        "",
        ...renderSessionRollupSection("Top sessions", breakdown.by_session.rows, wide, palette, 5),
      );
    }
  }

  if (explainPricing) {
    lines.push("", "Pricing Resolution & Multipliers");
    if (breakdown.model_resolutions.length === 0) {
      lines.push("  (no model usage rows)");
    } else {
      const headers = [
        { title: "Raw Model", width: 24 },
        { title: "Catalog Match", width: 20 },
        { title: "Kind", width: 10 },
        { title: "USD/1M (In/CR/CW/Out)", width: 22 },
        { title: "Mult (M/In/CR/CW/Out/R)", width: 23 },
        { title: "List$", width: 8, right: true },
        { title: "Adj$", width: 8, right: true },
      ];
      const rows = breakdown.model_resolutions.map((m: ModelPricingResolution) => {
        const p = m.unit_prices
          ? `${m.unit_prices.input}/${m.unit_prices.cache_read ?? "-"}/${m.unit_prices.cache_write ?? "-"}/${m.unit_prices.output}`
          : "unpriced";
        const x = m.multipliers;
        const mult = `${x.model}/${x.input}/${x.cache_read}/${x.cache_write}/${x.output}/${x.reasoning}`;
        return [
          m.raw_model,
          m.resolved_model ?? "—",
          m.match_kind,
          p,
          mult,
          formatVisualUsd(m.list_cost_usd),
          formatVisualUsd(m.adjusted_cost_usd),
        ];
      });
      lines.push(...renderUsageTable(headers, rows));
    }
  }

  return `${lines.join("\n")}\n`;
}
