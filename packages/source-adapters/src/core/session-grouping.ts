import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { SourcePlatform } from "@cchistory/domain";
import { deriveSessionId } from "./source-identity.js";
import { coerceIso } from "./type-guards.js";

export interface SourceFileLogicalSessionMetadata {
  sessionKey: string;
  workingDirectoryState: "known" | "absent" | "uncertain";
  workingDirectory?: string;
}

interface SessionMetadataWorkerResponse {
  index: number;
  metadata: SourceFileLogicalSessionMetadata;
}

type LogicalSessionWorkspaceMetadata =
  | { state: "known"; workingDirectory: string }
  | { state: "absent" | "uncertain" };

const CWD_FIELD = Buffer.from('"cwd"');
const TIMESTAMP_FIELD = Buffer.from('"timestamp"');
const TYPE_FIELD = Buffer.from('"type"');
const SESSION_METADATA_PREFIX_BYTES = 64 * 1024;

/**
 * Resolve the same logical session identity used by the canonical parser while
 * reading only the first non-empty JSONL record. This lets ephemeral consumers
 * assemble all files for one session before projection without retaining an
 * entire source payload in memory.
 */
export async function deriveSourceFileLogicalSessionKey(
  platform: SourcePlatform,
  filePath: string,
): Promise<string> {
  if (platform === "antigravity") {
    const basename = path.basename(filePath);
    if (basename === "task.md" || /^Conversation_.*_History\.md$/u.test(basename)) {
      return `sess:${platform}:${path.basename(path.dirname(filePath))}`;
    }
  }
  if (platform === "amp" || platform === "gemini" || platform === "opencode") {
    try {
      const fileBuffer = await readFile(filePath);
      if (platform === "opencode") {
        const parsed = JSON.parse(fileBuffer.toString("utf8")) as Record<string, unknown>;
        const sourceSessionId = [parsed.id, parsed.sessionId, parsed.session_id]
          .find((value): value is string => typeof value === "string" && value.length > 0);
        if (sourceSessionId) return `sess:${platform}:${sourceSessionId}`;
      }
      return deriveSessionId(platform, filePath, fileBuffer);
    } catch {
      return deriveSessionId(platform, filePath, Buffer.alloc(0));
    }
  }
  const input = createReadStream(filePath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      return deriveSessionId(platform, filePath, Buffer.from(line, "utf8"));
    }
    return deriveSessionId(platform, filePath, Buffer.alloc(0));
  } catch {
    // A file that cannot be read (deleted or rotated mid-scan, EACCES, EIO)
    // degrades to the same path-based key an empty file gets, so the scan
    // continues; the per-group probe re-reads the file and records its own
    // file_error event instead of aborting the whole source.
    return deriveSessionId(platform, filePath, Buffer.alloc(0));
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Read only the JSONL fields needed to decide whether a logical session can
 * match a canonical directory scope. An uncertain cwd is omitted so callers
 * conservatively retain the file for the full probe.
 */
export async function inspectSourceFileLogicalSessionMetadata(
  platform: SourcePlatform,
  filePath: string,
): Promise<SourceFileLogicalSessionMetadata> {
  if (platform !== "codex" && platform !== "claude_code") {
    return {
      sessionKey: await deriveSourceFileLogicalSessionKey(platform, filePath),
      workingDirectoryState: "absent",
    };
  }

  try {
    const { buffer: fileBuffer, truncated } = await readFilePrefix(filePath);
    const firstLine = firstNonemptyLineFromBuffer(fileBuffer);
    const sessionKey = deriveSessionId(
      platform,
      filePath,
      firstLine,
    );
    const workspace = truncated
      ? { state: "uncertain" as const }
      : scanLogicalSessionWorkspaceMetadata(platform, fileBuffer);
    return workspace.state === "known"
      ? {
          sessionKey,
          workingDirectoryState: "known",
          workingDirectory: workspace.workingDirectory,
        }
      : { sessionKey, workingDirectoryState: workspace.state };
  } catch {
    return {
      sessionKey: deriveSessionId(platform, filePath, Buffer.alloc(0)),
      workingDirectoryState: "uncertain",
    };
  }
}

export async function inspectSourceFilesLogicalSessionMetadata(
  platform: SourcePlatform,
  filePaths: readonly string[],
): Promise<SourceFileLogicalSessionMetadata[]> {
  if (filePaths.length < 16) {
    const results: SourceFileLogicalSessionMetadata[] = [];
    for (const filePath of filePaths) {
      results.push(await inspectSourceFileLogicalSessionMetadata(platform, filePath));
    }
    return results;
  }

  const workerCount = Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)), filePaths.length);
  const results = new Array<SourceFileLogicalSessionMetadata>(filePaths.length);
  const workers: Worker[] = [];
  let nextIndex = 0;
  let completed = 0;
  let settled = false;

  return new Promise<SourceFileLogicalSessionMetadata[]>((resolve, reject) => {
    const stopWorkers = (): void => {
      for (const worker of workers) void worker.terminate();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      stopWorkers();
      reject(error);
    };
    const dispatch = (worker: Worker): void => {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= filePaths.length) return;
      worker.postMessage({ index, platform, filePath: filePaths[index] });
    };

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(new URL("./session-grouping-worker.js", import.meta.url), {
        execArgv: [],
      });
      workers.push(worker);
      worker.on("message", (response: SessionMetadataWorkerResponse) => {
        if (settled) return;
        results[response.index] = response.metadata;
        completed += 1;
        if (completed === filePaths.length) {
          settled = true;
          stopWorkers();
          resolve(results);
          return;
        }
        dispatch(worker);
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (!settled && code !== 0) fail(new Error(`Logical-session metadata worker exited with code ${code}.`));
      });
      dispatch(worker);
    }
  });
}

