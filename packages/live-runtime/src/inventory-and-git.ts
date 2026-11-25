/**
 * Role: Live runtime orchestration for Slice A (read-only AI agent config inventory
 * correlated with in-memory history activity) and Slice B (bounded opt-in local Git
 * metadata attachment for projected projects).
 * Excludes low-level config/git parsing (source-adapters) and pure reconciliation semantics (canonical).
 */

import type {
  AgentInventoryReport,
  ProjectIdentity,
  ProjectWithGitMetadata,
  SessionProjection,
} from "@cchistory/domain";
import { correlateAgentInventory } from "@cchistory/canonical";
import {
  NATIVE_STARTUP_CLIENT_IDS,
  inspectLocalProjectGitMetadata,
  readAgentConfigInventory,
  resolveAgentStartupContexts,
  validateAgentStartupRefs,
} from "@cchistory/source-adapters";
export { NATIVE_STARTUP_CLIENT_IDS, validateAgentStartupRefs };
import { mapPool } from "./async-pool.js";
import type { LiveHistorySnapshot, ScanLiteHistoryOptions } from "./index.js";

const GIT_INSPECT_CONCURRENCY = 4;

export interface ScanAgentInventoryOptions {
  homeDir?: string;
  projectDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional agent slot ids or aliases for native pre-launch startup resolution. */
  agentRefs?: readonly string[];
  /** Explicitly toggle pre-launch startup resolution (defaults to true when projectDir or agentRefs is provided). */
  resolveStartup?: boolean;
  window?: string;
  nowMs?: number;
  skipActivity?: boolean;
  /** Optional pre-scanned sessions or snapshot to correlate without re-scanning disk. */
  sessions?: readonly SessionProjection[];
  snapshot?: LiveHistorySnapshot;
  /** Callback to run a light history scan when sessions/snapshot are not already supplied. */
  scanHistory?: (options: ScanLiteHistoryOptions) => Promise<LiveHistorySnapshot>;
  historyScanOptions?: ScanLiteHistoryOptions;
}

export async function scanAgentInventory(
  options: ScanAgentInventoryOptions = {},
): Promise<AgentInventoryReport> {
  const discovered = await readAgentConfigInventory({
    homeDir: options.homeDir,
    projectDir: options.projectDir,
    env: options.env,
  });

  const shouldResolveStartup =
    options.resolveStartup ?? Boolean(options.projectDir || (options.agentRefs && options.agentRefs.length > 0));
  const startupContexts = shouldResolveStartup
    ? await resolveAgentStartupContexts({
        homeDir: options.homeDir,
        projectDir: options.projectDir,
        env: options.env,
        agentRefs: options.agentRefs,
      })
    : undefined;

  if (options.skipActivity) {
    return correlateAgentInventory({
      discovered,
      startupContexts,
      window: options.window,
      nowMs: options.nowMs,
      skipActivity: true,
    });
  }

  let sessions: readonly SessionProjection[] | undefined = options.sessions;
  if (!sessions && options.snapshot) {
    sessions = options.snapshot.data.sessions;
  }
  if (!sessions && options.scanHistory) {
    const snapshot = await options.scanHistory({
      ...(options.historyScanOptions ?? {}),
      homeDir: options.historyScanOptions?.homeDir ?? options.homeDir,
      contextMode: "none",
    });
    sessions = snapshot.data.sessions;
  }

  return correlateAgentInventory({
    discovered,
    startupContexts,
    sessions: sessions ?? [],
    window: options.window,
    nowMs: options.nowMs,
    skipActivity: false,
  });
}

export interface AttachProjectGitMetadataOptions {
  timeoutMs?: number;
  concurrency?: number;
}

export async function attachProjectGitMetadata(
  projects: readonly ProjectIdentity[],
  options: AttachProjectGitMetadataOptions = {},
): Promise<ProjectWithGitMetadata[]> {
  const concurrency = options.concurrency ?? GIT_INSPECT_CONCURRENCY;
  const gitResults = await mapPool(projects, concurrency, async (project) => {
    const targetPath = project.repo_root ?? project.primary_workspace_path;
    return inspectLocalProjectGitMetadata(targetPath, { timeoutMs: options.timeoutMs });
  });

  return projects.map((project, index) => ({
    ...project,
    git: gitResults[index]!,
  }));
}
