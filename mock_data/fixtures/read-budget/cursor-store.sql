-- Synthetic Cursor chat-store schema: even metadata requires admission.
CREATE TABLE meta(key TEXT, value TEXT);
INSERT INTO meta VALUES('meta','{}');
CREATE TABLE blobs(id TEXT, data BLOB);
