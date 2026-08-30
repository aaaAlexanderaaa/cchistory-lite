import { readFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";

/**
 * Shared system-memory reading for the scan guard and the adaptive heap
 * ceiling. Everything here is synchronous (the scan watchdog calls it from
 * inside sync progress callbacks) and best-effort: a reading failure returns
 * `undefined` ("unknown") and never throws, so a guard can never break a scan
 * with its own errors.
 */

const MEMINFO_PATH = "/proc/meminfo";

export interface SystemMemoryDeps {
  platform?: NodeJS.Platform;
  /** Reads /proc/meminfo contents; only consulted on Linux. */
  readMeminfo?: () => string;
  freemem?: () => number;
  /** process.constrainedMemory(): the enforced cgroup memory limit, 0 when unconstrained. */
  constrainedMemory?: () => number;
}

/**
 * Bytes the host can hand out right now. Linux MemAvailable counts reclaimable
 * page cache (os.freemem does not), so it is the honest signal on Linux;
 * os.freemem() is the fallback elsewhere and when meminfo is unreadable or
 * predates MemAvailable. /proc/meminfo and freemem are both host-wide, so an
 * enforced cgroup limit caps the result to keep containers honest. Returns
 * undefined when no signal is available.
 */
export function readAvailableMemoryBytes(deps: SystemMemoryDeps = {}): number | undefined {
  const platform = deps.platform ?? process.platform;
  let available: number | undefined;
  if (platform === "linux") {
    const meminfo = safeCall(deps.readMeminfo ?? (() => readFileSync(MEMINFO_PATH, "utf8")));
    if (meminfo !== undefined) available = parseMemAvailableBytes(meminfo);
    available ??= positiveFiniteBytes(safeCall(deps.freemem ?? (() => os.freemem())));
  } else {
    available = positiveFiniteBytes(safeCall(deps.freemem ?? (() => os.freemem())));
  }
  const constrained = positiveFiniteBytes(safeCall(deps.constrainedMemory ?? (() => process.constrainedMemory())));
  if (constrained !== undefined && available !== undefined) {
    available = Math.min(available, constrained);
  }
  return available;
}

export function parseMemAvailableBytes(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s*(\d+)\s*kB\s*$/mu.exec(meminfo);
  if (!match?.[1]) return undefined;
  const kib = Number(match[1]);
  return Number.isSafeInteger(kib) ? kib * 1024 : undefined;
}

function safeCall<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function positiveFiniteBytes(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
