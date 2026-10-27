import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { importLetterKey, seal } from "../src/seal";
import { type SendEnv, sendDue } from "../src/send";
// Resend's real answers, captured from its API.
import accepted from "./fixtures/resend-accepted.json";
import rejected from "./fixtures/resend-rejected.json";

// 2027-01-15 08:00 UTC.
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const LETTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const BODY = "<p>Dear me,<br><strong>hello</strong></p>";

const app: SendEnv = {
  ACCESS_TEAM_DOMAIN: "https://owner-team.cloudflareaccess.com",
  ACCESS_AUD: "aud-1",
  OWNER_EMAIL: "owner@example.com",
  LETTER_KEY,
  DB: env.DB,
  FILES: env.FILES,
  RESEND_API_KEY: "re_test",
  SEND_DOMAIN: "letters.example",
  R2_ACCOUNT_ID: "acc123",
  R2_BUCKET: "timecapsule",
  R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secret",
};

type Letter = {
  subject?: string;
  send?: string;
  zone?: string;
  status?: string;
  retryAt?: number;
  recipients?: string[];
  files?: string[];
  body?: Uint8Array;
  written?: number;
  writtenZone?: string;
};

async function addLetter(letter: Letter = {}): Promise<number> {
  const key = await importLetterKey(LETTER_KEY);
  const row = await env.DB.prepare(
    "INSERT INTO letters (subject, body, send_local, send_zone, written_at, written_zone, status, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(
      await seal(letter.subject ?? "To me", key),
      letter.body ?? (await seal(BODY, key)),
      letter.send ?? "2027-01-15T08:00",
      letter.zone ?? "UTC",
      letter.written ?? 0,
      letter.writtenZone ?? "UTC",
      letter.status ?? "waiting",
      letter.retryAt ?? null,
    )
    .first<{ id: number }>();
  const id = row?.id ?? 0;
  for (const email of letter.recipients ?? []) {
    await env.DB.prepare("INSERT INTO recipients (letter_id, email) VALUES (?, ?)")
      .bind(id, await seal(email, key))
      .run();
  }
  for (const [i, name] of (letter.files ?? []).entries()) {
    await env.DB.prepare("INSERT INTO files (letter_id, key, name, type, size) VALUES (?, ?, ?, 'image/jpeg', 1)")
      .bind(id, `key${id}x${i}`, await seal(name, key))
      .run();
  }
  return id;
}

type Sent = { url: string; headers: Headers; body: Record<string, unknown>; raw: string };
let sent: Sent[];
let answers: (() => Response)[];

// Stands in for Resend: records each request and gives the next queued answer.
const resend = async (url: string, init: RequestInit) => {
  const raw = String(init.body);
  sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(raw), raw });
  const answer = answers.shift();
  if (!answer) throw new Error("No answer.");
  return answer();
};

const answer = (fixture: { status: number; body: unknown }) => () =>
  Response.json(fixture.body, { status: fixture.status });

const row = (id: number) =>
  env.DB.prepare("SELECT status, sent_at, retry_at FROM letters WHERE id = ?")
    .bind(id)
    .first<{ status: string; sent_at: number | null; retry_at: number | null }>();

const attempts = async (id: number) =>
  (
    await env.DB.prepare("SELECT tried_at, outcome, detail FROM send_attempts WHERE letter_id = ? ORDER BY id")
      .bind(id)
      .all<{ tried_at: number; outcome: string; detail: string }>()
  ).results;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["send_attempts", "files", "recipients", "letters"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("UPDATE settings SET failure_alert = 1, time_zone = NULL").run();
  sent = [];
  answers = [];
});

