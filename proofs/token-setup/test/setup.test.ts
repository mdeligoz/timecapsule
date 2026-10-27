import { describe, expect, it } from "vitest";
import { runSetup, type SetupInput } from "../src/setup";
import { type Answer, type Call, fakeCloudflare } from "./fake-cloudflare";

const OURS = "acc-ours";
const OTHER = "acc-other";
const SCRIPT = "timecapsule-token-proof";
const VERSION = "ver-running";
const PASTED = "pasted-token-value";
const R2_TOKEN_VALUE = "r2-token-value";
const BUCKET_ITEM_WRITE = "pg-bucket-item-write";

function input(fetch: typeof globalThis.fetch): SetupInput {
  return {
    token: PASTED,
    scriptName: SCRIPT,
    versionId: VERSION,
    host: "timecapsule-token-proof.example.workers.dev",
    ownerEmail: "owner@example.com",
    bucket: "timecapsule-token-proof",
    fetch,
  };
}

function happyRoutes() {
  let deleted = false;
  return {
    "GET /accounts": { result: [{ id: OTHER }, { id: OURS }] },
    [`GET /accounts/${OTHER}/workers/scripts/${SCRIPT}/versions`]: { result: { items: [{ id: "ver-elsewhere" }] } },
    [`GET /accounts/${OURS}/workers/scripts/${SCRIPT}/versions`]: {
      result: { items: [{ id: "ver-newer" }, { id: VERSION }] },
    },
    [`GET /accounts/${OURS}/tokens/verify`]: () =>
      deleted
        ? { status: 401, errors: [{ code: 1000, message: "Invalid API Token" }] }
        : { result: { id: "tok-pasted", status: "active" } },
    [`GET /accounts/${OURS}/tokens/permission_groups`]: {
      result: [
        { id: "pg-other", name: "Workers R2 Storage Write" },
        { id: BUCKET_ITEM_WRITE, name: "Workers R2 Storage Bucket Item Write" },
      ],
    },
    [`POST /accounts/${OURS}/tokens`]: { result: { id: "tok-r2", value: R2_TOKEN_VALUE } },
    [`POST /accounts/${OURS}/access/apps`]: { result: { id: "app-1", aud: "aud-tag" } },
    [`PATCH /accounts/${OURS}/workers/scripts/${SCRIPT}/secrets-bulk`]: { result: {} },
    [`DELETE /accounts/${OURS}/tokens/tok-pasted`]: () => {
      deleted = true;
      return { result: { id: "tok-pasted" } };
    },
  } as Record<string, Answer | ((call: Call) => Answer)>;
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("runSetup", () => {
  it("refuses a token whose accounts do not hold this running Worker, and changes nothing", async () => {
    const { fetch, calls } = fakeCloudflare({
      "GET /accounts": { result: [{ id: OTHER }] },
      [`GET /accounts/${OTHER}/workers/scripts/${SCRIPT}/versions`]: { result: { items: [{ id: "ver-elsewhere" }] } },
    });
    const outcome = await runSetup(input(fetch));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.failedStep).toBe("find this Worker's account");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("treats an account that cannot list this Worker's versions as not ours", async () => {
    const { fetch } = fakeCloudflare({
      "GET /accounts": { result: [{ id: OTHER }] },
      [`GET /accounts/${OTHER}/workers/scripts/${SCRIPT}/versions`]: {
        status: 404,
        errors: [{ code: 10007, message: "script not found" }],
      },
    });
    const outcome = await runSetup(input(fetch));
    expect(outcome.ok === false && outcome.failedStep).toBe("find this Worker's account");
  });

  it("calls fetch unbound, as the runtime's own fetch requires", async () => {
    const { fetch: fake } = fakeCloudflare(happyRoutes());
    const outcome = await runSetup(
      input(function (this: unknown, ...args: Parameters<typeof fetch>) {
        if (this !== undefined) throw new TypeError("Illegal invocation");
        return fake(...args);
      }),
    );
    expect(outcome.ok).toBe(true);
  });

  it("ignores spaces, line breaks and a leading Bearer in the pasted text", async () => {
    const { fetch, calls } = fakeCloudflare(happyRoutes());
    await runSetup({ ...input(fetch), token: `  Bearer ${PASTED.slice(0, 6)}\n ${PASTED.slice(6)} ` });
    expect(calls[0].auth).toBe(`Bearer ${PASTED}`);
  });

  it("reports Cloudflare's nested reasons and the pasted text's shape, never its value", async () => {
    const { fetch } = fakeCloudflare({
      "GET /accounts": {
        status: 400,
        errors: [
          {
            code: 6003,
            message: "Invalid request headers",
            error_chain: [{ code: 6111, message: "Invalid format for Authorization header" }],
          },
        ],
      },
    });
    const outcome = await runSetup({ ...input(fetch), token: "ab$cd.ef" });
    expect(outcome).toMatchObject({
      ok: false,
      reason: "6003 Invalid request headers (6111 Invalid format for Authorization header)",
      pasted: "8 characters: letters, other: $ .",
    });
    expect(JSON.stringify(outcome)).not.toContain("ab$cd.ef");
  });

  it("reports a failed account lookup as Cloudflare's error, not as another account", async () => {
    const routes = happyRoutes();
    routes[`GET /accounts/${OURS}/workers/scripts/${SCRIPT}/versions`] = {
      status: 503,
      errors: [{ code: 10013, message: "Service unavailable" }],
    };
    const outcome = await runSetup(input(fakeCloudflare(routes).fetch));
    expect(outcome).toMatchObject({
      ok: false,
      failedStep: "find this Worker's account",
      reason: "10013 Service unavailable",
    });
  });

  it("says the token was deleted when only the check after deleting failed", async () => {
    const routes = happyRoutes();
    routes[`GET /accounts/${OURS}/tokens/verify`] = { result: { id: "tok-pasted", status: "active" } };
    const outcome = await runSetup(input(fakeCloudflare(routes).fetch));
    expect(outcome).toMatchObject({ ok: false, tokenDeleted: true });
  });

  it("still shows the encryption key when a step after storing it fails", async () => {
    const routes = happyRoutes();
    routes[`DELETE /accounts/${OURS}/tokens/tok-pasted`] = { status: 500, errors: [{ code: 1, message: "boom" }] };
    const { fetch, calls } = fakeCloudflare(routes);
    const outcome = await runSetup(input(fetch));
    const secrets = calls.find((c) => c.path.endsWith("/secrets-bulk"))?.body as {
      secrets: Record<string, { text: string }>;
    };
    expect(outcome).toMatchObject({
      ok: false,
      failedStep: "delete the pasted token",
      tokenDeleted: false,
      encryptionKey: secrets.secrets.ENCRYPTION_KEY.text,
    });
  });

  it("shows no encryption key when setup fails before storing it", async () => {
    const routes = happyRoutes();
    routes[`POST /accounts/${OURS}/access/apps`] = { status: 403, errors: [{ code: 10000, message: "no" }] };
    const outcome = await runSetup(input(fakeCloudflare(routes).fetch));
    expect(outcome.ok === false && outcome.encryptionKey).toBeUndefined();
  });

  it("sends the pasted token on every call", async () => {
    const { fetch, calls } = fakeCloudflare(happyRoutes());
    await runSetup(input(fetch));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.auth === `Bearer ${PASTED}`)).toBe(true);
  });

  it("creates an R2 key that reaches only the one bucket", async () => {
    const { fetch, calls } = fakeCloudflare(happyRoutes());
    await runSetup(input(fetch));
    const create = calls.find((c) => c.method === "POST" && c.path === `/accounts/${OURS}/tokens`);
    expect(create?.body).toMatchObject({
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: BUCKET_ITEM_WRITE }],
          resources: { [`com.cloudflare.edge.r2.bucket.${OURS}_default_timecapsule-token-proof`]: "*" },
        },
      ],
    });
  });

  it("creates an Access app for this host that lets in only the owner's email", async () => {
    const { fetch, calls } = fakeCloudflare(happyRoutes());
    await runSetup(input(fetch));
    const app = calls.find((c) => c.path === `/accounts/${OURS}/access/apps`);
    expect(app?.body).toMatchObject({
      type: "self_hosted",
      domain: "timecapsule-token-proof.example.workers.dev",
      policies: [{ decision: "allow", include: [{ email: { email: "owner@example.com" } }] }],
    });
  });

  it("stores the R2 key, the Access audience and a fresh encryption key as secrets in one change", async () => {
    const { fetch, calls } = fakeCloudflare(happyRoutes());
    const outcome = await runSetup(input(fetch));
    expect(outcome.ok).toBe(true);
    const secrets = calls.filter((c) => c.path.endsWith("/secrets-bulk"));
    expect(secrets).toHaveLength(1);
    const body = secrets[0].body as { secrets: Record<string, { type: string; text: string }> };
    const stored = Object.fromEntries(Object.entries(body.secrets).map(([k, v]) => [k, v.text]));
    expect(Object.values(body.secrets).every((s) => s.type === "secret_text")).toBe(true);
    expect(stored.R2_ACCESS_KEY_ID).toBe("tok-r2");
    expect(stored.R2_SECRET_ACCESS_KEY).toBe(await sha256Hex(R2_TOKEN_VALUE));
    expect(stored.ACCESS_AUD).toBe("aud-tag");
    expect(stored.ACCOUNT_ID).toBe(OURS);
    expect(stored.SETUP_DONE).toBe("1");
    expect(outcome.ok && outcome.encryptionKey).toBe(stored.ENCRYPTION_KEY);
    expect(atob(stored.ENCRYPTION_KEY)).toHaveLength(32);
  });

  it("generates a different encryption key each run", async () => {
    const first = await runSetup(input(fakeCloudflare(happyRoutes()).fetch));
    const second = await runSetup(input(fakeCloudflare(happyRoutes()).fetch));
    expect(first.ok && second.ok && first.encryptionKey !== second.encryptionKey).toBe(true);
  });

  it("deletes the pasted token by its own id, then checks it is refused", async () => {
    const { fetch, calls } = fakeCloudflare(happyRoutes());
    const outcome = await runSetup(input(fetch));
    expect(calls.slice(-2).map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE /accounts/${OURS}/tokens/tok-pasted`,
      `GET /accounts/${OURS}/tokens/verify`,
    ]);
    expect(outcome.ok).toBe(true);
  });

  it("fails if the token still works after it was deleted", async () => {
    const routes = happyRoutes();
    routes[`GET /accounts/${OURS}/tokens/verify`] = { result: { id: "tok-pasted", status: "active" } };
    const outcome = await runSetup(input(fakeCloudflare(routes).fetch));
    expect(outcome).toMatchObject({ ok: false, failedStep: "confirm the pasted token no longer works" });
  });

  it("names the failed step with Cloudflare's message and still deletes the token", async () => {
    const routes = happyRoutes();
    routes[`POST /accounts/${OURS}/access/apps`] = {
      status: 403,
      errors: [{ code: 10000, message: "Authentication error" }],
    };
    const { fetch, calls } = fakeCloudflare(routes);
    const outcome = await runSetup(input(fetch));
    expect(outcome).toMatchObject({
      ok: false,
      failedStep: "create the Access app",
      reason: "10000 Authentication error",
    });
    expect(calls.some((c) => c.path.endsWith("/secrets-bulk"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/accounts/${OURS}/tokens/tok-pasted`)).toBe(true);
    expect(outcome.ok === false && outcome.tokenDeleted).toBe(true);
  });
});
