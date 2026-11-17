/**
 * Role: Pure ANSI frame renderer for the Lite TUI Plan A statistics dashboard
 * (`2×2` cross-filter quadrants, `v` matrix table, and `m` multiplier calibration view).
 * Excludes stats reducer logic (stats-state.ts) and core usage math (canonical).
 */

import type { ModelPricingResolution, UsageCostBreakdown, UsageStatsRollupRow } from "@cchistory/domain";
import {
  activeItem,
  activeSectionTitle,
  bold,
  cursor as cursorColor,
  cyan,
  danger,
  dim,
  green,
  metaLabel,
  muted,
  sectionTitle,
  selectedItem,
  warning,
  yellow,
} from "./colors.js";
import type { LiteBrowserModel } from "./model.js";
import { viewportWindow } from "./render.js";
import type { LiteBrowserState } from "./state.js";
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

  lines.push(renderHeaderLine(stats, width));
  lines.push(dim("─".repeat(Math.max(10, width))));
  lines.push(renderTotalsBar(data, width));
  lines.push(renderFilterOrEditBar(data, stats, width));

  const bodyBudget = Math.max(4, contentHeight - lines.length);
  if (stats.view === "matrix") {
    lines.push(...renderMatrixView(data, stats, width, bodyBudget));
  } else if (stats.view === "multipliers") {
    lines.push(...renderMultipliersView(data, stats, width, bodyBudget));
  } else {
    lines.push(...renderQuadDashboard(data, stats, width, bodyBudget));
  }
  return lines.slice(0, contentHeight);
}

function renderHeaderLine(stats: LiteStatsState, width: number): string {
  const quadTab = stats.view === "quad" ? bold(cyan("[1:Quad]")) : dim("1:Quad");
  const matrixTab = stats.view === "matrix" ? bold(cyan("[2:Matrix(v)]")) : dim("v:Matrix");
  const multTab = stats.view === "multipliers" ? bold(cyan("[3:Calibrate(m)]")) : dim("m:Calibrate");
  const timeBadge = yellow(`t:${stats.timePreset}`);
  const bucketBadge = green(`b:${stats.timeBucket}`);
  const weekBadge = dim(`w:${stats.weekMode}`);
  const sortBadge = dim(`o:${stats.sortBy}`);
  const head = `${activeSectionTitle("▸ Statistics")}  ${quadTab} ${matrixTab} ${multTab}  ${timeBadge} ${bucketBadge}`;
  const tail = width >= 96 ? ` ${weekBadge} ${sortBadge}  ${dim("(i/Esc close)")}` : ` ${dim("(i close)")}`;
  return clipLine(`${head}${tail}`, width);
}

