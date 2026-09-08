import { createReadStream } from "node:fs";
import type { SourceFileReadPlan } from "../../core/file-read-plan.js";
import { assertSourceFileReadCurrent } from "../../core/file-read-plan.js";
import { streamBoundedJsonlLines, SESSION_METADATA_MAX_LINE_BYTES } from "../../core/session-grouping.js";
import { coerceIso } from "../../core/type-guards.js";

/** Native facts only. The runtime/canonical layer decides whether these permit a query plan. */
export interface CodexActivityEvidence {
  file: string;
  supported: boolean;
  reason?: "shape" | "timestamp" | "identity" | "related_metadata" | "unreadable" | "oversized_line";
  sessionId?: string;
  upperBound?: string;
  toolNames: string[];
  bytesRead: number;
  recordsDecoded: number;
}
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const responses = new Set(["message", "reasoning", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);
const events = new Set(["token_count", "user_message", "agent_message", "agent_reasoning", "task_started", "task_complete"]);

export async function inspectCodexActivityEvidence(plan: SourceFileReadPlan, file: string): Promise<CodexActivityEvidence> {
  await assertSourceFileReadCurrent(plan, file);
  const result: CodexActivityEvidence = { file, supported: true, toolNames: [], bytesRead: 0, recordsDecoded: 0 };
  const reject = (reason: CodexActivityEvidence["reason"]) => { result.supported = false; result.reason = reason; };
  if (/\/subagents\//u.test(file.replace(/\\/gu, "/"))) {
    reject("related_metadata");
    return result;
  }
  const toolNames = new Set<string>();
  const input = createReadStream(file);
  async function* chunks() { for await (const chunk of input) { result.bytesRead += (chunk as Buffer).length; yield chunk as Buffer; } }
  try {
    for await (const line of streamBoundedJsonlLines(chunks(), SESSION_METADATA_MAX_LINE_BYTES)) {
      if (line.oversized) { reject("oversized_line"); break; }
      const text = line.buffer.toString("utf8").trim(); if (!text) continue;
      let record: unknown;
      try { record = JSON.parse(text); result.recordsDecoded++; } catch { reject("shape"); break; }
      if (!object(record) || !object(record.payload)) { reject("shape"); break; }
      const payload = record.payload;
      const timestamp = coerceIso(record.timestamp);
      // The bound follows the adapter's timeKey rule. Reject scan-time fallback and extended years.
      if (!timestamp || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(timestamp)) { reject("timestamp"); break; }
      if (!result.upperBound || timestamp > result.upperBound) result.upperBound = timestamp;
      if (result.recordsDecoded === 1 && (record.type !== "session_meta" || typeof payload.id !== "string" || !payload.id)) { reject("identity"); break; }
      if (record.type === "session_meta") {
        if (typeof payload.id !== "string" || result.sessionId && payload.id !== result.sessionId) { reject("identity"); break; }
        result.sessionId = payload.id;
        if (object(payload.source) || payload.thread_source === "subagent" || payload.parent_thread_id !== undefined || payload.subagent_history_start_ordinal !== undefined) { reject("related_metadata"); break; }
      } else if (record.type === "turn_context") {
        // This registered shape emits workspace/model signals using the top-level timestamp.
      } else if (record.type === "response_item" && responses.has(String(payload.type))) {
        if (payload.type === "function_call" || payload.type === "custom_tool_call") {
          if (typeof payload.name !== "string" || !payload.name || payload.name.length > 256) { reject("shape"); break; }
          toolNames.add(payload.name);
          if (toolNames.size > 256) { reject("shape"); break; }
        }
      } else if (record.type !== "event_msg" || !events.has(String(payload.type))) { reject("shape"); break; }
    }
  } catch { reject("unreadable"); }
  finally { input.destroy(); }
  // A changed read is an invalid attempt, never downgraded to an uncertain-but-usable bound.
  await assertSourceFileReadCurrent(plan, file);
  if (!result.sessionId || !result.upperBound) reject(result.reason ?? "identity");
  result.toolNames = [...toolNames];
  return result;
}
