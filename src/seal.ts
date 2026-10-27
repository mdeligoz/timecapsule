const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The Worker secret is base64 of 32 random bytes. Import it once per request or run, not once per letter.
export async function importLetterKey(secret: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("The letter key must be 32 bytes.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// AES-256-GCM; stored as the 12-byte nonce followed by the ciphertext.
export async function seal(text: string, key: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(text)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return out;
}

// Takes the stored bytes as seal made them or as D1 returns a BLOB (a plain array of numbers).
export async function open(blob: Uint8Array | ArrayLike<number>, key: CryptoKey): Promise<string> {
  const stored = Uint8Array.from(blob);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: stored.subarray(0, 12) }, key, stored.subarray(12));
  return decoder.decode(plain);
}

// A letter's details are sealed as its text is. One that cannot be opened (a different key, damaged data) is shown
// as fallback, so one letter never breaks a screen.
export async function openOr(blob: Uint8Array | ArrayLike<number>, key: CryptoKey, fallback: string): Promise<string> {
  try {
    return await open(blob, key);
  } catch {
    return fallback;
  }
}

export const SUBJECT_UNOPENED = "Subject could not be opened";
export const NAME_UNOPENED = "Name could not be opened";
