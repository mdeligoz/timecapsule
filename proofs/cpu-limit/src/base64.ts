export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const plain = atob(text);
  const bytes = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) bytes[i] = plain.charCodeAt(i);
  return bytes;
}
