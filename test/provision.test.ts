import { describe, expect, it } from "vitest";
import { cleanToken, type ProvisionInput, provision } from "../src/provision";
import { BUCKET_ITEM_WRITE, fakeAccount, OTHER, OURS, PASTED, SCRIPT, VERSION } from "./fake-cloudflare";

const HOST = "timecapsule.owner.workers.dev";
const TEAM = "https://owner-team.cloudflareaccess.com";
const LETTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function input(account: ReturnType<typeof fakeAccount>, token = PASTED): ProvisionInput {
  return {
    token,
    teamDomain: TEAM,
    letterKey: LETTER_KEY,
    scriptName: SCRIPT,
    versionId: VERSION,
    host: HOST,
    ownerEmail: "owner@example.com",
    sendDomain: "letters.example",
    resendKey: "re_test_key",
    fetch: account.fetch,
  };
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const made = (account: ReturnType<typeof fakeAccount>) => ({
  keys: account.tokens.filter((t) => t.name === `${SCRIPT} files`),
  apps: account.apps.filter((a) => a.domain === HOST),
});

describe("setup with the pasted token", () => {
  it("makes the file key and the login, stores every setting, then deletes the token", async () => {
    const account = fakeAccount();
    expect(await provision(input(account))).toEqual({ ok: true, tokenDeleted: true });

    const { keys, apps } = made(account);
    expect(keys).toHaveLength(1);
    expect(keys[0].policies).toEqual([
      {
        effect: "allow",
        permission_groups: [{ id: BUCKET_ITEM_WRITE }],
        resources: { [`com.cloudflare.edge.r2.bucket.${OURS}_default_timecapsule`]: "*" },
      },
    ]);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      name: SCRIPT,
      domain: HOST,
      policies: [{ name: "Owner only", decision: "allow", include: [{ email: { email: "owner@example.com" } }] }],
    });
    expect(Object.fromEntries(account.secrets)).toEqual({
      LETTER_KEY,
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: apps[0].aud,
      R2_ACCOUNT_ID: OURS,
      R2_ACCESS_KEY_ID: keys[0].id,
      R2_SECRET_ACCESS_KEY: await sha256Hex(keys[0].value),
      R2_BUCKET: "timecapsule",
      OWNER_EMAIL: "owner@example.com",
      SEND_DOMAIN: "letters.example",
      RESEND_API_KEY: "re_test_key",
      SETUP_DONE: "1",
    });
    expect(account.tokens.some((t) => t.value === PASTED)).toBe(false);
  });

  it("scopes the file key to the bucket the running version uses, and stores its name", async () => {
    // A copy whose wrangler.jsonc names another bucket.
    const account = fakeAccount("letters-files");
    expect(await provision(input(account))).toMatchObject({ ok: true });
    expect(made(account).keys[0].policies).toMatchObject([
      { resources: { [`com.cloudflare.edge.r2.bucket.${OURS}_default_letters-files`]: "*" } },
    ]);
    expect(account.secrets.get("R2_BUCKET")).toBe("letters-files");
  });

  it("stops before making the file key when the running version has no file bucket, and deletes the token", async () => {
    const account = fakeAccount();
    account.failWhen((call) =>
      call.path.includes("/versions/") ? { result: { id: VERSION, resources: { bindings: [] } } } : undefined,
    );
    expect(await provision(input(account))).toEqual({
      ok: false,
      step: "make the file storage key",
      reason: "the running version has no file storage bucket",
      tokenDeleted: true,
    });
    expect(made(account)).toEqual({ keys: [], apps: [] });
  });

  it("stores the setup-done mark last, so a stop part-way leaves setup open", async () => {
    const account = fakeAccount();
    await provision(input(account));
    const stored = account.calls.filter((c) => c.method === "PUT").map((c) => (c.body as { name: string }).name);
    expect(stored.at(-1)).toBe("SETUP_DONE");
    expect(new Set(stored).size).toBe(11);
  });

  it("refuses a token for another account and changes nothing", async () => {
    const account = fakeAccount();
    account.failWhen((call) =>
      call.path.startsWith(`/accounts/${OURS}/workers`)
        ? { status: 404, errors: [{ code: 10007, message: "not found" }] }
        : undefined,
    );
    const outcome = await provision(input(account));
    expect(outcome).toMatchObject({ ok: false, step: "check the token", otherAccount: true, tokenDeleted: false });
    expect(account.calls.every((c) => c.method === "GET")).toBe(true);
    expect(account.calls.map((c) => c.path)).toContain(
      `/accounts/${OTHER}/workers/scripts/${SCRIPT}/versions/${VERSION}`,
    );
  });

  it("reports a token Cloudflare does not accept with its answer, and changes nothing", async () => {
    const account = fakeAccount();
    const outcome = await provision(input(account, "not-a-token"));
    expect(outcome).toEqual({
      ok: false,
      step: "check the token",
      reason: "9109 Invalid access token",
      status: 401,
      tokenDeleted: false,
    });
    expect(account.calls).toHaveLength(1);
  });

  it("reports a failed account lookup as Cloudflare's error, not as another account", async () => {
    const account = fakeAccount();
    account.failWhen((call) =>
      call.path.includes("/versions/")
        ? { status: 503, errors: [{ code: 10013, message: "Service unavailable" }] }
        : undefined,
    );
    expect(await provision(input(account))).toMatchObject({
      ok: false,
      step: "check the token",
      reason: "10013 Service unavailable",
    });
  });

  it("ignores spaces, line breaks and a leading Bearer in the pasted text", async () => {
    const account = fakeAccount();
    const pasted = `  Bearer ${PASTED.slice(0, 6)}\n ${PASTED.slice(6)} `;
    expect(await provision(input(account, pasted))).toMatchObject({ ok: true });
    expect(account.calls[0].auth).toBe(`Bearer ${PASTED}`);
  });

  it("removes Bearer only as a word in front, so a token that starts with those letters is kept whole", () => {
    expect(cleanToken(" Bearer abc\n def ")).toBe("abcdef");
    expect(cleanToken("bearer\tabc")).toBe("abc");
    expect(cleanToken("BearerlyStartingToken")).toBe("BearerlyStartingToken");
  });

  it("calls fetch unbound, as the runtime's own fetch requires", async () => {
    const account = fakeAccount();
    const outcome = await provision({
      ...input(account),
      fetch(this: unknown, url: string, init: RequestInit) {
        if (this !== undefined) throw new TypeError("Illegal invocation");
        return account.fetch(url, init);
      },
    });
    expect(outcome).toMatchObject({ ok: true });
  });

  it("removes what it made and deletes the token when a step fails before the settings are stored", async () => {
    const account = fakeAccount();
    account.failWhen((call) =>
      call.method === "PUT" && (call.body as { name: string }).name === "ACCESS_AUD"
        ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
        : undefined,
    );
    const outcome = await provision(input(account));
    expect(outcome).toEqual({
      ok: false,
      step: "store the app's settings",
      reason: "10000 Internal error",
      status: 500,
      tokenDeleted: true,
    });
    expect(made(account)).toEqual({ keys: [], apps: [] });
    expect(account.tokens.some((t) => t.value === PASTED)).toBe(false);
    expect(account.secrets.has("SETUP_DONE")).toBe(false);
  });

  it("clears what an earlier stopped try left behind, on any page of the lists, before making new ones", async () => {
    const account = fakeAccount();
    account.tokens.push({ id: "tok-left", name: `${SCRIPT} files`, value: "left" });
    account.apps.push({ id: "app-left", aud: "aud-left", name: SCRIPT, domain: HOST });
    expect(await provision(input(account))).toMatchObject({ ok: true });
    const { keys, apps } = made(account);
    expect(keys.map((k) => k.id)).not.toContain("tok-left");
    expect(apps.map((a) => a.id)).not.toContain("app-left");
    expect(keys).toHaveLength(1);
    expect(apps).toHaveLength(1);
    // Things that are not this app's are left alone.
    expect(account.tokens.map((t) => t.id)).toEqual(expect.arrayContaining(["tok-other-1", "tok-other-2"]));
    expect(account.apps.map((a) => a.id)).toEqual(expect.arrayContaining(["app-other-1", "app-other-2"]));
  });

  it("can be tried again after a stop whose clean-up also failed, and ends with one key and one login", async () => {
    const account = fakeAccount();
    account.failWhen((call) =>
      call.method === "PUT" || call.method === "DELETE"
        ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
        : undefined,
    );
    expect(await provision(input(account))).toMatchObject({ ok: false, tokenDeleted: false });
    expect(made(account).keys).toHaveLength(1);

    account.failWhen(() => undefined);
    account.tokens.push({ id: "tok-pasted-2", name: "timecapsule setup", value: "second-token" });
    expect(await provision(input(account, "second-token"))).toEqual({ ok: true, tokenDeleted: true });
    const { keys, apps } = made(account);
    expect(keys).toHaveLength(1);
    expect(apps).toHaveLength(1);
    expect(account.secrets.get("ACCESS_AUD")).toBe(apps[0].aud);
    expect(account.secrets.get("R2_ACCESS_KEY_ID")).toBe(keys[0].id);
  });

  it("keeps the key and the login when the answer to the setup-done mark is lost, as it may have been stored", async () => {
    const account = fakeAccount();
    account.failWhen((call) => {
      if (call.method !== "PUT" || (call.body as { name: string }).name !== "SETUP_DONE") return undefined;
      account.secrets.set("SETUP_DONE", "1");
      return { status: 504, errors: [{ code: 10000, message: "Gateway timeout" }] };
    });
    expect(await provision(input(account))).toMatchObject({ ok: false, step: "store the app's settings" });
    expect(made(account).keys).toHaveLength(1);
    expect(made(account).apps).toHaveLength(1);
    expect(account.secrets.get("ACCESS_AUD")).toBe(made(account).apps[0].aud);
  });

  it("keeps everything once the settings are stored, even if the token cannot be deleted", async () => {
    const account = fakeAccount();
    account.failWhen((call) =>
      call.method === "DELETE" && call.path.endsWith("/tok-pasted")
        ? { status: 500, errors: [{ code: 10000, message: "Internal error" }] }
        : undefined,
    );
    expect(await provision(input(account))).toEqual({ ok: true, tokenDeleted: false });
    expect(made(account).keys).toHaveLength(1);
    expect(made(account).apps).toHaveLength(1);
    expect(account.secrets.get("SETUP_DONE")).toBe("1");
  });

  it("does not count the token as deleted while Cloudflare still accepts it", async () => {
    const account = fakeAccount();
    // Answers the delete as done without removing the token.
    account.failWhen((call) =>
      call.method === "DELETE" && call.path.endsWith("/tok-pasted") ? { result: { id: "tok-pasted" } } : undefined,
    );
    expect(await provision(input(account))).toEqual({ ok: true, tokenDeleted: false });
  });
});
