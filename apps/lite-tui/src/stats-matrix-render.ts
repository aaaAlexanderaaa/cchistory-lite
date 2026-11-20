/**
 * Role: Pure ANSI renderer for the Lite TUI Statistics Matrix view (`v`), with switchable
 * dimension groupings (`g`), unclipped time formatting, full token/efficiency/multiplier/cost
 * columns, narrow-screen column paging (`←/→`), and a pinned 2-line selected-row inspector.
 * Excludes matrix aggregation (canonical) and stats state transitions (stats-state.ts).
 */

import type { UsageMatrixRow, UsageStatsDimension, UsageTimeBucket } from "@cchistory/domain";
import {
  activeItem,
  activeSectionTitle,
  cursor as cursorColor,
  cyan,
  dim,
  green,
  muted,
  yellow,
} from "./colors.js";
import { viewportWindow } from "./render.js";
import type {
  LiteStatsMatrixGroup,
  LiteStatsResolvedViewData,
  LiteStatsState,
} from "./stats-state.js";
import {
  formatTuiMultiplier,
  formatTuiTimeLabel,
  formatTuiUsd,
  padRightTui,
  renderTuiCacheHit,
} from "./stats-visuals.js";
import { clipLine, compact, formatCompactCount, padLine } from "./text.js";

function timeBucketLabel(bucket: UsageTimeBucket): string {
  return bucket === "hour_of_day" ? "Hour(0-23)" : bucket[0]!.toUpperCase() + bucket.slice(1);
}

function matrixGroupTitle(group: LiteStatsMatrixGroup, bucket: UsageTimeBucket): string {
  const t = timeBucketLabel(bucket);
  switch (group) {
    case "project_model":
      return "Project × Model";
    case "model_time":
      return `Model × ${t}`;
    case "project_time":
      return `Project × ${t}`;
    case "all_4":
      return `All 4 · ${t}`;
  }
}

function shortSortLabel(sortBy: LiteStatsState["sortBy"]): string {
  switch (sortBy) {
    case "adjusted_cost":
      return "adj$";
    case "list_cost":
      return "list$";
    case "tokens":
      return "tok";
    default:
      return sortBy;
  }
}

function timeColWidth(bucket: UsageTimeBucket): number {
  switch (bucket) {
    case "hour":
      return 11; // "11-19 22:00"
    case "hour_of_day":
      return 6; // "22:00"
    case "week":
      return 12; // "11-10..11-16"
    case "month":
      return 7; // "2026-11"
    case "day":
      return 10; // "2026-11-19"
  }
}

function formatMatrixDimValue(
  dimName: UsageStatsDimension,
  raw: string,
  bucket: UsageTimeBucket,
): string {
  if (dimName === "hour" || dimName === "hour_of_day" || dimName === "day" || dimName === "week" || dimName === "month") {
    return formatTuiTimeLabel(raw, bucket);
  }
  if (dimName === "source") {
    // Prefer compact slot label inside table while full name stays in Selected Inspector
    const slotMatch = /\(([^)]+)\)\s*$/u.exec(raw);
    return slotMatch ? slotMatch[1]! : raw;
  }
  return raw;
}

interface DimColumnSpec {
  index: number;
  dim: UsageStatsDimension;
  title: string;
  width: number;
}

function computeDimColumns(
  dimensions: readonly UsageStatsDimension[],
  bucket: UsageTimeBucket,
  dimBudget: number,
): DimColumnSpec[] {
  const specs: DimColumnSpec[] = dimensions.map((d, index) => {
    const isTime = d === "hour" || d === "hour_of_day" || d === "day" || d === "week" || d === "month";
    return {
      index,
      dim: d,
      title: isTime ? timeBucketLabel(bucket) : d === "source" ? "Src" : d[0]!.toUpperCase() + d.slice(1),
      width: isTime ? Math.max(timeColWidth(bucket), 6) : d === "source" ? 8 : 14,
    };
  });
  const spaces = Math.max(0, specs.length - 1);
  const available = Math.max(12, dimBudget - spaces);

  // Protect time and source minimum widths; distribute extra (or absorb squeeze) across project/model.
  const fixedMask = specs.map((s) => s.dim !== "project" && s.dim !== "model");
  const fixedTotal = specs.reduce((sum, s, i) => sum + (fixedMask[i] ? s.width : 0), 0);
  const flexSpecs = specs.filter((_, i) => !fixedMask[i]);
  if (flexSpecs.length > 0) {
    const flexAvail = Math.max(flexSpecs.length * 8, available - fixedTotal);
    if (flexSpecs.length === 1) {
      flexSpecs[0]!.width = flexAvail;
    } else {
      const projW = Math.max(8, Math.floor(flexAvail * 0.42));
      const modelW = Math.max(10, flexAvail - projW);
      flexSpecs[0]!.width = projW;
      flexSpecs[1]!.width = modelW;
    }
  }
  return specs;
}

