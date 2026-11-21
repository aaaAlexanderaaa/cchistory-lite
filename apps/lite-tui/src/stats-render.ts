/**
 * Role: Pure ANSI frame renderer for the Lite TUI Plan A statistics dashboard
 * (`2×2` cross-filter quadrants, `v` matrix table, and `m` multiplier calibration view).
 * Excludes stats reducer logic (stats-state.ts) and core usage math (canonical).
 */

import type { ModelPricingResolution, UsageCostBreakdown, UsageStatsRollupRow } from "@cchistory/domain";
import { buildDenseTimeSeries } from "@cchistory/live-runtime";
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
  sectionTitle,
  selectedItem,
  warning,
  yellow,
} from "./colors.js";
import type { LiteBrowserModel } from "./model.js";
import { viewportWindow } from "./render.js";
import type { LiteBrowserState } from "./state.js";
import { renderAnomaliesView } from "./stats-anomalies-render.js";
import { renderMatrixView } from "./stats-matrix-render.js";
import { renderTraceView } from "./stats-trace-render.js";
import {
  STATS_MULTIPLIER_COLUMNS,
  activeFilterSelection,
  hasActiveStatsFilters,
  resolveStatsViewData,
  type LiteStatsQuadrant,
  type LiteStatsResolvedViewData,
  type LiteStatsState,
} from "./stats-state.js";
import {
  formatTuiTimeLabel,
  renderTopSessionsView,
  renderTuiCacheHit,
  renderTuiDiagnosticsBar,
  renderTuiFractionalBar,
  renderTuiQuotaGauge,
  renderTuiSparkline,
} from "./stats-visuals.js";
import {
  clipLine,
  compact,
  displayWidth,
  formatCompactCount,
  padLine,
} from "./text.js";

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatMultCell(value: number): string {
  const s = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
  return `${s}x`;
}

function formatQuotaLabel(cost: UsageCostBreakdown | undefined): string {
  if (!cost || cost.quota_limit_usd === undefined || cost.quota_percent === undefined) return "";
  return `Quota ${cost.quota_percent.toFixed(1)}%/$${cost.quota_limit_usd.toFixed(0)}`;
}

function padRight(text: string, width: number): string {
  const clipped = clipLine(text, width);
  const gap = Math.max(0, width - displayWidth(clipped));
  return `${" ".repeat(gap)}${clipped}`;
}

export function renderStatsDashboard(
  model: LiteBrowserModel,
  state: LiteBrowserState,
  width: number,
  contentHeight: number,
  now: number,
): string[] {
  const stats = state.stats;
  const data = resolveStatsViewData(model, stats, now);
  const lines: string[] = [];

  lines.push(renderHeaderLine(stats, data, width));
  lines.push(dim("─".repeat(Math.max(10, width))));
  if (stats.view !== "trace") {
    lines.push(renderTotalsBar(data, width));
    if (contentHeight >= 15) {
      const diagLine = renderTuiDiagnosticsBar(data, width);
      if (diagLine) lines.push(diagLine);
    }
    lines.push(renderFilterOrEditBar(data, stats, width));
  }

  const reserveLegend = contentHeight >= 10;
  const bodyBudget = Math.max(4, contentHeight - lines.length - (reserveLegend ? 1 : 0));
  if (stats.view === "matrix") {
    lines.push(...renderMatrixView(data, stats, width, bodyBudget));
  } else if (stats.view === "sessions") {
    lines.push(...renderTopSessionsView(data, stats, width, bodyBudget));
  } else if (stats.view === "anomalies") {
    lines.push(...renderAnomaliesView(data, stats, width, bodyBudget));
  } else if (stats.view === "trace") {
    lines.push(...renderTraceView(data, stats, width, bodyBudget));
  } else if (stats.view === "multipliers") {
    lines.push(...renderMultipliersView(data, stats, width, bodyBudget));
  } else {
    lines.push(...renderQuadDashboard(data, stats, width, bodyBudget));
  }
  if (reserveLegend) {
    while (lines.length < contentHeight - 1) lines.push("");
    lines.splice(contentHeight - 1);
    lines.push(renderAbbrevLegendLine(width));
  }
  return lines.slice(0, contentHeight);
}

