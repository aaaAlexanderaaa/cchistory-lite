/**
 * Role: Shared read-only filesystem, ancestor-chain, YAML frontmatter, JSONC, and
 * bounded file-reading helpers used by the 5 native per-tool startup resolvers.
 * Excludes tool-specific precedence logic (owned by each per-tool resolver module).
 */

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentInventoryClient,
  AgentInventoryDiagnostic,
  McpServerConfigEntry,
  McpTransportKind,
  ResolvedMcpServerState,
  StartupLoadedFileRef,
} from "@cchistory/domain";
import { extractSecretKeyNames, redactMcpCommand, redactMcpUrl } from "../redaction.js";
import { parseToml, TomlParseError } from "../toml.js";

const execFile = promisify(execFileCallback);

export const STARTUP_MAX_FILE_BYTES = 1_048_576;
export const STARTUP_MAX_DIR_ENTRIES = 500;
const IGNORED_NAMES = new Set([".DS_Store", "README.md", "README", ".gitkeep", "Thumbs.db"]);

export interface NativeStartupResolverInput {
  homeDir: string;
  projectDir: string | null;
  gitRoot: string | null;
  /** Directories ordered from repository root (or projectDir) down to projectDir. */
  ancestorDirsRootToCwd: string[];
  env: NodeJS.ProcessEnv;
  /** True when --home was explicitly set (prevents leaking host OS system paths). */
  isolatedHome: boolean;
}

export interface StartupReadTracker {
  client: AgentInventoryClient;
  filesRead: StartupLoadedFileRef[];
  seenFiles: Set<string>;
  diagnostics: AgentInventoryDiagnostic[];
}

export function createReadTracker(client: AgentInventoryClient): StartupReadTracker {
  return { client, filesRead: [], seenFiles: new Set(), diagnostics: [] };
}

export function estimateTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}

export async function resolveOfflineGitRoot(projectDir: string | null): Promise<string | null> {
  if (!projectDir || !(await pathExists(projectDir))) return null;
  try {
    const { stdout } = await execFile("git", ["-C", projectDir, "rev-parse", "--show-toplevel"], {
      timeout: 1_500,
      maxBuffer: 32 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    const resolved = stdout.trim();
    if (!resolved) return null;
    const realGitRoot = path.resolve(resolved);
    const lexicalProject = path.resolve(projectDir);
    const realProject = await fs.realpath(lexicalProject).catch(() => lexicalProject);
    const rel = path.relative(realGitRoot, realProject);
    if (rel === "") return lexicalProject;
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      const depth = rel.split(path.sep).filter(Boolean).length;
      let candidate = lexicalProject;
      for (let i = 0; i < depth; i += 1) candidate = path.dirname(candidate);
      if ((await fs.realpath(candidate).catch(() => candidate)) === realGitRoot) return candidate;
    }
    return realGitRoot;
  } catch {
    return null;
  }
}

export function buildAncestorChainRootToCwd(projectDir: string | null, gitRoot: string | null): string[] {
  if (!projectDir) return [];
  const cwd = path.resolve(projectDir);
  if (!gitRoot) return [cwd];
  const root = path.resolve(gitRoot);
  const rel = path.relative(root, cwd);
  if (rel === "") return [root];
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [cwd];
  const chain: string[] = [root];
  let cursor = root;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    chain.push(cursor);
  }
  return chain;
}

export async function readTrackedTextFile(
  tracker: StartupReadTracker,
  filePath: string,
  role: string,
  maxBytes = STARTUP_MAX_FILE_BYTES,
): Promise<{ content: string; sizeBytes: number } | undefined> {
  const resolved = path.resolve(filePath);
  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    tracker.diagnostics.push({
      code: "startup_file_unreadable",
      severity: "warning",
      client: tracker.client,
      path: resolved,
      detail: formatErr(error),
    });
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  recordFileRead(tracker, resolved, stats.size, role);
  if (stats.size > maxBytes) {
    tracker.diagnostics.push({
      code: "startup_file_too_large",
      severity: "warning",
      client: tracker.client,
      path: resolved,
      detail: `Skipped reading full body (${stats.size} bytes exceeds ${maxBytes}-byte bound).`,
    });
    return { content: "", sizeBytes: stats.size };
  }
  try {
    const content = await fs.readFile(resolved, "utf8");
    return { content, sizeBytes: stats.size };
  } catch (error) {
    tracker.diagnostics.push({
      code: "startup_file_unreadable",
      severity: "warning",
      client: tracker.client,
      path: resolved,
      detail: formatErr(error),
    });
    return undefined;
  }
}

