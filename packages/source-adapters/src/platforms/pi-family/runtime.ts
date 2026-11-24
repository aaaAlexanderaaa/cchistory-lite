import type { FragmentKind, LossAuditRecord, RawRecord, SourceFragment } from "@cchistory/domain";
import type {
  CommonParseRuntimeHelpers,
  FragmentBuildContextLike,
  ParseRuntimeResult,
  SessionDraftLike,
  TokenUsageLike,
} from "../runtime-types.js";

/**
 * Pi / Oh My Pi session interpreter.
 *
 * One file is one session. Entries are tree nodes; the reader already selected
 * the active branch and projected each node as a `message`/`model_change`/
 * `usage`/`compaction`/`branch_summary`/`title`/`reset_boundary` record.
 * Assistant messages carry per-call usage, so calls stay independently
 * attributable while compaction and tool-side model work keep their own usage
 * records instead of overwriting a reply's accounting.
 */

type PushFragment = (fragmentKind: FragmentKind, payload: Record<string, unknown>) => void;
type RecordLoss = (detail: string, diagnosticCode: string, severity?: LossAuditRecord["severity"]) => void;

export function parsePiFamilyRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  draft: SessionDraftLike,
  helpers: CommonParseRuntimeHelpers,
): ParseRuntimeResult {
  const fragments: SourceFragment[] = [];
  const lossAudits: LossAuditRecord[] = [];
  const kind = helpers.asString(parsed.kind) ?? "unknown";
  const timeKey =
    helpers.coerceIso(parsed.timestamp) ??
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

  if (kind === "session") {
    const title = helpers.asString(parsed.title)?.trim();
    const workingDirectory = helpers.asString(parsed.cwd);
    if (title) {
      draft.title = title;
    }
    if (workingDirectory) {
      draft.working_directory = workingDirectory;
    }
    push("session_meta", parsed);
    if (title) {
      push("title_signal", { title, title_source: "pi_session_title" });
    }
    if (workingDirectory) {
      push("workspace_signal", { path: workingDirectory });
    }
    const parentSession = helpers.asString(parsed.parent_session);
    if (parsed.delegated === true && parentSession) {
      push("session_relation", {
        parent_uuid: parentSession,
        child_session_id: helpers.asString(parsed.id),
        is_sidechain: true,
        relation_source: "pi_task_parent_session",
      });
    } else if (parentSession) {
      loss(
        `Session lineage ${parentSession} is an ordinary fork/clone rather than delegated work; kept as a top-level session.`,
        "pi_family_fork_lineage_not_delegated",
      );
    }
    return { fragments, lossAudits };
  }

  if (kind === "title") {
    const title = helpers.asString(parsed.title)?.trim();
    if (title) {
      draft.title = title;
      push("title_signal", { title, title_source: "pi_title_change" });
    }
    return { fragments, lossAudits };
  }

  if (kind === "model_change") {
    const model = helpers.asString(parsed.model);
    const provider = helpers.asString(parsed.provider);
    if (model) {
      draft.model = model;
    }
    if (model || provider) {
      push("model_signal", { model, provider, role: helpers.asString(parsed.role) });
    }
    return { fragments, lossAudits };
  }

  if (kind === "usage") {
    appendUsageRecord(context, record, parsed, timeKey, fragments, helpers, {
      sourceEventType: "pi_family_usage_entry",
      callKind: helpers.asString(parsed.purpose) ?? "usage_entry",
    });
    return { fragments, lossAudits };
  }

  if (kind === "compaction" || kind === "branch_summary") {
    const summary = helpers.asString(parsed.summary);
    if (summary?.trim()) {
      push("text", {
        actor_kind: "system",
        origin_kind: "source_instruction",
        display_policy: "collapse",
        synthetic: true,
        signal_kind: "compact_boundary",
        source_event_type: "context_compacted",
        text: summary,
      });
    }
    appendUsageRecord(context, record, parsed, timeKey, fragments, helpers, {
      sourceEventType: `pi_family_${kind}`,
      callKind: kind,
    });
    return { fragments, lossAudits };
  }

  if (kind === "reset_boundary") {
    loss(
      "A reset boundary starts a new context inside the same file; earlier entries stay part of the full-history transcript.",
      "pi_family_reset_boundary_evidence",
    );
    return { fragments, lossAudits };
  }

  if (kind === "message") {
    const message = helpers.isObject(parsed.message) ? parsed.message : undefined;
    if (!message) {
      loss("Pi/OMP message entry has no message body.", "pi_family_message_missing", "warning");
      return { fragments, lossAudits };
    }
    const entryId = helpers.asString(parsed.entry_id);
    appendMessage(context, record, message, entryId, draft, timeKey, fragments, push, loss, helpers);
    return { fragments, lossAudits };
  }

  loss(`Unhandled Pi/OMP record kind: ${kind}`, "pi_family_unhandled_record_kind", "warning");
  return { fragments, lossAudits };
}

