import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { SourcePlatform } from "@cchistory/domain";
import { deriveSessionId } from "./source-identity.js";
import { coerceIso } from "./type-guards.js";

export interface SourceFileLogicalSessionMetadata {
  sessionKey: string;
  sessionKeyState: "known" | "uncertain";
  workingDirectoryState: "known" | "absent" | "uncertain";
  workingDirectory?: string;
  relatedSessionRefs?: string[];
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
export const SESSION_METADATA_MAX_LINE_BYTES = 1024 * 1024;

interface WorkspaceScanState {
  firstWorkingDirectory?: string;
  latest?: { workingDirectory: string; timeKey: string; seqNo: number };
  sawWorkspaceChange: boolean;
  allSignalTimesValid: boolean;
  uncertain: boolean;
}

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
  try {
    for await (const line of streamBoundedJsonlLines(input, SESSION_METADATA_MAX_LINE_BYTES)) {
      if (!hasNonWhitespaceBytes(line.buffer) && !line.oversized) continue;
      return line.oversized
        ? deriveSessionId(platform, filePath, Buffer.alloc(0))
        : deriveSessionId(platform, filePath, line.buffer);
    }
    return deriveSessionId(platform, filePath, Buffer.alloc(0));
  } catch {
    // A file that cannot be read (deleted or rotated mid-scan, EACCES, EIO)
    // degrades to the same path-based key an empty file gets, so the scan
    // continues and the subsequent probe records its own file error.
    return deriveSessionId(platform, filePath, Buffer.alloc(0));
  } finally {
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
  options: { includeWorkspaceMetadata?: boolean } = {},
): Promise<SourceFileLogicalSessionMetadata> {
  if (platform !== "codex" && platform !== "claude_code") {
    return {
      sessionKey: await deriveSourceFileLogicalSessionKey(platform, filePath),
      sessionKeyState: "known",
      workingDirectoryState: "absent",
    };
  }

  try {
    const input = createReadStream(filePath);
    let firstLine = Buffer.alloc(0);
    let firstLineOversized = false;
    const workspaceState: WorkspaceScanState = {
      sawWorkspaceChange: false,
      allSignalTimesValid: true,
      uncertain: false,
    };
    try {
      for await (const line of streamBoundedJsonlLines(input, SESSION_METADATA_MAX_LINE_BYTES)) {
        if (!hasNonWhitespaceBytes(line.buffer) && !line.oversized) continue;
        if (firstLine.length === 0) {
          firstLine = Buffer.from(line.buffer);
          firstLineOversized = line.oversized;
          if (options.includeWorkspaceMetadata === false) break;
        }
        if (line.oversized) inspectOversizedWorkspaceMetadataLine(platform, line.buffer, workspaceState);
        else inspectWorkspaceMetadataLine(platform, line.buffer, workspaceState);
      }
    } finally {
      input.destroy();
    }
    const sessionKey = deriveSessionId(
      platform,
      filePath,
      firstLine,
    );
    const relatedSessionRefs = platform === "codex"
      ? extractCodexRelatedSessionRefs(firstLine)
      : undefined;
    const sessionKeyState = firstLineOversized ? "uncertain" as const : "known" as const;
    const workspace = options.includeWorkspaceMetadata === false
      ? { state: "absent" as const }
      : finishWorkspaceMetadataScan(workspaceState);
    return workspace.state === "known"
      ? {
          sessionKey,
          sessionKeyState,
          workingDirectoryState: "known",
          workingDirectory: workspace.workingDirectory,
          ...(relatedSessionRefs ? { relatedSessionRefs } : {}),
        }
      : {
          sessionKey,
          sessionKeyState,
          workingDirectoryState: workspace.state,
          ...(relatedSessionRefs ? { relatedSessionRefs } : {}),
        };
  } catch {
    return {
      sessionKey: deriveSessionId(platform, filePath, Buffer.alloc(0)),
      sessionKeyState: "uncertain",
      workingDirectoryState: "uncertain",
    };
  }
}

function extractCodexRelatedSessionRefs(firstLine: Buffer): string[] | undefined {
  try {
    const parsed = JSON.parse(firstLine.toString("utf8")) as Record<string, unknown>;
    const payload = isObjectRecord(parsed.payload) ? parsed.payload : undefined;
    const source = isObjectRecord(payload?.source) ? payload.source : undefined;
    const subagent = isObjectRecord(source?.subagent) ? source.subagent : undefined;
    const threadSpawn = isObjectRecord(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
    const parentRef = firstString(threadSpawn?.parent_thread_id);
    return parentRef ? [parentRef, `sess:codex:${parentRef}`] : undefined;
  } catch {
    return undefined;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export async function inspectSourceFilesLogicalSessionMetadata(
  platform: SourcePlatform,
  filePaths: readonly string[],
  options: { includeWorkspaceMetadata?: boolean } = {},
): Promise<SourceFileLogicalSessionMetadata[]> {
  if (filePaths.length < 16) {
    const results: SourceFileLogicalSessionMetadata[] = [];
    for (const filePath of filePaths) {
      results.push(await inspectSourceFileLogicalSessionMetadata(platform, filePath, options));
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
      worker.postMessage({ index, platform, filePath: filePaths[index], options });
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

interface BoundedJsonlLine {
  buffer: Buffer;
  oversized: boolean;
}

async function* streamBoundedJsonlLines(
  input: AsyncIterable<Buffer | string>,
  maxLineBytes: number,
): AsyncGenerator<BoundedJsonlLine> {
  let fragments: Buffer[] = [];
  let retainedBytes = 0;
  let oversized = false;

  const append = (segment: Buffer): void => {
    if (segment.length === 0 || retainedBytes >= maxLineBytes) return;
    const retained = segment.subarray(0, Math.min(segment.length, maxLineBytes - retainedBytes));
    fragments.push(retained);
    retainedBytes += retained.length;
    if (retained.length < segment.length) oversized = true;
  };
  const finish = (): BoundedJsonlLine => {
    const buffer = fragments.length === 0
      ? Buffer.alloc(0)
      : fragments.length === 1
        ? Buffer.from(fragments[0]!)
        : Buffer.concat(fragments, retainedBytes);
    const result = { buffer, oversized };
    fragments = [];
    retainedBytes = 0;
    oversized = false;
    return result;
  };

  for await (const rawChunk of input) {
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk, "utf8") : rawChunk;
    let segmentStart = 0;
    while (segmentStart < chunk.length) {
      const newlineOffset = chunk.indexOf(0x0a, segmentStart);
      if (newlineOffset < 0) {
        if (retainedBytes + chunk.length - segmentStart > maxLineBytes) oversized = true;
        append(chunk.subarray(segmentStart));
        break;
      }
      const segment = chunk.subarray(segmentStart, newlineOffset);
      if (retainedBytes + segment.length > maxLineBytes) oversized = true;
      append(segment);
      yield finish();
      segmentStart = newlineOffset + 1;
    }
  }
  if (fragments.length > 0 || oversized) yield finish();
}

function hasNonWhitespaceBytes(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (!isJsonWhitespace(byte)) return true;
  }
  return false;
}

function inspectOversizedWorkspaceMetadataLine(
  _platform: "codex" | "claude_code",
  _prefix: Buffer,
  state: WorkspaceScanState,
): void {
  state.uncertain = true;
}

function inspectWorkspaceMetadataLine(
  platform: "codex" | "claude_code",
  buffer: Buffer,
  state: WorkspaceScanState,
): void {
  if (state.uncertain || buffer.indexOf(CWD_FIELD) < 0) return;
  const cwd = findJsonStringFieldsAtDepth(buffer, 0, buffer.length, CWD_FIELD, platform === "claude_code" ? 1 : 2);
  if (cwd.state === "uncertain") {
    state.uncertain = true;
    return;
  }
  if (cwd.state !== "known") return;

  let seqNo = 0;
  if (platform === "codex") {
    const type = findJsonStringFieldsAtDepth(buffer, 0, buffer.length, TYPE_FIELD, 1);
    if (type.state === "uncertain") {
      state.uncertain = true;
      return;
    }
    if (type.state !== "known" || (type.value !== "session_meta" && type.value !== "turn_context")) return;
    if (cwd.count !== 1) {
      state.uncertain = true;
      return;
    }
    seqNo = type.value === "session_meta" ? 1 : 0;
  }

  if (state.firstWorkingDirectory === undefined) {
    state.firstWorkingDirectory = cwd.value;
  } else if (state.firstWorkingDirectory !== cwd.value) {
    state.sawWorkspaceChange = true;
  }

  const timestamp = findJsonStringFieldsAtDepth(buffer, 0, buffer.length, TIMESTAMP_FIELD, 1);
  const timeKey = timestamp.state === "known" ? coerceIso(timestamp.value) : undefined;
  if (!timeKey) {
    state.allSignalTimesValid = false;
    return;
  }
  if (
    !state.latest ||
    timeKey > state.latest.timeKey ||
    (timeKey === state.latest.timeKey && seqNo >= state.latest.seqNo)
  ) {
    state.latest = { workingDirectory: cwd.value, timeKey, seqNo };
  }
}

function finishWorkspaceMetadataScan(state: WorkspaceScanState): LogicalSessionWorkspaceMetadata {
  if (state.uncertain) return { state: "uncertain" };
  if (state.firstWorkingDirectory === undefined) return { state: "absent" };
  if (!state.sawWorkspaceChange) return { state: "known", workingDirectory: state.firstWorkingDirectory };
  if (!state.allSignalTimesValid || !state.latest) return { state: "uncertain" };
  return { state: "known", workingDirectory: state.latest.workingDirectory };
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