function renderSelectedRowInspector(
  row: UsageMatrixRow,
  dimensions: readonly UsageStatsDimension[],
  width: number,
): string[] {
  const fullLabels = row.labels.map((label, i) => {
    const d = dimensions[i];
    const prefix = d === "hour_of_day" ? "Clock " : "";
    return `${prefix}${label}`;
  });
  const line1 = clipLine(
    `  ${cyan("Selected:")} ${fullLabels.join(" · ")} ${dim(`(${row.turn_count} turns · ${row.usage_event_count} calls)`)}`,
    width,
  );
  const inStr = formatCompactCount(row.total_input_tokens) || "0";
  const crStr = formatCompactCount(row.total_cache_read_input_tokens) || "0";
  const cwStr = formatCompactCount(row.total_cache_creation_input_tokens) || "0";
  const outStr = formatCompactCount(row.total_output_tokens) || "0";
  const rPart = row.total_reasoning_output_tokens > 0
    ? ` (R ${formatCompactCount(row.total_reasoning_output_tokens)})`
    : "";
  const hitStr = renderTuiCacheHit(row.efficiency?.cache_hit_ratio ?? null, false);
  const multStr = formatTuiMultiplier(row.efficiency?.effective_multiplier);
  const listStr = formatTuiUsd(row.cost.list_cost_usd);
  const adjStr = formatTuiUsd(row.cost.adjusted_cost_usd);
  const costSummary =
    listStr !== adjStr
      ? `List ${green(listStr)} -> Adj ${yellow(adjStr)}`
      : `List ${green(listStr)} · Adj ${yellow(adjStr)}`;
  const line2 = clipLine(
    `  In ${inStr} · CR ${crStr} · CW ${cwStr} · Out ${outStr}${rPart} · Hit ${hitStr} · Mult ${multStr} · ${costSummary}`,
    width,
  );
  return [dim("─".repeat(Math.max(10, width))), line1, line2];
}

