import { stat } from "node:fs/promises";
import path from "node:path";
import type { SourceDefinition } from "@cchistory/domain";
import { getPlatformAdapter } from "../platforms/registry.js";

interface FileVersion {
  dev: number;
  ino: number;
  size: number;
  mtime: number;
  ctime: number;
}

/** One attempt's selected primary files and declared companion evidence. No payloads are retained. */
export interface SourceFileReadPlan {
  readonly files: readonly string[];
  readonly companions: Readonly<Record<string, readonly string[]>>;
  readonly versions: Readonly<Record<string, FileVersion | null>>;
  readonly bytes: number;
}

export class SourceFileReadPlanChangedError extends Error {
  readonly code = "source_read_plan_changed";

  constructor(filePath: string) {
    super(`Source evidence changed after scan planning: ${filePath}. Retry the read with a new scan.`);
    this.name = "SourceFileReadPlanChangedError";
  }
}

export async function createSourceFileReadPlan(
  source: SourceDefinition,
  selectedFiles: readonly string[],
  safeMode: boolean,
): Promise<SourceFileReadPlan> {
  const files = [...new Set(selectedFiles.map((file) => path.normalize(file)))];
  const adapter = getPlatformAdapter(source.platform);
  const companions: Record<string, readonly string[]> = {};
  const evidence = new Set(files);
  for (const file of files) {
    const paths = !safeMode && adapter?.getCompanionEvidencePaths
      ? await adapter.getCompanionEvidencePaths(source.base_dir, file)
      : [];
    companions[file] = Object.freeze([...new Set(paths.map((entry) => path.normalize(entry)))]);
    for (const entry of companions[file]!) evidence.add(entry);
    // Native SQLite may read WAL/SHM even when explicit companion capture is disabled.
    if (/\.(?:sqlite|vscdb|db)$/iu.test(file)) {
      evidence.add(`${file}-wal`);
      evidence.add(`${file}-shm`);
    }
  }
  const versions: Record<string, FileVersion | null> = {};
  let bytes = 0;
  for (const file of evidence) {
    const version = await readVersion(file);
    versions[file] = version && Object.freeze(version);
    bytes += version?.size ?? 0;
  }
  return Object.freeze({
    files: Object.freeze(files),
    companions: Object.freeze(companions),
    versions: Object.freeze(versions),
    bytes,
  });
}

/** Missing companions are included so their appearance also invalidates an estimate. */
export async function assertSourceFileReadPlanCurrent(
  plan: SourceFileReadPlan,
  files: readonly string[] = Object.keys(plan.versions),
): Promise<void> {
  for (const file of files) {
    const expected = plan.versions[file];
    if (expected === undefined || !sameVersion(expected, await readVersion(file))) {
      throw new SourceFileReadPlanChangedError(file);
    }
  }
}

export async function assertSourceFileReadCurrent(plan: SourceFileReadPlan, file: string): Promise<void> {
  if (!Object.hasOwn(plan.companions, file)) throw new SourceFileReadPlanChangedError(file);
  const evidence = [file, ...(plan.companions[file] ?? [])];
  for (const suffix of ["-wal", "-shm"]) {
    if (`${file}${suffix}` in plan.versions) evidence.push(`${file}${suffix}`);
  }
  await assertSourceFileReadPlanCurrent(plan, evidence);
}

async function readVersion(file: string): Promise<FileVersion | null> {
  try {
    const value = await stat(file);
    return { dev: value.dev, ino: value.ino, size: value.size, mtime: value.mtimeMs, ctime: value.ctimeMs };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function sameVersion(left: FileVersion | null, right: FileVersion | null): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtime === right.mtime && left.ctime === right.ctime;
}
