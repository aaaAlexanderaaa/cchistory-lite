import { readBudgetedSqliteRows, type SourceReadBudget } from "../../core/read-budget.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourcePlatform } from "@cchistory/domain";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";
import { splitUserText } from "../../core/user-text.js";

interface GenericSessionMetadataLike {
  workspacePath?: string;
  model?: string;
  title?: string;
  parentUuid?: string;
  isSidechain?: boolean;
}

interface TokenUsageLike {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  model?: string;
}

interface CursorRuntimeHelpers {
  asString(value: unknown): string | undefined;
  asNumber(value: unknown): number | undefined;
  asArray(value: unknown): unknown[];
  isObject(value: unknown): value is Record<string, any>;
  safeJsonParse(value: string | undefined): unknown;
  coerceIso(value: unknown): string | undefined;
  epochMillisToIso(value: number | undefined): string | undefined;
  nowIso(): string;
  truncate(value: string, length: number): string;
  sha1(value: string | Buffer): string;
  normalizeWorkspacePath(value: string): string | undefined;
  extractGenericSessionMetadata(parsed: Record<string, unknown>): GenericSessionMetadataLike;
  extractGenericRole(message: Record<string, unknown>): string | undefined;
  extractGenericContentItems(message: Record<string, unknown>): Record<string, unknown>[];
  extractTokenUsage(value: unknown): TokenUsageLike | undefined;
  normalizeStopReason(value: unknown): string | undefined;
  extractRichTextText(value: string): string | undefined;
  collectConversationSeedsFromValue(
    platform: SourcePlatform,
    value: unknown,
    originHint: string,
    options?: {
      defaultSessionId?: string;
      defaultTitle?: string;
      defaultWorkingDirectory?: string;
    },
  ): ExtractedSessionSeed[];
  firstDefinedNumber(...values: Array<number | undefined>): number | undefined;
}

export function extractCursorComposerTimestamps(
  composer: Record<string, unknown>,
  helpers: Pick<CursorRuntimeHelpers, "asNumber" | "coerceIso" | "epochMillisToIso">,
): { createdAt?: string; updatedAt?: string } {
  const createdAt =
    helpers.epochMillisToIso(helpers.asNumber(composer.createdAt)) ?? helpers.coerceIso(composer.createdAt);
  const updatedAt =
    helpers.epochMillisToIso(helpers.asNumber(composer.lastUpdatedAt)) ??
    helpers.coerceIso(composer.lastUpdatedAt) ??
    helpers.epochMillisToIso(helpers.asNumber(composer.updatedAt)) ??
    helpers.coerceIso(composer.updatedAt);
  return { createdAt, updatedAt };
}

export function buildCursorComposerSeed(
  platform: SourcePlatform,
  storageKey: string,
  composer: Record<string, unknown>,
  rowMap: Map<string, string>,
  defaultWorkingDirectory: string | undefined,
  helpers: CursorRuntimeHelpers,
  workspacePathById: ReadonlyMap<string, string> = new Map(),
): ExtractedSessionSeed | undefined {
  const composerId =
    (helpers.asString(composer.composerId) ??
      helpers.asString(composer.id) ??
      storageKey.split(":").slice(1).join(":")) ||
    helpers.sha1(storageKey);
  const sessionId = `sess:${platform}:${composerId}`;
  const meta = helpers.extractGenericSessionMetadata(composer);
  const workingDirectory =
    extractCursorWorkspacePath(composer, helpers, workspacePathById) ??
    meta.workspacePath ??
    defaultWorkingDirectory;
  const composerModel = extractCursorModel(composer, helpers) ?? meta.model;
  const explicitBubbleRefs = extractBubbleRefsFromComposer(composer, helpers);
  const bubbleRefs =
    explicitBubbleRefs.length > 0 ? explicitBubbleRefs : collectComposerPrefixedBubbleRefs(composerId, rowMap);
  let messageRecords = resolveCursorBubbleRecords(bubbleRefs, composerId, rowMap, workingDirectory, helpers);
  if (messageRecords.length === 0 && explicitBubbleRefs.length > 0) {
    messageRecords = resolveCursorBubbleRecords(
      collectComposerPrefixedBubbleRefs(composerId, rowMap),
      composerId,
      rowMap,
      workingDirectory,
      helpers,
    );
  }

  if (messageRecords.length === 0) {
    const fallback = helpers.collectConversationSeedsFromValue(platform, composer, storageKey, {
      defaultSessionId: sessionId,
      defaultWorkingDirectory: workingDirectory,
      defaultTitle: meta.title,
    });
    return fallback[0];
  }

  const bubbleModel = messageRecords
    .map((message) => helpers.asString(message.record.model))
    .find((value): value is string => Boolean(value));
  const model = composerModel ?? bubbleModel;
  const composerClock = extractCursorComposerTimestamps(composer, helpers);
  const composerFallbackObservedAt = composerClock.updatedAt ?? composerClock.createdAt;
  const messageHasUsage = messageRecords.some((message) =>
    Boolean(helpers.extractTokenUsage(message.record.usage ?? message.record)),
  );
  const composerUsage = messageHasUsage ? undefined : helpers.extractTokenUsage(composer);

  const records: ExtractedSessionSeed["records"] = [];
  if (meta.title || model || workingDirectory || composerUsage) {
    records.push({
      pointer: "meta",
      observedAt: messageRecords[0]?.observedAt ?? composerFallbackObservedAt,
      rawJson: JSON.stringify({
        id: sessionId,
        title: meta.title,
        model,
        cwd: workingDirectory,
        usage: composerUsage,
        createdAt: composerClock.createdAt ?? messageRecords[0]?.observedAt,
        updatedAt: composerClock.updatedAt ?? messageRecords.at(-1)?.observedAt ?? composerClock.createdAt,
      }),
    });
  }
  messageRecords
    .sort((left, right) => (left.observedAt ?? "").localeCompare(right.observedAt ?? ""))
    .forEach((message, index) => {
      records.push({
        pointer: `bubble[${index}]`,
        observedAt: message.observedAt ?? composerFallbackObservedAt,
        rawJson: JSON.stringify(message.record),
      });
    });

  return {
    sessionId,
    title: meta.title,
    createdAt: messageRecords[0]?.observedAt ?? composerClock.createdAt,
    updatedAt: messageRecords.at(-1)?.observedAt ?? composerClock.updatedAt ?? composerClock.createdAt,
    model,
    workingDirectory,
    records,
  };
}