function firstNonemptyLineFromBuffer(buffer: Buffer): Buffer {
  let offset = 0;
  while (offset < buffer.length) {
    const newlineOffset = buffer.indexOf(0x0a, offset);
    const endOffset = newlineOffset < 0 ? buffer.length : newlineOffset;
    const line = buffer.subarray(offset, endOffset).toString("utf8").trim();
    if (line) return Buffer.from(line, "utf8");
    if (newlineOffset < 0) break;
    offset = newlineOffset + 1;
  }
  return Buffer.alloc(0);
}

async function readFilePrefix(filePath: string): Promise<{ buffer: Buffer; truncated: boolean }> {
  const input = createReadStream(filePath, {
    start: 0,
    end: SESSION_METADATA_PREFIX_BYTES,
  });
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      totalBytes += buffer.length;
    }
  } finally {
    input.destroy();
  }
  return {
    buffer: Buffer.concat(chunks, Math.min(totalBytes, SESSION_METADATA_PREFIX_BYTES)),
    truncated: totalBytes > SESSION_METADATA_PREFIX_BYTES,
  };
}

function scanLogicalSessionWorkspaceMetadata(
  platform: "codex" | "claude_code",
  buffer: Buffer,
): LogicalSessionWorkspaceMetadata {
  let workingDirectory: string | undefined;
  const expectedDepth = platform === "claude_code" ? 1 : 2;
  let searchOffset = 0;

  while (searchOffset < buffer.length) {
    const fieldOffset = buffer.indexOf(CWD_FIELD, searchOffset);
    if (fieldOffset < 0) break;
    const lineStart = fieldOffset === 0 ? 0 : buffer.lastIndexOf(0x0a, fieldOffset - 1) + 1;
    const depth = jsonNestingDepthAtOffset(buffer, lineStart, fieldOffset);
    if (depth === undefined) return { state: "uncertain" };
    if (depth !== expectedDepth) {
      searchOffset = fieldOffset + CWD_FIELD.length;
      continue;
    }

    const field = parseCwdField(buffer, fieldOffset);
    if (field.kind === "incomplete" || field.kind === "invalid") return { state: "uncertain" };
    if (field.kind === "not_field") {
      searchOffset = fieldOffset + CWD_FIELD.length;
      continue;
    }
    if (workingDirectory !== undefined && workingDirectory !== field.value) {
      return resolveChangedWorkspaceMetadata(platform, buffer);
    }
    workingDirectory = field.value;
    searchOffset = field.endOffset;
  }

  return workingDirectory === undefined
    ? { state: "absent" }
    : { state: "known", workingDirectory };
}

function resolveChangedWorkspaceMetadata(
  platform: "codex" | "claude_code",
  buffer: Buffer,
): LogicalSessionWorkspaceMetadata {
  let latest: { workingDirectory: string; timeKey: string; seqNo: number } | undefined;
  let offset = 0;
  while (offset < buffer.length) {
    const newlineOffset = buffer.indexOf(0x0a, offset);
    const endOffset = newlineOffset < 0 ? buffer.length : newlineOffset;
    const cwd = findJsonStringFieldsAtDepth(buffer, offset, endOffset, CWD_FIELD, platform === "claude_code" ? 1 : 2);
    if (cwd.state === "uncertain") return { state: "uncertain" };
    if (cwd.state === "known") {
      let seqNo = 0;
      if (platform === "codex") {
        const type = findJsonStringFieldsAtDepth(buffer, offset, endOffset, TYPE_FIELD, 1);
        if (type.state === "uncertain") return { state: "uncertain" };
        if (type.state !== "known" || (type.value !== "session_meta" && type.value !== "turn_context")) {
          if (newlineOffset < 0) break;
          offset = newlineOffset + 1;
          continue;
        }
        if (cwd.count !== 1) return { state: "uncertain" };
        seqNo = type.value === "session_meta" ? 1 : 0;
      }
      const timestamp = findJsonStringFieldsAtDepth(buffer, offset, endOffset, TIMESTAMP_FIELD, 1);
      const timeKey = timestamp.state === "known" ? coerceIso(timestamp.value) : undefined;
      if (!timeKey) return { state: "uncertain" };
      if (
        !latest ||
        timeKey > latest.timeKey ||
        (timeKey === latest.timeKey && seqNo >= latest.seqNo)
      ) {
        latest = { workingDirectory: cwd.value, timeKey, seqNo };
      }
    }
    if (newlineOffset < 0) break;
    offset = newlineOffset + 1;
  }
  return latest
    ? { state: "known", workingDirectory: latest.workingDirectory }
    : { state: "absent" };
}

