import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Env, handle } from "../src/index";
import schema from "../src/schema.sql?raw";
import { makeSigner, type Signer } from "./token";

let signer: Signer;
let app: Env;
let token: string;
let sent: { url: string; init: RequestInit }[];

const okResend = async (url: RequestInfo | URL, init?: RequestInit) => {
  sent.push({ url: String(url), init: init ?? {} });
  return Response.json({ id: "email-1" });
};

function call(method: string, path: string, body?: BodyInit, withToken = true, send = okResend) {
  const headers = withToken ? { "cf-access-jwt-assertion": token } : undefined;
  return handle(new Request(`https://app.example${path}`, { method, body, headers }), app, send);
}

const letter = {
  title: "A letter from <today>",
  html: "<h1>Dear me</h1>\n<p>Hello <strong>future</strong></p>\n",
  sendLocal: "2020-01-01T09:00",
  sendZone: "Europe/Istanbul",
  recipients: Array.from({ length: 20 }, (_, i) => `friend${i}@example.com`),
  files: [
    { key: "f1", name: "photo.jpg", type: "image/jpeg", size: 1000 },
    { key: "f2", name: "video.mp4", type: "video/mp4", size: 2000 },
    { key: "f3", name: "scan.pdf", type: "application/pdf", size: 3000 },
  ],
};

async function save(fields: Partial<typeof letter> = {}): Promise<number> {
  const response = await call("POST", "/letters", JSON.stringify({ ...letter, ...fields }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

beforeAll(async () => {
  signer = await makeSigner();
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  app = {
    ...(env as unknown as Env),
    OWNER_EMAIL: "owner@example.com",
    ACCESS_AUD: "aud-1",
    ACCESS_JWKS: signer.jwks,
    LETTER_KEY: key,
    RESEND_API_KEY: "re_test",
    RESEND_FROM: "Timecapsule <letters@example.com>",
    R2_ACCOUNT_ID: "acc",
    R2_BUCKET: "letters",
    R2_ACCESS_KEY_ID: "kid",
    R2_SECRET_ACCESS_KEY: "secret",
  };
  token = await signer.sign({ aud: ["aud-1"], email: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 600 });
});

beforeEach(async () => {
  sent = [];
  await app.DB.batch([
    ...["DROP TABLE IF EXISTS files", "DROP TABLE IF EXISTS recipients", "DROP TABLE IF EXISTS letters"].map((s) => app.DB.prepare(s)),
    ...schema.split(";").map((s) => s.trim()).filter(Boolean).map((s) => app.DB.prepare(s)),
  ]);
});

describe("login", () => {
  it("refuses every page without a login token", async () => {
    for (const [method, path] of [["GET", "/letters"], ["POST", "/letters"], ["GET", "/letters/1"], ["PUT", "/files/x"], ["POST", "/send-due"], ["GET", "/convert"]]) {
      expect((await call(method, path, undefined, false)).status).toBe(403);
    }
  });

  it("refuses a valid login for someone other than the owner", async () => {
    const stranger = await signer.sign({ aud: ["aud-1"], email: "stranger@example.com", exp: Math.floor(Date.now() / 1000) + 600 });
    const response = await handle(new Request("https://app.example/letters", { headers: { "cf-access-jwt-assertion": stranger } }), app, okResend);
    expect(response.status).toBe(403);
  });
});

describe("letters", () => {
  it("stores the letter text encrypted", async () => {
    const id = await save();
    const row = await app.DB.prepare("SELECT title, body FROM letters WHERE id = ?").bind(id).first<{ title: string; body: string }>();
    expect(row?.body).not.toContain("Dear me");
    expect(row?.title).not.toContain("A letter");
  });

  it("opens a saved letter with its HTML and an escaped title", async () => {
    const id = await save();
    const html = await (await call("GET", `/letters/${id}`)).text();
    expect(html).toContain("A letter from &lt;today&gt;");
    expect(html).toContain("<p>Hello <strong>future</strong></p>");
  });

  it("lists every letter's title", async () => {
    await save({ title: "First" });
    await save({ title: "Second <b>" });
    const html = await (await call("GET", "/letters")).text();
    expect(html).toContain("First");
    expect(html).toContain("Second &lt;b&gt;");
  });

  it("answers 404 for a letter that does not exist", async () => {
    expect((await call("GET", "/letters/999")).status).toBe(404);
  });
});

describe("files", () => {
  it("streams an upload into private storage", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    expect((await call("PUT", "/files/photo-1", bytes)).status).toBe(201);
    const stored = await app.FILES.get("photo-1");
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });
});

describe("hourly send", () => {
  it("sends a due letter once, to the owner with the rest in BCC, with signed file links", async () => {
    const id = await save();
    const response = await call("POST", "/send-due");
    expect(await response.json()).toEqual({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    const headers = new Headers(sent[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test");
    expect(headers.get("idempotency-key")).toBe(`letter-${id}`);
    const email = JSON.parse(String(sent[0].init.body));
    expect(email.from).toBe("Timecapsule <letters@example.com>");
    expect(email.to).toEqual(["owner@example.com"]);
    expect(email.bcc).toEqual(letter.recipients);
    expect(email.subject).toBe(letter.title);
    expect(email.html).toContain("<p>Hello <strong>future</strong></p>");
    expect(email.attachments.map((a: { filename: string }) => a.filename)).toEqual(["photo.jpg", "video.mp4", "scan.pdf"]);
    expect(email.attachments[0].path).toMatch(/^https:\/\/acc\.r2\.cloudflarestorage\.com\/letters\/f1\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Expires=3600&.*X-Amz-Signature=[0-9a-f]{64}$/);

    sent = [];
    expect(await (await call("POST", "/send-due")).json()).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("sends a single recipient in To without BCC", async () => {
    await save({ recipients: ["only@example.com"] });
    await call("POST", "/send-due");
    const email = JSON.parse(String(sent[0].init.body));
    expect(email.to).toEqual(["only@example.com"]);
    expect(email.bcc).toBeUndefined();
  });

  it("leaves a letter whose time has not come", async () => {
    await save({ sendLocal: "2040-01-01T09:00" });
    expect(await (await call("POST", "/send-due")).json()).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("keeps a letter for the next hour when Resend fails", async () => {
    await save();
    const failing = async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 500 });
    };
    expect(await (await call("POST", "/send-due", undefined, true, failing)).json()).toEqual({ sent: 0, failed: 1 });
    expect(await (await call("POST", "/send-due")).json()).toEqual({ sent: 1, failed: 0 });
  });
});