export interface CursorChatStoreSeedResult {
  seed: ExtractedSessionSeed;
  diagnostics: Array<{
    code: string;
    detail: string;
    severity: "info" | "warning";
  }>;
}

export function buildCursorPromptHistorySeed(
  platform: SourcePlatform,
  filePath: string,
  rowMap: Map<string, string>,
  defaultWorkingDirectory: string | undefined,
  fallbackObservedAtBase: string,
  helpers: CursorRuntimeHelpers,
): ExtractedSessionSeed | undefined {
  const generationEntries = parseCursorPromptHistoryEntries(
    rowMap.get("aiService.generations"),
    fallbackObservedAtBase,
    helpers,
  );
  const promptEntries =
    generationEntries.length === 0
      ? parseCursorPromptHistoryEntries(rowMap.get("aiService.prompts"), fallbackObservedAtBase, helpers)
      : [];
  const entries = generationEntries.length > 0 ? generationEntries : promptEntries;
  if (entries.length === 0) {
    return undefined;
  }

  const sessionScope = helpers.normalizeWorkspacePath(defaultWorkingDirectory ?? "") ?? path.dirname(filePath);
  const sessionId = `sess:${platform}:prompt-history:${helpers.sha1(sessionScope)}`;
  const title =
    extractCursorWorkspaceTitle(rowMap, helpers) ?? helpers.truncate(entries[0]?.text ?? "Cursor prompt history", 72);
  const createdAt = entries[0]?.observedAt ?? fallbackObservedAtBase;
  const updatedAt = entries.at(-1)?.observedAt ?? createdAt;
  const records: ExtractedSessionSeed["records"] = [
    {
      pointer: "meta",
      observedAt: createdAt,
      rawJson: JSON.stringify({
        id: sessionId,
        title,
        cwd: defaultWorkingDirectory,
      }),
    },
  ];

  entries.forEach((entry, index) => {
    records.push({
      pointer: `prompt[${index}]`,
      observedAt: entry.observedAt,
      rawJson: JSON.stringify({
        id: entry.id,
        role: "user",
        content: entry.text,
        cwd: defaultWorkingDirectory,
      }),
    });
  });

  return {
    sessionId,
    title,
    createdAt,
    updatedAt,
    workingDirectory: defaultWorkingDirectory,
    records,
  };
}

