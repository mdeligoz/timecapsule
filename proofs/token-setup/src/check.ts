import { presign } from "./presign";

export type CheckInput = {
  accountId: string;
  bucket: string;
  otherBucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  viewer: string | null;
  fetch: typeof globalThis.fetch;
};

export type CheckResult = { name: string; passed: boolean; detail: string };

export async function checkStorage(input: CheckInput): Promise<CheckResult[]> {
  const { fetch } = input;
  const sign = (method: string, bucket: string, key: string) =>
    presign({
      method,
      url: `https://${input.accountId}.r2.cloudflarestorage.com/${bucket}/${key}`,
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      region: "auto",
      expiresSeconds: 3600,
    });
  const key = `proof-${crypto.randomUUID()}.txt`;
  const written = `written ${new Date().toISOString()}`;
  const put = await fetch(await sign("PUT", input.bucket, key), { method: "PUT", body: written });
  const get = await fetch(await sign("GET", input.bucket, key));
  const read = await get.text();
  const deleted = await fetch(await sign("DELETE", input.bucket, key), { method: "DELETE" });
  const other = await fetch(await sign("PUT", input.otherBucket, key), { method: "PUT", body: written });
  return [
    { name: "Upload a file through a signed link", passed: put.ok, detail: `HTTP ${put.status}` },
    {
      name: "Download it, unchanged",
      passed: get.ok && read === written,
      detail: `HTTP ${get.status}, ${read === written ? "same text" : "different text"}`,
    },
    { name: "Delete it", passed: deleted.ok, detail: `HTTP ${deleted.status}` },
    {
      name: "The key is refused on any other bucket",
      passed: other.status === 403,
      detail: `upload to another bucket got HTTP ${other.status}`,
    },
    { name: "Only the owner got past the login", passed: input.viewer !== null, detail: input.viewer ?? "nobody signed in" },
  ];
}

export function verdict(results: CheckResult[]): string {
  const failed = results.filter((r) => !r.passed).length;
  return failed === 0 ? "PASS: every check passed." : `FAIL: ${failed} of ${results.length} checks failed.`;
}
