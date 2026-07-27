/**
 * Display-width-aware text utilities for the Lite TUI.
 *
 * Every measurement is in terminal columns, not JavaScript string length, so
 * CJK text and ANSI-styled strings align in the same grid as the Full TUI.
 */

import { stripAnsi } from "./colors.js";

/** East Asian Wide / Fullwidth ranges that occupy two terminal columns. */
export function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0x33bf) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

/** Terminal columns occupied by `value`, ignoring ANSI styling. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const character of stripAnsi(value)) {
    width += isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

/** Clip a possibly styled line to `maxColumns`, preserving ANSI sequences. */
export function clipLine(line: string, maxColumns: number): string {
  if (maxColumns <= 0) return "";
  if (displayWidth(line) <= maxColumns) return line;

  let column = 0;
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\x1b" && line[index + 1] === "[") {
      const end = line.indexOf("m", index);
      if (end !== -1) {
        result += line.slice(index, end + 1);
        index = end + 1;
        continue;
      }
    }
    const character = line[index]!;
    const characterWidth = isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (column + characterWidth > maxColumns - 1) {
      result += "…";
      break;
    }
    result += character;
    column += characterWidth;
    index += 1;
  }
  // Only re-arm the reset when styling actually survived the clip, so
  // color-disabled output stays free of escape bytes.
  return result.includes("\x1b[") ? `${result}\x1b[0m` : result;
}

/** Right-pad a line to exactly `targetColumns` display width. */
export function padLine(line: string, targetColumns: number): string {
  const width = displayWidth(line);
  if (width >= targetColumns) return line;
  return line + " ".repeat(targetColumns - width);
}

/** Collapse whitespace and truncate to `maxColumns` terminal columns. */
export function compact(value: string, maxColumns: number): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (displayWidth(cleaned) <= maxColumns) return cleaned;
  if (maxColumns <= 1) return "…";
  let width = 0;
  let index = 0;
  for (const character of cleaned) {
    const characterWidth = isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + characterWidth + 1 > maxColumns) break;
    width += characterWidth;
    index += character.length;
  }
  return `${cleaned.slice(0, index)}…`;
}

/**
 * Strip agent-injected command markup for single-line browse rows.
 *
 * This is display taming only. The canonical text is never mutated, so the
 * evidence model keeps the captured content intact.
 */
export function tameBrowseMarkup(value: string): string {
  return stripInjectedMarkup(value).replace(/\s+/gu, " ").trim();
}

/** Same taming as {@link tameBrowseMarkup} but preserving paragraph breaks. */
export function tameDetailMarkup(value: string): string {
  return stripInjectedMarkup(value)
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function stripInjectedMarkup(value: string): string {
  return value
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/giu, " ")
    .replace(/<command-message>[\s\S]*?<\/command-message>/giu, " ")
    .replace(/<command-args>[\s\S]*?<\/command-args>/giu, " ")
    .replace(/<command-name>([\s\S]*?)<\/command-name>/giu, "$1 ")
    .replace(/<\/?(?:command-name|command-message|command-args)>/giu, " ");
}

/** Word-wrap `text` to `width` columns, keeping explicit newlines. */
export function wrapText(text: string, width: number): string[] {
  if (text.trim().length === 0) return [];
  const target = Math.max(1, width);
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    const cleaned = paragraph.replace(/[^\S\n]+/gu, " ").trim();
    if (cleaned.length === 0) {
      result.push("");
      continue;
    }
    if (displayWidth(cleaned) <= target) {
      result.push(cleaned);
      continue;
    }
    wrapParagraph(cleaned, target, result);
  }
  return result;
}

/** Greedy word wrap; words wider than the line are hard-broken by column. */
function wrapParagraph(text: string, width: number, out: string[]): void {
  let line = "";
  let lineWidth = 0;

  const flush = () => {
    if (line.length > 0) out.push(line);
    line = "";
    lineWidth = 0;
  };

  for (const word of text.split(" ")) {
    const wordWidth = displayWidth(word);
    if (wordWidth > width) {
      flush();
      let rest = word;
      while (displayWidth(rest) > width) {
        const chunk = takeColumns(rest, width);
        if (chunk.length === 0) break;
        out.push(chunk);
        rest = rest.slice(chunk.length);
      }
      line = rest;
      lineWidth = displayWidth(rest);
      continue;
    }
    const cost = lineWidth === 0 ? wordWidth : wordWidth + 1;
    if (lineWidth + cost > width) {
      flush();
      line = word;
      lineWidth = wordWidth;
      continue;
    }
    line = lineWidth === 0 ? word : `${line} ${word}`;
    lineWidth += cost;
  }
  flush();
}

/** The longest prefix of `value` that fits in `maxColumns` terminal columns. */
function takeColumns(value: string, maxColumns: number): string {
  let width = 0;
  let index = 0;
  for (const character of value) {
    const characterWidth = isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + characterWidth > maxColumns) break;
    width += characterWidth;
    index += character.length;
  }
  return value.slice(0, index);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Mar 14 09:26:05` — the Full TUI's row timestamp format. */
export function formatShortDate(isoDate: string | undefined): string {
  const date = parseDate(isoDate);
  if (!date) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${hours}:${minutes}:${seconds}`;
}

/** `3d ago` — compact age label for headers and status lines. */
export function formatRelativeTime(isoDate: string | undefined, now: number): string {
  const date = parseDate(isoDate);
  if (!date) return "";
  const deltaSeconds = Math.round((now - date.getTime()) / 1000);
  if (!Number.isFinite(deltaSeconds)) return "";
  if (deltaSeconds < 0) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function parseDate(isoDate: string | undefined): Date | undefined {
  if (!isoDate) return undefined;
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `1.2M` / `43K` / `912` — compact token counts for dense rows. */
export function formatCompactCount(count: number | undefined): string {
  if (!count) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/** Collapse to one line and truncate by character count (non-TUI output). */
export function singleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
