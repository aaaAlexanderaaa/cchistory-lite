-- Synthetic Cursor state value: an empty object still consumes row overhead.
CREATE TABLE ItemTable(key TEXT, value TEXT);
INSERT INTO ItemTable VALUES('composerData:fixture','{}');