function renderAbbrevLegendLine(width: number): string {
  const text =
    width >= 106
      ? "  Legend: In=Input · CR=CacheRead · CW=CacheWrite · Out=Output · Reas=Reasoning · Hit=CacheHit · List/Adj=List/Adjusted$"
      : width >= 76
        ? "  In=Input · CR=CacheRead · CW=CacheWrite · Out=Output · Reas=Reasoning · Hit=CacheHit · Adj=Adjusted$"
        : "  In=Input CR=CacheR CW=CacheW Out=Out Reas=Reasoning Hit=CacheHit";
  return dim(clipLine(text, width));
}

function renderHeaderLine(stats: LiteStatsState, data: LiteStatsResolvedViewData, width: number): string {
  const quadTab = stats.view === "quad" ? bold(cyan("[Quad]")) : dim("Quad");
  const matrixTab = stats.view === "matrix" ? bold(cyan("[v:Matrix]")) : dim("v:Matrix");
  const sessionsTab = stats.view === "sessions" ? bold(cyan("[S:Sessions]")) : dim("S:Sessions");
  const anomCount = data.anomalies.length;
  const anomText = anomCount > 0 ? `a:Anom(${anomCount})` : "a:Anom";
  const anomTab =
    stats.view === "anomalies"
      ? bold(cyan(`[${anomText}]`))
      : anomCount > 0
        ? yellow(anomText)
        : dim(anomText);
  const traceTab = stats.view === "trace" ? ` ${bold(cyan("[Trace]"))}` : "";
  const multTab = stats.view === "multipliers" ? bold(cyan("[m:Calibrate]")) : dim("m:Calibrate");
  const timeBadge = yellow(`t:${stats.timePreset}`);
  const bucketBadge = green(`b:${stats.timeBucket}`);
  const weekBadge = dim(`w:${stats.weekMode}`);
  const sortBadge = dim(`o:${stats.sortBy}`);
  const head = `${activeSectionTitle("▸ Statistics")}  ${quadTab} ${matrixTab} ${sessionsTab} ${anomTab}${traceTab} ${multTab}  ${timeBadge} ${bucketBadge}`;
  const tail = width >= 116 ? ` ${weekBadge} ${sortBadge}  ${dim("(i/Esc close)")}` : ` ${dim("(i close)")}`;
  return clipLine(`${head}${tail}`, width);
}

function renderTotalsBar(data: LiteStatsResolvedViewData, width: number): string {
  const ov = data.breakdown.overview;
  const cost = ov.cost;
  const compactTok = width < 100;
  const tokParts = [
    `Tot ${cyan(formatCompactCount(ov.total_tokens) || "0")}`,
    `In ${formatCompactCount(ov.total_input_tokens) || "0"}`,
    `CR ${formatCompactCount(ov.total_cache_read_input_tokens ?? 0) || "0"}`,
    ...(!compactTok ? [`CW ${formatCompactCount(ov.total_cache_creation_input_tokens ?? 0) || "0"}`] : []),
    `Out ${formatCompactCount(ov.total_output_tokens) || "0"}`,
    ...(!compactTok && ov.total_reasoning_output_tokens > 0
      ? [`Reas ${formatCompactCount(ov.total_reasoning_output_tokens)}`]
      : []),
  ];
  const costParts = [
    `List ${green(formatUsd(cost?.list_cost_usd ?? 0))}`,
    `Adj ${yellow(formatUsd(cost?.adjusted_cost_usd ?? 0))}`,
    ...(!compactTok || cost?.quota_limit_usd === undefined
      ? [renderTuiQuotaGauge(cost, data.breakdown.quota_pace, width >= 110 ? 8 : 5)]
      : []),
  ];
  return clipLine(`  ${tokParts.join(" · ")}  │  ${costParts.join(" · ")}`, width);
}

