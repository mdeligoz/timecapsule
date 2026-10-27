import { pickOwnZone } from "./own-zone";
import { RELOAD } from "./reload";
import { zip } from "./zip";

const zone = document.querySelector('select[name="zone"]') as HTMLSelectElement;
const exportButton = document.getElementById("export") as HTMLButtonElement;
const exportStatus = document.getElementById("export-status") as HTMLElement;

// With no zone saved yet, Settings offers the browser's own zone; it is stored only when the owner saves.
if (!zone.value) pickOwnZone(zone);

async function fetched(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

// The server lists what goes in the zip; each letter's page and file is fetched one at a time and zipped here. A part
// that is no longer in the app (a letter deleted meanwhile, a file gone from R2) is left out and named, so it can
// never stop the rest from exporting; any other failure stops the export.
exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  try {
    const list = (await (await fetched("/export")).json()) as {
      name: string;
      entries: { path: string; url: string }[];
    };
    const files: { path: string; data: Blob }[] = [];
    const missing: string[] = [];
    for (const [done, entry] of list.entries.entries()) {
      exportStatus.textContent = `Exporting: ${done + 1} of ${list.entries.length}`;
      const response = await fetch(entry.url);
      if (response.status === 404) missing.push(entry.path.slice(entry.path.indexOf("/") + 1));
      else if (!response.ok) throw new Error(`${entry.url} answered ${response.status}`);
      else files.push({ path: entry.path, data: await response.blob() });
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await zip(files, new Date()));
    link.download = list.name;
    link.click();
    // The download still reads the zip for a moment after the click.
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    exportStatus.textContent = `Export ready: ${list.name}`;
    if (missing.length) exportStatus.textContent += `. Left out, no longer in the app: ${missing.join(", ")}`;
  } catch {
    exportStatus.textContent = `Export stopped. ${RELOAD}`;
  } finally {
    exportButton.disabled = false;
  }
});
