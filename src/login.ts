const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromBase64url(text: string): Uint8Array {
  const plain = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(plain, (c) => c.charCodeAt(0));
}

function json(part: string): Record<string, unknown> {
  return JSON.parse(decoder.decode(fromBase64url(part)));
}

// Access's public signing keys, fetched from the team's certs page and fetched again when a token names an unknown key.
export class AccessKeys {
  #keys = new Map<string, CryptoKey>();
  #certsUrl: string;
  #fetcher: (url: string) => Promise<Response>;

  constructor(teamDomain: string, fetcher: (url: string) => Promise<Response>) {
    this.#certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
    this.#fetcher = fetcher;
  }

  async find(kid: string): Promise<CryptoKey | undefined> {
    if (!this.#keys.has(kid)) await this.#refresh();
    return this.#keys.get(kid);
  }

  async #refresh(): Promise<void> {
    const response = await this.#fetcher(this.#certsUrl);
    if (!response.ok) return;
    const { keys } = (await response.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const fresh = new Map<string, CryptoKey>();
    for (const jwk of keys) {
      // A key that cannot be imported for RS256 checks is skipped, so it cannot block the others.
      const key = await crypto.subtle
        .importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
        .catch(() => null);
      if (key) fresh.set(jwk.kid, key);
    }
    this.#keys = fresh;
  }
}

// Verifies a Cloudflare Access login token (RS256 JWT) for this app and returns its email, or null.
export async function loginEmail(
  token: string | null,
  keys: AccessKeys,
  teamDomain: string,
  audience: string,
  nowSeconds: number,
): Promise<string | null> {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3 || !teamDomain || !audience) return null;
  try {
    const head = json(parts[0]);
    if (head.alg !== "RS256" || typeof head.kid !== "string") return null;
    const key = await keys.find(head.kid);
    if (!key) return null;
    const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(parts[2]), signed))) return null;
    const claims = json(parts[1]);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience) || claims.iss !== teamDomain) return null;
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) return null;
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}