function renderFilterOrEditBar(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
): string {
  if (stats.editing) {
    const label =
      stats.editing.target === "export_path"
        ? "Export pricing JSON"
        : stats.editing.target === "alias"
          ? `Alias ${stats.editing.rawModel}`
          : stats.editing.target === "quota"
            ? "Quota USD"
            : `${stats.editing.rawModel} ${stats.editing.col}x`;
    const nowHint =
      stats.editing.placeholder && stats.editing.target !== "export_path"
        ? dim(` (now ${stats.editing.placeholder})`)
        : "";
    return clipLine(
      `  ${bold(cyan(`${label}${nowHint} ->`))} ${stats.editing.value}${cursorColor("_")}  ${dim("(Enter save · Esc cancel)")}`,
      width,
    );
  }

  const chips: string[] = [];
  if (stats.filters.projectIds.length > 0) chips.push(`P:${stats.filters.projectIds.length}`);
  if (stats.filters.models.length > 0) chips.push(`M:${stats.filters.models.join(",")}`);
  if (stats.filters.sourceIds.length > 0) chips.push(`S:${stats.filters.sourceIds.length}`);
  if (stats.filters.timeKeys.length > 0) chips.push(`T:${stats.filters.timeKeys.join(",")}`);
  if (stats.timePreset !== "all") chips.push(`Win:${stats.timePreset}`);

  const unpriced = data.breakdown.overview.cost?.unpriced_models ?? [];
  if (hasActiveStatsFilters(stats)) {
    const hint = dim(" (Space toggle · c clear · S sessions · a anom · v matrix · m calibrate · E export)");
    return clipLine(`  ${cyan(`Filters: ${chips.join(" · ")}`)}${hint}`, width);
  }
  if (unpriced.length > 0) {
    return clipLine(
      `  ${warning(`Unpriced models (${unpriced.length}): ${unpriced.slice(0, 3).join(", ")}`)}  ${dim("press m to set alias/price · E export")}`,
      width,
    );
  }
  return clipLine(
    dim("  Tab/1-4 quadrant · Space filter · S sessions · a anomalies · v matrix · m calibrate · E export · t/b window"),
    width,
  );
}

function renderQuadDashboard(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
  budget: number,
): string[] {
  const twoCol = width >= 84 && budget >= 9;
  if (!twoCol) {
    return renderStackedQuads(data, stats, width, budget);
  }

  const leftW = Math.floor((width - 3) / 2);
  const rightW = width - leftW - 3;
  const topH = Math.max(4, Math.floor((budget - 1) / 2));
  const bottomH = Math.max(4, budget - topH - 1);

  const tl = renderQuadrantBox("project", "By project", data.quadrantRows.project, stats, leftW, topH);
  const tr = renderQuadrantBox("model", "By model", data.quadrantRows.model, stats, rightW, topH);
  const bl = renderQuadrantBox("source", "By source", data.quadrantRows.source, stats, leftW, bottomH);
  const timeTitle = stats.timeBucket === "hour_of_day" ? "By hour (00-23)" : `By ${stats.timeBucket}`;
  const timeSpark = buildTimeSparkBadge(data, stats);
  const br = renderQuadrantBox("day", timeTitle, data.quadrantRows.day, stats, rightW, bottomH, timeSpark);

  const lines: string[] = [];
  for (let i = 0; i < topH; i += 1) {
    lines.push(`${padLine(tl[i] ?? "", leftW)} ${dim("│")} ${padLine(tr[i] ?? "", rightW)}`);
  }
  lines.push(dim(`${"─".repeat(leftW)}─┼─${"─".repeat(Math.max(1, rightW))}`));
  for (let i = 0; i < bottomH; i += 1) {
    lines.push(`${padLine(bl[i] ?? "", leftW)} ${dim("│")} ${padLine(br[i] ?? "", rightW)}`);
  }
  return lines;
}

function renderStackedQuads(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
  budget: number,
): string[] {
  const timeTitle = stats.timeBucket === "hour_of_day" ? "By hour (00-23)" : `By ${stats.timeBucket}`;
  const order: Array<{ q: LiteStatsQuadrant; title: string; suffix?: string }> = [
    { q: "project", title: "By project" },
    { q: "model", title: "By model" },
    { q: "source", title: "By source" },
    { q: "day", title: timeTitle, suffix: buildTimeSparkBadge(data, stats) },
  ];
  const eachH = Math.max(3, Math.floor(budget / 4));
  const lines: string[] = [];
  for (let i = 0; i < order.length; i += 1) {
    const item = order[i]!;
    const h = i === order.length - 1 ? Math.max(2, budget - lines.length) : Math.min(eachH, budget - lines.length);
    if (h <= 0) break;
    lines.push(...renderQuadrantBox(item.q, item.title, data.quadrantRows[item.q], stats, width, h, item.suffix ?? ""));
  }
  return lines;
}

function buildTimeSparkBadge(data: LiteStatsResolvedViewData, stats: LiteStatsState): string {
  const dense = buildDenseTimeSeries(data.breakdown.by_time.rows, stats.timeBucket, {
    timezone: data.breakdown.timezone,
    maxPoints: 24,
  });
  if (dense.length < 2) return "";
  const useCost = dense.some((pt) => pt.adjusted_cost_usd > 0);
  const values = dense.map((pt) => (useCost ? pt.adjusted_cost_usd : pt.total_tokens));
  const spark = renderTuiSparkline(values, { zeroChar: "·", activeStyle: cyan, zeroStyle: dim });
  return spark ? `  ${spark}` : "";
}

