import { asNumber, asString, isObject, safeJsonParse } from "../../core/type-guards.js";

/**
 * Role: Pure OpenCode SQLite row-to-generic-record builders (message parts,
 * tool calls/results, shell/compaction evidence, and token normalization).
 * Excludes SQLite connection lifecycle, schema probing, and read budgets.
 */

export interface OpenCodeSqliteSchema {
  version: 2 | 1;
  sessionsTable: "session_v2" | "session";
  messagesTable: "session_message" | "message";
  partsTable?: "session_part" | "part";
  sessionColumns: ReadonlySet<string>;
  messageColumns: ReadonlySet<string>;
  partColumns: ReadonlySet<string>;
}

export interface OpenCodeMessageRow {
  id: unknown;
  type?: unknown;
  seq?: unknown;
  data: unknown;
  time_created?: unknown;
  time_updated?: unknown;
}

export interface OpenCodePartRow {
  message_id: unknown;
  ordinal?: unknown;
  type?: unknown;
  data: unknown;
  time_created?: unknown;
  time_updated?: unknown;
}

export interface OpenCodeSeedDiagnostic {
  code: string;
  detail: string;
  severity?: "info" | "warning" | "error";
}

export interface MessageRecordContext {
  messageId: string | undefined;
  workingDirectory: string | undefined;
  diagnostics: OpenCodeSeedDiagnostic[];
}

export function buildMessageRecord(
  schema: OpenCodeSqliteSchema,
  message: OpenCodeMessageRow,
  parsed: Record<string, unknown>,
  parts: readonly OpenCodePartRow[],
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
      pushLoss(
        "opencode_assistant_error_evidence",
        `Assistant message ${context.messageId ?? "?"} recorded an error payload: ${describeValue(parsed.error)}`,
      );
    }
  } else if (role === "compaction") {
    // Compaction usage is emitted separately as an independent usage_only call
    // record so reply accounting stays untouched while the summary stays collapsed.
    const summary = extractContentText(parsed.summary);
    if (summary) {
      content.push({ type: "text", text: summary, synthetic: true });
    }
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

export function normalizeOpenCodeUsage(tokens: unknown): Record<string, number> | undefined {
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

export function parseJsonObject(
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

export function normalizeDirectory(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\\/gu, "/").replace(/\/+$/u, "") || "/";
}

export function epochMillisIso(value: unknown): string | undefined {
  const millis = asNumber(value);
  if (millis === undefined || !Number.isFinite(millis)) {
    return undefined;
  }
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
