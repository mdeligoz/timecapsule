import { fromBase64, toBase64 } from "./base64";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function importKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

// AES-256-GCM; stored as base64 of the 12-byte nonce followed by the ciphertext.
export async function seal(text: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(key), encoder.encode(text)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64(out);
}

export async function open(stored: string, key: string): Promise<string> {
  const bytes = fromBase64(stored);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, await importKey(key), bytes.subarray(12));
  return decoder.decode(plain);
}
