/**
 * Role: Pure canonical extraction of tool execution status, duration, masked normalized
 * target signatures, compaction markers, sidecar subagent attribution, and causal
 * tool-to-model-call binding for SessionUsageEvent enrichment.
 * Excludes usage aggregation, pricing, anomaly ranking, and CLI/TUI rendering.
 */

import { Buffer } from "node:buffer";
import type {
  AtomEdge,
  CapturedBlob,
  ConversationAtom,
  ParsedSessionMetadata,
  RawRecord,
  SessionUsageEvent,
  SourceFragment,
  UsageToolStatus,
  UsageToolSummary,
  UserTurnProjection,
} from "@cchistory/domain";
import {
  applyMaskTemplates,
  asString,
  extractStopReasonFromPayload,
  extractTokenUsageFromPayload,
  isObject,
} from "@cchistory/domain";

export const MAX_TOOL_SUMMARIES_PER_CALL = 16;
export const MAX_TOOL_SIGNATURE_CHARS = 80;
const MAX_SANE_TOOL_DURATION_MS = 24 * 60 * 60 * 1_000;

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "shell_command",
  "exec_command",
  "run_command",
  "terminal",
  "execute_command",
  "command_execution",
  "local_shell",
]);

const FILE_TOOL_NAMES = new Set([
  "read",
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "read_file",
  "write_file",
  "edit_file",
  "view_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file",
  "apply_patch",
]);

const SEARCH_TOOL_NAMES = new Set([
  "grep",
  "glob",
  "grep_search",
  "find_by_name",
  "list_dir",
  "search",
  "ripgrep",
]);

const SPAWN_TOOL_NAMES = new Set(["task", "agent", "spawn_subagent", "invoke_subagent"]);

const SUBAGENT_PATH_RE = /(?:^|[\\/])subagents[\\/]([^\\/]+?)(?:\.jsonl?)?$/iu;
const COMPACTION_SIGNAL_KINDS = new Set(["compacted", "context_compacted", "compact_boundary", "microcompact_boundary"]);

export interface ToolResultStatusInfo {
  status: UsageToolStatus;
  errorMessage?: string;
}

export function detectToolResultStatus(
  resultAtom: ConversationAtom | undefined,
): ToolResultStatusInfo {
  if (!resultAtom) {
    return { status: "pending" };
  }
  const payload = resultAtom.payload;
  const output = asString(payload.output) ?? "";
  const statusStr = asString(payload.status)?.toLowerCase();
  const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : extractExitCode(output);

  if (
    payload.is_error === true ||
    payload.isError === true ||
    payload.success === false ||
    payload.error === true ||
    statusStr === "error" ||
    statusStr === "failed" ||
    (exitCode !== undefined && exitCode !== 0)
  ) {
    return {
      status: "error",
      errorMessage: extractErrorMessage(payload, output, exitCode),
    };
  }

  const explicitErr = asString(payload.error) ?? asString(payload.error_message);
  if (explicitErr) {
    return { status: "error", errorMessage: firstLine(explicitErr, 120) };
  }

  if (/^(?:error|traceback|failed|fatal|exception|command failed|permission denied)\b/iu.test(output.trimStart())) {
    return { status: "error", errorMessage: firstLine(output, 120) };
  }

  return { status: "success" };
}

export function resolveToolCallDurationMs(
  callAtom: ConversationAtom,
  resultAtom: ConversationAtom | undefined,
): number | undefined {
  const fromResult = typeof resultAtom?.payload.duration_ms === "number" ? resultAtom.payload.duration_ms : undefined;
  if (fromResult !== undefined && Number.isFinite(fromResult) && fromResult >= 0 && fromResult <= MAX_SANE_TOOL_DURATION_MS) {
    return Math.round(fromResult);
  }
  const fromCall = typeof callAtom.payload.duration_ms === "number" ? callAtom.payload.duration_ms : undefined;
  if (fromCall !== undefined && Number.isFinite(fromCall) && fromCall >= 0 && fromCall <= MAX_SANE_TOOL_DURATION_MS) {
    return Math.round(fromCall);
  }
  if (!resultAtom) return undefined;
  const startMs = Date.parse(callAtom.time_key);
  const endMs = Date.parse(resultAtom.time_key);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  const diff = endMs - startMs;
  if (diff < 0 || diff > MAX_SANE_TOOL_DURATION_MS) return undefined;
  return Math.round(diff);
}

