import { codedAddress, EMAIL } from "./address";
import { DAY, defaultSubject, HOUR, sendDateLimits, yearsLater } from "./dates";
import { type Html, html } from "./html";
import type { Env } from "./index";
import { FILES_LIMIT, RECIPIENT_LIMIT, TEXT_LIMIT } from "./limits";
import { importLetterKey, seal } from "./seal";
import { sendMoment } from "./sendtime";

// The subject and each file name; both end up in the email.
const NAME_LIMIT = 200;
// A save refuses files added longer ago than this, and the clean-up takes them an hour later, so it never takes one
// being saved.
const UPLOAD_LIMIT = 7 * DAY;
// R2 removes at most 1,000 objects in one call.
const CLEAR_LIMIT = 1000;

// The allowed files by name ending. The server sets the type, so a file's type never comes from the browser.
const TYPES = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["pdf", "application/pdf"],
]);
const ACCEPT = [...TYPES.keys()].map((ending) => `.${ending}`).join(",");

// uploads names the added files a refusal is about, so the page can mark them.
const refuse = (error: string, uploads?: number[]) => Response.json({ error, uploads }, { status: 400 });

function randomKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Why a letter can no longer be changed, or null while it can: it locks 48 hours after it was written, and once its
// send time has passed, so what goes out, and every retry of it, is the letter as it was then. A send time that can no
// longer be worked out never sends, so it stays open to be fixed.
export function lockedBecause(letter: { written_at: number; send_local: string; send_zone: string }, now: number) {
  let moment = Number.POSITIVE_INFINITY;
  try {
    moment = sendMoment(letter.send_local, letter.send_zone);
  } catch {}
  if (moment <= now) return "This letter can no longer be changed: its send time has passed.";
  if (now - letter.written_at >= 2 * DAY) {
    return "This letter can no longer be changed: a letter is locked 48 hours after it was written.";
  }
  return null;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Every zone the runtime knows, with the picked one selected. The runtime's list leaves out UTC.
export function zoneOptions(picked: string): Html[] {
  const zones = Intl.supportedValuesOf("timeZone");
  for (const extra of ["UTC", picked]) if (extra && !zones.includes(extra)) zones.push(extra);
  return zones.map((z) => html`<option value="${z}"${z === picked ? html` selected` : html``}>${z}</option>`);
}

const CALENDAR_ICON = html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="2.5" y="4" width="15" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 8h15M6.5 2.5v3M13.5 2.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// A saved letter, as Edit opens it.
export type Draft = {
  id: number;
  subject: string;
  markdown: string;
  sendLocal: string;
  zone: string;
  writtenAt: number;
  recipients: string[];
  files: { id: number; name: string; size: number }[];
};

// Screen 2, empty for a new letter or filled in to edit one.
// With no zone saved yet, a new letter's dates are in UTC and the page's script redoes them in the browser's zone.
export async function writePage(db: D1Database, now: number, ownerEmail: string, draft?: Draft): Promise<Html> {
  const settings = await db.prepare("SELECT time_zone FROM settings").first<{ time_zone: string | null }>();
  const saved = settings?.time_zone && knownZone(settings.time_zone) ? settings.time_zone : "";
  const picked = draft?.zone ?? saved;
  const zone = picked || "UTC";
  // The send date is measured from when the letter was written, which for an edit is earlier than now.
  const limits = sendDateLimits(draft?.writtenAt ?? now, zone);
  const hour = draft?.sendLocal.slice(11) ?? "09:00";
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const hourOptions = hours.map(
    (h) => html`<option value="${h}"${h === hour ? html` selected` : html``}>${h}</option>`,
  );
  const files = (draft?.files ?? []).map(
    (file) =>
      html`<li data-file="${file.id}" data-size="${file.size}" data-name="${file.name}">${file.name} (${megabytes(file.size)})</li>`,
  );

  // A textarea drops the first line break after its tag, so one is put there to keep any the letter starts with.
  return html`<h1>${draft ? "Edit the letter" : "Write a letter"}</h1>
<form id="letter" class="write"${draft ? html` data-letter="${draft.id}" data-written="${draft.writtenAt}"` : html``}>
<label>Subject <input name="subject" value="${draft?.subject ?? defaultSubject(now, zone)}" maxlength="${NAME_LIMIT}" required></label>
<div class="editor">
<div class="toolbar" role="toolbar" aria-label="Formatting">
<button type="button" data-before="**" data-after="**">Bold</button>
<button type="button" data-before="*" data-after="*">Italic</button>
<button type="button" data-line="# ">Heading</button>
<button type="button" data-line="- ">List</button>
<button type="button" data-line="> ">Quote</button>
<button type="button" data-before="[" data-after="](https://)">Link</button>
<button type="button" class="preview-toggle" aria-pressed="false">Preview</button>
</div>
<textarea name="text" aria-label="Letter" rows="16" maxlength="${TEXT_LIMIT}">
${draft?.markdown ?? ""}</textarea>
<div class="preview" hidden></div>
</div>
<fieldset class="send">
<legend>Send on</legend>
<div class="date-field"><span class="name" id="date-name">Date</span>
<input type="hidden" name="date" min="${limits.min}" max="${limits.max}" value="${draft?.sendLocal.slice(0, 10) ?? ""}">
<div class="date-picker"><button type="button" class="date-toggle" aria-haspopup="dialog" aria-expanded="false" aria-labelledby="date-name date-value"><span id="date-value">Pick a date</span>${CALENDAR_ICON}</button></div>
</div>
<label>Hour <select name="hour">${hourOptions}</select></label>
<label>Time zone <select name="zone" required><option value="">Pick a time zone</option>${zoneOptions(picked)}</select></label>
</fieldset>
<label for="recipients">Recipients</label>
<div class="to-box"><p class="to-you" id="to-you">You (${ownerEmail}) always get this letter.</p><textarea id="recipients" name="recipients" aria-describedby="to-you" data-owner="${ownerEmail}" rows="3" placeholder="Other people's addresses, one per line">${draft?.recipients.join("\n") ?? ""}</textarea></div>
<p class="hint">Up to ${RECIPIENT_LIMIT} more people.</p>
<label class="files-label">Files <span class="drop-zone"><span class="pick">Add files</span> <span class="drop-text">or drop them here</span><input type="file" multiple accept="${ACCEPT}" aria-label="Files"></span></label>
<p class="hint">JPG, PNG, GIF, WebP, HEIC, MP4, MOV or PDF, up to 25 MB in total. <span class="total"></span></p>
<ul class="files">${files}</ul>
<p class="error" role="alert"></p>
<button class="button" type="submit">Save</button>
</form>
<script type="module" src="/write.js"></script>`;
}

// Streams one file to R2 as soon as it is added, before the letter is saved.
export async function addUpload(request: Request, env: Env, url: URL, now: number): Promise<Response> {
  const name = url.searchParams.get("name")?.trim() ?? "";
  const type = TYPES.get(/\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? "");
  if (!type) return refuse("Only JPG, PNG, GIF, WebP, HEIC, MP4, MOV and PDF files can be added.");
  if (name.length > NAME_LIMIT)
    return refuse(`The file's name is over ${NAME_LIMIT} characters; rename it and add it again.`);
  const length = request.headers.get("content-length");
  if (length === null || !/^\d+$/.test(length)) return refuse("The file's size was not sent; add it again.");
  if (Number(length) > FILES_LIMIT) return refuse("A letter's files can come to 25 MB at most.");
  const key = randomKey();
  const object = await env.FILES.put(key, request.body ?? "", { httpMetadata: { contentType: type } });
  // Without its row nothing could ever find the file again, so it leaves R2 too.
  let row: { id: number } | null;
  try {
    row = await env.DB.prepare(
      "INSERT INTO uploads (key, name, type, size, uploaded_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(key, await seal(name, await importLetterKey(env.LETTER_KEY)), type, object.size, now)
      .first<{ id: number }>();
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }
  return Response.json({ id: row?.id, name, size: object.size }, { status: 201 });
}

// Files added to letters that were never saved. Runs with the send job; the R2 objects go before the rows,
// so a failure leaves the rows for the next run to try again.
export async function clearUploads(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, key FROM uploads WHERE uploaded_at < ? LIMIT ?")
    .bind(now - UPLOAD_LIMIT - HOUR, CLEAR_LIMIT)
    .all<{ id: number; key: string }>();
  if (results.length === 0) return;
  await env.FILES.delete(results.map((row) => row.key));
  await env.DB.prepare("DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(results.map((row) => row.id)))
    .run();
}

// The R2 object goes before the row, so a failure never leaves a file in R2 that nothing points to.
export async function removeUpload(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT key FROM uploads WHERE id = ?").bind(id).first<{ key: string }>();
  if (row) {
    await env.FILES.delete(row.key);
    await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
  }
  return new Response(null, { status: 204 });
}

type Input = {
  subject?: unknown;
  markdown?: unknown;
  html?: unknown;
  sendLocal?: unknown;
  zone?: unknown;
  recipients?: unknown;
  files?: unknown;
  uploads?: unknown;
};

type Checked = {
  subject: string;
  markdown: string;
  body: string;
  sendLocal: string;
  zone: string;
  emails: string[];
  // The added files' upload ids, as JSON for json_each.
  uploads: string;
};

const readInput = (request: Request) => request.json<Input>().catch(() => null);

// The rules for a new letter and for an edited one. The send time is measured from when the letter was written;
// keptBytes is the size of the files an edit keeps.
async function check(
  input: Input | null,
  env: Env,
  now: number,
  written: number,
  keptBytes = 0,
): Promise<Checked | Response> {
  if (input === null || typeof input !== "object") return refuse("The request is not a letter.");
  const { subject, markdown, html: body, sendLocal, zone, recipients, uploads } = input;

  if (typeof subject !== "string" || !subject.trim()) return refuse("Give the letter a subject.");
  if (subject.trim().length > NAME_LIMIT) return refuse(`The subject is over ${NAME_LIMIT} characters.`);
  if (typeof markdown !== "string" || typeof body !== "string") return refuse("The request is not a letter.");
  if (markdown.length > TEXT_LIMIT) return refuse("The letter is over 50,000 characters.");

  if (typeof zone !== "string" || !knownZone(zone)) return refuse("Pick a time zone from the list.");
  if (typeof sendLocal !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(sendLocal)) {
    return refuse("Pick a send date and a whole hour.");
  }
  let moment: number;
  try {
    moment = sendMoment(sendLocal, zone);
  } catch {
    return refuse("Pick a send date that exists.");
  }
  if (moment < written + 7 * DAY) return refuse("The send time must be at least 7 days after the letter was written.");
  if (moment > yearsLater(written, 20))
    return refuse("The send time must be at most 20 years after the letter was written.");

  // The owner always gets the letter, so their address is not one of the 20.
  if (!Array.isArray(recipients)) return refuse("The request is not a letter.");
  const seen = new Set([env.OWNER_EMAIL.toLowerCase()]);
  const emails: string[] = [];
  for (const entry of recipients) {
    if (typeof entry !== "string") return refuse("The request is not a letter.");
    const typed = entry.trim();
    if (!typed) continue;
    const email = codedAddress(typed);
    if (!EMAIL.test(email)) return refuse(`"${typed}" is not an email address.`);
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    emails.push(email);
  }
  if (emails.length > RECIPIENT_LIMIT)
    return refuse(`A letter can go to at most ${RECIPIENT_LIMIT} people besides you.`);

  if (!Array.isArray(uploads) || !uploads.every(Number.isSafeInteger)) return refuse("The request is not a letter.");
  const unique = [...new Set(uploads)];
  const ids = JSON.stringify(unique);
  const { results: files } = await env.DB.prepare(
    "SELECT id, size, uploaded_at FROM uploads WHERE id IN (SELECT value FROM json_each(?))",
  )
    .bind(ids)
    .all<{ id: number; size: number; uploaded_at: number }>();
  const found = new Set(files.map((file) => file.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    return refuse(
      "A file did not finish adding, or was added more than 7 days ago. Remove it and add it again.",
      missing,
    );
  }
  const old = files.filter((file) => file.uploaded_at < now - UPLOAD_LIMIT).map((file) => file.id);
  if (old.length) return refuse("A file was added more than 7 days ago. Remove it and add it again.", old);
  if (files.reduce((sum, file) => sum + file.size, keptBytes) > FILES_LIMIT) {
    return refuse("The files come to more than 25 MB in total.");
  }
  return { subject: subject.trim(), markdown, body, sendLocal, zone, emails, uploads: ids };
}

// A new letter counts as written when its Write page opened, so its send-time limits are the hours the page offered,
// but never from more than 3 hours before Save (owner's call): a long writing session does not make Save refuse the
// earliest hour offered, and a slow browser clock cannot move the 7 days back by more than that.
// Stored as its written time, the same moment rules its edits and its 48-hour lock.
function countedFrom(input: unknown, now: number): number {
  const opened = (input as { opened?: unknown } | null)?.opened;
  return Number.isSafeInteger(opened) && (opened as number) <= now && (opened as number) >= now - 3 * HOUR
    ? (opened as number)
    : now;
}

// The owner's browser sends the Markdown and the HTML it made from it; the server never runs Markdown.
export async function saveLetter(request: Request, env: Env, now: number): Promise<Response> {
  const input = await readInput(request);
  const written = countedFrom(input, now);
  const letter = await check(input, env, now, written);
  if (letter instanceof Response) return letter;

  // One batch, so a letter is never left without its recipients or files. They find the new letter by its send key.
  const key = await importLetterKey(env.LETTER_KEY);
  const sendKey = randomKey();
  // With no zone saved, the page dated the subject in the browser's zone, which it also picked as the letter's.
  const settings = await env.DB.prepare("SELECT time_zone FROM settings").first<{ time_zone: string | null }>();
  const writtenZone = settings?.time_zone && knownZone(settings.time_zone) ? settings.time_zone : letter.zone;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO letters (subject, body, source, send_local, send_zone, written_at, written_zone, send_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      await seal(letter.subject, key),
      await seal(letter.body, key),
      await seal(letter.markdown, key),
      letter.sendLocal,
      letter.zone,
      written,
      writtenZone,
      sendKey,
    ),
    // One insert per recipient, in the order typed: sealed addresses cannot go through json_each.
    ...(await Promise.all(
      letter.emails.map(async (email) =>
        env.DB.prepare("INSERT INTO recipients (letter_id, email) SELECT id, ? FROM letters WHERE send_key = ?").bind(
          await seal(email, key),
          sendKey,
        ),
      ),
    )),
    env.DB.prepare(
      "INSERT INTO files (letter_id, key, name, type, size) SELECT (SELECT id FROM letters WHERE send_key = ?), key, name, type, size FROM uploads WHERE id IN (SELECT value FROM json_each(?))",
    ).bind(sendKey, letter.uploads),
    env.DB.prepare("DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?))").bind(letter.uploads),
  ]);
  return Response.json({ location: "/" }, { status: 201 });
}

// Edit sends the ids of the files it keeps; the letter's other files are removed.
export async function updateLetter(request: Request, env: Env, id: number, now: number): Promise<Response> {
  const saved = await env.DB.prepare("SELECT written_at, send_local, send_zone FROM letters WHERE id = ?")
    .bind(id)
    .first<{ written_at: number; send_local: string; send_zone: string }>();
  if (!saved) return refuse("This letter no longer exists.");
  const locked = lockedBecause(saved, now);
  if (locked) return refuse(locked);

  const input = await readInput(request);
  const files = input?.files;
  if (!Array.isArray(files) || !files.every(Number.isSafeInteger)) return refuse("The request is not a letter.");
  const unique = [...new Set(files)];
  const keep = JSON.stringify(unique);
  const { results: kept } = await env.DB.prepare(
    "SELECT size FROM files WHERE letter_id = ? AND id IN (SELECT value FROM json_each(?))",
  )
    .bind(id, keep)
    .all<{ size: number }>();
  if (kept.length !== unique.length) return refuse("A file on this letter has changed. Reload the page.");
  const letter = await check(
    input,
    env,
    now,
    saved.written_at,
    kept.reduce((sum, file) => sum + file.size, 0),
  );
  if (letter instanceof Response) return letter;

  const { results: removed } = await env.DB.prepare(
    "SELECT key FROM files WHERE letter_id = ? AND id NOT IN (SELECT value FROM json_each(?))",
  )
    .bind(id, keep)
    .all<{ key: string }>();
  // Removed files go back on the uploads list in the same batch, so a file in R2 always has a row pointing to it.
  const key = await importLetterKey(env.LETTER_KEY);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE letters SET subject = ?, body = ?, source = ?, send_local = ?, send_zone = ? WHERE id = ?",
    ).bind(
      await seal(letter.subject, key),
      await seal(letter.body, key),
      await seal(letter.markdown, key),
      letter.sendLocal,
      letter.zone,
      id,
    ),
    env.DB.prepare("DELETE FROM recipients WHERE letter_id = ?").bind(id),
    ...(await Promise.all(
      letter.emails.map(async (email) =>
        env.DB.prepare("INSERT INTO recipients (letter_id, email) VALUES (?, ?)").bind(id, await seal(email, key)),
      ),
    )),
    env.DB.prepare(
      "INSERT INTO uploads (key, name, type, size, uploaded_at) SELECT key, name, type, size, ? FROM files WHERE letter_id = ? AND id NOT IN (SELECT value FROM json_each(?))",
    ).bind(now, id, keep),
    env.DB.prepare("DELETE FROM files WHERE letter_id = ? AND id NOT IN (SELECT value FROM json_each(?))").bind(
      id,
      keep,
    ),
    env.DB.prepare(
      "INSERT INTO files (letter_id, key, name, type, size) SELECT ?, key, name, type, size FROM uploads WHERE id IN (SELECT value FROM json_each(?))",
    ).bind(id, letter.uploads),
    env.DB.prepare("DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?))").bind(letter.uploads),
  ]);
  // The edit is saved; a removed file that cannot leave R2 now stays on the uploads list, which the clean-up clears.
  try {
    for (const file of removed) {
      await env.FILES.delete(file.key);
      await env.DB.prepare("DELETE FROM uploads WHERE key = ?").bind(file.key).run();
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "edit_cleanup_failed", letter: id, error: String(error) }));
  }
  return Response.json({ location: `/letters/${id}` });
}
