import { codedAddress, EMAIL } from "../address";
import { defaultSubject, firstSendHour, localHour, sendDateLimits, yearsLater } from "../dates";
import { FILES_LIMIT, RECIPIENT_LIMIT, TEXT_LIMIT } from "../limits";
import { calendar } from "./calendar";
import { letterHtml } from "./letter-html";
import { pickOwnZone } from "./own-zone";
import { RELOAD } from "./reload";

const form = document.getElementById("letter") as HTMLFormElement;
const subject = form.elements.namedItem("subject") as HTMLInputElement;
const text = form.elements.namedItem("text") as HTMLTextAreaElement;
const date = form.elements.namedItem("date") as HTMLInputElement;
const zone = form.elements.namedItem("zone") as HTMLSelectElement;
const recipients = form.elements.namedItem("recipients") as HTMLTextAreaElement;
const hour = form.elements.namedItem("hour") as HTMLSelectElement;
const preview = form.querySelector(".preview") as HTMLElement;
const previewToggle = form.querySelector(".preview-toggle") as HTMLButtonElement;
const formatting = [...form.querySelectorAll<HTMLButtonElement>("[data-before], [data-line]")];
const fileInput = form.querySelector('input[type="file"]') as HTMLInputElement;
const fileList = form.querySelector(".files") as HTMLUListElement;
const total = form.querySelector(".total") as HTMLElement;
const error = form.querySelector(".error") as HTMLElement;
const saveButton = form.querySelector('button[type="submit"]') as HTMLButtonElement;

// Files added on this page and already in R2, and, when editing, the letter's saved files it keeps; by their line in the list.
const added = new Map<HTMLLIElement, { id: number; size: number; name: string }>();
const kept = new Map<HTMLLIElement, { id: number; size: number }>();
let adding = 0;
// The size of the files on their way to R2, so a file added beside them is measured against them too.
let addingBytes = 0;
let saving = false;

// The send time's limits count from when the letter was written: an edit's first save, or for a new letter when this
// page opened, which Save sends back so the server counts from the same moment.
const opened = form.dataset.written ? undefined : Date.now();
const writtenAt = Number(form.dataset.written) || (opened as number);

// With no zone saved in Settings, a letter starts in the browser's own zone, and its dates are redone in it.
if (!zone.value) {
  const own = pickOwnZone(zone);
  // A subject the owner typed, and the browser kept on a return to the page, stays.
  if (subject.value === subject.defaultValue) subject.value = defaultSubject(Date.now(), own);
  Object.assign(date, sendDateLimits(writtenAt, own));
}
const dateToggle = form.querySelector(".date-toggle") as HTMLButtonElement;

// The earliest and latest days are in the letter's zone, so a zone change moves them, and clears a day they rule out.
zone.addEventListener("change", () => {
  Object.assign(date, sendDateLimits(writtenAt, zone.value || "UTC"));
  if (date.value && (date.value < date.min || date.value > date.max)) {
    date.value = "";
    date.dispatchEvent(new Event("change"));
  }
});

calendar(date, dateToggle, zone);

// The server refuses a send time under 7 days or over 20 years after writing, so on the first and the last day those
// hours are greyed out; an hour already picked that is greyed out moves to the nearest open one.
function limitHours(): void {
  const first = firstSendHour(writtenAt, zone.value || "UTC");
  const last = localHour(yearsLater(writtenAt, 20), zone.value || "UTC");
  const from = date.value === first.slice(0, 10) ? Number(first.slice(11, 13)) : 0;
  const to = date.value === last.slice(0, 10) ? Number(last.slice(11, 13)) : 23;
  for (const option of hour.options) {
    const h = Number(option.value.slice(0, 2));
    option.disabled = h < from || h > to;
  }
  if (hour.selectedOptions[0]?.disabled) {
    const open = [...hour.options].filter((option) => !option.disabled);
    hour.value = (Number(hour.value.slice(0, 2)) < from ? open[0] : open.at(-1))?.value ?? "";
  }
}
date.addEventListener("change", limitHours);
zone.addEventListener("change", limitHours);
limitHours();

