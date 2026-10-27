// The address rule shared by the server and the Write letter screen's script. Resend refuses an address that breaks
// it at send time, when the letter may be locked: the part before @ is runs of allowed characters joined by single
// dots, and the domain is dot-separated letters, digits and hyphens ending in two or more letters, or in the coded
// form of an ending in other scripts, such as xn--p1ai for .рф.
export const EMAIL = /^[\w!#$%&'*+/=?^`{|}~-]+(\.[\w!#$%&'*+/=?^`{|}~-]+)*@([a-z\d-]+\.)+([a-z]{2,}|xn--[a-z\d-]+)$/i;

// Resend refuses a domain written in other scripts ("contains non-ASCII characters") but takes its coded form, so
// ivan@пример.рф becomes ivan@xn--e1afmkfd.xn--p1ai (captured 2026-10-22). Any other address is left as typed.
export function codedAddress(address: string): string {
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  if (at < 0 || !/[^\p{ASCII}]/u.test(domain) || !/^[\p{L}\p{M}\p{N}.-]+$/u.test(domain)) return address;
  try {
    return `${address.slice(0, at)}@${new URL(`http://${domain}`).hostname}`;
  } catch {
    return address;
  }
}
