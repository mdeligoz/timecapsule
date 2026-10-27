import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const migrate = () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function addLetter(): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO letters (subject, body, send_local, send_zone, written_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(
      "A letter from Jan 1st, 2026",
      new Uint8Array([1, 2, 3]),
      "2027-01-01T09:00",
      "Europe/Istanbul",
      1_767_225_600_000,
    )
    .first<{ id: number }>();
  return row?.id ?? 0;
}

describe("database layout", () => {
  it("applies to an empty database and runs again without error", async () => {
    expect(await tables()).toEqual([]);
    await migrate();
    await migrate();
    expect(await tables()).toEqual([
      "d1_migrations",
      "files",
      "letters",
      "recipients",
      "send_attempts",
      "settings",
      "uploads",
    ]);
  });

  it("starts with one settings row: no time zone yet, both emails on", async () => {
    await migrate();
    const { results } = await env.DB.prepare("SELECT * FROM settings").all();
    expect(results).toEqual([
      {
        id: 1,
        time_zone: null,
        failure_alert: 1,
        monthly_status: 1,
        last_status_month: null,
        setup_started_at: null,
        setup_finished_at: null,
      },
    ]);
    await expect(env.DB.prepare("INSERT INTO settings (id) VALUES (2)").run()).rejects.toThrow();
  });

  it("names the letter's email subject subject", async () => {
    await migrate();
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('letters')").all<{ name: string }>();
    expect(results.map((r) => r.name)).toContain("subject");
    expect(results.map((r) => r.name)).not.toContain("title");
  });

  it("stores a new letter as waiting", async () => {
    await migrate();
    const id = await addLetter();
    const letter = await env.DB.prepare("SELECT status, sent_at, retry_at FROM letters WHERE id = ?").bind(id).first();
    expect(letter).toEqual({ status: "waiting", sent_at: null, retry_at: null });
  });

  it("refuses a letter status other than waiting, sent or failed", async () => {
    await migrate();
    const id = await addLetter();
    await expect(env.DB.prepare("UPDATE letters SET status = 'lost' WHERE id = ?").bind(id).run()).rejects.toThrow();
  });

  it("never gives a deleted letter's id to a new letter", async () => {
    await migrate();
    const first = await addLetter();
    await env.DB.prepare("DELETE FROM letters WHERE id = ?").bind(first).run();
    expect(await addLetter()).toBeGreaterThan(first);
  });

  it("deleting a letter removes its recipients, files and send attempts", async () => {
    await migrate();
    const id = await addLetter();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO recipients (letter_id, email) VALUES (?, ?)").bind(id, "friend@example.com"),
      env.DB.prepare("INSERT INTO files (letter_id, key, name, type, size) VALUES (?, ?, ?, ?, ?)").bind(
        id,
        `letters/${id}/a`,
        "photo.jpg",
        "image/jpeg",
        1000,
      ),
      env.DB.prepare("INSERT INTO send_attempts (letter_id, tried_at, outcome) VALUES (?, ?, ?)").bind(id, 1, "retry"),
    ]);
    await env.DB.prepare("DELETE FROM letters WHERE id = ?").bind(id).run();
    for (const table of ["recipients", "files", "send_attempts"]) {
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n")).toBe(0);
    }
  });

  it("gives each letter its own random send key", async () => {
    await migrate();
    const ids = [await addLetter(), await addLetter()];
    const keys = await Promise.all(
      ids.map((id) => env.DB.prepare("SELECT send_key FROM letters WHERE id = ?").bind(id).first<string>("send_key")),
    );
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("refuses rows that point at a letter that does not exist", async () => {
    await migrate();
    for (const insert of [
      env.DB.prepare("INSERT INTO recipients (letter_id, email) VALUES (?, ?)").bind(999, "friend@example.com"),
      env.DB.prepare("INSERT INTO files (letter_id, key, name, type, size) VALUES (?, ?, ?, ?, ?)").bind(
        999,
        "letters/999/a",
        "photo.jpg",
        "image/jpeg",
        1000,
      ),
      env.DB.prepare("INSERT INTO send_attempts (letter_id, tried_at, outcome) VALUES (?, ?, ?)").bind(999, 1, "retry"),
    ]) {
      await expect(insert.run()).rejects.toThrow();
    }
  });

  it("refuses two files with the same storage key", async () => {
    await migrate();
    const id = await addLetter();
    const add = () =>
      env.DB.prepare("INSERT INTO files (letter_id, key, name, type, size) VALUES (?, ?, ?, ?, ?)")
        .bind(id, "letters/1/a", "photo.jpg", "image/jpeg", 1000)
        .run();
    await add();
    await expect(add()).rejects.toThrow();
  });

  it("refuses a send attempt outcome other than sent, failed or retry", async () => {
    await migrate();
    const id = await addLetter();
    await expect(
      env.DB.prepare("INSERT INTO send_attempts (letter_id, tried_at, outcome) VALUES (?, ?, ?)")
        .bind(id, 1, "maybe")
        .run(),
    ).rejects.toThrow();
  });
});
