-- Times ending in _at are milliseconds since 1970 (UTC).

-- AUTOINCREMENT so a deleted letter's id is never reused.
-- send_key is the letter's idempotency key at Resend: random, so it never repeats across letters, reinstalls or installs.
-- body is the encrypted letter HTML. send_local is the local date and time (YYYY-MM-DDTHH:MM) in send_zone.
-- retry_at is set when Resend gave an error or no answer; the letter is tried again from then.
CREATE TABLE letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body BLOB NOT NULL,
  send_local TEXT NOT NULL,
  send_zone TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  send_key TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'failed')),
  sent_at INTEGER,
  retry_at INTEGER
);

CREATE INDEX letters_due ON letters (status, send_local);

-- Recipients besides the owner, who always gets the letter.
CREATE TABLE recipients (
  letter_id INTEGER NOT NULL REFERENCES letters (id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (letter_id, email)
);

-- key is the file's R2 object key, made by the server.
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES letters (id) ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0)
);

CREATE INDEX files_letter ON files (letter_id);

-- One row per try at sending a letter. detail holds Resend's answer or the error, never letter text.
CREATE TABLE send_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES letters (id) ON DELETE CASCADE,
  tried_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed', 'retry')),
  detail TEXT
);

CREATE INDEX send_attempts_letter ON send_attempts (letter_id);

-- Exactly one row. time_zone stays empty until the owner's browser sets it.
-- last_status_month (YYYY-MM) is the month the last monthly status email went out.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  time_zone TEXT,
  failure_alert INTEGER NOT NULL DEFAULT 1 CHECK (failure_alert IN (0, 1)),
  monthly_status INTEGER NOT NULL DEFAULT 1 CHECK (monthly_status IN (0, 1)),
  last_status_month TEXT
);

INSERT INTO settings (id) VALUES (1);
