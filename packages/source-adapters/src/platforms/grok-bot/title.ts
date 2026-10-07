/**
 * Title + hidden-prompt helpers for Grok Bot sidebar agents.
 * Prefer profile.json name, then SAND_AGENT_PROFILE_UPDATE payload, then first
 * real user text, then a short agent id. Never leave SAND_HIDDEN_PROMPT as title.
 */

const SAND_HIDDEN_PREFIX = "[SAND_HIDDEN_PROMPT]";
const PROFILE_UPDATE_RE = /SAND_AGENT_PROFILE_UPDATE:v1:([A-Za-z0-9_-]+)/u;
const TURN_TAG_RE = /^\[t\d+[a-z]?\d*\]\s*/iu;
const TIMESTAMP_RE = /<timestamp>[\s\S]*?<\/timestamp>/giu;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)<\/user_query>/iu;

export function isGrokBotHiddenPromptText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith(SAND_HIDDEN_PREFIX)) {
    return true;
  }
  const query = trimmed.match(USER_QUERY_RE)?.[1]?.trim();
  return Boolean(query?.startsWith(SAND_HIDDEN_PREFIX));
}

export function extractGrokBotProfileUpdateName(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const match = text.match(PROFILE_UPDATE_RE);
  const token = match?.[1];
  if (!token) {
    return undefined;
  }
  const payload = decodeBase64JsonObject(token);
  const name = typeof payload?.name === "string" ? payload.name.trim() : undefined;
  return name || undefined;
}

export function cleanGrokBotUserTitleText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  let value = text.replace(/\r\n/g, "\n").trim();
  if (!value || isGrokBotHiddenPromptText(value)) {
    return undefined;
  }

  const query = value.match(USER_QUERY_RE)?.[1]?.trim();
  if (query) {
    value = query;
  }
  value = value
    .replace(TIMESTAMP_RE, " ")
    .replace(TURN_TAG_RE, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (!value || isGrokBotHiddenPromptText(value)) {
    return undefined;
  }
  return value;
}

export function shortGrokBotAgentLabel(agentId: string): string {
  const compact = agentId.replace(/[^a-zA-Z0-9]/gu, "");
  const short = (compact || agentId).slice(0, 8);
  return short || "agent";
}

export function resolveGrokBotSessionTitle(options: {
  agentId: string;
  profileName?: string;
  profileTitle?: string;
  profileUpdateName?: string;
  firstUserText?: string;
  truncate: (value: string, length: number) => string;
}): string {
  const profileName = options.profileName?.trim();
  if (profileName) {
    return options.truncate(profileName, 72);
  }
  const profileTitle = options.profileTitle?.trim();
  if (profileTitle) {
    return options.truncate(profileTitle, 72);
  }
  const updateName = options.profileUpdateName?.trim();
  if (updateName) {
    return options.truncate(updateName, 72);
  }
  const cleaned = cleanGrokBotUserTitleText(options.firstUserText);
  if (cleaned) {
    return options.truncate(cleaned, 72);
  }
  return shortGrokBotAgentLabel(options.agentId);
}

function decodeBase64JsonObject(token: string): Record<string, unknown> | undefined {
  const pad = "=".repeat((4 - (token.length % 4)) % 4);
  const padded = `${token}${pad}`;
  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const raw = Buffer.from(padded, encoding).toString("utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next encoding
    }
  }
  return undefined;
}