// The reason the app refused, or, for any other answer (such as an expired login), nothing.
async function refusal(response: Response): Promise<string | undefined> {
  const answer = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof answer.error === "string" ? answer.error : undefined;
}

// Toolbar buttons put Markdown around the selection, or at the start of the line. The text field stops typing at the
// limit, but not what a script puts in, so a button that would pass it puts in nothing.
const TOO_LONG = `That would take the letter past ${TEXT_LIMIT.toLocaleString("en-US")} characters.`;
for (const button of formatting) {
  button.addEventListener("click", () => {
    const { selectionStart: start, selectionEnd: end } = text;
    const line = button.dataset.line;
    const marks = line ?? `${button.dataset.before ?? ""}${button.dataset.after ?? ""}`;
    if (text.value.length + marks.length > TEXT_LIMIT) {
      error.textContent = TOO_LONG;
      text.focus();
      return;
    }
    if (error.textContent === TOO_LONG) error.textContent = "";
    if (line !== undefined) {
      const lineStart = text.value.lastIndexOf("\n", start - 1) + 1;
      text.setRangeText(line, lineStart, lineStart);
      text.setSelectionRange(start + line.length, end + line.length);
    } else {
      const before = button.dataset.before ?? "";
      text.setRangeText(`${before}${text.value.slice(start, end)}${button.dataset.after ?? ""}`, start, end);
      text.setSelectionRange(start + before.length, end + before.length);
    }
    text.focus();
  });
}

// The preview is made by the same cleaner as Save, so it shows exactly what will be stored.
previewToggle.addEventListener("click", () => {
  const show = preview.hidden;
  if (show) preview.innerHTML = letterHtml(text.value);
  preview.hidden = !show;
  text.hidden = show;
  for (const button of formatting) button.disabled = show;
  previewToggle.setAttribute("aria-pressed", String(show));
  previewToggle.textContent = show ? "Write" : "Preview";
});

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function update(): void {
  const files = [...added.values(), ...kept.values()];
  const sum = files.reduce((all, file) => all + file.size, 0);
  total.textContent = files.length ? `Added so far: ${megabytes(sum)}.` : "";
  saveButton.disabled = adding > 0 || saving;
}

function removeButton(item: HTMLLIElement, name: string, onRemove: () => void): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Remove";
  button.setAttribute("aria-label", `Remove ${name}`);
  button.addEventListener("click", () => {
    onRemove();
    item.remove();
    update();
  });
  item.append(" ", button);
}

