import type { FragmentKind, LossAuditRecord, RawRecord, SourceFragment } from "@cchistory/domain";
import type {
  CommonParseRuntimeHelpers,
  FragmentBuildContextLike,
  ParseRuntimeResult,
  SessionDraftLike,
  TokenUsageLike,
} from "../runtime-types.js";

/**
 * DeepSeek Harness event interpreter.
 *
 * Every durable row is one session event. Only surface-producing events become
 * conversation atoms; lifecycle, routing, approval, job and telemetry events
 * are interpreted as evidence-only. Assistant messages carry the per-call
 * token accounting, so usage stays at call granularity instead of being folded
 * into a session total.
 */

/** Events that carry no conversation text and are expected to be skipped. */
const EVIDENCE_ONLY_EVENT_TYPES = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/attempt",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "deliverables/presented",
  "developer/message",
  "feedback/message-delete",
  "feedback/message-put",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "image/offload",
  "job/registered",
  "job/settled",
  "llm/retry",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "sandbox/mode",
  "schedule/change",
  "session-log-deepseek/delivery-accepted",
  "session/end-seed",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  "system/message",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/mode",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "turn/end",
  "turn/start",
  "web/deepseek-search-llm-request",
  "working-directory/change",
  "workspace/changes",
]);

/** User-message sources that are harness-injected context, not human prompts. */
const INJECTED_USER_SOURCE_KINDS = new Set([
  "agent-instructions",
  "compaction",
  "cron",
  "goal-continuation",
  "notification",
  "runtime-context",
  "skill-catalog",
  "subagent-result",
  "time-context",
  "tool-jobs",
]);

type PushFragment = (fragmentKind: FragmentKind, payload: Record<string, unknown>) => void;
type RecordLoss = (detail: string, diagnosticCode: string, severity?: LossAuditRecord["severity"]) => void;

export function parseDeepSeekHarnessRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  draft: SessionDraftLike,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const fragments: SourceFragment[] = [];
  const lossAudits: LossAuditRecord[] = [];
  const recordType = helpers.asString(parsed.type) ?? "unknown";
  const data = helpers.isObject(parsed.data) ? parsed.data : undefined;
  const timeKey =
    helpers.epochMillisToIso(helpers.asNumber(parsed.time)) ??
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

  if (recordType === "session") {
    push("session_meta", parsed);
    return { fragments, lossAudits };
  }

  if (recordType === "user/message") {
    if (data) {
      appendUserMessage(helpers, data, push, loss);
    } else {
      loss("DeepSeek Harness user message record has no data body.", "dsh_user_message_missing");
    }
    return { fragments, lossAudits };
  }

  if (recordType === "assistant/message") {
    if (data) {
      appendAssistantMessage(context, helpers, record, data, draft, timeKey, fragments, push, loss);
    } else {
      loss("DeepSeek Harness assistant message record has no data body.", "dsh_assistant_message_missing");
    }
    return { fragments, lossAudits };
  }

  if (recordType === "tool/call") {
    if (data) {
      const rawArguments = helpers.asString(data.arguments);
      push("tool_call", {
        call_id: helpers.asString(data.callId),
        tool_name: helpers.asString(data.name) ?? "tool",
        input: parseToolInput(rawArguments, helpers),
        source_event_type: recordType,
      });
    } else {
      loss("DeepSeek Harness tool call record has no data body.", "dsh_tool_call_missing");
    }
    return { fragments, lossAudits };
  }

  if (recordType === "tool/result") {
    if (data) {
      appendToolResult(helpers, data, push, loss);
    } else {
      loss("DeepSeek Harness tool result record has no data body.", "dsh_tool_result_missing");
    }
    return { fragments, lossAudits };
  }

  if (recordType === "session/title") {
    const title = data ? helpers.asString(data.title) : undefined;
    if (title) {
      draft.title = title;
      push("title_signal", { title, title_source: helpers.asString(data?.source) });
    }
    return { fragments, lossAudits };
  }

  if (recordType === "request/context" || recordType === "model/selection") {
    if (data) {
      appendModelSignal(helpers, data, draft, push);
    }
    return { fragments, lossAudits };
  }

  if (recordType === "request/header") {
    const header = data && helpers.isObject(data.header) ? data.header : undefined;
    const config = header && helpers.isObject(header.config) ? header.config : undefined;
    if (config) {
      appendModelSignal(helpers, config, draft, push);
    }
    return { fragments, lossAudits };
  }

  if (recordType === "working-directory/change") {
    const nextDirectory = data
      ? helpers.asString(data.cwd) ?? helpers.asString(data.path) ?? helpers.asString(data.directory)
      : undefined;
    const normalized = nextDirectory ? helpers.normalizeWorkspacePath(nextDirectory) : undefined;
    if (normalized) {
      draft.working_directory = normalized;
      push("workspace_signal", { path: normalized });
    }
    return { fragments, lossAudits };
  }

  if (recordType === "compaction/summary") {
    // Compaction is a separate model call whose usage belongs to this session.
    // The summary text itself is re-published through the surface replacement
    // event, so it is not duplicated here.
    const usage = data ? helpers.extractTokenUsage(data.usage) : undefined;
    if (usage) {
      fragments.push(helpers.createTokenUsageFragment(
        context,
        record,
        fragments.length,
        timeKey,
        { ...usage, model: data ? helpers.asString(data.model) ?? usage.model : usage.model },
        undefined,
        {
          scope: "call",
          independent_usage_event_id: record.id,
          source_event_type: recordType,
          call_kind: "compaction",
        },
      ));
    }
    return { fragments, lossAudits };
  }

  if (recordType === "subagent/catalog") {
    const childId = data ? helpers.asString(data.childId) : undefined;
    if (childId) {
      const label = data ? helpers.asString(data.name) ?? helpers.asString(data.label) : undefined;
      push("session_relation", {
        parent_uuid: draft.source_session_id,
        child_session_id: childId,
        agent_id: label,
        relation_source: "subagent_catalog",
        child_created_at: data ? helpers.epochMillisToIso(helpers.asNumber(data.childCreatedAt)) : undefined,
        child_mode: data ? helpers.asString(data.mode) : undefined,
      });
    }
    return { fragments, lossAudits };
  }

  if (EVIDENCE_ONLY_EVENT_TYPES.has(recordType)) {
    return { fragments, lossAudits };
  }

  push("unknown", parsed);
  lossAudits.push(helpers.createRecordLossAudit(
    context,
    record,
    "unknown_fragment",
    `Unhandled DeepSeek Harness event type: ${recordType}`,
    { diagnosticCode: "dsh_unhandled_event_type", severity: "warning" },
  ));
  return { fragments, lossAudits };
}

