import { DatabaseSync } from "node:sqlite";
import type { SourceReadBudget } from "../../core/read-budget.js";
import { readBudgetedSqliteRows } from "../../core/read-budget.js";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";
import { asNumber, asString, isObject, safeJsonParse } from "../../core/type-guards.js";

/**
 * Hermes Agent `state.db` reader.
 *
 * Hermes persists one SQLite store per profile (`$HERMES_HOME/state.db`,
 * default `~/.hermes/state.db`, named profiles under
 * `<root>/profiles/<name>/state.db`). Sessions, their full message rows,
 * per-model usage aggregates and lineage markers all live in that store.
 *
 * The store is WAL-mode and may be written by a live gateway, so it is opened
 * read-only inside one read transaction; every read runs under the adapter read
 * budget.
 */

const HERMES_CONTENT_JSON_PREFIX = "\x00json:";
const SESSION_LINEAGE_MARKERS = ["_delegate_from", "_branched_from", "_reset_from"] as const;
const SYNTHETIC_USER_MARKERS = [
  "Continue from the compressed conversation context above.",
  "You've reached the maximum number of tool-calling iterations allowed.",
  "[IMPORTANT: Background process ",
  "[Your active task list was preserved across context compression]",
] as const;
const DISPLAY_ONLY_KINDS = new Set(["failed_turn", "internal_notification", "process_complete"]);

export interface HermesSqliteReadOptions {
  targetSessionRefs?: readonly string[];
  budget?: SourceReadBudget;
}

interface HermesSeedDiagnostic {
  code: string;
  detail: string;
  severity?: "info" | "warning" | "error";
}

