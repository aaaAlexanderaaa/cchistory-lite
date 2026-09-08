import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import os from "node:os";
import { getHeapStatistics } from "node:v8";
import path from "node:path";
import process from "node:process";
import { readAvailableMemory, readAvailableMemoryBytes, type AvailableMemoryReading } from "./system-memory.js";

/**
 * Best-effort scan admission: shared availability readings, a scan queue,
 * preflight estimates and progress/checkpoint sampling. Native-byte admission
 * is installed by live-runtime and consumed by adapters before payload reads.
 * These heuristics cannot guarantee against every synchronous/native allocation
 * or concurrent change in host load. Only explicit budget/refusal paths stop a
 * scan; unavailable OS signals fall back to the remaining V8 heap for admission.
 */

export type ScanGuardProfile = "light" | "full";
export type ScanGuardStatus = "ok" | "warn" | "refuse";

// JS object graphs run several times larger than the raw bytes they were
// parsed from, and even a light scan peaks during per-session parsing (the
// probe builds full turn context before contextMode "none" discards it). A
// full scan additionally retains every turn's context until exit. Both
// multipliers are conservative planning heuristics, not proven allocation bounds.
export const LIGHT_SCAN_MEMORY_MULTIPLIER = 4;
export const FULL_SCAN_MEMORY_MULTIPLIER = 8;

// Use fractions of the smaller of estimated system availability and remaining
// V8 heap. Leave room for allocation overhead and concurrent changes in load.
export const SCAN_GUARD_REFUSE_AVAILABLE_FRACTION = 0.75;
export const SCAN_GUARD_WARN_AVAILABLE_FRACTION = 0.5;

// A full scan normally takes seconds; 30s bounds the wait so a queued command
// fails fast instead of hanging. The 30min holder cap marks a lock wedged —
// kill(pid, 0) liveness alone cannot survive pid reuse.
export const SCAN_LOCK_WAIT_MS = 30_000;
export const SCAN_LOCK_POLL_MS = 250;
export const SCAN_LOCK_MAX_HOLDER_AGE_MS = 30 * 60_000;
const SCAN_LOCK_MAX_STEALS = 3;

// Reserve a quarter of the availability observed when this scan starts. This
// shares the preflight consumption fraction and never uses host total in a container.
export const SCAN_WATCHDOG_AVAILABLE_RESERVE_FRACTION = 1 - SCAN_GUARD_REFUSE_AVAILABLE_FRACTION;
export function readRemainingHeapBytes(): number {
  const heap = getHeapStatistics();
  return Math.max(0, heap.heap_size_limit - heap.used_heap_size);
}
// A meminfo read is microseconds; every 64 files or 1s keeps the check off the
// hot path while bounding how long a collapse goes unnoticed on slow scans.
export const SCAN_WATCHDOG_CHECK_EVERY_FILES = 64;
export const SCAN_WATCHDOG_CHECK_INTERVAL_MS = 1_000;

export interface ScanRiskRoot {
  path: string;
  bytes: number;
  slot_id?: string;
}

export interface ScanRiskAssessment {
  status: ScanGuardStatus;
  /** The profile whose multiplier produced estimatedBytes. */
  profile: ScanGuardProfile;
  /** scannedBytes × the profile multiplier — the conservative peak estimate. */
  estimatedBytes: number;
  /** Effective admission headroom: smaller of the system estimate and V8 heap. */
  availableBytes?: number;
  /** OS estimate, not total physical RAM or a guaranteed allocation allowance. */
  systemAvailableBytes?: number;
  heapAvailableBytes?: number;
  memorySignal?: AvailableMemoryReading["source"] | "injected";
  limitingResource?: "system" | "heap";
  /** Bytes the scan would probe under the selected roots, pre-multiplier. */
  scannedBytes: number;
  /** Per-root walk totals that summed to scannedBytes. */
  roots?: readonly ScanRiskRoot[];
  /**
   * True when the estimate counted `--dir`-filtered files rather than every
   * regular file under the selected roots.
   */
  directoryScoped?: boolean;
  /** Neutral machine-readable note; surfaces compose the human message. */
  detail: string;
}

export type AssessScanRiskRoot = string | { path: string; slot_id?: string };

export interface AssessScanRiskInput {
  /** Resolved adapter base dirs, after --source/--source-root selection. */
  roots: readonly AssessScanRiskRoot[];
  /** Per-root cap on files counted, mirroring limit_files_per_source. */
  limitFiles?: number;
  profile: ScanGuardProfile;
  /**
   * When true, the caller walked the same `--dir`-filtered file set the scan
   * would probe. Refusal copy then says the estimate is already scoped.
   */
  directoryScoped?: boolean;
}

