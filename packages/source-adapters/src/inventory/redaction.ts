/**
 * Role: Strict secret-hygiene redaction for MCP server commands, arguments, URLs,
 * headers, and environment key extraction. Guarantees env/header values, basic-auth
 * credentials, query tokens, and bearer/API tokens never leave the parse boundary.
 * Excludes filesystem discovery, TOML/JSON parsing, and activity correlation.
 */

const SECRET_FLAG_NAMES = new Set([
  "--token",
  "-t",
  "--api-key",
  "--apikey",
  "--api_key",
  "--secret",
  "--password",
  "--passwd",
  "--pass",
  "--auth",
  "--authorization",
  "--bearer",
  "--key",
  "--access-token",
  "--refresh-token",
  "--client-secret",
  "-h",
  "--header",
]);

const SENSITIVE_KEY_RE = /(?:token|secret|key|pass|auth|bearer|cookie|credential|private|sig|jwt)/iu;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/giu,
  /\bBasic\s+[A-Za-z0-9+/=]{6,}/giu,
  /\b(?:sk|pk|rk)-(?:proj-|live-|test-)?[A-Za-z0-9_-]{12,}/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}/gu,
  /\bAIza[0-9A-Za-z_-]{20,}/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/gu,
];
const INLINE_URL_RE = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`]+/gu;

/**
 * Redact an MCP URL by stripping basic-auth credentials, fragments, and all query
 * parameter values (preserving query keys as `<redacted>`).
 */
export function redactMcpUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    const hasAuth = Boolean(parsed.username || parsed.password);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    const queryKeys = [...new Set([...parsed.searchParams.keys()])];
    parsed.search = "";
    const base = parsed.toString().replace(/\/$/u, parsed.pathname === "/" && trimmed.endsWith("/") ? "/" : "");
    const querySuffix = queryKeys.length > 0
      ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}`
      : "";
    const result = redactInlineTokens(`${base}${querySuffix}`);
    return hasAuth ? result : result;
  } catch {
    // Fallback for malformed URL strings with embedded auth or query params.
    const withoutAuth = trimmed.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/u, "$1");
    const [withoutHash] = withoutAuth.split("#", 1);
    const [beforeQuery, query] = (withoutHash ?? withoutAuth).split("?", 2);
    if (!query) return redactInlineTokens(beforeQuery ?? withoutAuth);
    const redactedPairs = query
      .split("&")
      .filter(Boolean)
      .map((pair) => {
        const eqIdx = pair.indexOf("=");
        const key = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
        return `${key}=<redacted>`;
      });
    return redactInlineTokens(`${beforeQuery}?${redactedPairs.join("&")}`);
  }
}

/**
 * Build a redacted single-line MCP command string from a command and optional args.
 * Strips inline env values, secret flag values, header values, URL credentials/queries,
 * and token-shaped literals.
 */
export function redactMcpCommand(command: string | undefined, args?: readonly string[]): string | undefined {
  const parts: string[] = [];
  const trimmedCommand = command?.trim();
  if (trimmedCommand) {
    parts.push(...tokenizeCommandForRedaction(trimmedCommand));
  }
  if (args && args.length > 0) {
    for (const arg of args) {
      parts.push(arg);
    }
  }
  if (parts.length === 0) return undefined;

  const redacted: string[] = [];
  let redactNextArg = false;

  for (const part of parts) {
    if (redactNextArg) {
      redacted.push("<redacted>");
      redactNextArg = false;
      continue;
    }

    // Inline env assignment: `API_KEY=secret` -> `API_KEY=<redacted>`
    const envMatch = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(part);
    if (envMatch) {
      redacted.push(`${envMatch[1]}=<redacted>`);
      continue;
    }

    // `--flag=value` form where flag is sensitive or header-like.
    const flagEqMatch = /^(--?[A-Za-z0-9_-]+)=(.*)$/su.exec(part);
    if (flagEqMatch) {
      const flagName = flagEqMatch[1]!;
      const flagVal = flagEqMatch[2]!;
      if (SECRET_FLAG_NAMES.has(flagName.toLowerCase()) || SENSITIVE_KEY_RE.test(flagName)) {
        redacted.push(`${flagName}=<redacted>`);
      } else {
        redacted.push(`${flagName}=${redactArgValue(flagVal)}`);
      }
      continue;
    }

    // Separate `--token <value>` or `-H "Authorization: Bearer ..."` form.
    if (SECRET_FLAG_NAMES.has(part.toLowerCase()) || (part.startsWith("--") && SENSITIVE_KEY_RE.test(part))) {
      redacted.push(part);
      redactNextArg = true;
      continue;
    }

    // Header literal such as `Authorization: Bearer ...`
    const headerMatch = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.+)$/su.exec(part);
    if (headerMatch && SENSITIVE_KEY_RE.test(headerMatch[1]!)) {
      redacted.push(`${headerMatch[1]}: <redacted>`);
      continue;
    }

    redacted.push(redactArgValue(part));
  }

  return redacted.join(" ");
}

/**
 * Extract sorted key names only from an env/headers object. Values are never read or returned.
 */
export function extractSecretKeyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>)
    .map((key) => key.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function redactArgValue(value: string): string {
  let out = value.replace(INLINE_URL_RE, (match) => redactMcpUrl(match) ?? "<redacted>");
  out = redactInlineTokens(out);
  return out;
}

function redactInlineTokens(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, "<redacted>");
  }
  return out;
}

function tokenizeCommandForRedaction(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
    } else if (/\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
