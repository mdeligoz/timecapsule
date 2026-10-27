import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type Env, handle } from "../src/index";
import { AccessKeys } from "../src/login";
import { importLetterKey, seal } from "../src/seal";
import { describe as describeAnswer } from "../src/send";
import badKey from "./fixtures/resend-bad-key.json";
import { makeSigner } from "./token";

const NOW = 1_800_000_000;
const TEXT = "the secret words of this letter";
const LETTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
// Sealed with the letter key, as the app stores it.
const sealed = async (text: string) => seal(text, await importLetterKey(LETTER_KEY));

type Letter = { subject: string; send: string; zone: string; written: string; status?: string; sent?: string };

async function addLetter(letter: Letter): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO letters (subject, body, send_local, send_zone, written_at, status, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(
      await sealed(letter.subject),
      new TextEncoder().encode(TEXT),
      letter.send,
      letter.zone,
      Date.parse(letter.written),
      letter.status ?? "waiting",
      letter.sent ? Date.parse(letter.sent) : null,
    )
    .first<{ id: number }>();
  return row?.id ?? 0;
}

// A try at sending that is to be repeated, recorded as the send job records it.
async function addTry(letterId: number, triedAt: string, detail: string): Promise<void> {
  await env.DB.prepare("INSERT INTO send_attempts (letter_id, tried_at, outcome, detail) VALUES (?, ?, 'retry', ?)")
    .bind(letterId, Date.parse(triedAt), detail)
    .run();
}

// The stamp on a letter: what the time is, then its date, hour and zone, each in its own part.
const STAMP = (label: string, date: string, time: string, zone: string) =>
  new RegExp(
    `<p class="when stamp"><span class="label">${label}</span> <span class="date">${date}</span> <span class="time">${time}\\sAM</span> <span class="zone">${zone}</span></p>`,
  );

let open: (path: string) => Promise<Response>;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM letters").run();
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
  open = (path) =>
    handle(
      new Request(`https://timecapsule.example${path}`, { headers: { "cf-access-jwt-assertion": token } }),
      app,
      keys,
      NOW,
    );
});

async function subjects(path: string): Promise<string[]> {
  const page = await (await open(path)).text();
  return [...page.matchAll(/<a class="letter" href="\/letters\/\d+">([^<]*)<\/a>/g)].map((m) => m[1]);
}

