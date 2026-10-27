-- The owner's zone when the letter was first saved, so the email's "Written on" date matches the subject and
-- never changes between two tries at sending it.
ALTER TABLE letters ADD COLUMN written_zone TEXT NOT NULL DEFAULT 'UTC';