export interface AssessScanRiskDeps {
  walkRootBytes?: (root: string, limitFiles?: number, slotId?: string) => Promise<number>;
  readAvailableBytes?: () => number | undefined;
  readMemory?: () => AvailableMemoryReading;
  readHeapBytes?: () => number;
}

export async function assessScanRisk(
  input: AssessScanRiskInput,
  deps: AssessScanRiskDeps = {},
): Promise<ScanRiskAssessment> {
  const multiplier = input.profile === "full" ? FULL_SCAN_MEMORY_MULTIPLIER : LIGHT_SCAN_MEMORY_MULTIPLIER;
  const walk = deps.walkRootBytes ?? walkRegularFileBytes;
  const normalizedRoots = input.roots.map((root) => (
    typeof root === "string" ? { path: root } : root
  ));
  const roots: ScanRiskRoot[] = [];
  let scannedBytes = 0;
  let walkFailed = false;
  for (const root of normalizedRoots) {
    try {
      const bytes = await walk(root.path, input.limitFiles, root.slot_id);
      roots.push({ path: root.path, bytes, ...(root.slot_id ? { slot_id: root.slot_id } : {}) });
      scannedBytes += bytes;
    } catch {
      // An incomplete walk cannot produce a sound estimate; degrade to ok.
      walkFailed = true;
      break;
    }
  }
  const estimatedBytes = scannedBytes * multiplier;
  let memory: AvailableMemoryReading | { bytes?: number; source: "injected" | "unknown" };
  try {
    memory = deps.readAvailableBytes
      ? { bytes: deps.readAvailableBytes(), source: "injected" }
      : (deps.readMemory ?? readAvailableMemory)();
  } catch {
    memory = { source: "unknown" };
  }
  const heapBytes = Math.max(0, (deps.readHeapBytes ?? readRemainingHeapBytes)());
  const systemAvailableBytes = memory.bytes;
  const availableBytes = systemAvailableBytes === undefined ? heapBytes : Math.min(systemAvailableBytes, heapBytes);
  const shared = {
    profile: input.profile,
    estimatedBytes,
    availableBytes,
    systemAvailableBytes,
    heapAvailableBytes: heapBytes,
    memorySignal: systemAvailableBytes === undefined ? "unknown" : memory.source,
    limitingResource: systemAvailableBytes === undefined || heapBytes <= systemAvailableBytes ? "heap" : "system",
    scannedBytes,
    roots,
    ...(input.directoryScoped ? { directoryScoped: true } : {}),
  } as const;
  if (walkFailed) {
    return {
      ...shared,
      status: "ok" as const,
      detail: "scan guard could not walk every selected root; proceeding without a complete estimate",
    };
  }
  if (estimatedBytes > availableBytes * SCAN_GUARD_REFUSE_AVAILABLE_FRACTION) {
    return {
      ...shared,
      status: "refuse" as const,
      detail: "estimated peak exceeds 75% of admission headroom",
    };
  }
  if (estimatedBytes > availableBytes * SCAN_GUARD_WARN_AVAILABLE_FRACTION) {
    return {
      ...shared,
      status: "warn" as const,
      detail: "estimated peak exceeds 50% of admission headroom",
    };
  }
  return {
    ...shared,
    status: "ok" as const,
    detail: "estimated peak within admission headroom",
  };
}

/**
 * Best-effort upper bound of the bytes adapters would read under one root:
 * every regular file, symlinks never followed (cycle- and escape-safe),
 * unreadable or vanished entries skipped. Deterministic (sorted entries) so
 * the limitFiles cap is stable.
 */
async function walkRegularFileBytes(root: string, limitFiles?: number): Promise<number> {
  let totalBytes = 0;
  let countedFiles = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        totalBytes += (await stat(entryPath)).size;
        countedFiles += 1;
      } catch {
        continue;
      }
      if (limitFiles !== undefined && countedFiles >= limitFiles) return totalBytes;
    }
  }
  return totalBytes;
}

// ── Advisory scan lock ──

export interface ScanLockHolder {
  pid: number;
  startedAt?: string;
}

export interface ScanLockHandle {
  readonly path: string;
  release(): Promise<void>;
}

export type ScanLockAcquisition =
  | { acquired: true; handle: ScanLockHandle; degradedDetail?: string }
  | { acquired: false; holder?: ScanLockHolder; waitedMs: number; detail: string };

