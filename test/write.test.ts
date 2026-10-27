import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type Env, handle } from "../src/index";
import { AccessKeys } from "../src/login";
import { importLetterKey, open, seal } from "../src/seal";
import { clearUploads } from "../src/write";
import { makeSigner } from "./token";

// 2027-01-15 08:00 UTC: on the hour, so a send time can sit exactly on a limit.
const NOW = 1_800_000_000;
const MB25 = 25 * 1024 * 1024;
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const LETTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const letterKey = () => importLetterKey(LETTER_KEY);

// A column of sealed values, opened with the letter key, in the order stored.
async function opened(query: string, column: string): Promise<string[]> {
  const { results } = await env.DB.prepare(query).all<Record<string, number[]>>();
  const key = await letterKey();
  return Promise.all(results.map((row) => open(row[column], key)));
}

type Input = {
  subject: string;
  markdown: string;
  html: string;
  sendLocal: string;
  zone: string;
  recipients: string[];
  uploads: number[];
};

const letter = (change: Partial<Input> = {}): Input => ({
  subject: "To me",
  markdown: "Dear me,\n**hello**",
  html: "<p>Dear me,<br><strong>hello</strong></p>",
  sendLocal: "2028-01-15T09:00",
  zone: "UTC",
  recipients: [],
  uploads: [],
  ...change,
});

