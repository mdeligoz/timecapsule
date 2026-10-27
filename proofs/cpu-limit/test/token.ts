// Signs Access-style login tokens (RS256 JWTs) for tests.
const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export type Signer = { jwks: string; sign: (claims: Record<string, unknown>) => Promise<string> };

export async function makeSigner(kid = "key-1"): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    jwks: JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256" }] }),
    async sign(claims) {
      const head = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
      const body = base64url(encoder.encode(JSON.stringify(claims)));
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(`${head}.${body}`));
      return `${head}.${body}.${base64url(signature)}`;
    },
  };
}