function renderQuadrantBox(
  quadrant: LiteStatsQuadrant,
  title: string,
  rows: readonly UsageStatsRollupRow[],
  stats: LiteStatsState,
  width: number,
  height: number,
  extraTitleSuffix = "",
): string[] {
  const focused = stats.activeQuadrant === quadrant && stats.view === "quad";
  const selectedKeys = new Set(activeFilterSelection(stats, quadrant));
  const badge = selectedKeys.size > 0 ? ` ${cyan(`[${selectedKeys.size} on]`)}` : "";
  const countTag = dim(` (${rows.length})`);
  const headingLine = focused
    ? `${activeSectionTitle(`▸ ${title}`)}${countTag}${badge}${extraTitleSuffix}`
    : `${sectionTitle(`  ${title}`)}${countTag}${badge}${extraTitleSuffix}`;

  const result: string[] = [clipLine(headingLine, width)];
  if (rows.length === 0) {
    result.push(clipLine(`  ${muted("(no matching usage rows)")}`, width));
    while (result.length < height) result.push("");
    return result;
  }

  // Compute strict fixed column widths once so every single row aligns to exact terminal columns.
  const prefixW = 2 + (selectedKeys.size > 0 ? 4 : 0);
  const showHit = quadrant === "day" ? width >= 48 : width >= 54;
  const hitW = showHit ? 5 : 0;
  const costW = 8;
  const tokW = 6;
  const barW = width >= 68 ? 12 : width >= 54 ? 10 : width >= 44 ? 8 : 0;
  const rightW = (barW > 0 ? barW + 1 : 0) + tokW + 1 + costW + (showHit ? 1 + hitW : 0);
  const nameW = Math.max(8, width - prefixW - rightW - 1);

  const showColHeader = height >= 5;
  if (showColHeader) {
    const hdrName = padLine(quadrant === "day" ? "Time" : "Name", nameW);
    const hdrBar = barW > 0 ? `${padLine("Bar (max)", barW)} ` : "";
    const hdrTok = padRight("Tok", tokW);
    const hdrCost = padRight("Adj$", costW);
    const hdrHit = showHit ? ` ${padRight("Hit", hitW)}` : "";
    result.push(dim(clipLine(`${" ".repeat(prefixW)}${hdrName} ${hdrBar}${hdrTok} ${hdrCost}${hdrHit}`, width)));
  }

  const totalCost = rows.reduce((sum, r) => sum + (r.cost?.adjusted_cost_usd ?? 0), 0);
  const useCost = totalCost > 0;
  const maxVal = rows.reduce(
    (best, r) => Math.max(best, useCost ? (r.cost?.adjusted_cost_usd ?? 0) : r.total_tokens),
    0,
  );

  const bodyH = Math.max(1, height - result.length);
  const cursorIdx = Math.min(stats.cursors[quadrant], Math.max(0, rows.length - 1));
  const win = viewportWindow(rows.length, cursorIdx, bodyH);
  for (let idx = win.start; idx < win.end; idx += 1) {
    const row = rows[idx]!;
    const isCursor = focused && idx === cursorIdx;
    const isChecked = selectedKeys.has(row.key);
    const pointer = isCursor ? cursorColor("❯") : isChecked ? bold("▪") : dim("·");
    const check = selectedKeys.size > 0 ? (isChecked ? cyan("[x] ") : dim("[ ] ")) : "";

    const adjVal = row.cost?.adjusted_cost_usd ?? 0;
    const listVal = row.cost?.list_cost_usd ?? 0;
    const adjStr = formatUsd(adjVal);
    const adjustedDiffers = Math.abs(adjVal - listVal) > 1e-6;
    const tokStr = formatCompactCount(row.total_tokens) || "0";
    const metricVal = useCost ? adjVal : row.total_tokens;
    const barRatio = maxVal > 0 ? metricVal / maxVal : 0;
    const barCell = barW > 0 ? `${renderTuiFractionalBar(barRatio, barW, cyan)} ` : "";
    const tokCell = row.total_tokens === 0 ? dim(padRight(tokStr, tokW)) : padRight(tokStr, tokW);
    const costRaw = padRight(adjStr, costW);
    const costCell =
      adjVal === 0 && row.total_tokens === 0
        ? dim(costRaw)
        : adjustedDiffers
          ? yellow(costRaw)
          : costRaw;
    const hitCell = showHit
      ? ` ${padRight(renderTuiCacheHit(row.efficiency?.cache_hit_ratio ?? null, true), hitW)}`
      : "";

    const displayLabel =
      quadrant === "day" ? formatTuiTimeLabel(row.label, stats.timeBucket) : row.label;
    const rawLabel = padLine(compact(displayLabel, nameW), nameW);
    const styledLabel = isCursor
      ? activeItem(rawLabel)
      : isChecked
        ? selectedItem(rawLabel)
        : row.total_tokens === 0 && quadrant === "day"
          ? dim(rawLabel)
          : rawLabel;

    result.push(
      clipLine(`${pointer} ${check}${styledLabel} ${barCell}${tokCell} ${costCell}${hitCell}`, width),
    );
  }
  while (result.length < height) result.push("");
  return result.slice(0, height);
}

