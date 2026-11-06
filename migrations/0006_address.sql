-- The app's own address, such as time.example.com, set from Settings; NULL while it is only at its workers.dev address.
ALTER TABLE settings ADD COLUMN address TEXT;

-- Earlier addresses a change could not yet take off the Worker, separated by spaces; the next change takes them off.
-- Kept apart from address so Settings never shows an address the login no longer covers.
ALTER TABLE settings ADD COLUMN address_leaving TEXT;