function appendUserMessage(
  helpers: CommonParseRuntimeHelpers,
  data: Record<string, unknown>,
  push: PushFragment,
  loss: RecordLoss,
): void {
  const source = helpers.isObject(data.source) ? data.source : undefined;
  const sourceKind = helpers.asString(source?.kind);
  const isHumanPrompt = sourceKind === "user";
  const isInjected = sourceKind !== undefined && INJECTED_USER_SOURCE_KINDS.has(sourceKind);
  const originKind = sourceKind === undefined || isHumanPrompt ? "user_authored" : "injected_user_shaped";
  const displayPolicy = sourceKind === undefined || isHumanPrompt ? "show" : "collapse";
  const messageId = helpers.asString(data.id);

  if (sourceKind !== undefined && !isHumanPrompt && !isInjected) {
    loss(
      `DeepSeek Harness user message source kind "${sourceKind}" is not catalogued; kept as injected user-shaped context.`,
      "dsh_user_message_source_unknown",
    );
  }

  let textFragments = 0;
  for (const item of helpers.asArray(data.content)) {
    if (!helpers.isObject(item)) {
      continue;
    }
    const itemType = helpers.asString(item.type);
    if (itemType === "text") {
      const text = helpers.asString(item.text);
      if (!text) {
        continue;
      }
      push("text", {
        actor_kind: "user",
        origin_kind: originKind,
        text,
        display_policy: displayPolicy,
        ...(messageId ? { message_id: messageId } : {}),
        source_origin_kind: sourceKind,
        source_event_type: "user/message",
      });
      textFragments += 1;
      continue;
    }
    if (itemType === "image" || itemType === "file") {
      loss(
        `DeepSeek Harness ${itemType} attachment was not projected as conversation text.`,
        `dsh_user_${itemType}_attachment_not_projected`,
      );
      continue;
    }
    loss(`Unsupported DeepSeek Harness user content block type: ${String(itemType)}`, "dsh_unsupported_user_content_block");
  }

  if (textFragments === 0) {
    loss("DeepSeek Harness user message contained no projectable text block.", "dsh_user_message_text_missing");
  }
}

