-- Sanitized Hermes Agent state.db: sessions, live messages, per-model usage.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  model TEXT,
  model_config TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cwd TEXT,
  title TEXT,
  last_activity_at REAL,
  estimated_cost_usd REAL,
  actual_cost_usd REAL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  finish_reason TEXT,
  reasoning TEXT,
  reasoning_content TEXT,
  display_kind TEXT,
  _compressed_summary INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  timestamp REAL NOT NULL
);
CREATE TABLE session_model_usage (
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  billing_provider TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  api_call_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  actual_cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, model, billing_provider, task)
);

INSERT INTO sessions VALUES ('sess_fixture_hermes_main', 'cli', 'mock-hermes-1', NULL, NULL,
  1770000000.0, 1770000060.0, 6, 1, 300, 60, 2500, 100, 40,
  '/Users/mock_user/workspace/hermes-lab', 'Retry review in Hermes', 1770000060.0, 0.02, 0.0);
INSERT INTO sessions VALUES ('sess_fixture_hermes_child', 'cli', 'mock-hermes-1',
  '{"_delegate_from":"sess_fixture_hermes_main"}', 'sess_fixture_hermes_main',
  1770000100.0, 1770000120.0, 2, 0, 60, 12, 300, 0, 5,
  '/Users/mock_user/workspace/hermes-lab', 'Delegated log audit', 1770000120.0, 0.0, 0.0);
INSERT INTO sessions VALUES ('sess_fixture_hermes_reset', 'cli', 'mock-hermes-2',
  '{"_reset_from":"sess_fixture_hermes_main"}', 'sess_fixture_hermes_main',
  1770000200.0, 1770000220.0, 2, 0, 80, 16, 400, 0, 8,
  '/Users/mock_user/workspace/hermes-lab', 'Hermes compression continuation', 1770000220.0, 0.0, 0.0);

INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('sess_fixture_hermes_main', 'user', 'Find the retry helper and explain the backoff.', 1770000001.5);
INSERT INTO messages (session_id, role, content, tool_calls, finish_reason, reasoning, timestamp) VALUES
  ('sess_fixture_hermes_main', 'assistant', 'I will inspect the retry module.',
   '[{"id":"call_h1","type":"function","function":{"name":"read","arguments":"{\"path\":\"src/retry.ts\"}"}}]',
   'tool_calls', 'The prompt names a retry helper.', 1770000002.0);
INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES
  ('sess_fixture_hermes_main', 'tool',
   'export function backoff(n) { return Math.min(30000, 500 * 2 ** n); }',
   'call_h1', 'read', 1770000002.5);
INSERT INTO messages (session_id, role, content, reasoning, timestamp) VALUES
  ('sess_fixture_hermes_main', 'assistant', 'The backoff doubles from 500 ms and caps at 30 s.',
   'Read the function.', 1770000003.0);
INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('sess_fixture_hermes_main', 'user',
   char(0) || 'json:[{"type":"text","text":"Now compare providers."},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]',
   1770000004.0);
INSERT INTO messages (session_id, role, content, finish_reason, timestamp) VALUES
  ('sess_fixture_hermes_main', 'assistant', 'Provider A and B both record usage per session.', 'stop', 1770000005.0);
INSERT INTO messages (session_id, role, content, display_kind, timestamp) VALUES
  ('sess_fixture_hermes_main', 'assistant', 'hidden audit note', 'hidden', 1770000005.5);
INSERT INTO messages (session_id, role, content, active, timestamp) VALUES
  ('sess_fixture_hermes_main', 'user', 'rewound prompt', 0, 1770000005.8);
INSERT INTO messages (session_id, role, content, _compressed_summary, display_kind, timestamp) VALUES
  ('sess_fixture_hermes_main', 'user',
   '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier discussion of the retry helper.', 1, 'hidden', 1770000000.5);
INSERT INTO messages (session_id, role, content, _compressed_summary, timestamp) VALUES
  ('sess_fixture_hermes_main', 'user',
   'Please fix the flaky retry test.
[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]
[CONTEXT COMPACTION — REFERENCE ONLY] Older summary of the retry work.', 1, 1770000007.0);
INSERT INTO messages (session_id, role, content, display_kind, timestamp) VALUES
  ('sess_fixture_hermes_main', 'user', 'Delegated audit finished.', 'async_delegation_complete', 1770000007.5);
INSERT INTO messages (session_id, role, content, display_kind, timestamp) VALUES
  ('sess_fixture_hermes_main', 'assistant', 'Turn failed: provider timeout.', 'failed_turn', 1770000005.6);
INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('sess_fixture_hermes_main', 'system', 'You are a helpful coding agent.', 1770000000.2);
INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('sess_fixture_hermes_main', 'user', '[PRIOR CONTEXT — for reference only] old handoff body', 1770000006.5);

INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('sess_fixture_hermes_child', 'user', 'Audit the delegated log output.', 1770000101.0);
INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('sess_fixture_hermes_child', 'assistant', 'The log line reports a timeout.', 1770000102.0);

INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('sess_fixture_hermes_reset', 'user', 'Continue after compression.', 1770000201.0);
INSERT INTO messages (session_id, role, content, timestamp) VALUES
  ('sess_fixture_hermes_reset', 'assistant', 'Continuing with the compacted context.', 1770000202.0);

INSERT INTO session_model_usage VALUES ('sess_fixture_hermes_main', 'mock-hermes-1', 'mock', '', 3, 250, 50, 2000, 80, 30, 0.02, 0.0);
INSERT INTO session_model_usage VALUES ('sess_fixture_hermes_main', 'mock-hermes-mini', 'mock', 'title', 1, 50, 10, 500, 20, 10, 0.0, 0.0);
INSERT INTO session_model_usage VALUES ('sess_fixture_hermes_child', 'mock-hermes-1', 'mock', '', 1, 60, 12, 300, 0, 5, 0.0, 0.0);
INSERT INTO session_model_usage VALUES ('sess_fixture_hermes_reset', 'mock-hermes-2', 'mock', '', 1, 80, 16, 400, 0, 8, 0.0, 0.0);
