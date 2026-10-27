import { applyD1Migrations, env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { finishButton } from "../src/ready";
import { importLetterKey, seal } from "../src/seal";
import { type SetupEnv, setup } from "../src/setup";
import { fakeAccount, OURS, PASTED, SCRIPT, VERSION } from "./fake-cloudflare";
import unknownTeam from "./fixtures/access-unknown-team.json";

const APP = `https://${SCRIPT}.owner.workers.dev`;
const NOW = 1_800_000_000_000;
const ENV: SetupEnv = {
  OWNER_EMAIL: "owner@example.com",
  SEND_DOMAIN: "letters.example",
  CF_VERSION_METADATA: { id: VERSION, tag: "", timestamp: "" },
  DB: testEnv.DB,
};
// Setup only checks that the team's certs page answers; it never reads the answer.
const TEAM = "https://example-team.cloudflareaccess.com";
const TEAM_NAME = new URL(TEAM).hostname.split(".")[0];

// Cloudflare's API goes to the stand-in account; a known team's certs page answers, and an unknown one answers with the
// status and type captured from a real one.
function world() {
  const account = fakeAccount();
  const certs: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    if (url.startsWith("https://api.cloudflare.com/")) return account.fetch(url, init);
    certs.push(url);
    return url === `${TEAM}/cdn-cgi/access/certs`
      ? Response.json({ keys: [] })
      : new Response("<!doctype html>", {
          status: unknownTeam.status,
          headers: { "content-type": unknownTeam.contentType },
        });
  };
  return { account, certs, fetcher };
}

const visit = (path: string, init?: RequestInit) => new Request(`${APP}${path}`, init);

async function setupPage(fetcher = world().fetcher) {
  const html = await (await setup(visit("/"), ENV, fetcher, NOW)).text();
  const key = /name="letter_key" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { html, key };
}

function finish(fields: Record<string, string>) {
  return visit("/setup", { method: "POST", body: new URLSearchParams(fields) });
}

async function ready() {
  const { key } = await setupPage();
  return { letter_key: key, saved: "on", team: TEAM_NAME, token: PASTED };
}

// The key the owner saved at the first setup.
const SAVED_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const restoring = (letterKey: string) => ({ restore: "1", letter_key: letterKey, team: TEAM_NAME, token: PASTED });

async function finishedAt(at: number) {
  await testEnv.DB.prepare("UPDATE settings SET setup_finished_at = ?").bind(at).run();
}

async function addLetter(secret: string) {
  const key = await importLetterKey(secret);
  await testEnv.DB.prepare(
    "INSERT INTO letters (subject, body, send_local, send_zone, written_at) VALUES ('To me', ?, '2028-01-15T09:00', 'UTC', 0)",
  )
    .bind(await seal("<p>Dear me</p>", key))
    .run();
}

