-- Sanitized current OpenCode store: session_v2/session_message/session_part tables.
CREATE TABLE session_v2 (
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
CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  type TEXT,
  seq INTEGER,
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

INSERT INTO session_v2 VALUES ('ses_fixture_v2_main', 'global', NULL,
  '/Users/mock_user/workspace/opencode-v2', 'Compare storage generations', '1.3.0',
  '{"id":"mock-opencode-v2","providerID":"mock"}', 1770001000000, 1770001060000);

INSERT INTO session_message VALUES ('msg_v2_user', 'ses_fixture_v2_main', 'user', 0,
  '{"id":"msg_v2_user","type":"user","text":"Compare the two OpenCode storage generations.","files":[],"agents":[],"skills":[],"time":{"created":1770001001000}}',
  1770001001000, 1770001001000);

INSERT INTO session_message VALUES ('msg_v2_assistant', 'ses_fixture_v2_main', 'assistant', 1,
  '{"id":"msg_v2_assistant","type":"assistant","agent":"builder","model":{"id":"mock-opencode-v2","providerID":"mock"},"content":[],"tokens":{"input":150,"output":30,"reasoning":8,"cache":{"read":1500,"write":80}},"time":{"created":1770001002000,"completed":1770001003500}}',
  1770001002000, 1770001005000);
INSERT INTO session_part VALUES ('msg_v2_assistant', 'ses_fixture_v2_main', 0, 'text', NULL,
  '{"type":"text","text":"The v2 store keeps parts in session_part rows."}', 1770001002100, 1770001002100);
INSERT INTO session_part VALUES ('msg_v2_assistant', 'ses_fixture_v2_main', 1, 'reasoning', NULL,
  '{"type":"reasoning","text":"Compare table names and part ownership."}', 1770001002200, 1770001002200);
INSERT INTO session_part VALUES ('msg_v2_assistant', 'ses_fixture_v2_main', 2, 'tool', 'call_v2_read',
  '{"type":"tool","id":"call_v2_read","name":"read","state":{"status":"completed","input":{"path":"src/storage.ts"},"content":[{"type":"text","text":"export const SessionTable = ..."}]},"time":{"created":1770001002300,"completed":1770001003300}}',
  1770001002300, 1770001003300);

INSERT INTO session_message VALUES ('msg_v2_tool_error', 'ses_fixture_v2_main', 'assistant', 2,
  '{"id":"msg_v2_tool_error","type":"assistant","model":{"id":"mock-opencode-v2","providerID":"mock"},"content":[],"time":{"created":1770001004000}}',
  1770001004000, 1770001005000);
INSERT INTO session_part VALUES ('msg_v2_tool_error', 'ses_fixture_v2_main', 0, 'tool', 'call_v2_bash',
  '{"type":"tool","id":"call_v2_bash","name":"bash","state":{"status":"error","input":{"command":"rg SESSION_ROW src"},"error":{"message":"ripgrep exited with status 2"}},"time":{"created":1770001004100}}',
  1770001004100, 1770001004900);

INSERT INTO session_message VALUES ('msg_v2_system', 'ses_fixture_v2_main', 'system', 3,
  '{"id":"msg_v2_system","type":"system","text":"Compact rules apply."}', 1770001006000, 1770001006000);
INSERT INTO session_message VALUES ('msg_v2_shell', 'ses_fixture_v2_main', 'shell', 4,
  '{"id":"msg_v2_shell","type":"shell","command":"npm test","status":"completed","exit":0,"output":[{"type":"text","text":"ok"}]}', 1770001007000, 1770001008000);
INSERT INTO session_message VALUES ('msg_v2_compaction', 'ses_fixture_v2_main', 'compaction', 5,
  '{"id":"msg_v2_compaction","type":"compaction","status":"completed","reason":"auto","summary":[{"type":"text","text":"Compacted summary text."}],"tokens":{"input":7,"output":3,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1770001009000,"completed":1770001010000}}',
  1770001009000, 1770001010000);
