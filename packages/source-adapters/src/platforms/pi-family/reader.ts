import path from "node:path";
import { asNumber, asString, isObject, safeJsonParse } from "../../core/type-guards.js";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";

/**
 * Pi / Oh My Pi shared session-file reader.
 *
 * Both tools persist one JSONL file per session under
 * `<agent-dir>/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl`.
 * Oh My Pi additionally starts the physical file with a fixed-width `title`
 * slot, appends `title_change` entries and may persist the active leaf on an
 * entry as `activeLeafId` (late usage can be the physically last row while the
 * conversation continues at an earlier leaf).
 *
 * Conversation evidence comes from the active branch only. Usage is different:
 * Pi/OMP native session totals aggregate every entry that was actually billed,
 * including compacted and abandoned branches, so non-active entries contribute
 * usage-only records with an independent identity.
 */

export type PiFamilyPlatform = "pi" | "oh_my_pi";

interface PiSeedDiagnostic {
  code: string;
  detail: string;
  severity?: "info" | "warning" | "error";
}

interface ParsedRecord {
  lineNumber: number;
  value: Record<string, unknown>;
}

export interface PiFamilyReadOptions {
  /** Whole-file capture ceiling already admitted by the runtime budget. */
  maxBytes?: number;
}

export interface PiFamilyReadResult {
  seed: ExtractedSessionSeed | undefined;
  diagnostics: PiSeedDiagnostic[];
}

const EVIDENCE_ONLY_ENTRY_TYPES = new Set([
  "label",
  "custom",
  "thinking_level_change",
  "service_tier_change",
  "ttsr_injection",
  "credential_pin",
  "session_init",
  "mode_change",
  "context_edit",
  "session_info",
]);

