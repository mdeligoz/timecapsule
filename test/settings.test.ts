import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { version } from "../package.json";
import { type Env, handle } from "../src/index";
import { AccessKeys } from "../src/login";
import { importLetterKey, seal } from "../src/seal";
import { makeSigner } from "./token";

// 2027-01-15 08:00 UTC.
const NOW = 1_800_000_000;
const LETTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let call: (method: string, path: string, body?: BodyInit) => Promise<Response>;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM letters").run();
  await env.DB.prepare("UPDATE settings SET time_zone = NULL, failure_alert = 1, monthly_status = 1").run();
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
  call = (method, path, body) =>
    handle(
      new Request(`https://timecapsule.example${path}`, {
        method,
        body,
        headers: { "cf-access-jwt-assertion": token },
      }),
      app,
      keys,
      NOW,
    );
});

// The form as the browser posts it: a switch that is off is left out.
const save = (fields: Record<string, string>) => call("POST", "/settings", new URLSearchParams(fields));

const stored = () =>
  env.DB.prepare("SELECT time_zone, failure_alert, monthly_status FROM settings").first<{
    time_zone: string | null;
    failure_alert: number;
    monthly_status: number;
  }>();

describe("Settings screen", () => {
  it("starts with no zone picked and both emails on", async () => {
    const response = await call("GET", "/settings");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('<option value="">Pick a time zone</option>');
    expect(page).not.toMatch(/<option value="[^"]*" selected>/);
    expect(page).toContain('<input type="checkbox" name="failure_alert" checked>');
    expect(page).toContain('<input type="checkbox" name="monthly_status" checked>');
    expect(page).toContain('<script type="module" src="/settings.js"></script>');
  });

  it("offers UTC among the time zones, which the runtime's own list leaves out", async () => {
    expect(await (await call("GET", "/settings")).text()).toContain('<option value="UTC">UTC</option>');
  });

  it("saves the zone and both switches, then shows them saved", async () => {
    const response = await save({ zone: "Asia/Tokyo" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?saved=1");
    expect(await stored()).toEqual({ time_zone: "Asia/Tokyo", failure_alert: 0, monthly_status: 0 });

    const page = await (await call("GET", "/settings?saved=1")).text();
    expect(page).toContain('<p class="saved" role="status">Settings saved.</p>');
    expect(page).toContain('<option value="Asia/Tokyo" selected>');
    expect(page).toContain('<input type="checkbox" name="failure_alert">');
    expect(page).toContain('<input type="checkbox" name="monthly_status">');
  });

  it("switches each email back on", async () => {
    await save({ zone: "UTC" });
    await save({ zone: "UTC", failure_alert: "on", monthly_status: "on" });
    expect(await stored()).toEqual({ time_zone: "UTC", failure_alert: 1, monthly_status: 1 });
    await save({ zone: "UTC", monthly_status: "on" });
    expect(await stored()).toEqual({ time_zone: "UTC", failure_alert: 0, monthly_status: 1 });
  });

  it("refuses a zone that is not on the list and changes nothing", async () => {
    for (const zone of ["", "Not/AZone"]) {
      const response = await save({ zone, failure_alert: "on" });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Pick a time zone from the list.");
      expect(await stored()).toEqual({ time_zone: null, failure_alert: 1, monthly_status: 1 });
    }
  });

  it("shows the version that is running, as package.json names it, spelled as its release tag", async () => {
    const page = await (await call("GET", "/settings")).text();
    expect(page).toContain(`<p class="version">timecapsule v${version}</p>`);
    expect(page).toMatch(/<p class="version">timecapsule v\d+\.\d+\.\d+<\/p>/);
  });

  it("does not say saved before anything is saved", async () => {
    expect(await (await call("GET", "/settings")).text()).not.toContain("Settings saved.");
  });

  it("a saved zone dates the Letters screen and starts a new letter", async () => {
    await env.DB.prepare(
      "INSERT INTO letters (subject, body, send_local, send_zone, written_at) VALUES (?, x'00', '2030-01-01T09:00', 'UTC', ?)",
    )
      .bind(await seal("Hello", await importLetterKey(LETTER_KEY)), Date.parse("2026-01-01T20:00:00Z"))
      .run();
    // 20:00 UTC on Jan 1st is already Jan 2nd in Tokyo.
    await save({ zone: "Asia/Tokyo" });
    expect(await (await call("GET", "/")).text()).toContain("Written Jan 2, 2026");
    expect(await (await call("GET", "/write")).text()).toContain('<option value="Asia/Tokyo" selected>');
  });
});