export function renderMatrixView(
  data: LiteStatsResolvedViewData,
  stats: LiteStatsState,
  width: number,
  budget: number,
): string[] {
  const rows = data.matrixRows;
  const dimensions = data.breakdown.matrix?.dimensions ?? ["project", "model"];
  const isFourAxis = stats.matrixGroup === "all_4";
  const showAllNumeric = isFourAxis ? width >= 118 : width >= 92;
  const numericPage: "all" | "tokens" | "cost" = showAllNumeric
    ? "all"
    : stats.matrixColPage === 0
      ? "tokens"
      : "cost";

  // Numeric column block widths (exact sum including 1-col separators):
  // all:    In(7) CR(7) CW(6) Out(7) Hit(5) Mult(5) List$(8) Adj$(8) = 60 cols
  // tokens: In(7) CR(7) CW(6) Out(7) Adj$(8)                        = 39 cols
  // cost:   Turns(5) Tok(7) Hit(5) Mult(5) List$(8) Adj$(8)         = 43 cols
  const numericW = numericPage === "all" ? 60 : numericPage === "tokens" ? 39 : 43;
  const dimBudget = Math.max(16, width - 2 - numericW - 1);
  const dimCols = computeDimColumns(dimensions, stats.timeBucket, dimBudget);

  const pageTag =
    numericPage === "all"
      ? ""
      : numericPage === "tokens"
        ? ` · ${cyan("←/→ [Tokens]")}${dim("|Cost")}`
        : ` · ${dim("←/→ Tokens|")}${cyan("[Cost]")}`;
  const groupTitle = matrixGroupTitle(stats.matrixGroup, stats.timeBucket);
  const lines: string[] = [
    clipLine(
      `${activeSectionTitle(`▸ Matrix [g: ${groupTitle}]`)}  ${dim(
        `${rows.length} rows · o:${shortSortLabel(stats.sortBy)}${pageTag ? "" : " · v back"}`,
      )}${pageTag}`,
      width,
    ),
  ];

  const numericHeaders =
    numericPage === "all"
      ? [
          "In".padStart(7),
          "CR".padStart(7),
          "CW".padStart(6),
          "Out".padStart(7),
          "Hit".padStart(5),
          "Mult".padStart(5),
          "List$".padStart(8),
          "Adj$".padStart(8),
        ]
      : numericPage === "tokens"
        ? [
            "In".padStart(7),
            "CR".padStart(7),
            "CW".padStart(6),
            "Out".padStart(7),
            "Adj$".padStart(8),
          ]
        : [
            "Turns".padStart(5),
            "Tok".padStart(7),
            "Hit".padStart(5),
            "Mult".padStart(5),
            "List$".padStart(8),
            "Adj$".padStart(8),
          ];

  const dimHeaderStr = dimCols.map((c) => padLine(c.title, c.width)).join(" ");
  lines.push(dim(clipLine(`  ${dimHeaderStr} ${numericHeaders.join(" ")}`, width)));

  if (rows.length === 0) {
    lines.push(`  ${muted("(no matrix rows match active filters)")}`);
    return lines;
  }

  const showInspector = budget >= 7;
  const inspectorLines = showInspector ? 3 : 0;
  const bodyH = Math.max(1, budget - lines.length - inspectorLines);
  const cursorIdx = Math.min(stats.cursors.matrix, rows.length - 1);
  const win = viewportWindow(rows.length, cursorIdx, bodyH);

  for (let idx = win.start; idx < win.end; idx += 1) {
    const r = rows[idx]!;
    const isCursor = idx === cursorIdx;
    const prefix = isCursor ? cursorColor("❯") : dim("·");
    const dimCells = dimCols.map((c) => {
      const formatted = formatMatrixDimValue(c.dim, r.labels[c.index] ?? "-", stats.timeBucket);
      return padLine(compact(formatted, c.width), c.width);
    });
    const inStr = formatCompactCount(r.total_input_tokens) || "0";
    const crStr = formatCompactCount(r.total_cache_read_input_tokens) || "0";
    const cwStr = formatCompactCount(r.total_cache_creation_input_tokens) || "0";
    const outStr = formatCompactCount(r.total_output_tokens) || "0";
    const tokStr = formatCompactCount(r.total_tokens) || "0";
    const hitCell = padRightTui(renderTuiCacheHit(r.efficiency?.cache_hit_ratio ?? null, true), 5);
    const multCell = padRightTui(formatTuiMultiplier(r.efficiency?.effective_multiplier), 5);
    const listStr = formatTuiUsd(r.cost.list_cost_usd);
    const adjStr = formatTuiUsd(r.cost.adjusted_cost_usd);

    const numCells =
      numericPage === "all"
        ? [
            padRightTui(inStr, 7),
            padRightTui(crStr, 7),
            padRightTui(cwStr, 6),
            padRightTui(outStr, 7),
            isCursor ? padRightTui(r.efficiency?.cache_hit_ratio !== null && r.efficiency?.cache_hit_ratio !== undefined ? `${Math.round(r.efficiency.cache_hit_ratio * 100)}%` : "—", 5) : hitCell,
            multCell,
            padRightTui(listStr, 8),
            padRightTui(adjStr, 8),
          ]
        : numericPage === "tokens"
          ? [
              padRightTui(inStr, 7),
              padRightTui(crStr, 7),
              padRightTui(cwStr, 6),
              padRightTui(outStr, 7),
              padRightTui(adjStr, 8),
            ]
          : [
              padRightTui(String(r.turn_count), 5),
              padRightTui(tokStr, 7),
              isCursor ? padRightTui(r.efficiency?.cache_hit_ratio !== null && r.efficiency?.cache_hit_ratio !== undefined ? `${Math.round(r.efficiency.cache_hit_ratio * 100)}%` : "—", 5) : hitCell,
              multCell,
              padRightTui(listStr, 8),
              padRightTui(adjStr, 8),
            ];

    const body = `${dimCells.join(" ")} ${numCells.join(" ")}`;
    lines.push(clipLine(`${prefix} ${isCursor ? activeItem(body) : body}`, width));
  }

  if (showInspector) {
    while (lines.length < budget - inspectorLines) lines.push("");
    const selected = rows[cursorIdx];
    if (selected) {
      lines.push(...renderSelectedRowInspector(selected, dimensions, width));
    }
  }
  return lines.slice(0, budget);
}
