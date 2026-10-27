import { applyD1Migrations, env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type Env, handle } from "../src/index";
import { AccessKeys } from "../src/login";
import { makeSigner } from "./token";

const ENV: Env = {
  ACCESS_TEAM_DOMAIN: "https://owner-team.cloudflareaccess.com",
  ACCESS_AUD: "aud-1",
  OWNER_EMAIL: "Owner@Example.com",
  LETTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  DB: testEnv.DB,
  FILES: testEnv.FILES,
};
const NOW = 1_800_000_000;

async function setup() {
  const signer = await makeSigner();
  const keys = new AccessKeys(ENV.ACCESS_TEAM_DOMAIN, async () => new Response(signer.jwks));
  const token = (email: string) =>
    signer.sign({ aud: [ENV.ACCESS_AUD], iss: ENV.ACCESS_TEAM_DOMAIN, email, exp: NOW + 3600 });
  const visit = (headers: Record<string, string> = {}) =>
    handle(new Request("https://timecapsule.example/", { headers }), ENV, keys, NOW);
  return { token, visit };
}

describe("every request", () => {
  beforeEach(() => applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS));

  it("shows the page to the owner", async () => {
    const { token, visit } = await setup();
    const response = await visit({ "cf-access-jwt-assertion": await token("owner@example.com") });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("<title>timecapsule</title>");
  });

  it("refuses a visitor without a login token, with a page in the app's look that carries its own styles", async () => {
    const { visit } = await setup();
    const response = await visit();
    expect(response.status).toBe(403);
    const page = await response.text();
    expect(page).toContain("Only the owner can open this timecapsule.");
    // Without a login, Access guards the stylesheet too, so the page brings its own and shows no menu.
    expect(page).toContain("<style>");
    expect(page).not.toContain("/style.css");
    expect(page).not.toContain('class="menu"');
  });

  it("refuses a visitor who only sends the email header", async () => {
    const { visit } = await setup();
    expect((await visit({ "cf-access-authenticated-user-email": "owner@example.com" })).status).toBe(403);
  });

  it("refuses a valid login for someone other than the owner", async () => {
    const { token, visit } = await setup();
    expect((await visit({ "cf-access-jwt-assertion": await token("someone@example.com") })).status).toBe(403);
  });

  it("refuses everyone when the app tag or the owner email is not set", async () => {
    const signer = await makeSigner();
    const keys = new AccessKeys(ENV.ACCESS_TEAM_DOMAIN, async () => new Response(signer.jwks));
    // Without an app tag, a token that names no app must not pass; without an owner email, nobody's token passes.
    const noApp = await signer.sign({ iss: ENV.ACCESS_TEAM_DOMAIN, email: "owner@example.com", exp: NOW + 3600 });
    const valid = await signer.sign({
      aud: [ENV.ACCESS_AUD],
      iss: ENV.ACCESS_TEAM_DOMAIN,
      email: "owner@example.com",
      exp: NOW + 3600,
    });
    for (const [unset, token] of [
      ["ACCESS_AUD", noApp],
      ["OWNER_EMAIL", valid],
    ]) {
      const env = { ...ENV, [unset]: undefined } as unknown as Env;
      const request = new Request("https://timecapsule.example/", { headers: { "cf-access-jwt-assertion": token } });
      expect((await handle(request, env, keys, NOW)).status).toBe(403);
    }
  });
});

describe("a request from another website", () => {
  beforeEach(() => applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS));

  // Every request that changes something, as the app's own pages send it.
  const CHANGES: [string, string][] = [
    ["POST", "/settings"],
    ["POST", "/letters"],
    ["POST", "/uploads?name=a.txt"],
    ["DELETE", "/uploads/1"],
    ["PUT", "/letters/1"],
    ["POST", "/letters/1/delete"],
  ];

  async function send(method: string, path: string, headers: Record<string, string>) {
    const signer = await makeSigner();
    const keys = new AccessKeys(ENV.ACCESS_TEAM_DOMAIN, async () => new Response(signer.jwks));
    const login = await signer.sign({
      aud: [ENV.ACCESS_AUD],
      iss: ENV.ACCESS_TEAM_DOMAIN,
      email: "owner@example.com",
      exp: NOW + 3600,
    });
    const request = new Request(`https://timecapsule.example${path}`, {
      method,
      headers: { "cf-access-jwt-assertion": login, ...headers },
      body: method === "POST" || method === "PUT" ? new URLSearchParams({ zone: "Asia/Tokyo" }) : undefined,
    });
    return handle(request, ENV, keys, NOW);
  }

  it("is refused for every request that changes something, though it carries the owner's login", async () => {
    for (const [method, path] of CHANGES) {
      const response = await send(method, path, { "sec-fetch-site": "cross-site" });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.text()).toContain("came from another website");
    }
  });

  it("is refused from another address on the same site, such as another workers.dev app", async () => {
    const response = await send("POST", "/letters/1/delete", { "sec-fetch-site": "same-site" });
    expect(response.status).toBe(403);
  });

  it("is refused by its Origin when the browser does not say which site sent it", async () => {
    const other = await send("POST", "/settings", { origin: "https://attacker.example" });
    expect(other.status).toBe(403);
  });

  // The settings form is the simplest change to check: a save answers 303 and stores the zone.
  const zone = () => testEnv.DB.prepare("SELECT time_zone FROM settings").first<string>("time_zone");

  it("lets the app's own pages change things", async () => {
    const own: Record<string, string>[] = [
      { "sec-fetch-site": "same-origin" },
      { origin: "https://timecapsule.example" },
    ];
    for (const headers of own) {
      await testEnv.DB.prepare("UPDATE settings SET time_zone = NULL").run();
      expect((await send("POST", "/settings", headers)).status).toBe(303);
      expect(await zone()).toBe("Asia/Tokyo");
    }
  });

  it("is refused when reloaded, as a reload can resend another site's refused request", async () => {
    expect((await send("POST", "/letters/1/delete", { "sec-fetch-site": "none" })).status).toBe(403);
  });

  it("lets a request through that names no site, as no current browser sends one", async () => {
    await testEnv.DB.prepare("UPDATE settings SET time_zone = NULL").run();
    expect((await send("POST", "/settings", {})).status).toBe(303);
    expect(await zone()).toBe("Asia/Tokyo");
  });

  it("can still open a page from a link on another site", async () => {
    const response = await send("GET", "/", { "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(200);
  });
});
