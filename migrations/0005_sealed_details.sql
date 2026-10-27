-- The subject, each recipient's address and each file's name are sealed with the letter key, as the text is.
-- letters.subject, files.name and uploads.name keep their TEXT type; SQLite stores the sealed bytes in them as they are.

-- Sealed addresses cannot be compared, so the app keeps a letter's recipients unique, and the table loses its key.
CREATE TABLE recipients_sealed (
  letter_id INTEGER NOT NULL REFERENCES letters (id) ON DELETE CASCADE,
  email BLOB NOT NULL
);
INSERT INTO recipients_sealed (letter_id, email) SELECT letter_id, email FROM recipients ORDER BY rowid;
DROP TABLE recipients;
ALTER TABLE recipients_sealed RENAME TO recipients;
CREATE INDEX recipients_letter ON recipients (letter_id);