function renderTotalsBar(data: LiteStatsResolvedViewData, width: number): string {
  const ov = data.breakdown.overview;
  const cost = ov.cost;
  const tokParts = [
    `Tot ${cyan(formatCompactCount(ov.total_tokens) || "0")}`,
    `In ${formatCompactCount(ov.total_input_tokens) || "0"}`,
    `CR ${formatCompactCount(ov.total_cache_read_input_tokens ?? 0) || "0"}`,
    `CW ${formatCompactCount(ov.total_cache_creation_input_tokens ?? 0) || "0"}`,
    `Out ${formatCompactCount(ov.total_output_tokens) || "0"}`,
    ov.total_reasoning_output_tokens > 0 ? `R ${formatCompactCount(ov.total_reasoning_output_tokens)}` : undefined,
  ].filter(Boolean);
  const costParts = [
    `List ${green(formatUsd(cost?.list_cost_usd ?? 0))}`,
    `Adj ${yellow(formatUsd(cost?.adjusted_cost_usd ?? 0))}`,
    cost?.quota_limit_usd !== undefined && cost.quota_percent !== undefined
      ? bold(cyan(`${cost.quota_percent.toFixed(1)}% of ${formatUsd(cost.quota_limit_usd)}`))
      : dim("$ quota"),
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
      stats.editing.target === "alias"
        ? `Alias ${stats.editing.rawModel}`
        : stats.editing.target === "quota"
          ? "Quota USD"
          : `${stats.editing.rawModel} ${stats.editing.col}x`;
    const nowHint = stats.editing.placeholder ? dim(` (now ${stats.editing.placeholder})`) : "";
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
    const hint = dim(" (Space toggle · c clear · v matrix · m calibrate)");
    return clipLine(`  ${cyan(`Filters: ${chips.join(" · ")}`)}${hint}`, width);
  }
  if (unpriced.length > 0) {
    return clipLine(
      `  ${warning(`Unpriced models (${unpriced.length}): ${unpriced.slice(0, 3).join(", ")}`)}  ${dim("press m to set alias/price")}`,
      width,
    );
  }
  return clipLine(
    dim("  Tab quadrant · 1-4 jump · Space/Enter filter · t window · b day/wk/mo · v matrix · m multipliers · $ quota"),
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
  const br = renderQuadrantBox("day", `By ${stats.timeBucket}`, data.quadrantRows.day, stats, rightW, bottomH);

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
  const order: Array<{ q: LiteStatsQuadrant; title: string }> = [
    { q: "project", title: "By project" },
    { q: "model", title: "By model" },
    { q: "source", title: "By source" },
    { q: "day", title: `By ${stats.timeBucket}` },
  ];
  const eachH = Math.max(3, Math.floor(budget / 4));
  const lines: string[] = [];
  for (let i = 0; i < order.length; i += 1) {
    const item = order[i]!;
    const h = i === order.length - 1 ? Math.max(2, budget - lines.length) : Math.min(eachH, budget - lines.length);
    if (h <= 0) break;
    lines.push(...renderQuadrantBox(item.q, item.title, data.quadrantRows[item.q], stats, width, h));
  }
  return lines;
}

function renderQuadrantBox(
  quadrant: LiteStatsQuadrant,
  title: string,
  rows: readonly UsageStatsRollupRow[],
  stats: LiteStatsState,
  width: number,
  height: number,
): string[] {
  const focused = stats.activeQuadrant === quadrant && stats.view === "quad";
  const selectedKeys = new Set(activeFilterSelection(stats, quadrant));
  const badge = selectedKeys.size > 0 ? ` ${cyan(`[${selectedKeys.size} on]`)}` : "";
  const countTag = dim(` (${rows.length})`);
  const headingLine = focused
    ? `${activeSectionTitle(`▸ ${title}`)}${countTag}${badge}`
    : `${sectionTitle(`  ${title}`)}${countTag}${badge}`;

  const result: string[] = [clipLine(headingLine, width)];
  const bodyH = Math.max(1, height - 1);
  if (rows.length === 0) {
    result.push(clipLine(`  ${muted("(no matching usage rows)")}`, width));
    while (result.length < height) result.push("");
    return result;
  }

  const cursorIdx = Math.min(stats.cursors[quadrant], Math.max(0, rows.length - 1));
  const win = viewportWindow(rows.length, cursorIdx, bodyH);
  for (let idx = win.start; idx < win.end; idx += 1) {
    const row = rows[idx]!;
    const isCursor = focused && idx === cursorIdx;
    const isChecked = selectedKeys.has(row.key);
    const pointer = isCursor ? cursorColor("❯") : isChecked ? bold("▪") : dim("·");
    const check = selectedKeys.size > 0 ? (isChecked ? cyan("[x] ") : dim("[ ] ")) : "";

    const adjStr = formatUsd(row.cost?.adjusted_cost_usd ?? 0);
    const listStr = formatUsd(row.cost?.list_cost_usd ?? 0);
    const tokStr = formatCompactCount(row.total_tokens) || "0";
    const rightMeta =
      width >= 50
        ? `${tokStr.padStart(6)} ${listStr === adjStr ? listStr.padStart(7) : `${listStr}→${adjStr}`}`
        : `${tokStr.padStart(6)} ${adjStr.padStart(7)}`;

    const prefixW = 2 + (selectedKeys.size > 0 ? 4 : 0);
    const metaW = displayWidth(rightMeta);
    const nameBudget = Math.max(8, width - prefixW - metaW - 2);
    const rawLabel = compact(row.label, nameBudget);
    const styledLabel = isCursor ? activeItem(rawLabel) : isChecked ? selectedItem(rawLabel) : rawLabel;
    const left = `${pointer} ${check}${styledLabel}`;
    const gap = Math.max(1, width - displayWidth(left) - metaW);
    result.push(clipLine(`${left}${" ".repeat(gap)}${metaLabel(rightMeta)}`, width));
  }
  while (result.length < height) result.push("");
  return result.slice(0, height);
}

function renderMatrixView(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
  budget: number,
): string[] {
  const rows = data.matrixRows;
  const lines: string[] = [
    clipLine(
      `${activeSectionTitle(`▸ Matrix (${["project", "model", "source", stats.timeBucket].join(" × ")})`)}  ${dim(
        `${rows.length} rows · o sort (${stats.sortBy}) · v back`,
      )}`,
      width,
    ),
  ];

  const wide = width >= 112;
  const headerLine = wide
    ? `  ${"Project".padEnd(15)} ${"Model".padEnd(18)} ${"Source".padEnd(13)} ${"Time".padEnd(10)} ${"Turns".padStart(5)} ${"In".padStart(7)} ${"CR".padStart(7)} ${"CW".padStart(6)} ${"Out".padStart(7)} ${"List$".padStart(7)} ${"Adj$".padStart(7)}`
    : `  ${"Project".padEnd(13)} ${"Model".padEnd(15)} ${"Src".padEnd(9)} ${"Time".padEnd(10)} ${"Tok".padStart(7)} ${"List$".padStart(7)} ${"Adj$".padStart(7)}`;
  lines.push(dim(clipLine(headerLine, width)));

  if (rows.length === 0) {
    lines.push(`  ${muted("(no matrix rows match active filters)")}`);
    return lines;
  }

  const bodyH = Math.max(1, budget - lines.length);
  const cursorIdx = Math.min(stats.cursors.matrix, rows.length - 1);
  const win = viewportWindow(rows.length, cursorIdx, bodyH);
  for (let idx = win.start; idx < win.end; idx += 1) {
    const r = rows[idx]!;
    const isCursor = idx === cursorIdx;
    const prefix = isCursor ? cursorColor("❯") : dim("·");
    const [p = "-", m = "-", s = "-", t = "-"] = r.labels;
    const listStr = formatUsd(r.cost.list_cost_usd);
    const adjStr = formatUsd(r.cost.adjusted_cost_usd);
    if (wide) {
      const cells = [
        padLine(compact(p, 15), 15),
        padLine(compact(m, 18), 18),
        padLine(compact(s, 13), 13),
        padLine(compact(t, 10), 10),
        padRight(String(r.turn_count), 5),
        padRight(formatCompactCount(r.total_input_tokens) || "0", 7),
        padRight(formatCompactCount(r.total_cache_read_input_tokens) || "0", 7),
        padRight(formatCompactCount(r.total_cache_creation_input_tokens) || "0", 6),
        padRight(formatCompactCount(r.total_output_tokens) || "0", 7),
        padRight(listStr, 7),
        padRight(adjStr, 7),
      ];
      const body = cells.join(" ");
      lines.push(clipLine(`${prefix} ${isCursor ? activeItem(body) : body}`, width));
    } else {
      const cells = [
        padLine(compact(p, 13), 13),
        padLine(compact(m, 15), 15),
        padLine(compact(s, 9), 9),
        padLine(compact(t, 10), 10),
        padRight(formatCompactCount(r.total_tokens) || "0", 7),
        padRight(listStr, 7),
        padRight(adjStr, 7),
      ];
      const body = cells.join(" ");
      lines.push(clipLine(`${prefix} ${isCursor ? activeItem(body) : body}`, width));
    }
  }
  return lines;
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
      dim("  ←/→ cell · +/- step · 0/1/u set · a alias · e edit value · $ quota · R reset all · m/Esc back"),
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
