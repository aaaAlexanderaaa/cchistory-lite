/**
 * Role: Manifest expansion, hook extraction, rule `@[label](path)` include parsing, and
 * path canonicalization helpers for the native Google Antigravity startup resolver.
 * Excludes top-level Antigravity precedence orchestration and CLI formatting.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  AntigravityRuleEntry,
  RedactedHookEntry,
} from "@cchistory/domain";
import { redactMcpCommand } from "../redaction.js";
import {
  asNonEmptyString,
  asRecord,
  pathExists,
  readTrackedJsonObject,
  type StartupReadTracker,
} from "./shared.js";

export const AGY_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PreInvocation",
  "PostInvocation",
  "Stop",
] as const;

export interface ManifestDirEntry {
  dir: string;
  includeOnly?: string[];
  exclude?: string[];
}

export async function readPluginManifest(
  tracker: StartupReadTracker,
  pluginDir: string,
): Promise<Record<string, unknown> | undefined> {
  for (const rel of ["plugin.json", ".antigravity-plugin/plugin.json", ".gemini-plugin/plugin.json", "manifest.json"]) {
    const parsed = await readTrackedJsonObject(tracker, path.join(pluginDir, rel), "antigravity_plugin_manifest");
    if (parsed) return parsed;
  }
  return undefined;
}

export function extractAntigravityHooks(
  hooksObj: Record<string, unknown>,
  sourcePath: string,
  out: RedactedHookEntry[],
): void {
  for (const [hookName, rawSpec] of Object.entries(hooksObj)) {
    const spec = asRecord(rawSpec);
    if (!spec) continue;
    const enabled = spec.enabled !== false;
    for (const event of AGY_HOOK_EVENTS) {
      const list = spec[event];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const rec = asRecord(item);
        const matcher = asNonEmptyString(rec?.matcher);
        const nested = Array.isArray(rec?.hooks) ? rec.hooks : [rec];
        for (const h of nested) {
          const hRec = asRecord(h);
          const cmd = redactMcpCommand(asNonEmptyString(hRec?.command));
          out.push({
            name: hookName,
            event,
            ...(matcher ? { matcher } : {}),
            ...(cmd ? { command: cmd } : {}),
            enabled,
            source_path: sourcePath,
          });
        }
      }
    }
  }
}

export async function expandJsonManifest(
  tracker: StartupReadTracker,
  manifestPath: string,
  homeDir: string,
  workspaceRoot: string | null,
  visited = new Set<string>(),
): Promise<ManifestDirEntry[]> {
  const resolved = path.resolve(manifestPath);
  if (visited.has(resolved)) return [];
  const parsed = await readTrackedJsonObject(tracker, resolved, "antigravity_json_manifest");
  if (!parsed) return [];
  visited.add(resolved);

  const out: ManifestDirEntry[] = [];
  const baseDir = path.dirname(path.dirname(resolved));

  if (Array.isArray(parsed.inherits)) {
    for (const item of parsed.inherits) {
      const rec = asRecord(item);
      const rawPath = asNonEmptyString(rec?.path);
      if (!rawPath) continue;
      const target = resolveManifestPath(rawPath, homeDir, baseDir, workspaceRoot);
      const inherited = await expandJsonManifest(tracker, target, homeDir, workspaceRoot, visited);
      out.push(...inherited);
    }
  }

  if (Array.isArray(parsed.entries)) {
    for (const item of parsed.entries) {
      const rec = asRecord(item);
      const rawPath = asNonEmptyString(rec?.path);
      if (!rawPath) continue;
      const target = resolveManifestPath(rawPath, homeDir, baseDir, workspaceRoot);
      const includeOnly = Array.isArray(rec?.include_only)
        ? rec.include_only.filter((v): v is string => typeof v === "string")
        : undefined;
      const exclude = Array.isArray(rec?.exclude)
        ? rec.exclude.filter((v): v is string => typeof v === "string")
        : undefined;
      out.push({ dir: target, includeOnly, exclude });
    }
  }

  return out;
}

function resolveManifestPath(
  raw: string,
  homeDir: string,
  dotParentDir: string,
  workspaceRoot: string | null,
): string {
  if (raw.startsWith("~/")) return path.resolve(homeDir, raw.slice(2));
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(workspaceRoot ?? dotParentDir, raw);
}

export function matchesManifestFilter(
  name: string,
  filter?: { includeOnly?: string[]; exclude?: string[] },
): boolean {
  if (!filter) return true;
  if (filter.includeOnly && filter.includeOnly.length > 0) {
    if (!filter.includeOnly.some((pat) => safePatternMatch(pat, name))) return false;
  }
  if (filter.exclude && filter.exclude.length > 0) {
    if (filter.exclude.some((pat) => safePatternMatch(pat, name))) return false;
  }
  return true;
}

function safePatternMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  try {
    return new RegExp(`^(?:${pattern})$`, "u").test(value);
  } catch {
    return false;
  }
}

export async function extractAntigravityIncludes(
  ownerPath: string,
  markdown: string,
  homeDir: string,
): Promise<AntigravityRuleEntry["includes"]> {
  const out: AntigravityRuleEntry["includes"] = [];
  const regex = /@\[([^\]]+)\]\(([^)\s]+)\)/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const label = match[1]!;
    const rawRef = match[2]!;
    const resolved = rawRef.startsWith("~/")
      ? path.resolve(homeDir, rawRef.slice(2))
      : path.resolve(path.dirname(ownerPath), rawRef);
    out.push({ label, raw_ref: rawRef, resolved_path: resolved, exists: await pathExists(resolved) });
  }
  return out;
}

export async function resolveSafeRealPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}