export function extractPiFamilySessionSeed(
  platform: PiFamilyPlatform,
  filePath: string,
  fileBuffer: Buffer,
  options: PiFamilyReadOptions = {},
): PiFamilyReadResult {
  const diagnostics: PiSeedDiagnostic[] = [];
  if (options.maxBytes !== undefined && fileBuffer.length > options.maxBytes) {
    diagnostics.push({
      code: "pi_family_file_too_large",
      detail: `Session file is ${fileBuffer.length} bytes, above the ${options.maxBytes}-byte read budget; only the header was admitted.`,
      severity: "warning",
    });
    return { seed: headerOnlySeed(platform, filePath, fileBuffer, diagnostics), diagnostics };
  }
  const records: ParsedRecord[] = [];
  const lines = fileBuffer.toString("utf8").split("\n");
  let lastNonEmptyLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim()) {
      lastNonEmptyLine = index;
    }
  }
  for (const [index, rawLine] of lines.entries()) {
    if (!rawLine.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(rawLine);
    } catch {
      const isTail = index === lastNonEmptyLine;
      diagnostics.push({
        code: isTail ? "pi_family_truncated_tail" : "pi_family_malformed_jsonl_record",
        detail: `Line ${index + 1} is not valid JSON${isTail ? " (truncated final record)" : ""}; it was kept only as a diagnostic.`,
        severity: "info",
      });
      continue;
    }
    if (!isObject(value)) {
      diagnostics.push({
        code: "pi_family_record_not_object",
        detail: `Line ${index + 1} is not a JSON object.`,
      });
      continue;
    }
    records.push({ lineNumber: index + 1, value });
  }

  const headerRecord = records.find((record) => record.value.type === "session");
  if (!headerRecord) {
    diagnostics.push({
      code: "pi_family_session_header_missing",
      detail: "The file has no session header; it is not projected as a session.",
    });
    return { seed: undefined, diagnostics };
  }
  const header = headerRecord.value;
  const titleSlot = [...records].reverse().find((record) => record.value.type === "title");
  const entries = records.filter((record) => record !== headerRecord && record.value.type !== "title");
  const version = asNumber(header.version) ?? 1;
  const activeEntries = selectActiveBranch(entries, version, diagnostics);
  const activeIds = new Set(
    activeEntries.map((entry) => asString(entry.value.id)).filter((id): id is string => id !== undefined),
  );

  const rawSessionId =
    asString(header.id) ??
    deriveSessionIdFromFileName(filePath) ??
    `session-${path.basename(filePath, ".jsonl")}`;
  const sessionId = `sess:${platform}:${rawSessionId}`;
  const workingDirectory = normalizeDirectory(asString(header.cwd));
  const headerTitle = asString(header.title)?.trim();
  const slotTitle = asString(titleSlot?.value.title)?.trim();
  const titleChanges = entries
    .filter((entry) => entry.value.type === "title_change")
    .map((entry) => asString(entry.value.title)?.trim())
    .filter((value): value is string => Boolean(value));
  const sessionInfoNames = entries
    .filter((entry) => entry.value.type === "session_info")
    .map((entry) => asString(entry.value.name)?.trim())
    .filter((value): value is string => Boolean(value));
  // Oh My Pi keeps the current title in the slot; Pi's `/name` lands in
  // session_info. Both are session-wide, independent of the active branch.
  const title = slotTitle || titleChanges.at(-1) || headerTitle || sessionInfoNames.at(-1);
  const rawParentSession = asString(header.parentSession);
  const parentSession = resolveParentSessionRef(rawParentSession);
  const nestedParent = nestedSessionParent(filePath);
  const taskPromptCacheKey = asString(header.taskPromptCacheKey);
  const delegated = platform === "oh_my_pi" && Boolean(nestedParent ?? taskPromptCacheKey);
  const startedAt = normalizeIso(asString(header.timestamp)) ?? firstEntryIso(activeEntries);

  const output: ExtractedSessionSeed["records"] = [];
  output.push({
    pointer: "session header",
    observedAt: startedAt,
    rawJson: JSON.stringify({
      kind: "session",
      id: rawSessionId,
      version,
      title,
      cwd: workingDirectory,
      parent_session: nestedParent ?? parentSession,
      parent_session_path: rawParentSession && (rawParentSession.includes("/") || rawParentSession.endsWith(".jsonl"))
        ? rawParentSession
        : undefined,
      delegated,
      taskPromptCacheKey,
      additional_directories: header.additionalDirectories,
    }),
  });

  for (const entry of activeEntries) {
    const entryType = asString(entry.value.type) ?? "unknown";
    const timestamp = normalizeIso(asString(entry.value.timestamp));
    if (entryType === "message" || entryType === "custom_message") {
      const message = entryType === "custom_message"
        ? {
            role: "custom",
            content: entry.value.content,
            customType: entry.value.customType,
            display: entry.value.display,
            timestamp: entry.value.timestamp,
          }
        : entry.value.message;
      output.push({
        pointer: `entry:${entry.lineNumber}`,
        observedAt: timestamp,
        rawJson: JSON.stringify({
          kind: "message",
          entry_id: asString(entry.value.id),
          parent_id: asString(entry.value.parentId),
          timestamp,
          message,
        }),
      });
      continue;
    }
    if (entryType === "model_change") {
      output.push({
        pointer: `entry:${entry.lineNumber}`,
        observedAt: timestamp,
        rawJson: JSON.stringify({
          kind: "model_change",
          entry_id: asString(entry.value.id),
          model: asString(entry.value.modelId) ?? asString(entry.value.model),
          provider: asString(entry.value.provider),
          role: asString(entry.value.role),
        }),
      });
      continue;
    }
    if (entryType === "usage" || entryType === "model_usage") {
      output.push({
        pointer: `entry:${entry.lineNumber}`,
        observedAt: timestamp,
        rawJson: JSON.stringify({
          kind: "usage",
          entry_id: asString(entry.value.id),
          purpose: asString(entry.value.purpose) ?? asString(entry.value.kind),
          role: asString(entry.value.role),
          provider: asString(entry.value.provider),
          model: asString(entry.value.model),
          usage: entry.value.usage,
          stop_reason: asString(entry.value.stopReason),
        }),
      });
      continue;
    }
    if (entryType === "compaction" || entryType === "branch_summary") {
      output.push({
        pointer: `entry:${entry.lineNumber}`,
        observedAt: timestamp,
        rawJson: JSON.stringify({
          kind: entryType,
          entry_id: asString(entry.value.id),
          summary: asString(entry.value.summary),
          usage: entry.value.usage,
          first_kept_entry_id: asString(entry.value.firstKeptEntryId),
        }),
      });
      continue;
    }
    if (entryType === "title_change") {
      const nextTitle = asString(entry.value.title)?.trim();
      if (nextTitle) {
        output.push({
          pointer: `entry:${entry.lineNumber}`,
          observedAt: timestamp,
          rawJson: JSON.stringify({ kind: "title", entry_id: asString(entry.value.id), title: nextTitle }),
        });
      }
      continue;
    }
    if (entryType === "reset_boundary") {
      output.push({
        pointer: `entry:${entry.lineNumber}`,
        observedAt: timestamp,
        rawJson: JSON.stringify({ kind: "reset_boundary", entry_id: asString(entry.value.id) }),
      });
      continue;
    }
    if (!EVIDENCE_ONLY_ENTRY_TYPES.has(entryType)) {
      diagnostics.push({
        code: "pi_family_unhandled_entry_type",
        detail: `Unhandled Pi/OMP entry type ${entryType}; kept only as a diagnostic.`,
        severity: "info",
      });
    }
  }

  // Native totals include compacted-away and abandoned-branch calls. Emit
  // usage-only records for every offset entry that the active branch skipped.
  for (const entry of entries) {
    const entryId = asString(entry.value.id);
    if (entryId && activeIds.has(entryId)) {
      continue;
    }
    appendInactiveUsage(entry, platform, output, diagnostics);
  }

  const lastActivity = lastMessageIso(activeEntries) ?? startedAt;
  return {
    seed: {
      sessionId,
      ...(title ? { title } : {}),
      ...(startedAt ? { createdAt: startedAt } : {}),
      ...(lastActivity ? { updatedAt: lastActivity } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(rawParentSession && (rawParentSession.includes("/") || rawParentSession.endsWith(".jsonl"))
        ? { parent_session_path: rawParentSession }
        : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      records: output,
    },
    diagnostics,
  };
}

function appendInactiveUsage(
  entry: ParsedRecord,
  _platform: PiFamilyPlatform,
  output: ExtractedSessionSeed["records"],
  diagnostics: PiSeedDiagnostic[],
): void {
  const entryType = asString(entry.value.type);
  const timestamp = normalizeIso(asString(entry.value.timestamp));
  const pushUsage = (usage: unknown, model: string | undefined, purpose: string): void => {
    if (!isObject(usage)) {
      return;
    }
    output.push({
      pointer: `inactive-usage:${entry.lineNumber}`,
      observedAt: timestamp,
      rawJson: JSON.stringify({
        kind: "usage",
        usage,
        model,
        purpose,
        entry_id: asString(entry.value.id),
        timestamp,
      }),
    });
  };
  if (entryType === "message" || entryType === "custom_message") {
    const message = entryType === "message" ? entry.value.message : undefined;
    if (isObject(message)) {
      const role = asString(message.role);
      if (role === "assistant" || role === "toolResult") {
        pushUsage(
          message.usage,
          asString(message.model) ?? asString(message.responseModel),
          role === "assistant" ? "inactive_assistant" : "inactive_tool",
        );
      }
    }
    return;
  }
  if (entryType === "usage" || entryType === "model_usage") {
    pushUsage(entry.value.usage, asString(entry.value.model), asString(entry.value.purpose) ?? "inactive_usage");
    return;
  }
  if (entryType === "compaction" || entryType === "branch_summary") {
    pushUsage(entry.value.usage, undefined, entryType);
    return;
  }
  if (entryType !== undefined && !EVIDENCE_ONLY_ENTRY_TYPES.has(entryType)) {
    diagnostics.push({
      code: "pi_family_unhandled_inactive_entry",
      detail: `Unhandled inactive ${entryType} entry; kept only as a diagnostic.`,
      severity: "info",
    });
  }
}

function selectActiveBranch(
  entries: readonly ParsedRecord[],
  version: number,
  diagnostics: PiSeedDiagnostic[],
): ParsedRecord[] {
  if (version < 2 || entries.length === 0) {
    return [...entries];
  }
  const byId = new Map<string, ParsedRecord>();
  for (const entry of entries) {
    const id = asString(entry.value.id);
    if (id) {
      byId.set(id, entry);
    }
  }
  // Oh My Pi persists the active leaf on late entries (background usage can be
  // the physically last row). The newest explicit activeLeafId wins.
  let leafId: string | undefined;
  let leafWasExplicit = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || !Object.prototype.hasOwnProperty.call(entry.value, "activeLeafId")) {
      continue;
    }
    leafWasExplicit = true;
    const rawLeaf = entry.value.activeLeafId;
    if (rawLeaf === null) {
      return [];
    }
    leafId = asString(rawLeaf);
    break;
  }
  if (!leafWasExplicit) {
    leafId = asString(entries.at(-1)?.value.id);
  }
  if (!leafId || !byId.has(leafId)) {
    diagnostics.push({
      code: "pi_family_active_leaf_missing",
      detail: `Active leaf ${leafId ?? "<unknown>"} is not present in the file; the file was projected in file order.`,
    });
    return [...entries];
  }
  const chain: ParsedRecord[] = [];
  const seen = new Set<string>();
  let cursorId: string | undefined = leafId;
  while (cursorId) {
    if (seen.has(cursorId)) {
      diagnostics.push({
        code: "pi_family_parent_cycle",
        detail: `Entry parent chain cycles at ${cursorId}; the file was projected in file order.`,
      });
      return [...entries];
    }
    seen.add(cursorId);
    const entry = byId.get(cursorId);
    if (!entry) {
      diagnostics.push({
        code: "pi_family_parent_missing",
        detail: `Entry ${cursorId} is missing from the file; the file was projected in file order.`,
      });
      return [...entries];
    }
    chain.push(entry);
    const parentId = asString(entry.value.parentId);
    cursorId = parentId && parentId.length > 0 ? parentId : undefined;
  }
  return chain.reverse();
}

