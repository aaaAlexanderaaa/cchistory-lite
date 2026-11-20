/**
 * Role: Zero-dependency terminal clipboard helper (OSC 52 sequence + best-effort native
 * OS clipboard command fallback) for copying resume commands and Q&A text from the Lite TUI.
 * Excludes TUI state and rendering (owned by state.ts and render.ts).
 */

import { spawn } from "node:child_process";
import process from "node:process";

export interface ClipboardCopyResult {
  ok: boolean;
  via: "system+osc52" | "osc52" | "system" | "none";
}

export interface ClipboardCopyOptions {
  writeOsc52?: (sequence: string) => void;
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: readonly string[], input: string) => Promise<boolean>;
}

/** Build an OSC 52 clipboard escape sequence supported by modern local and SSH terminals. */
export function buildOsc52Sequence(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `\x1b]52;c;${encoded}\x07`;
}

function candidateClipboardCommands(platform: NodeJS.Platform): Array<{ cmd: string; args: string[] }> {
  if (platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (platform === "win32") return [{ cmd: "clip", args: [] }];
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function defaultRunClipboardCommand(command: string, args: readonly string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child;
    try {
      child = spawn(command, [...args], { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 1500);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    try {
      child.stdin?.end(text, "utf8");
    } catch {
      finish(false);
    }
  });
}

export async function copyTextToClipboard(
  text: string,
  options: ClipboardCopyOptions = {},
): Promise<ClipboardCopyResult> {
  let osc52Sent = false;
  if (options.writeOsc52) {
    try {
      options.writeOsc52(buildOsc52Sequence(text));
      osc52Sent = true;
    } catch {
      osc52Sent = false;
    }
  }

  const run = options.runCommand ?? defaultRunClipboardCommand;
  const platform = options.platform ?? process.platform;
  let systemOk = false;
  for (const candidate of candidateClipboardCommands(platform)) {
    if (await run(candidate.cmd, candidate.args, text)) {
      systemOk = true;
      break;
    }
  }

  if (systemOk && osc52Sent) return { ok: true, via: "system+osc52" };
  if (systemOk) return { ok: true, via: "system" };
  if (osc52Sent) return { ok: true, via: "osc52" };
  return { ok: false, via: "none" };
}