function renderMultipliersView(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
  budget: number,
): string[] {
  const rows = data.modelResolutions;
  const activeCol = STATS_MULTIPLIER_COLUMNS[stats.multiplierColIndex] ?? "model";
  const quotaStr = formatQuotaLabel(data.breakdown.overview.cost);
  const lines: string[] = [
    clipLine(
      `${activeSectionTitle("▸ Calibrate Multipliers & Aliases")}  ${dim(`col:${activeCol}`)}${quotaStr ? `  ${cyan(quotaStr)}` : ""}`,
      width,
    ),
    clipLine(
      dim("  ←/→ cell · +/- step · 0/1/u set · a alias · e edit · $ quota · E export · R reset · m/Esc back"),
      width,
    ),
  ];

  const wide = width >= 106;
  const header = wide
    ? `  ${"Model".padEnd(20)} ${"Catalog".padEnd(16)} ${"$/1M In/CR".padEnd(11)} ${"M×".padStart(6)} ${"In×".padStart(6)} ${"CR×".padStart(6)} ${"CW×".padStart(6)} ${"Out×".padStart(6)} ${"R×".padStart(6)} ${"List$".padStart(7)} ${"Adj$".padStart(7)}`
    : `  ${"Model".padEnd(16)} ${"Catalog".padEnd(12)} ${"M×".padStart(5)} ${"In×".padStart(5)} ${"CR×".padStart(5)} ${"CW×".padStart(5)} ${"Out×".padStart(5)} ${"R×".padStart(5)} ${"Adj$".padStart(7)}`;
  lines.push(dim(clipLine(header, width)));

  if (rows.length === 0) {
    lines.push(`  ${muted("(no models in active window)")}`);
    return lines;
  }

  const bodyH = Math.max(1, budget - lines.length);
  const cursorIdx = Math.min(stats.cursors.multipliers, rows.length - 1);
  const win = viewportWindow(rows.length, cursorIdx, bodyH);
  for (let idx = win.start; idx < win.end; idx += 1) {
    const m: ModelPricingResolution = rows[idx]!;
    const isRow = idx === cursorIdx;
    const prefix = isRow ? cursorColor("❯") : dim("·");
    const cellW = wide ? 6 : 5;
    const multCells = STATS_MULTIPLIER_COLUMNS.map((col, colIdx) => {
      const txt = formatMultCell(m.multipliers[col]);
      if (isRow && colIdx === stats.multiplierColIndex) {
        return bold(cyan(`[${txt}]`.padStart(cellW)));
      }
      return padRight(txt, cellW);
    });
    const catalogLabel =
      m.match_kind === "unpriced"
        ? danger("(unpriced)")
        : m.resolved_model ?? m.raw_model;
    const priceTag = m.unit_prices
      ? `${m.unit_prices.input}/${m.unit_prices.cache_read ?? "-"}`
      : "—";

    const rowParts = wide
      ? [
          padLine(compact(m.raw_model, 20), 20),
          padLine(compact(catalogLabel, 16), 16),
          padLine(compact(priceTag, 11), 11),
          ...multCells,
          padRight(formatUsd(m.list_cost_usd), 7),
          padRight(formatUsd(m.adjusted_cost_usd), 7),
        ]
      : [
          padLine(compact(m.raw_model, 16), 16),
          padLine(compact(catalogLabel, 12), 12),
          ...multCells,
          padRight(formatUsd(m.adjusted_cost_usd), 7),
        ];
    const linePrefix = isRow ? activeItem(rowParts[0]!) : rowParts[0]!;
    lines.push(clipLine(`${prefix} ${[linePrefix, ...rowParts.slice(1)].join(" ")}`, width));
  }
  return lines;
}
