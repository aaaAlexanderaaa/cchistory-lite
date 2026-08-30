import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { readAvailableMemoryBytes } from "./system-memory.js";

/**
 * The scan guard: four cooperating components that keep a Lite scan — alone or
 * concurrently with sibling Lite processes and the host agent — from pushing
 * the machine into swap-death. Swap-death fails silently (allocations keep
 * succeeding, so neither the OOM killer nor the V8 heap limit fires), which is
 * why this layer fails fast instead.
 *
 *   1. The adaptive heap ceiling (node-memory.ts) budgets old-space from
 *      AVAILABLE memory rather than host totals.
 *   2. An advisory lock serializes full scans on this machine.
 *   3. A watchdog aborts a scan if available memory collapses mid-probe.
 *   4. A pre-flight estimate (sound because the lock serializes scans) refuses
 *      scans whose conservative peak estimate risks the machine.
 *
 * Everything here is best-effort: internal errors degrade to "proceed", never
 * to a blocked scan. Only the explicit refuse/abort paths stop one. The
 * kill-switch env is read by the caller (the live-runtime entry), not here, so
 * tests pass behavior explicitly.
 */

export type ScanGuardProfile = "light" | "full";
export type ScanGuardStatus = "ok" | "warn" | "refuse";

// JS object graphs run several times larger than the raw bytes they were
// parsed from, and even a light scan peaks during per-session parsing (the
// probe builds full turn context before contextMode "none" discards it). A
// full scan additionally retains every turn's context until exit. Both
// multipliers are deliberately conservative upper bounds on that anatomy.
export const LIGHT_SCAN_MEMORY_MULTIPLIER = 4;
export const FULL_SCAN_MEMORY_MULTIPLIER = 8;

// Above 75% of currently-available memory the scan risks pushing the host into
// swap; above 50% a warning is warranted because other processes may claim the
// rest while the scan runs.
export const SCAN_GUARD_REFUSE_AVAILABLE_FRACTION = 0.75;
export const SCAN_GUARD_WARN_AVAILABLE_FRACTION = 0.5;

// A full scan normally takes seconds; 30s bounds the wait so a queued command
// fails fast instead of hanging. The 30min holder cap marks a lock wedged —
// kill(pid, 0) liveness alone cannot survive pid reuse.
export const SCAN_LOCK_WAIT_MS = 30_000;
export const SCAN_LOCK_POLL_MS = 250;
export const SCAN_LOCK_MAX_HOLDER_AGE_MS = 30 * 60_000;
const SCAN_LOCK_MAX_STEALS = 3;

// Below this floor the next V8 growth spurt — a Lite scan may legally grow
// toward its old-space ceiling — plus the host agent can push the machine into
// swap-death. 512 MiB covers small hosts; 5% of total scales the floor up on
// big machines where a fixed MiB floor is noise.
export const SCAN_WATCHDOG_MIN_FLOOR_BYTES = 512 * 1024 ** 2;
export const SCAN_WATCHDOG_TOTAL_FLOOR_FRACTION = 0.05;
// A meminfo read is microseconds; every 64 files or 1s keeps the check off the
// hot path while bounding how long a collapse goes unnoticed on slow scans.
export const SCAN_WATCHDOG_CHECK_EVERY_FILES = 64;
export const SCAN_WATCHDOG_CHECK_INTERVAL_MS = 1_000;

export interface ScanRiskAssessment {
  status: ScanGuardStatus;
  /** The profile whose multiplier produced estimatedBytes. */
  profile: ScanGuardProfile;
  /** scannedBytes × the profile multiplier — the conservative peak estimate. */
  estimatedBytes: number;
  /** Bytes the host can give right now; undefined when the platform cannot say. */
  availableBytes?: number;
  /** Raw regular-file bytes walked under the selected roots, pre-multiplier. */
  scannedBytes: number;
  /** Neutral machine-readable note; surfaces compose the human message. */
  detail: string;
}

export interface AssessScanRiskInput {
  /** Resolved adapter base dirs, after --source/--source-root selection. */
  roots: readonly string[];
  /** Per-root cap on files counted, mirroring limit_files_per_source. */
  limitFiles?: number;
  profile: ScanGuardProfile;
}

export interface AssessScanRiskDeps {
  walkRootBytes?: (root: string, limitFiles?: number) => Promise<number>;
  readAvailableBytes?: () => number | undefined;
}

