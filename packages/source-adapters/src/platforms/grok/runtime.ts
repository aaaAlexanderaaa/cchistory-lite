import type { LossAuditRecord, RawRecord, SourceFragment } from "@cchistory/domain";
import type {
  CommonParseRuntimeHelpers,
  FragmentBuildContextLike,
  ParseRuntimeResult,
  SessionDraftLike,
} from "../runtime-types.js";
import { decodeGrokEncodedCwd } from "../grok.js";

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

  const recordType = helpers.asString(parsed.type) ?? "unknown";
  const timeKey =
    helpers.coerceIso(parsed.timestamp) ??
    helpers.epochMillisToIso(helpers.asNumber(parsed.timestamp)) ??
    record.observed_at ??
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
  const parentSessionId =
    helpers.asString(parsed.parent_session_id) ??
    helpers.asString(info?.parent_session_id);
  if (parentSessionId) {
    fragments.push(helpers.createFragment(context, record, fragments.length, "session_relation", timeKey, {
      parent_uuid: parentSessionId,
    }));
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