describe("setup page", () => {
  beforeEach(async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
    await testEnv.DB.prepare("UPDATE settings SET setup_started_at = NULL, setup_finished_at = NULL").run();
    await testEnv.DB.prepare("DELETE FROM letters").run();
  });

  it("shows a new letter key, the team box and the pre-filled token link", async () => {
    const { html, key } = await setupPage();
    const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    expect(raw).toHaveLength(32);
    expect(html).toContain(`<code id="letter-key">${key}</code>`);
    expect(html).toContain('<form method="post" action="/setup"');
    expect(html).toContain('name="team"');
    const link = new URL(
      /href="(https:\/\/dash\.cloudflare\.com\/[^"]+)"/.exec(html)?.[1].replaceAll("&amp;", "&") ?? "",
    );
    expect(link.searchParams.get("to")).toBe("/:account/api-tokens");
    expect(link.searchParams.get("name")).toBe("timecapsule setup");
    expect(JSON.parse(link.searchParams.get("permissionGroupKeys") ?? "")).toEqual([
      { key: "account_settings", type: "read" },
      { key: "workers_scripts", type: "edit" },
      { key: "account_api_tokens", type: "edit" },
      { key: "access", type: "edit" },
    ]);
  });

  it("says setup is working once the form is sent, on the setup and the restore page, from inside the page", async () => {
    const SETUP_JS = '<script type="module" src="/setup.js"></script>';
    const fresh = (await setupPage()).html;
    expect(fresh).toContain(finishButton().text);
    expect(fresh).toContain(SETUP_JS);
    await finishedAt(NOW - 11 * 60_000);
    const restore = (await setupPage()).html;
    expect(restore).toContain("Restore timecapsule");
    expect(restore).toContain(finishButton().text);
    // Access can already catch a separate script on a restore; the working state does not need one.
    expect(restore).not.toContain(SETUP_JS);
  });

  it("makes a different letter key on every visit", async () => {
    expect((await setupPage()).key).not.toBe((await setupPage()).key);
  });

  it("refuses every other page before setup", async () => {
    for (const [method, path] of [
      ["GET", "/write"],
      ["GET", "/settings"],
      ["POST", "/letters"],
      ["GET", "/letters/1"],
      ["GET", "/export"],
    ]) {
      const response = await setup(visit(path, { method }), ENV, world().fetcher, NOW);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Setup is not finished");
    }
  });

  it("asks to save the letter key first, keeps the same key, and calls nobody", async () => {
    const { account, certs, fetcher } = world();
    const fields = await ready();
    const response = await setup(finish({ ...fields, saved: "" }), ENV, fetcher, NOW);
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain("Save your encryption key first");
    expect(html).toContain(`<code id="letter-key">${fields.letter_key}</code>`);
    expect(html).toContain(`name="team" value="${TEAM_NAME}"`);
    expect(account.calls).toEqual([]);
    expect(certs).toEqual([]);
  });

  it("recognises a pasted token ID and says which value to copy", async () => {
    const { account, fetcher } = world();
    const fields = { ...(await ready()), token: "0123456789abcdef0123456789abcdef" };
    const response = await setup(finish(fields), ENV, fetcher, NOW);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This is the token's ID");
    expect(account.calls).toEqual([]);
  });

  it("refuses a team name Zero Trust does not have, before using the token", async () => {
    const { account, certs, fetcher } = world();
    const response = await setup(finish({ ...(await ready()), team: "no-such-team" }), ENV, fetcher, NOW);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("There is no Zero Trust team named no-such-team");
    expect(certs).toEqual(["https://no-such-team.cloudflareaccess.com/cdn-cgi/access/certs"]);
    expect(account.calls).toEqual([]);
  });

  it("finishes setup with the shown key and the team typed as a name or as its address", async () => {
    for (const team of [TEAM_NAME.toUpperCase(), `${TEAM}/`]) {
      await testEnv.DB.prepare("UPDATE settings SET setup_finished_at = NULL").run();
      const { account, fetcher } = world();
      const fields = { ...(await ready()), team };
      const response = await setup(finish(fields), ENV, fetcher, NOW);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Setup is finished");
      expect(html).toContain("owner@example.com");
      // The page holds the owner 3 minutes, as the login takes over 2 to start working after a restore.
      expect(html).toContain('<p class="ready" data-wait="180000"><a class="button" href="/">Open timecapsule</a></p>');
      expect(html).toContain("Your login is getting ready: ");
      // Access now guards the stylesheet too, and the owner has not logged in yet, so the page brings its own.
      expect(html).toContain("<style>");
      expect(html).not.toContain("/style.css");
      expect(account.secrets.get("LETTER_KEY")).toBe(fields.letter_key);
      expect(account.secrets.get("ACCESS_TEAM_DOMAIN")).toBe(TEAM);
      expect(account.secrets.get("R2_ACCOUNT_ID")).toBe(OURS);
    }
  });

  it("refuses a token from another Cloudflare account", async () => {
    const { account, fetcher } = world();
    account.failWhen((call) =>
      call.path.startsWith(`/accounts/${OURS}/workers`)
        ? { status: 404, errors: [{ code: 10007, message: "not found" }] }
        : undefined,
    );
    const response = await setup(finish(await ready()), ENV, fetcher, NOW);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This token is for a different Cloudflare account");
  });

  it("says Cloudflare did not accept the token when it refuses it", async () => {
    const response = await setup(finish({ ...(await ready()), token: "wrong" }), ENV, world().fetcher, NOW);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Cloudflare did not accept this token");
  });

  it("can be tried again after a stop, with the same key", async () => {
    const { account, fetcher } = world();
    account.failWhen((call) =>
      call.method === "PUT" ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] } : undefined,
    );
    const fields = await ready();
    const stopped = await setup(finish(fields), ENV, fetcher, NOW);
    const html = await stopped.text();
    expect(stopped.status).toBe(502);
    expect(html).toContain("Setup stopped while it tried to store the app&#39;s settings");
    expect(html).toContain("Cloudflare said: 10000 Internal error");
    expect(html).toContain(`<code id="letter-key">${fields.letter_key}</code>`);

    account.failWhen(() => undefined);
    account.tokens.push({ id: "tok-pasted-2", name: "timecapsule setup", value: "second-token" });
    const retried = await setup(finish({ ...fields, token: "second-token" }), ENV, fetcher, NOW + 1000);
    expect(retried.status).toBe(200);
    expect(account.secrets.get("LETTER_KEY")).toBe(fields.letter_key);
  });

  it("recognises a pasted token ID with Bearer or spaces around it", async () => {
    const { account, fetcher } = world();
    const fields = { ...(await ready()), token: "Bearer 0123456789abcdef 0123456789abcdef\n" };
    const response = await setup(finish(fields), ENV, fetcher, NOW);
    expect(await response.text()).toContain("This is the token's ID");
    expect(account.calls).toEqual([]);
  });

  it("refuses to run without the owner's email, before using the token", async () => {
    const { account, certs, fetcher } = world();
    const response = await setup(finish(await ready()), { ...ENV, OWNER_EMAIL: " " }, fetcher, NOW);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("The owner's email address is not set");
    // A space around the address would make a login nobody's email matches.
    const padded = await setup(finish(await ready()), { ...ENV, OWNER_EMAIL: "owner@example.com " }, fetcher, NOW);
    expect(padded.status).toBe(500);
    expect(account.calls).toEqual([]);
    expect(certs).toEqual([]);
  });

  it("refuses to run while the sending domain is not a plain domain name, before using the token", async () => {
    const { account, certs, fetcher } = world();
    // Each would send from an address Resend refuses, so every letter and the failure alert would fail.
    for (const domain of [
      "",
      "https://example.com",
      "@example.com",
      "letters@example.com",
      "example.com/",
      " example.com",
      "exa mple.com",
      "example",
      "example..com",
    ]) {
      const response = await setup(finish(await ready()), { ...ENV, SEND_DOMAIN: domain }, fetcher, NOW);
      expect(response.status, domain).toBe(500);
      expect(await response.text()).toContain("The sending domain is not set, or is not a plain domain name");
    }
    expect(account.calls).toEqual([]);
    expect(certs).toEqual([]);
  });

  it("accepts a sending domain with more parts or capitals", async () => {
    for (const domain of ["mail.example.co.uk", "Example.com", "my-site.example"]) {
      const response = await setup(finish(await ready()), { ...ENV, SEND_DOMAIN: domain }, world().fetcher, NOW);
      expect(response.status, domain).toBe(200);
      await testEnv.DB.prepare("UPDATE settings SET setup_finished_at = NULL").run();
    }
  });

  it("never runs again once a setup finished, even from a page served by the old version", async () => {
    const { account, fetcher } = world();
    const fields = await ready();
    const oldPage = await ready();
    expect((await setup(finish(fields), ENV, fetcher, NOW)).status).toBe(200);
    account.tokens.push({ id: "tok-pasted-2", name: "timecapsule setup", value: "second-token" });
    const calls = account.calls.length;
    const again = await setup(finish({ ...oldPage, token: "second-token" }), ENV, fetcher, NOW + 60_000);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("Setup is already finished");
    expect(account.calls).toHaveLength(calls);

    // An old version shows no new letter key, which the owner could save over the real one.
    const { html, key } = await setupPage(fetcher);
    expect(key).toBe("");
    expect(html).toContain("Setup is finished");
    expect(html).toContain('data-wait="180000"');
  });

  it("runs one setup at a time", async () => {
    const { account, fetcher } = world();
    const fields = await ready();
    await testEnv.DB.prepare("UPDATE settings SET setup_started_at = ?")
      .bind(NOW - 1000)
      .run();
    const busy = await setup(finish(fields), ENV, fetcher, NOW);
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain("Setup is already running");
    expect(account.calls).toEqual([]);

    // A run that never finished stops holding setup after five minutes.
    const later = await setup(finish(fields), ENV, fetcher, NOW + 5 * 60_000);
    expect(later.status).toBe(200);
  });

  it("shows no new key while a setup is running, and says to wait", async () => {
    await testEnv.DB.prepare("UPDATE settings SET setup_started_at = ?")
      .bind(NOW - 1000)
      .run();
    const { html, key } = await setupPage();
    expect(key).toBe("");
    expect(html).not.toContain('id="letter-key"');
    expect(html).toContain("Setup is running");
    expect(html).toContain("Wait a minute, then reload this page.");

    // A run that never finished stops holding setup after five minutes.
    await testEnv.DB.prepare("UPDATE settings SET setup_started_at = ?")
      .bind(NOW - 5 * 60_000)
      .run();
    expect((await setupPage()).key).not.toBe("");
  });

  it("shows no restore form while a restore is running", async () => {
    await finishedAt(NOW - 11 * 60_000);
    await testEnv.DB.prepare("UPDATE settings SET setup_started_at = ?")
      .bind(NOW - 1000)
      .run();
    const { html } = await setupPage();
    expect(html).not.toContain("Restore timecapsule");
    expect(html).toContain("Setup is running");
  });

  it("asks for the saved key, not a new one, when the app lost its settings long after setup", async () => {
    await finishedAt(NOW - 11 * 60_000);
    const { html, key } = await setupPage();
    expect(html).toContain("Restore timecapsule");
    expect(html).toContain('name="restore" value="1"');
    expect(html).toContain("Paste your encryption key");
    expect(key).toBe("");
    expect(html).not.toContain('id="letter-key"');
  });

  it("restores the app with the saved key, pasted with spaces around it", async () => {
    await finishedAt(NOW - 11 * 60_000);
    await addLetter(SAVED_KEY);
    const { account, fetcher } = world();
    const response = await setup(finish(restoring(` ${SAVED_KEY}\n`)), ENV, fetcher, NOW);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Setup is finished");
    expect(account.secrets.get("LETTER_KEY")).toBe(SAVED_KEY);
    expect(account.secrets.get("R2_BUCKET")).toBe("timecapsule");
    expect(account.secrets.get("SETUP_DONE")).toBe("1");
    expect(await testEnv.DB.prepare("SELECT setup_finished_at FROM settings").first("setup_finished_at")).toBe(NOW);
  });

  it("refuses a key that does not open the letters, before using the token", async () => {
    await finishedAt(NOW - 11 * 60_000);
    await addLetter(SAVED_KEY);
    const { account, certs, fetcher } = world();
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const response = await setup(finish(restoring(other)), ENV, fetcher, NOW);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This key does not open your letters");
    expect(account.calls).toEqual([]);
    expect(certs).toEqual([]);
  });

  it("refuses a damaged key without showing a new one", async () => {
    await finishedAt(NOW - 11 * 60_000);
    const { account, fetcher } = world();
    const response = await setup(finish(restoring("not a key")), ENV, fetcher, NOW);
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain("This is not a timecapsule encryption key");
    expect(html).not.toContain('id="letter-key"');
    expect(account.calls).toEqual([]);
  });

  it("restores with any well-formed key when there are no letters", async () => {
    await finishedAt(NOW - 11 * 60_000);
    const { account, fetcher } = world();
    const response = await setup(finish(restoring(SAVED_KEY)), ENV, fetcher, NOW);
    expect(response.status).toBe(200);
    expect(account.secrets.get("LETTER_KEY")).toBe(SAVED_KEY);
  });

  it("refuses a restore in the minutes right after setup, while the settings still arrive", async () => {
    await finishedAt(NOW - 60_000);
    const { account, fetcher } = world();
    const response = await setup(finish(restoring(SAVED_KEY)), ENV, fetcher, NOW);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Setup is already finished");
    expect(account.calls).toEqual([]);
  });

  it("asks for the saved key when a page from before setup posts long after it", async () => {
    const { account, fetcher } = world();
    const oldPage = await ready();
    await finishedAt(NOW - 11 * 60_000);
    const response = await setup(finish(oldPage), ENV, fetcher, NOW);
    const html = await response.text();
    expect(response.status).toBe(409);
    expect(html).toContain("Restore timecapsule");
    expect(html).toContain("Paste your encryption key");
    expect(html).not.toContain(oldPage.letter_key);
    expect(account.calls).toEqual([]);
  });

  it("says to wait the full ten minutes right after setup, then reload to restore", async () => {
    await finishedAt(NOW - 60_000);
    const { html } = await setupPage();
    expect(html).toContain("Setup is finished");
    expect(html).toContain("If this page is still here 10 minutes after setup");
  });

  it("holds the owner only for what is left of the 3 minutes after setup", async () => {
    await finishedAt(NOW - 60_000);
    expect((await setupPage()).html).toContain('<p class="ready" data-wait="120000">');
    await finishedAt(NOW - 4 * 60_000);
    expect((await setupPage()).html).toContain('<p class="ready" data-wait="0">');
  });

  it("runs one restore at a time", async () => {
    await finishedAt(NOW - 11 * 60_000);
    await testEnv.DB.prepare("UPDATE settings SET setup_started_at = ?")
      .bind(NOW - 1000)
      .run();
    const { account, fetcher } = world();
    const response = await setup(finish(restoring(SAVED_KEY)), ENV, fetcher, NOW);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Setup is already running");
    expect(account.calls).toEqual([]);
  });

  it("says setup is finished when another tab's restore finished first", async () => {
    await finishedAt(NOW - 11 * 60_000);
    const { account, fetcher } = world();
    // The other tab finishes while this one checks the team name.
    const racing = async (url: string, init: RequestInit) => {
      if (!url.startsWith("https://api.cloudflare.com/")) await finishedAt(NOW - 1000);
      return fetcher(url, init);
    };
    const response = await setup(finish(restoring(SAVED_KEY)), ENV, racing, NOW);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Setup is already finished");
    expect(account.calls).toEqual([]);
  });

  it("refuses a restore before any setup finished", async () => {
    const { account, fetcher } = world();
    const response = await setup(finish(restoring(SAVED_KEY)), ENV, fetcher, NOW);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("This app has not been set up yet");
    expect(account.calls).toEqual([]);
  });

  it("refuses a finish sent from another website", async () => {
    const { account, fetcher } = world();
    const request = visit("/setup", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: new URLSearchParams(await ready()),
    });
    const response = await setup(request, ENV, fetcher, NOW);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("came from another website");
    expect(account.calls).toEqual([]);
  });

  it("only runs at the app's workers.dev address", async () => {
    const { account, fetcher } = world();
    const request = new Request("https://letters.example.com/setup", {
      method: "POST",
      body: new URLSearchParams(await ready()),
    });
    const response = await setup(request, ENV, fetcher, NOW);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("workers.dev");
    expect(account.calls).toEqual([]);
  });
});

describe("the running Worker", () => {
  const app = { ...ENV, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud-1", LETTER_KEY: "", FILES: testEnv.FILES };

  it("shows the setup page until setup is done", async () => {
    const response = await worker.fetch(visit("/"), app as never);
    expect(await response.text()).toContain("Set up timecapsule");
  });

  it("has no setup page once setup is done", async () => {
    const done = { ...app, SETUP_DONE: "1" };
    const page = await worker.fetch(visit("/"), done as never);
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain("Set up timecapsule");
    const post = await worker.fetch(finish({ token: PASTED }), done as never);
    expect(post.status).toBe(403);
  });
});
