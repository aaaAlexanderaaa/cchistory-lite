/**
 * Role: Focused, zero-dependency, read-only TOML parser for local agent configuration
 * files (Codex, Grok CLI, DeepSeek Harness). Supports tables, quoted keys, array of
 * tables, inline tables, strings, arrays, numbers, booleans, and comments.
 * Excludes TOML serialization, file I/O, and agent-specific schema interpretation.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`TOML line ${line}: ${message}`);
    this.name = "TomlParseError";
    this.line = line;
  }
}

export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const lines = source.replace(/\r\n/gu, "\n").split("\n");

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const lineNo = lineIndex + 1;
    const rawLine = lines[lineIndex]!;
    const stripped = stripLineComment(rawLine).trim();
    lineIndex += 1;
    if (!stripped) continue;

    if (stripped.startsWith("[[")) {
      if (!stripped.endsWith("]]")) {
        throw new TomlParseError("unterminated array-of-tables header", lineNo);
      }
      const pathSegments = parseKeyPath(stripped.slice(2, -2).trim(), lineNo);
      current = ensureArrayTable(root, pathSegments, lineNo);
      continue;
    }

    if (stripped.startsWith("[")) {
      if (!stripped.endsWith("]")) {
        throw new TomlParseError("unterminated table header", lineNo);
      }
      const pathSegments = parseKeyPath(stripped.slice(1, -1).trim(), lineNo);
      current = ensureTable(root, pathSegments, lineNo);
      continue;
    }

    const eqIndex = findKeyValueSeparator(stripped);
    if (eqIndex <= 0) {
      throw new TomlParseError(`expected key = value, received ${JSON.stringify(stripped.slice(0, 40))}`, lineNo);
    }

    const keyPart = stripped.slice(0, eqIndex).trim();
    let valuePart = stripped.slice(eqIndex + 1).trim();

    // Support multiline strings (""" or ''') and multiline arrays/inline tables.
    while (needsContinuation(valuePart) && lineIndex < lines.length) {
      const nextRaw = lines[lineIndex]!;
      lineIndex += 1;
      const inMultilineStr = isInsideMultilineString(valuePart);
      valuePart += "\n" + (inMultilineStr ? nextRaw : stripLineComment(nextRaw));
    }

    const keySegments = parseKeyPath(keyPart, lineNo);
    const parsedValue = parseValue(valuePart.trim(), lineNo);
    assignNestedValue(current, keySegments, parsedValue, lineNo);
  }

  return root;
}

function stripLineComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inBasic) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inBasic = false;
      }
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === "\"") inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function findKeyValueSeparator(line: string): number {
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inBasic) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === "\"") inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === "=") return i;
  }
  return -1;
}

function isInsideMultilineString(value: string): boolean {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("\"\"\"")) {
    return countTripleQuotes(trimmed.slice(3), "\"\"\"") % 2 === 0;
  }
  if (trimmed.startsWith("'''")) {
    return countTripleQuotes(trimmed.slice(3), "'''") % 2 === 0;
  }
  return false;
}

function countTripleQuotes(text: string, token: "\"\"\"" | "'''"): number {
  let count = 0;
  for (let i = 0; i <= text.length - 3; i += 1) {
    if (token === "\"\"\"" && i > 0 && text[i - 1] === "\\") continue;
    if (text.slice(i, i + 3) === token) {
      count += 1;
      i += 2;
    }
  }
  return count;
}

function needsContinuation(value: string): boolean {
  if (isInsideMultilineString(value)) return true;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (inBasic) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === "\"") inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth -= 1;
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth -= 1;
  }
  return bracketDepth > 0 || braceDepth > 0;
}

function parseKeyPath(raw: string, lineNo: number): string[] {
  const segments: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/u.test(raw[i]!)) i += 1;
    if (i >= raw.length) break;
    const ch = raw[i]!;
    if (ch === "\"") {
      const { value, next } = readBasicString(raw, i, lineNo);
      segments.push(value);
      i = next;
    } else if (ch === "'") {
      const { value, next } = readLiteralString(raw, i, lineNo);
      segments.push(value);
      i = next;
    } else {
      let start = i;
      while (i < raw.length && raw[i] !== "." && !/\s/u.test(raw[i]!)) i += 1;
      const key = raw.slice(start, i);
      if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
        throw new TomlParseError(`invalid bare key ${JSON.stringify(key)}`, lineNo);
      }
      segments.push(key);
    }
    while (i < raw.length && /\s/u.test(raw[i]!)) i += 1;
    if (i < raw.length) {
      if (raw[i] !== ".") {
        throw new TomlParseError(`expected '.' in key path near ${JSON.stringify(raw.slice(i, i + 12))}`, lineNo);
      }
      i += 1;
    }
  }
  if (segments.length === 0) {
    throw new TomlParseError("empty key path", lineNo);
  }
  return segments;
}

function parseValue(raw: string, lineNo: number): TomlValue {
  if (!raw) throw new TomlParseError("missing value", lineNo);
  if (raw.startsWith("\"\"\"")) {
    if (!raw.endsWith("\"\"\"") || raw.length < 6) {
      throw new TomlParseError("unterminated multiline basic string", lineNo);
    }
    const inner = raw.slice(3, -3).replace(/^\n/u, "");
    return unescapeBasicString(inner, lineNo);
  }
  if (raw.startsWith("'''")) {
    if (!raw.endsWith("'''") || raw.length < 6) {
      throw new TomlParseError("unterminated multiline literal string", lineNo);
    }
    return raw.slice(3, -3).replace(/^\n/u, "");
  }
  if (raw.startsWith("\"")) {
    const { value, next } = readBasicString(raw, 0, lineNo);
    if (raw.slice(next).trim() !== "") throw new TomlParseError("trailing characters after string", lineNo);
    return value;
  }
  if (raw.startsWith("'")) {
    const { value, next } = readLiteralString(raw, 0, lineNo);
    if (raw.slice(next).trim() !== "") throw new TomlParseError("trailing characters after literal string", lineNo);
    return value;
  }
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw new TomlParseError("unterminated array", lineNo);
    return parseArray(raw.slice(1, -1), lineNo);
  }
  if (raw.startsWith("{")) {
    if (!raw.endsWith("}")) throw new TomlParseError("unterminated inline table", lineNo);
    return parseInlineTable(raw.slice(1, -1), lineNo);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)$/u.test(raw)) {
    const cleaned = raw.replace(/_/gu, "");
    const num = Number(cleaned);
    if (Number.isFinite(num)) return num;
  }
  // Preserve ISO-like TOML dates/times as strings so config files with dates do not fail parsing.
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/u.test(raw)) {
    return raw;
  }
  throw new TomlParseError(`unsupported value ${JSON.stringify(raw.slice(0, 40))}`, lineNo);
}

function parseArray(inner: string, lineNo: number): TomlValue[] {
  const parts = splitTopLevel(inner, ",");
  const out: TomlValue[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    out.push(parseValue(trimmed, lineNo));
  }
  return out;
}

function parseInlineTable(inner: string, lineNo: number): TomlTable {
  const table: TomlTable = {};
  const parts = splitTopLevel(inner, ",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = findKeyValueSeparator(trimmed);
    if (eqIndex <= 0) {
      throw new TomlParseError(`invalid inline table entry ${JSON.stringify(trimmed.slice(0, 40))}`, lineNo);
    }
    const keySegments = parseKeyPath(trimmed.slice(0, eqIndex).trim(), lineNo);
    const val = parseValue(trimmed.slice(eqIndex + 1).trim(), lineNo);
    assignNestedValue(table, keySegments, val, lineNo);
  }
  return table;
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const result: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inBasic) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === "\"") inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth -= 1;
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth -= 1;
    else if (ch === delimiter && bracketDepth === 0 && braceDepth === 0) {
      result.push(input.slice(start, i));
      start = i + 1;
    }
  }
  result.push(input.slice(start));
  return result;
}

function readBasicString(raw: string, startIndex: number, lineNo: number): { value: string; next: number } {
  let i = startIndex + 1;
  let escaped = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "\"") {
      return { value: unescapeBasicString(raw.slice(startIndex + 1, i), lineNo), next: i + 1 };
    }
    i += 1;
  }
  throw new TomlParseError("unterminated basic string", lineNo);
}

function readLiteralString(raw: string, startIndex: number, lineNo: number): { value: string; next: number } {
  const end = raw.indexOf("'", startIndex + 1);
  if (end === -1) throw new TomlParseError("unterminated literal string", lineNo);
  return { value: raw.slice(startIndex + 1, end), next: end + 1 };
}

function unescapeBasicString(text: string, lineNo: number): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) throw new TomlParseError("trailing backslash in string", lineNo);
    i += 1;
    switch (next) {
      case "b": out += "\b"; break;
      case "t": out += "\t"; break;
      case "n": out += "\n"; break;
      case "f": out += "\f"; break;
      case "r": out += "\r"; break;
      case "\"": out += "\""; break;
      case "\\": out += "\\"; break;
      case "u": {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new TomlParseError("invalid \\u escape", lineNo);
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      case "U": {
        const hex = text.slice(i + 1, i + 9);
        if (!/^[0-9a-fA-F]{8}$/u.test(hex)) throw new TomlParseError("invalid \\U escape", lineNo);
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 8;
        break;
      }
      default:
        out += next;
        break;
    }
  }
  return out;
}

function ensureTable(root: TomlTable, segments: readonly string[], lineNo: number): TomlTable {
  let cursor: TomlTable = root;
  for (const segment of segments) {
    const existing = cursor[segment];
    if (existing === undefined) {
      const next: TomlTable = {};
      cursor[segment] = next;
      cursor = next;
    } else if (Array.isArray(existing)) {
      const tail = existing.at(-1);
      if (!tail || typeof tail !== "object" || Array.isArray(tail)) {
        throw new TomlParseError(`cannot traverse array at ${JSON.stringify(segment)}`, lineNo);
      }
      cursor = tail;
    } else if (typeof existing === "object") {
      cursor = existing;
    } else {
      throw new TomlParseError(`key ${JSON.stringify(segment)} is already a scalar value`, lineNo);
    }
  }
  return cursor;
}

function ensureArrayTable(root: TomlTable, segments: readonly string[], lineNo: number): TomlTable {
  const parent = segments.length > 1 ? ensureTable(root, segments.slice(0, -1), lineNo) : root;
  const leaf = segments.at(-1)!;
  const existing = parent[leaf];
  const next: TomlTable = {};
  if (existing === undefined) {
    parent[leaf] = [next];
    return next;
  }
  if (!Array.isArray(existing)) {
    throw new TomlParseError(`cannot append array table to non-array ${JSON.stringify(leaf)}`, lineNo);
  }
  existing.push(next);
  return next;
}

function assignNestedValue(target: TomlTable, segments: readonly string[], value: TomlValue, lineNo: number): void {
  const parent = segments.length > 1 ? ensureTable(target, segments.slice(0, -1), lineNo) : target;
  parent[segments.at(-1)!] = value;
}
