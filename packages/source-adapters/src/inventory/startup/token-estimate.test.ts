import assert from "node:assert/strict";
import test from "node:test";
import {
  ASCII_CHARS_PER_TOKEN,
  CJK_TOKENS_PER_CHAR_BY_PROFILE,
  estimateTextTokens,
  estimateTokens,
  sliceUtf8Prefix,
} from "./token-estimate.js";

test("estimateTextTokens matches ceil(bytes / 4) on pure ASCII across all profiles", () => {
  const ascii = "Follow the repository invariants and keep zero-store boundaries intact.\n".repeat(12);
  const expected = Math.ceil(Buffer.byteLength(ascii, "utf8") / ASCII_CHARS_PER_TOKEN);
  assert.equal(estimateTokens(Buffer.byteLength(ascii, "utf8")), expected);
  for (const profile of ["default", "claude", "openai", "gemini", "deepseek"] as const) {
    assert.equal(estimateTextTokens(ascii, profile), expected);
  }
});

test("estimateTextTokens differentiates CJK tokenizer ratios instead of underestimating Claude", () => {
  const chinese = "严格遵守只读架构边界".repeat(100); // 1,000 Hanzi = 3,000 UTF-8 bytes
  assert.equal(Buffer.byteLength(chinese, "utf8"), 3_000);
  const naiveBytesOver4 = estimateTokens(3_000); // 750
  assert.equal(naiveBytesOver4, 750);

  const claude = estimateTextTokens(chinese, "claude");
  const openai = estimateTextTokens(chinese, "openai");
  const deepseek = estimateTextTokens(chinese, "deepseek");
  const gemini = estimateTextTokens(chinese, "gemini");

  assert.equal(claude, Math.ceil(1_000 * CJK_TOKENS_PER_CHAR_BY_PROFILE.claude));
  assert.equal(openai, Math.ceil(1_000 * CJK_TOKENS_PER_CHAR_BY_PROFILE.openai));
  assert.equal(deepseek, Math.ceil(1_000 * CJK_TOKENS_PER_CHAR_BY_PROFILE.deepseek));
  assert.equal(gemini, Math.ceil(1_000 * CJK_TOKENS_PER_CHAR_BY_PROFILE.gemini));
  assert.ok(claude > openai && openai > deepseek && deepseek > gemini);
  assert.ok(claude > naiveBytesOver4);
});

test("sliceUtf8Prefix cuts cleanly at multi-byte UTF-8 character boundaries", () => {
  const text = "ab中文cd"; // 1 + 1 + 3 + 3 + 1 + 1 = 10 bytes
  assert.equal(sliceUtf8Prefix(text, 0), "");
  assert.equal(sliceUtf8Prefix(text, 2), "ab");
  assert.equal(sliceUtf8Prefix(text, 4), "ab"); // cannot split 3-byte '中'
  assert.equal(sliceUtf8Prefix(text, 5), "ab中");
  assert.equal(sliceUtf8Prefix(text, 7), "ab中"); // cannot split 3-byte '文'
  assert.equal(sliceUtf8Prefix(text, 8), "ab中文");
  assert.equal(sliceUtf8Prefix(text, 100), text);
});
