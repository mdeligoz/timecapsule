import { Html, html, notFound, page } from "./html";
import type { Env } from "./index";
import { dayFormat, sendTime } from "./letters";
import { importLetterKey, NAME_UNOPENED, open, openOr, SUBJECT_UNOPENED } from "./seal";
import { type Draft, lockedBecause, writePage } from "./write";

export type LetterTimes = { send_local: string; send_zone: string; status: string; sent_at: number | null };

type Row = LetterTimes & { subject: number[]; body: number[]; written_at: number };

export const FAILED = "Not sent: Resend refused it";

// When a sent letter went, or when a waiting or failed one is due, in the letter's own zone.
export function when(letter: LetterTimes, day: Intl.DateTimeFormat): Html {
  return letter.status === "sent"
    ? html`Sent ${letter.sent_at === null ? "" : day.format(letter.sent_at)}`
    : html`${letter.status === "failed" ? "Was due" : "Sends"} ${sendTime(letter.send_local, letter.send_zone)}`;
}

// Screen 3. A waiting letter's text and files stay out of the page until Reveal; a sent letter shows them.
export async function letterPage(env: Env, id: number, url: URL, now: number): Promise<Response> {
  const letter = await env.DB.prepare(
    "SELECT subject, body, send_local, send_zone, written_at, status, sent_at FROM letters WHERE id = ?",
  )
    .bind(id)
    .first<Row>();
  if (!letter) return notFound();
  const settings = await env.DB.prepare("SELECT time_zone FROM settings").first<{ time_zone: string | null }>();
  const day = dayFormat(settings?.time_zone);
  const key = await importLetterKey(env.LETTER_KEY);
  const subject = await openOr(letter.subject, key, SUBJECT_UNOPENED);

  const failed = letter.status === "failed" ? html`<p class="failed">${FAILED}</p>` : html``;

  let contents = html`<p><a class="button" href="/letters/${id}?reveal">Reveal</a></p>`;
  if (letter.status === "sent" || url.searchParams.has("reveal")) {
    // The HTML was cleaned in the owner's browser when saved; the page's policy stops any script in it from running.
    // A text that cannot be opened (a different key, damaged data) is said so, as Export does.
    let body = html`<p>This letter's text could not be opened.</p>`;
    try {
      body = new Html(await open(letter.body, key));
    } catch {}
    const { results: files } = await env.DB.prepare("SELECT id, name FROM files WHERE letter_id = ? ORDER BY id")
      .bind(id)
      .all<{ id: number; name: number[] }>();
    const names = await Promise.all(files.map((file) => openOr(file.name, key, NAME_UNOPENED)));
    const links = files.map((file, i) => html`<li><a href="/letters/${id}/files/${file.id}">${names[i]}</a></li>`);
    contents = html`<div class="body">${body}</div>${files.length ? html`<ul class="files">${links}</ul>` : html``}`;
  }

  const edit = lockedBecause(letter, now) === null ? html`<a href="/letters/${id}/edit">Edit</a> · ` : html``;
  return page(
    html`<h1>${subject}</h1>
<p class="when">${when(letter, day)}</p><p class="when">Written ${day.format(letter.written_at)}</p>${failed}
${contents}
<p class="actions">${edit}<a href="/letters/${id}/delete">Delete</a></p>`,
    { headers: { "content-security-policy": "script-src 'none'" } },
  );
}

// The server set each file's type from its name when it was added, so it is served as that type and nothing else.
// A name that cannot be opened is left out, and the browser names the file itself.
export async function letterFile(env: Env, letterId: number, fileId: number): Promise<Response> {
  const file = await env.DB.prepare("SELECT key, name, type FROM files WHERE id = ? AND letter_id = ?")
    .bind(fileId, letterId)
    .first<{ key: string; name: number[]; type: string }>();
  const object = file && (await env.FILES.get(file.key));
  if (!file || !object) return notFound();
  const name = await openOr(file.name, await importLetterKey(env.LETTER_KEY), "");
  return new Response(object.body, {
    headers: {
      "content-type": file.type,
      "content-disposition": name ? `inline; filename*=UTF-8''${encodeURIComponent(name)}` : "inline",
      "x-content-type-options": "nosniff",
    },
  });
}

