import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeLocalPathIdentity, type TokenUsageMetrics } from "@cchistory/domain";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";
import { readBudgetedSqliteRows, type SourceReadBudget } from "../../core/read-budget.js";
import { indices, message, protobuf, scalar, string, timestamp, type ProtoField } from "./protobuf.js";
import { decodeAntigravityUsage } from "./usage.js";

type SeedRecord = ExtractedSessionSeed["records"][number];
interface Step {
  index: number;
  type: number;
  metadata: ProtoField[];
  executionId?: string;
  observedAt?: string;
  durationMs?: number;
  record: Record<string, unknown>;
}

/** The schema/field numbers are from Antigravity 2.32.1's installed protobuf
 * descriptors. Generation rows carry explicit step indices, independent of idx;
 * one generation may cover several steps, including a planner and its tools. */
export function extractAntigravitySqliteSeeds(filePath: string, budget?: SourceReadBudget): ExtractedSessionSeed[] {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    db.exec("BEGIN");
    const headers = readBudgetedSqliteRows(db, "SELECT cascade_id, trajectory_id FROM trajectory_meta", ["cascade_id", "trajectory_id"], [], budget);
    const cascadeId = text(headers[0]?.cascade_id) ?? path.basename(filePath, ".db");
    const stepRows = readBudgetedSqliteRows(db, "SELECT idx, step_type, step_format, metadata, step_payload FROM steps ORDER BY idx",
      ["idx", "step_type", "step_format", "metadata", "step_payload"], [], budget, "Antigravity steps");
    const generations = hasTable(db, "gen_metadata")
      ? readBudgetedSqliteRows(db, "SELECT idx, data FROM gen_metadata ORDER BY idx", ["idx", "data"], [], budget, "Antigravity generations") : [];
    if (stepRows.length === 0 && generations.length === 0) return [];
    const diagnostics: NonNullable<ExtractedSessionSeed["diagnostics"]> = [];
    const records: SeedRecord[] = [];
    const steps: Step[] = [];
    const loss = (code: string, detail: string) => diagnostics.push({ code: `antigravity_${code}`, detail });
    for (const row of stepRows) {
      const index = Number(row.idx);
      try {
        if (Number(row.step_format) !== 0) throw new Error(`Unsupported step format ${row.step_format}`);
        const metadata = protobuf(bytes(row.metadata));
        const payload = protobuf(bytes(row.step_payload));
        const type = Number(row.step_type);
        const startedAt = timestamp(metadata, 1);
        const completedAt = timestamp(metadata, 8);
        const observedAt = startedAt ?? completedAt;
        const durationMs =
          startedAt && completedAt
            ? (() => {
                const diff = Date.parse(completedAt) - Date.parse(startedAt);
                return Number.isFinite(diff) && diff >= 0 ? diff : undefined;
              })()
            : undefined;
        const executionId = string(metadata, 12);
        const record = decodeStep(type, payload, metadata, index, durationMs);
        steps.push({ index, type, metadata, observedAt, durationMs, executionId, record });
      } catch (error) {
        loss("invalid_step", `Step ${index}: ${error instanceof Error ? error.message : String(error)}`);
        records.push({ pointer: `sqlite:steps[${index}]:opaque`, rawJson: JSON.stringify({ antigravitySqlite: {
          index, type: row.step_type, format: row.step_format,
          metadata: base64(row.metadata), payload: base64(row.step_payload),
        } }) });
      }
    }

    const byIndex = new Map(steps.map(step => [step.index, step]));
    const covered = new Set<number>();
    const executions = new Set<string>();
    const usageAtStep = new Map<number, Array<{ usage: TokenUsageMetrics; pointer: string; coveredStepIndices?: number[] }>>();
    for (const row of generations) {
      try {
        const fields = protobuf(bytes(row.data));
        const chat = message(fields, 1);
        const usage = decodeAntigravityUsage(message(chat, 4), string(chat, 19) ?? string(chat, 22) ?? string(chat, 21));
        if (!usage) continue;
        const executionId = string(fields, 4);
        const stepIndices = indices(fields, 2);
        const candidates = stepIndices.map(index => byIndex.get(index)).filter((step): step is Step => !!step);
        const target = candidates[0] ?? steps.find(step => executionId && step.executionId === executionId);
        if (executionId) executions.add(executionId);
        for (const index of stepIndices) covered.add(index);
        if (!target) {
          loss("unanchored_generation", `Generation ${row.idx} has usage with no resolving step indices or execution ID`);
          records.push({ pointer: `sqlite:gen_metadata[${row.idx}]`, rawJson: JSON.stringify({
            antigravitySqlite: { generationIndex: row.idx, data: base64(row.data) },
          }) });
          continue;
        }
        const usages = usageAtStep.get(target.index) ?? [];
        usages.push({
          usage,
          pointer: `sqlite:gen_metadata[${row.idx}]`,
          coveredStepIndices: stepIndices.length > 0 ? stepIndices : undefined,
        });
        usageAtStep.set(target.index, usages);
      } catch (error) {
        loss("invalid_generation", `Generation ${row.idx}: ${error instanceof Error ? error.message : String(error)}`);
        records.push({ pointer: `sqlite:gen_metadata[${row.idx}]:opaque`, rawJson: JSON.stringify({
          antigravitySqlite: { generationIndex: row.idx, data: base64(row.data) },
        }) });
      }
    }

    const trajectory = hasTable(db, "trajectory_metadata_blob")
      ? readBudgetedSqliteRows(db, "SELECT data FROM trajectory_metadata_blob WHERE id = 'main'", ["data"], [], budget)[0]?.data : undefined;
    let cwd: string | undefined;
    let parent: string | undefined;
    let createdAt: string | undefined;
    try {
      const meta = trajectory ? protobuf(bytes(trajectory)) : [];
      cwd = normalizeLocalPathIdentity(string(message(meta, 1), 1) ?? string(meta, 7));
      parent = string(meta, 5);
      createdAt = timestamp(meta, 2);
    } catch {
      loss("invalid_trajectory_metadata", "Malformed trajectory metadata");
      records.push({ pointer: "sqlite:trajectory_metadata_blob:opaque", rawJson: JSON.stringify({
        antigravitySqlite: { trajectoryMetadata: base64(trajectory) },
      }) });
    }
    createdAt ??= steps.find(step => step.observedAt)?.observedAt;
    const updatedAt = [...steps].reverse().find(step => step.observedAt)?.observedAt ?? createdAt;
    const title = steps.map(step => step.record.message).filter(isRecord)
      .find(msg => msg.role === "user")?.content as string | undefined;
    const sessionId = `sess:antigravity:${cascadeId}`;
    records.unshift({ pointer: "sqlite:trajectory_meta", observedAt: createdAt, rawJson: JSON.stringify({
      id: sessionId, title, cwd, createdAt, updatedAt,
      parentId: parent, isSidechain: parent ? true : undefined,
    }) });
    for (const step of steps) {
      if (!step.observedAt) loss("missing_step_timestamp", `Step ${step.index} has no recorded timestamp`);
      // The generic parser keeps tool/system context separate from authored text.
      records.push({ pointer: `sqlite:steps[${step.index}]`, observedAt: step.observedAt ?? createdAt,
        rawJson: JSON.stringify({ timestamp: step.observedAt, cwd, ...step.record }) });
      const usages = usageAtStep.get(step.index) ?? [];
      if (!covered.has(step.index) && (!step.executionId || !executions.has(step.executionId))) {
        try {
          const usage = decodeAntigravityUsage(message(step.metadata, 9));
          if (usage) {
            usages.push({ usage, pointer: `sqlite:steps[${step.index}]:usage`, coveredStepIndices: [step.index] });
            if (step.executionId) executions.add(step.executionId);
          }
        } catch { loss("invalid_step_usage", `Step ${step.index} has malformed model usage`); }
      }
      for (const entry of usages) records.push({ pointer: entry.pointer, observedAt: step.observedAt ?? createdAt,
        rawJson: JSON.stringify({ timestamp: step.observedAt, model: entry.usage.model,
          ...(entry.coveredStepIndices ? { covered_step_indices: entry.coveredStepIndices } : {}),
          message: { role: "assistant", content: [], usage: entry.usage } }) });
    }
    return [{ sessionId, title, createdAt, updatedAt, workingDirectory: cwd, records, diagnostics }];
  } finally { db.close(); }
}