export function normalizeToolTargetSignature(
  toolName: string,
  input: Record<string, unknown> | undefined,
): { target_signature?: string; sample?: string } {
  const raw = extractPrimaryToolTarget(toolName, input);
  if (!raw) return {};

  const masked = applyMaskTemplates(raw, "tool_input").canonical_text.replace(/\s+/gu, " ").trim();
  if (!masked) return {};

  const sample = clipText(masked, MAX_TOOL_SIGNATURE_CHARS);
  const lowerTool = toolName.trim().toLowerCase();
  const normalized = SHELL_TOOL_NAMES.has(lowerTool)
    ? normalizeShellCommandSignature(masked)
    : FILE_TOOL_NAMES.has(lowerTool)
      ? normalizeFileTargetSignature(masked)
      : normalizeGenericSignature(masked);

  return {
    target_signature: clipText(normalized || sample, MAX_TOOL_SIGNATURE_CHARS),
    sample,
  };
}

function extractPrimaryToolTarget(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input || !isObject(input)) return undefined;
  const lowerTool = toolName.trim().toLowerCase();

  if (SHELL_TOOL_NAMES.has(lowerTool)) {
    const cmd =
      asString(input.command) ??
      asString(input.cmd) ??
      asString(input.CommandLine) ??
      asString(input.script) ??
      asString(input.raw);
    if (cmd) return cmd;
    if (Array.isArray(input.command)) {
      return input.command.filter((part): part is string => typeof part === "string").join(" ");
    }
  }

  if (FILE_TOOL_NAMES.has(lowerTool)) {
    return (
      asString(input.file_path) ??
      asString(input.path) ??
      asString(input.TargetFile) ??
      asString(input.AbsolutePath) ??
      asString(input.notebook_path) ??
      asString(input.file)
    );
  }

  if (SEARCH_TOOL_NAMES.has(lowerTool)) {
    const pattern = asString(input.pattern) ?? asString(input.query) ?? asString(input.Query) ?? asString(input.Pattern);
    const scope = asString(input.path) ?? asString(input.SearchPath) ?? asString(input.SearchDirectory);
    if (pattern && scope) return `${pattern} @ ${shortenPath(scope)}`;
    return pattern ?? scope;
  }

  if (SPAWN_TOOL_NAMES.has(lowerTool)) {
    const subType = asString(input.subagent_type) ?? asString(input.TypeName) ?? asString(input.Role) ?? asString(input.agent_type);
    const desc = asString(input.description) ?? asString(input.task) ?? asString(input.prompt) ?? asString(input.Prompt);
    if (subType && desc) return `${subType}: ${firstLine(desc, 60)}`;
    return subType ?? (desc ? firstLine(desc, 60) : undefined);
  }

  if (lowerTool === "call_mcp_tool" || lowerTool === "use_mcp_tool") {
    const serverName = asString(input.ServerName) ?? asString(input.server_name) ?? asString(input.server);
    const mcpTool = asString(input.ToolName) ?? asString(input.tool_name) ?? asString(input.tool);
    if (serverName && mcpTool) return `${serverName}:${mcpTool}`;
    if (serverName) return serverName;
  }

  for (const key of ["url", "query", "command", "cmd", "path", "file_path", "target", "name", "id", "pattern", "description", "raw"]) {
    const candidate = asString(input[key]);
    if (candidate?.trim()) return candidate;
  }
  return undefined;
}

