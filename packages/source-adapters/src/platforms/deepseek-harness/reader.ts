import path from "node:path";
import * as zlib from "node:zlib";
import { isObject, asString, asNumber } from "../../core/type-guards.js";
import type { SourceReadBudget } from "../../core/read-budget.js";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";

/**
 * DeepSeek Harness persistence reader.
 *
 * The current physical format (`session.v4.jsonl[.zstd]`) stores one JSONL
 * record per durable session event behind a header record, framed as
 * independent Zstandard frames when compression is enabled. The bundled
 * reader reconstructs the logical rows without depending on the harness, so
 * Lite keeps its zero-store, read-only contract.
 */

const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Current logical session format this adapter interprets. */
export const SUPPORTED_SESSION_FORMAT_VERSION = 4;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;

interface SeedDiagnostic {
  code: string;
  detail: string;
}

interface ZstdDecoder {
  on(event: "data", listener: (chunk: Buffer) => void): ZstdDecoder;
  on(event: "error", listener: (error: Error) => void): ZstdDecoder;
  on(event: "end", listener: () => void): ZstdDecoder;
  end(chunk: Buffer): void;
  destroy(): void;
}

// Resolved lazily so an older Node.js still loads this module and reports an
// actionable diagnostic instead of failing at import time.
function createZstdDecoder(): ZstdDecoder | undefined {
  const factory = (zlib as unknown as { createZstdDecompress?: () => ZstdDecoder }).createZstdDecompress;
  return typeof factory === "function" ? factory() : undefined;
}

export interface DeepSeekHarnessLog {
  /** Decoded JSONL lines in file order; blank lines are dropped. */
  lines: string[];
  /** Number of bytes after decompression (or the plain file size). */
  decodedBytes: number;
  diagnostics: SeedDiagnostic[];
}

function isZstdFrame(fileBuffer: Buffer): boolean {
  return fileBuffer.length >= 4 && fileBuffer.subarray(0, 4).equals(ZSTD_FRAME_MAGIC);
}

function readMaxDecodedBytes(budget: SourceReadBudget | undefined): number {
  const budgeted = budget?.maximumUnitBytes?.();
  if (typeof budgeted === "number" && Number.isFinite(budgeted) && budgeted > 0) {
    return Math.min(budgeted, MAX_DECODED_BYTES);
  }
  return MAX_DECODED_BYTES;
}

function splitLines(decoded: Buffer): string[] {
  return decoded
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/**
 * Decode every concatenated Zstandard frame. A truncated trailing frame from a
 * crashed writer still yields its complete predecessor frames; the partial
 * suffix is reported instead of dropping the whole readable prefix.
 */
async function decodeZstdFrames(
  fileBuffer: Buffer,
  maxDecodedBytes: number,
): Promise<DeepSeekHarnessLog> {
  const decoder = createZstdDecoder();
  if (!decoder) {
    return {
      lines: [],
      decodedBytes: 0,
      diagnostics: [{
        code: "dsh_zstd_unsupported_runtime",
        detail: "This Node.js runtime has no Zstandard support; install Node 22.15+ or point the adapter at an uncompressed session log.",
      }],
    };
  }
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const diagnostics: SeedDiagnostic[] = [];
    let decodedBytes = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ lines: splitLines(Buffer.concat(chunks)), decodedBytes, diagnostics });
    };

    decoder.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      decodedBytes += chunk.length;
      if (decodedBytes > maxDecodedBytes) {
        diagnostics.push({
          code: "dsh_decoded_size_exceeded",
          detail: `Decoded session log exceeds the ${maxDecodedBytes}-byte read budget; readable prefix discarded.`,
        });
        chunks.length = 0;
        decodedBytes = 0;
        decoder.destroy();
        finish();
        return;
      }
      chunks.push(chunk);
    });
    decoder.on("error", (error: Error) => {
      if (decodedBytes > 0) {
        diagnostics.push({
          code: "dsh_zstd_partial_frame",
          detail: `Zstandard stream ended after ${decodedBytes} decoded bytes: ${error.message}. Complete predecessor frames were retained.`,
        });
      } else {
        diagnostics.push({
          code: "dsh_zstd_decode_failed",
          detail: `Zstandard decompression failed before any readable record: ${error.message}.`,
        });
      }
      finish();
    });
    decoder.on("end", finish);
    decoder.end(fileBuffer);
  });
}

export async function readDeepSeekHarnessLog(
  fileBuffer: Buffer,
  budget?: SourceReadBudget,
): Promise<DeepSeekHarnessLog> {
  if (!isZstdFrame(fileBuffer)) {
    return { lines: splitLines(fileBuffer), decodedBytes: fileBuffer.length, diagnostics: [] };
  }
  return await decodeZstdFrames(fileBuffer, readMaxDecodedBytes(budget));
}

interface ParsedRow {
  lineNumber: number;
  rawLine: string;
  value: Record<string, unknown>;
}

