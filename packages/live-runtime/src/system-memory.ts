import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";

export interface SystemMemoryDeps {
  platform?: NodeJS.Platform;
  availableMemory?: () => number;
  readMeminfo?: () => string;
  readVmStat?: () => string;
  freemem?: () => number;
  totalmem?: () => number;
  /** Zero means unavailable/unknown, not proof that no external limit exists. */
  constrainedMemory?: () => number;
}

export interface AvailableMemoryReading {
  bytes?: number;
  source: "darwin_vm_stat" | "linux_memavailable" | "node_available" | "os_freemem" | "unknown";
  constrainedBytes?: number;
}

/** Darwin's Node availableMemory reports unused pages, not reclaimable memory. */
export function readAvailableMemory(deps: SystemMemoryDeps = {}): AvailableMemoryReading {
  const platform = deps.platform ?? process.platform;
  const constraint = finiteBytes(safeCall(deps.constrainedMemory ?? (() => process.constrainedMemory())));
  const constrainedBytes = constraint && constraint > 0 ? constraint : undefined;
  const total = finiteBytes(safeCall(deps.totalmem ?? (() => os.totalmem())));
  const finish = (bytes: number | undefined, source: AvailableMemoryReading["source"]): AvailableMemoryReading => ({
    bytes: bytes === undefined ? undefined : Math.min(bytes, total ?? Infinity, constrainedBytes ?? Infinity),
    source: bytes === undefined ? "unknown" : source,
    ...(constrainedBytes === undefined ? {} : { constrainedBytes }),
  });
  if (platform === "darwin") {
    const raw = safeCall(deps.readVmStat ?? readDarwinVmStat);
    // An unreadable/unknown format is unknown capacity. Falling back to free pages
    // would restore the false tiny budget this path exists to avoid.
    return finish(raw === undefined ? undefined : parseDarwinAvailableBytes(raw), "darwin_vm_stat");
  }
  const nodeAvailable = finiteBytes(safeCall(deps.availableMemory ?? (() => process.availableMemory())));
  if (platform === "linux") {
    const raw = safeCall(deps.readMeminfo ?? (() => readFileSync("/proc/meminfo", "utf8")));
    const hostAvailable = raw === undefined ? undefined : parseMemAvailableBytes(raw);
    // Under a known cgroup constraint, Node includes current group usage. Keep a
    // real zero; never replace remaining quota with total quota or host RAM.
    if (constrainedBytes !== undefined && nodeAvailable !== undefined) return finish(
      Math.min(nodeAvailable, hostAvailable ?? Infinity), "node_available");
    if (hostAvailable !== undefined) return finish(hostAvailable, "linux_memavailable");
  }
  if (nodeAvailable !== undefined) return finish(nodeAvailable, "node_available");
  return finish(finiteBytes(safeCall(deps.freemem ?? (() => os.freemem()))), "os_freemem");
}

export function readAvailableMemoryBytes(deps: SystemMemoryDeps = {}): number | undefined {
  return readAvailableMemory(deps).bytes;
}

/** Same available-memory accounting as psutil/Zabbix on macOS: free + inactive. */
export function parseDarwinAvailableBytes(raw: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/u.exec(raw)?.[1]);
  const free = /^Pages free:\s*(\d+)\.\s*$/mu.exec(raw)?.[1];
  const inactive = /^Pages inactive:\s*(\d+)\.\s*$/mu.exec(raw)?.[1];
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || free === undefined || inactive === undefined) return undefined;
  // vm_stat free_count already includes speculative pages. Purgeable, file-backed
  // and compressor counts overlap other categories; don't add them again.
  const bytes = (Number(free) + Number(inactive)) * pageSize;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

export function parseMemAvailableBytes(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s*(\d+)\s*kB\s*$/mu.exec(meminfo);
  if (!match?.[1]) return undefined;
  const bytes = Number(match[1]) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

// Process-local sampling only, shared by estimate/admission/watchdog. Never a store.
let darwinSample: { at: number; raw?: string } | undefined;
function readDarwinVmStat(): string | undefined {
  const now = performance.now();
  if (!darwinSample || now - darwinSample.at >= 1000) {
    const raw = safeCall(() => execFileSync("/usr/bin/vm_stat", [], {
      encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }));
    darwinSample = { at: now, raw };
  }
  return darwinSample.raw;
}

function safeCall<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}
function finiteBytes(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
