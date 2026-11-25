/**
 * Role: Public dispatcher for per-tool native pre-launch startup context resolution.
 * Computes the offline Git root and ancestor directory chain once, invokes the requested
 * native resolvers (Claude Code, Codex, Google Antigravity, OpenCode, DeepSeek Harness),
 * and returns explicit basic/unsupported entries for other adapter slots.
 * Excludes history correlation, CLI rendering, and filesystem mutations.
 */

import os from "node:os";
import path from "node:path";
import type { AgentStartupResolution } from "@cchistory/domain";
import { listPlatformAdapters } from "../../platforms/registry.js";
import { resolveAntigravityStartup } from "./antigravity.js";
import { resolveClaudeCodeStartup } from "./claude-code.js";
import { resolveCodexStartup } from "./codex.js";
import { resolveDeepSeekHarnessStartup } from "./deepseek-harness.js";
import { resolveOpenCodeStartup } from "./opencode.js";
import {
  buildAncestorChainRootToCwd,
  resolveOfflineGitRoot,
  type NativeStartupResolverInput,
} from "./shared.js";

export type NativeStartupClientId =
  | "claude_code"
  | "codex"
  | "antigravity"
  | "opencode"
  | "deepseek_harness";

export const NATIVE_STARTUP_CLIENT_IDS: readonly NativeStartupClientId[] = [
  "claude_code",
  "codex",
  "antigravity",
  "opencode",
  "deepseek_harness",
];

const BASIC_CONFIG_CLIENTS: Readonly<Record<string, string>> = {
  gemini: "Gemini CLI",
  grok: "Grok CLI",
};

const AGENT_REF_ALIASES: Readonly<Record<string, string>> = {
  claude: "claude_code",
  "claude-code": "claude_code",
  claude_code: "claude_code",
  codex: "codex",
  antigravity: "antigravity",
  agy: "antigravity",
  opencode: "opencode",
  "open-code": "opencode",
  deepseek: "deepseek_harness",
  dsh: "deepseek_harness",
  "deepseek-harness": "deepseek_harness",
  deepseek_harness: "deepseek_harness",
  gemini: "gemini",
  "gemini-cli": "gemini",
  grok: "grok",
  "grok-cli": "grok",
};

export interface ResolveAgentStartupContextsOptions {
  homeDir?: string;
  projectDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional list of requested agent slot ids or aliases. Defaults to all 5 native resolvers. */
  agentRefs?: readonly string[];
}

export interface AgentStartupRefValidation {
  resolvedIds: string[];
  unknownRefs: string[];
}

export function validateAgentStartupRefs(agentRefs?: readonly string[]): AgentStartupRefValidation {
  const registered = new Set<string>(listPlatformAdapters().map((adapter) => adapter.platform));
  const known = new Set<string>([
    ...NATIVE_STARTUP_CLIENT_IDS,
    ...Object.keys(BASIC_CONFIG_CLIENTS),
    ...registered,
  ]);
  const resolvedIds: string[] = [];
  const unknownRefs: string[] = [];
  const seen = new Set<string>();
  for (const raw of agentRefs ?? []) {
    for (const part of raw.split(",")) {
      const cleaned = part.trim().toLowerCase();
      if (!cleaned) continue;
      if (cleaned === "all") {
        for (const id of NATIVE_STARTUP_CLIENT_IDS) {
          if (!seen.has(id)) {
            seen.add(id);
            resolvedIds.push(id);
          }
        }
        continue;
      }
      const mapped = AGENT_REF_ALIASES[cleaned] ?? cleaned;
      if (!known.has(mapped)) {
        if (!unknownRefs.includes(part.trim())) unknownRefs.push(part.trim());
        continue;
      }
      if (!seen.has(mapped)) {
        seen.add(mapped);
        resolvedIds.push(mapped);
      }
    }
  }
  return { resolvedIds, unknownRefs };
}