export function extractCursorChatStoreSeed(
  platform: SourcePlatform,
  filePath: string,
  fallbackObservedAtBase: string,
  helpers: CursorRuntimeHelpers,
  budget?: SourceReadBudget,
): CursorChatStoreSeedResult | undefined {
  const db = new DatabaseSync(filePath, { readOnly: true });

  try {
    db.exec("BEGIN");
    const metaRow = readBudgetedSqliteRows(db, "SELECT value FROM meta ORDER BY key LIMIT 1", ["value"], [], budget, `${filePath}:meta`)[0] as { value: unknown } | undefined;
    const meta = decodeCursorChatStoreMeta(metaRow?.value, helpers);
    const blobRows = readBudgetedSqliteRows(db, "SELECT rowid AS rowid, id, data FROM blobs ORDER BY rowid", ["rowid", "id", "data"], [], budget, `${filePath}:blobs`) as Array<{
      rowid: unknown;
      id: unknown;
      data: unknown;
    }>;

    const sidecar = readCursorChatStoreSidecar(filePath, helpers);
    const nativeSessionId = meta?.agentId ?? path.basename(path.dirname(filePath));
    const createdAt = meta?.createdAt ?? sidecar?.createdAt ?? fallbackObservedAtBase;
    const baseTime = Date.parse(createdAt);
    const blobIds = new Set(
      blobRows
        .map((row) => helpers.asString(row.id))
        .filter((blobId): blobId is string => Boolean(blobId)),
    );
    const decodedRows = blobRows
      .map((row, index) => decodeCursorChatStoreBlobRow(row, baseTime, index, blobIds, helpers))
      .filter((row): row is CursorChatStoreBlobRow => row !== undefined);

    const sessionId = `sess:${platform}:${nativeSessionId}`;
    const structuredRows = decodedRows.filter(
      (row): row is Extract<CursorChatStoreBlobRow, { kind: "structured" }> => row.kind === "structured",
    );
    const authoredUserRows = structuredRows.filter((row) => isAuthoredCursorChatStoreUserRecord(row.record, helpers));
    const visibleAssistantRows = structuredRows.filter((row) => isVisibleCursorChatStoreAssistantRecord(row.record, helpers));
    const readableTextRows = decodedRows.filter(
      (row): row is Extract<CursorChatStoreBlobRow, { kind: "text" }> =>
        row.kind === "text" && isReadableCursorChatStoreText(row.text),
    );
    const promptRow = authoredUserRows.length > 0 ? undefined : readableTextRows[0];
    const structuredAssistant =
      authoredUserRows.length > 0
        ? (meta?.latestRootBlobId
            ? visibleAssistantRows.find((row) => row.blobId === meta.latestRootBlobId)
            : undefined) ?? visibleAssistantRows.at(-1)
        : (meta?.latestRootBlobId
            ? structuredRows.find((row) => row.blobId === meta.latestRootBlobId)
            : undefined) ?? structuredRows.at(-1);
    const fallbackAssistant =
      structuredAssistant || authoredUserRows.length > 0 ? undefined : readableTextRows.at(1);
    const workingDirectory = sidecar?.cwd;
    const title = preferCursorChatStoreTitle(meta?.name, sidecar?.title) ?? `Cursor chat store ${nativeSessionId}`;

    const records: ExtractedSessionSeed["records"] = [
      {
        pointer: "meta",
        observedAt: createdAt,
        rawJson: JSON.stringify({
          id: sessionId,
          title,
          model: meta?.lastUsedModel,
          cwd: workingDirectory,
          cursor_chat_store: {
            agentId: meta?.agentId,
            latestRootBlobId: meta?.latestRootBlobId,
            mode: meta?.mode,
          },
        }),
      },
    ];

    if (authoredUserRows.length > 0) {
      const authoredUserIds = new Set(authoredUserRows.map((row) => row.blobId));
      const visibleAssistantIds = new Set(visibleAssistantRows.map((row) => row.blobId));
      for (const row of decodedRows) {
        if (row.kind !== "structured") {
          continue;
        }
        if (!authoredUserIds.has(row.blobId) && !visibleAssistantIds.has(row.blobId)) {
          continue;
        }
        records.push({
          pointer: `blob:${row.blobId}`,
          observedAt: row.observedAt,
          rawJson: JSON.stringify(row.record),
        });
      }
    } else if (promptRow?.kind === "text") {
      records.push({
        pointer: `blob:${promptRow.blobId}`,
        observedAt: promptRow.observedAt,
        rawJson: JSON.stringify({
          id: `prompt:${promptRow.blobId}`,
          role: "user",
          content: [{ type: "input_text", text: promptRow.text }],
        }),
      });
      if (structuredAssistant?.kind === "structured") {
        records.push({
          pointer: `blob:${structuredAssistant.blobId}`,
          observedAt: structuredAssistant.observedAt,
          rawJson: JSON.stringify(structuredAssistant.record),
        });
      } else if (fallbackAssistant?.kind === "text") {
        records.push({
          pointer: `blob:${fallbackAssistant.blobId}`,
          observedAt: fallbackAssistant.observedAt,
          rawJson: JSON.stringify({
            id: `assistant:${fallbackAssistant.blobId}`,
            role: "assistant",
            content: [{ type: "output_text", text: fallbackAssistant.text }],
          }),
        });
      }
    }

    if (records.length <= 1) {
      return undefined;
    }

    return {
      seed: {
        sessionId,
        title,
        createdAt,
        updatedAt: sidecar?.updatedAt ?? records.at(-1)?.observedAt ?? createdAt,
        model: meta?.lastUsedModel,
        workingDirectory,
        records,
      },
      diagnostics: [
        {
          code: "cursor_chat_store_blob_graph_opaque",
          detail:
            "Cursor chat-store blob graph remains opaque; projected JSON user_query or protobuf-style prompt fragments plus assistant evidence instead of walking the DAG.",
          severity: "info",
        },
      ],
    };
  } finally {
    db.close();
  }
}

