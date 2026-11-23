import { existsSync } from "node:fs";
import path from "node:path";
import { normalizePathSeparators } from "../core/utils.js";
import type { PlatformAdapter } from "./types.js";

const OMP_CONFIG_DIR = ".omp";

function envText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Oh My Pi is a Pi fork: it reuses the Pi session JSONL layout under
 * `<agent-dir>/sessions/<encoded-cwd>/` and adds a fixed-width title slot and
 * extra entry types. The default agent directory is `~/.omp/agent`, with
 * named profiles under `<config-root>/profiles/<name>/agent`.
 */
export const ohMyPiAdapter: PlatformAdapter = {
  platform: "oh_my_pi",
  supportTier: "experimental",
  sessionTargeting: "file",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => {
    const env = options.env ?? process.env;
    const pathExists = options.pathExists ?? existsSync;
    const homeDir = options.homeDir ?? "";
    const configDirName = envText(env.PI_CONFIG_DIR) ?? OMP_CONFIG_DIR;
    const configRoot = path.join(homeDir, configDirName);
    const defaultAgentDir = path.join(configRoot, "agent");
    const candidates: string[] = [];
    const envAgentDir = envText(env.PI_CODING_AGENT_DIR);
    // OMP honours the same override for its default profile. Only accept it
    // when it clearly belongs to OMP (or OMP is the installed product), so a
    // Pi-only machine is not indexed twice.
    if (
      envAgentDir &&
      (!envAgentDir.replace(/\\/gu, "/").includes("/.pi/") &&
        (envAgentDir.replace(/\\/gu, "/").includes("/.omp/") || pathExists(defaultAgentDir) || !pathExists(path.join(homeDir, ".pi"))))
    ) {
      candidates.push(path.join(envAgentDir, "sessions"));
    }
    if (homeDir) {
      candidates.push(path.join(defaultAgentDir, "sessions"));
    }
    return [...new Set(candidates)];
  },
  getSourceRoots: (baseDir) => {
    // Named profiles keep their own agent directory; walking the profiles tree
    // finds them without guessing every profile name.
    const normalized = normalizePathSeparators(baseDir);
    if (normalized.endsWith("/agent/sessions")) {
      const configRoot = path.dirname(path.dirname(baseDir));
      return [baseDir, path.join(configRoot, "profiles")];
    }
    return [baseDir];
  },
  matchesSourceFile: (filePath) => {
    const normalized = normalizePathSeparators(filePath);
    return normalized.includes("/agent/sessions/") && normalized.endsWith(".jsonl");
  },
  filterSourceFiles: (files) => [...files].sort((left, right) => left.localeCompare(right)),
};