describe("Letters screen", () => {
  it("lists waiting letters soonest first, by the exact moment in each letter's own zone", async () => {
    // 01:00 in London is later than 09:00 in Auckland on the same date, though it reads earlier.
    await addLetter({ subject: "London", send: "2030-01-01T01:00", zone: "Europe/London", written: "2026-01-01" });
    await addLetter({ subject: "Auckland", send: "2030-01-01T09:00", zone: "Pacific/Auckland", written: "2026-01-02" });
    await addLetter({ subject: "Later", send: "2031-06-01T09:00", zone: "UTC", written: "2026-01-03" });
    expect(await subjects("/")).toEqual(["Auckland", "London", "Later"]);
  });

  it("sorts by writing date, newest first", async () => {
    await addLetter({ subject: "Old", send: "2030-01-01T09:00", zone: "UTC", written: "2026-01-01" });
    await addLetter({ subject: "New", send: "2031-01-01T09:00", zone: "UTC", written: "2026-03-01" });
    await addLetter({ subject: "Middle", send: "2029-01-01T09:00", zone: "UTC", written: "2026-02-01" });
    expect(await subjects("/?sort=written")).toEqual(["New", "Middle", "Old"]);
  });

  it("shows sent letters only on the Sent tab, most recently sent first", async () => {
    await addLetter({ subject: "Waiting", send: "2030-01-01T09:00", zone: "UTC", written: "2026-01-01" });
    await addLetter({
      subject: "Sent first",
      send: "2026-02-01T09:00",
      zone: "UTC",
      written: "2025-01-01",
      status: "sent",
      sent: "2026-02-01T09:00:30Z",
    });
    await addLetter({
      subject: "Sent last",
      send: "2026-03-01T09:00",
      zone: "UTC",
      written: "2025-01-02",
      status: "sent",
      sent: "2026-03-01T09:00:30Z",
    });
    expect(await subjects("/")).toEqual(["Waiting"]);
    expect(await subjects("/?tab=sent")).toEqual(["Sent last", "Sent first"]);
  });

  it("keeps a failed letter on the Waiting tab and marks it", async () => {
    await addLetter({
      subject: "Refused",
      send: "2026-01-01T09:00",
      zone: "UTC",
      written: "2025-01-01",
      status: "failed",
    });
    expect(await subjects("/")).toEqual(["Refused"]);
    const page = await (await open("/")).text();
    expect(page).toContain("Not sent: Resend refused it");
    expect(page).toMatch(STAMP("Was due", "Jan 1, 2026", "9:00", "UTC"));
  });

  it("marks a letter still being tried with Resend's last answer, from the first failed try", async () => {
    const id = await addLetter({ subject: "Stuck", send: "2026-01-01T09:00", zone: "UTC", written: "2025-01-01" });
    await addTry(id, "2026-01-01T09:00:00Z", "No answer.");
    await addTry(id, "2026-01-01T10:00:00Z", describeAnswer(badKey.status, badKey.body));
    await addLetter({ subject: "Not due", send: "2030-01-01T09:00", zone: "UTC", written: "2026-01-01" });
    const page = await (await open("/")).text();
    expect(page.match(/Not sent yet/g)).toHaveLength(1);
    expect(page).toContain("Not sent yet. Resend&#39;s answer: API key is invalid. Trying again every hour.");
    expect(page).toMatch(STAMP("Was due", "Jan 1, 2026", "9:00", "UTC"));
  });

  it("says Resend did not answer when the last try got no answer", async () => {
    const id = await addLetter({ subject: "Stuck", send: "2026-01-01T09:00", zone: "UTC", written: "2025-01-01" });
    await addTry(id, "2026-01-01T09:00:00Z", "The operation was aborted due to timeout");
    expect(await (await open("/")).text()).toContain("Not sent yet. Resend did not answer. Trying again every hour.");
  });

  it("keeps a single full stop after a message that ends in one, and says so when Resend gave no reason", async () => {
    const limited = await addLetter({
      subject: "Limited",
      send: "2026-01-01T09:00",
      zone: "UTC",
      written: "2025-01-01",
    });
    await addTry(
      limited,
      "2026-01-01T09:00:00Z",
      describeAnswer(429, { name: "rate_limit_exceeded", message: "Too many requests." }),
    );
    const down = await addLetter({ subject: "Down", send: "2026-01-01T10:00", zone: "UTC", written: "2025-01-01" });
    await addTry(down, "2026-01-01T10:00:00Z", describeAnswer(502, null));
    const page = await (await open("/")).text();
    expect(page).toContain("Not sent yet. Resend&#39;s answer: Too many requests. Trying again every hour.");
    expect(page).toContain("Not sent yet. Resend answered with an error and no reason. Trying again every hour.");
  });

  it("shows a waiting letter's subject and send time in its own zone, and never its text", async () => {
    await addLetter({ subject: "Hello", send: "2030-01-01T09:00", zone: "Europe/Istanbul", written: "2026-01-01" });
    await addLetter({
      subject: "Gone",
      send: "2026-02-01T09:00",
      zone: "UTC",
      written: "2025-01-01",
      status: "sent",
      sent: "2026-02-01T09:00:30Z",
    });
    const waiting = await (await open("/")).text();
    expect(waiting).toMatch(STAMP("Sends", "Jan 1, 2030", "9:00", "Europe/<wbr>Istanbul"));
    expect(waiting).toContain("Written Jan 1, 2026");
    expect(waiting).not.toContain(TEXT);
    expect(await (await open("/?tab=sent")).text()).not.toContain(TEXT);
  });

  it("shows the send time as a stamp, one part to a line, breaking a long zone at its slashes", async () => {
    await addLetter({
      subject: "Far",
      send: "2030-01-01T09:00",
      zone: "America/Argentina/Rio_Gallegos",
      written: "2026-01-01",
    });
    await addLetter({
      subject: "Gone",
      send: "2026-02-01T09:00",
      zone: "UTC",
      written: "2025-01-01",
      status: "sent",
      sent: "2026-02-01T09:00:30Z",
    });
    expect(await (await open("/")).text()).toMatch(
      STAMP("Sends", "Jan 1, 2030", "9:00", "America/<wbr>Argentina/<wbr>Rio Gallegos"),
    );
    expect(await (await open("/?tab=sent")).text()).toContain(
      '<p class="when stamp"><span class="label">Sent</span> <span class="date">Feb 1, 2026</span></p>',
    );
  });

  it("lists a letter whose subject cannot be opened, saying so, and still lists the others", async () => {
    await addLetter({ subject: "Readable", send: "2030-01-01T09:00", zone: "UTC", written: "2026-01-01" });
    const id = await addLetter({ subject: "Damaged", send: "2031-01-01T09:00", zone: "UTC", written: "2026-01-02" });
    await env.DB.prepare("UPDATE letters SET subject = x'00' WHERE id = ?").bind(id).run();
    expect(await subjects("/")).toEqual(["Readable", "Subject could not be opened"]);
  });

  it("escapes a subject, so it shows as text and never runs", async () => {
    await addLetter({ subject: "<script>x()</script>", send: "2030-01-01T09:00", zone: "UTC", written: "2026-01-01" });
    const page = await (await open("/")).text();
    expect(page).not.toContain("<script>x()");
    expect(page).toContain("&lt;script&gt;x()&lt;/script&gt;");
  });

  it("shows dates in UTC when the saved time zone is blank or unknown", async () => {
    await addLetter({ subject: "Hello", send: "2030-01-01T09:00", zone: "UTC", written: "2026-01-01T12:00:00Z" });
    for (const zone of ["", "Not/AZone"]) {
      await env.DB.prepare("UPDATE settings SET time_zone = ?").bind(zone).run();
      const response = await open("/");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Written Jan 1, 2026");
    }
  });

  it("says so when a tab is empty", async () => {
    expect(await (await open("/")).text()).toContain("No letters waiting.");
    expect(await (await open("/?tab=sent")).text()).toContain("No letters sent yet.");
  });

  it("links to writing a new letter and to Settings", async () => {
    const page = await (await open("/")).text();
    expect(page).toContain('<a class="button" href="/write">Write a new letter</a>');
    expect(page).toContain('<a href="/settings">Settings</a>');
  });

  it("shows the logo and a menu of Letters, Write and Settings, marking the screen shown", async () => {
    const letters = await (await open("/")).text();
    expect(letters).toContain('<svg class="logo"');
    expect(letters).toContain(
      '<nav class="menu"><a href="/" aria-current="page">Letters</a><a href="/write">Write</a><a href="/settings">Settings</a></nav>',
    );
    expect(await (await open("/write")).text()).toContain('<a href="/write" aria-current="page">Write</a>');
    expect(await (await open("/settings")).text()).toContain('<a href="/settings" aria-current="page">Settings</a>');
  });

  it("links the stylesheet on the screens shown after login", async () => {
    expect(await (await open("/")).text()).toContain('<link rel="stylesheet" href="/style.css">');
  });

  it("answers a page that does not exist with a page in the app's look, leading back to Letters", async () => {
    const response = await open("/nothing-here");
    expect(response.status).toBe(404);
    const page = await response.text();
    expect(page).toContain("<h1>Page not found</h1>");
    expect(page).toContain('<a href="/">Letters</a>');
  });
});