export async function resolveAgentStartupContexts(
  options: ResolveAgentStartupContextsOptions = {},
): Promise<AgentStartupResolution[]> {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const isolatedHome = Boolean(options.homeDir);
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : null;
  const env = options.env ?? process.env;

  const gitRoot = await resolveOfflineGitRoot(projectDir);
  const ancestorDirsRootToCwd = buildAncestorChainRootToCwd(projectDir, gitRoot);

  const resolverInput: NativeStartupResolverInput = {
    homeDir,
    projectDir,
    gitRoot,
    ancestorDirsRootToCwd,
    env,
    isolatedHome,
  };

  const targetIds = normalizeRequestedAgents(options.agentRefs);
  const registeredAdapters = new Set<string>(
    listPlatformAdapters().map((adapter) => adapter.platform),
  );

  const results: AgentStartupResolution[] = [];
  for (const clientId of targetIds) {
    switch (clientId) {
      case "claude_code":
        results.push(await resolveClaudeCodeStartup(resolverInput));
        break;
      case "codex":
        results.push(await resolveCodexStartup(resolverInput));
        break;
      case "antigravity":
        results.push(await resolveAntigravityStartup(resolverInput));
        break;
      case "opencode":
        results.push(await resolveOpenCodeStartup(resolverInput));
        break;
      case "deepseek_harness":
        results.push(await resolveDeepSeekHarnessStartup(resolverInput));
        break;
      default: {
        const basicDisplay = BASIC_CONFIG_CLIENTS[clientId];
        if (basicDisplay) {
          results.push({
            client: clientId,
            display_name: basicDisplay,
            resolution_tier: "basic",
            project_dir: projectDir,
            git_root: gitRoot,
            files_read: [],
            mcp_servers: [],
            diagnostics: [],
            native: {
              client: clientId,
              supported: false,
              reason:
                `${basicDisplay} currently reports machine-wide config inventory at tier=basic; ` +
                "deep per-project startup resolution is not yet implemented.",
            },
          });
          break;
        }
        if (registeredAdapters.has(clientId)) {
          const registeredDisplay = formatPlatformDisplayName(clientId);
          results.push({
            client: clientId,
            display_name: registeredDisplay,
            resolution_tier: "unsupported",
            project_dir: projectDir,
            git_root: gitRoot,
            files_read: [],
            mcp_servers: [],
            diagnostics: [],
            native: {
              client: clientId,
              supported: false,
              reason:
                `${registeredDisplay} is registered for history reading but does not yet have a ` +
                "pre-launch startup context resolver.",
            },
          });
          break;
        }
        results.push({
          client: clientId,
          display_name: clientId,
          resolution_tier: "unsupported",
          project_dir: projectDir,
          git_root: gitRoot,
          files_read: [],
          mcp_servers: [],
          diagnostics: [
            {
              code: "unknown_agent_ref",
              severity: "warning",
              client: clientId,
              path: projectDir ?? homeDir,
              detail: `Unknown agent identifier "${clientId}". Supported native startup resolvers: ${NATIVE_STARTUP_CLIENT_IDS.join(", ")}.`,
            },
          ],
          native: {
            client: clientId,
            supported: false,
            reason: `Unknown agent "${clientId}". Native startup resolvers support: ${NATIVE_STARTUP_CLIENT_IDS.join(", ")}.`,
          },
        });
        break;
      }
    }
  }

  return results;
}

function normalizeRequestedAgents(agentRefs?: readonly string[]): string[] {
  if (!agentRefs || agentRefs.length === 0) {
    return [...NATIVE_STARTUP_CLIENT_IDS];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of agentRefs) {
    for (const part of raw.split(",")) {
      const cleaned = part.trim().toLowerCase();
      if (!cleaned) continue;
      if (cleaned === "all") {
        for (const id of NATIVE_STARTUP_CLIENT_IDS) {
          if (!seen.has(id)) {
            seen.add(id);
            out.push(id);
          }
        }
        continue;
      }
      const mapped = AGENT_REF_ALIASES[cleaned] ?? cleaned;
      if (!seen.has(mapped)) {
        seen.add(mapped);
        out.push(mapped);
      }
    }
  }
  return out.length > 0 ? out : [...NATIVE_STARTUP_CLIENT_IDS];
}

function formatPlatformDisplayName(platform: string): string {
  return platform
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
