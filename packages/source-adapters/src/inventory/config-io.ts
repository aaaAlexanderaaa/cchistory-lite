/**
 * Role: Bounded read-only filesystem helpers, JSON/JSONC/TOML config loaders, and
 * MCP/extension entry extractors shared across per-client agent inventory scanners.
 * Excludes per-client directory layout knowledge (owned by agent-config-reader.ts).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentConfigScope,
  AgentExtensionEntry,
  AgentExtensionKind,
  AgentInventoryClient,
  AgentInventoryDiagnostic,
  McpServerConfigEntry,
  McpTransportKind,
} from "@cchistory/domain";
import { extractSecretKeyNames, redactMcpCommand, redactMcpUrl } from "./redaction.js";
import { parseToml, TomlParseError } from "./toml.js";

export const DEFAULT_MAX_CONFIG_FILE_BYTES = 1_048_576;
const MAX_DIR_ENTRIES = 500;
const IGNORED_ENTRY_NAMES = new Set([".DS_Store", "README.md", "README", ".gitkeep", "Thumbs.db"]);

export interface ClientAccumulator {
  client: AgentInventoryClient;
  display_name: string;
  installed: boolean;
  configured: boolean;
  config_paths: Set<string>;
}

export interface InventoryScanContext {
  homeDir: string;
  projectDir: string | null;
  env: NodeJS.ProcessEnv;
  maxFileBytes: number;
  clients: Map<AgentInventoryClient, ClientAccumulator>;
  mcpServers: McpServerConfigEntry[];
  mcpSeenKeys: Set<string>;
  extensions: AgentExtensionEntry[];
  extensionSeenKeys: Set<string>;
  diagnostics: AgentInventoryDiagnostic[];
}

export function extractMcpServersRecord(
  ctx: InventoryScanContext,
  client: AgentInventoryClient,
  scope: AgentConfigScope,
  sourcePath: string,
  servers: Record<string, unknown> | undefined,
): void {
  if (!servers) return;
  for (const [serverId, rawConfig] of Object.entries(servers)) {
    const rec = asRecord(rawConfig);
    if (!rec) continue;
    const normalizedId = serverId.trim();
    if (!normalizedId) continue;

    const dedupeKey = `${client}\0${scope}\0${normalizedId}\0${sourcePath}`;
    if (ctx.mcpSeenKeys.has(dedupeKey)) continue;
    ctx.mcpSeenKeys.add(dedupeKey);

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

    const transport = inferMcpTransport(rec, rawUrl, commandStr);
    const redactedCommand = redactMcpCommand(commandStr, argsList);
    const redactedUrl = redactMcpUrl(rawUrl);
    const envKeys = extractSecretKeyNames(rec.env ?? rec.environment);
    const headerKeys = extractSecretKeyNames(rec.headers ?? rec.http_headers ?? rec.env_http_headers);
    const enabled = rec.enabled === false || rec.disabled === true ? false : true;

    markConfigured(ctx, client, sourcePath);
    ctx.mcpServers.push({
      server_id: normalizedId,
      client,
      scope,
      transport,
      ...(redactedCommand ? { command: redactedCommand, args_count: argsList.length } : {}),
      ...(redactedUrl ? { url: redactedUrl } : {}),
      env_keys: envKeys,
      ...(headerKeys.length > 0 ? { header_keys: headerKeys } : {}),
      enabled,
      source_path: sourcePath,
    });
  }
}

function inferMcpTransport(
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

export function extractNamedObjectExtensions(
  ctx: InventoryScanContext,
  client: AgentInventoryClient,
  kind: AgentExtensionKind,
  scope: AgentConfigScope,
  sourcePath: string,
  record: Record<string, unknown> | undefined,
): void {
  if (!record) return;
  for (const [name, value] of Object.entries(record)) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const enabled =
      typeof value === "boolean"
        ? value
        : asRecord(value)?.enabled === false || asRecord(value)?.disabled === true
          ? false
          : true;
    addExtension(ctx, { kind, name: trimmed, client, scope, enabled, source_path: sourcePath });
  }
}

export function extractBooleanPluginMap(
  ctx: InventoryScanContext,
  client: AgentInventoryClient,
  scope: AgentConfigScope,
  sourcePath: string,
  record: Record<string, unknown> | undefined,
): void {
  if (!record) return;
  for (const [name, value] of Object.entries(record)) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    addExtension(ctx, {
      kind: "plugin",
      name: trimmed,
      client,
      scope,
      enabled: value !== false,
      source_path: sourcePath,
    });
  }
}

export async function scanExtensionDirectory(
  ctx: InventoryScanContext,
  client: AgentInventoryClient,
  kind: AgentExtensionKind,
  scope: AgentConfigScope,
  dirPath: string,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    ctx.diagnostics.push({
      code: "inventory_dir_unreadable",
      severity: "warning",
      client,
      path: dirPath,
      detail: formatFsError(error),
    });
    return;
  }

  markInstalled(ctx, client);
  let count = 0;
  for (const entry of entries) {
    if (count >= MAX_DIR_ENTRIES) {
      ctx.diagnostics.push({
        code: "inventory_dir_truncated",
        severity: "info",
        client,
        path: dirPath,
        detail: `Stopped after ${MAX_DIR_ENTRIES} entries in ${dirPath}.`,
      });
      break;
    }
    if (entry.name.startsWith(".") || IGNORED_ENTRY_NAMES.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue;
    count += 1;
    const displayName = entry.isFile() ? stripKnownExtension(entry.name) : entry.name;
    if (!displayName) continue;
    addExtension(ctx, {
      kind,
      name: displayName,
      client,
      scope,
      source_path: path.join(dirPath, entry.name),
    });
  }
}

export async function recordSingleRuleFile(
  ctx: InventoryScanContext,
  client: AgentInventoryClient,
  scope: AgentConfigScope,
  filePath: string,
): Promise<void> {
  if (!(await pathExists(filePath))) return;
  addExtension(ctx, {
    kind: "rule",
    name: path.basename(filePath),
    client,
    scope,
    source_path: filePath,
  });
}

export function addExtension(ctx: InventoryScanContext, entry: Omit<AgentExtensionEntry, "id">): void {
  const dedupeKey = `${entry.kind}\0${entry.client}\0${entry.scope}\0${entry.name.toLowerCase()}`;
  if (ctx.extensionSeenKeys.has(dedupeKey)) return;
  ctx.extensionSeenKeys.add(dedupeKey);
  markConfigured(ctx, entry.client, entry.source_path);
  ctx.extensions.push({
    id: `${entry.client}:${entry.kind}:${entry.scope}:${entry.name}`,
    ...entry,
  });
}

export async function readTomlConfig(
  ctx: InventoryScanContext,
  client: AgentInventoryClient,
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const content = await readBoundedTextFile(ctx, client, filePath);
  if (content === undefined) return undefined;
  markConfigured(ctx, client, filePath);
  try {
    return parseToml(content);
  } catch (error) {
    ctx.diagnostics.push({
      code: "inventory_toml_parse_failed",
      severity: "warning",
      client,
      path: filePath,
      detail: error instanceof TomlParseError ? error.message : formatFsError(error),
    });
    return undefined;
  }
}

export async function readJsonConfig(
  ctx: InventoryScanContext,
  client: AgentInventoryClient,
  filePath: string,
  allowJsonc = false,
): Promise<Record<string, unknown> | undefined> {
  const content = await readBoundedTextFile(ctx, client, filePath);
  if (content === undefined) return undefined;
  markConfigured(ctx, client, filePath);
  try {
    const cleaned = allowJsonc ? stripJsoncCommentsAndTrailingCommas(content) : content;
    const parsed: unknown = JSON.parse(cleaned);
    const rec = asRecord(parsed);
    if (!rec) {
      ctx.diagnostics.push({
        code: "inventory_json_not_object",
        severity: "warning",
        client,
        path: filePath,
        detail: "Expected a top-level JSON object.",
      });
      return undefined;
    }
    return rec;
  } catch (error) {
    ctx.diagnostics.push({
      code: "inventory_json_parse_failed",
      severity: "warning",
      client,
      path: filePath,
      detail: formatFsError(error),
    });
    return undefined;
  }
}

export async function readBoundedTextFile(
  ctx: InventoryScanContext,
  client: AgentInventoryClient,
  filePath: string,
): Promise<string | undefined> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    ctx.diagnostics.push({
      code: "inventory_file_unreadable",
      severity: "warning",
      client,
      path: filePath,
      detail: formatFsError(error),
    });
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  if (stats.size > ctx.maxFileBytes) {
    ctx.diagnostics.push({
      code: "inventory_file_too_large",
      severity: "warning",
      client,
      path: filePath,
      detail: `Skipped config file (${stats.size} bytes exceeds ${ctx.maxFileBytes}-byte limit).`,
    });
    return undefined;
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    ctx.diagnostics.push({
      code: "inventory_file_unreadable",
      severity: "warning",
      client,
      path: filePath,
      detail: formatFsError(error),
    });
    return undefined;
  }
}

function stripJsoncCommentsAndTrailingCommas(input: string): string {
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

export function markInstalled(ctx: InventoryScanContext, client: AgentInventoryClient): void {
  const acc = ctx.clients.get(client);
  if (acc) acc.installed = true;
}

export function markConfigured(ctx: InventoryScanContext, client: AgentInventoryClient, configPath: string): void {
  const acc = ctx.clients.get(client);
  if (!acc) return;
  acc.installed = true;
  acc.configured = true;
  acc.config_paths.add(configPath);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripKnownExtension(fileName: string): string {
  return fileName.replace(/\.(?:md|markdown|txt|json|jsonc|toml|ya?ml|mjs|cjs|js|ts|sh)$/iu, "");
}

export function normalizeComparablePath(value: string): string {
  return path.resolve(value).replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

export function uniquePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function formatFsError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
