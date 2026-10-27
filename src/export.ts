import { localDate } from "./dates";
import { Html, html, notFound } from "./html";
import type { Env } from "./index";
import { FAILED, type LetterTimes, when } from "./letter";
import { dayFormat } from "./letters";
import { importLetterKey, NAME_UNOPENED, open, openOr, SUBJECT_UNOPENED } from "./seal";
import { knownZone } from "./write";

// Short enough for every file system, with room left for the folders around it.
const NAME_BYTES = 100;
const encoder = new TextEncoder();

// Characters some file system refuses in a name become a dash. One Unicode form, so a name typed on a Mac and the same
// name typed elsewhere are seen as the same name and cannot overwrite each other.
const clean = (text: string) => text.normalize("NFC").replace(/[\p{Cc}<>:"/\\|?*]/gu, "-");

// Names Windows keeps for devices, whatever follows the first dot; it cannot unpack "con.jpg" or "aux.notes.pdf".
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(?=\.|$)/i;

// No leading dot, which hides a file, no trailing dot or space, which Windows drops, and at most max bytes.
function shorten(text: string, max: number): string {
  let out = "";
  let size = 0;
  for (const char of text.replace(/^[.\s]+/, "")) {
    size += encoder.encode(char).length;
    if (size > max) break;
    out += char;
  }
  return out.replace(/[.\s]+$/, "");
}

// Some file systems ignore case, so "Photo.jpg" and "photo.jpg" would overwrite each other.
function unique(stem: string, ending: string, taken: Set<string>): string {
  let name = stem + ending;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ending}`;
  taken.add(name.toLowerCase());
  return name;
}

// A letter's files under the names they get in the export. The server only accepts names with an ending.
function fileNames<T extends { name: string }>(files: T[]): (T & { saved: string })[] {
  const taken = new Set<string>();
  return files.map((file) => {
    const ending = /\.[a-z0-9]+$/i.exec(file.name)?.[0] ?? "";
    const stem = shorten(clean(file.name.slice(0, file.name.length - ending.length)), NAME_BYTES - ending.length);
    return { ...file, saved: unique(stem.replace(WINDOWS_DEVICE, "$1-") || "file", ending, taken) };
  });
}

// A blank or unknown zone falls back to UTC instead of breaking the export.
async function ownerZone(db: D1Database): Promise<string> {
  const settings = await db.prepare("SELECT time_zone FROM settings").first<{ time_zone: string | null }>();
  return settings?.time_zone && knownZone(settings.time_zone) ? settings.time_zone : "UTC";
}

// What goes in the zip and where each part is fetched from; the owner's browser builds the zip. Each letter gets a
// folder named by the date it was written and its subject.
export async function exportList(env: Env, now: number): Promise<Response> {
  const db = env.DB;
  const zone = await ownerZone(db);
  const root = `timecapsule-export-${localDate(now, zone)}`;
  const [letters, files] = await Promise.all([
    db
      .prepare("SELECT id, subject, written_at FROM letters ORDER BY written_at, id")
      .all<{ id: number; subject: number[]; written_at: number }>(),
    db
      .prepare("SELECT id, letter_id, name FROM files ORDER BY id")
      .all<{ id: number; letter_id: number; name: number[] }>(),
  ]);
  const key = await importLetterKey(env.LETTER_KEY);
  const byLetter = new Map<number, { id: number; name: string }[]>();
  for (const file of files.results) {
    const opened = { id: file.id, name: await openOr(file.name, key, NAME_UNOPENED) };
    byLetter.set(file.letter_id, [...(byLetter.get(file.letter_id) ?? []), opened]);
  }

  const taken = new Set<string>();
  const entries: { path: string; url: string }[] = [];
  for (const letter of letters.results) {
    const subject = await openOr(letter.subject, key, SUBJECT_UNOPENED);
    const folder = `${root}/${unique(shorten(clean(`${localDate(letter.written_at, zone)} ${subject}`), NAME_BYTES), "", taken)}`;
    entries.push({ path: `${folder}/letter.html`, url: `/export/letters/${letter.id}` });
    for (const file of fileNames(byLetter.get(letter.id) ?? [])) {
      entries.push({ path: `${folder}/${file.saved}`, url: `/letters/${letter.id}/files/${file.id}` });
    }
  }
  return Response.json({ name: `${root}.zip`, entries });
}

// A letter as a page of its own, waiting or not, linking to its files beside it in the same folder. Its policy stops
// any script in the stored HTML from running when the page is opened from the export.
export async function exportPage(env: Env, id: number): Promise<Response> {
  const letter = await env.DB.prepare(
    "SELECT subject, body, send_local, send_zone, written_at, status, sent_at FROM letters WHERE id = ?",
  )
    .bind(id)
    .first<LetterTimes & { subject: number[]; body: number[]; written_at: number }>();
  if (!letter) return notFound();
  const [day, recipients, files] = await Promise.all([
    ownerZone(env.DB).then(dayFormat),
    env.DB.prepare("SELECT email FROM recipients WHERE letter_id = ? ORDER BY rowid")
      .bind(id)
      .all<{ email: number[] }>(),
    env.DB.prepare("SELECT name FROM files WHERE letter_id = ? ORDER BY id").bind(id).all<{ name: number[] }>(),
  ]);

  // One letter that cannot be opened must not stop the owner exporting the others.
  const key = await importLetterKey(env.LETTER_KEY);
  let body = html`<p>This letter's text could not be opened.</p>`;
  try {
    body = new Html(await open(letter.body, key));
  } catch {}
  const subject = await openOr(letter.subject, key, SUBJECT_UNOPENED);
  const emails = await Promise.all(recipients.results.map((r) => openOr(r.email, key, "Address could not be opened")));
  const names = await Promise.all(
    files.results.map(async (file) => ({ name: await openOr(file.name, key, NAME_UNOPENED) })),
  );

  const others = emails.join(", ");
  const links = fileNames(names).map(
    (file) => html`<li><a href="${encodeURIComponent(file.saved)}">${file.saved}</a></li>`,
  );
  const page = html`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta http-equiv="content-security-policy" content="script-src 'none'">
<title>${subject}</title>
<style>body { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; font: 16px / 1.5 system-ui, sans-serif; }</style>
<h1>${subject}</h1>
<p>${when(letter, day)}</p>
<p>Written ${day.format(letter.written_at)}</p>
${others ? html`<p>Recipients besides you: ${others}</p>` : html``}${letter.status === "failed" ? html`<p>${FAILED}</p>` : html``}
${body}
${links.length ? html`<ul>${links}</ul>` : html``}
</html>
`;
  return new Response(page.text, { headers: { "content-type": "text/html; charset=utf-8" } });
}
