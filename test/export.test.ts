import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type Env, handle } from "../src/index";
import { AccessKeys } from "../src/login";
import { importLetterKey, seal } from "../src/seal";
import { makeSigner } from "./token";

// 2027-01-15 08:00 UTC.
const NOW = 1_800_000_000;
const HOUR = 3_600_000;
const LETTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const BODY = "<p>Dear me,<br><strong>the secret words</strong></p>";
const FOLDER = "timecapsule-export-2027-01-15";
// Sealed with the letter key, as the app stores it.
const sealed = async (text: string) => seal(text, await importLetterKey(LETTER_KEY));

type Letter = { subject?: string; written?: number; status?: string; sentAt?: number; body?: Uint8Array };

async function addLetter(letter: Letter = {}): Promise<number> {
  const key = await importLetterKey(LETTER_KEY);
  const row = await env.DB.prepare(
    "INSERT INTO letters (subject, body, source, send_local, send_zone, written_at, status, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(
      await seal(letter.subject ?? "To me", key),
      letter.body ?? (await seal(BODY, key)),
      await seal("Dear me", key),
      "2028-01-15T09:00",
      "Europe/Istanbul",
      letter.written ?? NOW * 1000 - HOUR,
      letter.status ?? "waiting",
      letter.sentAt ?? null,
    )
    .first<{ id: number }>();
  return row?.id ?? 0;
}

async function addFile(letterId: number, name: string): Promise<number> {
  const key = crypto.randomUUID();
  await env.FILES.put(key, new Uint8Array([1, 2, 3]));
  const row = await env.DB.prepare(
    "INSERT INTO files (letter_id, key, name, type, size) VALUES (?, ?, ?, 'image/jpeg', 3) RETURNING id",
  )
    .bind(letterId, key, await sealed(name))
    .first<{ id: number }>();
  return row?.id ?? 0;
}

let call: (path: string) => Promise<Response>;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["files", "recipients", "send_attempts", "letters", "uploads"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("UPDATE settings SET time_zone = NULL").run();
  const signer = await makeSigner();
  const app: Env = {
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
  call = (path) =>
    handle(
      new Request(`https://timecapsule.example${path}`, { headers: { "cf-access-jwt-assertion": token } }),
      app,
      keys,
      NOW,
    );
});