interface CursorChatStoreMeta {
  agentId?: string;
  latestRootBlobId?: string;
  name?: string;
  mode?: string;
  createdAt?: string;
  lastUsedModel?: string;
}

type CursorChatStoreBlobRow =
  | {
      kind: "text";
      blobId: string;
      observedAt: string;
      text: string;
    }
  | {
      kind: "structured";
      blobId: string;
      observedAt: string;
      record: Record<string, unknown>;
    };

function decodeCursorChatStoreMeta(
  rawValue: unknown,
  helpers: Pick<CursorRuntimeHelpers, "asString" | "safeJsonParse" | "isObject" | "coerceIso" | "epochMillisToIso">,
): CursorChatStoreMeta | undefined {
  const hexValue = helpers.asString(rawValue)?.trim();
  if (!hexValue) {
    return undefined;
  }

  let decodedText: string;
  try {
    decodedText = Buffer.from(hexValue, "hex").toString("utf8");
  } catch {
    return undefined;
  }

  const parsed = helpers.safeJsonParse(decodedText);
  if (!helpers.isObject(parsed)) {
    return undefined;
  }

  return {
    agentId: helpers.asString(parsed.agentId),
    latestRootBlobId: helpers.asString(parsed.latestRootBlobId),
    name: helpers.asString(parsed.name),
    mode: helpers.asString(parsed.mode),
    createdAt: helpers.coerceIso(parsed.createdAt) ?? helpers.epochMillisToIso(typeof parsed.createdAt === "number" ? parsed.createdAt : undefined),
    lastUsedModel: helpers.asString(parsed.lastUsedModel),
  };
}

function decodeCursorChatStoreBlobRow(
  row: { rowid: unknown; id: unknown; data: unknown },
  baseTime: number,
  index: number,
  siblingBlobIds: ReadonlySet<string>,
  helpers: Pick<
    CursorRuntimeHelpers,
    | "asString"
    | "safeJsonParse"
    | "isObject"
    | "extractGenericRole"
    | "extractGenericContentItems"
    | "extractRichTextText"
    | "extractTokenUsage"
    | "normalizeStopReason"
    | "epochMillisToIso"
    | "asNumber"
    | "coerceIso"
  >,
): CursorChatStoreBlobRow | undefined {
  const blobId = helpers.asString(row.id);
  const dataBuffer = coerceBlobBuffer(row.data);
  if (!blobId || !dataBuffer) {
    return undefined;
  }
  const observedAt = helpers.epochMillisToIso(baseTime + index * 1000) ?? new Date(baseTime + index * 1000).toISOString();
  const decodedText = extractReadableCursorBlobText(dataBuffer);
  if (decodedText) {
    const structuredRecord = decodeStructuredCursorBlobRecord(blobId, decodedText, helpers);
    if (structuredRecord) {
      return {
        kind: "structured",
        blobId,
        observedAt,
        record: structuredRecord,
      };
    }
  }

  const protobufText = extractCursorChatStoreProtobufText(dataBuffer, siblingBlobIds);
  if (protobufText) {
    return {
      kind: "text",
      blobId,
      observedAt,
      text: protobufText,
    };
  }
  if (cursorChatStoreBlobLooksLikeGraph(dataBuffer, siblingBlobIds, blobId)) {
    return undefined;
  }
  if (!decodedText) {
    return undefined;
  }

  return {
    kind: "text",
    blobId,
    observedAt,
    text: decodedText,
  };
}

function decodeStructuredCursorBlobRecord(
  blobId: string,
  decodedText: string,
  helpers: Pick<
    CursorRuntimeHelpers,
    | "safeJsonParse"
    | "isObject"
    | "extractGenericRole"
    | "extractGenericContentItems"
    | "extractRichTextText"
    | "extractTokenUsage"
    | "normalizeStopReason"
    | "asString"
    | "asNumber"
    | "coerceIso"
    | "epochMillisToIso"
  >,
): Record<string, unknown> | undefined {
  const jsonStart = decodedText.indexOf("{");
  const jsonEnd = decodedText.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    return undefined;
  }

  const parsed = helpers.safeJsonParse(decodedText.slice(jsonStart, jsonEnd + 1));
  if (!helpers.isObject(parsed)) {
    return undefined;
  }

  const normalized = normalizeCursorBubbleRecord(parsed, undefined, helpers as CursorRuntimeHelpers);
  if (!normalized) {
    return undefined;
  }
  return {
    id: helpers.asString(normalized.record.id) ?? blobId,
    ...normalized.record,
  };
}

