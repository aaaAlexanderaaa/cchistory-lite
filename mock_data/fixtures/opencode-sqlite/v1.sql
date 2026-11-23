-- Sanitized OpenCode 1.2-era SQLite store: session/message/part tables.
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  parent_id TEXT,
  slug TEXT,
  directory TEXT,
  title TEXT,
  version TEXT,
  time_created INTEGER,
  time_updated INTEGER
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  data TEXT
);
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  session_id TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  data TEXT
);

INSERT INTO session VALUES ('ses_fixture_v1_main', 'global', NULL, 'retry-review',
  '/Users/mock_user/workspace/opencode-lab', 'Retry helper review', '1.2.9', 1770000000000, 1770000060000);
INSERT INTO session VALUES ('ses_fixture_v1_child', 'global', 'ses_fixture_v1_main', 'retry-audit',
  '/Users/mock_user/workspace/opencode-lab', 'Delegated retry audit', '1.2.9', 1770000100000, 1770000130000);

INSERT INTO message VALUES ('msg_v1_user', 'ses_fixture_v1_main', 1770000001000, 1770000001000,
  '{"role":"user","time":{"created":1770000001000},"modelID":"mock-opencode-v1","providerID":"mock","path":{"cwd":"/Users/mock_user/workspace/opencode-lab","root":"/"}}');
INSERT INTO part VALUES ('prt_v1_user_text', 'msg_v1_user', 'ses_fixture_v1_main', 1770000001000, 1770000001000,
  '{"type":"text","text":"Find the retry helper and explain its backoff."}');

INSERT INTO message VALUES ('msg_v1_assistant', 'ses_fixture_v1_main', 1770000002000, 1770000003500,
  '{"role":"assistant","agent":"builder","modelID":"mock-opencode-v1","providerID":"mock","time":{"created":1770000002000,"completed":1770000003500},"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":1000,"write":50}},"finish":"tool-calls","path":{"cwd":"/Users/mock_user/workspace/opencode-lab","root":"/"}}');
INSERT INTO part VALUES ('prt_v1_assistant_text', 'msg_v1_assistant', 'ses_fixture_v1_main', 1770000002100, 1770000002100,
  '{"type":"text","text":"I will read the retry module."}');
INSERT INTO part VALUES ('prt_v1_assistant_reasoning', 'msg_v1_assistant', 'ses_fixture_v1_main', 1770000002200, 1770000002200,
  '{"type":"reasoning","text":"The prompt names a retry helper; inspect the source first."}');
INSERT INTO part VALUES ('prt_v1_tool_read', 'msg_v1_assistant', 'ses_fixture_v1_main', 1770000002300, 1770000003300,
  '{"type":"tool","callID":"call_v1_read","tool":"read","state":{"status":"completed","input":{"path":"src/retry.ts"},"output":"export function backoff(attempt) { return Math.min(30000, 500 * 2 ** attempt); }"}}');
INSERT INTO part VALUES ('prt_v1_step_finish', 'msg_v1_assistant', 'ses_fixture_v1_main', 1770000003400, 1770000003400,
  '{"type":"step-finish","reason":"tool-calls","tokens":{"input":120,"output":24,"reasoning":6,"cache":{"read":1100,"write":60}}}');

INSERT INTO message VALUES ('msg_v1_tool_error', 'ses_fixture_v1_main', 1770000004000, 1770000005000,
  '{"role":"assistant","modelID":"mock-opencode-v1","providerID":"mock","time":{"created":1770000004000}}');
INSERT INTO part VALUES ('prt_v1_tool_error', 'msg_v1_tool_error', 'ses_fixture_v1_main', 1770000004100, 1770000004900,
  '{"type":"tool","callID":"call_v1_bash","tool":"bash","state":{"status":"error","input":{"command":"rg TIMEOUT_MS src/retry.ts"},"error":"ripgrep exited with status 2"}}');

INSERT INTO message VALUES ('msg_v1_child_user', 'ses_fixture_v1_child', 1770000101000, 1770000101000,
  '{"role":"user","time":{"created":1770000101000},"path":{"cwd":"/Users/mock_user/workspace/opencode-lab","root":"/"}}');
INSERT INTO part VALUES ('prt_v1_child_user_text', 'msg_v1_child_user', 'ses_fixture_v1_child', 1770000101000, 1770000101000,
  '{"type":"text","text":"Audit the delegated retry change."}');
INSERT INTO message VALUES ('msg_v1_child_assistant', 'ses_fixture_v1_child', 1770000102000, 1770000103000,
  '{"role":"assistant","modelID":"mock-opencode-v1","providerID":"mock","time":{"created":1770000102000},"tokens":{"input":40,"output":8,"reasoning":0,"cache":{"read":200,"write":0}}}');
INSERT INTO part VALUES ('prt_v1_child_text', 'msg_v1_child_assistant', 'ses_fixture_v1_child', 1770000102500, 1770000102500,
  '{"type":"text","text":"The delegated change keeps the capped exponential backoff."}');

INSERT INTO part VALUES ('prt_v1_user_file', 'msg_v1_user', 'ses_fixture_v1_main', 1770000001100, 1770000001100,
  '{"type":"file","filename":"diagram.png","mime":"image/png","url":"data:image/png;base64,AAAA"}');
