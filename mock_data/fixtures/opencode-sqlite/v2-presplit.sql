-- Sanitized pre-split OpenCode v2 store: the v2 metadata table is still named
-- `session`, empty legacy `message`/`part` tables remain, and session_message
-- has no `seq` column yet (before 2026-06-03).
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  parent_id TEXT,
  directory TEXT,
  title TEXT,
  version TEXT,
  model TEXT,
  time_created INTEGER,
  time_updated INTEGER
);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  type TEXT,
  data TEXT,
  time_created INTEGER,
  time_updated INTEGER
);
CREATE TABLE session_part (
  message_id TEXT,
  session_id TEXT,
  ordinal INTEGER,
  type TEXT,
  call_id TEXT,
  data TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  PRIMARY KEY (message_id, ordinal)
);

INSERT INTO session VALUES ('ses_fixture_presplit', 'global', NULL,
  '/Users/mock_user/workspace/opencode-presplit', 'Pre-split storage review', '1.2.20',
  '{"id":"mock-opencode-presplit","providerID":"mock"}', 1770002000000, 1770002060000);

INSERT INTO session_message VALUES ('msg_presplit_user', 'ses_fixture_presplit', 'user',
  '{"id":"msg_presplit_user","type":"user","text":"Review the pre-split v2 store.","time":{"created":1770002001000}}',
  1770002001000, 1770002001000);
INSERT INTO session_message VALUES ('msg_presplit_assistant', 'ses_fixture_presplit', 'assistant',
  '{"id":"msg_presplit_assistant","type":"assistant","model":{"id":"mock-opencode-presplit","providerID":"mock"},"content":[],"tokens":{"input":90,"output":18,"reasoning":2,"cache":{"read":700,"write":30}},"time":{"created":1770002002000,"completed":1770002003000}}',
  1770002002000, 1770002004000);
INSERT INTO session_part VALUES ('msg_presplit_assistant', 'ses_fixture_presplit', 0, 'text', NULL,
  '{"type":"text","text":"The pre-split store already uses session_message rows."}', 1770002002100, 1770002002100);
INSERT INTO session_part VALUES ('msg_presplit_assistant', 'ses_fixture_presplit', 1, 'tool', 'call_presplit_read',
  '{"type":"tool","id":"call_presplit_read","name":"read","state":{"status":"completed","input":{"path":"src/db.ts"},"content":[{"type":"text","text":"export const schema = ..."}]},"time":{"created":1770002002200}}',
  1770002002200, 1770002002800);
