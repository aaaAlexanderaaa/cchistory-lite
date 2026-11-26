/**
 * Zero-dependency raw-mode key decoder.
 *
 * Node's `readline` keypress emitter is line-oriented and pulls in interface
 * state the Lite TUI does not want; a full-screen app only needs bytes in and
 * key events out. The decoder is a pure state machine over a byte buffer so
 * keybinding behavior is testable without a TTY.
 */

export interface LiteKey {
  /** Printable text for this key press; empty for pure control keys. */
  input: string;
  name?:
    | "up"
    | "down"
    | "left"
    | "right"
    | "pageup"
    | "pagedown"
    | "home"
    | "end"
    | "return"
    | "tab"
    | "backspace"
    | "delete"
    | "escape";
  ctrl?: boolean;
  shift?: boolean;
}

/** An escape sequence longer than this is treated as noise, not a pending key. */
const MAX_SEQUENCE_LENGTH = 20;

function isCsiParamOrIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

export class KeyDecoder {
  private buffer = "";

  /** Feed raw stdin text and drain every complete key press it contains. */
  push(chunk: string): LiteKey[] {
    this.buffer += chunk;
    const keys: LiteKey[] = [];
    while (this.buffer.length > 0) {
      const next = this.readOne();
      if (!next) break;
      this.buffer = this.buffer.slice(next.consumed);
      if (next.key) keys.push(next.key);
    }
    return keys;
  }

  /**
   * Flush a trailing lone `ESC`.
   *
   * A bare Escape and the start of a cursor sequence are the same first byte,
   * so the decoder holds it until it knows which it is. Callers resolve the
   * ambiguity on an idle tick.
   */
  flushPendingEscape(): LiteKey | undefined {
    if (this.buffer === "\x1b") {
      this.buffer = "";
      return { input: "", name: "escape" };
    }
    // Discard an incomplete escape sequence (such as a stray CSI prefix) on
    // idle timeout so it can never swallow subsequent key presses.
    if (this.buffer.startsWith("\x1b")) {
      this.buffer = "";
    }
    return undefined;
  }

  get pending(): string {
    return this.buffer;
  }

  private readOne(): { consumed: number; key?: LiteKey } | undefined {
    const buffer = this.buffer;
    const first = buffer[0]!;

    if (first === "\x1b") {
      return this.readEscapeSequence(buffer);
    }
    if (first === "\r" || first === "\n") return { consumed: 1, key: { input: "", name: "return" } };
    if (first === "\t") return { consumed: 1, key: { input: "", name: "tab" } };
    if (first === "\x7f" || first === "\b") return { consumed: 1, key: { input: "", name: "backspace" } };

    // Read from the buffer, not from `first`: an astral character's first UTF-16
    // unit is a lone surrogate and would decode to a replacement character.
    const code = buffer.codePointAt(0) ?? 0;
    if (code < 0x20) {
      // Ctrl+<letter>: 0x01 is Ctrl+A, 0x1a is Ctrl+Z.
      const letter = String.fromCharCode(code + 96);
      return { consumed: 1, key: { input: letter, ctrl: true } };
    }

    const character = String.fromCodePoint(code);
    return { consumed: character.length, key: { input: character } };
  }

  private readEscapeSequence(buffer: string): { consumed: number; key?: LiteKey } | undefined {
    if (buffer.length === 1) return undefined; // wait for more bytes

    const second = buffer[1]!;
    // A second ESC is another Escape press, not an Alt-modified character.
    // Emit the first Escape now and leave the second byte pending so it is
    // resolved on its own (flushed as Escape or continued into a sequence).
    // Otherwise a double-tap of Escape merges into one stray { input: "\x1b" }
    // key with no name, which matches no binding and can corrupt a search query.
    if (second === "\x1b") {
      return { consumed: 1, key: { input: "", name: "escape" } };
    }
    if (second === "O") {
      if (buffer.length < 3) return undefined;
      const thirdCode = buffer.charCodeAt(2);
      // An aborted SS3 prefix followed by a control byte (such as Ctrl+C or a
      // fresh ESC) drops the prefix and leaves the control byte intact.
      if (thirdCode < 0x20 || thirdCode > 0x7e) {
        return { consumed: 2 };
      }
      return { consumed: 3, key: decodeSequence(buffer.slice(0, 3)) };
    }
    if (second !== "[") {
      // ESC followed by a printable character: Alt+<key>. Ignore the modifier
      // rather than guessing; the Lite TUI binds no Alt chords.
      return { consumed: 2, key: { input: second } };
    }

    let index = 2;
    while (index < buffer.length) {
      const code = buffer.charCodeAt(index);
      if (isCsiFinal(code)) {
        const sequence = buffer.slice(0, index + 1);
        return { consumed: sequence.length, key: decodeSequence(sequence) };
      }
      if (!isCsiParamOrIntermediate(code)) {
        // Control bytes (such as Ctrl+C or another ESC) terminate a broken CSI
        // sequence immediately instead of being swallowed into the prefix.
        return { consumed: index };
      }
      index += 1;
    }
    if (buffer.length > MAX_SEQUENCE_LENGTH) return { consumed: buffer.length };
    return undefined; // incomplete sequence, wait for more bytes
  }
}

function decodeSequence(sequence: string): LiteKey | undefined {
  const body = sequence.slice(2);
  switch (body) {
    case "A":
      return { input: "", name: "up" };
    case "B":
      return { input: "", name: "down" };
    case "C":
      return { input: "", name: "right" };
    case "D":
      return { input: "", name: "left" };
    case "H":
    case "1~":
    case "7~":
      return { input: "", name: "home" };
    case "F":
    case "4~":
    case "8~":
      return { input: "", name: "end" };
    case "5~":
      return { input: "", name: "pageup" };
    case "6~":
      return { input: "", name: "pagedown" };
    case "3~":
      return { input: "", name: "delete" };
    case "Z":
      return { input: "", name: "tab", shift: true };
    default:
      break;
  }
  // Modified arrows arrive as CSI 1;<mod><letter> (e.g. Shift+Up = `[1;2A`).
  const modified = /^1;(\d+)([A-D])$/u.exec(body);
  if (modified) {
    const letter = modified[2]!;
    const shift = ((Number(modified[1]) - 1) & 1) === 1;
    const name = letter === "A" ? "up" : letter === "B" ? "down" : letter === "C" ? "right" : "left";
    return { input: "", name, shift };
  }
  // SGR mouse wheel sequences (e.g. CSI <64;col;rowM / <65;col;rowM).
  const sgrMouse = /^<(\d+);\d+;\d+[Mm]$/u.exec(body);
  if (sgrMouse) {
    const button = Number(sgrMouse[1]);
    if (button === 64) return { input: "", name: "up" };
    if (button === 65) return { input: "", name: "down" };
  }
  return undefined;
}
