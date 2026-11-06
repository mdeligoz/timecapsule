import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { changeAddress } from "../src/own-address";
import { fakeAccount, OURS, PASTED, SCRIPT } from "./fake-cloudflare";

const AUD = "aud-ours";
const WORKERS_DEV = `${SCRIPT}.owner.workers.dev`;
const ENV = { DB: env.DB, ACCESS_AUD: AUD };
const POLICY = {
  id: "policy-owner",
  name: "Owner only",
  decision: "allow",
  include: [{ email: { email: "owner@example.com" } }],
  precedence: 1,
};
const page = (host: string) => [{ type: "public", uri: WORKERS_DEV }, ...(host ? [{ type: "public", uri: host }] : [])];

// The owner's account after setup: the app's login on its workers.dev address only, and the domain owner.example.
function installed() {
  const account = fakeAccount();
  account.apps.push({
    id: "app-ours",
    aud: AUD,
    name: SCRIPT,
    domain: WORKERS_DEV,
    self_hosted_domains: [WORKERS_DEV],
    destinations: page(""),
    policies: [POLICY],
  });
  return account;
}

type Account = ReturnType<typeof installed>;
const login = (account: Account) => account.apps.find((app) => app.aud === AUD);
const addresses = (account: Account) => account.addresses.map((a) => [a.hostname, a.service, a.environment]);
const stored = () => env.DB.prepare("SELECT address FROM settings").first<string | null>("address");
const change = (account: Account, address: string, token = PASTED) =>
  changeAddress(
    new Request("https://time.owner.example/settings/address", {
      method: "POST",
      body: new URLSearchParams({ address, token }),
    }),
    ENV,
    account.fetch,
  );
// Each change deletes its token, so the next one needs a new one.
const newToken = (account: Account, value: string) =>
  account.tokens.push({ id: `tok-${value}`, name: "timecapsule address", value });

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("UPDATE settings SET address = NULL").run();
});