export interface ScanLockDeps {
  lockPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  maxHolderAgeMs?: number;
}

/**
 * Runtime coordination between Lite processes — NOT a history store: the file
 * holds only `{ pid, startedAt }`, lives in XDG_RUNTIME_DIR (per-user, tmpfs)
 * or the OS temp dir, and is removed on release and on process exit.
 */
export async function acquireScanLock(deps: ScanLockDeps = {}): Promise<ScanLockAcquisition> {
  const lockPath = deps.lockPath ?? defaultScanLockPath();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const maxWaitMs = deps.maxWaitMs ?? SCAN_LOCK_WAIT_MS;
  const pollMs = deps.pollIntervalMs ?? SCAN_LOCK_POLL_MS;
  const maxHolderAgeMs = deps.maxHolderAgeMs ?? SCAN_LOCK_MAX_HOLDER_AGE_MS;
  const startedWaitingAt = now();
  let steals = 0;

  while (true) {
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      return { acquired: true, handle: createLockHandle(lockPath) };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        // The lock is advisory: an unwritable runtime dir must not block scans.
        return {
          acquired: true,
          handle: noopLockHandle(lockPath),
          degradedDetail: `scan lock unavailable (${error instanceof Error ? error.message : String(error)}); proceeding without it`,
        };
      }
    }

    const holder = await readLockHolder(lockPath);
    const holderAgeMs = holder?.startedAt ? now() - Date.parse(holder.startedAt) : undefined;
    const holderFresh = holder !== undefined
      && isAlive(holder.pid)
      && holderAgeMs !== undefined
      && Number.isFinite(holderAgeMs)
      && holderAgeMs < maxHolderAgeMs;
    if (holderFresh) {
      const waitedMs = now() - startedWaitingAt;
      if (waitedMs >= maxWaitMs) {
        return {
          acquired: false,
          holder,
          waitedMs,
          detail: `another cchistory-lite scan still holds ${lockPath}`,
        };
      }
      await sleep(Math.min(pollMs, Math.max(1, maxWaitMs - waitedMs)));
      continue;
    }
    // Dead pid, expired, or unreadable/corrupt: break the lock and retry. A
    // corrupt lock is treated as stale because the guard must fail open — the
    // worst case of a wrong steal is the pre-guard behavior (concurrent scans).
    steals += 1;
    if (steals > SCAN_LOCK_MAX_STEALS) {
      return {
        acquired: true,
        handle: noopLockHandle(lockPath),
        degradedDetail: "scan lock could not be acquired or cleared; proceeding without it",
      };
    }
    try {
      await unlink(lockPath);
    } catch {
      // Another contender cleared it first; retry the exclusive create.
    }
  }
}

export function defaultScanLockPath(
  env: NodeJS.ProcessEnv = process.env,
  tmpdir: () => string = os.tmpdir,
): string {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return path.join(runtimeDir, "cchistory-lite-scan.lock");
  // The shared temp dir is multi-user on Linux, so the fallback name carries
  // the uid; XDG_RUNTIME_DIR is already per-user.
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return path.join(tmpdir(), `cchistory-lite-scan${uid === undefined ? "" : `-${uid}`}.lock`);
}

function createLockHandle(lockPath: string): ScanLockHandle {
  let released = false;
  // Backstop for crashes between acquire and release. Only unlinks a lock
  // this process still owns, so a stolen-then-recreated lock survives.
  const onExit = () => {
    releaseIfOwnerSync(lockPath);
  };
  process.once("exit", onExit);
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      process.removeListener("exit", onExit);
      try {
        const holder = await readLockHolder(lockPath);
        if (holder?.pid === process.pid) await unlink(lockPath);
      } catch {
        // Already gone or unreadable; nothing to release.
      }
    },
  };
}

function releaseIfOwnerSync(lockPath: string): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    const pid = parsed && typeof parsed === "object" ? (parsed as { pid?: unknown }).pid : undefined;
    if (pid === process.pid) unlinkSync(lockPath);
  } catch {
    // Already gone or unreadable; nothing to release.
  }
}

function noopLockHandle(lockPath: string): ScanLockHandle {
  return { path: lockPath, release: async () => {} };
}

async function readLockHolder(lockPath: string): Promise<ScanLockHolder | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    const startedAt = (parsed as { startedAt?: unknown }).startedAt;
    return { pid, startedAt: typeof startedAt === "string" ? startedAt : undefined };
  } catch {
    return undefined;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means alive but owned by another user; ESRCH means gone.
    return Boolean(
      error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EPERM",
    );
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST",
  );
}