// Write letter, filled in with the letter as saved, while it can still be changed.
export async function editPage(env: Env, id: number, now: number): Promise<Response> {
  const letter = await env.DB.prepare(
    "SELECT subject, source, send_local, send_zone, written_at FROM letters WHERE id = ?",
  )
    .bind(id)
    .first<{
      subject: number[];
      source: number[];
      send_local: string;
      send_zone: string;
      written_at: number;
    }>();
  if (!letter) return notFound();
  const key = await importLetterKey(env.LETTER_KEY);
  const locked = lockedBecause(letter, now);
  if (locked) {
    return page(
      html`<h1>${await openOr(letter.subject, key, SUBJECT_UNOPENED)}</h1><p>${locked}</p><p><a href="/letters/${id}">Back to the letter</a></p>`,
      {
        status: 403,
      },
    );
  }
  const [recipients, files] = await Promise.all([
    env.DB.prepare("SELECT email FROM recipients WHERE letter_id = ? ORDER BY rowid")
      .bind(id)
      .all<{ email: number[] }>(),
    env.DB.prepare("SELECT id, name, size FROM files WHERE letter_id = ? ORDER BY id")
      .bind(id)
      .all<{ id: number; name: number[]; size: number }>(),
  ]);
  // Saving a placeholder over a part that cannot be opened would lose it, so such a letter cannot be edited.
  const refused = async (what: string) =>
    page(
      html`<h1>${await openOr(letter.subject, key, SUBJECT_UNOPENED)}</h1><p>This letter's ${what} could not be opened, so it cannot be edited.</p><p><a href="/letters/${id}">Back to the letter</a></p>`,
    );
  let markdown: string;
  try {
    markdown = await open(letter.source, key);
  } catch {
    return refused("text");
  }
  let draft: Draft;
  try {
    draft = {
      id,
      subject: await open(letter.subject, key),
      markdown,
      sendLocal: letter.send_local,
      zone: letter.send_zone,
      writtenAt: letter.written_at,
      recipients: await Promise.all(recipients.results.map((r) => open(r.email, key))),
      files: await Promise.all(files.results.map(async (file) => ({ ...file, name: await open(file.name, key) }))),
    };
  } catch {
    return refused("details");
  }
  return page(await writePage(env.DB, now, env.OWNER_EMAIL, draft));
}

export async function deletePage(env: Env, id: number): Promise<Response> {
  const letter = await env.DB.prepare("SELECT subject FROM letters WHERE id = ?")
    .bind(id)
    .first<{ subject: number[] }>();
  if (!letter) return notFound();
  const subject = await openOr(letter.subject, await importLetterKey(env.LETTER_KEY), SUBJECT_UNOPENED);
  return page(html`<h1>Delete “${subject}”?</h1>
<p>This removes the letter and its files for good.</p>
<form method="post" action="/letters/${id}/delete"><button class="button danger" type="submit">Delete</button> <a href="/letters/${id}">Keep it</a></form>`);
}

// The files leave R2 before the letter's rows go, so a failed or cut-off delete never leaves private files in R2
// with nothing pointing to them. Deleting the letter row deletes its recipients, files and send attempts.
export async function deleteLetter(env: Env, id: number): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT key FROM files WHERE letter_id = ?").bind(id).all<{ key: string }>();
  if (results.length) await env.FILES.delete(results.map((file) => file.key));
  await env.DB.prepare("DELETE FROM letters WHERE id = ?").bind(id).run();
  return new Response(null, { status: 303, headers: { location: "/" } });
}