function extractReadableCursorBlobText(value: Buffer): string | undefined {
  const cleaned = value
    .toString("utf8")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function cursorChatStoreBlobLooksLikeGraph(
  data: Buffer,
  siblingBlobIds: ReadonlySet<string>,
  selfBlobId: string,
): boolean {
  let embeddedSiblingHashes = 0;
  for (const blobId of siblingBlobIds) {
    if (blobId === selfBlobId || blobId.length !== 64 || !/^[0-9a-f]+$/iu.test(blobId)) {
      continue;
    }
    const rawId = Buffer.from(blobId, "hex");
    if (rawId.length === 32 && data.includes(rawId)) {
      embeddedSiblingHashes += 1;
    }
  }
  if (embeddedSiblingHashes === 0) {
    return false;
  }
  const readable = extractReadableCursorBlobText(data);
  if (readable && isReadableCursorChatStoreText(readable)) {
    return false;
  }
  return true;
}

function readProtobufVarint(value: Buffer, offset: number): { value: number; size: number } | undefined {
  let result = 0;
  let shift = 0;
  let size = 0;
  while (offset + size < value.length && size < 5) {
    const byte = value[offset + size]!;
    size += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, size };
    }
    shift += 7;
  }
  return undefined;
}

function extractCursorChatStoreProtobufText(
  value: Buffer,
  siblingBlobIds: ReadonlySet<string> = new Set(),
): string | undefined {
  if (value.length < 10 || value[0] !== 0x0a) {
    return undefined;
  }
  const decodedLength = readProtobufVarint(value, 1);
  if (!decodedLength) {
    return undefined;
  }
  const start = 1 + decodedLength.size;
  if (decodedLength.value < 8 || start + decodedLength.value > value.length) {
    return undefined;
  }
  const candidate = value.subarray(start, start + decodedLength.value).toString("utf8").trim();
  if (!isReadableCursorChatStoreText(candidate) || cursorChatStoreTextLooksLikeJsonMessage(candidate)) {
    return undefined;
  }
  const remainder = value.subarray(start + decodedLength.value);
  if (!cursorChatStoreProtobufRemainderLooksValid(remainder, siblingBlobIds)) {
    return undefined;
  }
  return candidate;
}

function cursorChatStoreTextLooksLikeJsonMessage(text: string): boolean {
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    return /[{[]/.test(text) && /"role"\s*:/u.test(text);
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as unknown;
    return Boolean(parsed && typeof parsed === "object" && "role" in parsed);
  } catch {
    return /"role"\s*:/u.test(text);
  }
}

function cursorChatStoreProtobufRemainderLooksValid(
  remainder: Buffer,
  siblingBlobIds: ReadonlySet<string>,
): boolean {
  if (remainder.length === 0) {
    return true;
  }
  if (remainder[0] === 0x7b) {
    return false;
  }
  for (const blobId of siblingBlobIds) {
    if (blobId.length !== 64 || !/^[0-9a-f]+$/iu.test(blobId)) {
      continue;
    }
    const rawId = Buffer.from(blobId, "hex");
    if (rawId.length === 32 && remainder.subarray(0, 32).equals(rawId)) {
      return true;
    }
  }
  const wireType = (remainder[0] ?? 0) & 0x07;
  return wireType <= 5;
}

function isReadableCursorChatStoreText(text: string): boolean {
  const readable = text.replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, "");
  return readable.trim().length >= 8 && readable.length / text.length >= 0.75;
}

function collectCursorChatStoreRecordText(
  record: Record<string, unknown>,
  helpers: Pick<CursorRuntimeHelpers, "extractGenericContentItems" | "asString">,
): string {
  return helpers
    .extractGenericContentItems(record)
    .map((item) => helpers.asString(item.text) ?? helpers.asString(item.input_text) ?? helpers.asString(item.output_text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function isAuthoredCursorChatStoreUserRecord(
  record: Record<string, unknown>,
  helpers: Pick<CursorRuntimeHelpers, "extractGenericRole" | "extractGenericContentItems" | "asString">,
): boolean {
  if (helpers.extractGenericRole(record) !== "user") {
    return false;
  }
  return splitUserText(collectCursorChatStoreRecordText(record, helpers), { platform: "cursor" }).some(
    (chunk) => chunk.originKind === "user_authored",
  );
}

function isVisibleCursorChatStoreAssistantRecord(
  record: Record<string, unknown>,
  helpers: Pick<CursorRuntimeHelpers, "extractGenericRole" | "extractGenericContentItems" | "asString">,
): boolean {
  if (helpers.extractGenericRole(record) !== "assistant") {
    return false;
  }
  return helpers.extractGenericContentItems(record).some((item) => {
    const itemType = helpers.asString(item.type)?.trim().toLowerCase();
    if (itemType === "reasoning") {
      return false;
    }
    const text = helpers.asString(item.text) ?? helpers.asString(item.output_text);
    return Boolean(text?.trim());
  });
}

function preferCursorChatStoreTitle(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && trimmed.toLowerCase() !== "new agent") {
      return trimmed;
    }
  }
  return candidates.find((candidate) => candidate?.trim())?.trim();
}

function readCursorChatStoreSidecar(
  storePath: string,
  helpers: Pick<
    CursorRuntimeHelpers,
    "safeJsonParse" | "isObject" | "asString" | "asNumber" | "coerceIso" | "epochMillisToIso" | "normalizeWorkspacePath"
  >,
): { cwd?: string; title?: string; createdAt?: string; updatedAt?: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(path.dirname(storePath), "meta.json"), "utf8");
  } catch {
    return undefined;
  }
  const parsed = helpers.safeJsonParse(raw);
  if (!helpers.isObject(parsed)) {
    return undefined;
  }
  const cwd = helpers.asString(parsed.cwd);
  return {
    cwd: cwd ? helpers.normalizeWorkspacePath(cwd) ?? cwd : undefined,
    title: helpers.asString(parsed.title),
    createdAt: helpers.epochMillisToIso(helpers.asNumber(parsed.createdAtMs)) ?? helpers.coerceIso(parsed.createdAt),
    updatedAt: helpers.epochMillisToIso(helpers.asNumber(parsed.updatedAtMs)) ?? helpers.coerceIso(parsed.updatedAt),
  };
}

function coerceBlobBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  return undefined;
}


function resolveCursorBubbleRecords(
  bubbleRefs: readonly string[],
  composerId: string,
  rowMap: Map<string, string>,
  workingDirectory: string | undefined,
  helpers: CursorRuntimeHelpers,
): Array<{ observedAt?: string; record: Record<string, unknown> }> {
  return bubbleRefs
    .map((bubbleRef) => {
      const rawBubble = resolveCursorBubbleValue(bubbleRef, composerId, rowMap);
      if (!rawBubble) {
        return undefined;
      }
      const parsedBubble = helpers.safeJsonParse(rawBubble);
      if (!helpers.isObject(parsedBubble)) {
        return undefined;
      }
      return normalizeCursorBubbleRecord(parsedBubble, workingDirectory, helpers);
    })
    .filter((record): record is { observedAt?: string; record: Record<string, unknown> } => record !== undefined);
}

function resolveCursorBubbleValue(
  bubbleRef: string,
  composerId: string,
  rowMap: Map<string, string>,
): string | undefined {
  const trimmed = bubbleRef.trim();
  const withPrefix = trimmed.startsWith("bubbleId:") ? trimmed : `bubbleId:${trimmed}`;
  const bareId = withPrefix.slice("bubbleId:".length);
  return (
    rowMap.get(trimmed) ??
    rowMap.get(withPrefix) ??
    rowMap.get(`bubbleId:${trimmed}`) ??
    rowMap.get(`bubbleId:${composerId}:${bareId}`) ??
    rowMap.get(`bubbleId:${composerId}:${trimmed}`)
  );
}

function collectComposerPrefixedBubbleRefs(composerId: string, rowMap: Map<string, string>): string[] {
  const prefix = `bubbleId:${composerId}:`;
  const refs: string[] = [];
  for (const key of rowMap.keys()) {
    if (key.startsWith(prefix)) {
      refs.push(key);
    }
  }
  return refs;
}

function extractBubbleRefsFromComposer(value: unknown, helpers: CursorRuntimeHelpers): string[] {
  const refs = new Set<string>();

  const visit = (candidate: unknown, fieldHint?: string, depth = 0) => {
    if (depth > 6 || candidate === null || candidate === undefined) {
      return;
    }
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.startsWith("bubbleId:")) {
        refs.add(trimmed);
      } else if (fieldHint?.includes("bubble") && trimmed) {
        refs.add(`bubbleId:${trimmed}`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        visit(entry, fieldHint, depth + 1);
      }
      return;
    }
    if (!helpers.isObject(candidate)) {
      return;
    }

    const bubbleId = helpers.asString(candidate.bubbleId) ?? helpers.asString(candidate.id);
    if (bubbleId && fieldHint?.includes("bubble")) {
      refs.add(bubbleId.startsWith("bubbleId:") ? bubbleId : `bubbleId:${bubbleId}`);
    }

    for (const [key, entry] of Object.entries(candidate)) {
      visit(entry, key.toLowerCase(), depth + 1);
    }
  };

  visit(value);
  return [...refs];
}

function normalizeCursorBubbleRecord(
  value: Record<string, unknown>,
  defaultWorkingDirectory: string | undefined,
  helpers: CursorRuntimeHelpers,
): { observedAt?: string; record: Record<string, unknown> } | undefined {
  const role =
    helpers.extractGenericRole(value) ??
    (helpers.asNumber(value.type) === 1 ? "user" : helpers.asNumber(value.type) === 2 ? "assistant" : undefined);
  let content = helpers.extractGenericContentItems(value);
  if (content.length === 0) {
    const richText = helpers.asString(value.richText);
    const extractedText = richText ? helpers.extractRichTextText(richText) : undefined;
    if (extractedText) {
      content = [{ type: "text", text: extractedText }];
    }
  }
  if (!role && content.length === 0) {
    return undefined;
  }

  return {
    observedAt:
      helpers.coerceIso(value.createdAt) ??
      helpers.coerceIso(value.updatedAt) ??
      helpers.epochMillisToIso(helpers.asNumber(value.createdAt)) ??
      helpers.epochMillisToIso(helpers.asNumber(value.created)),
    record: {
      id: helpers.asString(value.bubbleId) ?? helpers.asString(value.id),
      role: role ?? "assistant",
      content,
      usage: helpers.extractTokenUsage(value),
      stopReason: helpers.normalizeStopReason(value.stopReason),
      cwd: defaultWorkingDirectory,
      model: extractCursorBubbleModel(value, helpers),
    },
  };
}

