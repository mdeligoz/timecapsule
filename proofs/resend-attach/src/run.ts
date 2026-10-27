// Proof that Resend attaches files fetched by link: upload three files to a private R2 bucket, sign a one-hour
// link per file, and have Resend attach them to one email. Settings come from the environment;
// nothing secret is written to disk.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEmail } from "./email.ts";
import { presign } from "./presign.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};

const ACCOUNT = env("R2_ACCOUNT_ID");
const BUCKET = env("R2_BUCKET");
const KEYS = { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY"), region: "auto" };
const RESEND_API_KEY = env("RESEND_API_KEY");
const FROM = env("FROM");
const TO = env("TO");
const MB = 1024 * 1024;
const FIXTURES = join(import.meta.dirname, "..", "fixtures");

// 25 MB in total: the app's per-letter limit.
const FILES = [
  { name: "photo.jpg", size: 1 * MB },
  { name: "video.mp4", size: 4 * MB },
  { name: "scan.pdf", size: 20 * MB },
];

const objectUrl = (name: string) => `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}/${name}`;

function check(passed: boolean, what: string): void {
  console.log(`${what}: ${passed ? "yes" : "NO"}`);
  if (!passed) throw new Error(`Stopped: ${what} failed`);
}

// Saves a real Resend answer as a fixture, only when it is the kind of answer the fixture claims to be.
function saveFixture(name: string, expectedStatus: number, answer: { status: number; body: unknown }): void {
  check(answer.status === expectedStatus, `${name} answered HTTP ${expectedStatus} (got ${answer.status})`);
  writeFileSync(join(FIXTURES, `${name}.json`), `${JSON.stringify(answer, null, 2)}\n`);
}

async function sendToResend(body: unknown, idempotencyKey: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const links = [];
for (const file of FILES) {
  const put = await presign({ method: "PUT", url: objectUrl(file.name), ...KEYS, expiresSeconds: 300 });
  const upload = await fetch(put, { method: "PUT", body: randomBytes(file.size) });
  console.log(`upload ${file.name} (${file.size / MB} MB): HTTP ${upload.status}`);
  if (!upload.ok) throw new Error(await upload.text());
  links.push({ filename: file.name, url: await presign({ method: "GET", url: objectUrl(file.name), ...KEYS, expiresSeconds: 3600 }) });
}

const unsigned = await fetch(objectUrl(FILES[0].name));
check(unsigned.status === 400 || unsigned.status === 403, `plain link refused (HTTP ${unsigned.status})`);
const signed = await fetch(links[0].url, { headers: { range: "bytes=0-0" } });
check(signed.ok, `signed link works (HTTP ${signed.status})`);

const stamp = new Date().toISOString();
const accepted = await sendToResend(
  buildEmail({
    from: FROM,
    to: TO,
    subject: `timecapsule attachment proof ${stamp}`,
    html: "<p>Three attachments should be here: photo.jpg (1 MB), video.mp4 (4 MB), scan.pdf (20 MB).</p>",
    files: links,
  }),
  `proof-${stamp}`,
);
console.log("send:", accepted.status, JSON.stringify(accepted.body));
saveFixture("resend-accepted", 200, accepted);

const rejected = await sendToResend(
  buildEmail({ from: FROM, to: "not-an-email", subject: "rejected on purpose", html: "<p>x</p>", files: [] }),
  `proof-rejected-${stamp}`,
);
console.log("deliberate rejection:", rejected.status, JSON.stringify(rejected.body));
saveFixture("resend-rejected", 422, rejected);