function normalizeShellCommandSignature(command: string): string {
  // Take the first command segment before unquoted pipes/chains if very long,
  // while stripping leading `cd <dir> &&` and inline env var assignments.
  let cleaned = command.replace(/\s+/gu, " ").trim();
  cleaned = cleaned.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/u, "");
  cleaned = cleaned.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/u, "");

  // Collapse quoted long payloads while preserving command structure.
  cleaned = cleaned.replace(/'[^']{24,}'/gu, "'<str>'").replace(/"[^"]{24,}"/gu, '"<str>"');

  // Normalize ephemeral identifiers so repeated polling/retry commands cluster cleanly.
  cleaned = cleaned
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gu, "<ts>")
    .replace(/\b([a-z][a-z0-9-]*)-[a-f0-9]{6,10}(?:-[a-z0-9]{4,6})?\b/gu, "$1-<id>")
    .replace(/\b[0-9a-f]{8,}\b/giu, "<hex>")
    .replace(/(?<![A-Za-z_.-])\d{3,}(?![A-Za-z_.-])/gu, "<num>");

  return cleaned.trim();
}

function normalizeFileTargetSignature(filePath: string): string {
  return shortenPath(filePath.replace(/\\/gu, "/"));
}

function normalizeGenericSignature(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replace(/\b[0-9a-f]{10,}\b/giu, "<hex>")
    .replace(/\s+/gu, " ")
    .trim();
}

