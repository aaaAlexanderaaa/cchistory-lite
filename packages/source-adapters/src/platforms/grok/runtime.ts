import { createReadStream } from "node:fs";
import type { LossAuditRecord, RawRecord, SourceFragment } from "@cchistory/domain";
import { forEachNonEmptyTrimmedLineStreaming } from "../../core/jsonl-records.js";
import type {
  CommonParseRuntimeHelpers,
  FragmentBuildContextLike,
  ParseRuntimeResult,
  SessionDraftLike,
} from "../runtime-types.js";
import { decodeGrokEncodedCwd, GROK_DELEGATED_SESSION_KINDS } from "../grok.js";

const SYNTHETIC_USER_REASONS = new Set([
  "system_reminder",
  "project_instructions",
  "compaction_meta",
  "goal_summary",
  "task_completed",
]);

export function parseGrokRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  draft: SessionDraftLike,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  if (record.record_path_or_offset === "summary") {
    return parseGrokSummaryRecord(context, record, parsed, draft, helpers);
  }
  if (
    record.record_path_or_offset === "updates" ||
    record.record_path_or_offset.startsWith("updates:")
  ) {
    return parseGrokUpdateRecord(context, record, parsed, helpers);
  }
  if (
    record.record_path_or_offset.startsWith("subagent_meta") ||
    isGrokSubagentMetaPayload(parsed, helpers)
  ) {
    return parseGrokSubagentMetaRecord(context, record, parsed, draft, helpers);
  }

  const recordType = helpers.asString(parsed.type) ?? "unknown";
  const timeKey =
    record.observed_at ??
    helpers.coerceIso(parsed.timestamp) ??
    helpers.epochMillisToIso(helpers.asNumber(parsed.timestamp)) ??
    helpers.nowIso();

  if (recordType === "system") {
    return emitGrokText(context, record, parsed, timeKey, helpers, {
      actorKind: "system",
      originKind: "source_instruction",
      displayPolicy: "collapse",
    });
  }

  if (recordType === "user") {
    const syntheticReason = helpers.asString(parsed.synthetic_reason);
    const isSynthetic = Boolean(syntheticReason) || SYNTHETIC_USER_REASONS.has(syntheticReason ?? "");
    return emitGrokText(context, record, parsed, timeKey, helpers, {
      actorKind: isSynthetic ? "system" : "user",
      originKind: isSynthetic ? "source_instruction" : "user_authored",
      displayPolicy: isSynthetic ? "collapse" : "show",
      extra: syntheticReason ? { source_origin_kind: syntheticReason } : undefined,
    });
  }

  if (recordType === "assistant") {
    return parseGrokAssistantRecord(context, record, parsed, draft, timeKey, helpers);
  }

  if (recordType === "reasoning") {
    return parseGrokReasoningRecord(context, record, parsed, timeKey, helpers);
  }

  if (recordType === "backend_tool_call") {
    return parseGrokBackendToolCall(context, record, parsed, timeKey, helpers);
  }

  if (recordType === "tool_result") {
    const fragments: SourceFragment[] = [
      helpers.createFragment(context, record, 0, "tool_result", timeKey, {
        call_id: helpers.asString(parsed.tool_call_id) ?? helpers.asString(parsed.call_id),
        output: helpers.stringifyToolContent(parsed.content ?? parsed.output ?? parsed.result),
      }),
    ];
    return { fragments, lossAudits: [] };
  }

  return unhandledGrokRecord(context, record, recordType, parsed, timeKey, helpers);
}

