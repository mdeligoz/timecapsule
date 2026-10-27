import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type Env, handle } from "../src/index";
import { AccessKeys } from "../src/login";
import { importLetterKey, open, seal } from "../src/seal";
import { makeSigner } from "./token";

// 2027-01-15 08:00 UTC.
const NOW = 1_800_000_000;
const HOUR = 3_600_000;
const LETTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const BODY = "<p>Dear me,<br><strong>the secret words</strong></p>";
const SOURCE = "Dear me,\n**the secret words**";
// Sealed with the letter key, as the app stores it.
const sealed = async (text: string) => seal(text, await importLetterKey(LETTER_KEY));

// A column of sealed values, opened with the letter key, in the order the query gives.
async function opened(query: string, column: string, ...values: unknown[]): Promise<string[]> {
  const { results } = await env.DB.prepare(query)
    .bind(...values)
    .all<Record<string, number[]>>();
  const key = await importLetterKey(LETTER_KEY);
  return Promise.all(results.map((row) => open(row[column], key)));
}

type Letter = { subject?: string; sendLocal?: string; written?: number; status?: string; sentAt?: number };

async function addLetter(letter: Letter = {}): Promise<number> {
  const key = await importLetterKey(LETTER_KEY);
  const row = await env.DB.prepare(
    "INSERT INTO letters (subject, body, source, send_local, send_zone, written_at, written_zone, status, sent_at) VALUES (?, ?, ?, ?, ?, ?, 'Europe/Istanbul', ?, ?) RETURNING id",
  )
    .bind(
      await seal(letter.subject ?? "To me", key),
      await seal(BODY, key),
      await seal(SOURCE, key),
      letter.sendLocal ?? "2028-01-15T09:00",
      "Europe/Istanbul",
      letter.written ?? NOW * 1000 - HOUR,
      letter.status ?? "waiting",
      letter.sentAt ?? null,
    )
    .first<{ id: number }>();
  return row?.id ?? 0;
}

