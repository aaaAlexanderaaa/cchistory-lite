import { existsSync } from "node:fs";
import path from "node:path";
import { normalizePathSeparators } from "../core/utils.js";
import type { PlatformAdapter } from "./types.js";

const OMP_CONFIG_DIR = ".omp";

function envText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function expandTilde(value: string, homeDir: string): string {
  if (value === "~" && homeDir) {
    return homeDir;
  }
  if (value.startsWith("~/") && homeDir) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
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
    if (envAgentDir) {
      const normalized = expandTilde(envAgentDir, homeDir).replace(/\\/gu, "/");
      const piAgentDir = path.join(homeDir, ".pi", "agent");
      // Marker-less overrides are accepted only when OMP's own default root
      // exists and Pi's does not; dual installs require an explicit source
      // selection instead of indexing one directory twice.
      const markerlessSafe =
        !normalized.includes("/.pi/")
        && (normalized.includes("/.omp/")
          || (pathExists(defaultAgentDir) && !pathExists(piAgentDir)));
      if (markerlessSafe) {
        candidates.push(path.join(expandTilde(envAgentDir, homeDir), "sessions"));
      }
    }
    if (homeDir) {
      candidates.push(path.join(defaultAgentDir, "sessions"));
    }
    return [...new Set(candidates)];
  },
  getSourceRoots: (baseDir) => {
    // Named profiles keep their own agent directory; walking the profiles tree
    // finds them without guessing every profile name or leaking host env state.
    const normalized = normalizePathSeparators(baseDir);
    const roots = [baseDir];
    if (normalized.endsWith("/agent/sessions")) {
      const configRoot = path.dirname(path.dirname(baseDir));
      roots.push(path.join(configRoot, "profiles"));
    }
    return [...new Set(roots)];
  },
  matchesSourceFile: (filePath) => {
    const normalized = normalizePathSeparators(filePath);
    if (!normalized.endsWith(".jsonl")) {
      return false;
    }
    // Inside a walked `profiles/` tree, accept only session transcripts under a
    // `sessions/` subtree; explicit session roots accept any `.jsonl` file.
    if (normalized.includes("/profiles/")) {
      return normalized.includes("/sessions/");
    }
    return true;
  },
  filterSourceFiles: (files) => [...files].sort((left, right) => left.localeCompare(right)),
};
