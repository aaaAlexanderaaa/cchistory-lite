-- Hand-authored native-shaped rows. Tests build this database only in scratch space.
CREATE TABLE session (
  id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, path TEXT, title TEXT,
  task_type TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, trace_id TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
);
CREATE TABLE part (
  id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
);
INSERT INTO session VALUES ('zcode-parent', NULL, '/workspace/zcode-semantic', NULL, 'ZCode parent fixture', 'interactive', 1775955600000, 1775955606000, NULL, 'fixture-parent');
INSERT INTO session VALUES ('zcode-child', 'zcode-parent', '/workspace/zcode-semantic', NULL, 'ZCode child fixture', 'subagent', 1775955610000, 1775955613000, NULL, 'fixture-child');
INSERT INTO message VALUES ('parent-user', 'zcode-parent', 1775955601000, 1775955601000, '{"role":"user","time":{"created":1775955601000},"model":{"providerID":"fixture","modelID":"zcode-fixture"}}');
INSERT INTO message VALUES ('parent-assistant', 'zcode-parent', 1775955602000, 1775955606000, '{"role":"assistant","parentID":"parent-user","modelID":"zcode-fixture","providerID":"fixture","finish":"stop"}');
INSERT INTO message VALUES ('child-user', 'zcode-child', 1775955611000, 1775955611000, '{"role":"user","time":{"created":1775955611000}}');
INSERT INTO message VALUES ('child-assistant', 'zcode-child', 1775955612000, 1775955613000, '{"role":"assistant","parentID":"child-user","modelID":"zcode-fixture","finish":"stop"}');
INSERT INTO part VALUES ('parent-prompt', 'parent-user', 'zcode-parent', 1775955601000, 1775955601000, '{"type":"text","text":"Inspect the ZCode semantic fixture."}');
INSERT INTO part VALUES ('parent-reply', 'parent-assistant', 'zcode-parent', 1775955602000, 1775955602000, '{"type":"text","text":"ZCode parent inspected."}');
INSERT INTO part VALUES ('parent-tool', 'parent-assistant', 'zcode-parent', 1775955603000, 1775955603000, '{"type":"tool","callID":"call-1","tool":"Read","state":{"status":"completed","input":{"file_path":"/workspace/zcode-semantic/README.md"},"output":"Fixture loaded."}}');
INSERT INTO part VALUES ('parent-finish', 'parent-assistant', 'zcode-parent', 1775955606000, 1775955606000, '{"type":"step-finish","reason":"stop","tokens":{"input":10,"output":4,"reasoning":1,"total":18,"cache":{"read":3,"write":0}}}');
INSERT INTO part VALUES ('child-prompt', 'child-user', 'zcode-child', 1775955611000, 1775955611000, '{"type":"text","text":"Inspect this delegated fixture."}');
INSERT INTO part VALUES ('child-reply', 'child-assistant', 'zcode-child', 1775955612000, 1775955612000, '{"type":"text","text":"Delegated fixture inspected."}');