export function grokUnixToIso(value: number | undefined): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  const millis = value > 1e12 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export async function collectGrokTurnCompletedUpdateRecords(input: {
  filePath: string;
  identity: { sourceId: string; blobId: string; sessionId: string };
  startOrdinal: number;
  createRecordId: (ordinal: number, pointer: string) => string;
  nowIso: () => string;
}): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const stream = createReadStream(input.filePath);
  try {
    await forEachNonEmptyTrimmedLineStreaming(stream, (line, lineIndex) => {
      if (!line.includes("turn_completed")) return;
      let sessionUpdate: unknown;
      let timestamp: number | undefined;
      try {
        const parsed = JSON.parse(line) as {
          timestamp?: unknown;
          params?: { update?: { sessionUpdate?: unknown } };
        };
        sessionUpdate = parsed.params?.update?.sessionUpdate;
        timestamp = typeof parsed.timestamp === "number" ? parsed.timestamp : undefined;
      } catch {
        return;
      }
      if (sessionUpdate !== "turn_completed") return;
      const pointer = `updates:${lineIndex}`;
      const ordinal = input.startOrdinal + records.length;
      records.push({
        id: input.createRecordId(ordinal, pointer),
        source_id: input.identity.sourceId,
        blob_id: input.identity.blobId,
        session_ref: input.identity.sessionId,
        ordinal,
        record_path_or_offset: pointer,
        observed_at: grokUnixToIso(timestamp) ?? input.nowIso(),
        parseable: true,
        raw_json: line,
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally {
    stream.destroy();
  }
  return records;
}

export function interleaveGrokTurnCompletedRecords(records: RawRecord[]): RawRecord[] {
  const chat: RawRecord[] = [];
  const completed: RawRecord[] = [];
  const other: RawRecord[] = [];
  for (const record of records) {
    const pointer = record.record_path_or_offset;
    if (/^\d+$/u.test(pointer)) {
      chat.push(record);
      continue;
    }
    if (pointer.startsWith("updates:")) {
      if (isGrokTurnCompletedRecord(record)) {
        completed.push(stampGrokUpdateTime(record));
      }
      continue;
    }
    other.push(record);
  }

  const turns: RawRecord[][] = [];
  let current: RawRecord[] = [];
  for (const record of chat) {
    if (isGrokRealUserRecord(record) && current.some((entry) => isGrokRealUserRecord(entry))) {
      turns.push(current);
      current = [];
    }
    current.push(record);
  }
  if (current.length > 0) {
    turns.push(current);
  }

  const result = [...other];
  let completedIndex = 0;
  for (const turn of turns) {
    const usage = completed[completedIndex];
    const iso = usage ? grokTimestampFromRecord(usage) : undefined;
    if (usage) completedIndex += 1;
    const stampedTurn = turn.map((record) => iso ? { ...record, observed_at: iso } : record);
    if (usage) {
      attachGrokUsageToLastAssistant(stampedTurn, usage);
    }
    result.push(...stampedTurn);
  }
  return result;
}

function parseGrokUpdateRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const params = helpers.isObject(parsed.params) ? parsed.params : undefined;
  const update = helpers.isObject(params?.update) ? params.update : undefined;
  const kind = helpers.asString(update?.sessionUpdate);
  if (kind !== "turn_completed") {
    return { fragments: [], lossAudits: [] };
  }
  const usage = helpers.extractTokenUsage(update?.usage ?? update);
  const timeKey = grokTimestampFromRecord(record) ?? record.observed_at ?? helpers.nowIso();
  if (!usage) {
    return { fragments: [], lossAudits: [] };
  }
  return {
    fragments: [
      helpers.createTokenUsageFragment(context, record, 0, timeKey, usage, helpers.normalizeStopReason(update?.stop_reason), {
        scope: "turn",
        source_event_type: "turn_completed",
      }),
    ],
    lossAudits: [],
  };
}

function isGrokTurnCompletedRecord(record: RawRecord): boolean {
  try {
    const parsed = JSON.parse(record.raw_json) as { params?: { update?: { sessionUpdate?: string } } };
    return parsed?.params?.update?.sessionUpdate === "turn_completed";
  } catch {
    return false;
  }
}

function isGrokRealUserRecord(record: RawRecord): boolean {
  try {
    const parsed = JSON.parse(record.raw_json) as { type?: string; synthetic_reason?: string };
    return parsed.type === "user" && !parsed.synthetic_reason;
  } catch {
    return false;
  }
}

function grokTimestampFromRecord(record: RawRecord): string | undefined {
  try {
    const parsed = JSON.parse(record.raw_json) as { timestamp?: number };
    return grokUnixToIso(typeof parsed.timestamp === "number" ? parsed.timestamp : undefined);
  } catch {
    return undefined;
  }
}

function stampGrokUpdateTime(record: RawRecord): RawRecord {
  const iso = grokTimestampFromRecord(record);
  return iso ? { ...record, observed_at: iso } : record;
}

function attachGrokUsageToLastAssistant(turn: RawRecord[], usageRecord: RawRecord): void {
  let usage: unknown;
  try {
    const parsed = JSON.parse(usageRecord.raw_json) as { params?: { update?: { usage?: unknown } } };
    usage = parsed.params?.update?.usage;
  } catch {
    return;
  }
  if (!usage || typeof usage !== "object") {
    return;
  }
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const record = turn[index];
    if (!record) continue;
    try {
      const parsed = JSON.parse(record.raw_json) as Record<string, unknown>;
      if (parsed.type !== "assistant") continue;
      turn[index] = { ...record, raw_json: JSON.stringify({ ...parsed, usage }) };
      return;
    } catch {
      continue;
    }
  }
}

function parseGrokSummaryRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  draft: SessionDraftLike,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const fragments: SourceFragment[] = [];
  const info = helpers.isObject(parsed.info) ? parsed.info : undefined;
  const createdAt = helpers.coerceIso(parsed.created_at);
  const updatedAt = helpers.coerceIso(parsed.updated_at) ?? helpers.coerceIso(parsed.last_active_at);
  const title =
    helpers.asString(parsed.generated_title) ??
    helpers.asString(parsed.session_summary) ??
    helpers.asString(parsed.title);
  const model = helpers.asString(parsed.current_model_id) ?? helpers.asString(parsed.model);
  const cwd =
    helpers.asString(info?.cwd) ??
    helpers.asString(parsed.git_root_dir) ??
    decodeGrokEncodedCwd(helpers.asString(parsed.encoded_cwd) ?? "");
  const timeKey = createdAt ?? record.observed_at ?? helpers.nowIso();

  draft.created_at = createdAt ?? draft.created_at;
  draft.updated_at = updatedAt ?? draft.updated_at;
  draft.title = title ?? draft.title;
  if (model) {
    draft.model = model;
  }
  if (cwd) {
    draft.working_directory = helpers.normalizeWorkspacePath(cwd) ?? draft.working_directory;
  }
  const sourceSessionId = helpers.asString(info?.id);
  if (sourceSessionId) {
    draft.source_session_id = sourceSessionId;
  }
  const sessionKind = helpers.asString(parsed.session_kind);
  const isDelegated = sessionKind !== undefined && GROK_DELEGATED_SESSION_KINDS.has(sessionKind);
  const parentSessionId =
    helpers.asString(parsed.parent_session_id) ??
    helpers.asString(info?.parent_session_id);
  const childSessionId = sourceSessionId ?? draft.source_session_id;
  if (isDelegated) {
    draft.delegated_parent_session_id = parentSessionId ?? draft.delegated_parent_session_id;
    draft.delegated_agent_key =
      helpers.asString(parsed.agent_name) ??
      draft.delegated_agent_key ??
      sessionKind;
    if (parentSessionId && childSessionId) {
      fragments.push(helpers.createFragment(context, record, fragments.length, "session_relation", timeKey, {
        parent_uuid: parentSessionId,
        child_session_id: childSessionId,
        is_sidechain: true,
        agent_id: helpers.asString(parsed.agent_name),
        session_kind: sessionKind,
      }));
    }
  }

  fragments.push(helpers.createFragment(context, record, fragments.length, "session_meta", timeKey, parsed));
  if (draft.title) {
    fragments.push(helpers.createFragment(context, record, fragments.length, "title_signal", timeKey, {
      title: draft.title,
    }));
  }
  if (draft.working_directory) {
    fragments.push(helpers.createFragment(context, record, fragments.length, "workspace_signal", timeKey, {
      path: draft.working_directory,
    }));
  }
  if (draft.model) {
    fragments.push(helpers.createFragment(context, record, fragments.length, "model_signal", timeKey, {
      model: draft.model,
    }));
  }
  return { fragments, lossAudits: [] };
}

function isGrokSubagentMetaPayload(
  parsed: Record<string, unknown>,
  helpers: CommonParseRuntimeHelpers,
): boolean {
  return Boolean(
    helpers.asString(parsed.parent_session_id) &&
    helpers.asString(parsed.child_session_id) &&
    helpers.asString(parsed.subagent_type) &&
    helpers.asString(parsed.type) === undefined,
  );
}

function parseGrokSubagentMetaRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  draft: SessionDraftLike,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const parentSessionId = helpers.asString(parsed.parent_session_id);
  const childSessionId = helpers.asString(parsed.child_session_id);
  const agentKey = helpers.asString(parsed.subagent_type);
  const timeKey =
    helpers.coerceIso(parsed.started_at) ??
    helpers.coerceIso(parsed.completed_at) ??
    record.observed_at ??
    helpers.nowIso();
  if (childSessionId && draft.source_session_id === childSessionId) {
    draft.delegated_parent_session_id = parentSessionId ?? draft.delegated_parent_session_id;
    draft.delegated_agent_key = agentKey ?? draft.delegated_agent_key;
    const description = helpers.asString(parsed.description);
    if (description && !draft.title) {
      draft.title = description;
    }
  }
  if (!parentSessionId || !childSessionId) {
    return { fragments: [], lossAudits: [] };
  }
  return {
    fragments: [
      helpers.createFragment(context, record, 0, "session_relation", timeKey, {
        parent_uuid: parentSessionId,
        child_session_id: childSessionId,
        is_sidechain: true,
        agent_id: agentKey,
        status: helpers.asString(parsed.status),
        description: helpers.asString(parsed.description),
      }),
    ],
    lossAudits: [],
  };
}

function parseGrokAssistantRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  draft: SessionDraftLike,
  timeKey: string,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const fragments: SourceFragment[] = [];
  const lossAudits: LossAuditRecord[] = [];
  const model = helpers.asString(parsed.model_id) ?? helpers.asString(parsed.model);
  if (model) {
    draft.model = model;
    fragments.push(helpers.createFragment(context, record, fragments.length, "model_signal", timeKey, { model }));
  }

  const content = parsed.content;
  const text = typeof content === "string"
    ? content
    : collectGrokContentText(content, helpers);
  if (text) {
    helpers.appendChunkedTextFragments(
      context,
      record,
      fragments,
      timeKey,
      "assistant",
      text,
      fragments.length,
      { model },
    );
  }

  for (const toolCall of helpers.asArray(parsed.tool_calls)) {
    if (!helpers.isObject(toolCall)) {
      continue;
    }
    fragments.push(helpers.createFragment(context, record, fragments.length, "tool_call", timeKey, {
      call_id: helpers.asString(toolCall.id) ?? helpers.asString(toolCall.call_id),
      tool_name: helpers.asString(toolCall.name) ?? helpers.asString(toolCall.tool_name) ?? "tool_call",
      input: normalizeGrokToolInput(toolCall.arguments ?? toolCall.args ?? toolCall.input, helpers),
    }));
  }

  const usage = helpers.extractTokenUsage(parsed);
  if (usage) {
    fragments.push(helpers.createTokenUsageFragment(context, record, fragments.length, timeKey, usage, undefined, {
      scope: "turn",
      source_event_type: "assistant",
    }));
  }

  if (fragments.length === 0) {
    return unhandledGrokRecord(context, record, "assistant", parsed, timeKey, helpers);
  }
  return { fragments, lossAudits };
}

function parseGrokReasoningRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  timeKey: string,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const summaryText = collectGrokContentText(parsed.summary, helpers);
  if (!summaryText) {
    return { fragments: [], lossAudits: [] };
  }
  return {
    fragments: [
      helpers.createFragment(context, record, 0, "text", timeKey, {
        actor_kind: "assistant",
        origin_kind: "assistant_authored",
        display_policy: "collapse",
        source_content_type: "think",
        text: summaryText,
        message_id: helpers.asString(parsed.id),
      }),
    ],
    lossAudits: [],
  };
}

function parseGrokBackendToolCall(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  timeKey: string,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const kind = helpers.isObject(parsed.kind) ? parsed.kind : parsed;
  const toolName =
    helpers.asString(kind.tool_type) ??
    helpers.asString(kind.name) ??
    helpers.asString(parsed.tool_type) ??
    "backend_tool_call";
  return {
    fragments: [
      helpers.createFragment(context, record, 0, "tool_call", timeKey, {
        call_id: helpers.asString(kind.id) ?? helpers.asString(parsed.id),
        tool_name: toolName,
        input: helpers.isObject(kind.action) ? kind.action : normalizeGrokToolInput(kind.action, helpers),
        source_event_type: "backend_tool_call",
      }),
    ],
    lossAudits: [],
  };
}

