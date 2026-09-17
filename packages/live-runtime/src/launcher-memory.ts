import { spawn } from "node:child_process";
import os from "node:os";
import { getHeapStatistics } from "node:v8";
import { readAvailableMemoryBytes } from "./system-memory.js";

export interface LauncherMemoryInput {
  availableBytes?: number;
  heapLimitBytes: number;
  execArgv: readonly string[];
  nodeOptions?: string;
  arch?: string;
}

/** A ceiling, not a reservation. Leave half the observed capacity for native
 * allocations and other processes. Never override an explicit Node heap policy. */
export function adaptiveHeapLimitMiB(input: LauncherMemoryInput): number | undefined {
  const flags = [...input.execArgv, input.nodeOptions ?? ""].join(" ").replaceAll("_", "-");
  if (/--(?:max-old-space-size(?:-percentage)?|max-heap-size|huge-max-old-generation-size)(?:[=\s"']|$)/u.test(flags)) return undefined;
  if (input.arch === "ia32" || input.arch === "arm") return undefined;
  if (input.availableBytes === undefined || !Number.isFinite(input.availableBytes) || input.availableBytes <= 0) return undefined;
  const target = Math.floor(input.availableBytes * 0.5 / 1024 ** 2);
  // Avoid a relaunch for marginal changes; never shrink a working Node default.
  return target * 1024 ** 2 > input.heapLimitBytes * 1.25 ? target : undefined;
}

export async function runWithAdaptiveHeap(run: () => Promise<number>): Promise<number> {
  const target = adaptiveHeapLimitMiB({ availableBytes: readAvailableMemoryBytes(),
    heapLimitBytes: getHeapStatistics().heap_size_limit, execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS, arch: process.arch });
  if (target === undefined || !process.argv[1]) return run();
  // The explicit flag also makes the child skip relaunching. Load the history
  // runtime only in that child so the launcher holds no duplicate snapshot.
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, `--max-old-space-size=${target}`, ...process.argv.slice(1)], { stdio: "inherit" });
    const forwardInterrupt = () => { child.kill("SIGINT"); };
    const forwardTerminate = () => { child.kill("SIGTERM"); };
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    const cleanup = () => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1));
    });
  });
}