interface UsageAppendOptions {
  sourceEventType: string;
  callKind: string;
  messageId?: string;
}

function mapPiStopReason(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  // Pi persists the camelCase provider value; canonical's stop-reason alias
  // table only knows the snake_case form.
  return value === "toolUse" ? "tool_use" : value;
}

function appendUsageRecord(
  context: FragmentBuildContextLike,
  record: RawRecord,
  parsed: Record<string, unknown>,
  timeKey: string,
  fragments: SourceFragment[],
  helpers: CommonParseRuntimeHelpers,
  options: UsageAppendOptions,
): void {
  const usage = normalizeUsage(parsed.usage, helpers.asString(parsed.model), helpers);
  if (!usage) {
    return;
  }
  fragments.push(helpers.createTokenUsageFragment(
    context,
    record,
    fragments.length,
    timeKey,
    usage,
    helpers.normalizeStopReason(mapPiStopReason(helpers.asString(parsed.stop_reason))),
    {
      scope: "call",
      independent_usage_event_id: record.id,
      source_event_type: options.sourceEventType,
      call_kind: options.callKind,
      ...(options.messageId ? { message_id: options.messageId } : {}),
      ...(helpers.asString(parsed.provider) ? { billing_provider: helpers.asString(parsed.provider) } : {}),
    },
  ));
}