function firstEntryIso(entries: readonly ParsedRecord[]): string | undefined {
  for (const entry of entries) {
    const iso = normalizeIso(asString(entry.value.timestamp));
    if (iso) {
      return iso;
    }
  }
  return undefined;
}

function lastMessageIso(entries: readonly ParsedRecord[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const type = asString(entry.value.type);
    if (type !== "message" && type !== "custom_message") {
      continue;
    }
    const message = entry.value.message;
    if (isObject(message)) {
      const millis = asNumber(message.timestamp);
      if (millis !== undefined) {
        const date = new Date(millis);
        if (!Number.isNaN(date.getTime())) {
          return date.toISOString();
        }
      }
    }
    const iso = normalizeIso(asString(entry.value.timestamp));
    if (iso) {
      return iso;
    }
  }
  return undefined;
}

/**
 * OMP nests subagent transcripts under `<bucket>/<timestamp>_<parent-id>/`.
 * The directory name is durable delegation evidence even when the child header
 * has no `taskPromptCacheKey` (that key is only written after a shared-cache
 * request).
 */
function nestedSessionParent(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/gu, "/");
  const match = normalized.match(/\/sessions\/[^/]+\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_([^/]+)\/[^/]+\.jsonl$/u);
  return match?.[1] ?? undefined;
}

