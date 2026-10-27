import { longDate } from "./dates";
import type { Env } from "./index";
import { alertFailed } from "./notify";
import { encode, presign } from "./presign";
import { importLetterKey, open } from "./seal";
import { sendMoment } from "./sendtime";

export interface SendEnv extends Env {
  RESEND_API_KEY: string;
  SEND_DOMAIN: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// The furthest any zone's clock runs ahead of UTC (Kiribati, UTC+14).
const AHEAD = 14 * HOUR;
// Resend's docs say it keeps an idempotency key for 24 hours and refuses a different email under it (not captured
// here), so every try in those 24 hours sends the first try's links; they must still work at the end, while Resend
// fetches the files.
const LINK_SECONDS = 25 * 60 * 60;
// How a try's record starts when Resend refused the letter as invalid.
const INVALID = /^HTTP (400|422)\b/;

// Runs every minute and sends at most one letter: of those due, the one whose moment came first.
export async function sendDue(env: SendEnv, fetcher: Fetcher, now: number): Promise<void> {
  // send_local is local time in each letter's own zone, so SQL only narrows to letters that could be due somewhere.
  const latest = new Date(now + AHEAD).toISOString().slice(0, 16);
  const { results } = await env.DB.prepare(
    "SELECT id, send_local, send_zone FROM letters WHERE status = 'waiting' AND send_local <= ? AND (retry_at IS NULL OR retry_at <= ?)",
  )
    .bind(latest, now)
    .all<{ id: number; send_local: string; send_zone: string }>();

  let next: { id: number; moment: number } | undefined;
  for (const letter of results) {
    let moment: number;
    try {
      moment = sendMoment(letter.send_local, letter.send_zone);
    } catch {
      // A letter whose send time cannot be worked out is skipped, so it never holds up the others.
      continue;
    }
    if (moment > now) continue;
    if (!next || moment < next.moment || (moment === next.moment && letter.id < next.id)) {
      next = { id: letter.id, moment };
    }
  }
  if (next) await sendLetter(env, fetcher, next.id, now);
}

async function sendLetter(env: SendEnv, fetcher: Fetcher, id: number, now: number): Promise<void> {
  let email: { key: string; body: string; invalidBefore: boolean };
  try {
    email = await build(env, id, now);
  } catch (error) {
    // Resend was never called, so this is not a try and must not move where Resend's 24 hours start.
    await env.DB.prepare("UPDATE letters SET retry_at = ? WHERE id = ?")
      .bind(now + HOUR, id)
      .run();
    console.error(JSON.stringify({ event: "letter_not_built", letter: id, error: String(error) }));
    return;
  }

  // Counted as a try before Resend is called, so a run cut off mid-send waits an hour like any error,
  // and its retry signs the links at the same time and so sends the same email.
  const attempt = await tried(env, id, now, "No answer.");
  let outcome: "sent" | "failed" | "retry" = "retry";
  let detail: string;
  let reason: unknown;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": email.key,
      },
      body: email.body,
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    detail = describe(response.status, answer);
    reason = answer?.message;
    // Only a letter Resend refuses as invalid twice fails, so a passing problem fetching a file gets a second
    // chance; a wrong key, the day's limit or Resend's own trouble is always tried again later.
    if (response.ok) outcome = "sent";
    else if (INVALID.test(detail) && email.invalidBefore) outcome = "failed";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  if (outcome === "retry") {
    await env.DB.prepare("UPDATE send_attempts SET detail = ? WHERE id = ?").bind(detail, attempt).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE letters SET status = ?, sent_at = ?, retry_at = NULL WHERE id = ?").bind(
      outcome,
      outcome === "sent" ? now : null,
      id,
    ),
    env.DB.prepare("UPDATE send_attempts SET outcome = ?, detail = ? WHERE id = ?").bind(outcome, detail, attempt),
  ]);
  if (outcome === "failed") await alertFailed(env, fetcher, id, typeof reason === "string" ? reason : undefined);
}

// Records a call to Resend, to be repeated in an hour unless its answer says otherwise, and answers with its id.
async function tried(env: SendEnv, id: number, now: number, detail: string): Promise<number> {
  const [, attempt] = await env.DB.batch<{ id: number }>([
    env.DB.prepare("UPDATE letters SET retry_at = ? WHERE id = ?").bind(now + HOUR, id),
    env.DB.prepare(
      "INSERT INTO send_attempts (letter_id, tried_at, outcome, detail) VALUES (?, ?, 'retry', ?) RETURNING id",
    ).bind(id, now, detail),
  ]);
  return attempt.results[0].id;
}