// ── Scan watchdog ──

export interface ScanWatchdogDeps {
  readAvailableBytes?: () => number | undefined;
  /** Initial available bytes, sampled once when omitted. */
  initialAvailableBytes?: number;
  /** @deprecated Host total is deliberately ignored. */
  totalBytes?: number;
  /** Explicit floor override; wins over the computed one. */
  floorBytes?: number;
  now?: () => number;
  checkEveryFiles?: number;
  checkIntervalMs?: number;
}

export interface ScanWatchdog {
  readonly floorBytes: number;
  /**
   * Feed scan progress events. Throws ScanGuardAbortedError when available
   * memory has crossed the floor; the throw propagates out of adapter progress
   * emissions (file_start is emitted outside adapter try/catch blocks), and a
   * recorded breach is re-thrown by assertHealthy at scan checkpoints.
   */
  observeProgress(event: { stage: string }): void;
  /** Re-throws a recorded breach; call between sources and before materializing. */
  assertHealthy(): void;
}

export function createScanWatchdog(deps: ScanWatchdogDeps = {}): ScanWatchdog {
  const now = deps.now ?? Date.now;
  const readAvailable = deps.readAvailableBytes ?? (() => readAvailableMemoryBytes());
  let initialAvailableBytes = deps.initialAvailableBytes;
  if (initialAvailableBytes === undefined && deps.floorBytes === undefined) {
    try { initialAvailableBytes = readAvailable(); } catch { /* unknown */ }
  }
  const floorBytes = deps.floorBytes ?? Math.floor((initialAvailableBytes ?? 0) * SCAN_WATCHDOG_AVAILABLE_RESERVE_FRACTION);
  const checkEveryFiles = deps.checkEveryFiles ?? SCAN_WATCHDOG_CHECK_EVERY_FILES;
  const checkIntervalMs = deps.checkIntervalMs ?? SCAN_WATCHDOG_CHECK_INTERVAL_MS;
  let filesSinceCheck = 0;
  let lastCheckAt = now();
  let breachAvailableBytes: number | undefined;
  let breached = false;

  const abort = (): never => {
    throw new ScanGuardAbortedError({ availableBytes: breachAvailableBytes, floorBytes });
  };

  const check = (): void => {
    lastCheckAt = now();
    filesSinceCheck = 0;
    let available: number | undefined;
    try {
      available = readAvailable();
    } catch {
      return; // A failed read never aborts a scan.
    }
    if (available === undefined) return; // Unknown availability: nothing to compare.
    if (available === 0 || available < floorBytes) {
      breached = true;
      breachAvailableBytes = available;
      abort();
    }
  };

  return {
    floorBytes,
    observeProgress(event) {
      if (breached) abort();
      if (event.stage === "file_start") filesSinceCheck += 1;
      if (filesSinceCheck >= checkEveryFiles || now() - lastCheckAt >= checkIntervalMs) check();
    },
    assertHealthy() {
      if (breached) abort();
      check();
    },
  };
}

// ── Guard outcomes ──

export type ScanGuardRefusalReason = "scan_in_progress" | "estimated_memory";

export class ScanGuardRefusedError extends Error {
  readonly reason: ScanGuardRefusalReason;
  readonly assessment?: ScanRiskAssessment;
  readonly holder?: ScanLockHolder;
  readonly waitedMs?: number;

  constructor(init: {
    reason: ScanGuardRefusalReason;
    assessment?: ScanRiskAssessment;
    holder?: ScanLockHolder;
    waitedMs?: number;
  }) {
    super(buildRefusalMessage(init));
    this.name = "ScanGuardRefusedError";
    this.reason = init.reason;
    this.assessment = init.assessment;
    this.holder = init.holder;
    this.waitedMs = init.waitedMs;
  }
}

export class ScanGuardAbortedError extends Error {
  readonly availableBytes?: number;
  readonly floorBytes: number;

  constructor(init: { availableBytes?: number; floorBytes: number }) {
    super(
      `Scan aborted: system available-memory estimate dropped to ${
        init.availableBytes === undefined ? "an unknown level" : formatScanGuardBytes(init.availableBytes)
      }, below the ${formatScanGuardBytes(init.floorBytes)} reserve set at scan start. ` +
      formatScanBoundNextSteps(),
    );
    this.name = "ScanGuardAbortedError";
    this.availableBytes = init.availableBytes;
    this.floorBytes = init.floorBytes;
  }
}

