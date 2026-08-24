import { installRuntimeWarningFilter } from "@cchistory/canonical";

// Install before any importer dynamically loads `node:sqlite` through adapters.
installRuntimeWarningFilter();

export {
  buildAdaptiveNodeExecArgv,
  calculateAdaptiveOldSpaceMiB,
  isAdaptiveNodeMemoryApplied,
  runWithAdaptiveNodeMemory,
} from "./node-memory.js";

export function settleLauncherExit(result: Promise<number>): void {
  result.then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      writeLauncherError(error);
      process.exitCode = 1;
    },
  );
}

function writeLauncherError(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // stderr already closed (broken pipe).
  }
}