function appendAssistantMessage(
  context: FragmentBuildContextLike,
  helpers: CommonParseRuntimeHelpers,
  record: RawRecord,
  data: Record<string, unknown>,
  draft: SessionDraftLike,
  timeKey: string,
  fragments: SourceFragment[],
  push: PushFragment,
  loss: RecordLoss,
): void {
  const message = helpers.isObject(data.message) ? data.message : undefined;
  if (!message) {
    loss("DeepSeek Harness assistant message record has no message body.", "dsh_assistant_message_missing");
    return;
  }
  const source = helpers.isObject(message.source) ? message.source : undefined;
  const model = helpers.asString(source?.model);
  if (model) {
    draft.model = model;
  }
  const messageId = helpers.asString(message.id);

  for (const item of helpers.asArray(message.content)) {
    if (!helpers.isObject(item)) {
      continue;
    }
    const itemType = helpers.asString(item.type);
    if (itemType === "text") {
      const text = helpers.asString(item.text);
      if (!text) {
        continue;
      }
      push("text", {
        actor_kind: "assistant",
        origin_kind: "assistant_authored",
        text,
        display_policy: "show",
        ...(messageId ? { message_id: messageId } : {}),
        ...(model ? { model } : {}),
        source_event_type: "assistant/message",
      });
      continue;
    }
    if (itemType === "reasoning") {
      const text = helpers.asString(item.text);
      if (!text) {
        continue;
      }
      push("text", {
        actor_kind: "assistant",
        origin_kind: "assistant_authored",
        text,
        display_policy: "collapse",
        source_content_type: "reasoning",
        ...(messageId ? { message_id: messageId } : {}),
        ...(model ? { model } : {}),
        source_event_type: "assistant/message",
      });
      continue;
    }
    if (itemType === "tool-call") {
      // The paired tool/call event owns the durable call record, so the copy
      // embedded in the assistant message is not projected twice.
      continue;
    }
    loss(
      `Unsupported DeepSeek Harness assistant content block type: ${String(itemType)}`,
      "dsh_unsupported_assistant_content_block",
    );
  }

  const usage = helpers.extractTokenUsage(data.usage);
  if (usage) {
    fragments.push(helpers.createTokenUsageFragment(
      context,
      record,
      fragments.length,
      timeKey,
      { ...usage, model: model ?? usage.model },
      undefined,
      {
        scope: "call",
        ...(messageId ? { message_id: messageId } : {}),
        independent_usage_event_id: record.id,
        source_event_type: "assistant/message",
      },
    ));
  }
}

function appendToolResult(
  helpers: CommonParseRuntimeHelpers,
  data: Record<string, unknown>,
  push: PushFragment,
  loss: RecordLoss,
): void {
  const message = helpers.isObject(data.message) ? data.message : undefined;
  if (!message) {
    loss("DeepSeek Harness tool result record has no message body.", "dsh_tool_result_missing");
    return;
  }
  const callId = helpers.asString(message.toolCallId);
  const output = helpers.stringifyToolContent(message.content);
  const isError = helpers.asBoolean(message.isError);
  const error = helpers.isObject(data.error) ? data.error : undefined;
  push("tool_result", {
    call_id: callId,
    output,
    ...(isError !== undefined ? { is_error: isError } : {}),
    ...(error ? {
      error_name: helpers.asString(error.name),
      error_code: helpers.asString(error.code),
      error_reason: helpers.asString(error.reason),
    } : {}),
    source_event_type: "tool/result",
  });
}

function appendModelSignal(
  helpers: CommonParseRuntimeHelpers,
  data: Record<string, unknown>,
  draft: SessionDraftLike,
  push: PushFragment,
): void {
  const model = helpers.asString(data.model);
  const provider = helpers.asString(data.provider);
  if (model) {
    draft.model = model;
  }
  if (model || provider) {
    push("model_signal", {
      model,
      provider,
      context_window: helpers.asNumber(data.contextWindow),
    });
  }
}

function parseToolInput(rawArguments: string | undefined, helpers: CommonParseRuntimeHelpers): Record<string, unknown> {
  if (!rawArguments) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    return helpers.isObject(parsed) ? parsed : { arguments: rawArguments };
  } catch {
    return { arguments: rawArguments };
  }
}
