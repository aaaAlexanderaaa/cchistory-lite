import type {
  AtomEdge, CapturedBlob, ConversationAtom, DerivedCandidate, RawRecord,
  SessionProjection, SourceFragment, SourcePlatform, TurnContextProjection, UserTurnProjection,
} from "./index.js";

/** Source metadata after native fragments have been reconciled. No snapshot or I/O owner. */
export interface ParsedSessionMetadata {
  id: string;
  source_session_id?: string;
  source_id: string;
  source_platform: SourcePlatform;
  host_id: string;
  title?: string;
  canonical_title?: string;
  created_at?: string;
  updated_at?: string;
  model?: string;
  working_directory?: string;
  source_native_project_ref?: string;
  resume_command?: string;
  resume_working_directory?: string;
  resume_command_confidence?: number;
  delegated_parent_session_id?: string;
  delegated_history_start_ordinal?: number;
  delegated_agent_key?: string;
}

export interface GitProjectEvidence {
  repoRoot?: string;
  repoRemote?: string;
  repoFingerprint?: string;
}

export interface TokenUsageMetrics {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  model?: string;
}

export type AssistantStopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

/** Borrowed evidence for one reconciled session. Interpreters must not mutate it. */
export interface ParsedSessionEvidence {
  readonly draft: Readonly<ParsedSessionMetadata>;
  readonly blobs: readonly CapturedBlob[];
  readonly records: readonly RawRecord[];
  readonly fragments: readonly SourceFragment[];
  readonly atoms: readonly ConversationAtom[];
  readonly edges: readonly AtomEdge[];
  readonly gitProjectEvidence?: Readonly<GitProjectEvidence>;
}

/** Complete interpretation for the current eager path; absence of a session is explicit. */
export interface SessionInterpretation {
  session?: SessionProjection;
  candidates: DerivedCandidate[];
  turns: UserTurnProjection[];
  contexts: TurnContextProjection[];
  edges: AtomEdge[];
}

export type InterpretParsedSession = (evidence: ParsedSessionEvidence) => SessionInterpretation;