describe("own address", () => {
  it("puts the app on a new address and its login, keeps workers.dev, saves it and deletes the token", async () => {
    const account = installed();
    const response = await change(account, "time.owner.example");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("Your address is now time.owner.example.");
    expect(text).toContain('<a href="https://time.owner.example/">open time.owner.example</a>');
    expect(text).toContain("The token has been deleted.");
    expect(addresses(account)).toEqual([["time.owner.example", SCRIPT, "production"]]);
    expect(login(account)).toMatchObject({
      aud: AUD,
      domain: WORKERS_DEV,
      self_hosted_domains: [WORKERS_DEV, "time.owner.example"],
      destinations: page("time.owner.example"),
      policies: [POLICY],
    });
    expect(await stored()).toBe("time.owner.example");
    expect(account.tokens.some((t) => t.value === PASTED)).toBe(false);
  });

  it("moves to another address, taking the old one off the app and the login", async () => {
    const account = installed();
    await change(account, "time.owner.example");
    newToken(account, "second");
    const response = await change(account, "letters.owner.example", "second");
    expect(response.status).toBe(200);
    expect(addresses(account)).toEqual([["letters.owner.example", SCRIPT, "production"]]);
    expect(login(account)?.destinations).toEqual(page("letters.owner.example"));
    expect(await stored()).toBe("letters.owner.example");
  });

  it("removes the address when the box is left empty, leaving the app on its workers.dev address", async () => {
    const account = installed();
    await change(account, "time.owner.example");
    newToken(account, "second");
    const text = await (await change(account, "", "second")).text();
    expect(text).toContain("Your own address is removed. timecapsule is at its workers.dev address only.");
    expect(addresses(account)).toEqual([]);
    expect(login(account)).toMatchObject({ self_hosted_domains: [WORKERS_DEV], destinations: page("") });
    expect(await stored()).toBeNull();
  });

  it("leaves other Workers' addresses alone", async () => {
    const account = installed();
    account.addresses.push({
      id: "addr-blog",
      hostname: "blog.owner.example",
      service: "blog",
      environment: "production",
    });
    await change(account, "time.owner.example");
    expect(addresses(account)).toEqual([
      ["blog.owner.example", "blog", "production"],
      ["time.owner.example", SCRIPT, "production"],
    ]);
  });

  it("leaves an address attached to the Worker by hand that the login never covered", async () => {
    const account = installed();
    account.addresses.push({
      id: "addr-hand",
      hostname: "hand.owner.example",
      service: SCRIPT,
      environment: "production",
    });
    await change(account, "time.owner.example");
    expect(addresses(account)).toEqual([
      ["hand.owner.example", SCRIPT, "production"],
      ["time.owner.example", SCRIPT, "production"],
    ]);
  });

  it("takes an address the login covered off the app when moving, though Settings never saved it", async () => {
    const account = installed();
    account.addresses.push({
      id: "addr-time",
      hostname: "time.owner.example",
      service: SCRIPT,
      environment: "production",
    });
    const app = login(account);
    if (app) app.destinations = page("time.owner.example");
    await change(account, "letters.owner.example");
    expect(addresses(account)).toEqual([["letters.owner.example", SCRIPT, "production"]]);
  });

  it("refuses an address another Worker already has, before changing anything, and deletes the token", async () => {
    const account = installed();
    account.addresses.push({
      id: "addr-blog",
      hostname: "time.owner.example",
      service: "blog",
      environment: "production",
    });
    const response = await change(account, "time.owner.example");
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).toContain("time.owner.example is already the address of another Worker, blog. Pick another address.");
    expect(text).toContain("The token has been deleted.");
    expect(addresses(account)).toEqual([["time.owner.example", "blog", "production"]]);
    expect(account.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("says Cloudflare refused the address and to pick another, rather than to try the same one again", async () => {
    const account = installed();
    account.failWhen((call) =>
      call.method === "PUT" && call.path.endsWith("/workers/domains")
        ? { status: 409, errors: [{ code: 100117, message: "Refused" }] }
        : undefined,
    );
    const response = await change(account, "time.owner.example");
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).toContain("Cloudflare refused time.owner.example. Pick another address.");
    expect(text).toContain("Cloudflare said: 100117 Refused");
    expect(text).not.toContain("press Change address again");
  });

  it("takes the previous address off on the next try, when taking it off failed", async () => {
    const account = installed();
    await change(account, "time.owner.example");
    newToken(account, "second");
    account.failWhen((call) =>
      call.method === "DELETE" && call.path.includes("/workers/domains/")
        ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
        : undefined,
    );
    const failed = await change(account, "letters.owner.example", "second");
    const text = await failed.text();
    expect(failed.status).toBe(502);
    expect(text).toContain("Changing the address stopped while it tried to take the previous address off the app.");
    // The login already has the new address, so the old one is shown nowhere, here or on Settings.
    expect(await stored()).toBe("letters.owner.example");
    expect(text).not.toContain("time.owner.example");
    account.failWhen(() => undefined);
    newToken(account, "third");
    expect((await change(account, "letters.owner.example", "third")).status).toBe(200);
    expect(addresses(account)).toEqual([["letters.owner.example", SCRIPT, "production"]]);
    expect(await stored()).toBe("letters.owner.example");
  });

  it("after two changes that could not take their old address off, the next one takes both off", async () => {
    const account = installed();
    await change(account, "time.owner.example");
    account.failWhen((call) =>
      call.method === "DELETE" && call.path.includes("/workers/domains/")
        ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
        : undefined,
    );
    newToken(account, "second");
    expect((await change(account, "letters.owner.example", "second")).status).toBe(502);
    newToken(account, "third");
    expect((await change(account, "mail.owner.example", "third")).status).toBe(502);
    account.failWhen(() => undefined);
    newToken(account, "fourth");
    expect((await change(account, "mail.owner.example", "fourth")).status).toBe(200);
    expect(addresses(account)).toEqual([["mail.owner.example", SCRIPT, "production"]]);
  });

  it("takes a new address back off the app when the login could not be changed, leaving the old one working", async () => {
    const account = installed();
    await change(account, "time.owner.example");
    newToken(account, "second");
    account.failWhen((call) =>
      call.method === "PUT" && call.path.includes("/access/apps/")
        ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
        : undefined,
    );
    expect((await change(account, "letters.owner.example", "second")).status).toBe(502);
    expect(addresses(account)).toEqual([["time.owner.example", SCRIPT, "production"]]);
    expect(login(account)?.destinations).toEqual(page("time.owner.example"));
    expect(await stored()).toBe("time.owner.example");
  });

  it("deletes the token when the app's addresses cannot be read", async () => {
    const account = installed();
    account.failWhen((call) =>
      call.method === "GET" && call.path.endsWith("/workers/domains")
        ? { status: 403, errors: [{ code: 10000, message: "Authentication error" }] }
        : undefined,
    );
    const response = await change(account, "time.owner.example");
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain("Changing the address stopped while it tried to read the app&#39;s addresses.");
    expect(text).toContain("The token has been deleted.");
    expect(account.tokens.some((t) => t.value === PASTED)).toBe(false);
  });

  it("keeps what was typed in the box when it is refused, so pressing again cannot set the old address", async () => {
    const account = installed();
    await env.DB.prepare("UPDATE settings SET address = 'time.owner.example'").run();
    const text = await (await change(account, "tme.owner")).text();
    expect(text).toContain('<input name="address" value="tme.owner"');
    expect(text).toContain('timecapsule is also at <a href="https://time.owner.example/">time.owner.example</a>.');
  });

  it("takes the address typed as a link, in capitals or with a slash at the end", async () => {
    for (const typed of ["https://Time.Owner.Example/", " time.owner.example. "]) {
      const account = installed();
      expect((await change(account, typed)).status, typed).toBe(200);
      expect(await stored(), typed).toBe("time.owner.example");
    }
  });

  it("refuses what is not an address, before using the token", async () => {
    for (const [typed, shows] of [
      ["owner example", "Type only the address, for example time.example.com."],
      ["time.owner.example/letters", "Type only the address, for example time.example.com."],
      ["localhost", "Type only the address, for example time.example.com."],
      ["-time.owner.example", "Type only the address, for example time.example.com."],
      ["time-.owner.example", "Type only the address, for example time.example.com."],
      [`${"a".repeat(64)}.owner.example`, "Type only the address, for example time.example.com."],
      ["1.2.3.4", "Type only the address, for example time.example.com."],
      [`${"a".repeat(250)}.example`, "An address can be at most 253 characters."],
      [WORKERS_DEV, "This is the workers.dev address, which always works. Type an address on your own domain."],
    ]) {
      const account = installed();
      const response = await change(account, typed);
      expect(response.status, typed).toBe(400);
      expect(await response.text(), typed).toContain(shows);
      expect(account.calls, typed).toEqual([]);
    }
  });

  it("refuses the token's ID, before using it", async () => {
    const account = installed();
    const response = await change(account, "time.owner.example", "0123456789abcdef0123456789abcdef");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This is the token's ID, not the token.");
    expect(account.calls).toEqual([]);
  });

  it("says when the address is not on a domain in this Cloudflare account, changes nothing and deletes the token", async () => {
    const account = installed();
    const response = await change(account, "time.example.com");
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).toContain(
      "time.example.com is not on a domain in this Cloudflare account. Add its domain to the account, or pick an address on one that is.",
    );
    expect(text).toContain("The token has been deleted.");
    expect(addresses(account)).toEqual([]);
    expect(login(account)?.destinations).toEqual(page(""));
    expect(await stored()).toBeNull();
    expect(account.tokens.some((t) => t.value === PASTED)).toBe(false);
  });

  it("refuses a token for another account and changes nothing", async () => {
    const account = fakeAccount();
    const response = await change(account, "time.owner.example");
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).toContain("This token is for a different Cloudflare account.");
    expect(account.addresses).toEqual([]);
    expect(account.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("reports a token Cloudflare does not accept", async () => {
    const account = installed();
    const response = await change(account, "time.owner.example", "not-a-real-token");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Cloudflare did not accept this token.");
    expect(account.addresses).toEqual([]);
  });

  it("says where it stopped and what Cloudflare said when a step fails, keeps the saved address and deletes the token", async () => {
    const account = installed();
    account.failWhen((call) =>
      call.method === "PUT" && call.path === `/accounts/${OURS}/access/apps/app-ours`
        ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
        : undefined,
    );
    const response = await change(account, "time.owner.example");
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain("Changing the address stopped while it tried to add the address to the login.");
    expect(text).toContain("Cloudflare said: 10000 Internal error");
    expect(text).toContain("The token has been deleted.");
    expect(await stored()).toBeNull();
    expect(account.tokens.some((t) => t.value === PASTED)).toBe(false);
  });

  it("says to delete the token by hand when it could not be deleted", async () => {
    const account = installed();
    account.failWhen((call) =>
      call.method === "DELETE" && call.path.includes("/tokens/")
        ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
        : undefined,
    );
    const text = await (await change(account, "time.owner.example")).text();
    expect(text).toContain("The app could not delete its token. Delete it yourself: on");
    expect(text).toContain('delete "timecapsule address".');
  });
});
