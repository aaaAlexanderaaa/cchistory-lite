import type { FragmentKind, LossAuditRecord, RawRecord, SourceFragment } from "@cchistory/domain";
import type {
  CommonParseRuntimeHelpers,
  FragmentBuildContextLike,
  ParseRuntimeResult,
  SessionDraftLike,
  TokenUsageLike,
} from "../runtime-types.js";

/**
 * Hermes Agent record interpreter.
 *
 * The `state.db` reader projects one session row, zero or more per-model usage
 * rows, and the session's live message rows into seeds. This runtime keeps the
 * message semantics: user/assistant/tool roles, OpenAI-style tool calls,
 * collapsed reasoning channels, and session-granular usage (Hermes records
 * usage per session/model, never per call).
 */

type PushFragment = (fragmentKind: FragmentKind, payload: Record<string, unknown>) => void;
type RecordLoss = (detail: string, diagnosticCode: string, severity?: LossAuditRecord["severity"]) => void;

export function parseHermesRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  draft: SessionDraftLike,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const fragments: SourceFragment[] = [];
  const lossAudits: LossAuditRecord[] = [];
  const timeKey =
    helpers.coerceIso(parsed.timestamp) ??
    helpers.coerceIso(parsed.started_at) ??
    record.observed_at ??
    helpers.nowIso();
  const push: PushFragment = (fragmentKind, payload) => {
    fragments.push(helpers.createFragment(context, record, fragments.length, fragmentKind, timeKey, payload));
  };
  const loss: RecordLoss = (detail, diagnosticCode, severity = "info") => {
    lossAudits.push(helpers.createRecordLossAudit(context, record, "unknown_fragment", detail, {
      diagnosticCode,
      severity,
    }));
  };

  const kind = helpers.asString(parsed.kind) ?? recordKindFromPointer(record.record_path_or_offset);

  if (kind === "session") {
    appendSessionMetadata(helpers, parsed, draft, timeKey, push, loss);
    return { fragments, lossAudits };
  }

  if (kind === "usage") {
    appendSessionUsage(context, helpers, record, parsed, timeKey, fragments);
    return { fragments, lossAudits };
  }

  if (kind === "message") {
    appendMessage(helpers, parsed, push, loss);
    return { fragments, lossAudits };
  }

  loss(`Unhandled Hermes Agent record kind: ${kind ?? "unknown"}`, "hermes_unhandled_record_kind", "warning");
  return { fragments, lossAudits };
}

function recordKindFromPointer(pointer: string): string | undefined {
  if (pointer === "sqlite:sessions") return "session";
  if (pointer.startsWith("sqlite:session_model_usage") || pointer === "sqlite:sessions:usage") return "usage";
  if (pointer.startsWith("sqlite:messages[")) return "message";
  return undefined;
}

function appendSessionMetadata(
  helpers: CommonParseRuntimeHelpers,
  parsed: Record<string, unknown>,
  draft: SessionDraftLike,
  timeKey: string,
  push: PushFragment,
  loss: RecordLoss,
): void {
  const title = helpers.asString(parsed.title);
  const model = helpers.asString(parsed.model);
  const workingDirectory = helpers.asString(parsed.cwd) ?? helpers.asString(parsed.working_directory);
  if (title) {
    draft.title = title;
  }
  if (model) {
    draft.model = model;
  }
  if (workingDirectory) {
    draft.working_directory = workingDirectory;
  }

  push("session_meta", parsed);
  if (title) {
    push("title_signal", { title, title_source: "hermes_sessions_title" });
  }
  if (workingDirectory) {
    push("workspace_signal", { path: workingDirectory });
  }
  if (model) {
    push("model_signal", { model });
  }

  const lineageKind = helpers.asString(parsed.lineage_kind);
  const lineageParent = helpers.asString(parsed.lineage_parent);
  const sessionId = helpers.asString(parsed.id);
  if (lineageKind === "delegate" && lineageParent) {
    const childId = sessionId ?? helpers.asString(parsed.child_session_id);
    push("session_relation", {
      parent_uuid: lineageParent,
      child_session_id: childId,
      is_sidechain: true,
      relation_source: "hermes_model_config_delegate",
    });
    return;
  }
  if (lineageKind && lineageParent) {
    // Compression resets and user branches continue a conversation; they are
    // not delegated work, so the continuation stays a top-level session.
    loss(
      `Hermes session ${sessionId ?? "?"} continues a ${lineageKind} lineage of ${lineageParent}; kept as its own top-level session.`,
      "hermes_lineage_continuation",
    );
  }
}

function appendSessionUsage(
  context: FragmentBuildContextLike,
  helpers: CommonParseRuntimeHelpers,
  record: RawRecord,
  parsed: Record<string, unknown>,
  timeKey: string,
  fragments: SourceFragment[],
): void {
  const usage: TokenUsageLike = {
    input_tokens: helpers.asNumber(parsed.input_tokens),
    output_tokens: helpers.asNumber(parsed.output_tokens),
    cache_read_input_tokens: helpers.asNumber(parsed.cache_read_tokens),
    cache_creation_input_tokens: helpers.asNumber(parsed.cache_write_tokens),
    reasoning_output_tokens: helpers.asNumber(parsed.reasoning_tokens),
    model: helpers.asString(parsed.model),
  };
  const total = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
    usage.reasoning_output_tokens,
  ].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (total <= 0) {
    return;
  }
  fragments.push(helpers.createTokenUsageFragment(
    context,
    record,
    fragments.length,
    timeKey,
    { ...usage, total_tokens: total },
    undefined,
    {
      scope: "session",
      source_event_type: "hermes_session_usage",
      ...(helpers.asString(parsed.provider) ? { billing_provider: helpers.asString(parsed.provider) } : {}),
      ...(helpers.asNumber(parsed.api_calls) !== undefined ? { api_call_count: helpers.asNumber(parsed.api_calls) } : {}),
      ...(helpers.asString(parsed.task) ? { task: helpers.asString(parsed.task) } : {}),
    },
  ));
}

