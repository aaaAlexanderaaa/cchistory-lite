import { DatabaseSync } from "node:sqlite";
import type { SourceReadBudget } from "../../core/read-budget.js";
import { readBudgetedSqliteRows } from "../../core/read-budget.js";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";
import { asNumber, asString, isObject, safeJsonParse } from "../../core/type-guards.js";

/**
 * OpenCode native SQLite reader.
 *
 * The store has three shapes in the wild:
 *
 * - `session` / `message` / `part` (OpenCode 1.2 era), one row per message and
 *   part with the payload in a JSON `data` column;
 * - pre-split v2: `session` (the future `session_v2` metadata table under its
 *   old name) plus `session_message`/`session_part`, optionally beside the now
 *   empty `message`/`part` tables;
 * - current v2: `session_v2` plus `session_message`/`session_part`.
 *
 * The reader detects the message table first, because `session` is a valid
 * metadata table in both the legacy and the pre-split v2 shape. It projects
 * rows into the adapter's generic message records and leaves turn, tool and
 * usage semantics to the canonical interpreter. The database is opened
 * read-only inside one read transaction so budget admission and retrieval see
 * the same snapshot.
 */

interface SqliteSchema {
  version: 2 | 1;
  sessionsTable: "session_v2" | "session";
  messagesTable: "session_message" | "message";
  partsTable?: "session_part" | "part";
  sessionColumns: ReadonlySet<string>;
  messageColumns: ReadonlySet<string>;
  partColumns: ReadonlySet<string>;
}

interface SessionRow {
  id: unknown;
  title?: unknown;
  directory?: unknown;
  parent_id?: unknown;
  model?: unknown;
  time_created?: unknown;
  time_updated?: unknown;
}

interface MessageRow {
  id: unknown;
  type?: unknown;
  seq?: unknown;
  data: unknown;
  time_created?: unknown;
  time_updated?: unknown;
}

interface PartRow {
  message_id: unknown;
  ordinal?: unknown;
  type?: unknown;
  data: unknown;
  time_created?: unknown;
  time_updated?: unknown;
}

