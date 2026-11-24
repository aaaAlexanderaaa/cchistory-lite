import { DatabaseSync } from "node:sqlite";
import { readBudgetedSqliteRows, SourceReadBudgetExceededError, type SourceReadBudget } from "../../core/read-budget.js";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";
import { asString, isObject, safeJsonParse } from "../../core/type-guards.js";
import {
  buildMessageRecord,
  epochMillisIso,
  normalizeDirectory,
  normalizeOpenCodeUsage,
  parseJsonObject,
  type OpenCodeMessageRow,
  type OpenCodePartRow,
  type OpenCodeSeedDiagnostic,
  type OpenCodeSqliteSchema,
} from "./sqlite-records.js";

/**
 * Role: OpenCode native SQLite store reader (schema detection, read-only
 * transaction, target filtering, and budgeted row retrieval). Excludes
 * part/message record formatting (owned by `sqlite-records.ts`).
 *
 * Supported shapes:
 * - `session` / `message` / `part` (OpenCode 1.2 era);
 * - pre-split v2 (`session` + `session_message` / `session_part`, optional `seq`);
 * - current v2 (`session_v2` + `session_message` / `session_part`).
 */

interface SessionRow {
  id: unknown;
  title?: unknown;
  directory?: unknown;
  parent_id?: unknown;
  model?: unknown;
  time_created?: unknown;
  time_updated?: unknown;
}

export interface OpenCodeSqliteReadOptions {
  targetSessionRefs?: readonly string[];
  budget?: SourceReadBudget;
}

export function extractOpenCodeSqliteSeeds(
  dbPath: string,
  options: OpenCodeSqliteReadOptions = {},
): ExtractedSessionSeed[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let transactionOpen = false;
  try {
    const schema = detectSchema(db, dbPath);
    db.exec("BEGIN");
    transactionOpen = true;
    const seeds: ExtractedSessionSeed[] = [];
    for (const sessionRow of listSessions(db, schema, options)) {
      const rawSessionId = asString(sessionRow.id);
      if (!rawSessionId) {
        continue;
      }
      const seed = buildSessionSeed(db, schema, sessionRow, rawSessionId, options);
      if (seed) {
        seeds.push(seed);
      }
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return seeds;
  } finally {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the connection is already unusable; close below still runs */
      }
    }
    db.close();
  }
}

function detectSchema(db: DatabaseSync, dbPath: string): OpenCodeSqliteSchema {
  const names = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => asString((row as Record<string, unknown>).name))
      .filter((name): name is string => name !== undefined),
  );

  if (names.has("session_message")) {
    const sessionsTable = names.has("session_v2")
      ? ("session_v2" as const)
      : names.has("session")
        ? ("session" as const)
        : undefined;
    if (!sessionsTable) {
      throw new Error(
        `Unrecognized OpenCode SQLite schema in ${dbPath}: session_message exists without session/session_v2.`,
      );
    }
    const partsTable = names.has("session_part") ? ("session_part" as const) : undefined;
    const schema: OpenCodeSqliteSchema = {
      version: 2,
      sessionsTable,
      messagesTable: "session_message",
      ...(partsTable ? { partsTable } : {}),
      sessionColumns: tableColumns(db, sessionsTable),
      messageColumns: tableColumns(db, "session_message"),
      partColumns: partsTable ? tableColumns(db, partsTable) : new Set<string>(),
    };
    requireColumns(schema.messageColumns, ["data"], "session_message", dbPath);
    return schema;
  }

  if (names.has("session") && names.has("message")) {
    const partsTable = names.has("part") ? ("part" as const) : undefined;
    const schema: OpenCodeSqliteSchema = {
      version: 1,
      sessionsTable: "session",
      messagesTable: "message",
      ...(partsTable ? { partsTable } : {}),
      sessionColumns: tableColumns(db, "session"),
      messageColumns: tableColumns(db, "message"),
      partColumns: partsTable ? tableColumns(db, partsTable) : new Set<string>(),
    };
    requireColumns(schema.messageColumns, ["data"], "message", dbPath);
    return schema;
  }

  throw new Error(
    `Unrecognized OpenCode SQLite schema in ${dbPath}: expected session_message/session_v2 or message/session tables.`,
  );
}

