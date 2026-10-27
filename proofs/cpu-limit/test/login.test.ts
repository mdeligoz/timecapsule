import { beforeAll, describe, expect, it } from "vitest";
import { loginEmail } from "../src/login";
import { makeSigner, type Signer } from "./token";

const AUD = "aud-123";
const NOW = 1_800_000_000;
let signer: Signer;
let other: Signer;

beforeAll(async () => {
  signer = await makeSigner();
  other = await makeSigner();
});

const claims = { aud: [AUD], email: "owner@example.com", exp: NOW + 60 };

describe("loginEmail", () => {
  it("returns the email from a valid token", async () => {
    expect(await loginEmail(await signer.sign(claims), signer.jwks, AUD, NOW)).toBe("owner@example.com");
  });

  it("refuses a token for another application", async () => {
    expect(await loginEmail(await signer.sign({ ...claims, aud: ["other"] }), signer.jwks, AUD, NOW)).toBeNull();
  });

  it("refuses an expired token", async () => {
    expect(await loginEmail(await signer.sign({ ...claims, exp: NOW - 1 }), signer.jwks, AUD, NOW)).toBeNull();
  });

  it("refuses a token signed by another key", async () => {
    expect(await loginEmail(await other.sign(claims), signer.jwks, AUD, NOW)).toBeNull();
  });

  it("refuses a token whose claims were changed after signing", async () => {
    const [head, , signature] = (await signer.sign(claims)).split(".");
    const forged = btoa(JSON.stringify({ ...claims, email: "evil@example.com" })).replace(/=+$/, "");
    expect(await loginEmail(`${head}.${forged}.${signature}`, signer.jwks, AUD, NOW)).toBeNull();
  });

  it("refuses a missing or malformed token", async () => {
    expect(await loginEmail(null, signer.jwks, AUD, NOW)).toBeNull();
    expect(await loginEmail("not-a-token", signer.jwks, AUD, NOW)).toBeNull();
  });
});
