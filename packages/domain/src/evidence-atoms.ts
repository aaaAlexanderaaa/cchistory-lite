import type { ConversationAtom } from "./index.js";

export const EVIDENCE_RULE_VERSION = "2026-03-10.1";

export function isUserTurnAtom(atom: ConversationAtom): boolean {
  return (
    atom.actor_kind === "user" &&
    atom.content_kind === "text" &&
    (atom.origin_kind === "user_authored" || atom.origin_kind === "injected_user_shaped")
  );
}

export function isConversationActivityAtom(atom: ConversationAtom): boolean {
  if (atom.display_policy === "hide") {
    return false;
  }
  if (atom.content_kind === "tool_call" || atom.content_kind === "tool_result") {
    return true;
  }
  return atom.content_kind === "text" && (atom.actor_kind === "user" || atom.actor_kind === "assistant");
}

export function findLastConversationActivityAtom(
  atoms: readonly ConversationAtom[],
): ConversationAtom | undefined {
  for (let index = atoms.length - 1; index >= 0; index -= 1) {
    const atom = atoms[index];
    if (atom && isConversationActivityAtom(atom)) {
      return atom;
    }
  }
  return undefined;
}

export function normalizeGitRemote(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }

  let normalized = raw.replace(/\.git$/iu, "").replace(/\/+$/u, "");
  if (/^[^@]+@[^:]+:.+/u.test(normalized)) {
    normalized = normalized.replace(/^([^@]+@[^:]+):/u, "ssh://$1/");
  }

  return normalized;
}