function requireColumns(
  columns: ReadonlySet<string>,
  required: readonly string[],
  table: string,
  dbPath: string,
): void {
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Unrecognized OpenCode SQLite schema in ${dbPath}: ${table} is missing ${missing.join(", ")}.`,
    );
  }
}

function tableColumns(
  db: DatabaseSync,
  table: OpenCodeSqliteSchema["sessionsTable"] | "session_message" | "session_part" | "message" | "part",
): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => asString((row as Record<string, unknown>).name))
      .filter((name): name is string => name !== undefined),
  );
}

function pickColumns(columns: ReadonlySet<string>, wanted: readonly string[]): string[] {
  return wanted.filter((column) => columns.has(column));
}

function matchesSessionRef(ref: string, rawSessionId: string): boolean {
  const canonical = `sess:opencode:${rawSessionId}`;
  return ref === canonical || ref === rawSessionId || canonical.startsWith(ref) || rawSessionId.startsWith(ref);
}

function listSessions(
  db: DatabaseSync,
  schema: OpenCodeSqliteSchema,
  options: OpenCodeSqliteReadOptions,
): SessionRow[] {
  const selected = pickColumns(schema.sessionColumns, [
    "id",
    "title",
    "directory",
    "parent_id",
    "model",
    "time_created",
    "time_updated",
  ]);
  if (!selected.includes("id")) {
    throw new Error(`Unrecognized OpenCode SQLite schema: ${schema.sessionsTable} has no id column.`);
  }
  const rows = readBudgetedSqliteRows(
    db,
    `SELECT ${selected.join(", ")} FROM ${schema.sessionsTable} ORDER BY id`,
    selected,
    [],
    options.budget,
    `${schema.sessionsTable} rows`,
  ) as unknown as SessionRow[];

  const targetRefs = options.targetSessionRefs?.filter((ref) => ref.trim().length > 0) ?? [];
  if (targetRefs.length === 0) {
    return rows;
  }
  const matchedIds = new Set<string>();
  for (const row of rows) {
    const id = asString(row.id);
    if (id && targetRefs.some((ref) => matchesSessionRef(ref, id))) {
      matchedIds.add(id);
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      const id = asString(row.id);
      if (!id || matchedIds.has(id)) {
        continue;
      }
      const parentId = asString(row.parent_id);
      if (parentId && matchedIds.has(parentId)) {
        matchedIds.add(id);
        added = true;
      }
    }
  }
  return rows.filter((row) => {
    const id = asString(row.id);
    return id !== undefined && matchedIds.has(id);
  });
}

function buildSessionSeed(
  db: DatabaseSync,
  schema: OpenCodeSqliteSchema,
  session: SessionRow,
  rawSessionId: string,
  options: OpenCodeSqliteReadOptions,
): ExtractedSessionSeed | undefined {
  const diagnostics: OpenCodeSeedDiagnostic[] = [];
  const workingDirectory = normalizeDirectory(asString(session.directory));
  const title = asString(session.title)?.trim() || undefined;
  const parentId = asString(session.parent_id);
  const createdAt = epochMillisIso(session.time_created);
  const updatedAt = epochMillisIso(session.time_updated);
  const sessionModel = readSessionModel(session.model);

  const messages = readMessages(db, schema, rawSessionId, options.budget, diagnostics);
  const partsByMessage = readParts(db, schema, rawSessionId, options.budget, diagnostics);

  const records: ExtractedSessionSeed["records"] = [];
  let firstAssistantModel: string | undefined;
  for (const [index, message] of messages.entries()) {
    const messageId = asString(message.id);
    const parsed = parseJsonObject(asString(message.data), messageId, diagnostics, "message");
    if (!parsed) {
      continue;
    }
    const parts = (messageId ? partsByMessage.get(messageId) : undefined) ?? [];
    const role = schema.version === 2 ? asString(message.type) : asString(parsed.role);
    const messageModel =
      asString(parsed.modelID) ??
      (isObject(parsed.model) ? asString(parsed.model.id) : undefined);
    const effectiveModel = messageModel ?? sessionModel ?? firstAssistantModel;
    const effectiveParsed = { ...parsed };
    if (role === "assistant") {
      const assistantUsage = normalizeOpenCodeUsage(parsed.tokens);
      if (assistantUsage) {
        records.push({
          pointer: `sqlite:assistant-usage[${index}]`,
          observedAt: epochMillisIso(message.time_created) ?? createdAt,
          rawJson: JSON.stringify({
            usage_only: true,
            usage: assistantUsage,
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(asString(parsed.finish) ? { stop_reason: asString(parsed.finish) } : {}),
            source_event_type: "opencode_assistant_message",
            call_kind: "assistant",
          }),
        });
        // Usage is projected once as an independent call record so compaction
        // and assistant calls share one attribution path.
        delete effectiveParsed.tokens;
      }
    }
    if (role === "compaction") {
      const compactionUsage = normalizeOpenCodeUsage(parsed.tokens);
      if (compactionUsage) {
        records.push({
          pointer: `sqlite:compaction-usage[${index}]`,
          observedAt: epochMillisIso(message.time_created) ?? createdAt,
          rawJson: JSON.stringify({
            usage_only: true,
            usage: compactionUsage,
            ...(effectiveModel ? { model: effectiveModel } : {}),
            source_event_type: "opencode_compaction",
            call_kind: "compaction",
          }),
        });
      }
    }
    const record = buildMessageRecord(schema, message, effectiveParsed, parts, {
      messageId,
      workingDirectory,
      diagnostics,
    });
    if (!record) {
      continue;
    }
    records.push({
      pointer: `sqlite:${schema.messagesTable}[${index}]`,
      observedAt: record.observedAt ?? epochMillisIso(message.time_created) ?? createdAt,
      rawJson: JSON.stringify(record.record),
    });
    firstAssistantModel = firstAssistantModel ?? record.model;
  }

  const model = sessionModel ?? firstAssistantModel;
  if (parentId || title || model || workingDirectory) {
    records.unshift({
      pointer: "sqlite:session",
      observedAt: createdAt ?? updatedAt,
      rawJson: JSON.stringify({
        id: `sess:opencode:${rawSessionId}`,
        title,
        model,
        cwd: workingDirectory,
        ...(parentId ? { parentUuid: parentId, isSidechain: true } : {}),
      }),
    });
  }

  return {
    sessionId: `sess:opencode:${rawSessionId}`,
    ...(title ? { title } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(model ? { model } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    records,
  };
}

function readSessionModel(value: unknown): string | undefined {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  return isObject(parsed) ? asString(parsed.id) : undefined;
}

function readMessages(
  db: DatabaseSync,
  schema: OpenCodeSqliteSchema,
  sessionId: string,
  budget: SourceReadBudget | undefined,
  diagnostics: OpenCodeSeedDiagnostic[],
): OpenCodeMessageRow[] {
  const selected = pickColumns(schema.messageColumns, [
    "id",
    "type",
    "seq",
    "data",
    "time_created",
    "time_updated",
  ]);
  const order =
    schema.messagesTable === "session_message" && schema.messageColumns.has("seq")
      ? "seq ASC"
      : "time_created ASC, id ASC";
  try {
    return readBudgetedSqliteRows(
      db,
      `SELECT ${selected.join(", ")} FROM ${schema.messagesTable} WHERE session_id = ? ORDER BY ${order}`,
      selected,
      [sessionId],
      budget,
      `${schema.messagesTable} rows`,
    ) as unknown as OpenCodeMessageRow[];
  } catch (error) {
    if (error instanceof SourceReadBudgetExceededError) {
      throw error;
    }
    diagnostics.push({
      code: "opencode_message_read_failed",
      detail: `Could not read ${schema.messagesTable} rows for session ${sessionId}: ${(error as Error).message}`,
    });
    return [];
  }
}

function readParts(
  db: DatabaseSync,
  schema: OpenCodeSqliteSchema,
  sessionId: string,
  budget: SourceReadBudget | undefined,
  diagnostics: OpenCodeSeedDiagnostic[],
): Map<string, OpenCodePartRow[]> {
  if (!schema.partsTable) {
    return new Map();
  }
  const selected = pickColumns(schema.partColumns, [
    "message_id",
    "ordinal",
    "type",
    "data",
    "time_created",
    "time_updated",
  ]);
  const order =
    schema.partsTable === "session_part" && schema.partColumns.has("ordinal")
      ? "message_id ASC, ordinal ASC"
      : schema.partColumns.has("time_created")
        ? "message_id ASC, time_created ASC, rowid ASC"
        : "message_id ASC, rowid ASC";
  let rows: OpenCodePartRow[];
  try {
    rows = readBudgetedSqliteRows(
      db,
      `SELECT ${selected.join(", ")} FROM ${schema.partsTable} WHERE session_id = ? ORDER BY ${order}`,
      selected,
      [sessionId],
      budget,
      `${schema.partsTable} rows`,
    ) as unknown as OpenCodePartRow[];
  } catch (error) {
    if (error instanceof SourceReadBudgetExceededError) {
      throw error;
    }
    diagnostics.push({
      code: "opencode_part_read_failed",
      detail: `Could not read ${schema.partsTable} rows for session ${sessionId}: ${(error as Error).message}`,
    });
    return new Map();
  }
  const byMessage = new Map<string, OpenCodePartRow[]>();
  for (const row of rows) {
    const messageId = asString(row.message_id);
    if (!messageId) {
      continue;
    }
    const existing = byMessage.get(messageId) ?? [];
    existing.push(row);
    byMessage.set(messageId, existing);
  }
  return byMessage;
}
