CREATE TABLE letters (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  send_local TEXT NOT NULL,
  send_zone TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE TABLE recipients (letter_id INTEGER NOT NULL REFERENCES letters(id), email TEXT NOT NULL);
CREATE TABLE files (
  letter_id INTEGER NOT NULL REFERENCES letters(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL
);
