import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { maxIso, minIso, type SourcePlatform } from "@cchistory/domain";
import { readBudgetedSqliteRows, type SourceReadBudget } from "../../core/read-budget.js";
import type { ExtractedSessionSeed } from "../../core/conversation-seeds.js";
import { parseGrokBotAgentIdFromPath } from "../grok-bot.js";

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

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch {
    return undefined;
  }

  try {
    db.exec("BEGIN");
    if (!tableExists(db, "transcript_entries")) {
      return undefined;
    }

    const rows = readBudgetedSqliteRows(
      db,
      "SELECT seq, id, entry FROM transcript_entries ORDER BY seq, id",
      ["seq", "id", "entry"],
      [],
      budget,
      `${filePath}:transcript_entries`,
    ) as unknown as TranscriptEntryRow[];

    const profile = readSiblingProfile(path.dirname(filePath), helpers);
    const title =
      profile?.name?.trim() ||
      profile?.title?.trim() ||
      `Grok Bot ${helpers.truncate(agentId, 12)}`;

    const records: ExtractedSessionSeed["records"] = [
      {
        pointer: "meta",
        observedAt: helpers.nowIso(),
        rawJson: JSON.stringify({
          id: sessionId,
          title,
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
    let messageCount = 0;

    for (const row of rows) {
      const entryId = helpers.asString(row.id) ?? `seq:${helpers.asNumber(row.seq) ?? records.length}`;
      const rawEntry = helpers.asString(row.entry);
      const parsed = helpers.safeJsonParse(rawEntry);
      if (!helpers.isObject(parsed)) {
        records.push({
          pointer: `entry:${entryId}`,
          observedAt: helpers.nowIso(),
          rawJson: JSON.stringify({
            id: entryId,
            role: "system",
            content: [{ type: "text", text: rawEntry ?? "", synthetic: true }],
            grok_bot: { unparseable_entry: true, seq: helpers.asNumber(row.seq) },
          }),
        });
        continue;
      }

      const kind = helpers.asString(parsed.kind) ?? "unknown";
      const observedAt =
        helpers.epochMillisToIso(helpers.asNumber(parsed.timestampMs)) ?? helpers.nowIso();
      createdAt = minIso(createdAt, observedAt) ?? observedAt;
      updatedAt = maxIso(updatedAt, observedAt) ?? observedAt;

      if (kind === "message") {
        const role = helpers.asString(parsed.role) ?? "assistant";
        const content = normalizeMessageContent(parsed.content, helpers);
        if (content.length === 0) {
          continue;
        }
        messageCount += 1;
        records.push({
          pointer: `message:${entryId}`,
          observedAt,
          rawJson: JSON.stringify({
            id: entryId,
            role,
            timestamp: observedAt,
            content,
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
      records.push({
        pointer: `entry:${entryId}`,
        observedAt,
        rawJson: JSON.stringify({
          id: entryId,
          role: "system",
          timestamp: observedAt,
          content: [
            {
              type: "text",
              text: summarizeOpaqueEntry(kind, parsed, helpers),
              synthetic: true,
            },
          ],
          grok_bot: {
            kind,
            seq: helpers.asNumber(row.seq),
            raw: parsed,
          },
        }),
      });
    }

    if (messageCount === 0) {
      return [];
    }

    if (records[0]) {
      records[0] = {
        ...records[0],
        observedAt: createdAt ?? records[0].observedAt,
      };
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

function normalizeMessageContent(
  content: unknown,
  helpers: GrokBotRuntimeHelpers,
): Record<string, unknown>[] {
  if (typeof content === "string" && content.trim()) {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter((entry): entry is Record<string, unknown> => helpers.isObject(entry));
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

function readSiblingProfile(
  agentDir: string,
  helpers: GrokBotRuntimeHelpers,
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
