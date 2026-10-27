-- Letters for the Letters screen browser test. Every body holds the same marker text, which must never show.
-- Each subject is sealed with the browser tests' letter key (32 zero bytes), in the order: To London, To Auckland,
-- Refused, Stuck, Sent in February, Sent in March.
-- 01:00 in London is later than 09:00 in Auckland on the same date, though it reads earlier.
INSERT INTO letters (subject, body, send_local, send_zone, written_at, status, sent_at) VALUES
  (X'f444f3ff3e1621b377544b870f308e22ec8030d4579fe0b8a2a50fd7be0a9f5792c753ca29', CAST('marker letter text' AS BLOB), '2030-01-01T01:00', 'Europe/London', 1767225600000, 'waiting', NULL),
  (X'a975c542270cd4e2758944c17a07ecd962f15c00491149387eed8a85ba82effb82a80a69e48ec8', CAST('marker letter text' AS BLOB), '2030-01-01T09:00', 'Pacific/Auckland', 1767312000000, 'waiting', NULL),
  (X'9b5c0810615d8508b9e990b019bcc31ef5096396feb8e63d550fc221d0aab6375e388e', CAST('marker letter text' AS BLOB), '2026-01-01T09:00', 'UTC', 1735689600000, 'failed', NULL),
  (X'2c671263f09d0e004f3768408990f47f62155fd2f07760893bba7160225b6a0f69', CAST('marker letter text' AS BLOB), '2026-01-02T09:00', 'UTC', 1735776000000, 'waiting', NULL),
  (X'270839f4a253c65f1bb81e99684a7d1a96eeac365ff54d60639257b58b6be1039cc23d3d18b5083739222f9d', CAST('marker letter text' AS BLOB), '2026-02-01T09:00', 'UTC', 1704067200000, 'sent', 1769936430000),
  (X'ef7a0d1e485d2086a8bf67394b3847aaf5ad1db2075fc38208b98d424f8ca021be2a8a4bf062925a51', CAST('marker letter text' AS BLOB), '2026-03-01T09:00', 'UTC', 1704153600000, 'sent', 1772355630000);

-- The stuck letter's last try, as the send job records Resend refusing a bad API key.
INSERT INTO send_attempts (letter_id, tried_at, outcome, detail)
  SELECT id, 1767351600000, 'retry', 'HTTP 401 validation_error API key is invalid' FROM letters WHERE written_at = 1735776000000;