function parseCursorPromptHistoryEntries(
  rawValue: string | undefined,
  fallbackObservedAtBase: string,
  helpers: CursorRuntimeHelpers,
): Array<{ id: string; text: string; observedAt?: string }> {
  const parsed = helpers.safeJsonParse(rawValue);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const baseTime = Date.parse(fallbackObservedAtBase);
  const entries: Array<{ id: string; text: string; observedAt?: string }> = [];

  parsed.forEach((entry, index) => {
    if (!helpers.isObject(entry)) {
      return;
    }
    const text =
      helpers.asString(entry.textDescription) ??
      helpers.asString(entry.text) ??
      helpers.asString(entry.prompt);
    if (!text?.trim()) {
      return;
    }
    entries.push({
      id: helpers.asString(entry.generationUUID) ?? helpers.asString(entry.id) ?? helpers.sha1(`${text}:${index}`),
      text,
      observedAt:
        helpers.epochMillisToIso(helpers.asNumber(entry.unixMs)) ??
        helpers.epochMillisToIso(baseTime + index * 1000),
    });
  });

  entries.sort((left, right) => (left.observedAt ?? "").localeCompare(right.observedAt ?? ""));
  return entries;
}

function extractCursorWorkspaceTitle(
  rowMap: Map<string, string>,
  helpers: CursorRuntimeHelpers,
): string | undefined {
  const parsed = helpers.safeJsonParse(rowMap.get("composer.composerData"));
  if (!helpers.isObject(parsed)) {
    return undefined;
  }

  return helpers
    .asArray(parsed.allComposers)
    .filter((composer): composer is Record<string, unknown> => helpers.isObject(composer))
    .map((composer) => ({
      title: helpers.asString(composer.name) ?? helpers.asString(composer.title),
      sortKey: helpers.firstDefinedNumber(
        helpers.asNumber(composer.lastUpdatedAt),
        helpers.asNumber(composer.createdAt),
      ) ?? 0,
    }))
    .filter((composer) => composer.title)
    .sort((left, right) => right.sortKey - left.sortKey)[0]?.title;
}

export function extractCursorWorkspacePath(
  composer: Record<string, unknown>,
  helpers: Pick<CursorRuntimeHelpers, "isObject" | "asString" | "asArray" | "normalizeWorkspacePath">,
  workspacePathById: ReadonlyMap<string, string> = new Map(),
): string | undefined {
  const identifier = helpers.isObject(composer.workspaceIdentifier) ? composer.workspaceIdentifier : undefined;
  const uri = identifier && helpers.isObject(identifier.uri) ? identifier.uri : undefined;
  const fromUri =
    (uri ? helpers.asString(uri.fsPath) : undefined) ??
    (uri ? helpers.asString(uri.path) : undefined) ??
    (uri ? helpers.asString(uri.external) : undefined) ??
    (typeof identifier?.uri === "string" ? helpers.asString(identifier.uri) : undefined);
  const normalizedFromUri = fromUri ? helpers.normalizeWorkspacePath(fromUri) : undefined;
  if (normalizedFromUri) {
    return normalizedFromUri;
  }

  const storageId =
    (identifier ? helpers.asString(identifier.id) : undefined) ?? helpers.asString(composer.workspaceId);
  const mapped = storageId ? workspacePathById.get(storageId) : undefined;
  if (mapped) {
    return mapped;
  }

  for (const repo of helpers.asArray(composer.trackedGitRepos)) {
    if (!helpers.isObject(repo)) {
      continue;
    }
    const repoPath = helpers.asString(repo.repoPath);
    const normalizedRepoPath = repoPath ? helpers.normalizeWorkspacePath(repoPath) : undefined;
    if (normalizedRepoPath) {
      return normalizedRepoPath;
    }
  }
  return undefined;
}

export function extractCursorModel(
  composer: Record<string, unknown>,
  helpers: Pick<CursorRuntimeHelpers, "isObject" | "asString">,
): string | undefined {
  const modelConfig = helpers.isObject(composer.modelConfig) ? composer.modelConfig : undefined;
  return (
    (modelConfig ? helpers.asString(modelConfig.modelName) ?? helpers.asString(modelConfig.model) : undefined) ??
    helpers.asString(composer.modelName) ??
    helpers.asString(composer.model)
  );
}

