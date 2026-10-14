import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

/** Attempt-owned admission; adapters report native byte costs before allocating payloads. */
export interface SourceReadBudget {
  admit(bytes: number, unit: string): void;
  maximumUnitBytes?(): number;
}

export class SourceReadBudgetExceededError extends Error {
  constructor(readonly unit: string, readonly requestedBytes: number, readonly remainingBytes: number) {
    super(`Read budget exceeded for ${unit}: needs ${requestedBytes} native bytes, ${remainingBytes} bytes of read headroom remain. This input was skipped; other readable history is retained.`);
    this.name = "SourceReadBudgetExceededError";
  }
}

/**
 * Read value lengths inside SQLite before crossing into JS. The caller owns a read
 * transaction so admission and retrieval see the same rows. The fixed per-row
 * allowance also charges empty/null rows; it is an estimate, not an RSS guarantee.
 * An adapter may supply a conservative equivalent admission query to avoid
 * recomputing expensive derived columns or ordering that admission does not need.
 */
export function readBudgetedSqliteRows(
  db: DatabaseSync, query: string, columns: readonly string[], params: SQLInputValue[] = [],
  budget?: SourceReadBudget, unit = "SQLite result",
  admissionQuery?: string,
): Record<string, SQLOutputValue>[] {
  if (budget) {
    const lengths = columns.map(column => `coalesce(length(CAST("${column.replaceAll('"', '""')}" AS BLOB)), 0)`).join(" + ");
    const size = db.prepare(admissionQuery ?? `SELECT coalesce(sum(128 + ${lengths}), 0) AS bytes FROM (${query})`).get(...params);
    budget.admit(Number(size?.bytes), unit);
  }
  // Admission bounds the retained rows; iterate avoids a second all()-allocated array.
  return Array.from(db.prepare(query).iterate(...params));
}