// Resend's request body, as text, the letter's idempotency key, and whether Resend refused it as invalid before.
async function build(
  env: SendEnv,
  id: number,
  now: number,
): Promise<{ key: string; body: string; invalidBefore: boolean }> {
  const [letter, recipients, files, tries] = await Promise.all([
    env.DB.prepare("SELECT subject, body, written_at, written_zone, send_key FROM letters WHERE id = ?")
      .bind(id)
      .first<{ subject: number[]; body: number[]; written_at: number; written_zone: string; send_key: string }>(),
    env.DB.prepare("SELECT email FROM recipients WHERE letter_id = ? ORDER BY rowid")
      .bind(id)
      .all<{ email: number[] }>(),
    env.DB.prepare("SELECT key, name FROM files WHERE letter_id = ? ORDER BY id")
      .bind(id)
      .all<{ key: string; name: number[] }>(),
    env.DB.prepare("SELECT tried_at, detail FROM send_attempts WHERE letter_id = ? ORDER BY tried_at")
      .bind(id)
      .all<{ tried_at: number; detail: string | null }>(),
  ]);
  if (!letter) throw new Error("The letter was deleted.");
  const key = await importLetterKey(env.LETTER_KEY);
  const html = await open(letter.body, key);
  const subject = await open(letter.subject, key);

  // Resend's 24 hours for a key start at the first try after the last 24 hours ran out.
  let window: number | undefined;
  for (const { tried_at } of tries.results) if (window === undefined || tried_at - window >= DAY) window = tried_at;
  const signedAt = window !== undefined && now - window < DAY ? window : now;

  const attachments = await Promise.all(
    files.results.map(async (file) => ({
      filename: await open(file.name, key),
      path: await presign({
        method: "GET",
        url: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${encode(file.key)}`,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        region: "auto",
        expiresSeconds: LINK_SECONDS,
        now: new Date(signedAt),
      }),
    })),
  );
  // The owner always gets the letter; anyone else is in BCC, so recipients never see each other.
  const others = await Promise.all(recipients.results.map((r) => open(r.email, key)));
  const body = {
    from: `Timecapsule <letters@${env.SEND_DOMAIN}>`,
    to: [env.OWNER_EMAIL],
    ...(others.length ? { bcc: others } : {}),
    reply_to: env.OWNER_EMAIL,
    subject,
    html: framed(html, letter.written_at, letter.written_zone),
    attachments,
  };
  return {
    key: letter.send_key,
    body: JSON.stringify(body),
    invalidBefore: tries.results.some((t) => INVALID.test(t.detail ?? "")),
  };
}

// The letter as the recipients see it, with a footer saying when it was written. Dated in the owner's zone when the
// letter was first saved, like the subject; stored with the letter, so every try in
// Resend's 24 hours sends the same email and a lost "accepted" can never turn into a second send.
function framed(html: string, writtenAt: number, zone: string): string {
  return (
    '<div style="font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#222;max-width:640px">' +
    html +
    '<p style="margin-top:2.5em;padding-top:1em;border-top:1px solid #ddd;font-family:Arial,sans-serif;font-size:13px;color:#777">' +
    `Written on ${longDate(writtenAt, zone)}, sent with timecapsule</p></div>`
  );
}

// A try's record, as describe writes it, in plain words for the owner: Resend's own message, or that Resend never
// answered. Resend's error names are snake_case, such as validation_error.
export function lastAnswer(detail: string): string {
  const answered = /^HTTP \d+(?: [a-z]+_[a-z_]+)?(?: ([\s\S]+))?$/.exec(detail);
  if (!answered) return "Resend did not answer.";
  const message = answered[1]?.trim();
  if (!message) return "Resend answered with an error and no reason.";
  return `Resend's answer: ${/[.!?]$/.test(message) ? message : `${message}.`}`;
}

// Resend's answer in short: the sent email's id, or the error's name and message. Never the letter.
export function describe(status: number, answer: Record<string, unknown> | null): string {
  const parts = [`HTTP ${status}`];
  for (const field of ["id", "name", "message"]) {
    const value = answer?.[field];
    if (typeof value === "string") parts.push(value);
  }
  return parts.join(" ");
}