function emitGrokText(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  timeKey: string,
  helpers: CommonParseRuntimeHelpers,
  options: {
    actorKind: "user" | "system" | "assistant";
    originKind: string;
    displayPolicy: "show" | "collapse";
    extra?: Record<string, unknown>;
  },
): ParseRuntimeResult {
  const text = typeof parsed.content === "string"
    ? parsed.content
    : collectGrokContentText(parsed.content, helpers);
  if (!text) {
    return {
      fragments: [helpers.createFragment(context, record, 0, "unknown", timeKey, parsed)],
      lossAudits: [
        helpers.createRecordLossAudit(
          context,
          record,
          "unknown_fragment",
          `Grok ${helpers.asString(parsed.type) ?? "record"} did not contain text content`,
          { diagnosticCode: "grok_input_text_missing" },
        ),
      ],
    };
  }

  if (options.actorKind === "user" && options.originKind === "user_authored") {
    const fragments: SourceFragment[] = [];
    helpers.appendChunkedTextFragments(
      context,
      record,
      fragments,
      timeKey,
      "user",
      text,
      0,
      { messageId: helpers.asString(parsed.id) },
    );
    return { fragments, lossAudits: [] };
  }

  return {
    fragments: [
      helpers.createFragment(context, record, 0, "text", timeKey, {
        actor_kind: options.actorKind,
        origin_kind: options.originKind,
        display_policy: options.displayPolicy,
        text,
        ...options.extra,
      }),
    ],
    lossAudits: [],
  };
}

function collectGrokContentText(
  value: unknown,
  helpers: Pick<CommonParseRuntimeHelpers, "asArray" | "asString" | "extractTextFromContentItem" | "isObject">,
): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  const parts: string[] = [];
  for (const item of helpers.asArray(value)) {
    if (typeof item === "string" && item.trim()) {
      parts.push(item);
      continue;
    }
    if (!helpers.isObject(item)) {
      continue;
    }
    const text = helpers.extractTextFromContentItem(item) ?? helpers.asString(item.text);
    if (text?.trim()) {
      parts.push(text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function normalizeGrokToolInput(
  value: unknown,
  helpers: Pick<CommonParseRuntimeHelpers, "isObject">,
): Record<string, unknown> {
  if (helpers.isObject(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return helpers.isObject(parsed) ? parsed : value.trim() ? { raw: value } : {};
    } catch {
      return value.trim() ? { raw: value } : {};
    }
  }
  if (value === undefined || value === null) {
    return {};
  }
  return { value };
}

function unhandledGrokRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  recordType: string,
  parsed: Record<string, unknown>,
  timeKey: string,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  return {
    fragments: [helpers.createFragment(context, record, 0, "unknown", timeKey, parsed)],
    lossAudits: [
      helpers.createRecordLossAudit(
        context,
        record,
        "unknown_fragment",
        `Unhandled Grok record type: ${recordType}`,
        { diagnosticCode: "grok_unhandled_record_type" },
      ),
    ],
  };
}