export async function readTrackedJsonObject(
  tracker: StartupReadTracker,
  filePath: string,
  role: string,
  allowJsonc = false,
): Promise<Record<string, unknown> | undefined> {
  const file = await readTrackedTextFile(tracker, filePath, role);
  if (!file || !file.content) return undefined;
  try {
    const text = allowJsonc ? stripJsonc(file.content) : file.content;
    const parsed: unknown = JSON.parse(text);
    const rec = asRecord(parsed);
    if (!rec) {
      tracker.diagnostics.push({
        code: "startup_json_not_object",
        severity: "warning",
        client: tracker.client,
        path: path.resolve(filePath),
        detail: "Expected a top-level JSON object.",
      });
      return undefined;
    }
    return rec;
  } catch (error) {
    tracker.diagnostics.push({
      code: "startup_json_parse_failed",
      severity: "warning",
      client: tracker.client,
      path: path.resolve(filePath),
      detail: formatErr(error),
    });
    return undefined;
  }
}

export async function readTrackedTomlObject(
  tracker: StartupReadTracker,
  filePath: string,
  role: string,
): Promise<Record<string, unknown> | undefined> {
  const file = await readTrackedTextFile(tracker, filePath, role);
  if (!file || !file.content) return undefined;
  try {
    return parseToml(file.content);
  } catch (error) {
    tracker.diagnostics.push({
      code: "startup_toml_parse_failed",
      severity: "warning",
      client: tracker.client,
      path: path.resolve(filePath),
      detail: error instanceof TomlParseError ? error.message : formatErr(error),
    });
    return undefined;
  }
}

export interface SimpleFrontmatter {
  scalars: Record<string, string>;
  lists: Record<string, string[]>;
  body: string;
}

/**
 * Lightweight YAML frontmatter parser for `SKILL.md`, `.claude/rules/*.md`,
 * `.claude/agents/*.md`, and Antigravity rule files. Handles `key: value`,
 * inline `[a, b]` arrays, and `- item` block lists without external deps.
 */
export function parseMarkdownFrontmatter(content: string): SimpleFrontmatter {
  const normalized = content.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    return { scalars: {}, lists: {}, body: normalized };
  }
  const endIdx = normalized.indexOf("\n---", 4);
  if (endIdx === -1) {
    return { scalars: {}, lists: {}, body: normalized };
  }
  const yamlBlock = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 4).replace(/^\n/u, "");
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};

  let currentListKey: string | null = null;
  let currentBlockScalarKey: string | null = null;

  for (const rawLine of yamlBlock.split("\n")) {
    if (currentBlockScalarKey) {
      if (rawLine.startsWith("  ") || rawLine.startsWith("\t") || rawLine.trim() === "") {
        const piece = rawLine.trim();
        scalars[currentBlockScalarKey] = scalars[currentBlockScalarKey]
          ? `${scalars[currentBlockScalarKey]} ${piece}`.trim()
          : piece;
        continue;
      }
      currentBlockScalarKey = null;
    }

    const listMatch = /^\s*-\s+(.+)$/u.exec(rawLine);
    if (listMatch && currentListKey) {
      const val = unquoteYamlScalar(listMatch[1]!.trim());
      if (val) (lists[currentListKey] ??= []).push(val);
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(rawLine.trim());
    if (!kvMatch) {
      currentListKey = null;
      continue;
    }
    const key = kvMatch[1]!;
    const rawVal = kvMatch[2]!.trim();
    currentListKey = null;

    if (rawVal === "" || rawVal === "[]") {
      if (rawVal === "") currentListKey = key;
      lists[key] = lists[key] ?? [];
      continue;
    }
    if (rawVal === ">" || rawVal === ">-" || rawVal === "|" || rawVal === "|-") {
      currentBlockScalarKey = key;
      scalars[key] = "";
      continue;
    }
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      const items = rawVal
        .slice(1, -1)
        .split(",")
        .map((s) => unquoteYamlScalar(s.trim()))
        .filter(Boolean);
      lists[key] = items;
      continue;
    }
    scalars[key] = unquoteYamlScalar(rawVal);
  }

  return { scalars, lists, body };
}

