import { existsSync } from "node:fs";
import path from "node:path";
import { normalizePathSeparators } from "../core/utils.js";
import type { PlatformAdapter } from "./types.js";

const PI_CONFIG_DIR = ".pi";

function envText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Pi keeps one JSONL file per session under `<agent-dir>/sessions/<encoded-cwd>/`.
 * The agent directory defaults to `~/.pi/agent` and can be relocated with
 * `PI_CODING_AGENT_DIR`; `PI_CONFIG_DIR` renames the config directory itself.
 */
export const piAdapter: PlatformAdapter = {
  platform: "pi",
  supportTier: "experimental",
  sessionTargeting: "file",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => {
    const env = options.env ?? process.env;
    const pathExists = options.pathExists ?? existsSync;
    const homeDir = options.homeDir ?? "";
    const configDirName = envText(env.PI_CONFIG_DIR) ?? PI_CONFIG_DIR;
    const defaultAgentDir = path.join(homeDir, configDirName, "agent");
    const candidates: string[] = [];
    const envAgentDir = envText(env.PI_CODING_AGENT_DIR);
    // Both Pi and Oh My Pi honour PI_CODING_AGENT_DIR (OMP is a fork). Accept a
    // marker-less override only when this product's own root exists, so an
    // OMP-only machine does not get its sessions indexed twice as Pi.
    if (
      envAgentDir &&
      (!envAgentDir.replace(/\\/gu, "/").includes("/.omp/") &&
        (envAgentDir.replace(/\\/gu, "/").includes("/.pi/") || pathExists(defaultAgentDir) || !pathExists(path.join(homeDir, ".omp"))))
    ) {
      candidates.push(path.join(envAgentDir, "sessions"));
    }
    if (homeDir) {
      candidates.push(path.join(defaultAgentDir, "sessions"));
    }
    // Deduplicate when PI_CONFIG_DIR already spells `.pi`.
    return [...new Set(candidates)];
  },
  matchesSourceFile: (filePath) => {
    const normalized = normalizePathSeparators(filePath);
    return normalized.includes("/agent/sessions/") && normalized.endsWith(".jsonl");
  },
  filterSourceFiles: (files) => [...files].sort((left, right) => left.localeCompare(right)),
};
