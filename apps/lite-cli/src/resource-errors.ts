import { ScanGuardAbortedError, ScanGuardRefusedError, SourceReadBudgetExceededError } from "@cchistory/live-runtime";

/** Shared one-shot/shell classification; a refused read never becomes an empty success. */
export function resourceError(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof SourceReadBudgetExceededError) return {
    code: "read_budget_exceeded", resource: { complete: false, unit: error.unit,
      requested_bytes: error.requestedBytes, remaining_bytes: error.remainingBytes },
  };
  if (error instanceof ScanGuardRefusedError) return { code: "scan_guard_refused",
    resource: { complete: false, reason: error.reason, assessment: error.assessment } };
  if (error instanceof ScanGuardAbortedError) return { code: "scan_guard_aborted",
    resource: { complete: false, available_bytes: error.availableBytes, reserve_bytes: error.floorBytes } };
  return undefined;
}
