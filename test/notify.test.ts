import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sendStatus } from "../src/notify";
import { importLetterKey, seal } from "../src/seal";
import type { SendEnv } from "../src/send";
// Resend's real answer, captured from its API.
import accepted from "./fixtures/resend-accepted.json";

const LETTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

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

const FEB_1 = Date.UTC(2027, 1, 1);
const MAR_1 = Date.UTC(2027, 2, 1);

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };
let sent: Sent[];
let answers: (() => Response)[];

// Stands in for Resend: records each request and gives the next queued answer, or accepts it.
const resend = async (url: string, init: RequestInit) => {
  // The date format puts a narrow no-break space before AM and PM; it is read here as a plain space.
  sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body).replaceAll("\u202f", " ")) });
  return (answers.shift() ?? (() => Response.json(accepted.body, { status: accepted.status })))();
};

async function settings(values: { zone?: string | null; on?: boolean; last?: string | null }): Promise<void> {
  await env.DB.prepare("UPDATE settings SET time_zone = ?, monthly_status = ?, last_status_month = ?")
    .bind(values.zone ?? null, values.on === false ? 0 : 1, values.last === undefined ? "2027-01" : values.last)
    .run();
}

async function addLetter(
  subject: string,
  send: string,
  zone = "UTC",
  status = "waiting",
  retryAt: number | null = null,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO letters (subject, body, send_local, send_zone, written_at, status, retry_at) VALUES (?, x'00', ?, ?, 0, ?, ?)",
  )
    .bind(await seal(subject, await importLetterKey(LETTER_KEY)), send, zone, status, retryAt)
    .run();
}

const lastMonth = () =>
  env.DB.prepare("SELECT last_status_month FROM settings").first<string | null>("last_status_month");

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM letters").run();
  await settings({});
  sent = [];
  answers = [];
});