function decodeStep(
  type: number,
  payload: ProtoField[],
  metadata: ProtoField[],
  stepIndex: number,
  durationMs?: number,
): Record<string, unknown> {
  if (type === 14) {
    const input = message(payload, 19);
    // user_response is the literal request; items/query can be rewritten context.
    const content = string(input, 2);
    return { message: { role: content ? "user" : "system", content: content ?? "" } };
  }
  if (type === 15) {
    const planner = message(payload, 20);
    const content = string(planner, 8) ?? string(planner, 1) ?? "";
    return { message: { role: "assistant", content } };
  }
  if (type === 82) return { message: { role: "assistant", content: string(message(payload, 94), 2) ?? "" } };
  const call = message(metadata, 4);
  const name = string(call, 2);
  if (name) return { message: { role: "assistant", content: [{ type: "tool_use", id: string(call, 1),
    name, input: parseArguments(string(call, 3)), step_index: stepIndex,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}) }] } };
  // Preserve opaque non-conversation steps for future format investigation.
  // Known lifecycle/context records stay system evidence; future types receive
  // the generic parser's unknown-record diagnostic with their payload retained.
  return { ...([0, 1, 2, 23, 98, 99, 101, 102, 116].includes(type) ? { message: { role: "system", content: "" } } : {}), antigravitySqlite: { stepType: type,
    payload: payload.map(field => ({ ...field, value: Buffer.isBuffer(field.value) ? field.value.toString("base64") : field.value })) } };
}