// Each file goes to R2 the moment it is added, unless it would take the letter's files past the limit.
async function add(file: File): Promise<void> {
  const item = document.createElement("li");
  fileList.append(item);
  const sum = [...added.values(), ...kept.values()].reduce((all, other) => all + other.size, addingBytes);
  if (sum + file.size > FILES_LIMIT) {
    item.textContent = `${file.name}: the files would come to more than ${FILES_LIMIT / 1024 / 1024} MB in total.`;
    item.className = "refused";
    removeButton(item, file.name, () => {});
    return;
  }
  item.textContent = `${file.name}: adding…`;
  adding++;
  addingBytes += file.size;
  update();
  try {
    const response = await fetch(`/uploads?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    if (response.ok) {
      const answer = (await response.json()) as { id: number; size: number };
      added.set(item, { id: answer.id, size: answer.size, name: file.name });
      item.textContent = `${file.name} (${megabytes(answer.size)})`;
      removeButton(item, file.name, () => {
        added.delete(item);
        void fetch(`/uploads/${answer.id}`, { method: "DELETE" });
      });
    } else {
      item.textContent = `${file.name}: ${(await refusal(response)) ?? `not added. ${RELOAD}`}`;
      item.className = "refused";
      removeButton(item, file.name, () => {});
    }
  } catch {
    item.textContent = `${file.name}: not added. ${RELOAD}`;
    item.className = "refused";
    removeButton(item, file.name, () => {});
  } finally {
    adding--;
    addingBytes -= file.size;
    update();
  }
}

// Marks the added files a save refused by their ids, as two files can have the same name.
function markRefused(ids: unknown[]): void {
  for (const [item, file] of added) {
    if (!ids.includes(file.id)) continue;
    item.textContent = `${file.name}: remove it and add it again.`;
    item.className = "refused";
    removeButton(item, file.name, () => {
      added.delete(item);
      void fetch(`/uploads/${file.id}`, { method: "DELETE" });
    });
  }
}

// A saved file removed here leaves the letter, and R2, only when the edit is saved.
for (const item of fileList.querySelectorAll<HTMLLIElement>("li[data-file]")) {
  kept.set(item, { id: Number(item.dataset.file), size: Number(item.dataset.size) });
  removeButton(item, item.dataset.name ?? "", () => kept.delete(item));
}
update();

fileInput.addEventListener("change", () => {
  for (const file of fileInput.files ?? []) void add(file);
  fileInput.value = "";
});

// A file dropped anywhere on the page, the Files box included, is added the same way; left to the browser, it would
// open the file in place of the page. Text dragged within the letter is still the browser's. While saving, the
// page takes no files, as the Files box takes no clicks.
const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
document.addEventListener("dragover", (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (saving) return;
  for (const file of event.dataTransfer?.files ?? []) void add(file);
});

// While saving, the form takes no clicks, so the letter and its list of files cannot change or be sent twice.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  error.textContent = "";
  if (!date.value) {
    error.textContent = "Pick a send date.";
    dateToggle.focus();
    return;
  }
  // Checked by the same rule as the server's, so the owner hears which address is wrong before anything is sent.
  const emails = recipients.value.split(/[\s,;]+/);
  const wrong = emails.find((email) => email && !EMAIL.test(codedAddress(email)));
  if (wrong) {
    error.textContent = `"${wrong}" is not an email address.`;
    recipients.focus();
    return;
  }
  // Counted as the server counts: each address once, whatever its capitals, and never the owner.
  const others = new Set(emails.filter(Boolean).map((email) => codedAddress(email).toLowerCase()));
  others.delete(recipients.dataset.owner?.toLowerCase() ?? "");
  if (others.size > RECIPIENT_LIMIT) {
    error.textContent = `A letter can go to at most ${RECIPIENT_LIMIT} people besides you.`;
    recipients.focus();
    return;
  }
  const data = new FormData(form);
  const markdown = text.value;
  const letter = {
    subject: data.get("subject"),
    markdown,
    html: letterHtml(markdown),
    sendLocal: `${data.get("date")}T${data.get("hour")}`,
    zone: data.get("zone"),
    recipients: emails,
    files: [...kept.values()].map((file) => file.id),
    uploads: [...added.values()].map((file) => file.id),
    opened,
  };
  // Editing saves over the letter; otherwise Save makes a new one.
  const letterId = form.dataset.letter;
  saving = true;
  form.inert = true;
  update();
  try {
    const response = await fetch(letterId ? `/letters/${letterId}` : "/letters", {
      method: letterId ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(letter),
    });
    // Saved: the page leaves even if the answer cannot be read, so Save is never pressed twice for one letter.
    if (response.ok) {
      const answer = (await response.json().catch(() => ({}))) as { location?: unknown };
      location.assign(typeof answer.location === "string" ? answer.location : "/");
      return;
    }
    const answer = (await response.json().catch(() => ({}))) as { error?: unknown; uploads?: unknown };
    error.textContent = typeof answer.error === "string" ? answer.error : `Not saved. ${RELOAD}`;
    if (Array.isArray(answer.uploads)) markRefused(answer.uploads);
  } catch {
    error.textContent = `Not saved. ${RELOAD}`;
  }
  saving = false;
  form.inert = false;
  update();
});