describe("Monthly status email", () => {
  it("emails the owner on the first run of a month, with the letters waiting and the next send time", async () => {
    await addLetter("Later", "2027-03-01T09:00", "Europe/London");
    await addLetter("Sooner", "2027-02-10T09:00");
    await sendStatus(app, resend, FEB_1);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    expect(sent[0].headers.get("authorization")).toBe("Bearer re_test");
    expect(sent[0].body).toEqual({
      from: "Timecapsule <letters@letters.example>",
      to: ["owner@example.com"],
      subject: "Timecapsule: 2 letters waiting",
      text: '2 letters waiting. Next: "Sooner" on Feb 10, 2027, 9:00 AM UTC.\n',
    });
    expect(await lastMonth()).toBe("2027-02");
  });

  it("goes once per month, not once per run", async () => {
    await addLetter("To me", "2027-06-01T09:00");
    await sendStatus(app, resend, FEB_1);
    await sendStatus(app, resend, FEB_1 + 60_000);
    await sendStatus(app, resend, Date.UTC(2027, 1, 20));
    expect(sent).toHaveLength(1);
    await sendStatus(app, resend, MAR_1);
    expect(sent).toHaveLength(2);
  });

  it("sends nothing when switched off, and once switched on waits for the next month", async () => {
    await addLetter("To me", "2027-06-01T09:00");
    await settings({ on: false });
    await sendStatus(app, resend, FEB_1);
    await settings({ on: true, last: await lastMonth() });
    await sendStatus(app, resend, FEB_1 + 60_000);
    expect(sent).toEqual([]);
    await sendStatus(app, resend, MAR_1);
    expect(sent).toHaveLength(1);
  });

  it("waits for the next month after install, instead of sending on the first run", async () => {
    await addLetter("To me", "2027-06-01T09:00");
    await settings({ last: null });
    await sendStatus(app, resend, Date.UTC(2027, 1, 15));
    expect(sent).toEqual([]);
    expect(await lastMonth()).toBe("2027-02");
    await sendStatus(app, resend, MAR_1);
    expect(sent).toHaveLength(1);
  });

  it("skips a month with no letters waiting", async () => {
    await addLetter("Gone", "2027-01-10T09:00", "UTC", "sent");
    await sendStatus(app, resend, FEB_1);
    expect(sent).toEqual([]);
    expect(await lastMonth()).toBe("2027-02");
  });

  it("says the next letter is late when its time has passed and it is still being tried", async () => {
    await addLetter("Later", "2027-06-01T09:00");
    await addLetter("Stuck", "2027-01-31T09:00", "UTC", "waiting", FEB_1 + 1_800_000);
    await sendStatus(app, resend, FEB_1);
    expect(sent[0].body.text).toBe(
      '2 letters waiting. Next: "Stuck", due Jan 31, 2027, 9:00 AM UTC \u2014 late, still being tried.\n',
    );
  });

  it("does not call a letter late that is due now and waits its turn, untried", async () => {
    await addLetter("First", "2027-02-01T00:00");
    await sendStatus(app, resend, FEB_1 + 60_000);
    expect(sent[0].body.text).toBe('1 letter waiting. Next: "First" on Feb 1, 2027, 12:00 AM UTC.\n');
  });

  it("counts the letters marked Not sent", async () => {
    await addLetter("To me", "2027-06-01T09:00");
    await addLetter("Refused", "2027-01-10T09:00", "UTC", "failed");
    await sendStatus(app, resend, FEB_1);
    expect(sent[0].body).toMatchObject({
      subject: "Timecapsule: 1 letter waiting",
      text: '1 letter waiting. Next: "To me" on Jun 1, 2027, 9:00 AM UTC.\n1 letter not sent: Resend refused it.\n',
    });
  });

  it("still reports letters marked Not sent when none are waiting", async () => {
    await addLetter("Refused", "2027-01-10T09:00", "UTC", "failed");
    await addLetter("Refused too", "2027-01-11T09:00", "UTC", "failed");
    await sendStatus(app, resend, FEB_1);
    expect(sent[0].body).toMatchObject({
      subject: "Timecapsule: 2 letters not sent",
      text: "No letters waiting.\n2 letters not sent: Resend refused them.\n",
    });
  });

  it("starts the month in the owner's time zone", async () => {
    await addLetter("To me", "2027-06-01T09:00");
    // 22:00 on Jan 31 in New York.
    await settings({ zone: "America/New_York" });
    await sendStatus(app, resend, FEB_1 + 3 * 3_600_000);
    expect(sent).toEqual([]);
    // 00:00 on Feb 1 at UTC+14.
    await settings({ zone: "Pacific/Kiritimati" });
    await sendStatus(app, resend, FEB_1 - 14 * 3_600_000);
    expect(sent).toHaveLength(1);
  });

  it("does not send again when a new zone moves the owner back into the month before", async () => {
    await addLetter("To me", "2027-06-01T09:00");
    // 00:00 on Feb 1 at UTC+14.
    await settings({ zone: "Pacific/Kiritimati" });
    await sendStatus(app, resend, FEB_1 - 14 * 3_600_000);
    // Still Jan 31 in Honolulu, then Feb 1 there.
    await settings({ zone: "Pacific/Honolulu", last: await lastMonth() });
    await sendStatus(app, resend, FEB_1 - 13 * 3_600_000);
    await sendStatus(app, resend, FEB_1 + 10 * 3_600_000);
    expect(sent).toHaveLength(1);
  });

  it("uses UTC when the saved zone is unknown", async () => {
    await addLetter("To me", "2027-06-01T09:00");
    await settings({ zone: "Not/AZone" });
    await sendStatus(app, resend, FEB_1);
    expect(sent).toHaveLength(1);
  });

  it("tries once: an email Resend refused is not sent again that month", async () => {
    await addLetter("To me", "2027-06-01T09:00");
    answers.push(() => new Response(null, { status: 500 }));
    await sendStatus(app, resend, FEB_1);
    await sendStatus(app, resend, FEB_1 + 60_000);
    expect(sent).toHaveLength(1);
  });
});