function appendMessage(
  context: FragmentBuildContextLike,
  record: RawRecord,
  message: Record<string, unknown>,
  entryId: string | undefined,
  draft: SessionDraftLike,
  timeKey: string,
  fragments: SourceFragment[],
  push: PushFragment,
  loss: RecordLoss,
  helpers: CommonParseRuntimeHelpers,
): void {
  const role = helpers.asString(message.role);
  const messageTimestamp = helpers.epochMillisToIso(helpers.asNumber(message.timestamp));
  const messageTimeKey = messageTimestamp ?? timeKey;

  const pushText = (text: string | undefined, options: {
    actorKind: "user" | "assistant" | "system";
    originKind: string;
    displayPolicy: "show" | "collapse";
    contentType?: string;
  }): void => {
    if (!text?.trim()) {
      return;
    }
    fragments.push(helpers.createFragment(context, record, fragments.length, "text", messageTimeKey, {
      actor_kind: options.actorKind,
      origin_kind: options.originKind,
      text,
      display_policy: options.displayPolicy,
      ...(options.contentType ? { source_content_type: options.contentType } : {}),
      ...(entryId ? { message_id: entryId } : {}),
    }));
  };

  if (role === "user") {
    appendContentBlocks(message.content, helpers, {
      text: (text) => pushText(text, { actorKind: "user", originKind: "user_authored", displayPolicy: "show" }),
      image: () => loss("Pi/OMP user image content was not projected as conversation text.", "pi_family_image_content_not_projected"),
      unknown: (type) => loss(`Unsupported Pi/OMP user content block ${String(type)}.`, "pi_family_unsupported_user_block"),
    });
    return;
  }

  if (role === "assistant") {
    appendContentBlocks(message.content, helpers, {
      text: (text) => pushText(text, { actorKind: "assistant", originKind: "assistant_authored", displayPolicy: "show" }),
      thinking: (text) => pushText(text, {
        actorKind: "assistant",
        originKind: "assistant_authored",
        displayPolicy: "collapse",
        contentType: "reasoning",
      }),
      toolCall: (callId, name, input) => {
        fragments.push(helpers.createFragment(context, record, fragments.length, "tool_call", messageTimeKey, {
          call_id: callId,
          tool_name: name,
          input,
          ...(entryId ? { message_id: entryId } : {}),
          source_event_type: "pi_assistant_tool_call",
        }));
      },
      image: () => loss("Pi/OMP assistant image content was not projected as conversation text.", "pi_family_assistant_image_not_projected"),
      unknown: (type) => loss(`Unsupported Pi/OMP assistant content block ${String(type)}.`, "pi_family_unsupported_assistant_block"),
    });
    if (helpers.asString(message.errorMessage)) {
      loss(
        `Assistant message ${entryId ?? "?"} reported an error: ${helpers.asString(message.errorMessage)}`,
        "pi_family_assistant_error_evidence",
      );
    }
    const assistantModel = helpers.asString(message.responseModel) ?? helpers.asString(message.model);
    if (assistantModel) {
      draft.model = assistantModel;
      fragments.push(helpers.createFragment(context, record, fragments.length, "model_signal", messageTimeKey, {
        model: assistantModel,
        provider: helpers.asString(message.provider),
      }));
    }
    appendUsageRecord(context, record, {
      usage: message.usage,
      model: assistantModel,
      stop_reason: mapPiStopReason(helpers.asString(message.stopReason)),
      provider: helpers.asString(message.provider),
    }, messageTimeKey, fragments, helpers, {
      sourceEventType: "pi_assistant_message",
      callKind: "assistant",
      ...(entryId ? { messageId: entryId } : {}),
    });
    return;
  }

  if (role === "toolResult") {
    const output = contentToText(message.content, helpers);
    fragments.push(helpers.createFragment(context, record, fragments.length, "tool_result", messageTimeKey, {
      call_id: helpers.asString(message.toolCallId),
      tool_name: helpers.asString(message.toolName),
      output,
      ...(typeof message.isError === "boolean" ? { is_error: message.isError } : {}),
      source_event_type: "pi_tool_result",
    }));
    // A tool can perform nested model work; that usage is a separate call, not
    // part of the assistant reply that requested the tool.
    appendUsageRecord(context, record, {
      usage: message.usage,
      model: helpers.asString(message.model),
      provider: helpers.asString(message.provider),
    }, messageTimeKey, fragments, helpers, {
      sourceEventType: "pi_tool_result_usage",
      callKind: "tool_nested",
    });
    return;
  }

  if (role === "system") {
    return;
  }

  if (role === "developer") {
    pushText(contentToText(message.content, helpers), {
      actorKind: "system",
      originKind: "source_instruction",
      displayPolicy: "collapse",
    });
    return;
  }

  if (role === "bashExecution" || role === "pythonExecution") {
    const command = helpers.asString(message.command) ?? helpers.asString(message.code);
    const output = helpers.asString(message.output);
    const exitCode = helpers.asNumber(message.exitCode);
    const text = [
      command ? `$ ${command}` : role,
      output,
      exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : undefined,
    ].filter((value): value is string => Boolean(value)).join("\n");
    pushText(text || `${role} evidence`, {
      actorKind: "system",
      originKind: "source_instruction",
      displayPolicy: "collapse",
    });
    return;
  }

  if (role === "custom" || role === "hookMessage") {
    pushText(contentToText(message.content, helpers), {
      actorKind: "system",
      originKind: "source_instruction",
      displayPolicy: "collapse",
    });
    return;
  }

  if (role === "branchSummary" || role === "compactionSummary") {
    pushText(helpers.asString(message.summary), {
      actorKind: "system",
      originKind: "source_instruction",
      displayPolicy: "collapse",
    });
    return;
  }

  if (role === "fileMention") {
    const files = Array.isArray(message.files) ? message.files : [];
    const labels = files
      .map((file) => (isPiObject(file) ? asPiString(file.path) ?? asPiString(file.name) : undefined))
      .filter((value): value is string => Boolean(value));
    pushText(labels.length > 0 ? labels.map((label) => `[file] ${label}`).join("\n") : contentToText(message.content, helpers), {
      actorKind: "user",
      originKind: "injected_user_shaped",
      displayPolicy: "collapse",
    });
    return;
  }

  loss(`Unhandled Pi/OMP message role: ${String(role)}`, "pi_family_unhandled_message_role", "warning");
}