export function extractAntigravitySummarySeeds(filePath: string, budget?: SourceReadBudget): ExtractedSessionSeed[] {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    db.exec("BEGIN");
    const available = new Set(db.prepare("PRAGMA table_info(conversation_summaries)").all().map(row => row.name));
    const columns = ["conversation_id", "title", "workspace_uris", "last_modified_time", "parent_conversation_id"]
      .filter(column => available.has(column));
    if (!columns.includes("conversation_id") || !columns.includes("title")) throw new Error("Unsupported Antigravity summary schema");
    return readBudgetedSqliteRows(db, `SELECT ${columns.join(", ")} FROM conversation_summaries`, columns, [], budget)
      .flatMap(row => {
        const id = text(row.conversation_id);
        if (!id) throw new Error("Antigravity summary has no conversation identity");
        let cwd: string | undefined;
        const diagnostics: NonNullable<ExtractedSessionSeed["diagnostics"]> = [];
        if (text(row.workspace_uris)) {
          try {
            const uris: unknown = JSON.parse(row.workspace_uris as string);
            if (!Array.isArray(uris)) throw new Error("Expected workspace URI array");
            cwd = normalizeLocalPathIdentity(uris.find(uri => typeof uri === "string"));
          } catch { diagnostics.push({ code: "antigravity_invalid_summary_workspace", detail: `Conversation ${id} has malformed workspace URIs` }); }
        }
        const sessionId = `sess:antigravity:${id}`;
        const title = text(row.title);
        const updatedAt = text(row.last_modified_time);
        const parent = text(row.parent_conversation_id);
        return [{ sessionId, title, updatedAt, workingDirectory: cwd, diagnostics,
          records: [{ pointer: `sqlite:conversation_summaries[${id}]`, observedAt: updatedAt,
            rawJson: JSON.stringify({ id: sessionId, title, cwd, parentId: parent, isSidechain: parent ? true : undefined,
              antigravitySqlite: { workspaceUris: row.workspace_uris } }) }] }];
      });
  } finally { db.close(); }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value === null || value === undefined) return new Uint8Array();
  throw new Error("Expected protobuf BLOB");
}
function base64(value: unknown): string | undefined { return value instanceof Uint8Array ? Buffer.from(value).toString("base64") : text(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
function parseArguments(value: string | undefined): unknown {
  try { return value ? JSON.parse(value) : {}; } catch { return { raw: value }; }
}