type Listing = { name: string; entries: { path: string; url: string }[] };
const listing = async () => (await (await call("/export")).json()) as Listing;
const paths = async () => (await listing()).entries.map((entry) => entry.path);
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("Export list", () => {
  it("names the zip after today and lists each letter's page and files, waiting letters included", async () => {
    const waiting = await addLetter({ subject: "To me" });
    const photo = await addFile(waiting, "photo.jpg");
    const sent = await addLetter({ subject: "Sent one", status: "sent", written: NOW * 1000 - 400 * 24 * HOUR });
    expect(await listing()).toEqual({
      name: `${FOLDER}.zip`,
      entries: [
        { path: `${FOLDER}/2025-12-11 Sent one/letter.html`, url: `/export/letters/${sent}` },
        { path: `${FOLDER}/2027-01-15 To me/letter.html`, url: `/export/letters/${waiting}` },
        { path: `${FOLDER}/2027-01-15 To me/photo.jpg`, url: `/letters/${waiting}/files/${photo}` },
      ],
    });
  });

  it("dates folders and the zip in the owner's zone", async () => {
    await env.DB.prepare("UPDATE settings SET time_zone = 'Pacific/Honolulu'").run();
    await addLetter();
    expect(await listing()).toMatchObject({
      name: "timecapsule-export-2027-01-14.zip",
      entries: [{ path: "timecapsule-export-2027-01-14/2027-01-14 To me/letter.html" }],
    });
  });

  it("gives letters with the same date and subject their own folders, and the same for file names", async () => {
    const first = await addLetter({ subject: "Same" });
    await addFile(first, "photo.jpg");
    await addFile(first, "PHOTO.jpg");
    await addLetter({ subject: "same" });
    expect(await paths()).toEqual([
      `${FOLDER}/2027-01-15 Same/letter.html`,
      `${FOLDER}/2027-01-15 Same/photo.jpg`,
      `${FOLDER}/2027-01-15 Same/PHOTO (2).jpg`,
      `${FOLDER}/2027-01-15 same (2)/letter.html`,
    ]);
  });

  it("replaces characters a computer cannot put in a file name", async () => {
    const id = await addLetter({ subject: '..a/b\\c:d*e?f"g<h>i|j\tk. ' });
    await addFile(id, ".hidden?.jpg");
    expect(await paths()).toEqual([
      `${FOLDER}/2027-01-15 ..a-b-c-d-e-f-g-h-i-j-k/letter.html`,
      `${FOLDER}/2027-01-15 ..a-b-c-d-e-f-g-h-i-j-k/hidden-.jpg`,
    ]);
  });

  it("renames names Windows keeps for itself, and treats the same name in another Unicode form as the same", async () => {
    const id = await addLetter({ subject: "NUL" });
    await addFile(id, "con.jpg");
    await addFile(id, "Lpt1.pdf");
    await addFile(id, "aux.notes.pdf");
    await addFile(id, "caf\u00e9.jpg");
    await addFile(id, "cafe\u0301.jpg");
    expect(await paths()).toEqual([
      `${FOLDER}/2027-01-15 NUL/letter.html`,
      `${FOLDER}/2027-01-15 NUL/con-.jpg`,
      `${FOLDER}/2027-01-15 NUL/Lpt1-.pdf`,
      `${FOLDER}/2027-01-15 NUL/aux-.notes.pdf`,
      `${FOLDER}/2027-01-15 NUL/caf\u00e9.jpg`,
      `${FOLDER}/2027-01-15 NUL/caf\u00e9 (2).jpg`,
    ]);
  });

  it("shortens long names to fit every file system, keeping a file's ending", async () => {
    const id = await addLetter({ subject: "é".repeat(200) });
    await addFile(id, `${"ü".repeat(196)}.jpg`);
    const [page, file] = await paths();
    const [, folder, fileName] = file.split("/");
    expect(page.split("/")[1]).toBe(folder);
    expect(bytes(folder)).toBeLessThanOrEqual(100);
    expect(folder).toMatch(/^2027-01-15 é+$/);
    expect(bytes(fileName)).toBeLessThanOrEqual(100);
    expect(fileName).toMatch(/^ü+\.jpg$/);
  });

  it("is empty with no letters", async () => {
    expect(await listing()).toEqual({ name: `${FOLDER}.zip`, entries: [] });
  });
});

describe("Exported letter page", () => {
  it("is a page of its own with the letter's details, text and files, waiting or not", async () => {
    const id = await addLetter({ subject: "Hello <you>" });
    await addFile(id, "photo one.jpg");
    await addFile(id, "photo one.jpg");
    await env.DB.prepare("INSERT INTO recipients (letter_id, email) VALUES (?, ?), (?, ?)")
      .bind(id, await sealed("friend@example.com"), id, await sealed("aunt@example.com"))
      .run();
    const response = await call(`/export/letters/${id}`);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const page = await response.text();
    expect(page).toContain(`<meta http-equiv="content-security-policy" content="script-src 'none'">`);
    expect(page).toContain("<title>Hello &lt;you&gt;</title>");
    expect(page).toContain("<h1>Hello &lt;you&gt;</h1>");
    expect(page).toMatch(/Sends Jan 15, 2028, 9:00\sAM Europe\/Istanbul/);
    expect(page).toContain("Written Jan 15, 2027");
    expect(page).toContain("Recipients besides you: friend@example.com, aunt@example.com");
    expect(page).toContain(BODY);
    expect(page).toContain(`<a href="photo%20one.jpg">photo one.jpg</a>`);
    expect(page).toContain(`<a href="photo%20one%20(2).jpg">photo one (2).jpg</a>`);
    expect(page).not.toContain("/settings");
  });

  it("shows when a sent letter went, and marks a failed one", async () => {
    const sent = await addLetter({ status: "sent", sentAt: NOW * 1000 - 24 * HOUR });
    expect(await (await call(`/export/letters/${sent}`)).text()).toContain("Sent Jan 14, 2027");
    const failed = await addLetter({ status: "failed" });
    expect(await (await call(`/export/letters/${failed}`)).text()).toContain("Not sent: Resend refused it");
  });

  it("says so when the letter's text cannot be opened, so the rest of the export goes on", async () => {
    const id = await addLetter({ body: new TextEncoder().encode("not sealed") });
    const response = await call(`/export/letters/${id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("This letter's text could not be opened.");
  });

  it("answers Not found for a letter that does not exist", async () => {
    expect((await call("/export/letters/999")).status).toBe(404);
  });
});
