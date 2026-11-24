import { existsSync } from "node:fs";
import path from "node:path";
import type { PlatformAdapter } from "./types.js";

const PI_CONFIG_DIR = ".pi";

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
    // Pi has no PI_CONFIG_DIR; only its own agent dir can be relocated.
    const defaultAgentDir = path.join(homeDir, PI_CONFIG_DIR, "agent");
    const ompAgentDir = path.join(homeDir, ".omp", "agent");
    const candidates: string[] = [];
    const envAgentDir = envText(env.PI_CODING_AGENT_DIR);
    const sessionDir = envText(env.PI_CODING_AGENT_SESSION_DIR);
    if (sessionDir) {
      candidates.push(expandTilde(sessionDir, homeDir));
    }
    if (envAgentDir) {
      const normalized = expandTilde(envAgentDir, homeDir).replace(/\\/gu, "/");
      // Both Pi and Oh My Pi honour PI_CODING_AGENT_DIR. A marker-less path is
      // accepted only when this product's default root exists and OMP's does
      // not, so a dual install never indexes one directory twice.
      const markerlessSafe =
        !normalized.includes("/.omp/")
        && (normalized.includes("/.pi/")
          || (pathExists(defaultAgentDir) && !pathExists(ompAgentDir)));
      if (markerlessSafe) {
        candidates.push(path.join(expandTilde(envAgentDir, homeDir), "sessions"));
      }
    }
    if (homeDir) {
      candidates.push(path.join(defaultAgentDir, "sessions"));
    }
    return [...new Set(candidates)];
  },
  matchesSourceFile: (filePath) => filePath.endsWith(".jsonl"),
  filterSourceFiles: (files) => [...files].sort((left, right) => left.localeCompare(right)),
};
