/**
 * Role: Helpers for the native Claude Code startup resolver: CLAUDE.md recursive @import
 * resolution, .claude/rules YAML frontmatter parsing, subagent parsing, plugin bundle
 * expansion, hook extraction, and precedence deduplication.
 * Excludes top-level Claude Code settings/MCP cascade orchestration and CLI rendering.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  ClaudeMdEntry,
  ClaudeMdImportRef,
  ClaudePluginEntry,
  ClaudeRuleEntry,
  ClaudeSkillOrCommandEntry,
  ClaudeSubagentEntry,
  McpServerConfigEntry,
  RedactedHookEntry,
} from "@cchistory/domain";
import { redactMcpCommand } from "../redaction.js";
import {
  asNonEmptyString,
  asRecord,
  buildRedactedMcpEntry,
  estimateTextTokens,
  listSkillEntriesInDir,
  parseMarkdownFrontmatter,
  readTrackedJsonObject,
  readTrackedTextFile,
  safeReadDir,
  type StartupReadTracker,
} from "./shared.js";

const MAX_IMPORT_DEPTH = 5;

export async function loadClaudeMdEntry(
  tracker: StartupReadTracker,
  filePath: string,
  layer: ClaudeMdEntry["layer"],
  homeDir: string,
): Promise<ClaudeMdEntry | undefined> {
  const file = await readTrackedTextFile(tracker, filePath, "claude_md");
  if (!file) return undefined;
  const imports: ClaudeMdImportRef[] = [];
  const visited = new Set<string>([path.resolve(filePath)]);
  await resolveClaudeImports(tracker, filePath, file.content, homeDir, 1, visited, imports);
  return {
    path: path.resolve(filePath),
    layer,
    size_bytes: file.sizeBytes,
    estimated_tokens: estimateTextTokens(file.content, "claude"),
    imports,
  };
}

async function resolveClaudeImports(
  tracker: StartupReadTracker,
  ownerPath: string,
  content: string,
  homeDir: string,
  depth: number,
  visited: Set<string>,
  out: ClaudeMdImportRef[],
): Promise<void> {
  if (depth > MAX_IMPORT_DEPTH) return;
  const refs = extractAtImportRefs(content);
  for (const rawRef of refs) {
    const resolved = rawRef.startsWith("~/")
      ? path.resolve(homeDir, rawRef.slice(2))
      : path.resolve(path.dirname(ownerPath), rawRef);
    if (visited.has(resolved)) {
      out.push({ raw_ref: rawRef, resolved_path: resolved, exists: true, cycle: true, depth });
      continue;
    }
    const imported = await readTrackedTextFile(tracker, resolved, "claude_md_import");
    if (!imported) {
      out.push({ raw_ref: rawRef, resolved_path: resolved, exists: false, depth });
      continue;
    }
    visited.add(resolved);
    out.push({
      raw_ref: rawRef,
      resolved_path: resolved,
      exists: true,
      size_bytes: imported.sizeBytes,
      estimated_tokens: estimateTextTokens(imported.content, "claude"),
      depth,
    });
    await resolveClaudeImports(tracker, resolved, imported.content, homeDir, depth + 1, visited, out);
  }
}

function extractAtImportRefs(markdown: string): string[] {
  const refs: string[] = [];
  let inFence = false;
  for (const rawLine of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (/^`{3,}|^~{3,}/u.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^@((?:~\/|\.\.?\/|\/)?[^\s`"']+\.[A-Za-z0-9_-]+)$/u.exec(trimmed);
    if (match?.[1]) refs.push(match[1]);
  }
  return refs;
}

export async function collectClaudeRules(
  tracker: StartupReadTracker,
  dirPath: string,
  scope: "user" | "project",
  out: ClaudeRuleEntry[],
): Promise<void> {
  const entries = await safeReadDir(tracker, dirPath);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isFile() || !/\.(?:md|markdown)$/iu.test(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const file = await readTrackedTextFile(tracker, fullPath, "claude_rule");
    if (!file) continue;
    const fm = parseMarkdownFrontmatter(file.content);
    const pathsList = fm.lists.paths?.length
      ? fm.lists.paths
      : fm.scalars.paths
        ? [fm.scalars.paths]
        : fm.lists.globs?.length
          ? fm.lists.globs
          : [];
    out.push({
      name: entry.name.replace(/\.(?:md|markdown)$/iu, ""),
      path: fullPath,
      scope,
      mode: pathsList.length > 0 ? "path_scoped" : "always",
      ...(pathsList.length > 0 ? { paths: pathsList } : {}),
      size_bytes: file.sizeBytes,
      estimated_tokens: estimateTextTokens(file.content, "claude"),
    });
  }
}

export async function listClaudeSubagents(
  tracker: StartupReadTracker,
  dirPath: string,
): Promise<Array<{ name: string; path: string; description?: string; model?: string; tools?: string[] }>> {
  const entries = await safeReadDir(tracker, dirPath);
  const out: Array<{ name: string; path: string; description?: string; model?: string; tools?: string[] }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isFile() || !/\.(?:md|markdown)$/iu.test(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const file = await readTrackedTextFile(tracker, fullPath, "claude_subagent");
    const fm = file ? parseMarkdownFrontmatter(file.content) : undefined;
    const tools = fm?.lists.tools?.length
      ? fm.lists.tools
      : fm?.scalars.tools
        ? fm.scalars.tools.split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;
    out.push({
      name: fm?.scalars.name || entry.name.replace(/\.(?:md|markdown)$/iu, ""),
      path: fullPath,
      ...(fm?.scalars.description ? { description: fm.scalars.description } : {}),
      ...(fm?.scalars.model ? { model: fm.scalars.model } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
    });
  }
  return out;
}

export async function expandClaudePluginBundle(
  tracker: StartupReadTracker,
  plugin: ClaudePluginEntry,
  installPath: string,
  mcpOut: Array<{ entry: McpServerConfigEntry; pluginName: string }>,
  skillsOut: Array<{ name: string; path: string; description?: string }>,
  commandsOut: Array<{ name: string; path: string; description?: string }>,
  subagentsOut: Array<{ name: string; path: string; description?: string; model?: string; tools?: string[] }>,
  hooksOut: RedactedHookEntry[],
): Promise<void> {
  try {
    await fs.access(installPath);
  } catch {
    return;
  }
  const manifestPath = path.join(installPath, ".claude-plugin", "plugin.json");
  await readTrackedJsonObject(tracker, manifestPath, "claude_plugin_manifest");

  const skills = await listSkillEntriesInDir(tracker, path.join(installPath, "skills"));
  for (const s of skills) {
    plugin.bundled_skills.push(s.name);
    skillsOut.push(s);
  }
  const cmds = await listSkillEntriesInDir(tracker, path.join(installPath, "commands"));
  for (const c of cmds) {
    plugin.bundled_commands.push(c.name);
    commandsOut.push(c);
  }
  const agents = await listClaudeSubagents(tracker, path.join(installPath, "agents"));
  for (const a of agents) {
    plugin.bundled_agents.push(a.name);
    subagentsOut.push(a);
  }

  const mcpPath = path.join(installPath, ".mcp.json");
  const mcpJson = await readTrackedJsonObject(tracker, mcpPath, "claude_plugin_mcp");
  const servers = asRecord(mcpJson?.mcpServers);
  if (servers) {
    for (const [id, val] of Object.entries(servers)) {
      const rec = asRecord(val);
      if (!rec) continue;
      plugin.bundled_mcp_servers.push(id);
      mcpOut.push({
        entry: buildRedactedMcpEntry("claude_code", "user", mcpPath, id, rec),
        pluginName: plugin.name,
      });
    }
  }

  const hooksPath = path.join(installPath, "hooks", "hooks.json");
  const hooksJson = await readTrackedJsonObject(tracker, hooksPath, "claude_plugin_hooks");
  const hookEvents = asRecord(hooksJson?.hooks ?? hooksJson);
  if (hookEvents) {
    const before = hooksOut.length;
    extractClaudeHooks(hookEvents, hooksPath, hooksOut);
    for (let i = before; i < hooksOut.length; i += 1) {
      plugin.bundled_hooks.push(hooksOut[i]!.event);
    }
  }
}

export function extractClaudeHooks(
  hooksObj: Record<string, unknown> | undefined,
  sourcePath: string,
  out: RedactedHookEntry[],
): void {
  if (!hooksObj) return;
  for (const [event, value] of Object.entries(hooksObj)) {
    if (!Array.isArray(value) || value.length === 0) {
      out.push({ event, enabled: true, source_path: sourcePath });
      continue;
    }
    for (const group of value) {
      const rec = asRecord(group);
      const matcher = asNonEmptyString(rec?.matcher);
      const nested = Array.isArray(rec?.hooks) ? rec.hooks : [];
      if (nested.length === 0) {
        const directCmd = redactMcpCommand(asNonEmptyString(rec?.command));
        out.push({
          event,
          ...(matcher ? { matcher } : {}),
          ...(directCmd ? { command: directCmd } : {}),
          enabled: true,
          source_path: sourcePath,
        });
        continue;
      }
      for (const handler of nested) {
        const hRec = asRecord(handler);
        const cmd = redactMcpCommand(asNonEmptyString(hRec?.command));
        out.push({
          event,
          ...(matcher ? { matcher } : {}),
          ...(cmd ? { command: cmd } : {}),
          enabled: true,
          source_path: sourcePath,
        });
      }
    }
  }
}

export function resolveNamedEntries(
  projectList: Array<{ name: string; path: string; description?: string }>,
  userList: Array<{ name: string; path: string; description?: string }>,
  pluginList: Array<{ name: string; path: string; description?: string }>,
): ClaudeSkillOrCommandEntry[] {
  const out: ClaudeSkillOrCommandEntry[] = [];
  const winners = new Map<string, string>();
  const addScope = (items: typeof projectList, scope: "project" | "user" | "plugin") => {
    for (const item of items) {
      const key = item.name.toLowerCase();
      const winner = winners.get(key);
      if (winner) {
        out.push({ ...item, scope, status: "shadowed", shadowed_by: winner });
      } else {
        winners.set(key, `${scope} (${item.path})`);
        out.push({ ...item, scope, status: "effective" });
      }
    }
  };
  addScope(projectList, "project");
  addScope(userList, "user");
  addScope(pluginList, "plugin");
  return out;
}

export function resolveSubagentEntries(
  projectList: Array<{ name: string; path: string; description?: string; model?: string; tools?: string[] }>,
  userList: Array<{ name: string; path: string; description?: string; model?: string; tools?: string[] }>,
  pluginList: Array<{ name: string; path: string; description?: string; model?: string; tools?: string[] }>,
): ClaudeSubagentEntry[] {
  const out: ClaudeSubagentEntry[] = [];
  const winners = new Map<string, string>();
  const addScope = (items: typeof projectList, scope: "project" | "user" | "plugin") => {
    for (const item of items) {
      const key = item.name.toLowerCase();
      const winner = winners.get(key);
      if (winner) {
        out.push({ ...item, scope, status: "shadowed", shadowed_by: winner });
      } else {
        winners.set(key, `${scope} (${item.path})`);
        out.push({ ...item, scope, status: "effective" });
      }
    }
  };
  addScope(projectList, "project");
  addScope(userList, "user");
  addScope(pluginList, "plugin");
  return out;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}