// A file on the letter, stored in R2 under its key.
async function addFile(letterId: number, name: string, bytes = new Uint8Array([1, 2, 3])): Promise<number> {
  const key = crypto.randomUUID();
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  const row = await env.DB.prepare(
    "INSERT INTO files (letter_id, key, name, type, size) VALUES (?, ?, ?, 'image/jpeg', ?) RETURNING id",
  )
    .bind(letterId, key, await sealed(name), bytes.length)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

// An upload of the given size, as if its file were already in R2.
async function addUpload(size: number): Promise<number> {
  const key = crypto.randomUUID();
  await env.FILES.put(key, new Uint8Array(size));
  const row = await env.DB.prepare(
    "INSERT INTO uploads (key, name, type, size, uploaded_at) VALUES (?, ?, 'image/png', ?, ?) RETURNING id",
  )
    .bind(key, await sealed("new.png"), size, NOW * 1000)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

let app: Env;
let call: (method: string, path: string, body?: BodyInit, headers?: Record<string, string>) => Promise<Response>;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["files", "recipients", "send_attempts", "letters", "uploads"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("UPDATE settings SET time_zone = NULL").run();
  for (const object of (await env.FILES.list()).objects) await env.FILES.delete(object.key);
  const signer = await makeSigner();
  app = {
    ACCESS_TEAM_DOMAIN: "https://owner-team.cloudflareaccess.com",
    ACCESS_AUD: "aud-1",
    OWNER_EMAIL: "owner@example.com",
    LETTER_KEY,
    DB: env.DB,
    FILES: env.FILES,
  };
  const keys = new AccessKeys(app.ACCESS_TEAM_DOMAIN, async () => new Response(signer.jwks));
  const token = await signer.sign({
    aud: [app.ACCESS_AUD],
    iss: app.ACCESS_TEAM_DOMAIN,
    email: app.OWNER_EMAIL,
    exp: NOW + 3600,
  });
  call = (method, path, body, headers = {}) =>
    handle(
      new Request(`https://timecapsule.example${path}`, {
        method,
        body,
        headers: { "cf-access-jwt-assertion": token, ...headers },
      }),
      app,
      keys,
      NOW,
    );
});

const text = async (path: string) => (await call("GET", path)).text();
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

const edit = (id: number, change: Record<string, unknown> = {}) =>
  call(
    "PUT",
    `/letters/${id}`,
    JSON.stringify({
      subject: "Changed",
      markdown: "Changed words",
      html: "<p>Changed words</p>",
      sendLocal: "2029-03-01T10:00",
      zone: "UTC",
      recipients: ["friend@example.com"],
      files: [],
      uploads: [],
      ...change,
    }),
    { "content-type": "application/json" },
  );

// 47 hours 59 minutes, and exactly 48 hours, before now.
const JUST_INSIDE = NOW * 1000 - 48 * HOUR + 60_000;
const AT_48_HOURS = NOW * 1000 - 48 * HOUR;

describe("Letter screen", () => {
  it("shows a waiting letter's subject and send time in its own zone, and hides its text", async () => {
    const id = await addLetter({ subject: "Hello <you>" });
    const page = await text(`/letters/${id}`);
    expect(page).toContain("<h1>Hello &lt;you&gt;</h1>");
    expect(page).toMatch(/Sends Jan 15, 2028, 9:00\sAM Europe\/Istanbul/);
    expect(page).not.toContain("the secret words");
    expect(page).toContain(`<a class="button" href="/letters/${id}?reveal">Reveal</a>`);
  });

  it("Reveal shows the stored HTML and the files", async () => {
    const id = await addLetter();
    const file = await addFile(id, "photo.jpg");
    const page = await text(`/letters/${id}?reveal`);
    expect(page).toContain(BODY);
    expect(page).toContain(`<a href="/letters/${id}/files/${file}">photo.jpg</a>`);
    expect(page).not.toContain(">Reveal</a>");
  });

  it("shows a sent letter's full text and files without Reveal", async () => {
    const id = await addLetter({
      status: "sent",
      sentAt: NOW * 1000 - 24 * HOUR,
      written: NOW * 1000 - 400 * 24 * HOUR,
    });
    const file = await addFile(id, "photo.jpg");
    const page = await text(`/letters/${id}`);
    expect(page).toContain("Sent Jan 14, 2027");
    expect(page).toContain(BODY);
    expect(page).toContain(`<a href="/letters/${id}/files/${file}">photo.jpg</a>`);
    expect(page).not.toContain(">Reveal</a>");
  });

  it("says so when the letter's text cannot be opened, and still shows its details and files", async () => {
    const id = await addLetter({ subject: "Locked away" });
    const file = await addFile(id, "photo.jpg");
    await env.DB.prepare("UPDATE letters SET body = x'00' WHERE id = ?").bind(id).run();
    const response = await call("GET", `/letters/${id}?reveal`);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("<h1>Locked away</h1>");
    expect(page).toContain("This letter's text could not be opened.");
    expect(page).toContain(`<a href="/letters/${id}/files/${file}">photo.jpg</a>`);
  });

  it("marks a failed letter", async () => {
    const id = await addLetter({ status: "failed", written: NOW * 1000 - 400 * 24 * HOUR });
    expect(await text(`/letters/${id}`)).toContain("Not sent: Resend refused it");
  });

  it("lets no script run in the page, whatever the stored HTML holds", async () => {
    const id = await addLetter();
    expect((await call("GET", `/letters/${id}`)).headers.get("content-security-policy")).toBe("script-src 'none'");
  });

  it("serves a letter's file with its stored type", async () => {
    const id = await addLetter();
    const file = await addFile(id, "photo.jpg", new Uint8Array([9, 8, 7]));
    const response = await call("GET", `/letters/${id}/files/${file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("serves a file only under its own letter", async () => {
    const id = await addLetter();
    const other = await addLetter();
    const file = await addFile(id, "photo.jpg");
    expect((await call("GET", `/letters/${other}/files/${file}`)).status).toBe(404);
  });

  it("answers Not found for a file whose row is kept but whose object is gone from R2", async () => {
    const id = await addLetter();
    const file = await addFile(id, "photo.jpg");
    const row = await env.DB.prepare("SELECT key FROM files WHERE id = ?").bind(file).first<{ key: string }>();
    await env.FILES.delete(row?.key ?? "");
    expect(await count("files")).toBe(1);
    expect((await call("GET", `/letters/${id}/files/${file}`)).status).toBe(404);
  });

  it("answers Not found for a letter that does not exist", async () => {
    expect((await call("GET", "/letters/999")).status).toBe(404);
    expect((await call("GET", "/letters/999/edit")).status).toBe(404);
    expect((await call("GET", "/letters/999/delete")).status).toBe(404);
  });
});

describe("Editing a letter", () => {
  it("offers Edit at 47 hours 59 minutes after writing", async () => {
    const id = await addLetter({ written: JUST_INSIDE });
    expect(await text(`/letters/${id}`)).toContain(`<a href="/letters/${id}/edit">Edit</a>`);
    expect((await call("GET", `/letters/${id}/edit`)).status).toBe(200);
  });

  it("no longer offers Edit at 48 hours", async () => {
    const id = await addLetter({ written: AT_48_HOURS });
    expect(await text(`/letters/${id}`)).not.toContain("/edit");
    const response = await call("GET", `/letters/${id}/edit`);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("locked 48 hours after it was written");
  });

  it("opens Write letter filled in with the letter as saved", async () => {
    const id = await addLetter();
    await env.DB.prepare("INSERT INTO recipients (letter_id, email) VALUES (?, ?), (?, ?)")
      .bind(id, await sealed("a@x.io"), id, await sealed("b@x.io"))
      .run();
    const file = await addFile(id, "photo.jpg");
    const page = await text(`/letters/${id}/edit`);
    const written = await env.DB.prepare("SELECT written_at FROM letters WHERE id = ?").bind(id).first("written_at");
    // The page greys out the hours before the letter was written, which is when an edit's limits are measured from.
    expect(page).toContain(`<form id="letter" class="write" data-letter="${id}" data-written="${written}">`);
    expect(page).toContain('value="To me"');
    expect(page).toContain("Dear me,\n**the secret words**</textarea>");
    expect(page).toContain('value="2028-01-15"');
    expect(page).toContain('<option value="09:00" selected>');
    expect(page).toContain('<option value="Europe/Istanbul" selected>');
    expect(page).toMatch(/<textarea id="recipients" name="recipients"[^>]*>a@x.io\nb@x.io<\/textarea>/);
    expect(page).toContain(`<li data-file="${file}" data-size="3" data-name="photo.jpg">photo.jpg (0.0 MB)</li>`);
  });

  it("saves the changes at 47 hours 59 minutes and answers with the way to the letter", async () => {
    const id = await addLetter({ written: JUST_INSIDE });
    // The zone the letter was written in stays as it was, like the date written.
    await env.DB.prepare("UPDATE settings SET time_zone = 'Asia/Tokyo'").run();
    const response = await edit(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ location: `/letters/${id}` });
    const row = await env.DB.prepare(
      "SELECT subject, body, source, send_local, send_zone, written_at, written_zone FROM letters WHERE id = ?",
    )
      .bind(id)
      .first<{ subject: number[]; body: number[]; source: number[]; [k: string]: unknown }>();
    expect(row).toMatchObject({
      send_local: "2029-03-01T10:00",
      send_zone: "UTC",
      written_at: JUST_INSIDE,
      written_zone: "Europe/Istanbul",
    });
    const key = await importLetterKey(LETTER_KEY);
    expect(await open(row?.subject ?? [], key)).toBe("Changed");
    expect(await open(row?.body ?? [], key)).toBe("<p>Changed words</p>");
    expect(await open(row?.source ?? [], key)).toBe("Changed words");
    expect(await opened("SELECT email FROM recipients WHERE letter_id = ?", "email", id)).toEqual([
      "friend@example.com",
    ]);
  });

  it("refuses to save changes at 48 hours", async () => {
    const id = await addLetter({ written: AT_48_HOURS });
    const response = await edit(id);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/locked 48 hours after it was written/);
    expect(await opened("SELECT subject FROM letters WHERE id = ?", "subject", id)).toEqual(["To me"]);
  });

  it("checks the changes by the same rules as a new letter", async () => {
    const id = await addLetter();
    const response = await edit(id, { sendLocal: "2099-01-01T09:00" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/at most 20 years/);
    const offHour = await edit(id, { sendLocal: "2028-01-15T09:30" });
    expect(((await offHour.json()) as { error: string }).error).toMatch(/whole hour/);
  });

  it("measures the 7 days from when the letter was written, not from the edit", async () => {
    // Written 2027-01-13 08:01 UTC, so 7 days later is 2027-01-20 08:01; now is two days later.
    const id = await addLetter({ written: JUST_INSIDE });
    expect((await edit(id, { sendLocal: "2027-01-20T09:00" })).status).toBe(200);
    const response = await edit(id, { sendLocal: "2027-01-20T08:00" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/at least 7 days/);
  });

  it("locks a letter once its send time has passed", async () => {
    // Now is 2027-01-15 08:00 UTC, which is 11:00 in Istanbul.
    const id = await addLetter({ sendLocal: "2027-01-15T11:00" });
    const response = await edit(id);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/its send time has passed/);
    expect(await text(`/letters/${id}/edit`)).toContain("its send time has passed");
    expect(await text(`/letters/${id}`)).not.toContain(`/letters/${id}/edit`);
    const later = await addLetter({ sendLocal: "2027-01-15T12:00" });
    expect(await text(`/letters/${later}`)).toContain(`/letters/${later}/edit`);
  });

  it("still opens, and can be edited, when its send time can no longer be worked out", async () => {
    const id = await addLetter({ sendLocal: "2028-02-30T09:00" });
    expect(await text(`/letters/${id}`)).toContain(`/letters/${id}/edit`);
    expect((await call("GET", `/letters/${id}/edit`)).status).toBe(200);
  });

  it("says so on Edit when the letter's text cannot be opened", async () => {
    const id = await addLetter({ subject: "Locked away" });
    await env.DB.prepare("UPDATE letters SET source = x'00' WHERE id = ?").bind(id).run();
    const page = await text(`/letters/${id}/edit`);
    expect(page).toContain("<h1>Locked away</h1>");
    expect(page).toContain("This letter's text could not be opened, so it cannot be edited.");
  });

  it("offers send dates from 7 days after the letter was written", async () => {
    const id = await addLetter({ written: JUST_INSIDE });
    expect(await text(`/letters/${id}/edit`)).toContain('min="2027-01-20"');
  });

  it("offers send dates from the next day when every hour of the seventh day comes too soon", async () => {
    // Written 2027-01-14 23:30 in Istanbul, so 7 days later is 23:30 on the 21st and the first whole hour is on the 22nd.
    const id = await addLetter({ written: NOW * 1000 - 11.5 * HOUR });
    expect(await text(`/letters/${id}/edit`)).toContain('min="2027-01-22"');
  });

  it("answers saved when a removed file cannot leave R2, and keeps it on the uploads list", async () => {
    const id = await addLetter();
    await addFile(id, "removed.jpg");
    app = {
      ...app,
      FILES: new Proxy(env.FILES, {
        get(target, property) {
          if (property === "delete") return () => Promise.reject(new Error("R2 is unavailable."));
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    expect((await edit(id)).status).toBe(200);
    expect(await count("files")).toBe(0);
    expect(await opened("SELECT name FROM uploads", "name")).toEqual(["removed.jpg"]);
  });

  it("keeps the files left on, adds new ones, and removes the rest from R2", async () => {
    const id = await addLetter();
    const kept = await addFile(id, "kept.jpg");
    const removed = await addFile(id, "removed.jpg");
    const removedKey = (
      await env.DB.prepare("SELECT key FROM files WHERE id = ?").bind(removed).first<{ key: string }>()
    )?.key;
    const upload = await addUpload(10);
    expect((await edit(id, { files: [kept], uploads: [upload] })).status).toBe(200);
    expect((await opened("SELECT name FROM files WHERE letter_id = ?", "name", id)).sort()).toEqual([
      "kept.jpg",
      "new.png",
    ]);
    expect(await count("uploads")).toBe(0);
    expect(await env.FILES.get(removedKey ?? "")).toBeNull();
    expect((await env.FILES.list()).objects).toHaveLength(2);
  });

  it("counts the files kept towards the 25 MB", async () => {
    const id = await addLetter();
    const kept = await addFile(id, "kept.jpg", new Uint8Array(1000));
    const upload = await addUpload(25 * 1024 * 1024 - 999);
    const response = await edit(id, { files: [kept], uploads: [upload] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/25 MB/);
  });

  it("refuses to keep a file that belongs to another letter", async () => {
    const id = await addLetter();
    const other = await addLetter();
    const file = await addFile(other, "theirs.jpg");
    expect((await edit(id, { files: [file] })).status).toBe(400);
    expect(await env.DB.prepare("SELECT letter_id FROM files WHERE id = ?").bind(file).first()).toEqual({
      letter_id: other,
    });
  });
});

describe("Deleting a letter", () => {
  it("asks for confirmation first", async () => {
    const id = await addLetter({ subject: "Goodbye" });
    const page = await text(`/letters/${id}/delete`);
    expect(page).toContain("Delete “Goodbye”?");
    expect(page).toContain(`<form method="post" action="/letters/${id}/delete">`);
    expect(page).toContain(`<a href="/letters/${id}">Keep it</a>`);
    expect(await count("letters")).toBe(1);
  });

  it("removes the letter, its recipients, files and send attempts, and its files in R2", async () => {
    const id = await addLetter();
    const keep = await addLetter();
    await addFile(id, "a.jpg");
    await addFile(id, "b.jpg");
    await addFile(keep, "other.jpg");
    await env.DB.prepare("INSERT INTO recipients (letter_id, email) VALUES (?, ?)")
      .bind(id, await sealed("a@x.io"))
      .run();
    await env.DB.prepare("INSERT INTO send_attempts (letter_id, tried_at, outcome) VALUES (?, 0, 'retry')")
      .bind(id)
      .run();
    const response = await call("POST", `/letters/${id}/delete`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(await env.DB.prepare("SELECT id FROM letters").all()).toMatchObject({ results: [{ id: keep }] });
    for (const table of ["recipients", "send_attempts"]) expect(await count(table)).toBe(0);
    expect(await opened("SELECT name FROM files", "name")).toEqual(["other.jpg"]);
    expect((await env.FILES.list()).objects).toHaveLength(1);
  });

  it("keeps the letter when its files cannot be removed from R2, so none is left with nothing pointing to it", async () => {
    const id = await addLetter();
    await addFile(id, "a.jpg");
    const files = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "delete") return () => Promise.reject(new Error("R2 is unavailable."));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    app = { ...app, FILES: files };
    await expect(call("POST", `/letters/${id}/delete`)).rejects.toThrow("R2 is unavailable.");
    expect(await count("letters")).toBe(1);
    expect(await count("files")).toBe(1);
  });
});
