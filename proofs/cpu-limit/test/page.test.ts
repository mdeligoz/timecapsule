import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanLetter } from "../src/clean";
import { type Env, handle } from "../src/index";
import { sampleLetter } from "../src/letter";
import { makeSigner } from "./token";

describe("server conversion page", () => {
  it("converts and cleans the sample letter on the server, for measuring", async () => {
    const signer = await makeSigner();
    const app = { ...(env as unknown as Env), OWNER_EMAIL: "owner@example.com", ACCESS_AUD: "aud-1", ACCESS_JWKS: signer.jwks };
    const token = await signer.sign({ aud: ["aud-1"], email: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 600 });
    const request = new Request("https://app.example/convert", { headers: { "cf-access-jwt-assertion": token } });
    const response = await handle(request, app, fetch);
    const html = (await cleanLetter(sampleLetter())).length;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`Converted and cleaned a 50000-character letter into ${html} characters of HTML.\n`);
  });
});
