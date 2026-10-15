import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { maxIso, minIso, type SourcePlatform } from "@cchistory/domain";
import { readBudgetedSqliteRows, type SourceReadBudget } from "../../core/read-budget.js";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";
import { parseGrokBotAgentIdFromPath } from "../grok-bot.js";
import {
  extractGrokBotProfileUpdateName,
  isGrokBotHiddenPromptText,
  resolveGrokBotSessionTitle,
} from "./title.js";

interface GrokBotRuntimeHelpers {
  asString(value: unknown): string | undefined;
  asNumber(value: unknown): number | undefined;
  isObject(value: unknown): value is Record<string, unknown>;
  safeJsonParse(value: string | undefined): unknown;
  epochMillisToIso(value: number | undefined): string | undefined;
  nowIso(): string;
  truncate(value: string, length: number): string;
}

interface TranscriptEntryRow {
  seq: unknown;
  id: unknown;
  entry: unknown;
}

/**
 * Read one Grok Bot sidebar-agent store.db into a single session seed.
 * Prefer message rows; keep non-message kinds as opaque evidence records so
 * unexpected shapes stay visible instead of being dropped.
 */
export function extractGrokBotStoreSeeds(
  platform: SourcePlatform,
  filePath: string,
  helpers: GrokBotRuntimeHelpers,
  targetSessionRefs: readonly string[] = [],
  budget?: SourceReadBudget,
): ExtractedSessionSeed[] | undefined {
  const agentId = parseGrokBotAgentIdFromPath(filePath) ?? path.basename(path.dirname(filePath));
  const sessionId = `sess:${platform}:${agentId}`;
  if (
    targetSessionRefs.length > 0 &&
    !targetSessionRefs.some(
      (ref) => ref === sessionId || ref === agentId || ref.endsWith(`:${agentId}`),
    )
  ) {
    return [];
  }

  const db = new DatabaseSync(filePath, { readOnly: true });

  try {
    db.exec("BEGIN");
    if (!tableExists(db, "transcript_entries")) {
      throw new Error("Grok Bot store is missing the transcript_entries table");
    }

    const rows = readBudgetedSqliteRows(
      db,
      "SELECT seq, id, entry FROM transcript_entries ORDER BY seq, id",
      ["seq", "id", "entry"],
      [],
      budget,
      `${filePath}:transcript_entries`,
    ) as unknown as TranscriptEntryRow[];

    const profile = readGrokBotProfile(path.dirname(filePath), helpers);

    const records: ExtractedSessionSeed["records"] = [
      {
        pointer: "meta",
        observedAt: helpers.nowIso(),
        rawJson: JSON.stringify({
          id: sessionId,
          source_session_id: agentId,
          grok_bot: {
            agent_id: agentId,
            profile_name: profile?.name,
            description: profile?.description,
          },
        }),
      },
    ];

    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let firstUserText: string | undefined;
    let profileUpdateName: string | undefined;

    for (const row of rows) {
      const entryId = helpers.asString(row.id) ?? `seq:${helpers.asNumber(row.seq) ?? records.length}`;
      const rawEntry = helpers.asString(row.entry);
      const parsed = helpers.safeJsonParse(rawEntry);
      if (!helpers.isObject(parsed)) {
        records.push({
          pointer: `entry:${entryId}`,
          observedAt: helpers.nowIso(),
          // Keep the original value so the ordinary parser retains unknown
          // evidence and emits its normal JSON/non-object loss diagnostic.
          rawJson: rawEntry ?? "null",
        });
        continue;
      }

      const kind = helpers.asString(parsed.kind) ?? "unknown";
      const observedAt =
        helpers.epochMillisToIso(helpers.asNumber(parsed.timestampMs)) ?? helpers.nowIso();
      createdAt = minIso(createdAt, observedAt) ?? observedAt;
      updatedAt = maxIso(updatedAt, observedAt) ?? observedAt;

      if (kind === "message") {
        const role = helpers.asString(parsed.role);
        const supportedRole = role === "user" || role === "assistant" || role === "system" ||
          role === "developer" || role === "tool";
        // An inferred actor must not make an unusable store supersede JSONL.
        // Unknown content retains the complete native entry and a parse loss.
        const content = supportedRole ? normalizeMessageContent(parsed.content, helpers)
          : [{ type: "grok_bot_unsupported_role", raw: parsed }];
        const plainText = contentText(content, helpers);
        if (!profileUpdateName) {
          profileUpdateName = extractGrokBotProfileUpdateName(plainText);
        }
        if (role === "user" && !firstUserText && plainText && !isGrokBotHiddenPromptText(plainText)) {
          firstUserText = plainText;
        }
        records.push({
          pointer: `message:${entryId}`,
          observedAt,
          rawJson: JSON.stringify({
            id: entryId,
            role: supportedRole ? role : "system",
            timestamp: observedAt,
            content: content.length > 0 ? content : [{ type: "grok_bot_empty_message", raw: parsed }],
            grok_bot: {
              kind,
              seq: helpers.asNumber(row.seq),
              from_agent: parsed.fromAgent,
              to_agent: parsed.toAgent,
            },
          }),
        });
        continue;
      }

      // Preserve non-message kinds as evidence without inventing user turns.
      const opaqueText = summarizeOpaqueEntry(kind, parsed, helpers);
      if (!profileUpdateName) {
        profileUpdateName = extractGrokBotProfileUpdateName(opaqueText);
      }
      records.push({
        pointer: `entry:${entryId}`,
        observedAt,
        rawJson: JSON.stringify({
          id: entryId,
          role: "system",
          timestamp: observedAt,
          content: ["event", "send-message", "user-attachment"].includes(kind) ? [
            {
              type: "text",
              text: opaqueText,
              synthetic: true,
            },
          ] : [{ type: "grok_bot_unknown_entry", raw: parsed }],
          grok_bot: {
            kind,
            seq: helpers.asNumber(row.seq),
            raw: parsed,
          },
        }),
      });
    }

    if (records.length === 1) {
      return [];
    }

    const title = resolveGrokBotSessionTitle({
      agentId,
      profileName: profile?.name,
      profileTitle: profile?.title,
      profileUpdateName,
      firstUserText,
      truncate: helpers.truncate,
    });

    if (records[0]) {
      const meta = helpers.safeJsonParse(records[0].rawJson);
      if (helpers.isObject(meta)) {
        records[0] = {
          ...records[0],
          observedAt: createdAt ?? records[0].observedAt,
          rawJson: JSON.stringify({ ...meta, title }),
        };
      } else {
        records[0] = {
          ...records[0],
          observedAt: createdAt ?? records[0].observedAt,
        };
      }
    }

    return [
      {
        sessionId,
        title,
        createdAt,
        updatedAt: updatedAt ?? createdAt,
        records,
      },
    ];
  } finally {
    db.close();
  }
}

