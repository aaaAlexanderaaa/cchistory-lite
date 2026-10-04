import { AmbiguousReferenceError, SessionReferenceNotFoundError, type LiteContextTarget, type LiveHistorySnapshot, type ScanLiteHistoryOptions } from "./index.js";

type Scan = (overrides?: Partial<ScanLiteHistoryOptions>) => Promise<LiveHistorySnapshot>;
interface DetailEntry { snapshot: LiveHistorySnapshot; complete: boolean; bytes: number }

/** Process-owned snapshots only. Explicit refresh is the freshness boundary. */
export class LiveHistoryReader {
  private snapshot?: LiveHistorySnapshot;
  private details: DetailEntry[] = [];
  private conversation = false;
  constructor(private readonly scan: Scan, private readonly cacheBytes = 16 * 1024 * 1024, private readonly cacheEntries = 4) {}

  async collection(conversation = false): Promise<LiveHistorySnapshot> {
    if (this.snapshot && (!conversation || this.snapshot.data.conversation_evidence !== undefined)) return this.snapshot;
    const next = await this.scan({ contextMode: "none", retainConversationEvidence: conversation || this.conversation });
    this.snapshot = next;
    this.details = [];
    this.conversation ||= conversation;
    return next;
  }

  async refresh(): Promise<LiveHistorySnapshot> {
    const next = await this.scan({ contextMode: "none", retainConversationEvidence: this.conversation });
    this.snapshot = next;
    this.details = [];
    return next;
  }

  async detail(targets: readonly LiteContextTarget[], options: { complete?: boolean; conversation?: boolean; evidenceOnly?: boolean } = {}): Promise<LiveHistorySnapshot> {
    const matching = () => this.scan({ contextMode: "matching", contextTargets: targets,
      retainConversationEvidence: options.conversation || options.evidenceOnly });
    let resolvedTargets = targets;
    if (this.snapshot) {
      try {
        resolvedTargets = targets.map(target => ({ ...target, ref: (target.kind === "session"
          ? this.snapshot!.getSession(target.ref) : this.snapshot!.getTurn(target.ref))?.id ?? target.ref }));
      } catch (error) {
        // Preserve operation-level ambiguity and all candidates, including in mixed batches.
        if (error instanceof AmbiguousReferenceError) return matching();
        throw error;
      }
    }
    const covers = (snapshot: LiveHistorySnapshot): boolean => resolvedTargets.every(target => {
      // A partial detail cache cannot prove that an alias or prefix is unique globally.
      if (target.kind === "session" ? !snapshot.data.sessions.some(session => session.id === target.ref)
        : !snapshot.data.turns.some(turn => turn.id === target.ref)) return false;
      const session = target.kind === "session" ? snapshot.getSession(target.ref) : undefined;
      const turn = target.kind === "turn" ? snapshot.getTurn(target.ref) : undefined;
      if (!(session || turn)) return false;
      if (options.evidenceOnly) return snapshot.data.conversation_evidence !== undefined;
      return (session ? snapshot.listSessionTurns(session.id) : [turn!]).every(t => snapshot.getTurnContext(t.id) !== undefined);
    });
    if (this.snapshot && (!options.conversation || this.snapshot.data.conversation_evidence !== undefined) && covers(this.snapshot)) return this.snapshot;
    const index = this.details.findIndex(entry => (!options.complete || entry.complete)
      && (!options.conversation || entry.snapshot.data.conversation_evidence !== undefined) && covers(entry.snapshot));
    if (index !== -1) {
      const [entry] = this.details.splice(index, 1);
      this.details.push(entry!);
      return entry!.snapshot;
    }
    const refs = resolvedTargets.map(target => {
      if (target.kind === "session" && /^sess:[^:]+:.+$/u.test(target.ref)) return target.ref;
      return target.kind === "session" ? this.snapshot?.getSession(target.ref)?.id : this.snapshot?.getTurn(target.ref)?.session_id;
    });
    const targeted = !options.complete && refs.every((ref): ref is string => ref !== undefined);
    let next: LiveHistorySnapshot;
    try {
      next = targeted ? await this.scan({ contextMode: "full", sessionRefs: [...new Set(refs)],
        retainConversationEvidence: options.conversation || options.evidenceOnly, scanGuard: { profile: "full", bypass: true } })
        : await matching();
    } catch (error) {
      // Let query execution report unresolved references per operation, preserving valid results.
      if (targeted && (error instanceof AmbiguousReferenceError || error instanceof SessionReferenceNotFoundError)) return matching();
      throw error;
    }
    const bytes = retainedSize(next.data, this.cacheBytes);
    if (bytes <= this.cacheBytes && this.cacheEntries > 0) {
      while (this.details.length && (this.details.length >= this.cacheEntries || this.details.reduce((n, e) => n + e.bytes, bytes) > this.cacheBytes)) this.details.shift();
      this.details.push({ snapshot: next, complete: !targeted, bytes });
    }
    return next;
  }

  close(): void { this.snapshot = undefined; this.details = []; this.conversation = false; }
}

/** Conservative retained-data accounting, not a claim to bound process RSS. Stops before serializing large bodies. */
function retainedSize(value: unknown, maximum: number): number {
  const seen = new Set<object>();
  let bytes = 0;
  const visit = (entry: unknown): void => {
    if (bytes > maximum) return;
    if (typeof entry === "string") { bytes += 2 * entry.length + 32; return; }
    if (!entry || typeof entry !== "object") { bytes += 16; return; }
    if (seen.has(entry)) return;
    seen.add(entry); bytes += 64;
    if (Array.isArray(entry)) { for (const child of entry) { visit(child); if (bytes > maximum) break; } }
    else for (const key in entry) { bytes += 2 * key.length + 32; visit((entry as Record<string, unknown>)[key]); if (bytes > maximum) break; }
  };
  visit(value);
  return bytes;
}
