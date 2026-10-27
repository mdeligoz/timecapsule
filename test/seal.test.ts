import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importLetterKey, open, seal } from "../src/seal";

const TEXT = "<p>Dear me, ünïcode ✓</p>";

// A key as setup makes it: base64 of 32 random bytes.
const newKey = (bytes = 32) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))));

describe("letter encryption", () => {
  afterEach(() => vi.restoreAllMocks());

  it("decrypts to the original text", async () => {
    const key = await importLetterKey(newKey());
    const opened = await open(await seal(TEXT, key), key);
    expect(opened === TEXT).toBe(true);
  });

  it("decrypts a letter read back from the database", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const key = await importLetterKey(newKey());
    const row = await env.DB.prepare(
      "INSERT INTO letters (subject, body, send_local, send_zone, written_at) VALUES ('t', ?, '2027-01-01T09:00', 'UTC', 0) RETURNING body",
    )
      .bind(await seal(TEXT, key))
      .first<{ body: ArrayLike<number> }>();
    if (!row) throw new Error("The letter was not stored.");
    expect((await open(row.body, key)) === TEXT).toBe(true);
  });

  it("never stores the text in readable form", async () => {
    const key = await importLetterKey(newKey());
    const stored = new TextDecoder().decode(await seal(TEXT, key));
    expect(stored.includes("Dear")).toBe(false);
  });

  it("encrypts the same text differently each time", async () => {
    const key = await importLetterKey(newKey());
    const [a, b] = [await seal(TEXT, key), await seal(TEXT, key)];
    expect(a.length).toBe(b.length);
    expect(a.every((byte, i) => byte === b[i])).toBe(false);
  });

  it("refuses to decrypt when any byte was changed", async () => {
    const key = await importLetterKey(newKey());
    const stored = await seal(TEXT, key);
    for (const at of [0, 12, stored.length - 1]) {
      const changed = stored.slice();
      changed[at] ^= 1;
      await expect(open(changed, key)).rejects.toThrow();
    }
  });

  it("refuses to decrypt with another key", async () => {
    const stored = await seal(TEXT, await importLetterKey(newKey()));
    await expect(open(stored, await importLetterKey(newKey()))).rejects.toThrow();
  });

  it("refuses a key that is not 256 bits", async () => {
    await expect(importLetterKey(newKey(16))).rejects.toThrow();
    await expect(importLetterKey(newKey(31))).rejects.toThrow();
    await expect(importLetterKey("not base64!")).rejects.toThrow();
  });

  it("never logs, and its errors never carry the text", async () => {
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const key = await importLetterKey(newKey());
    const stored = await seal(TEXT, key);
    await open(stored, key);
    const failure = await open(stored, await importLetterKey(newKey())).catch((e: unknown) => String(e));
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    expect(String(failure).includes("Dear")).toBe(false);
  });
});