export function buildRedactedMcpEntry(
  client: AgentInventoryClient,
  scope: "user" | "project",
  sourcePath: string,
  serverId: string,
  rec: Record<string, unknown>,
): McpServerConfigEntry {
  const rawUrl = asNonEmptyString(rec.url) ?? asNonEmptyString(rec.serverUrl) ?? asNonEmptyString(rec.httpUrl);
  const rawCommand = rec.command;
  let commandStr: string | undefined;
  let argsList: string[] = [];

  if (Array.isArray(rawCommand)) {
    const parts = rawCommand.filter((entry): entry is string => typeof entry === "string");
    commandStr = parts[0];
    argsList = parts.slice(1);
  } else if (typeof rawCommand === "string" && rawCommand.trim()) {
    commandStr = rawCommand.trim();
    if (Array.isArray(rec.args)) {
      argsList = rec.args.filter((entry): entry is string => typeof entry === "string");
    }
  }

  const transport = inferTransport(rec, rawUrl, commandStr);
  const redactedCommand = redactMcpCommand(commandStr, argsList);
  const redactedUrl = redactMcpUrl(rawUrl);
  const envKeys = extractSecretKeyNames(rec.env ?? rec.environment);
  const headerKeys = extractSecretKeyNames(rec.headers ?? rec.http_headers ?? rec.env_http_headers);
  const enabled = rec.enabled === false || rec.disabled === true ? false : true;

  return {
    server_id: serverId.trim(),
    client,
    scope,
    transport,
    ...(redactedCommand ? { command: redactedCommand, args_count: argsList.length } : {}),
    ...(redactedUrl ? { url: redactedUrl } : {}),
    env_keys: envKeys,
    ...(headerKeys.length > 0 ? { header_keys: headerKeys } : {}),
    enabled,
    source_path: sourcePath,
  };
}

function inferTransport(
  rec: Record<string, unknown>,
  rawUrl: string | undefined,
  commandStr: string | undefined,
): McpTransportKind {
  const declared = (asNonEmptyString(rec.transport) ?? asNonEmptyString(rec.type))?.toLowerCase();
  if (declared === "stdio" || declared === "local" || declared === "command") return "stdio";
  if (declared === "sse") return "sse";
  if (declared === "http" || declared === "streamable-http" || declared === "streamable_http" || declared === "remote") {
    return rawUrl && /\/sse(?:[/?#]|$)/iu.test(rawUrl) ? "sse" : "http";
  }
  if (rawUrl) return /\/sse(?:[/?#]|$)/iu.test(rawUrl) ? "sse" : "http";
  if (commandStr) return "stdio";
  return "unknown";
}

export async function listSkillEntriesInDir(
  tracker: StartupReadTracker,
  dirPath: string,
): Promise<Array<{ name: string; path: string; description?: string }>> {
  const entries = await safeReadDir(tracker, dirPath);
  const out: Array<{ name: string; path: string; description?: string }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED_NAMES.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const skillMd = path.join(fullPath, "SKILL.md");
      const file = await readTrackedTextFile(tracker, skillMd, "skill");
      if (file) {
        const fm = parseMarkdownFrontmatter(file.content);
        out.push({
          name: fm.scalars.name || entry.name,
          path: skillMd,
          ...(fm.scalars.description ? { description: fm.scalars.description } : {}),
        });
      } else {
        out.push({ name: entry.name, path: fullPath });
      }
    } else if (entry.isFile() && /\.(?:md|markdown)$/iu.test(entry.name)) {
      const file = await readTrackedTextFile(tracker, fullPath, "skill");
      const fm = file ? parseMarkdownFrontmatter(file.content) : undefined;
      out.push({
        name: fm?.scalars.name || entry.name.replace(/\.(?:md|markdown)$/iu, ""),
        path: fullPath,
        ...(fm?.scalars.description ? { description: fm.scalars.description } : {}),
      });
    }
  }
  return out;
}

export async function safeReadDir(tracker: StartupReadTracker, dirPath: string) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.slice(0, STARTUP_MAX_DIR_ENTRIES);
  } catch (error) {
    if (isEnoent(error)) return [];
    tracker.diagnostics.push({
      code: "startup_dir_unreadable",
      severity: "warning",
      client: tracker.client,
      path: path.resolve(dirPath),
      detail: formatErr(error),
    });
    return [];
  }
}

export function recordFileRead(tracker: StartupReadTracker, resolvedPath: string, sizeBytes: number, role: string): void {
  if (tracker.seenFiles.has(resolvedPath)) return;
  tracker.seenFiles.add(resolvedPath);
  tracker.filesRead.push({ path: resolvedPath, size_bytes: sizeBytes, role });
}

export function stripJsonc(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      if (i < input.length) out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/gu, "$1");
}

function unquoteYamlScalar(raw: string): string {
  return (raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))
    ? raw.slice(1, -1)
    : raw;
}

export async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeComparablePath(value: string): string {
  return path.resolve(value).replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

export function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

export function formatErr(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stripMcpResolutionFields(entry: ResolvedMcpServerState): McpServerConfigEntry {
  return {
    server_id: entry.server_id,
    client: entry.client,
    scope: entry.scope,
    transport: entry.transport,
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.args_count !== undefined ? { args_count: entry.args_count } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    env_keys: entry.env_keys,
    ...(entry.header_keys !== undefined ? { header_keys: entry.header_keys } : {}),
    enabled: entry.enabled,
    source_path: entry.source_path,
  };
}
