import { fromBase64 } from "./base64";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromBase64url(text: string): Uint8Array {
  const plain = text.replaceAll("-", "+").replaceAll("_", "/");
  return fromBase64(plain + "=".repeat((4 - (plain.length % 4)) % 4));
}

function json(part: string): Record<string, unknown> {
  return JSON.parse(decoder.decode(fromBase64url(part)));
}

// Verifies a Cloudflare Access login token (RS256 JWT) and returns its email, or null.
export async function loginEmail(token: string | null, jwks: string, audience: string, nowSeconds: number): Promise<string | null> {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) return null;
  try {
    const head = json(parts[0]);
    if (head.alg !== "RS256") return null;
    const jwk = (JSON.parse(jwks).keys as (JsonWebKey & { kid?: string })[]).find((k) => k.kid === head.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(parts[2]), signed))) return null;
    const claims = json(parts[1]);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience) || typeof claims.exp !== "number" || claims.exp <= nowSeconds) return null;
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}