export interface ScanGuardWarnEvent {
  type: "warn";
  assessment: ScanRiskAssessment;
}

export type ScanGuardEvent = ScanGuardWarnEvent;

export function isScanGuardEnabled(envValue: string | undefined): boolean {
  if (envValue === undefined) return true;
  const normalized = envValue.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export function formatScanGuardBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatScanGuardWarning(assessment: ScanRiskAssessment): string {
  const available = assessment.availableBytes === undefined
    ? "an unknown amount of"
    : formatScanGuardBytes(assessment.availableBytes);
  const multiplier = assessment.profile === "full" ? FULL_SCAN_MEMORY_MULTIPLIER : LIGHT_SCAN_MEMORY_MULTIPLIER;
  return `Scan guard warning: estimated peak memory ${formatScanGuardBytes(assessment.estimatedBytes)} ` +
    `(${assessment.profile} scan of ${formatScanGuardBytes(assessment.scannedBytes)} source bytes, ×${multiplier}) ` +
    `exceeds 50% of the ${available} admission headroom; proceeding. ${formatMemorySignals(assessment)}`;
}

function buildRefusalMessage(init: {
  reason: ScanGuardRefusalReason;
  assessment?: ScanRiskAssessment;
  holder?: ScanLockHolder;
  waitedMs?: number;
}): string {
  if (init.reason === "scan_in_progress") {
    const holder = init.holder;
    const holderDescription = holder
      ? `pid ${holder.pid}${holder.startedAt ? `, started ${holder.startedAt}` : ""}`
      : "holder unknown";
    const waitedSeconds = Math.round((init.waitedMs ?? 0) / 1000);
    return `Refusing to scan: another cchistory-lite scan is still running (${holderDescription}); ` +
      `waited ${waitedSeconds}s for it to finish. ` +
      `Wait for that scan to finish, or reuse its \`shell\` / \`query\` session.`;
  }
  const assessment = init.assessment;
  const multiplier = assessment?.profile === "full" ? FULL_SCAN_MEMORY_MULTIPLIER : LIGHT_SCAN_MEMORY_MULTIPLIER;
  const available = assessment?.availableBytes === undefined
    ? "unknown"
    : formatScanGuardBytes(assessment.availableBytes);
  const directoryNote = assessment?.directoryScoped
    ? "--dir already limited this estimate to files that may match that working directory."
    : "--dir also bounds the estimate when a collection command uses it; this scan has no --dir filter.";
  return `Refusing to scan: estimated peak memory ${formatScanGuardBytes(assessment?.estimatedBytes ?? 0)} ` +
    `(${assessment?.profile ?? "light"} scan of ${formatScanGuardBytes(assessment?.scannedBytes ?? 0)} source bytes, ×${multiplier}) ` +
    `exceeds 75% of the ${available} admission headroom. ${formatMemorySignals(assessment)}` +
    `${formatSelectedSourceRoots(assessment)} ` +
    `${directoryNote} ` +
    formatScanBoundNextSteps();
}

function formatMemorySignals(assessment: ScanRiskAssessment | undefined): string {
  const system = assessment?.systemAvailableBytes === undefined ? "unknown" : formatScanGuardBytes(assessment.systemAvailableBytes);
  const heap = assessment?.heapAvailableBytes === undefined ? "unknown" : formatScanGuardBytes(assessment.heapAvailableBytes);
  return `System available-memory estimate: ${system} (${assessment?.memorySignal ?? "unknown"}); ` +
    `remaining V8 heap: ${heap}; limiting resource: ${assessment?.limitingResource ?? "unknown"}. ` +
    "Lite does not set the Node heap limit.";
}

function formatSelectedSourceRoots(assessment: ScanRiskAssessment | undefined): string {
  const roots = assessment?.roots;
  if (!roots?.length) return "";
  const lines = roots.map((root) => {
    const slot = root.slot_id ? `${root.slot_id}  ` : "";
    return `  ${slot}${root.path}  ${formatScanGuardBytes(root.bytes)}`;
  });
  const heading = assessment?.directoryScoped
    ? "Selected source roots after --dir filter:"
    : "Selected source roots:";
  return ` ${heading}\n${lines.join("\n")}`;
}

function formatScanBoundNextSteps(): string {
  return "No complete result was produced; keep the requested scope. `cchistory-lite sources --json` lists adapter roots without parsing history. " +
    "Report the resource limit before changing scope or memory settings. File count and sample size are not memory bounds; shell reuses a successful read.";
}
