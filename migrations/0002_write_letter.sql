-- A letter has no separate title: what the owner writes at the top is the email's subject.
ALTER TABLE letters RENAME COLUMN title TO subject;

-- source is the encrypted Markdown the owner wrote, kept so the letter can be edited; body stays the HTML that is sent.
ALTER TABLE letters ADD COLUMN source BLOB;

-- Files put in R2 while a letter is being written, before it is saved. Saving moves its rows into files.
-- key is the file's R2 object key, made by the server. uploaded_at is milliseconds since 1970 (UTC).
CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_at INTEGER NOT NULL
);
