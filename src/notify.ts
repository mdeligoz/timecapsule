import { localDate } from "./dates";
import { sendTime } from "./letters";
import { importLetterKey, openOr, SUBJECT_UNOPENED } from "./seal";
import { describe, type Fetcher, type SendEnv } from "./send";
import { sendMoment } from "./sendtime";

type Letter = { subject: number[]; send_local: string; send_zone: string; status: string; retry_at: number | null };

const count = (n: number) => `${n} ${n === 1 ? "letter" : "letters"}`;

// An email from the app to the owner, as plain text. Tried once: one Resend refuses is only logged.
async function tellOwner(
  env: SendEnv,
  fetcher: Fetcher,
  subject: string,
  text: string,
  event: Record<string, unknown>,
): Promise<void> {
  let error: string;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `Timecapsule <letters@${env.SEND_DOMAIN}>`, to: [env.OWNER_EMAIL], subject, text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return;
    error = describe(response.status, (await response.json().catch(() => null)) as Record<string, unknown> | null);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  console.error(JSON.stringify({ ...event, error }));
}

// Tells the owner a letter failed, if the failure alert is on. reason is Resend's own message, when it gave one.
export async function alertFailed(
  env: SendEnv,
  fetcher: Fetcher,
  id: number,
  reason: string | undefined,
): Promise<void> {
  const [settings, letter] = await Promise.all([
    env.DB.prepare("SELECT failure_alert FROM settings").first<{ failure_alert: number }>(),
    env.DB.prepare("SELECT subject, send_local, send_zone FROM letters WHERE id = ?").bind(id).first<Letter>(),
  ]);
  if (settings?.failure_alert !== 1 || !letter) return;
  const subject = await openOr(letter.subject, await importLetterKey(env.LETTER_KEY), SUBJECT_UNOPENED);
  const text =
    `Your letter "${subject}", due ${sendTime(letter.send_local, letter.send_zone)}, was not sent.\n` +
    (reason ? `Resend refused it: ${reason}\n` : "Resend refused it.\n") +
    'It will not be tried again. It stays on your Waiting list, marked "Not sent".\n';
  await tellOwner(env, fetcher, `Not sent: ${subject}`, text, { event: "alert_not_sent", letter: id });
}

// The month (YYYY-MM) in the owner's zone; a blank or unknown zone counts as UTC.
function ownerMonth(now: number, zone: string | null): string {
  try {
    return localDate(now, zone || "UTC").slice(0, 7);
  } catch {
    return localDate(now, "UTC").slice(0, 7);
  }
}

// A letter whose send time cannot be worked out counts as last.
function moment(letter: Letter): number {
  try {
    return sendMoment(letter.send_local, letter.send_zone);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// On the first run of each month in the owner's zone, an email with the letters waiting and the next send time,
// if the monthly status email is on and there is anything to report.
export async function sendStatus(env: SendEnv, fetcher: Fetcher, now: number): Promise<void> {
  const settings = await env.DB.prepare("SELECT time_zone, monthly_status, last_status_month FROM settings").first<{
    time_zone: string | null;
    monthly_status: number;
    last_status_month: string | null;
  }>();
  if (!settings) return;
  const month = ownerMonth(now, settings.time_zone);
  // Only a later month counts, so a new zone that moves the owner's clock back a day never sends a month twice.
  if (settings.last_status_month !== null && settings.last_status_month >= month) return;
  // The month is claimed before Resend is called, so a run cut off mid-send or running alongside never sends it twice.
  // It passes whether or not the email is on; the first month after install is only noted, so the first email
  // goes on the next 1st.
  const claimed = await env.DB.prepare("UPDATE settings SET last_status_month = ? WHERE last_status_month IS ?")
    .bind(month, settings.last_status_month)
    .run();
  if (claimed.meta.changes !== 1 || settings.last_status_month === null || settings.monthly_status !== 1) return;

  const { results } = await env.DB.prepare(
    "SELECT subject, send_local, send_zone, status, retry_at FROM letters WHERE status IN ('waiting', 'failed')",
  ).all<Letter>();
  if (!results.length) return;
  const waiting = results.filter((letter) => letter.status === "waiting");
  const failed = results.length - waiting.length;

  const lines: string[] = [];
  if (waiting.length) {
    const moments = new Map(waiting.map((letter) => [letter, moment(letter)]));
    const next = waiting.reduce((a, b) => ((moments.get(b) ?? 0) < (moments.get(a) ?? 0) ? b : a));
    const when = sendTime(next.send_local, next.send_zone);
    // Only a letter that already had a try waits for another; one merely queued behind others is not late.
    const late = next.retry_at !== null;
    const subject = await openOr(next.subject, await importLetterKey(env.LETTER_KEY), SUBJECT_UNOPENED);
    lines.push(
      `${count(waiting.length)} waiting. Next: "${subject}"${late ? `, due ${when} \u2014 late, still being tried.` : ` on ${when}.`}`,
    );
  } else lines.push("No letters waiting.");
  if (failed) lines.push(`${count(failed)} not sent: Resend refused ${failed === 1 ? "it" : "them"}.`);
  const subject = waiting.length
    ? `Timecapsule: ${count(waiting.length)} waiting`
    : `Timecapsule: ${count(failed)} not sent`;
  await tellOwner(env, fetcher, subject, `${lines.join("\n")}\n`, { event: "status_not_sent", month });
}