interface OpenCodeSeedDiagnostic {
  code: string;
  detail: string;
  severity?: "info" | "warning" | "error";
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

function detectSchema(db: DatabaseSync, dbPath: string): SqliteSchema {
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
    const schema: SqliteSchema = {
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
    const schema: SqliteSchema = {
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

function tableColumns(db: DatabaseSync, table: SqliteSchema["sessionsTable"] | "session_message" | "session_part" | "message" | "part"): Set<string> {
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
  schema: SqliteSchema,
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
  for (const row of rows) {
    const parentId = asString(row.parent_id);
    if (parentId && matchedIds.has(parentId)) {
      const id = asString(row.id);
      if (id) {
        matchedIds.add(id);
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
  schema: SqliteSchema,
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
    const record = buildMessageRecord(schema, message, parsed, parts, {
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
  schema: SqliteSchema,
  sessionId: string,
  budget: SourceReadBudget | undefined,
  diagnostics: OpenCodeSeedDiagnostic[],
): MessageRow[] {
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
    ) as unknown as MessageRow[];
  } catch (error) {
    diagnostics.push({
      code: "opencode_message_read_failed",
      detail: `Could not read ${schema.messagesTable} rows for session ${sessionId}: ${(error as Error).message}`,
    });
    return [];
  }
}

function readParts(
  db: DatabaseSync,
  schema: SqliteSchema,
  sessionId: string,
  budget: SourceReadBudget | undefined,
  diagnostics: OpenCodeSeedDiagnostic[],
): Map<string, PartRow[]> {
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
  let rows: PartRow[];
  try {
    rows = readBudgetedSqliteRows(
      db,
      `SELECT ${selected.join(", ")} FROM ${schema.partsTable} WHERE session_id = ? ORDER BY ${order}`,
      selected,
      [sessionId],
      budget,
      `${schema.partsTable} rows`,
    ) as unknown as PartRow[];
  } catch (error) {
    diagnostics.push({
      code: "opencode_part_read_failed",
      detail: `Could not read ${schema.partsTable} rows for session ${sessionId}: ${(error as Error).message}`,
    });
    return new Map();
  }
  const byMessage = new Map<string, PartRow[]>();
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

interface MessageRecordContext {
  messageId: string | undefined;
  workingDirectory: string | undefined;
  diagnostics: OpenCodeSeedDiagnostic[];
}

function buildMessageRecord(
  schema: SqliteSchema,
  message: MessageRow,
  parsed: Record<string, unknown>,
  parts: readonly PartRow[],
  context: MessageRecordContext,
): { observedAt?: string; model?: string; record: Record<string, unknown> } | undefined {
  const v2Type = schema.version === 2 ? asString(message.type) : undefined;
  const role = v2Type ?? asString(parsed.role);
  if (!role) {
    return undefined;
  }

  const content: Record<string, unknown>[] = [];
  const pushLoss = (code: string, detail: string, severity: "info" | "warning" | "error" = "info"): void => {
    context.diagnostics.push({ code, detail, severity });
  };

  if (role === "user") {
    appendTextBlock(content, asString(parsed.text));
    for (const part of parts) {
      const parsedPart = parseJsonObject(asString(part.data), context.messageId, context.diagnostics, "part");
      if (parsedPart) {
        appendMessagePart(content, parsedPart, role, pushLoss);
      }
    }
    appendUserFiles(content, parsed.files);
  } else if (role === "assistant") {
    const inlineContent = Array.isArray(parsed.content) ? parsed.content : [];
    // Current builds store assistant parts in `session_part`; the inline copy is
    // only authoritative when no part rows exist (part rows disabled).
    if (parts.length === 0) {
      for (const item of inlineContent) {
        if (isObject(item)) {
          appendMessagePart(content, item, role, pushLoss);
        }
      }
    }
    for (const part of parts) {
      const parsedPart = parseJsonObject(asString(part.data), context.messageId, context.diagnostics, "part");
      if (parsedPart) {
        appendMessagePart(content, parsedPart, role, pushLoss);
      }
    }
    if (parsed.error !== undefined) {
      pushLoss("opencode_assistant_error_evidence", `Assistant message ${context.messageId ?? "?"} recorded an error payload: ${describeValue(parsed.error)}`);
    }
  } else if (role === "compaction") {
    // A compaction is its own model call. Emitting its tokens as ordinary
    // assistant usage would overwrite the neighbouring reply's accounting
    // because canonical attributes signals to the nearest assistant reply.
    const summary = extractContentText(parsed.summary);
    if (summary) {
      content.push({ type: "text", text: summary, synthetic: true });
    }
    pushLoss(
      "opencode_compaction_usage_not_attributed",
      `Compaction ${context.messageId ?? "?"} records usage for its own call; the amount stays out of assistant reply accounting until canonical has an independent compaction call identity.`,
    );
  } else if (role === "system" || role === "synthetic" || role === "skill") {
    appendTextBlock(content, asString(parsed.text), true);
  } else if (role === "shell") {
    appendShellEvidence(content, parsed);
  } else {
    pushLoss("opencode_unhandled_message_type", `Unhandled OpenCode message type ${role}; kept only as a diagnostic.`);
    return undefined;
  }

  const usage = role === "compaction" ? undefined : normalizeOpenCodeUsage(parsed.tokens);
  const model =
    asString(parsed.modelID) ??
    (isObject(parsed.model) ? asString(parsed.model.id) : undefined);
  const stopReason = asString(parsed.finish);

  if (content.length === 0 && !usage && !model && role !== "user" && role !== "compaction") {
    return undefined;
  }

  const observedAt =
    epochMillisIso(message.time_created) ??
    epochMillisIso(isObject(parsed.time) ? parsed.time.created : undefined);

  return {
    observedAt,
    model,
    record: {
      id: context.messageId,
      role: role === "compaction" || role === "shell" || role === "synthetic" || role === "skill" ? "system" : role,
      timestamp: observedAt,
      content,
      ...(usage ? { usage } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(model ? { model } : {}),
      ...(context.workingDirectory ? { cwd: context.workingDirectory } : {}),
      opencode: {
        storage: schema.messagesTable,
        message_type: role,
        provider_id:
          asString(parsed.providerID) ??
          (isObject(parsed.model) ? asString(parsed.model.providerID) : undefined),
        agent: asString(parsed.agent) ?? asString(parsed.mode),
      },
    },
  };
}

function appendMessagePart(
  content: Record<string, unknown>[],
  part: Record<string, unknown>,
  role: string,
  loss: (code: string, detail: string) => void,
): void {
  const partType = asString(part.type);
  if (partType === "text" || partType === "reasoning") {
    appendTextBlock(content, asString(part.text), part.synthetic === true);
    return;
  }
  if (partType === "file" || partType === "file_part") {
    appendFilePart(content, part);
    return;
  }
  if (partType === "tool") {
    appendToolPart(content, part);
    return;
  }
  if (partType === "step-start" || partType === "step-finish" || partType === "snapshot" || partType === "patch") {
    return;
  }
  if (partType === "compaction") {
    loss(
      "opencode_compaction_part_evidence",
      `Compaction part ${asString(part.id) ?? "?"} is retained only as a diagnostic; its summary/usage is not projected as assistant usage.`,
    );
    return;
  }
  if (partType === "agent" || partType === "subtask") {
    const label =
      asString(part.name) ??
      asString(part.agent) ??
      asString(part.description) ??
      asString(part.prompt) ??
      partType;
    appendTextBlock(content, `[${partType}] ${label}`, true);
    return;
  }
  if (partType === "retry") {
    loss("opencode_retry_part_evidence", `Retry part ${asString(part.id) ?? "?"} was recorded for ${role}; kept as a diagnostic.`);
    return;
  }
  loss(
    "opencode_unknown_part_type",
    `Unknown OpenCode ${role} part type ${String(partType)}; raw payload retained in the source row only.`,
  );
}

function appendTextBlock(content: Record<string, unknown>[], text: string | undefined, synthetic = false): void {
  if (!text?.trim()) {
    return;
  }
  content.push(synthetic ? { type: "text", text, synthetic: true } : { type: "text", text });
}

function appendUserFiles(content: Record<string, unknown>[], files: unknown): void {
  if (!Array.isArray(files)) {
    return;
  }
  for (const file of files) {
    if (isObject(file)) {
      appendFilePart(content, file);
    }
  }
}

function appendFilePart(content: Record<string, unknown>[], part: Record<string, unknown>): void {
  // v1 FilePart: { filename, mime, url }; v2 FileAttachment: { name, ... }.
  // A data: URL is never projected as text; it can be megabytes of base64.
  const filename = asString(part.filename) ?? asString(part.name) ?? asString(part.path);
  if (filename) {
    content.push({ type: "text", text: `[file] ${truncateLabel(filename)}` });
    return;
  }
  const mime = asString(part.mime) ?? asString(part.mediaType);
  if (mime) {
    content.push({ type: "text", text: `[file ${truncateLabel(mime)}]` });
    return;
  }
  content.push({ type: "text", text: "[file attachment]" });
}

function appendToolPart(content: Record<string, unknown>[], item: Record<string, unknown>): void {
  const state = isObject(item.state) ? item.state : undefined;
  const callId = asString(item.callID) ?? asString(item.callId) ?? asString(item.id);
  const toolName = asString(item.tool) ?? asString(item.name) ?? "tool";
  content.push({
    type: "tool_call",
    id: callId,
    name: toolName,
    input: state?.input ?? item.input ?? {},
  });

  const status = asString(state?.status);
  const error = state?.error ?? item.error;
  const output = state?.output ?? state?.content ?? item.output;
  const isError = status === "error" || error !== undefined;
  if (isError || output !== undefined) {
    // Keep both halves when a failed call carries partial content and an error.
    const detail = isError && output !== undefined && error !== undefined
      ? `${stringifyValue(output)}\n${stringifyValue(error)}`
      : (output ?? error ?? { status });
    content.push({
      type: "tool_result",
      tool_use_id: callId,
      content: detail,
      ...(isError ? { is_error: true } : {}),
    });
  }
}

function appendShellEvidence(content: Record<string, unknown>[], parsed: Record<string, unknown>): void {
  const command = asString(parsed.command);
  const output = parsed.output;
  const status = asString(parsed.status);
  const exit = asNumber(parsed.exit);
  const text = [
    command ? `$ ${command}` : "shell",
    status ? `status: ${status}${exit !== undefined ? ` (exit ${exit})` : ""}` : undefined,
    output !== undefined ? stringifyValue(output) : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");
  appendTextBlock(content, text || "shell command evidence", true);
}

function extractContentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of value) {
    if (isObject(item)) {
      const text = asString(item.text);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n").trim() || undefined;
}

function normalizeOpenCodeUsage(tokens: unknown): Record<string, number> | undefined {
  if (!isObject(tokens)) {
    return undefined;
  }
  const cache = isObject(tokens.cache) ? tokens.cache : undefined;
  const inputTokens = asNumber(tokens.input);
  const outputTokens = asNumber(tokens.output);
  const reasoningTokens = asNumber(tokens.reasoning);
  const cacheReadTokens = asNumber(cache?.read);
  const cacheCreationTokens = asNumber(cache?.write);
  const values = [inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheCreationTokens];
  if (values.every((value) => value === undefined)) {
    return undefined;
  }
  const totalTokens = values.reduce<number>((total, value) => total + (value ?? 0), 0);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    totalTokens,
  };
}

function parseJsonObject(
  raw: string | undefined,
  messageId: string | undefined,
  diagnostics: OpenCodeSeedDiagnostic[],
  kind: string,
): Record<string, unknown> | undefined {
  if (!raw) {
    diagnostics.push({
      code: "opencode_empty_payload",
      detail: `OpenCode ${kind} record${messageId ? ` ${messageId}` : ""} has no JSON payload.`,
    });
    return undefined;
  }
  const parsed = safeJsonParse(raw);
  if (!isObject(parsed)) {
    diagnostics.push({
      code: "opencode_malformed_payload",
      detail: `OpenCode ${kind} record${messageId ? ` ${messageId}` : ""} is not a JSON object.`,
    });
    return undefined;
  }
  return parsed;
}

function describeValue(value: unknown): string {
  const text = typeof value === "string" ? value : stringifyValue(value);
  return truncateLabel(text);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncateLabel(value: string, limit = 160): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function normalizeDirectory(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\\/gu, "/").replace(/\/+$/u, "") || "/";
}

function epochMillisIso(value: unknown): string | undefined {
  const millis = asNumber(value);
  if (millis === undefined || !Number.isFinite(millis)) {
    return undefined;
  }
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
