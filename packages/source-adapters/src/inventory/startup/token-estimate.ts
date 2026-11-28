/**
 * Role: Pure offline token-count estimation for startup instruction and rule files,
 * distinguishing ASCII (~4 chars/token) from CJK and other non-ASCII scripts using
 * per-tokenizer empirical ratios (Claude BPE, OpenAI o200k_base, Gemini SentencePiece,
 * DeepSeek). Excludes file I/O and provider API token counting.
 */

export type TokenEstimatorProfile = "default" | "claude" | "openai" | "gemini" | "deepseek";

/** Baseline ASCII / English bytes-per-token divisor (~4 ASCII chars per token). */
export const ASCII_CHARS_PER_TOKEN = 4;

/**
 * Benchmarked tokens-per-CJK-character ratios across major tokenizer families:
 * - Claude BPE: ~1.2–1.8 tokens/Hanzi (1.3 midpoint for standard prose/rules)
 * - OpenAI o200k_base: ~0.65–1.0 tokens/Hanzi (0.9 midpoint)
 * - Gemini SentencePiece: ~0.5–0.7 tokens/Hanzi (0.65 midpoint)
 * - DeepSeek native CJK vocabulary: ~0.6–0.8 tokens/Hanzi (0.7 midpoint)
 * - Default cross-provider estimate: 0.9 tokens/CJK char
 */
export const CJK_TOKENS_PER_CHAR_BY_PROFILE: Readonly<Record<TokenEstimatorProfile, number>> = {
  default: 0.9,
  claude: 1.3,
  openai: 0.9,
  gemini: 0.65,
  deepseek: 0.7,
};

/** Conservative token estimate per non-ASCII, non-CJK Unicode character (Latin-ext, Cyrillic, emoji). */
export const OTHER_NON_ASCII_TOKENS_PER_CHAR = 0.5;

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0xff00 && codePoint <= 0xffef)
    || (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
  );
}

/** Byte-only fallback when file content is unavailable (ASCII 4 bytes/token heuristic). */
export function estimateTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / ASCII_CHARS_PER_TOKEN);
}

/**
 * Script- and tokenizer-aware offline token estimate over UTF-8 text.
 * Matches `Math.ceil(bytes / 4)` exactly on pure ASCII text while avoiding
 * 30–50% underestimates on CJK rules files under Claude/OpenAI tokenizers.
 */
export function estimateTextTokens(text: string, profile: TokenEstimatorProfile = "default"): number {
  if (!text) return 0;
  const cjkWeight = CJK_TOKENS_PER_CHAR_BY_PROFILE[profile];
  let asciiChars = 0;
  let cjkChars = 0;
  let otherNonAsciiChars = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) asciiChars += 1;
    else if (isCjkCodePoint(cp)) cjkChars += 1;
    else otherNonAsciiChars += 1;
  }
  const total =
    asciiChars / ASCII_CHARS_PER_TOKEN
    + cjkChars * cjkWeight
    + otherNonAsciiChars * OTHER_NON_ASCII_TOKENS_PER_CHAR;
  return Math.ceil(total);
}

/** Slice a string to at most `maxBytes` UTF-8 bytes without splitting a multi-byte sequence. */
export function sliceUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Walk back past UTF-8 continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}