/**
 * OMP writes either a session id or the parent session file path into
 * `parentSession`. The path form must be reduced to the same native id the
 * parent file's header uses, or the lineage cannot resolve in the snapshot.
 */
function resolveParentSessionRef(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\\/gu, "/");
  if (!normalized.includes("/") && !normalized.endsWith(".jsonl")) {
    return value;
  }
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.jsonl$/u, "");
  const separator = base.indexOf("_");
  if (separator > 0 && base.slice(0, separator).includes("-")) {
    return base.slice(separator + 1) || base;
  }
  return base || value;
}

function deriveSessionIdFromFileName(filePath: string): string | undefined {
  const base = path.basename(filePath, ".jsonl");
  const separator = base.indexOf("_");
  if (separator > 0 && base.slice(0, separator).includes("-")) {
    return base.slice(separator + 1) || undefined;
  }
  return base || undefined;
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeDirectory(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\\/gu, "/").replace(/\/+$/u, "") || "/";
}

export function isPiFamilySessionFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");
  return normalized.includes("/agent/sessions/") && normalized.endsWith(".jsonl");
}

export function parsePiFamilyRecordJson(raw: string | undefined): Record<string, unknown> | undefined {
  const parsed = safeJsonParse(raw);
  return isObject(parsed) ? parsed : undefined;
}

function headerOnlySeed(
  platform: PiFamilyPlatform,
  filePath: string,
  fileBuffer: Buffer,
  diagnostics: PiSeedDiagnostic[],
): ExtractedSessionSeed | undefined {
  const headerLine = fileBuffer.toString("utf8").split("\n", 1)[0];
  const header = safeJsonParse(headerLine);
  if (!isObject(header) || header.type !== "session") {
    return undefined;
  }
  const rawSessionId = asString(header.id) ?? deriveSessionIdFromFileName(filePath);
  if (!rawSessionId) {
    return undefined;
  }
  const timestamp = normalizeIso(asString(header.timestamp));
  return {
    sessionId: `sess:${platform}:${rawSessionId}`,
    ...(asString(header.title) ? { title: asString(header.title) } : {}),
    ...(timestamp ? { createdAt: timestamp } : {}),
    ...(normalizeDirectory(asString(header.cwd)) ? { workingDirectory: normalizeDirectory(asString(header.cwd)) } : {}),
    diagnostics,
    records: [{
      pointer: "session header",
      observedAt: timestamp,
      rawJson: JSON.stringify({ kind: "session", id: rawSessionId, ...(header.title ? { title: header.title } : {}) }),
    }],
  };
}