export function extractHermesSqliteSeeds(
  dbPath: string,
  options: HermesSqliteReadOptions = {},
): ExtractedSessionSeed[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let transactionOpen = false;
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => asString((row as Record<string, unknown>).name))
        .filter((name): name is string => name !== undefined),
    );
    if (!tables.has("sessions") || !tables.has("messages")) {
      throw new Error(
        `Unrecognized Hermes Agent SQLite schema in ${dbPath}: expected sessions and messages tables.`,
      );
    }
    const sessionColumns = tableColumns(db, "sessions");
    const messageColumns = tableColumns(db, "messages");
    requireColumns(sessionColumns, ["id"], "sessions", dbPath);
    requireColumns(messageColumns, ["session_id", "role", "content", "timestamp"], "messages", dbPath);
    const hasUsageTable = tables.has("session_model_usage");
    const usageColumns = hasUsageTable ? tableColumns(db, "session_model_usage") : new Set<string>();
    db.exec("BEGIN");
    transactionOpen = true;

    const seeds: ExtractedSessionSeed[] = [];
    for (const sessionRow of listSessions(db, sessionColumns, options)) {
      const rawSessionId = asString(sessionRow.id);
      if (!rawSessionId) {
        continue;
      }
      const seed = buildSessionSeed(db, {
        sessionRow,
        rawSessionId,
        sessionColumns,
        messageColumns,
        hasUsageTable,
        usageColumns,
        budget: options.budget,
      });
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

function requireColumns(
  columns: ReadonlySet<string>,
  required: readonly string[],
  table: string,
  dbPath: string,
): void {
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Unrecognized Hermes Agent SQLite schema in ${dbPath}: ${table} is missing ${missing.join(", ")}.`,
    );
  }
}

function matchesSessionRef(ref: string, rawSessionId: string): boolean {
  const canonical = `sess:hermes:${rawSessionId}`;
  if (ref === canonical || ref === rawSessionId) {
    return true;
  }
  // Only a canonical prefix may abbreviate, and it must name this platform.
  return ref.startsWith("sess:hermes:") && canonical.startsWith(ref);
}

function tableColumns(db: DatabaseSync, table: "sessions" | "messages" | "session_model_usage"): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => asString((row as Record<string, unknown>).name))
      .filter((name): name is string => name !== undefined),
  );
}

const SESSION_SELECT_COLUMNS = [
  "id",
  "title",
  "model",
  "cwd",
  "parent_session_id",
  "started_at",
  "ended_at",
  "last_activity_at",
  "message_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "estimated_cost_usd",
  "actual_cost_usd",
  "model_config",
  "source",
] as const;

function listSessions(
  db: DatabaseSync,
  columns: ReadonlySet<string>,
  options: HermesSqliteReadOptions,
): Record<string, unknown>[] {
  const selected = SESSION_SELECT_COLUMNS.filter((column) => columns.has(column));
  const query = `SELECT ${selected.join(", ")} FROM sessions ORDER BY id`;
  const rows = readBudgetedSqliteRows(db, query, selected, [], options.budget, "sessions rows");
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
  // A parent target includes direct children so family/related work and
  // delegated usage stay resolvable; a child target stays one session.
  for (const row of rows) {
    const parentId = asString(row.parent_session_id);
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

interface BuildSeedContext {
  sessionRow: Record<string, unknown>;
  rawSessionId: string;
  sessionColumns: ReadonlySet<string>;
  messageColumns: ReadonlySet<string>;
  hasUsageTable: boolean;
  usageColumns: ReadonlySet<string>;
  budget: SourceReadBudget | undefined;
}

function buildSessionSeed(db: DatabaseSync, context: BuildSeedContext): ExtractedSessionSeed | undefined {
  const { sessionRow, rawSessionId, budget } = context;
  const diagnostics: HermesSeedDiagnostic[] = [];
  const records: ExtractedSessionSeed["records"] = [];
  let lastMessageObservedAt: string | undefined;

  const startedAt = epochSecondsIso(sessionRow.started_at);
  const updatedAt =
    epochSecondsIso(sessionRow.last_activity_at) ??
    epochSecondsIso(sessionRow.ended_at) ??
    startedAt;
  const title = asString(sessionRow.title)?.trim() || undefined;
  const model = asString(sessionRow.model)?.trim() || undefined;
  const workingDirectory = normalizeDirectory(asString(sessionRow.cwd));
  const lineage = resolveLineage(sessionRow.model_config, rawSessionId);

  records.push({
    pointer: "sqlite:sessions",
    observedAt: startedAt ?? updatedAt,
    rawJson: JSON.stringify({
      kind: "session",
      id: rawSessionId,
      title,
      model,
      cwd: workingDirectory,
      parent_session_id: asString(sessionRow.parent_session_id),
      lineage_kind: lineage.kind,
      lineage_parent: lineage.parent,
      source: asString(sessionRow.source),
      started_at: startedAt,
      ended_at: epochSecondsIso(sessionRow.ended_at),
      message_count: asNumber(sessionRow.message_count),
    }),
  });

  for (const message of readMessages(db, context, diagnostics)) {
    const messageId = asNumber(message.id);
    const content = decodeContent(message.content, diagnostics, messageId);
    const messageObservedAt = epochSecondsIso(message.timestamp) ?? updatedAt;
    lastMessageObservedAt = messageObservedAt ?? lastMessageObservedAt;
    records.push({
      pointer: `sqlite:messages[${messageId ?? "?"}]`,
      observedAt: messageObservedAt,
      rawJson: JSON.stringify({
        kind: "message",
        id: messageId,
        role: asString(message.role),
        content,
        tool_call_id: asString(message.tool_call_id),
        tool_name: asString(message.tool_name),
        tool_calls: parseToolCalls(message.tool_calls),
        finish_reason: asString(message.finish_reason),
        reasoning: asString(message.reasoning) ?? asString(message.reasoning_content),
        synthetic_user: isSyntheticUserMessage(message, content),
        display_only: isDisplayOnlyRow(asString(message.display_kind)),
        display_kind: asString(message.display_kind),
        timestamp: epochSecondsIso(message.timestamp),
      }),
    });
  }

  // Session-level usage is emitted after the transcript and carries its own
  // independent identity, so it survives a last turn with no text reply and
  // keeps per-model attribution.
  appendUsageRecords(db, context, records, diagnostics, lastMessageObservedAt);

  return {
    sessionId: `sess:hermes:${rawSessionId}`,
    ...(title ? { title } : {}),
    ...(startedAt ? { createdAt: startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(model ? { model } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    records,
  };
}

interface MessageRow {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
  tool_name?: unknown;
  timestamp?: unknown;
  finish_reason?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  _compressed_summary?: unknown;
  display_kind?: unknown;
}

function readMessages(
  db: DatabaseSync,
  context: BuildSeedContext,
  diagnostics: HermesSeedDiagnostic[],
): MessageRow[] {
  const columns = context.messageColumns;
  const selected = [
    "id",
    "role",
    "content",
    "tool_call_id",
    "tool_calls",
    "tool_name",
    "timestamp",
    "finish_reason",
    "reasoning",
    "reasoning_content",
    "_compressed_summary",
    "display_kind",
  ].filter((column) => columns.has(column));
  const filters = ["session_id = ?"];
  if (columns.has("active")) {
    filters.push("active = 1");
  }
  if (columns.has("display_kind")) {
    filters.push("COALESCE(display_kind, '') <> 'hidden'");
  }
  const query =
    `SELECT ${selected.join(", ")} FROM messages WHERE ${filters.join(" AND ")} ORDER BY id ASC`;
  try {
    return readBudgetedSqliteRows(
      db,
      query,
      selected,
      [context.rawSessionId],
      context.budget,
      "messages rows",
    ) as unknown as MessageRow[];
  } catch (error) {
    diagnostics.push({
      code: "hermes_message_read_failed",
      detail: `Could not read messages for session ${context.rawSessionId}: ${(error as Error).message}`,
    });
    return [];
  }
}

function appendUsageRecords(
  db: DatabaseSync,
  context: BuildSeedContext,
  records: ExtractedSessionSeed["records"],
  diagnostics: HermesSeedDiagnostic[],
  lastMessageObservedAt: string | undefined,
): void {
  const { sessionRow, rawSessionId, hasUsageTable, usageColumns, budget } = context;
  const usageObservedAt =
    epochSecondsIso(sessionRow.last_activity_at) ??
    epochSecondsIso(sessionRow.ended_at) ??
    lastMessageObservedAt ??
    epochSecondsIso(sessionRow.started_at);

  if (hasUsageTable) {
    const selected = [
      "model",
      "billing_provider",
      "task",
      "api_call_count",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
      "estimated_cost_usd",
      "actual_cost_usd",
    ].filter((column) => usageColumns.has(column));
    if (selected.length > 0) {
      try {
        const rows = readBudgetedSqliteRows(
          db,
          `SELECT ${selected.join(", ")} FROM session_model_usage WHERE session_id = ? ORDER BY rowid ASC`,
          selected,
          [rawSessionId],
          budget,
          "session_model_usage rows",
        );
        for (const [index, row] of rows.entries()) {
          records.push({
            pointer: `sqlite:session_model_usage[${index}]`,
            observedAt: usageObservedAt,
            rawJson: JSON.stringify({
              kind: "usage",
              model: asString(row.model),
              provider: asString(row.billing_provider),
              task: asString(row.task),
              api_calls: asNumber(row.api_call_count),
              input_tokens: asNumber(row.input_tokens),
              output_tokens: asNumber(row.output_tokens),
              cache_read_tokens: asNumber(row.cache_read_tokens),
              cache_write_tokens: asNumber(row.cache_write_tokens),
              reasoning_tokens: asNumber(row.reasoning_tokens),
              estimated_cost_usd: asNumber(row.estimated_cost_usd),
              actual_cost_usd: asNumber(row.actual_cost_usd),
            }),
          });
        }
        if (rows.length > 0) {
          return;
        }
      } catch (error) {
        diagnostics.push({
          code: "hermes_usage_read_failed",
          detail: `Could not read per-model usage for session ${rawSessionId}: ${(error as Error).message}`,
        });
      }
    }
  }

  const sessionUsage = {
    input_tokens: asNumber(sessionRow.input_tokens),
    output_tokens: asNumber(sessionRow.output_tokens),
    cache_read_tokens: asNumber(sessionRow.cache_read_tokens),
    cache_write_tokens: asNumber(sessionRow.cache_write_tokens),
    reasoning_tokens: asNumber(sessionRow.reasoning_tokens),
  };
  if (Object.values(sessionUsage).some((value) => value !== undefined && value > 0)) {
    records.push({
      pointer: "sqlite:sessions:usage",
      observedAt: usageObservedAt,
      rawJson: JSON.stringify({
        kind: "usage",
        model: asString(sessionRow.model),
        provider: null,
        task: null,
        api_calls: null,
        estimated_cost_usd: asNumber(sessionRow.estimated_cost_usd),
        actual_cost_usd: asNumber(sessionRow.actual_cost_usd),
        ...sessionUsage,
      }),
    });
  }
}

function decodeContent(
  raw: unknown,
  diagnostics: HermesSeedDiagnostic[],
  messageId: number | undefined,
): unknown {
  if (typeof raw !== "string" || !raw.startsWith(HERMES_CONTENT_JSON_PREFIX)) {
    return raw ?? null;
  }
  const payload = raw.slice(HERMES_CONTENT_JSON_PREFIX.length);
  const parsed = safeJsonParse(payload);
  if (parsed === undefined) {
    diagnostics.push({
      code: "hermes_content_decode_failed",
      detail: `Message ${messageId ?? "?"} has a structured content marker that is not valid JSON; kept as the raw stored text.`,
    });
    // Upstream returns the original string, including the reserved prefix.
    return raw;
  }
  return parsed;
}

function parseToolCalls(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw ?? null;
  }
  const parsed = safeJsonParse(raw);
  return parsed ?? null;
}

function isDisplayOnlyRow(displayKind: string | undefined): boolean {
  return displayKind !== undefined && DISPLAY_ONLY_KINDS.has(displayKind);
}

function isSyntheticUserMessage(message: MessageRow, content: unknown): boolean {
  if (message._compressed_summary === 1 || message._compressed_summary === true) {
    return true;
  }
  if (asString(message.role) !== "user") {
    return false;
  }
  const text = contentToPlainText(content);
  return text.length > 0 && SYNTHETIC_USER_MARKERS.some((marker) => text.startsWith(marker));
}

function contentToPlainText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => (isObject(item) && asString(item.type) === "text" ? asString(item.text) ?? "" : ""))
    .join("\n")
    .trim();
}

function resolveLineage(
  modelConfig: unknown,
  sessionId: string,
): { kind: string | undefined; parent: string | undefined } {
  const config = typeof modelConfig === "string" ? safeJsonParse(modelConfig) : modelConfig;
  if (!isObject(config)) {
    return { kind: undefined, parent: undefined };
  }
  for (const marker of SESSION_LINEAGE_MARKERS) {
    const parent = asString(config[marker]);
    if (parent) {
      return {
        kind: marker === "_delegate_from" ? "delegate" : marker === "_branched_from" ? "branch" : "reset",
        parent,
      };
    }
  }
  return { kind: undefined, parent: undefined };
}

function normalizeDirectory(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\\/gu, "/").replace(/\/+$/u, "") || "/";
}

/**
 * Hermes stores `time.time()` floats (seconds). Some imported databases carry
 * milliseconds instead, so values past the 1973-in-milliseconds boundary are
 * read as milliseconds.
 */
function epochSecondsIso(value: unknown): string | undefined {
  const numeric = asNumber(value);
  if (numeric === undefined || !Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  const millis = numeric > 1e11 ? numeric : numeric * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
