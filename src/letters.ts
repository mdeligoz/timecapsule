import { Html, html } from "./html";
import type { Env } from "./index";
import { importLetterKey, openOr, SUBJECT_UNOPENED } from "./seal";
import { lastAnswer } from "./send";
import { sendMoment } from "./sendtime";

type Row = {
  id: number;
  subject: number[];
  send_local: string;
  send_zone: string;
  written_at: number;
  status: string;
  sent_at: number | null;
  last_try: string | null;
};

// A send time is a local date and hour, so it is shown as written, in the letter's own zone.
const sendFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });

export function sendTime(local: string, zone: string): string {
  return `${sendFormat.format(Date.parse(`${local}:00Z`))} ${zone}`;
}

const stampDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" });
const stampTime = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", timeStyle: "short" });

// The stamp on a letter: what the time is, then its date, hour and zone, each set on its own line by the stylesheet.
// A long zone may break after its slashes, and reads with spaces for its underscores.
function stamp(label: string, date: string, time?: { at: number; zone: string }): Html {
  const zone = time
    ? time.zone
        .replaceAll("_", " ")
        .split("/")
        .map((part) => html`${part}`.text)
        .join("/<wbr>")
    : "";
  const parts = time
    ? html` <span class="time">${stampTime.format(time.at)}</span> <span class="zone">${new Html(zone)}</span>`
    : html``;
  return html`<p class="when stamp"><span class="label">${label}</span> <span class="date">${date}</span>${parts}</p>`;
}

// A letter whose send time cannot be worked out sorts last instead of breaking the list.
function moment(row: Row): number {
  try {
    return sendMoment(row.send_local, row.send_zone);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// The owner's dates, in their saved zone; a blank or unknown zone falls back to UTC instead of breaking the screen.
export function dayFormat(zone: string | null | undefined): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", dateStyle: "medium" });
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" });
  }
}

// Screen 1. The query never reads the letter text.
export async function lettersPage(env: Env, url: URL): Promise<Html> {
  const db = env.DB;
  const tab = url.searchParams.get("tab") === "sent" ? "sent" : "waiting";
  const sort = url.searchParams.get("sort") === "written" ? "written" : "send";
  const settings = await db.prepare("SELECT time_zone FROM settings").first<{ time_zone: string | null }>();
  const day = dayFormat(settings?.time_zone);

  const statuses = tab === "sent" ? ["sent", "sent"] : ["waiting", "failed"];
  const { results } = await db
    .prepare(
      "SELECT id, subject, send_local, send_zone, written_at, status, sent_at, (SELECT detail FROM send_attempts WHERE letter_id = letters.id ORDER BY id DESC LIMIT 1) AS last_try FROM letters WHERE status IN (?, ?)",
    )
    .bind(...statuses)
    .all<Row>();

  if (sort === "written") results.sort((a, b) => b.written_at - a.written_at);
  else if (tab === "sent") results.sort((a, b) => (b.sent_at ?? 0) - (a.sent_at ?? 0));
  else {
    const moments = new Map(results.map((row) => [row, moment(row)]));
    results.sort((a, b) => (moments.get(a) ?? 0) - (moments.get(b) ?? 0));
  }

  const key = await importLetterKey(env.LETTER_KEY);
  const subjects = await Promise.all(results.map((row) => openOr(row.subject, key, SUBJECT_UNOPENED)));

  const link = (toTab: string, toSort: string, label: string) =>
    html`<a href="${`/?tab=${toTab}&sort=${toSort}`}"${toTab === tab && toSort === sort ? html` aria-current="page"` : html``}>${label}</a>`;

  // A waiting letter with a try is still being tried, as a try that sends or fails for good moves it on.
  const items = results.map((row, i) => {
    const stuck = row.status === "waiting" && row.last_try !== null;
    const at = Date.parse(`${row.send_local}:00Z`);
    const when =
      row.status === "sent"
        ? stamp("Sent", row.sent_at === null ? "" : day.format(row.sent_at))
        : stamp(row.status === "failed" || stuck ? "Was due" : "Sends", stampDate.format(at), {
            at,
            zone: row.send_zone,
          });
    const failed =
      row.status === "failed"
        ? html`<p class="failed">Not sent: Resend refused it</p>`
        : stuck
          ? html`<p class="failed">Not sent yet. ${lastAnswer(row.last_try ?? "")} Trying again every hour.</p>`
          : html``;
    return html`<li><a class="letter" href="/letters/${row.id}">${subjects[i]}</a>${when}<p class="when">Written ${day.format(row.written_at)}</p>${failed}</li>`;
  });

  const empty = tab === "sent" ? "No letters sent yet." : "No letters waiting.";
  return html`<div class="heading"><h1>Letters</h1><a class="button" href="/write">Write a new letter</a></div>
<nav class="tabs" aria-label="Letters">${link("waiting", sort, "Waiting")}${link("sent", sort, "Sent")}</nav>
<p class="sort">Sort by ${link(tab, "send", "send time")} · ${link(tab, "written", "writing date")}</p>
${items.length ? html`<ul class="letters">${items}</ul>` : html`<p class="empty">${empty}</p>`}`;
}
