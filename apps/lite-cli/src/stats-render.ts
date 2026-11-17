/**
 * Role: Human-readable tabular and cost rendering for CLI `stats` output.
 * Excludes option parsing and pricing config loading (owned by stats-command.ts).
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

function formatNum(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatQuotaPct(cost: UsageCostBreakdown | undefined): string {
  if (!cost || cost.quota_percent === undefined) return "—";
  return `${cost.quota_percent.toFixed(1)}%`;
}

function padCell(value: string, width: number, rightAlign = false): string {
  const truncated = value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;
  return rightAlign ? truncated.padStart(width, " ") : truncated.padEnd(width, " ");
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

function rollupToTableRows(rows: readonly UsageStatsRollupRow[], wide: boolean): string[][] {
  return rows.map((row) =>
    wide
      ? [
          row.label,
          String(row.turn_count),
          formatNum(row.total_input_tokens),
          formatNum(row.total_cache_read_input_tokens ?? 0),
          formatNum(row.total_cache_creation_input_tokens ?? 0),
          formatNum(row.total_output_tokens),
          formatNum(row.total_tokens),
          formatUsd(row.cost?.list_cost_usd ?? 0),
          formatUsd(row.cost?.adjusted_cost_usd ?? 0),
          formatQuotaPct(row.cost),
        ]
      : [
          row.label,
          String(row.turn_count),
          formatNum(row.total_tokens),
          formatUsd(row.cost?.list_cost_usd ?? 0),
          formatUsd(row.cost?.adjusted_cost_usd ?? 0),
          formatQuotaPct(row.cost),
        ],
  );
}

function renderRollupSection(title: string, rows: readonly UsageStatsRollupRow[], wide: boolean, limit?: number): string[] {
  const shown = limit !== undefined && rows.length > limit ? rows.slice(0, limit) : rows;
  const headers = wide
    ? [
        { title: "Name", width: 26 },
        { title: "Turns", width: 6, right: true },
        { title: "Input", width: 11, right: true },
        { title: "CacheR", width: 11, right: true },
        { title: "CacheW", width: 10, right: true },
        { title: "Output", width: 10, right: true },
        { title: "Total", width: 12, right: true },
        { title: "List$", width: 8, right: true },
        { title: "Adj$", width: 8, right: true },
        { title: "Quota", width: 7, right: true },
      ]
    : [
        { title: "Name", width: 22 },
        { title: "Turns", width: 6, right: true },
        { title: "Total", width: 11, right: true },
        { title: "List$", width: 8, right: true },
        { title: "Adj$", width: 8, right: true },
        { title: "Quota", width: 6, right: true },
      ];
  const lines = [title];
  if (shown.length === 0) {
    lines.push("  (no matching rows)");
    return lines;
  }
  lines.push(...renderUsageTable(headers, rollupToTableRows(shown, wide)));
  if (limit !== undefined && rows.length > limit) {
    lines.push(`  ... ${rows.length - limit} more rows (use --by <dim> to view all)`);
  }
  return lines;
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
  renderMeta: (line: string) => string;
  renderDashRow: (line: string) => string;
  columns: number;
}): string {
  const { breakdown, rollup, matrix, directoryScope, cwd, modelQueries, projectRefs, sourceIds, explainPricing, exportNotice, renderMeta, renderDashRow, columns } = params;
  const ov: UsageStatsOverview = breakdown.overview;
  const cost = ov.cost;
  const wide = columns >= 108;

  const lines: string[] = [renderMeta("Stats")];
  if (directoryScope) {
    const isCwd = path.resolve(directoryScope) === path.resolve(cwd);
    lines.push(renderDashRow(`- Scope: ${directoryScope}${isCwd ? " (current directory; pass --no-dir for whole-machine stats)" : ""}`));
  } else {
    lines.push(renderDashRow("- Scope: machine-wide (--no-dir)"));
  }

  const filterBits = [
    `tz=${breakdown.timezone}`,
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
    const quotaText =
      cost.quota_limit_usd !== undefined && cost.quota_percent !== undefined
        ? ` · Quota: ${cost.quota_percent.toFixed(1)}% of ${formatUsd(cost.quota_limit_usd)}`
        : "";
    lines.push(
      renderDashRow(`- Cost: List ${formatUsd(cost.list_cost_usd)} · Adjusted ${formatUsd(cost.adjusted_cost_usd)}${quotaText}`),
    );
    if (cost.unpriced_models.length > 0) {
      lines.push(renderDashRow(`- Unpriced models (${formatNum(cost.unpriced_tokens)} tokens): ${cost.unpriced_models.join(", ")}`));
    }
  }
  if (ov.excluded_zero_token_turns) {
    lines.push(renderDashRow(`- Excluded zero-token turns: ${ov.excluded_zero_token_turns} (no usage data)`));
  }
  if (exportNotice) {
    lines.push(renderDashRow(`- Exported pricing config: ${exportNotice}`));
  }

  if (rollup) {
    lines.push("", ...renderRollupSection(`By ${rollup.dimension}`, rollup.rows, wide));
  } else if (matrix) {
    lines.push("", `Matrix (${matrix.dimensions.join(" × ")})`);
    if (matrix.rows.length === 0) {
      lines.push("  (no matching rows)");
    } else {
      const headers = [
        ...matrix.dimensions.map((d) => ({ title: d[0]!.toUpperCase() + d.slice(1), width: d === "day" || d === "month" ? 12 : 18 })),
        { title: "Turns", width: 6, right: true },
        { title: "Input", width: 10, right: true },
        { title: "CacheR", width: 10, right: true },
        { title: "CacheW", width: 9, right: true },
        { title: "Output", width: 9, right: true },
        { title: "Total", width: 11, right: true },
        { title: "List$", width: 8, right: true },
        { title: "Adj$", width: 8, right: true },
        ...(breakdown.quota_limit_usd ? [{ title: "Quota", width: 7, right: true }] : []),
      ];
      const matrixTableRows = matrix.rows.map((r) => [
        ...r.labels,
        String(r.turn_count),
        formatNum(r.total_input_tokens),
        formatNum(r.total_cache_read_input_tokens),
        formatNum(r.total_cache_creation_input_tokens),
        formatNum(r.total_output_tokens),
        formatNum(r.total_tokens),
        formatUsd(r.cost.list_cost_usd),
        formatUsd(r.cost.adjusted_cost_usd),
        ...(breakdown.quota_limit_usd ? [formatQuotaPct(r.cost)] : []),
      ]);
      lines.push(...renderUsageTable(headers, matrixTableRows));
    }
  } else {
    lines.push(
      "",
      ...renderRollupSection("By project", breakdown.by_project.rows, wide, 10),
      "",
      ...renderRollupSection("By model", breakdown.by_model.rows, wide, 10),
      "",
      ...renderRollupSection("By source", breakdown.by_source.rows, wide, 10),
      "",
      ...renderRollupSection(`By ${breakdown.time_dimension}`, breakdown.by_time.rows, wide, 14),
    );
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
          formatUsd(m.list_cost_usd),
          formatUsd(m.adjusted_cost_usd),
        ];
      });
      lines.push(...renderUsageTable(headers, rows));
    }
  }

  return `${lines.join("\n")}\n`;
}