function appendMessage(
  helpers: CommonParseRuntimeHelpers,
  parsed: Record<string, unknown>,
  push: PushFragment,
  loss: RecordLoss,
): void {
  const role = helpers.asString(parsed.role) ?? "assistant";
  const messageId = helpers.asNumber(parsed.id);
  const content = parsed.content;

  if (role === "user") {
    appendContentItems(helpers, content, push, loss, {
      actorKind: "user",
      originKind: "user_authored",
      displayPolicy: "show",
      messageId,
    });
    return;
  }

  if (role === "assistant") {
    appendContentItems(helpers, content, push, loss, {
      actorKind: "assistant",
      originKind: "assistant_authored",
      displayPolicy: "show",
      messageId,
    });
    appendReasoning(helpers, parsed, push, messageId);
    appendToolCalls(helpers, parsed, push, loss);
    return;
  }

  if (role === "tool") {
    const output = helpers.stringifyToolContent(content);
    push("tool_result", {
      call_id: helpers.asString(parsed.tool_call_id),
      tool_name: helpers.asString(parsed.tool_name),
      output,
      source_event_type: "hermes_tool_message",
    });
    return;
  }

  if (role === "system") {
    return;
  }

  loss(`Unhandled Hermes Agent message role: ${role}`, "hermes_unhandled_message_role", "warning");
}

function appendContentItems(
  helpers: CommonParseRuntimeHelpers,
  content: unknown,
  push: PushFragment,
  loss: RecordLoss,
  options: {
    actorKind: "user" | "assistant";
    originKind: "user_authored" | "assistant_authored";
    displayPolicy: "show" | "collapse";
    messageId: number | undefined;
  },
): void {
  const pushText = (text: string | undefined): void => {
    if (!text?.trim()) {
      return;
    }
    push("text", {
      actor_kind: options.actorKind,
      origin_kind: options.originKind,
      text,
      display_policy: options.displayPolicy,
      ...(options.messageId !== undefined ? { message_id: String(options.messageId) } : {}),
    });
  };

  if (typeof content === "string") {
    pushText(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!helpers.isObject(item)) {
        continue;
      }
      const itemType = helpers.asString(item.type);
      if (itemType === "text" || itemType === "input_text" || itemType === "output_text") {
        pushText(helpers.asString(item.text));
        continue;
      }
      if (
        itemType === "image_url" ||
        itemType === "input_image" ||
        itemType === "image"
      ) {
        loss("Hermes image content was not projected as conversation text.", "hermes_image_content_not_projected");
        continue;
      }
      if (itemType === "file" || itemType === "input_file") {
        const label =
          helpers.asString(item.filename) ??
          helpers.asString(item.path) ??
          helpers.asString(item.name) ??
          "file";
        pushText(`[file] ${label}`);
        continue;
      }
      loss(`Unsupported Hermes content part type: ${String(itemType)}`, "hermes_unsupported_content_part");
    }
    return;
  }
  if (helpers.isObject(content)) {
    pushText(helpers.asString(content.text));
    return;
  }
}

function appendReasoning(
  helpers: CommonParseRuntimeHelpers,
  parsed: Record<string, unknown>,
  push: PushFragment,
  messageId: number | undefined,
): void {
  const reasoning = helpers.asString(parsed.reasoning);
  if (!reasoning?.trim()) {
    return;
  }
  push("text", {
    actor_kind: "assistant",
    origin_kind: "assistant_authored",
    text: reasoning,
    display_policy: "collapse",
    source_content_type: "reasoning",
    ...(messageId !== undefined ? { message_id: String(messageId) } : {}),
  });
}

function appendToolCalls(
  helpers: CommonParseRuntimeHelpers,
  parsed: Record<string, unknown>,
  push: PushFragment,
  loss: RecordLoss,
): void {
  const toolCalls = parsed.tool_calls;
  if (toolCalls === null || toolCalls === undefined) {
    return;
  }
  const calls = Array.isArray(toolCalls) ? toolCalls : helpers.isObject(toolCalls) ? [toolCalls] : [];
  if (calls.length === 0) {
    loss("Hermes assistant tool_calls payload was not a call list.", "hermes_tool_calls_malformed");
    return;
  }
  for (const call of calls) {
    if (!helpers.isObject(call)) {
      continue;
    }
    const fn = helpers.isObject(call.function) ? call.function : undefined;
    const name = helpers.asString(fn?.name) ?? helpers.asString(call.name) ?? "tool";
    push("tool_call", {
      call_id: helpers.asString(call.id) ?? helpers.asString(call.call_id),
      tool_name: name,
      input: parseArguments(fn?.arguments ?? call.arguments, helpers),
      source_event_type: "hermes_tool_calls",
    });
  }
}

function parseArguments(raw: unknown, helpers: CommonParseRuntimeHelpers): Record<string, unknown> {
  if (helpers.isObject(raw)) {
    return raw;
  }
  const text = helpers.asString(raw);
  if (!text) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return helpers.isObject(parsed) ? parsed : { raw: text };
}
