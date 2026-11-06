import { version } from "../package.json";
import { type Html, html, page } from "./html";
import { tokenLink } from "./setup";
import { knownZone, zoneOptions } from "./write";

type Settings = { time_zone: string | null; failure_alert: number; monthly_status: number; address: string | null };

export const ADDRESS_TOKEN = "timecapsule address";

const checked = (on: boolean) => (on ? html` checked` : html``);

// Screen 4, showing what is stored. With no zone saved yet, the page's script picks the browser's zone; nothing is
// stored until Save.
// After a refused address change, the box keeps what was typed, so pressing again cannot set the saved address.
export async function settingsForm(db: D1Database, notice: Html, typedAddress?: string): Promise<Html> {
  const settings = await db
    .prepare("SELECT time_zone, failure_alert, monthly_status, address FROM settings")
    .first<Settings>();
  const address = settings?.address ?? "";
  const zone = settings?.time_zone && knownZone(settings.time_zone) ? settings.time_zone : "";
  return html`<h1>Settings</h1>
${notice}
<form class="settings" method="post" action="/settings">
<label>Time zone <select name="zone" required><option value="">Pick a time zone</option>${zoneOptions(zone)}</select></label>
<p class="hint">Written and sent dates are shown in this zone, and a new letter starts in it.</p>
<label><input type="checkbox" name="failure_alert"${checked(settings?.failure_alert === 1)}>Failure alert</label>
<p class="hint">An email to you when a letter fails to send.</p>
<label><input type="checkbox" name="monthly_status"${checked(settings?.monthly_status === 1)}>Monthly status email</label>
<p class="hint">On the first of each month, an email with the letters waiting and the next send time.</p>
<button class="button" type="submit">Save</button>
</form>
<section class="address">
<h2>Your address</h2>
${address ? html`<p>timecapsule is also at <a href="https://${address}/">${address}</a>.</p>` : html`<p>timecapsule is only at its workers.dev address.</p>`}
<form class="settings" method="post" action="/settings/address">
<label>Address <input name="address" value="${typedAddress ?? address}" maxlength="253" placeholder="time.example.com" autocomplete="off"></label>
<p class="hint">An address on a domain in this Cloudflare account; Cloudflare makes its DNS record. Leave it empty to remove your address. The workers.dev address always keeps working.</p>
<ol>
<li><a href="${tokenLink(ADDRESS_TOKEN)}" target="_blank" rel="noopener">Open Cloudflare's token page</a>. Its permissions are already filled in.</li>
<li>Click <b>Continue to summary</b>, then <b>Create Token</b>.</li>
<li>Copy the token: the long value Cloudflare shows only once, not the token's ID.</li>
</ol>
<label>Token <input name="token" type="password" required autocomplete="off"></label>
<p class="hint">The app uses the token once, then deletes it.</p>
<button class="button" type="submit">Change address</button>
</form>
</section>
<section class="export">
<h2>Export</h2>
<p class="hint">Downloads every letter, waiting ones included, as a web page with its files, all in one zip file.</p>
<button class="button" type="button" id="export">Export</button>
<p class="hint" id="export-status" aria-live="polite"></p>
</section>
<p class="version">timecapsule v${version}</p>
<script type="module" src="/settings.js"></script>`;
}

export function settingsPage(db: D1Database, url: URL): Promise<Html> {
  const saved = url.searchParams.has("saved") ? html`<p class="saved" role="status">Settings saved.</p>` : html``;
  return settingsForm(db, saved);
}

// The form posts as a plain page; a switch that is off is left out of it.
export async function saveSettings(request: Request, db: D1Database): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const zone = form?.get("zone");
  if (!form || typeof zone !== "string" || !knownZone(zone)) {
    const error = html`<p class="error" role="alert">Pick a time zone from the list.</p>`;
    return page(await settingsForm(db, error), { status: 400 });
  }
  await db
    .prepare("UPDATE settings SET time_zone = ?, failure_alert = ?, monthly_status = ?")
    .bind(zone, form.has("failure_alert") ? 1 : 0, form.has("monthly_status") ? 1 : 0)
    .run();
  return new Response(null, { status: 303, headers: { location: "/settings?saved=1" } });
}