function findJsonStringFieldsAtDepth(
  buffer: Buffer,
  lineStart: number,
  lineEnd: number,
  fieldName: Buffer,
  expectedDepth: number,
):
  | { state: "known"; value: string; count: number }
  | { state: "absent" | "uncertain" } {
  let count = 0;
  let value: string | undefined;
  let searchOffset = lineStart;
  while (searchOffset < lineEnd) {
    const fieldOffset = buffer.indexOf(fieldName, searchOffset);
    if (fieldOffset < 0 || fieldOffset >= lineEnd) break;
    const field = parseJsonStringField(buffer, fieldOffset, fieldName.length, lineEnd);
    if (field.kind === "incomplete" || field.kind === "invalid") return { state: "uncertain" };
    if (field.kind === "not_field") {
      searchOffset = fieldOffset + fieldName.length;
      continue;
    }
    const depth = jsonNestingDepthForField(
      buffer,
      lineStart,
      lineEnd,
      fieldOffset,
      field.endOffset,
    );
    if (depth === undefined) return { state: "uncertain" };
    if (depth === expectedDepth) {
      count += 1;
      value = field.value;
    }
    searchOffset = field.endOffset;
  }
  return value === undefined
    ? { state: "absent" }
    : { state: "known", value, count };
}

function jsonNestingDepthForField(
  buffer: Buffer,
  lineStart: number,
  lineEnd: number,
  fieldOffset: number,
  fieldEnd: number,
): number | undefined {
  return fieldOffset - lineStart <= lineEnd - fieldEnd
    ? jsonNestingDepthAtOffset(buffer, lineStart, fieldOffset)
    : jsonNestingDepthAfterOffset(buffer, fieldEnd, lineEnd);
}

function jsonNestingDepthAtOffset(
  buffer: Buffer,
  startOffset: number,
  endOffset: number,
): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let offset = startOffset; offset < endOffset; offset += 1) {
    const byte = buffer[offset]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) inString = true;
    else if (byte === 0x7b || byte === 0x5b) depth += 1;
    else if (byte === 0x7d || byte === 0x5d) {
      depth -= 1;
      if (depth < 0) return undefined;
    }
  }
  return inString ? undefined : depth;
}

function parseCwdField(
  buffer: Buffer,
  fieldOffset: number,
): JsonStringFieldParseResult {
  return parseJsonStringField(buffer, fieldOffset, CWD_FIELD.length, buffer.length);
}

type JsonStringFieldParseResult =
  | { kind: "value"; value: string; endOffset: number }
  | { kind: "incomplete" }
  | { kind: "invalid" }
  | { kind: "not_field" };

function parseJsonStringField(
  buffer: Buffer,
  fieldOffset: number,
  fieldNameLength: number,
  endOffset: number,
): JsonStringFieldParseResult {
  let offset = fieldOffset + fieldNameLength;
  while (offset < endOffset && isJsonWhitespace(buffer[offset]!)) offset += 1;
  if (offset >= endOffset) return { kind: "incomplete" };
  if (buffer[offset] !== 0x3a) return { kind: "not_field" };

  offset += 1;
  while (offset < endOffset && isJsonWhitespace(buffer[offset]!)) offset += 1;
  if (offset >= endOffset) return { kind: "incomplete" };
  if (buffer[offset] !== 0x22) return { kind: "not_field" };

  const valueStart = offset;
  offset += 1;
  let escaped = false;
  while (offset < endOffset) {
    const byte = buffer[offset]!;
    if (escaped) {
      escaped = false;
    } else if (byte === 0x5c) {
      escaped = true;
    } else if (byte === 0x22) {
      const encodedValue = buffer.subarray(valueStart, offset + 1).toString("utf8");
      try {
        const value: unknown = JSON.parse(encodedValue);
        return typeof value === "string"
          ? { kind: "value", value, endOffset: offset + 1 }
          : { kind: "invalid" };
      } catch {
        return { kind: "invalid" };
      }
    }
    offset += 1;
  }
  return { kind: "incomplete" };
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function jsonNestingDepthAfterOffset(
  buffer: Buffer,
  startOffset: number,
  endOffset: number,
): number | undefined {
  let depth = 0;
  let inString = false;
  for (let offset = endOffset - 1; offset >= startOffset; offset -= 1) {
    const byte = buffer[offset]!;
    if (byte === 0x22 && !isEscapedQuote(buffer, offset, startOffset)) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (byte === 0x7d || byte === 0x5d) depth += 1;
    else if (byte === 0x7b || byte === 0x5b) {
      depth -= 1;
      if (depth < 0) return undefined;
    }
  }
  return inString ? undefined : depth;
}

function isEscapedQuote(buffer: Buffer, quoteOffset: number, lowerBound: number): boolean {
  let backslashCount = 0;
  for (let offset = quoteOffset - 1; offset >= lowerBound && buffer[offset] === 0x5c; offset -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}