function extractCursorBubbleModel(
  value: Record<string, unknown>,
  helpers: Pick<CursorRuntimeHelpers, "isObject" | "asString">,
): string | undefined {
  const modelInfo = helpers.isObject(value.modelInfo) ? value.modelInfo : undefined;
  return (
    (modelInfo ? helpers.asString(modelInfo.modelName) ?? helpers.asString(modelInfo.model) : undefined) ??
    helpers.asString(value.modelName) ??
    helpers.asString(value.model)
  );
}

const CURSOR_WORKSPACE_INDEX_CACHE = new Map<string, {
  byStorageId: Map<string, string>;
  byEncodedName: Map<string, string>;
}>();

export function clearCursorWorkspaceIndexCache(): void {
  CURSOR_WORKSPACE_INDEX_CACHE.clear();
}

export function encodeCursorProjectDirectoryName(workspacePath: string): string {
  return workspacePath.replace(/[\\/._:]+/g, "-").replace(/^-+|-+$/gu, "");
}

export function loadCursorWorkspaceIndex(
  userDir: string,
  helpers: Pick<CursorRuntimeHelpers, "safeJsonParse" | "isObject" | "asString" | "normalizeWorkspacePath">,
): { byStorageId: Map<string, string>; byEncodedName: Map<string, string> } {
  const cached = CURSOR_WORKSPACE_INDEX_CACHE.get(userDir);
  if (cached) {
    return cached;
  }
  const byStorageId = new Map<string, string>();
  const byEncodedName = new Map<string, string>();
  const storageRoot = path.join(userDir, "workspaceStorage");
  if (existsSync(storageRoot)) {
    try {
      for (const entry of readdirSync(storageRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const folder = readWorkspaceJsonFolderSync(
          path.join(storageRoot, entry.name, "workspace.json"),
          helpers,
        );
        if (!folder) {
          continue;
        }
        byStorageId.set(entry.name, folder);
        const encoded = encodeCursorProjectDirectoryName(folder);
        if (!byEncodedName.has(encoded)) {
          byEncodedName.set(encoded, folder);
        }
      }
    } catch {
      /* keep whatever we collected */
    }
  }
  const index = { byStorageId, byEncodedName };
  CURSOR_WORKSPACE_INDEX_CACHE.set(userDir, index);
  return index;
}

export function resolveCursorTranscriptWorkspacePath(
  filePath: string,
  helpers: Pick<CursorRuntimeHelpers, "safeJsonParse" | "isObject" | "asString" | "normalizeWorkspacePath">,
): string | undefined {
  const layout = parseCursorAgentTranscriptLayout(filePath);
  if (!layout) {
    return undefined;
  }
  return loadCursorEncodedWorkspaceIndex(layout.homeDir, helpers).get(layout.encodedProject);
}

function parseCursorAgentTranscriptLayout(
  filePath: string,
): { homeDir: string; encodedProject: string } | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = "/.cursor/projects/";
  const index = normalized.indexOf(marker);
  if (index < 0 || !normalized.includes("/agent-transcripts/")) {
    return undefined;
  }
  const encodedProject = normalized.slice(index + marker.length).split("/")[0];
  if (!encodedProject) {
    return undefined;
  }
  return {
    homeDir: normalized.slice(0, index),
    encodedProject,
  };
}

function loadCursorEncodedWorkspaceIndex(
  homeDir: string,
  helpers: Pick<CursorRuntimeHelpers, "safeJsonParse" | "isObject" | "asString" | "normalizeWorkspacePath">,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const userDir of cursorUserDirs(homeDir)) {
    for (const [encoded, folder] of loadCursorWorkspaceIndex(userDir, helpers).byEncodedName) {
      if (!index.has(encoded)) {
        index.set(encoded, folder);
      }
    }
  }
  return index;
}

function cursorUserDirs(homeDir: string): string[] {
  return [
    path.join(homeDir, "Library", "Application Support", "Cursor", "User"),
    path.join(homeDir, "AppData", "Roaming", "Cursor", "User"),
    path.join(homeDir, ".config", "Cursor", "User"),
    path.join(homeDir, ".config", "cursor", "User"),
  ];
}

function readWorkspaceJsonFolderSync(
  workspaceJsonPath: string,
  helpers: Pick<CursorRuntimeHelpers, "safeJsonParse" | "isObject" | "asString" | "normalizeWorkspacePath">,
): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(workspaceJsonPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = helpers.safeJsonParse(raw);
  if (!helpers.isObject(parsed)) {
    return undefined;
  }
  const folder =
    helpers.asString(parsed.folder) ??
    helpers.asString(parsed.path) ??
    helpers.asString(parsed.uri) ??
    (helpers.isObject(parsed.workspace)
      ? helpers.asString(parsed.workspace.path) ?? helpers.asString(parsed.workspace.uri)
      : undefined);
  return folder ? helpers.normalizeWorkspacePath(folder) : undefined;
}