export function readGrokBotProfileFromAgentDir(
  agentDir: string,
  helpers: Pick<GrokBotRuntimeHelpers, "asString" | "isObject" | "safeJsonParse">,
): { name?: string; title?: string; description?: string } | undefined {
  return readGrokBotProfile(agentDir, helpers);
}

export function resolveGrokBotProfilePathFromSourceFile(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/gu, "/");
  const storeMatch = normalized.match(/^(.*)\/agents\/([^/]+)\/store\.db$/u);
  if (storeMatch?.[1] && storeMatch[2]) {
    return path.join(storeMatch[1], "agents", storeMatch[2], "profile.json");
  }
  const transcriptMatch = normalized.match(/^(.*)\/agent-transcripts\/([^/]+)\/[^/]+\.jsonl$/u);
  if (transcriptMatch?.[1] && transcriptMatch[2]) {
    return path.join(transcriptMatch[1], "agents", transcriptMatch[2], "profile.json");
  }
  return undefined;
}

export function loadGrokBotProfileTitleForSourceFile(
  filePath: string,
  helpers: Pick<GrokBotRuntimeHelpers, "asString" | "isObject" | "safeJsonParse" | "truncate">,
  agentId: string,
): string | undefined {
  const profilePath = resolveGrokBotProfilePathFromSourceFile(filePath);
  if (!profilePath || !existsSync(profilePath)) {
    return undefined;
  }
  const profile = readGrokBotProfile(path.dirname(profilePath), helpers);
  if (!profile?.name?.trim() && !profile?.title?.trim()) {
    return undefined;
  }
  return resolveGrokBotSessionTitle({
    agentId,
    profileName: profile?.name,
    profileTitle: profile?.title,
    truncate: helpers.truncate,
  });
}

function normalizeMessageContent(
  content: unknown,
  helpers: GrokBotRuntimeHelpers,
): Record<string, unknown>[] {
  if (typeof content === "string" && content.trim()) {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((entry) => helpers.isObject(entry)
      ? entry
      : typeof entry === "string" && entry.trim()
        ? { type: "text", text: entry }
        : { type: "grok_bot_unsupported_content", raw: entry });
  }
  if (helpers.isObject(content)) {
    const text = helpers.asString(content.text) ?? helpers.asString(content.content);
    if (text?.trim()) {
      return [{ type: "text", text }];
    }
    return [content];
  }
  return [];
}

function contentText(
  content: Record<string, unknown>[],
  helpers: GrokBotRuntimeHelpers,
): string {
  return content
    .map((entry) => helpers.asString(entry.text) ?? helpers.asString(entry.content) ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function summarizeOpaqueEntry(
  kind: string,
  parsed: Record<string, unknown>,
  helpers: GrokBotRuntimeHelpers,
): string {
  if (kind === "send-message") {
    const message = helpers.isObject(parsed.message) ? parsed.message : undefined;
    const text = helpers.asString(message?.content) ?? helpers.asString(parsed.content);
    return text?.trim() ? `[send-message] ${helpers.truncate(text, 240)}` : "[send-message]";
  }
  if (kind === "user-attachment") {
    const name = helpers.asString(parsed.file_name) ?? helpers.asString(parsed.file_path) ?? "attachment";
    return `[user-attachment] ${name}`;
  }
  if (kind === "event") {
    const event = helpers.isObject(parsed.event) ? parsed.event : undefined;
    const type = helpers.asString(event?.type) ?? "event";
    return `[event] ${type}`;
  }
  return `[${kind}]`;
}

function readGrokBotProfile(
  agentDir: string,
  helpers: Pick<GrokBotRuntimeHelpers, "asString" | "isObject" | "safeJsonParse">,
): { name?: string; title?: string; description?: string } | undefined {
  try {
    const raw = readFileSync(path.join(agentDir, "profile.json"), "utf8");
    const parsed = helpers.safeJsonParse(raw);
    if (!helpers.isObject(parsed)) {
      return undefined;
    }
    return {
      name: helpers.asString(parsed.name),
      title: helpers.asString(parsed.title),
      description: helpers.asString(parsed.description),
    };
  } catch {
    return undefined;
  }
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | { name?: unknown }
    | undefined;
  return typeof row?.name === "string";
}
