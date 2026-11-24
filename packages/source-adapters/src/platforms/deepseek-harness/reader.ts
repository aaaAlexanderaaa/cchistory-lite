import path from "node:path";
import * as zlib from "node:zlib";
import { isObject, asString, asNumber } from "../../core/type-guards.js";
import { SourceReadBudgetExceededError, type SourceReadBudget } from "../../core/read-budget.js";
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

const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const ZSTD_SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
/** Current logical session format this adapter interprets. */
export const SUPPORTED_SESSION_FORMAT_VERSION = 4;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

interface SeedDiagnostic {
  code: string;
  detail: string;
}

type ZstdDecompressSync = (buffer: Buffer, options?: { maxOutputLength?: number }) => Buffer;

// Resolved lazily so an older Node.js still loads this module and reports an
// actionable diagnostic instead of failing at import time.
function getZstdDecompressSync(): ZstdDecompressSync | undefined {
  const fn = (zlib as unknown as { zstdDecompressSync?: ZstdDecompressSync }).zstdDecompressSync;
  return typeof fn === "function" ? fn : undefined;
}

export interface DeepSeekHarnessLog {
  /** Decoded JSONL lines in file order; blank lines are dropped. */
  lines: string[];
  /** Number of bytes after decompression (or the plain file size). */
  decodedBytes: number;
  diagnostics: SeedDiagnostic[];
}

function isZstdMagic(fileBuffer: Buffer): boolean {
  if (fileBuffer.length < 4) {
    return false;
  }
  const magic = fileBuffer.readUInt32LE(0);
  return (
    magic === ZSTD_FRAME_MAGIC ||
    (magic >= ZSTD_SKIPPABLE_MAGIC_MIN && magic <= ZSTD_SKIPPABLE_MAGIC_MAX)
  );
}

type FrameScanResult =
  | { kind: "frame"; start: number; end: number }
  | { kind: "skippable"; start: number; end: number }
  | { kind: "truncated" | "invalid"; reason: string };

/**
 * Locate the exact RFC 8878 byte span of one Zstandard (or skippable) frame.
 * Node 22's `node:zlib` Zstd decoder stops after the first frame in a
 * concatenated stream, so slicing frames explicitly keeps multi-frame decoding
 * and torn-tail detection consistent across Node 22 and newer runtimes.
 */
