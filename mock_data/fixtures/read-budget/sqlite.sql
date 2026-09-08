-- Synthetic native-value admission input, deliberately tiny on disk.
CREATE TABLE payloads (id TEXT, data BLOB);
INSERT INTO payloads VALUES ('small', CAST('fixture' AS BLOB));
INSERT INTO payloads VALUES ('large', zeroblob(4096));
INSERT INTO payloads VALUES ('empty', NULL);