export async function assessScanRisk(
  input: AssessScanRiskInput,
  deps: AssessScanRiskDeps = {},
): Promise<ScanRiskAssessment> {
  const multiplier = input.profile === "full" ? FULL_SCAN_MEMORY_MULTIPLIER : LIGHT_SCAN_MEMORY_MULTIPLIER;
  const walk = deps.walkRootBytes ?? walkRegularFileBytes;
  let scannedBytes = 0;
  let walkFailed = false;
  for (const root of input.roots) {
    try {
      scannedBytes += await walk(root, input.limitFiles);
    } catch {
      // An incomplete walk cannot produce a sound estimate; degrade to ok.
      walkFailed = true;
      break;
    }
  }
  const estimatedBytes = scannedBytes * multiplier;
  let availableBytes: number | undefined;
  try {
    availableBytes = (deps.readAvailableBytes ?? (() => readAvailableMemoryBytes()))();
  } catch {
    availableBytes = undefined;
  }
  if (walkFailed) {
    return {
      status: "ok",
      profile: input.profile,
      estimatedBytes,
      availableBytes,
      scannedBytes,
      detail: "scan guard could not walk every selected root; proceeding without a complete estimate",
    };
  }
  if (availableBytes === undefined) {
    return {
      status: "ok",
      profile: input.profile,
      estimatedBytes,
      availableBytes,
      scannedBytes,
      detail: "available system memory is unknown; proceeding without a memory estimate",
    };
  }
  if (estimatedBytes > availableBytes * SCAN_GUARD_REFUSE_AVAILABLE_FRACTION) {
    return {
      status: "refuse",
      profile: input.profile,
      estimatedBytes,
      availableBytes,
      scannedBytes,
      detail: "estimated peak exceeds 75% of available memory",
    };
  }
  if (estimatedBytes > availableBytes * SCAN_GUARD_WARN_AVAILABLE_FRACTION) {
    return {
      status: "warn",
      profile: input.profile,
      estimatedBytes,
      availableBytes,
      scannedBytes,
      detail: "estimated peak exceeds 50% of available memory",
    };
  }
  return {
    status: "ok",
    profile: input.profile,
    estimatedBytes,
    availableBytes,
    scannedBytes,
    detail: "estimated peak within available memory",
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
  /** Host total memory, for the 5%-of-total floor component. */
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
  const floorBytes = deps.floorBytes ?? Math.max(
    SCAN_WATCHDOG_MIN_FLOOR_BYTES,
    Math.floor((deps.totalBytes ?? os.totalmem()) * SCAN_WATCHDOG_TOTAL_FLOOR_FRACTION),
  );
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
    if (available < floorBytes) {
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
      `Scan aborted: available memory dropped to ${
        init.availableBytes === undefined ? "an unknown level" : formatScanGuardBytes(init.availableBytes)
      }, below the ${formatScanGuardBytes(init.floorBytes)} safety floor; failing fast is safer than letting this machine swap. ` +
      `Narrow the scan with --source, --dir, or --limit-files, or retry when the machine is less loaded. ` +
      `Override the guard with CCHISTORY_SCAN_GUARD=0.`,
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
    `exceeds 50% of the ${available} currently available; proceeding. ` +
    `Consider \`sample\`, \`shell\`, or \`query\` to lower peak memory; CCHISTORY_SCAN_GUARD=0 disables the guard.`;
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
      `Retry shortly, or amortize one scan over many reads with \`shell\` / \`query\`; ` +
      `\`sample\` and \`show session <exact id>\` bypass the scan lock. ` +
      `Override the guard with CCHISTORY_SCAN_GUARD=0.`;
  }
  const assessment = init.assessment;
  const multiplier = assessment?.profile === "full" ? FULL_SCAN_MEMORY_MULTIPLIER : LIGHT_SCAN_MEMORY_MULTIPLIER;
  const available = assessment?.availableBytes === undefined
    ? "unknown"
    : formatScanGuardBytes(assessment.availableBytes);
  return `Refusing to scan: estimated peak memory ${formatScanGuardBytes(assessment?.estimatedBytes ?? 0)} ` +
    `(${assessment?.profile ?? "light"} scan of ${formatScanGuardBytes(assessment?.scannedBytes ?? 0)} source bytes, ×${multiplier}) ` +
    `exceeds 75% of the ${available} currently available on this machine. ` +
    `Narrow the scan with --source, --dir, or --limit-files; use \`sample\` for a bounded preview, ` +
    `or \`shell\` / \`query\` to amortize one scan over many reads. ` +
    `Override the guard with CCHISTORY_SCAN_GUARD=0.`;
}