describe("Send job", () => {
  it("marks a letter Resend accepted as sent", async () => {
    const id = await addLetter();
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    expect(await row(id)).toEqual({ status: "sent", sent_at: NOW, retry_at: null });
    expect(await attempts(id)).toMatchObject([{ tried_at: NOW, outcome: "sent" }]);
  });

  it("tries a letter Resend refused as invalid once more, an hour later", async () => {
    const id = await addLetter();
    answers.push(answer(rejected));
    await sendDue(app, resend, NOW);
    expect(await row(id)).toEqual({ status: "waiting", sent_at: null, retry_at: NOW + HOUR });
    const [attempt] = await attempts(id);
    expect(attempt.outcome).toBe("retry");
    expect(attempt.detail).toContain("Invalid `to` field");
  });

  it("marks a letter failed when Resend refuses it as invalid a second time", async () => {
    const id = await addLetter();
    answers.push(answer(rejected), () => new Response(null, { status: 500 }), answer(rejected));
    await sendDue(app, resend, NOW);
    await sendDue(app, resend, NOW + HOUR);
    expect((await row(id))?.status).toBe("waiting");
    await sendDue(app, resend, NOW + 2 * HOUR);
    expect(await row(id)).toEqual({ status: "failed", sent_at: null, retry_at: null });
    expect((await attempts(id)).map((a) => a.outcome)).toEqual(["retry", "retry", "failed"]);
  });

  it("emails the owner once when a letter fails, with Resend's reason, if the failure alert is on", async () => {
    await addLetter({ subject: "Hello future", recipients: ["a@x.io"], files: ["photo.jpg"] });
    answers.push(answer(rejected), answer(rejected), answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent).toHaveLength(1);
    await sendDue(app, resend, NOW + HOUR);
    expect(sent).toHaveLength(3);
    expect(sent[2].url).toBe("https://api.resend.com/emails");
    expect(sent[2].headers.get("authorization")).toBe("Bearer re_test");
    // The date format puts a narrow no-break space before AM and PM; it is read here as a plain space.
    expect({ ...sent[2].body, text: String(sent[2].body.text).replaceAll("\u202f", " ") }).toEqual({
      from: "Timecapsule <letters@letters.example>",
      to: ["owner@example.com"],
      subject: "Not sent: Hello future",
      text:
        'Your letter "Hello future", due Jan 15, 2027, 8:00 AM UTC, was not sent.\n' +
        `Resend refused it: ${rejected.body.message}\n` +
        'It will not be tried again. It stays on your Waiting list, marked "Not sent".\n',
    });
  });

  it("sends no alert when the failure alert is off", async () => {
    await env.DB.prepare("UPDATE settings SET failure_alert = 0").run();
    const id = await addLetter();
    answers.push(answer(rejected), answer(rejected));
    await sendDue(app, resend, NOW);
    await sendDue(app, resend, NOW + HOUR);
    expect((await row(id))?.status).toBe("failed");
    expect(sent).toHaveLength(2);
  });

  it("tries the alert once: a refused alert leaves the letter failed and is not sent again", async () => {
    const id = await addLetter();
    answers.push(answer(rejected), answer(rejected), () => new Response(null, { status: 500 }));
    await sendDue(app, resend, NOW);
    await sendDue(app, resend, NOW + HOUR);
    await sendDue(app, resend, NOW + 2 * HOUR);
    expect(sent).toHaveLength(3);
    expect(await row(id)).toEqual({ status: "failed", sent_at: null, retry_at: null });
  });

  it("names Resend's refusal plainly when it gave no reason", async () => {
    await addLetter();
    answers.push(
      ...Array.from({ length: 2 }, () => () => Response.json({ name: "validation_error" }, { status: 400 })),
      answer(accepted),
    );
    await sendDue(app, resend, NOW);
    await sendDue(app, resend, NOW + HOUR);
    expect(sent[2].body.text).toContain("\nResend refused it.\n");
  });

  it("treats a 400 like a 422", async () => {
    const id = await addLetter();
    answers.push(
      ...Array.from({ length: 2 }, () => () => Response.json({ name: "validation_error" }, { status: 400 })),
    );
    await sendDue(app, resend, NOW);
    expect((await row(id))?.status).toBe("waiting");
    await sendDue(app, resend, NOW + HOUR);
    expect((await row(id))?.status).toBe("failed");
  });

  it("tries again an hour later after an error", async () => {
    const id = await addLetter();
    answers.push(() => Response.json({ name: "internal_server_error" }, { status: 500 }));
    await sendDue(app, resend, NOW);
    expect(await row(id)).toEqual({ status: "waiting", sent_at: null, retry_at: NOW + HOUR });
    expect(await attempts(id)).toMatchObject([{ outcome: "retry" }]);
  });

  it("tries again an hour later when Resend does not answer", async () => {
    const id = await addLetter();
    await sendDue(app, resend, NOW);
    expect(await row(id)).toMatchObject({ status: "waiting", retry_at: NOW + HOUR });
  });

  it("tries again later, rather than failing the letter, when the API key is wrong or the day's limit is reached", async () => {
    for (const status of [401, 403, 429]) {
      const id = await addLetter();
      answers.push(() => Response.json({ name: "x" }, { status }));
      await sendDue(app, resend, NOW);
      expect(await row(id)).toMatchObject({ status: "waiting", retry_at: NOW + HOUR });
    }
  });

  it("does not try again before the hour is up, then does", async () => {
    const id = await addLetter();
    answers.push(() => new Response(null, { status: 500 }));
    await sendDue(app, resend, NOW);
    await sendDue(app, resend, NOW + HOUR - 60_000);
    expect(sent).toHaveLength(1);
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW + HOUR);
    expect(sent).toHaveLength(2);
    expect((await row(id))?.status).toBe("sent");
  });

  it("sends a retry within 24 hours exactly as the first try, under the same idempotency key", async () => {
    await addLetter({ files: ["photo.jpg"] });
    answers.push(
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
    );
    await sendDue(app, resend, NOW);
    await sendDue(app, resend, NOW + 23 * HOUR);
    expect(sent[1].raw).toBe(sent[0].raw);
    expect(sent[1].headers.get("idempotency-key")).toBe(sent[0].headers.get("idempotency-key"));
  });

  it("signs new links once Resend has forgotten the first try, and keeps the key", async () => {
    await addLetter({ files: ["photo.jpg"] });
    answers.push(...Array.from({ length: 3 }, () => () => new Response(null, { status: 500 })));
    await sendDue(app, resend, NOW);
    await sendDue(app, resend, NOW + 24 * HOUR);
    await sendDue(app, resend, NOW + 25 * HOUR);
    expect(sent[1].raw).not.toBe(sent[0].raw);
    expect(sent[2].raw).toBe(sent[1].raw);
    expect(new Set(sent.map((s) => s.headers.get("idempotency-key"))).size).toBe(1);
  });

  it("uses the letter's own random send key as the idempotency key", async () => {
    const id = await addLetter();
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    const key = await env.DB.prepare("SELECT send_key FROM letters WHERE id = ?").bind(id).first("send_key");
    expect(sent[0].headers.get("idempotency-key")).toBe(key);
  });

  it("calls Resend's send endpoint with the API key", async () => {
    await addLetter();
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    expect(sent[0].headers.get("authorization")).toBe("Bearer re_test");
    expect(sent[0].headers.get("content-type")).toBe("application/json");
  });

  it("sends the stored HTML with the letter's subject, from Timecapsule, with replies to the owner", async () => {
    await addLetter({ subject: "Hello future" });
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent[0].body).toMatchObject({
      from: "Timecapsule <letters@letters.example>",
      reply_to: "owner@example.com",
      subject: "Hello future",
    });
    expect(sent[0].body.html).toContain(BODY);
  });

  it("ends the email with when the letter was written, after the letter", async () => {
    // 2026-12-31 12:00 UTC.
    await addLetter({ written: Date.UTC(2026, 11, 31, 12) });
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    const html = String(sent[0].body.html);
    const footer = "Written on Dec 31st, 2026, sent with timecapsule";
    expect(html).toContain(footer);
    expect(html.indexOf(footer)).toBeGreaterThan(html.indexOf(BODY));
  });

  it("dates the footer in the owner's zone when writing, like the subject, not the letter's send zone", async () => {
    // 2026-12-31 12:00 UTC is already Jan 1st in Kiribati (UTC+14).
    await addLetter({ written: Date.UTC(2026, 11, 31, 12), writtenZone: "Pacific/Kiritimati", zone: "UTC" });
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent[0].body.html).toContain("Written on Jan 1st, 2027, sent with timecapsule");
  });

  it("sends a retry exactly as the first try after the owner changes their zone", async () => {
    await addLetter({ written: Date.UTC(2026, 11, 31, 12) });
    answers.push(
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
    );
    await sendDue(app, resend, NOW);
    await env.DB.prepare("UPDATE settings SET time_zone = 'Pacific/Kiritimati'").run();
    await sendDue(app, resend, NOW + HOUR);
    expect(sent[1].raw).toBe(sent[0].raw);
  });

  it("puts a letter with only the owner in To", async () => {
    await addLetter();
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent[0].body.to).toEqual(["owner@example.com"]);
    expect(sent[0].body).not.toHaveProperty("bcc");
  });

  it("puts the owner in To and everyone else in BCC", async () => {
    await addLetter({ recipients: ["a@x.io", "b@x.io"] });
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent[0].body.to).toEqual(["owner@example.com"]);
    expect(sent[0].body.bcc).toEqual(["a@x.io", "b@x.io"]);
  });

  it("attaches each file from a signed R2 link that lasts 25 hours", async () => {
    const id = await addLetter({ files: ["photo.jpg", "film.mp4"] });
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    const attachments = sent[0].body.attachments as { filename: string; path: string }[];
    expect(attachments.map((a) => a.filename)).toEqual(["photo.jpg", "film.mp4"]);
    const link = new URL(attachments[0].path);
    expect(`${link.origin}${link.pathname}`).toBe(`https://acc123.r2.cloudflarestorage.com/timecapsule/key${id}x0`);
    expect(link.searchParams.get("X-Amz-Expires")).toBe("90000");
    expect(link.searchParams.get("X-Amz-Date")).toBe("20270115T080000Z");
    expect(link.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(String(sent[0].body.html)).not.toContain("X-Amz");
  });

  it("with 3 due letters, three runs send one each, oldest first", async () => {
    // 09:00 in Istanbul is 06:00 UTC; 07:00 in London is 07:00 UTC; 08:00 UTC is now.
    const london = await addLetter({ subject: "London", send: "2027-01-15T07:00", zone: "Europe/London" });
    const utc = await addLetter({ subject: "UTC", send: "2027-01-15T08:00", zone: "UTC" });
    const istanbul = await addLetter({ subject: "Istanbul", send: "2027-01-15T09:00", zone: "Europe/Istanbul" });
    answers.push(answer(accepted), answer(accepted), answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent.map((s) => s.body.subject)).toEqual(["Istanbul"]);
    await sendDue(app, resend, NOW + 60_000);
    await sendDue(app, resend, NOW + 120_000);
    expect(sent.map((s) => s.body.subject)).toEqual(["Istanbul", "London", "UTC"]);
    for (const id of [london, utc, istanbul]) expect((await row(id))?.status).toBe("sent");
  });

  it("does not send a letter before its moment in its own zone, though its local time has passed in UTC", async () => {
    // 09:00 in New York is 14:00 UTC.
    await addLetter({ send: "2027-01-15T09:00", zone: "America/New_York" });
    await sendDue(app, resend, NOW);
    expect(sent).toEqual([]);
  });

  it("leaves sent, failed and later letters alone", async () => {
    await addLetter({ status: "sent" });
    await addLetter({ status: "failed" });
    await addLetter({ send: "2027-01-15T09:00" });
    await sendDue(app, resend, NOW);
    expect(sent).toEqual([]);
  });

  it("does not let a letter waiting for its retry hold up another", async () => {
    await addLetter({ subject: "Waiting for retry", send: "2027-01-15T06:00", retryAt: NOW + HOUR });
    await addLetter({ subject: "Due", send: "2027-01-15T07:00" });
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent.map((s) => s.body.subject)).toEqual(["Due"]);
  });

  it("skips a letter whose send time cannot be worked out, and sends the next", async () => {
    await addLetter({ subject: "Broken", send: "2027-01-15T06:00", zone: "Not/AZone" });
    await addLetter({ subject: "Due", send: "2027-01-15T07:00" });
    answers.push(answer(accepted));
    await sendDue(app, resend, NOW);
    expect(sent.map((s) => s.body.subject)).toEqual(["Due"]);
  });

  it("tries a letter that cannot be opened again an hour later, without calling Resend or counting a try", async () => {
    const id = await addLetter({ body: new Uint8Array(40) });
    await sendDue(app, resend, NOW);
    expect(sent).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "waiting", retry_at: NOW + HOUR });
    expect(await attempts(id)).toEqual([]);
  });

  it("starts Resend's 24 hours at the first real call, not at a try that never reached Resend", async () => {
    const id = await addLetter({ body: new Uint8Array(40), files: ["photo.jpg"] });
    await sendDue(app, resend, NOW);
    const key = await importLetterKey(LETTER_KEY);
    await env.DB.prepare("UPDATE letters SET body = ? WHERE id = ?")
      .bind(await seal(BODY, key), id)
      .run();
    answers.push(
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
    );
    await sendDue(app, resend, NOW + 23 * HOUR);
    await sendDue(app, resend, NOW + 24 * HOUR);
    expect(sent[1].raw).toBe(sent[0].raw);
  });

  it("never writes the letter's text into the send record", async () => {
    const id = await addLetter();
    answers.push(() => new Response(`echo ${BODY}`, { status: 500 }));
    await sendDue(app, resend, NOW);
    expect((await attempts(id))[0].detail).not.toContain("hello");
  });
});
