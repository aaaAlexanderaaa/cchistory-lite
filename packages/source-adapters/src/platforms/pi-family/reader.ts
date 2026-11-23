import path from "node:path";
import { asNumber, asString, isObject, safeJsonParse } from "../../core/type-guards.js";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";

/**
 * Pi / Oh My Pi shared session-file reader.
 *
 * Both tools persist one JSONL file per session under
 * `<agent-dir>/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl`.
 * Oh My Pi additionally starts the physical file with a fixed-width `title`
 * slot and appends `title_change` entries; Pi v3 and older files start with
 * the `session` header.
 *
 * Entries form a tree (`id`/`parentId`), so only the active branch is
 * projected: the last entry is the leaf, and walking `parentId` yields the
 * live conversation. Abandoned branches stay in the file as raw evidence.
 */

export type PiFamilyPlatform = "pi" | "oh_my_pi";

interface PiSeedDiagnostic {
  code: string;
  detail: string;
  severity?: "info" | "warning" | "error";
}

interface ParsedRecord {
  lineNumber: number;
  rawLine: string;
  value: Record<string, unknown>;
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
]);

export function extractPiFamilySessionSeed(
  platform: PiFamilyPlatform,
  filePath: string,
  fileBuffer: Buffer,
): PiFamilyReadResult {
  const diagnostics: PiSeedDiagnostic[] = [];
  const records: ParsedRecord[] = [];
  const lines = fileBuffer.toString("utf8").split("\n");
  for (const [index, rawLine] of lines.entries()) {
    if (!rawLine.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(rawLine);
    } catch {
      const isTail = index === lines.length - 1 || lines.slice(index + 1).every((line) => !line.trim());
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
    records.push({ lineNumber: index + 1, rawLine, value });
  }

  const headerRecord = records.find((record) => record.value.type === "session");
  const header = headerRecord?.value;
  const titleSlot = [...records].reverse().find((record) => record.value.type === "title");
  const entries = records.filter((record) => record !== headerRecord && record.value.type !== "title");

  const version = asNumber(header?.version) ?? 1;
  const activeEntries = selectActiveBranch(entries, version, diagnostics);

  const rawSessionId =
    asString(header?.id) ??
    deriveSessionIdFromFileName(filePath) ??
    `session-${path.basename(filePath, ".jsonl")}`;
  const sessionId = `sess:${platform}:${rawSessionId}`;
  const workingDirectory = normalizeDirectory(asString(header?.cwd));
  const headerTitle = asString(header?.title)?.trim();
  const slotTitle = asString(titleSlot?.value.title)?.trim();
  const titleChanges = activeEntries
    .filter((record) => record.value.type === "title_change")
    .map((record) => asString(record.value.title)?.trim())
    .filter((value): value is string => Boolean(value));
  const title = headerTitle || slotTitle || titleChanges.at(-1);
  const parentSession = resolveParentSessionRef(asString(header?.parentSession));
  const taskPromptCacheKey = asString(header?.taskPromptCacheKey);
  const startedAt =
    normalizeIso(asString(header?.timestamp)) ??
    firstEntryIso(activeEntries) ??
    undefined;

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
      parent_session: parentSession,
      delegated: platform === "oh_my_pi" && Boolean(taskPromptCacheKey),
      taskPromptCacheKey,
      additional_directories: header?.additionalDirectories,
    }),
  });

  for (const entry of activeEntries) {
    const entryType = asString(entry.value.type) ?? "unknown";
    const timestamp = normalizeIso(asString(entry.value.timestamp));
    if (entryType === "message") {
      const message = entry.value.message;
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
          rawJson: JSON.stringify({ kind: "title", title: nextTitle }),
        });
      }
      continue;
    }
    if (entryType === "reset_boundary") {
      output.push({
        pointer: `entry:${entry.lineNumber}`,
        observedAt: timestamp,
        rawJson: JSON.stringify({ kind: "reset_boundary" }),
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

  const lastActivity = lastMessageIso(activeEntries) ?? startedAt;
  return {
    seed: {
      sessionId,
      ...(title ? { title } : {}),
      ...(startedAt ? { createdAt: startedAt } : {}),
      ...(lastActivity ? { updatedAt: lastActivity } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      records: output,
    },
    diagnostics,
  };
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
  const leaf = entries.at(-1);
  const leafId = asString(leaf?.value.id);
  if (!leafId || !byId.has(leafId)) {
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
    const entry: ParsedRecord | undefined = byId.get(cursorId);
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
    if (!entry || asString(entry.value.type) !== "message") {
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
