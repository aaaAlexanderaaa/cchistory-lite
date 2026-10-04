/** Masked conversation text only; never raw/tool/system bodies. */
export interface ConversationEvidence {
  message_id: string;
  session_id: string;
  /** Null for an assistant message with no canonical user turn (for example delegated work). */
  turn_id: string | null;
  role: "user" | "assistant";
  created_at: string;
  text: string;
}

export interface EvidenceReadOptions {
  max_chars?: number;
  limit?: number;
  cursor?: string;
}

export interface ReadStatus {
  status: "no_known_gaps" | "partial" | "unverified";
  reasons: string[];
  source_error_count: number;
  loss_warning_count: number;
  unknown_directory_sessions: number;
  projection_issue_count: number;
}