function epochMillisIso(value: unknown): string | undefined {
  const millis = asNumber(value);
  if (millis === undefined || !Number.isFinite(millis)) {
    return undefined;
  }
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

/**
 * Project one DeepSeek Harness session log into the adapter seed shape.
 * One log file is one session; its header supplies identity and working
 * directory, and each durable event becomes one parseable record so the
 * runtime can interpret it in file order.
 */
export async function extractDeepSeekHarnessSeeds(
  filePath: string,
  fileBuffer: Buffer,
  budget?: SourceReadBudget,
): Promise<ExtractedSessionSeed[]> {
  const { lines, diagnostics } = await readDeepSeekHarnessLog(fileBuffer, budget);
  const seedDiagnostics: SeedDiagnostic[] = [...diagnostics];
  const rows: ParsedRow[] = [];
  for (const [index, rawLine] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(rawLine);
    } catch {
      seedDiagnostics.push({
        code: "dsh_malformed_jsonl_record",
        detail: `Line ${index + 1} is not valid JSON and was kept only as a diagnostic.`,
      });
      continue;
    }
    if (!isObject(value)) {
      seedDiagnostics.push({
        code: "dsh_record_not_object",
        detail: `Line ${index + 1} is not a JSON object and was kept only as a diagnostic.`,
      });
      continue;
    }
    rows.push({ lineNumber: index + 1, rawLine, value });
  }

  const headerRow = rows.find((row) => row.value.type === "session");
  const header = headerRow?.value;
  const version = asNumber(header?.version);
  if (!header) {
    seedDiagnostics.push({
      code: "dsh_session_header_missing",
      detail: "The log has no session header record; session identity falls back to the directory name.",
    });
  } else if (version !== SUPPORTED_SESSION_FORMAT_VERSION) {
    seedDiagnostics.push({
      code: "dsh_unsupported_session_format",
      detail: `Physical session format version ${String(header.version)} is not the supported v${SUPPORTED_SESSION_FORMAT_VERSION}; event bodies were not interpreted.`,
    });
    return [{
      sessionId: canonicalSessionId(filePath, header),
      diagnostics: seedDiagnostics,
      records: [],
    }];
  }

  const events = headerRow ? rows.filter((row) => row !== headerRow) : rows;
  const inheritedCut = findInheritedSeedCut(events);
  if (header && header.isSeeded === true && inheritedCut === undefined) {
    seedDiagnostics.push({
      code: "dsh_fork_seed_boundary_missing",
      detail: "The session header marks a fork seed but no tagged session/end-seed marker was found; inherited history cannot be separated.",
    });
  }
  const ownEvents = inheritedCut === undefined ? events : events.slice(inheritedCut);
  if (inheritedCut !== undefined && inheritedCut > 0) {
    seedDiagnostics.push({
      code: "dsh_fork_seed_prefix_omitted",
      detail: `${inheritedCut} inherited fork-seed event(s) belong to the parent history and were not projected as this session's conversation.`,
    });
  }

  const createdAt = epochMillisIso(header?.createdAt);
  const updatedAt = lastEventIso(ownEvents) ?? createdAt;
  const sessionId = canonicalSessionId(filePath, header);
  const model = resolveSessionModel(ownEvents) ?? resolveSessionModel(events);
  const title = resolveSessionTitle(events);

  const records: ExtractedSessionSeed["records"] = [];
  if (headerRow) {
    records.push({
      pointer: `line:${headerRow.lineNumber}`,
      observedAt: createdAt,
      rawJson: headerRow.rawLine,
      parsedValue: headerRow.value,
    });
  }
  for (const row of ownEvents) {
    records.push({
      pointer: `line:${row.lineNumber}`,
      observedAt: epochMillisIso(row.value.time) ?? updatedAt,
      rawJson: row.rawLine,
      parsedValue: row.value,
    });
  }

  const workingDirectory = asString(header?.cwd);
  return [{
    sessionId,
    ...(title ? { title } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(model ? { model } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(seedDiagnostics.length > 0 ? { diagnostics: seedDiagnostics } : {}),
    records,
  }];
}

function canonicalSessionId(filePath: string, header: Record<string, unknown> | undefined): string {
  const headerId = asString(header?.id);
  const nativeId = headerId ?? fallbackNativeId(filePath);
  return `sess:deepseek_harness:${nativeId}`;
}

function fallbackNativeId(filePath: string): string {
  const directory = path.basename(path.dirname(filePath));
  if (directory && directory !== "." && directory !== path.sep) {
    return directory;
  }
  return path.basename(filePath).replace(/\.jsonl(?:\.zstd)?$/u, "");
}

function findInheritedSeedCut(events: readonly ParsedRow[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const row = events[index];
    if (row?.value.type !== "session/end-seed") {
      continue;
    }
    const data = row.value.data;
    if (isObject(data) && data.inherited === true) {
      return index + 1;
    }
  }
  return undefined;
}

function lastEventIso(events: readonly ParsedRow[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const iso = epochMillisIso(events[index]?.value.time);
    if (iso) {
      return iso;
    }
  }
  return undefined;
}

function resolveSessionModel(events: readonly ParsedRow[]): string | undefined {
  let model: string | undefined;
  for (const row of events) {
    const data = row.value.data;
    if (!isObject(data)) {
      continue;
    }
    if (row.value.type === "request/context") {
      model = asString(data.model) ?? model;
      continue;
    }
    if (row.value.type === "request/header" && isObject(data.header) && isObject(data.header.config)) {
      model = asString(data.header.config.model) ?? model;
      continue;
    }
    if (row.value.type === "assistant/message" && isObject(data.message) && isObject(data.message.source)) {
      model = asString(data.message.source.model) ?? model;
    }
  }
  return model;
}

function resolveSessionTitle(events: readonly ParsedRow[]): string | undefined {
  let title: string | undefined;
  for (const row of events) {
    if (row.value.type !== "session/title" || !isObject(row.value.data)) {
      continue;
    }
    const candidate = asString(row.value.data.title);
    if (candidate) {
      title = candidate;
    }
  }
  return title;
}