interface ContentHandlers {
  text(text: string): void;
  thinking?(text: string): void;
  toolCall?(callId: string | undefined, name: string, input: Record<string, unknown>): void;
  image?(): void;
  unknown(type: unknown): void;
}

function appendContentBlocks(
  content: unknown,
  helpers: CommonParseRuntimeHelpers,
  handlers: ContentHandlers,
): void {
  if (typeof content === "string") {
    handlers.text(content);
    return;
  }
  if (!Array.isArray(content)) {
    if (helpers.isObject(content)) {
      handlers.text(helpers.asString(content.text) ?? "");
    }
    return;
  }
  for (const block of content) {
    if (!helpers.isObject(block)) {
      continue;
    }
    const type = helpers.asString(block.type);
    if (type === "text") {
      handlers.text(helpers.asString(block.text) ?? "");
      continue;
    }
    if (type === "thinking") {
      const thinking = helpers.asString(block.thinking);
      if (thinking) {
        handlers.thinking?.(thinking);
      }
      continue;
    }
    if (type === "toolCall") {
      handlers.toolCall?.(
        helpers.asString(block.id),
        helpers.asString(block.name) ?? "tool",
        helpers.isObject(block.arguments) ? block.arguments : {},
      );
      continue;
    }
    if (type === "image") {
      handlers.image?.();
      continue;
    }
    handlers.unknown(type);
  }
}

function contentToText(content: unknown, helpers: CommonParseRuntimeHelpers): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return helpers.isObject(content) ? helpers.asString(content.text) ?? "" : "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!helpers.isObject(block)) {
      continue;
    }
    if (helpers.asString(block.type) === "text") {
      const text = helpers.asString(block.text);
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (helpers.asString(block.type) === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function normalizeUsage(
  raw: unknown,
  model: string | undefined,
  helpers: CommonParseRuntimeHelpers,
): TokenUsageLike | undefined {
  if (!helpers.isObject(raw)) {
    return undefined;
  }
  const input = helpers.asNumber(raw.input);
  const output = helpers.asNumber(raw.output);
  const cacheRead = helpers.asNumber(raw.cacheRead);
  const cacheWrite = helpers.asNumber(raw.cacheWrite);
  const reasoning = helpers.asNumber(raw.reasoning);
  const total = helpers.asNumber(raw.totalTokens);
  const values = [input, output, cacheRead, cacheWrite, reasoning];
  if (values.every((value) => value === undefined)) {
    return undefined;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    // Pi documents `reasoning` as already included in `output`; keep it as
    // evidence without adding it to the total a second time.
    reasoning_output_tokens: reasoning,
    // reasoning is a subset of output; the fallback mirrors Pi's own
    // input + output + cacheRead + cacheWrite total.
    total_tokens: total ?? [input, output, cacheRead, cacheWrite].reduce<number>((sum, value) => sum + (value ?? 0), 0),
    model,
  };
}

function isPiObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPiString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
