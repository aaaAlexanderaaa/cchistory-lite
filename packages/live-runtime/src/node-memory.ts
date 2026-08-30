import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";
import { readAvailableMemoryBytes } from "./system-memory.js";

const MIB = 1024 ** 2;
export const MAX_OLD_SPACE_MIB = 4096;
// Even on a memory-tight host a scan needs enough heap to parse and project;
// below this floor Lite could not function at all. The scan watchdog — not the
// heap ceiling — is the protector on tight hosts.
export const MIN_OLD_SPACE_MIB = 512;
const APPLIED_MEMORY_ENV = "CCHISTORY_ADAPTIVE_NODE_MEMORY_MB";

export function calculateAdaptiveOldSpaceMiB(totalMemoryBytes: number, availableMemoryBytes?: number): number {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new Error(`Host memory must be a positive finite byte count; received ${totalMemoryBytes}.`);
  }
  if (availableMemoryBytes === undefined || !Number.isFinite(availableMemoryBytes) || availableMemoryBytes <= 0) {
    // Availability unknown: keep the pre-guard total/2 policy rather than
    // guessing low and reintroducing the R43 large-machine launch OOM.
    return Math.max(1, Math.min(Math.floor(totalMemoryBytes / (2 * MIB)), MAX_OLD_SPACE_MIB));
  }
  // N concurrent Lite processes and the host agent share one physical memory,
  // so the heap budget tracks what is actually free (MemAvailable / freemem,
  // cgroup-capped), not the machine's total. Half of available leaves headroom
  // for the host agent and the OS; the 4 GiB cap preserves R43's big idle
  // machine behavior (available ≈ total there); the floor keeps small but
  // sufficient scans possible.
  const availableBasedMiB = Math.floor(availableMemoryBytes / (2 * MIB));
  return Math.max(MIN_OLD_SPACE_MIB, Math.min(availableBasedMiB, MAX_OLD_SPACE_MIB));
}

export function resolveAdaptiveOldSpaceMiB(
  totalMemoryBytes: number,
  readAvailableMemory: () => number | undefined = () => readAvailableMemoryBytes(),
): number {
  let availableMemoryBytes: number | undefined;
  try {
    availableMemoryBytes = readAvailableMemory();
  } catch {
    availableMemoryBytes = undefined;
  }
  return calculateAdaptiveOldSpaceMiB(totalMemoryBytes, availableMemoryBytes);
}

export function buildAdaptiveNodeExecArgv(execArgv: readonly string[], memoryMiB: number): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index]!;
    if (/^--max[-_]old[-_]space[-_]size=/u.test(argument)) continue;
    if (/^--max[-_]old[-_]space[-_]size$/u.test(argument)) {
      index += 1;
      continue;
    }
    filtered.push(argument);
  }
  return [...filtered, `--max-old-space-size=${memoryMiB}`];
}

export function isAdaptiveNodeMemoryApplied(
  execArgv: readonly string[],
  appliedMemoryEnv: string | undefined,
  memoryMiB: number,
): boolean {
  if (appliedMemoryEnv !== String(memoryMiB)) return false;
  return execArgv.some((argument) => {
    const match = /^--max[-_]old[-_]space[-_]size=(\d+)$/u.exec(argument);
    return match?.[1] === String(memoryMiB);
  });
}

export async function runWithAdaptiveNodeMemory(
  runCurrentProcess: () => Promise<number>,
  readAvailableMemory?: () => number | undefined,
): Promise<number> {
  const memoryMiB = resolveAdaptiveOldSpaceMiB(os.totalmem(), readAvailableMemory);
  if (isAdaptiveNodeMemoryApplied(process.execArgv, process.env[APPLIED_MEMORY_ENV], memoryMiB)) {
    return runCurrentProcess();
  }
  const entryPath = process.argv[1];
  if (!entryPath) return runCurrentProcess();

  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...buildAdaptiveNodeExecArgv(process.execArgv, memoryMiB),
        entryPath,
        ...process.argv.slice(2),
      ],
      {
        env: { ...process.env, [APPLIED_MEMORY_ENV]: String(memoryMiB) },
        stdio: "inherit",
      },
    );
    // The child owns the terminal (stdio is inherited), so it must be the one
    // that decides how to shut down. Without forwarding, a supervisor signal
    // kills this launcher while the child keeps the raw-mode alternate screen.
    const forwarded = FORWARDED_SIGNALS.map((signal) => {
      const listener = () => {
        if (!child.killed) child.kill(signal);
      };
      process.on(signal, listener);
      return [signal, listener] as const;
    });
    const releaseSignals = () => {
      for (const [signal, listener] of forwarded) process.removeListener(signal, listener);
    };
    child.once("error", (error) => {
      releaseSignals();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      releaseSignals();
      resolve(code ?? (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : 1));
    });
  });
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const SIGNAL_NUMBERS: Readonly<Partial<Record<NodeJS.Signals, number>>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};