function scanNextZstdFrame(buffer: Buffer, offset: number): FrameScanResult {
  if (offset + 4 > buffer.length) {
    return { kind: "truncated", reason: "incomplete Zstandard frame magic" };
  }
  const magic = buffer.readUInt32LE(offset);
  if (magic >= ZSTD_SKIPPABLE_MAGIC_MIN && magic <= ZSTD_SKIPPABLE_MAGIC_MAX) {
    if (offset + 8 > buffer.length) {
      return { kind: "truncated", reason: "incomplete skippable frame header" };
    }
    const frameSize = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + frameSize;
    if (end > buffer.length) {
      return { kind: "truncated", reason: "incomplete skippable frame body" };
    }
    return { kind: "skippable", start: offset, end };
  }
  if (magic !== ZSTD_FRAME_MAGIC) {
    return { kind: "invalid", reason: `unexpected Zstandard frame magic 0x${magic.toString(16)}` };
  }
  if (offset + 5 > buffer.length) {
    return { kind: "truncated", reason: "incomplete Zstandard frame header descriptor" };
  }
  let pos = offset + 4;
  const fhd = buffer[pos++]!;
  const fcsFlag = (fhd >>> 6) & 3;
  const singleSegment = (fhd & 0x20) !== 0;
  if ((fhd & 0x08) !== 0) {
    return { kind: "invalid", reason: "reserved bit set in Zstandard frame header" };
  }
  const hasChecksum = (fhd & 0x04) !== 0;
  const dictFlag = fhd & 3;
  if (!singleSegment) {
    pos += 1;
  }
  pos += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4;
  pos += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  if (pos > buffer.length) {
    return { kind: "truncated", reason: "incomplete Zstandard frame header" };
  }
  while (true) {
    if (pos + 3 > buffer.length) {
      return { kind: "truncated", reason: "incomplete Zstandard block header" };
    }
    const blockHeader = buffer[pos]! | (buffer[pos + 1]! << 8) | (buffer[pos + 2]! << 16);
    pos += 3;
    const lastBlock = (blockHeader & 1) === 1;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) {
      return { kind: "invalid", reason: "reserved Zstandard block type" };
    }
    pos += blockType === 1 ? 1 : blockSize;
    if (pos > buffer.length) {
      return { kind: "truncated", reason: "incomplete Zstandard block payload" };
    }
    if (lastBlock) {
      break;
    }
  }
  if (hasChecksum) {
    pos += 4;
    if (pos > buffer.length) {
      return { kind: "truncated", reason: "incomplete Zstandard content checksum" };
    }
  }
  return { kind: "frame", start: offset, end: pos };
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
function decodeZstdFrames(
  fileBuffer: Buffer,
  maxDecodedBytes: number,
  budget?: SourceReadBudget,
  unitLabel = "deepseek_harness zstd log",
): DeepSeekHarnessLog {
  const decompress = getZstdDecompressSync();
  if (!decompress) {
    return {
      lines: [],
      decodedBytes: 0,
      diagnostics: [{
        code: "dsh_zstd_unsupported_runtime",
        detail: "This Node.js runtime has no Zstandard support; install Node 22.15+ or point the adapter at an uncompressed session log.",
      }],
    };
  }
  const chunks: Buffer[] = [];
  const diagnostics: SeedDiagnostic[] = [];
  let decodedBytes = 0;
  let admittedExtraBytes = 0;
  let offset = 0;

  while (offset < fileBuffer.length) {
    const scan = scanNextZstdFrame(fileBuffer, offset);
    if (scan.kind === "skippable") {
      offset = scan.end;
      continue;
    }
    if (scan.kind !== "frame") {
      if (decodedBytes > 0) {
        diagnostics.push({
          code: "dsh_zstd_partial_frame",
          detail: `Zstandard stream ended after ${decodedBytes} decoded bytes (${scan.reason}). Complete predecessor frames were retained.`,
        });
      } else {
        diagnostics.push({
          code: "dsh_zstd_decode_failed",
          detail: `Zstandard decompression failed before any readable record (${scan.reason}).`,
        });
      }
      break;
    }

    const remainingBytes = maxDecodedBytes - decodedBytes;
    if (remainingBytes <= 0) {
      diagnostics.push({
        code: "dsh_decoded_size_exceeded",
        detail: `Decoded session log exceeds the ${maxDecodedBytes}-byte read budget; readable prefix discarded.`,
      });
      return { lines: [], decodedBytes: 0, diagnostics };
    }

    let frameDecoded: Buffer;
    try {
      frameDecoded = decompress(fileBuffer.subarray(scan.start, scan.end), {
        maxOutputLength: remainingBytes,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ERR_BUFFER_TOO_LARGE") {
        diagnostics.push({
          code: "dsh_decoded_size_exceeded",
          detail: `Decoded session log exceeds the ${maxDecodedBytes}-byte read budget; readable prefix discarded.`,
        });
        return { lines: [], decodedBytes: 0, diagnostics };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (decodedBytes > 0) {
        diagnostics.push({
          code: "dsh_zstd_partial_frame",
          detail: `Zstandard frame at byte ${scan.start} failed after ${decodedBytes} decoded bytes: ${message}. Complete predecessor frames were retained.`,
        });
      } else {
        diagnostics.push({
          code: "dsh_zstd_decode_failed",
          detail: `Zstandard decompression failed before any readable record: ${message}.`,
        });
      }
      break;
    }

    decodedBytes += frameDecoded.length;
    if (decodedBytes > maxDecodedBytes) {
      diagnostics.push({
        code: "dsh_decoded_size_exceeded",
        detail: `Decoded session log exceeds the ${maxDecodedBytes}-byte read budget; readable prefix discarded.`,
      });
      return { lines: [], decodedBytes: 0, diagnostics };
    }
    // Charge incremental expansion beyond the compressed bytes already admitted
    // when the file was captured so many compressed logs cannot bypass the scan budget.
    const totalExtraBytes = Math.max(0, decodedBytes - fileBuffer.length);
    const deltaExtraBytes = totalExtraBytes - admittedExtraBytes;
    if (deltaExtraBytes > 0 && budget) {
      try {
        budget.admit(deltaExtraBytes, `${unitLabel}:zstd decoded`);
        admittedExtraBytes = totalExtraBytes;
      } catch (error) {
        if (error instanceof SourceReadBudgetExceededError) {
          throw error;
        }
        throw error;
      }
    }
    chunks.push(frameDecoded);
    offset = scan.end;
  }

  return {
    lines: chunks.length > 0 ? splitLines(Buffer.concat(chunks)) : [],
    decodedBytes,
    diagnostics,
  };
}

export async function readDeepSeekHarnessLog(
  fileBuffer: Buffer,
  budget?: SourceReadBudget,
  options?: { compressedHint?: boolean; unitLabel?: string },
): Promise<DeepSeekHarnessLog> {
  if (!isZstdMagic(fileBuffer) && !options?.compressedHint) {
    const maxBytes = readMaxDecodedBytes(budget);
    if (fileBuffer.length > maxBytes) {
      return {
        lines: [],
        decodedBytes: 0,
        diagnostics: [{
          code: "dsh_decoded_size_exceeded",
          detail: `Session log exceeds the ${maxBytes}-byte read budget; readable prefix discarded.`,
        }],
      };
    }
    return { lines: splitLines(fileBuffer), decodedBytes: fileBuffer.length, diagnostics: [] };
  }
  return decodeZstdFrames(fileBuffer, readMaxDecodedBytes(budget), budget, options?.unitLabel);
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
  const { lines, diagnostics } = await readDeepSeekHarnessLog(fileBuffer, budget, {
    compressedHint: filePath.endsWith(".zstd"),
    unitLabel: filePath,
  });
  const seedDiagnostics: SeedDiagnostic[] = [...diagnostics];
  const rows: ParsedRow[] = [];
  const maxRecordBytes = Math.min(MAX_RECORD_BYTES, readMaxDecodedBytes(budget));
  for (const [index, rawLine] of lines.entries()) {
    const lineBytes = Buffer.byteLength(rawLine, "utf8");
    if (lineBytes > maxRecordBytes) {
      seedDiagnostics.push({
        code: "dsh_record_too_large",
        detail: `Line ${index + 1} is ${lineBytes} bytes, exceeding the ${maxRecordBytes}-byte record cap; skipped.`,
      });
      continue;
    }
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
