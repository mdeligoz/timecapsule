import { describe, expect, it } from "vitest";
import { AccessKeys, loginEmail } from "../src/login";
import { makeSigner, type Signer } from "./token";

const TEAM = "https://owner-team.cloudflareaccess.com";
const AUD = "aud-1";
const NOW = 1_800_000_000;

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: [AUD], iss: TEAM, email: "owner@example.com", iat: NOW - 60, exp: NOW + 3600, ...overrides };
}

// Serves the signers' public keys as Access's certs endpoint does, and records each request.
function certs(...signers: Signer[]) {
  const served = { signers, urls: [] as string[] };
  const fetcher = async (url: string) => {
    served.urls.push(url);
    const keys = served.signers.flatMap((s) => JSON.parse(s.jwks).keys);
    return new Response(JSON.stringify({ keys }), { headers: { "content-type": "application/json" } });
  };
  return { served, keys: new AccessKeys(TEAM, fetcher) };
}

describe("Access login token", () => {
  it("accepts a valid token and returns its email", async () => {
    const signer = await makeSigner();
    const { keys, served } = certs(signer);
    expect(await loginEmail(await signer.sign(claims()), keys, TEAM, AUD, NOW)).toBe("owner@example.com");
    expect(served.urls).toEqual([`${TEAM}/cdn-cgi/access/certs`]);
  });

  it("refuses a missing token", async () => {
    const { keys } = certs(await makeSigner());
    expect(await loginEmail(null, keys, TEAM, AUD, NOW)).toBeNull();
    expect(await loginEmail("", keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses a token that is not a JWT", async () => {
    const { keys } = certs(await makeSigner());
    expect(await loginEmail("not.a-token", keys, TEAM, AUD, NOW)).toBeNull();
    expect(await loginEmail("a.b.c", keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses an expired token", async () => {
    const signer = await makeSigner();
    const { keys } = certs(signer);
    expect(await loginEmail(await signer.sign(claims({ exp: NOW })), keys, TEAM, AUD, NOW)).toBeNull();
    expect(await loginEmail(await signer.sign(claims({ exp: undefined })), keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses a token that is not valid yet", async () => {
    const signer = await makeSigner();
    const { keys } = certs(signer);
    expect(await loginEmail(await signer.sign(claims({ nbf: NOW + 60 })), keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses a token for another Access app", async () => {
    const signer = await makeSigner();
    const { keys } = certs(signer);
    expect(await loginEmail(await signer.sign(claims({ aud: ["aud-2"] })), keys, TEAM, AUD, NOW)).toBeNull();
    expect(await loginEmail(await signer.sign(claims({ aud: undefined })), keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses a token from another team", async () => {
    const signer = await makeSigner();
    const { keys } = certs(signer);
    const other = claims({ iss: "https://other-team.cloudflareaccess.com" });
    expect(await loginEmail(await signer.sign(other), keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses a forged token signed with another key under the same key id", async () => {
    const real = await makeSigner("key-1");
    const forger = await makeSigner("key-1");
    const { keys } = certs(real);
    expect(await loginEmail(await forger.sign(claims()), keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses a token whose signature was changed", async () => {
    const signer = await makeSigner();
    const { keys } = certs(signer);
    const token = await signer.sign(claims());
    const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect(await loginEmail(tampered, keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses a token whose claims were changed after signing", async () => {
    const signer = await makeSigner();
    const { keys } = certs(signer);
    const [head, , signature] = (await signer.sign(claims())).split(".");
    const body = btoa(JSON.stringify(claims({ email: "attacker@example.com" }))).replaceAll("=", "");
    expect(await loginEmail(`${head}.${body}.${signature}`, keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("refuses a token without an email", async () => {
    const signer = await makeSigner();
    const { keys } = certs(signer);
    expect(await loginEmail(await signer.sign(claims({ email: undefined })), keys, TEAM, AUD, NOW)).toBeNull();
  });

  it("fetches the keys again when Access starts signing with a new key", async () => {
    const before = await makeSigner("key-1");
    const after = await makeSigner("key-2");
    const { keys, served } = certs(before);
    expect(await loginEmail(await before.sign(claims()), keys, TEAM, AUD, NOW)).toBe("owner@example.com");
    served.signers = [after];
    expect(await loginEmail(await after.sign(claims()), keys, TEAM, AUD, NOW)).toBe("owner@example.com");
    expect(served.urls).toHaveLength(2);
  });

  it("skips a key it cannot use and still accepts tokens signed with the others", async () => {
    const signer = await makeSigner("key-1");
    const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const ecJwk = { ...((await crypto.subtle.exportKey("jwk", ec.publicKey)) as JsonWebKey), kid: "key-ec" };
    const keys = new AccessKeys(TEAM, async () => {
      return new Response(JSON.stringify({ keys: [ecJwk, ...JSON.parse(signer.jwks).keys] }));
    });
    expect(await loginEmail(await signer.sign(claims()), keys, TEAM, AUD, NOW)).toBe("owner@example.com");
  });

  it("keeps the fetched keys for later requests", async () => {
    const signer = await makeSigner();
    const { keys, served } = certs(signer);
    await loginEmail(await signer.sign(claims()), keys, TEAM, AUD, NOW);
    await loginEmail(await signer.sign(claims()), keys, TEAM, AUD, NOW);
    expect(served.urls).toHaveLength(1);
  });

  it("refuses when the certs endpoint fails", async () => {
    const signer = await makeSigner();
    const keys = new AccessKeys(TEAM, async () => new Response("down", { status: 503 }));
    expect(await loginEmail(await signer.sign(claims()), keys, TEAM, AUD, NOW)).toBeNull();
  });
});