let app: Env;
let call: (method: string, path: string, body?: BodyInit, headers?: Record<string, string>) => Promise<Response>;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["files", "recipients", "letters", "uploads"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("UPDATE settings SET time_zone = NULL").run();
  for (const object of (await env.FILES.list()).objects) await env.FILES.delete(object.key);
  const signer = await makeSigner();
  app = {
    ACCESS_TEAM_DOMAIN: "https://owner-team.cloudflareaccess.com",
    ACCESS_AUD: "aud-1",
    OWNER_EMAIL: "Owner@Example.com",
    LETTER_KEY,
    DB: env.DB,
    FILES: env.FILES,
  };
  const keys = new AccessKeys(app.ACCESS_TEAM_DOMAIN, async () => new Response(signer.jwks));
  const token = await signer.sign({
    aud: [app.ACCESS_AUD],
    iss: app.ACCESS_TEAM_DOMAIN,
    email: "owner@example.com",
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

const save = (input: unknown) =>
  call("POST", "/letters", JSON.stringify(input), { "content-type": "application/json" });

const upload = (name: string, bytes: Uint8Array) =>
  call("POST", `/uploads?name=${encodeURIComponent(name)}`, bytes, { "content-length": String(bytes.length) });

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

async function saved(input: unknown): Promise<void> {
  const response = await save(input);
  expect(response.status).toBe(201);
  expect(await count("letters")).toBe(1);
}

async function refused(input: unknown, error: RegExp): Promise<void> {
  const response = await save(input);
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toMatch(error);
  expect(await count("letters")).toBe(0);
}

// An upload of the given size, as if its file were already in R2; saving reads only the row.
async function addedFile(size: number, uploadedAt = NOW * 1000, name = "photo.jpg"): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO uploads (key, name, type, size, uploaded_at) VALUES (?, ?, 'image/jpeg', ?, ?) RETURNING id",
  )
    .bind(crypto.randomUUID(), await seal(name, await letterKey()), size, uploadedAt)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

const people = (n: number) => Array.from({ length: n }, (_, i) => `friend${i}@example.com`);

describe("Write letter screen", () => {
  it("fills the subject with A letter from and the date written", async () => {
    const response = await call("GET", "/write");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('value="A letter from Jan 15th, 2027"');
  });

  it("dates the subject in the owner's saved time zone and picks that zone", async () => {
    // 08:00 UTC is still the evening before in Honolulu.
    await env.DB.prepare("UPDATE settings SET time_zone = 'Pacific/Honolulu'").run();
    const page = await (await call("GET", "/write")).text();
    expect(page).toContain('value="A letter from Jan 14th, 2027"');
    expect(page).toContain('<option value="Pacific/Honolulu" selected>');
  });

  it("offers the 24 whole hours and no minutes", async () => {
    const page = await (await call("GET", "/write")).text();
    const hours = /<select name="hour"[^>]*>(.*?)<\/select>/s.exec(page)?.[1] ?? "";
    const values = [...hours.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual(Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`));
  });

  it("offers UTC among the time zones, which the runtime's own list leaves out", async () => {
    expect(await (await call("GET", "/write")).text()).toContain('<option value="UTC">UTC</option>');
  });

  it("stops the subject at 200 characters", async () => {
    expect(await (await call("GET", "/write")).text()).toMatch(/<input name="subject" [^>]*maxlength="200"/);
  });

  it("shows the owner as the first line of the recipients, as they always get the letter", async () => {
    const page = await (await call("GET", "/write")).text();
    expect(page).toContain('<p class="to-you" id="to-you">You (Owner@Example.com) always get this letter.</p>');
    expect(page).toMatch(/<textarea id="recipients" name="recipients" aria-describedby="to-you"/);
    expect(page).toContain('<p class="hint">Up to 20 more people.</p>');
  });

  it("keeps the send date in a field the calendar fills, with the earliest and latest days", async () => {
    const page = await (await call("GET", "/write")).text();
    expect(page).toContain('<input type="hidden" name="date" min="2027-01-22" max="2047-01-15" value="">');
    expect(page).toContain('<button type="button" class="date-toggle" aria-haspopup="dialog" aria-expanded="false"');
  });

  it("takes files through a drop area with an Add files button", async () => {
    const page = await (await call("GET", "/write")).text();
    expect(page).toMatch(
      /<span class="drop-zone"><span class="pick">Add files<\/span> <span class="drop-text">or drop them here<\/span><input type="file" multiple accept="[^"]+" aria-label="Files"><\/span>/,
    );
  });

  it("loads the editor script", async () => {
    expect(await (await call("GET", "/write")).text()).toContain('<script type="module" src="/write.js"></script>');
  });
});

describe("Saving a letter", () => {
  it("stores the letter sealed, with its send time, and answers with the way home", async () => {
    const response = await save(letter({ zone: "Europe/Istanbul" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ location: "/" });
    const row = await env.DB.prepare(
      "SELECT subject, body, source, send_local, send_zone, written_at, status FROM letters",
    ).first<{ subject: number[]; body: number[]; source: number[]; [k: string]: unknown }>();
    expect(row).toMatchObject({
      send_local: "2028-01-15T09:00",
      send_zone: "Europe/Istanbul",
      written_at: NOW * 1000,
      status: "waiting",
    });
    const key = await importLetterKey(LETTER_KEY);
    expect(await open(row?.subject ?? [], key)).toBe("To me");
    expect(await open(row?.body ?? [], key)).toBe(letter().html);
    expect(await open(row?.source ?? [], key)).toBe(letter().markdown);
    expect(new TextDecoder().decode(Uint8Array.from(row?.body ?? []))).not.toContain("hello");
  });

  it("stores the owner's saved zone as the zone the letter was written in", async () => {
    await env.DB.prepare("UPDATE settings SET time_zone = 'Pacific/Honolulu'").run();
    await saved(letter({ zone: "Europe/Istanbul" }));
    expect(await env.DB.prepare("SELECT written_zone FROM letters").first("written_zone")).toBe("Pacific/Honolulu");
  });

  it("with no zone saved, stores the letter's zone, which the page picked from the browser, as the zone written in", async () => {
    await saved(letter({ zone: "Europe/Istanbul" }));
    expect(await env.DB.prepare("SELECT written_zone FROM letters").first("written_zone")).toBe("Europe/Istanbul");
  });

  it("stores each recipient once, ignoring capitals, and leaves out the owner", async () => {
    await saved(
      letter({ recipients: ["Friend@example.com", " friend@EXAMPLE.com ", "owner@example.com", "", "b@x.io"] }),
    );
    expect(await opened("SELECT email FROM recipients ORDER BY rowid", "email")).toEqual([
      "Friend@example.com",
      "b@x.io",
    ]);
  });

  it("stores the subject, each recipient and each file name sealed, so none is readable in the database", async () => {
    const id = await addedFile(1000, NOW * 1000, "holiday photo.jpg");
    await saved(letter({ subject: "To Emma on her wedding day", recipients: ["emma@example.com"], uploads: [id] }));
    const stored = await env.DB.prepare(
      "SELECT subject, (SELECT email FROM recipients) AS email, (SELECT name FROM files) AS name FROM letters",
    ).first<Record<string, unknown>>();
    for (const [column, plain] of Object.entries({ subject: "Emma", email: "emma@", name: "holiday" })) {
      expect(Array.isArray(stored?.[column]), column).toBe(true);
      const bytes = Uint8Array.from(stored?.[column] as number[]);
      expect(new TextDecoder().decode(bytes), column).not.toContain(plain);
    }
  });

  it("moves the added files onto the letter", async () => {
    const id = await addedFile(1000);
    await saved(letter({ uploads: [id] }));
    expect(await env.DB.prepare("SELECT type, size FROM files").all()).toMatchObject({
      results: [{ type: "image/jpeg", size: 1000 }],
    });
    expect(await opened("SELECT name FROM files", "name")).toEqual(["photo.jpg"]);
    expect(await count("uploads")).toBe(0);
  });

  it("refuses a send time that is not on the hour", async () => {
    await refused(letter({ sendLocal: "2028-01-15T09:30" }), /whole hour/);
    await refused(letter({ sendLocal: "2028-01-15" }), /whole hour/);
  });

  it("refuses a date that does not exist", async () => {
    await refused(letter({ sendLocal: "2028-02-30T09:00" }), /date/);
  });

  it("refuses a time zone it does not know", async () => {
    await refused(letter({ zone: "Mars/Olympus" }), /time zone/);
  });

  it("refuses a send time under 7 days ahead", async () => {
    await refused(letter({ sendLocal: "2027-01-22T07:00" }), /at least 7 days/);
  });

  it("accepts a send time exactly 7 days ahead", async () => {
    await saved(letter({ sendLocal: "2027-01-22T08:00" }));
  });

  it("accepts a send time just over 7 days ahead", async () => {
    await saved(letter({ sendLocal: "2027-01-22T09:00" }));
  });

  it("accepts a send time just under 20 years ahead", async () => {
    await saved(letter({ sendLocal: "2047-01-15T07:00" }));
  });

  it("accepts a send time exactly 20 years ahead", async () => {
    await saved(letter({ sendLocal: "2047-01-15T08:00" }));
  });

  it("refuses a send time over 20 years ahead", async () => {
    await refused(letter({ sendLocal: "2047-01-15T09:00" }), /at most 20 years/);
  });

  it("counts a new letter's 7 days from when its Write page opened, up to 3 hours before Save", async () => {
    // The page opened 2 hours before Save, at 06:00 UTC, so 06:00 a week on was offered as the earliest hour.
    await saved({ ...letter({ sendLocal: "2027-01-22T06:00" }), opened: NOW * 1000 - 2 * HOUR });
  });

  it("stores the page's opening time as when the letter was written, so an edit keeps the hour it was saved with", async () => {
    const opened = NOW * 1000 - 2 * HOUR;
    await saved({ ...letter({ sendLocal: "2027-01-22T06:00" }), opened });
    const row = await env.DB.prepare("SELECT id, written_at FROM letters").first<{ id: number; written_at: number }>();
    expect(row?.written_at).toBe(opened);
    const edited = await call(
      "PUT",
      `/letters/${row?.id}`,
      JSON.stringify({ ...letter({ subject: "Changed", sendLocal: "2027-01-22T06:00" }), files: [] }),
      { "content-type": "application/json" },
    );
    expect(edited.status).toBe(200);
  });

  it("counts from a page opened exactly 3 hours before Save", async () => {
    await saved({ ...letter({ sendLocal: "2027-01-22T05:00" }), opened: NOW * 1000 - 3 * HOUR });
  });

  it("does not count from a page opened over 3 hours before Save", async () => {
    // A slow browser clock could otherwise move the 7 days back by as much as it is slow.
    await refused({ ...letter({ sendLocal: "2027-01-22T04:00" }), opened: NOW * 1000 - 4 * HOUR }, /at least 7 days/);
  });

  it("counts from Save when the page's time is later than Save or not a time", async () => {
    await saved({ ...letter({ sendLocal: "2027-01-22T08:00" }), opened: NOW * 1000 + 3 * HOUR });
    await env.DB.prepare("DELETE FROM recipients").run();
    await env.DB.prepare("DELETE FROM letters").run();
    await refused({ ...letter({ sendLocal: "2027-01-22T07:00" }), opened: "yesterday" }, /at least 7 days/);
  });

  it("measures the 7 days in a zone half an hour off UTC", async () => {
    // 7 days on, 08:00 UTC is 13:30 in Kolkata, so 13:00 there (07:30 UTC) is too soon and 14:00 is the first hour.
    await refused(letter({ sendLocal: "2027-01-22T13:00", zone: "Asia/Kolkata" }), /at least 7 days/);
    await saved(letter({ sendLocal: "2027-01-22T14:00", zone: "Asia/Kolkata" }));
  });

  it("measures the 7 days in the letter's own zone", async () => {
    // 2027-01-22 10:00 in Istanbul (UTC+3) is 07:00 UTC, an hour short of 7 days.
    await refused(letter({ sendLocal: "2027-01-22T10:00", zone: "Europe/Istanbul" }), /at least 7 days/);
  });

  it("accepts 19 recipients", async () => {
    await saved(letter({ recipients: people(19) }));
  });

  it("accepts 20 recipients", async () => {
    await saved(letter({ recipients: people(20) }));
    expect(await count("recipients")).toBe(20);
  });

  it("refuses 21 recipients", async () => {
    await refused(letter({ recipients: people(21) }), /at most 20 people/);
  });

  it("does not count a repeated recipient twice towards the 20", async () => {
    await saved(letter({ recipients: [...people(20), "FRIEND0@example.com", "owner@example.com"] }));
  });

  it("refuses a recipient that is not an email address", async () => {
    await refused(letter({ recipients: ["friend at example.com"] }), /friend at example\.com/);
  });

  // Resend refuses these at send time, when the letter may already be locked.
  for (const address of [
    "bob@gmail.com.",
    "bob@gmail..com",
    "<bob@x.io>",
    ".bob@x.io",
    "bob.@x.io",
    "bo..b@x.io",
    "bob@x",
    "bob@x.c",
    "bob@x.c0m",
    "bob@x_y.io",
    "bob@.x.io",
    "bob(work)@x.io",
  ]) {
    it(`refuses the recipient ${address}`, async () => {
      await refused(letter({ recipients: [address] }), /is not an email address/);
    });
  }

  it("accepts addresses with dots, plus signs, hyphens and several domain parts", async () => {
    await saved(letter({ recipients: ["first.last+tag@mail.example-site.co.uk", "o'brien@X.IO", "a_b@x1.io"] }));
  });

  // Resend refuses a domain in other scripts but takes its coded form (both captured 2026-10-22).
  it("stores a domain in other scripts in the coded form Resend takes", async () => {
    await saved(letter({ recipients: ["ivan@пример.рф", "anna@xn--e1afmkfd.xn--p1ai"] }));
    expect(await opened("SELECT email FROM recipients ORDER BY rowid", "email")).toEqual([
      "ivan@xn--e1afmkfd.xn--p1ai",
      "anna@xn--e1afmkfd.xn--p1ai",
    ]);
  });

  it("counts a domain typed both ways as one address", async () => {
    await saved(letter({ recipients: ["ivan@пример.рф", "IVAN@xn--e1afmkfd.xn--p1ai"] }));
    expect(await count("recipients")).toBe(1);
  });

  it("refuses letters other than Latin before the @, naming the address as typed", async () => {
    await refused(letter({ recipients: ["иван@пример.рф"] }), /"иван@пример\.рф" is not an email address/);
  });

  it("accepts text just under 50,000 characters", async () => {
    await saved(letter({ markdown: "a".repeat(49_999) }));
  });

  it("accepts text of exactly 50,000 characters", async () => {
    await saved(letter({ markdown: "a".repeat(50_000) }));
  });

  it("refuses text over 50,000 characters", async () => {
    await refused(letter({ markdown: "a".repeat(50_001) }), /50,000 characters/);
  });

  it("accepts files just under 25 MB in total", async () => {
    await saved(letter({ uploads: [await addedFile(MB25 - 1001), await addedFile(1000)] }));
  });

  it("accepts files of exactly 25 MB in total", async () => {
    await saved(letter({ uploads: [await addedFile(MB25 - 1000), await addedFile(1000)] }));
  });

  it("refuses files over 25 MB in total", async () => {
    await refused(letter({ uploads: [await addedFile(MB25 - 999), await addedFile(1000)] }), /25 MB/);
    expect(await count("uploads")).toBe(2);
  });

  it("refuses a file that was never added, or that the clean-up removed, and names it", async () => {
    const response = await save(letter({ uploads: [await addedFile(1000), 12345] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A file did not finish adding, or was added more than 7 days ago. Remove it and add it again.",
      uploads: [12345],
    });
  });

  it("accepts a file added exactly 7 days ago", async () => {
    await saved(letter({ uploads: [await addedFile(1000, NOW * 1000 - WEEK)] }));
  });

  it("refuses a file added more than 7 days ago, which the clean-up may be removing, and names it", async () => {
    const old = await addedFile(1000, NOW * 1000 - WEEK - 1);
    const response = await save(letter({ uploads: [await addedFile(1000), old] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A file was added more than 7 days ago. Remove it and add it again.",
      uploads: [old],
    });
    expect(await count("letters")).toBe(0);
  });

  it("accepts a subject just under 200 characters", async () => {
    await saved(letter({ subject: "a".repeat(199) }));
  });

  it("accepts a subject of exactly 200 characters", async () => {
    await saved(letter({ subject: "a".repeat(200) }));
  });

  it("refuses a subject over 200 characters", async () => {
    await refused(letter({ subject: "a".repeat(201) }), /200 characters/);
  });

  it("refuses a blank subject", async () => {
    await refused(letter({ subject: "   " }), /subject/);
  });

  it("refuses a request that is not a letter", async () => {
    await refused("not a letter", /not a letter/);
    expect((await call("POST", "/letters", "{", { "content-type": "application/json" })).status).toBe(400);
  });
});

describe("Adding files", () => {
  it("accepts each allowed type and stores it in R2 under a key the server makes", async () => {
    const types: Record<string, string> = {
      "a.jpg": "image/jpeg",
      "b.JPEG": "image/jpeg",
      "c.png": "image/png",
      "d.gif": "image/gif",
      "e.webp": "image/webp",
      "f.heic": "image/heic",
      "g.mp4": "video/mp4",
      "h.mov": "video/quicktime",
      "i.pdf": "application/pdf",
    };
    for (const [name, type] of Object.entries(types)) {
      const response = await upload(name, new Uint8Array([1, 2, 3]));
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: number };
      const row = await env.DB.prepare("SELECT key, name, type, size FROM uploads WHERE id = ?")
        .bind(id)
        .first<{ key: string; name: number[]; type: string; size: number }>();
      expect(row).toMatchObject({ type, size: 3 });
      expect(await open(row?.name ?? [], await letterKey())).toBe(name);
      expect(row?.key).toMatch(/^[0-9a-f]{32}$/);
      const object = await env.FILES.get(row?.key ?? "");
      expect(object?.httpMetadata?.contentType).toBe(type);
      expect(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(new Uint8Array([1, 2, 3]));
    }
  });

  it("refuses any other type", async () => {
    for (const name of ["virus.exe", "drawing.svg", "photo.jpg.html", "noending", "constructor"]) {
      const response = await upload(name, new Uint8Array([1]));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(/JPG, PNG, GIF, WebP, HEIC, MP4, MOV/);
    }
    expect(await count("uploads")).toBe(0);
    expect((await env.FILES.list()).objects).toEqual([]);
  });

  it("accepts a file name of 200 characters, ending included", async () => {
    expect((await upload(`${"a".repeat(196)}.jpg`, new Uint8Array([1]))).status).toBe(201);
    expect((await upload(`${"a".repeat(195)}.jpg`, new Uint8Array([1]))).status).toBe(201);
  });

  it("refuses a file name over 200 characters without storing it", async () => {
    const response = await upload(`${"a".repeat(197)}.jpg`, new Uint8Array([1]));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/200 characters/);
    expect((await env.FILES.list()).objects).toEqual([]);
  });

  it("accepts a file just under 25 MB", async () => {
    expect((await upload("film.mp4", new Uint8Array(MB25 - 1))).status).toBe(201);
  });

  it("accepts a file of exactly 25 MB", async () => {
    expect((await upload("film.mp4", new Uint8Array(MB25))).status).toBe(201);
  });

  it("refuses a file over 25 MB without storing it", async () => {
    const response = await upload("film.mp4", new Uint8Array(MB25 + 1));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/25 MB/);
    expect((await env.FILES.list()).objects).toEqual([]);
  });

  it("takes the file back out of R2 when its row cannot be stored", async () => {
    // A database that refuses the new upload's row.
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.startsWith("INSERT INTO uploads")) throw new Error("D1 is unavailable.");
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    app = { ...app, DB: db };
    await expect(upload("a.png", new Uint8Array([1]))).rejects.toThrow("D1 is unavailable.");
    expect((await env.FILES.list()).objects).toEqual([]);
  });

  it("removes an added file from R2 and from the list", async () => {
    const { id } = (await (await upload("a.png", new Uint8Array([1]))).json()) as { id: number };
    expect((await call("DELETE", `/uploads/${id}`)).status).toBe(204);
    expect(await count("uploads")).toBe(0);
    expect((await env.FILES.list()).objects).toEqual([]);
  });
});

describe("Clearing unsaved files", () => {
  const added = async (name: string, uploadedAt: number) => {
    const { id } = (await (await upload(name, new Uint8Array([1]))).json()) as { id: number };
    await env.DB.prepare("UPDATE uploads SET uploaded_at = ? WHERE id = ?").bind(uploadedAt, id).run();
  };
  const left = async () => ({
    rows: (await opened("SELECT name FROM uploads", "name")).sort(),
    objects: (await env.FILES.list()).objects.length,
  });

  it("removes a file added over 7 days and an hour ago from R2 and the list, and keeps a newer one", async () => {
    await added("old.png", NOW * 1000 - WEEK - HOUR - 1);
    await added("new.png", NOW * 1000 - WEEK);
    await clearUploads(app, NOW * 1000);
    expect(await left()).toEqual({ rows: ["new.png"], objects: 1 });
  });

  it("keeps a file added exactly 7 days and an hour ago", async () => {
    await added("a.png", NOW * 1000 - WEEK - HOUR);
    await clearUploads(app, NOW * 1000);
    expect(await left()).toEqual({ rows: ["a.png"], objects: 1 });
  });

  it("keeps the row when R2 refuses to remove the file, so a later run tries again", async () => {
    await added("a.png", NOW * 1000 - WEEK - HOUR - 1);
    app = {
      ...app,
      FILES: new Proxy(env.FILES, {
        get(target, property) {
          if (property === "delete") return async () => Promise.reject(new Error("R2 is unavailable."));
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    await expect(clearUploads(app, NOW * 1000)).rejects.toThrow("R2 is unavailable.");
    expect(await left()).toEqual({ rows: ["a.png"], objects: 1 });
  });
});