function shortenPath(raw: string): string {
  const normalized = raw.replace(/\\/gu, "/").trim();
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join("/")}`;
}

export function extractSidecarSubagentKey(
  blobOriginPath: string | undefined,
  atomPayload: Record<string, unknown>,
  sourceSessionId: string | undefined,
): string | undefined {
  if (blobOriginPath) {
    const match = SUBAGENT_PATH_RE.exec(blobOriginPath.replace(/\\/gu, "/"));
    if (match?.[1] && match[1] !== sourceSessionId) {
      return match[1];
    }
  }
  if (atomPayload.is_sidechain === true) {
    const agentId = asString(atomPayload.agent_id);
    if (agentId && agentId !== sourceSessionId) return agentId;
  }
  return undefined;
}

export function isCompactionBoundaryAtom(atom: ConversationAtom): boolean {
  const signalKind = asString(atom.payload.signal_kind);
  if (signalKind && COMPACTION_SIGNAL_KINDS.has(signalKind)) return true;
  const sourceEventType = asString(atom.payload.source_event_type);
  if (sourceEventType && COMPACTION_SIGNAL_KINDS.has(sourceEventType)) return true;
  if (atom.origin_kind === "injected_user_shaped" && atom.content_kind === "text") {
    const text = asString(atom.payload.text) ?? "";
    if (/^This session is being continued from a previous conversation\b/iu.test(text.trimStart())) {
      return true;
    }
  }
  return false;
}

export function buildUsageToolSummary(
  callAtom: ConversationAtom,
  resultAtom: ConversationAtom | undefined,
): UsageToolSummary {
  const toolName = asString(callAtom.payload.tool_name) ?? "tool_call";
  const input = isObject(callAtom.payload.input) ? callAtom.payload.input : undefined;
  const { target_signature, sample } = normalizeToolTargetSignature(toolName, input);
  const statusInfo = detectToolResultStatus(resultAtom);
  const durationMs = resolveToolCallDurationMs(callAtom, resultAtom);
  const inputBytes = input ? Buffer.byteLength(JSON.stringify(input), "utf8") : undefined;
  const outputText = resultAtom ? asString(resultAtom.payload.output) : undefined;
  const outputBytes = outputText !== undefined ? Buffer.byteLength(outputText, "utf8") : undefined;
  const callId = asString(callAtom.payload.call_id);
  const subagentRef = extractSpawnedSubagentRef(toolName, input, resultAtom?.payload);

  return {
    tool_name: toolName,
    ...(target_signature ? { target_signature } : {}),
    ...(sample && sample !== target_signature ? { sample } : {}),
    status: statusInfo.status,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(inputBytes !== undefined && inputBytes > 0 ? { input_bytes: inputBytes } : {}),
    ...(outputBytes !== undefined && outputBytes > 0 ? { output_bytes: outputBytes } : {}),
    ...(callId ? { call_id: callId } : {}),
    ...(subagentRef ? { subagent_ref: subagentRef } : {}),
  };
}

function extractSpawnedSubagentRef(
  toolName: string,
  input: Record<string, unknown> | undefined,
  resultPayload: Record<string, unknown> | undefined,
): string | undefined {
  if (!SPAWN_TOOL_NAMES.has(toolName.trim().toLowerCase())) return undefined;
  for (const container of [resultPayload, input]) {
    if (!container || !isObject(container)) continue;
    for (const key of ["child_session_ref", "child_session_id", "subagent_id", "agent_id", "conversationId", "task_id"]) {
      const value = asString(container[key]);
      if (value) return value;
    }
  }
  return undefined;
}

export function buildSessionUsageEvents(params: {
  draft: Readonly<ParsedSessionMetadata>;
  atoms: readonly ConversationAtom[];
  fragments: readonly SourceFragment[];
  records: readonly RawRecord[];
  blobs: readonly CapturedBlob[];
  turns: readonly UserTurnProjection[];
  edges: readonly AtomEdge[];
}): SessionUsageEvent[] {
  const { draft, atoms, fragments, records, blobs, turns, edges } = params;
  const fragmentById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const blobById = new Map(blobs.map((blob) => [blob.id, blob]));

  const blobPathForAtom = (atom: ConversationAtom): string | undefined => {
    for (const fragRef of atom.fragment_refs) {
      const recordId = fragmentById.get(fragRef)?.record_id;
      if (!recordId) continue;
      const blobId = recordById.get(recordId)?.blob_id;
      if (!blobId) continue;
      const blob = blobById.get(blobId);
      if (blob) return blob.origin_path;
    }
    return undefined;
  };

  const threadKeyForAtom = (atom: ConversationAtom): string | undefined =>
    extractSidecarSubagentKey(blobPathForAtom(atom), atom.payload, draft.source_session_id);

  // Collect deduplicated independent usage call atoms with their positions in `atoms`.
  const seenCallIds = new Set<string>();
  interface CallEntry {
    index: number;
    atomIndex: number;
    atom: ConversationAtom;
    id: string;
    usageScope: "call" | "session";
    threadKey: string;
    subagentKey?: string;
    messageId?: string;
    coveredStepIndices?: Set<number>;
    compactionBefore: boolean;
    emittedTools: UsageToolSummary[];
    precedingTools: UsageToolSummary[];
    truncatedCount: number;
  }

  const calls: CallEntry[] = [];
  const callsByThread = new Map<string, CallEntry[]>();
  const callByMessageId = new Map<string, CallEntry>();
  const callByStepIndex = new Map<number, CallEntry>();
  const compactionPendingByThread = new Map<string, boolean>();

  for (let atomIndex = 0; atomIndex < atoms.length; atomIndex += 1) {
    const atom = atoms[atomIndex]!;
    const subagentKey = threadKeyForAtom(atom);
    const threadKey = subagentKey ?? "__main__";
    if (isCompactionBoundaryAtom(atom)) {
      compactionPendingByThread.set(threadKey, true);
    }
    const id = asString(atom.payload.independent_usage_event_id);
    if (!id || seenCallIds.has(id) || !extractTokenUsageFromPayload(atom.payload)) continue;
    seenCallIds.add(id);

    const usageScope: "call" | "session" = asString(atom.payload.scope) === "session" ? "session" : "call";
    const messageId = asString(atom.payload.message_id);
    const coveredRaw = atom.payload.covered_step_indices;
    const coveredStepIndices = Array.isArray(coveredRaw)
      ? new Set(coveredRaw.filter((value): value is number => typeof value === "number"))
      : undefined;

    const entry: CallEntry = {
      index: calls.length,
      atomIndex,
      atom,
      id,
      usageScope,
      threadKey,
      subagentKey,
      messageId,
      coveredStepIndices: coveredStepIndices && coveredStepIndices.size > 0 ? coveredStepIndices : undefined,
      compactionBefore: usageScope === "call" && compactionPendingByThread.get(threadKey) === true,
      emittedTools: [],
      precedingTools: [],
      truncatedCount: 0,
    };
    if (usageScope === "call") {
      compactionPendingByThread.set(threadKey, false);
    }
    calls.push(entry);

    if (usageScope === "session") {
      continue;
    }

    const threadCalls = callsByThread.get(threadKey) ?? [];
    threadCalls.push(entry);
    callsByThread.set(threadKey, threadCalls);

    if (messageId && !callByMessageId.has(`${threadKey}:${messageId}`)) {
      callByMessageId.set(`${threadKey}:${messageId}`, entry);
    }
    if (entry.coveredStepIndices) {
      for (const stepIndex of entry.coveredStepIndices) {
        if (!callByStepIndex.has(stepIndex)) callByStepIndex.set(stepIndex, entry);
      }
    }
  }

  if (calls.length === 0) return [];

  // Index tool_call <-> tool_result pairs.
  const atomIndexById = new Map<string, number>();
  const atomById = new Map<string, ConversationAtom>();
  const toolCallByCallId = new Map<string, { atom: ConversationAtom; atomIndex: number }>();
  const resultAtomByToolAtomId = new Map<string, { atom: ConversationAtom; atomIndex: number }>();

  for (let i = 0; i < atoms.length; i += 1) {
    const atom = atoms[i]!;
    atomIndexById.set(atom.id, i);
    atomById.set(atom.id, atom);
    if (atom.content_kind === "tool_call") {
      const callId = asString(atom.payload.call_id);
      if (callId && !toolCallByCallId.has(callId)) {
        toolCallByCallId.set(callId, { atom, atomIndex: i });
      }
    }
  }

  for (const edge of edges) {
    if (edge.edge_kind !== "tool_result_for") continue;
    const resultAtom = atomById.get(edge.from_atom_id);
    const resultIndex = atomIndexById.get(edge.from_atom_id);
    if (resultAtom && resultIndex !== undefined && !resultAtomByToolAtomId.has(edge.to_atom_id)) {
      resultAtomByToolAtomId.set(edge.to_atom_id, { atom: resultAtom, atomIndex: resultIndex });
    }
  }

  // Fallback call_id pairing if an edge was absent.
  for (let i = 0; i < atoms.length; i += 1) {
    const atom = atoms[i]!;
    if (atom.content_kind !== "tool_result") continue;
    const callId = asString(atom.payload.call_id);
    if (!callId) continue;
    const matchedCall = toolCallByCallId.get(callId);
    if (matchedCall && !resultAtomByToolAtomId.has(matchedCall.atom.id)) {
      resultAtomByToolAtomId.set(matchedCall.atom.id, { atom, atomIndex: i });
    }
  }

  const pushCapped = (target: CallEntry, bucket: "emittedTools" | "precedingTools", summary: UsageToolSummary): void => {
    if (target[bucket].length < MAX_TOOL_SUMMARIES_PER_CALL) {
      target[bucket].push(summary);
    } else {
      target.truncatedCount += 1;
    }
  };

  // Bind each tool_call to its emitting model call and each tool_result to the next consuming call.
  const boundToolSummaries = new Map<string, UsageToolSummary>();
  for (let atomIndex = 0; atomIndex < atoms.length; atomIndex += 1) {
    const atom = atoms[atomIndex]!;
    if (atom.content_kind !== "tool_call" || atom.display_policy === "hide") continue;
    const subagentKey = threadKeyForAtom(atom);
    const threadKey = subagentKey ?? "__main__";
    const threadCalls = callsByThread.get(threadKey);
    if (!threadCalls?.length) continue;

    const matchedResult = resultAtomByToolAtomId.get(atom.id);
    const summary = buildUsageToolSummary(atom, matchedResult?.atom);
    boundToolSummaries.set(atom.id, summary);

    // 1. Exact binding via message_id (Claude Code) or step_index (Antigravity).
    const msgId = asString(atom.payload.message_id);
    const stepIndex = typeof atom.payload.step_index === "number" ? atom.payload.step_index : undefined;
    let emitter =
      (msgId ? callByMessageId.get(`${threadKey}:${msgId}`) : undefined) ??
      (stepIndex !== undefined ? callByStepIndex.get(stepIndex) : undefined);

    // 2. Chronological fallback: find the nearest usage call on this thread at or before the tool result.
    if (!emitter) {
      const upperBound = matchedResult ? matchedResult.atomIndex : Number.POSITIVE_INFINITY;
      let best: CallEntry | undefined;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const candidate of threadCalls) {
        if (candidate.atomIndex > upperBound) break;
        const dist = Math.abs(candidate.atomIndex - atomIndex);
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
      emitter = best ?? threadCalls[0];
    }

    if (emitter) {
      pushCapped(emitter, "emittedTools", summary);
    }
  }

  // Bind tool_results causally to the NEXT model call on the same thread (the call that ingests them).
  for (let atomIndex = 0; atomIndex < atoms.length; atomIndex += 1) {
    const atom = atoms[atomIndex]!;
    if (atom.content_kind !== "tool_result" || atom.display_policy === "hide") continue;
    const subagentKey = threadKeyForAtom(atom);
    const threadKey = subagentKey ?? "__main__";
    const threadCalls = callsByThread.get(threadKey);
    if (!threadCalls?.length) continue;

    const consumer = threadCalls.find((candidate) => candidate.atomIndex > atomIndex);
    if (!consumer) continue;

    const callId = asString(atom.payload.call_id);
    const matchedCall = callId ? toolCallByCallId.get(callId) : undefined;
    const summary = matchedCall
      ? boundToolSummaries.get(matchedCall.atom.id) ?? buildUsageToolSummary(matchedCall.atom, atom)
      : {
          tool_name: asString(atom.payload.tool_name) ?? "tool_result",
          status: detectToolResultStatus(atom).status,
          ...(typeof atom.payload.duration_ms === "number" ? { duration_ms: Math.round(atom.payload.duration_ms) } : {}),
          ...(asString(atom.payload.output) !== undefined
            ? { output_bytes: Buffer.byteLength(asString(atom.payload.output)!, "utf8") }
            : {}),
          ...(callId ? { call_id: callId } : {}),
        };
    pushCapped(consumer, "precedingTools", summary);
  }

  const turnByAtom = new Map(turns.flatMap((turn) => turn.lineage.atom_refs.map((ref) => [ref, turn.id] as const)));
  return calls.map((entry, idx): SessionUsageEvent => {
    const stopReason = extractStopReasonFromPayload(entry.atom.payload);
    return {
      id: entry.id,
      turn_id: turnByAtom.get(entry.atom.id) ?? null,
      created_at: entry.atom.time_key,
      model: asString(entry.atom.payload.model),
      token_usage: extractTokenUsageFromPayload(entry.atom.payload)!,
      ...(entry.usageScope === "session" ? { usage_scope: "session" as const } : {}),
      seq: idx + 1,
      ...(stopReason ? { stop_reason: stopReason } : {}),
      ...(entry.subagentKey ? { subagent_key: entry.subagentKey } : {}),
      ...(entry.compactionBefore ? { compaction_before: true } : {}),
      ...(entry.precedingTools.length > 0 ? { preceding_tool_results: entry.precedingTools } : {}),
      ...(entry.emittedTools.length > 0 ? { emitted_tool_calls: entry.emittedTools } : {}),
      ...(entry.truncatedCount > 0 ? { truncated_tool_count: entry.truncatedCount } : {}),
    };
  });
}

function extractExitCode(output: string): number | undefined {
  const match = /\b(?:Process exited with code|Exit code:?|exit_code"?\s*:\s*)\s*(-?\d+)\b/iu.exec(output);
  if (!match?.[1]) return undefined;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : undefined;
}

function extractErrorMessage(
  payload: Record<string, unknown>,
  output: string,
  exitCode: number | undefined,
): string | undefined {
  const explicit = asString(payload.error_message) ?? asString(payload.error);
  if (explicit) return firstLine(explicit, 120);
  const trimmed = output.trim();
  if (trimmed) return firstLine(trimmed, 120);
  if (exitCode !== undefined && exitCode !== 0) return `exit code ${exitCode}`;
  return undefined;
}

function firstLine(value: string, maxChars: number): string {
  const line = value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return clipText(line ?? value.trim(), maxChars);
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}
