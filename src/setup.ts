import { type Html, html, page } from "./html";
import { keyStep } from "./key-step";
import { fromOtherSite, otherSite } from "./origin";
import { cleanToken, provision } from "./provision";
import { finishButton, openWhenReady } from "./ready";
import { importLetterKey, open } from "./seal";
import type { Fetcher } from "./send";

export interface SetupEnv {
  CF_VERSION_METADATA: WorkerVersionMetadata;
  DB: D1Database;
  SETUP_DONE?: string;
}

// Account-owned token: the user-level "create tokens" permission cannot be pre-filled in a link.
const TOKEN_PERMISSIONS = [
  { key: "account_settings", type: "read" },
  { key: "workers_scripts", type: "edit" },
  { key: "account_api_tokens", type: "edit" },
  { key: "access", type: "edit" },
];
const TOKEN_NAME = "timecapsule setup";
const TOKENS_PAGE = "https://dash.cloudflare.com/?to=/:account/api-tokens";
// A run that never finished stops holding setup after this long.
const LOCK_MS = 5 * 60_000;
// Longer than this after setup finished, missing settings mean the app was deployed again and lost them, not that
// they are still reaching Cloudflare's servers; setup then asks for the saved key to restore the app.
const SETTLED_MS = 10 * 60_000;

function tokenLink(): string {
  const params = new URLSearchParams({
    to: "/:account/api-tokens",
    permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
    name: TOKEN_NAME,
  });
  return `https://dash.cloudflare.com/?${params}`;
}

function newLetterKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

function isLetterKey(text: string): boolean {
  try {
    return atob(text).length === 32;
  } catch {
    return false;
  }
}

// The owner may type the team's name or its whole login address.
function teamDomain(typed: string): string | null {
  const name = typed
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.cloudflareaccess\.com$/, "");
  return /^[a-z0-9-]+$/.test(name) ? `https://${name}.cloudflareaccess.com` : null;
}

// The Worker's name is the first part of its workers.dev address; the Access login is made for that address.
function workerName(host: string): string | null {
  const parts = host.split(".");
  return parts.length === 4 && host.endsWith(".workers.dev") ? parts[0] : null;
}

// A restore takes the key the owner saved at the first setup instead of showing a new one. The owner's three settings
// are asked on both pages: a restore follows a deploy that lost every secret.
type Settings = { email: string; domain: string; resendKey: string };
type Draft = { letterKey: string; saved: boolean; team: string; restore?: boolean } & Settings;
const NO_SETTINGS: Settings = { email: "", domain: "", resendKey: "" };

const notice = (lines: Html[]) =>
  html`<div class="error" role="alert">${lines.map((line) => html`<p>${line}</p>`)}</div>`;

function setupForm(draft: Draft, problem?: Html[]): Response {
  return page(
    html`<h1>${draft.restore ? "Restore timecapsule" : "Set up timecapsule"}</h1>
<p>Four steps, then your app is ready.</p>
${problem ? notice(problem) : html``}
<form method="post" action="/setup" class="setup">
${keyStep(draft)}
<section>
<h2>2. Your email and sending</h2>
<label>Your email address <input name="owner_email" type="email" value="${draft.email}" required autocomplete="email" spellcheck="false"></label>
<p class="hint">Only you can log in, and every letter is also sent to you.</p>
<label>Sending domain <input name="send_domain" value="${draft.domain}" required autocomplete="off" spellcheck="false"></label>
<p class="hint">Your domain verified at Resend, for example example.com. Letters are sent from letters@ this domain.</p>
<label>Resend API key <input name="resend_key" type="password" required autocomplete="off" spellcheck="false"></label>
<p class="hint">The key you made in Resend, with sending access.</p>
</section>
<section>
<h2>3. Paste your Zero Trust team name</h2>
<p>It is the first part of your Zero Trust login address: <i>team-name</i>.cloudflareaccess.com. Copy it from the <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noopener">Zero Trust dashboard</a> rather than typing it: setup can check that the team exists, not that it is yours, and a wrong team refuses every login.</p>
<label>Team name <input name="team" value="${draft.team}" required autocomplete="off" spellcheck="false"></label>
</section>
<section>
<h2>4. Create a setup token and paste it</h2>
<ol>
<li><a href="${tokenLink()}" target="_blank" rel="noopener">Open Cloudflare's token page</a>. Its permissions are already filled in.</li>
<li>Click <b>Continue to summary</b>, then <b>Create Token</b>.</li>
<li>Copy the token: the long value Cloudflare shows only once, not the token's ID.</li>
</ol>
<label>Token <input name="token" type="password" required autocomplete="off"></label>
<p class="hint">Setup uses the token once, then deletes it.</p>
</section>
${finishButton()}
</form>
${draft.restore ? html`` : html`<script type="module" src="/setup.js"></script>`}`,
    { status: problem ? 400 : 200, menu: false },
  );
}

const withStatus = (response: Response, status: number) =>
  new Response(response.body, { status, headers: response.headers });

const readFinishedAt = (db: D1Database) =>
  db.prepare("SELECT setup_finished_at FROM settings").first<number | null>("setup_finished_at");

// A restore runs only after a setup finished and its settings were lost, and only with the key that opens the letters.
async function refuseRestore(db: D1Database, draft: Draft, now: number): Promise<Response | null> {
  const finished = await readFinishedAt(db);
  if (finished === null) {
    return withStatus(
      setupForm({ ...draft, letterKey: newLetterKey(), saved: false, restore: false }, [
        html`This app has not been set up yet, so there is nothing to restore. Save the new encryption key below, then press Finish setup.`,
      ]),
      409,
    );
  }
  if (now - finished < SETTLED_MS) {
    return withStatus(
      setupForm(draft, [html`Setup is already finished. Next: <a href="/">open timecapsule</a>.`]),
      409,
    );
  }
  if (!isLetterKey(draft.letterKey)) {
    return setupForm({ ...draft, letterKey: "" }, [
      html`This is not a timecapsule encryption key. Paste the key you saved when you first set up timecapsule, exactly as saved.`,
    ]);
  }
  const letter = await db.prepare("SELECT body FROM letters ORDER BY id LIMIT 1").first<{ body: number[] }>();
  if (letter) {
    const opens = await open(letter.body, await importLetterKey(draft.letterKey)).then(
      () => true,
      () => false,
    );
    if (!opens) {
      return setupForm({ ...draft, letterKey: "" }, [
        html`This key does not open your letters. Paste the key you saved when you first set up timecapsule, exactly as saved.`,
      ]);
    }
  }
  return null;
}

async function finishSetup(request: Request, env: SetupEnv, fetcher: Fetcher, now: number): Promise<Response> {
  const form = await request.formData().catch(() => new FormData());
  const field = (name: string) => String(form.get(name) ?? "");
  const posted = field("letter_key").trim();
  const restore = field("restore") === "1";
  const draft: Draft = {
    letterKey: posted,
    saved: field("saved") === "on",
    team: field("team").trim(),
    restore,
    email: field("owner_email").trim(),
    domain: field("send_domain").trim().toLowerCase(),
    resendKey: field("resend_key").trim(),
  };
  const host = new URL(request.url).host;
  const scriptName = workerName(host);
  if (!scriptName) {
    return setupForm(draft, [html`Open setup at your app's workers.dev address, not at ${host}.`]);
  }
  // The login is made for this address; Cloudflare refuses an address without a plain domain, but only after the token
  // has been used.
  if (!/^[^\s@<>"(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(draft.email)) {
    return setupForm(draft, [html`Type your email address, for example you@example.com.`]);
  }
  // Letters and the failure alert are sent from letters@ this domain; anything else makes Resend refuse every one.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(draft.domain)) {
    return setupForm(draft, [
      html`Type only your domain verified at Resend, for example example.com: no https://, no @ and no slash.`,
    ]);
  }
  // Resend's keys start with re_; anything else would make every letter fail.
  if (!/^re_\S+$/.test(draft.resendKey)) {
    return setupForm(draft, [html`Paste your Resend API key: it starts with re_.`]);
  }
  if (restore) {
    const refused = await refuseRestore(env.DB, draft, now);
    if (refused) return refused;
  } else if (!isLetterKey(posted)) {
    return setupForm({ ...draft, letterKey: newLetterKey(), saved: false }, [
      html`The encryption key on the page was damaged, so this is a new one. Save it, then press Finish setup again.`,
    ]);
  } else if (!draft.saved) {
    return setupForm(draft, [html`Save your encryption key first, then tick the box in step 1.`]);
  }
  const team = teamDomain(draft.team);
  if (!team) return setupForm(draft, [html`Type the team name only, for example my-team.`]);
  const token = cleanToken(field("token"));
  if (/^[0-9a-f]{32}$/i.test(token)) {
    return setupForm(draft, [
      html`This is the token's ID, not the token. Copy the token itself: the longer value Cloudflare shows only once.`,
    ]);
  }

  const certs = await fetcher(`${team}/cdn-cgi/access/certs`, {}).catch(() => null);
  if (!certs) {
    return withStatus(
      setupForm(draft, [html`Cloudflare could not be reached to check the team name. Press Finish setup again.`]),
      502,
    );
  }
  if (!certs.ok) {
    return setupForm(draft, [
      html`There is no Zero Trust team named ${new URL(team).hostname.split(".")[0]}. Check the spelling in step 3.`,
    ]);
  }

  const locked = await (restore
    ? env.DB.prepare(
        "UPDATE settings SET setup_started_at = ? WHERE id = 1 AND setup_finished_at <= ? AND (setup_started_at IS NULL OR setup_started_at <= ?)",
      ).bind(now, now - SETTLED_MS, now - LOCK_MS)
    : env.DB.prepare(
        "UPDATE settings SET setup_started_at = ? WHERE id = 1 AND setup_finished_at IS NULL AND (setup_started_at IS NULL OR setup_started_at <= ?)",
      ).bind(now, now - LOCK_MS)
  ).run();
  if (locked.meta.changes !== 1) {
    // A page served by the version from before setup can still post here; a finished setup never runs again.
    const finishedAt = await readFinishedAt(env.DB);
    if (finishedAt !== null && !restore && now - finishedAt >= SETTLED_MS) {
      return withStatus(
        setupForm({ ...draft, letterKey: "", saved: false, restore: true }, [
          html`This app lost its settings since setup. Paste the encryption key you saved then to restore it.`,
        ]),
        409,
      );
    }
    // Another tab's restore can finish while this one checks the team name.
    if (finishedAt !== null && (!restore || now - finishedAt < SETTLED_MS)) {
      return withStatus(
        setupForm(draft, [html`Setup is already finished. Next: <a href="/">open timecapsule</a>.`]),
        409,
      );
    }
    return withStatus(
      setupForm(draft, [
        html`Setup is already running, from another tab or an earlier try that was cut off. Wait a minute, then reload this page.`,
      ]),
      409,
    );
  }
  try {
    const outcome = await provision({
      token,
      teamDomain: team,
      letterKey: posted,
      scriptName,
      versionId: env.CF_VERSION_METADATA.id,
      host,
      ownerEmail: draft.email,
      sendDomain: draft.domain,
      resendKey: draft.resendKey,
      fetch: fetcher,
    });
    if (outcome.ok) {
      await env.DB.prepare("UPDATE settings SET setup_finished_at = ?").bind(now).run();
      return finished(draft.email, outcome.tokenDeleted);
    }
    if (outcome.otherAccount) {
      return setupForm(draft, [
        html`This token is for a different Cloudflare account. Log in to the account this app runs on, create the token again in step 4, and paste it.`,
        html`Delete the token you made in the other account.`,
      ]);
    }
    const said = html`Cloudflare said: ${outcome.reason}`;
    if (outcome.step === "check the token" && outcome.status && outcome.status >= 400 && outcome.status < 500) {
      return setupForm(draft, [
        html`Cloudflare did not accept this token. Copy the token again, the long value Cloudflare shows only once, and paste it in step 4.`,
        said,
      ]);
    }
    const next = outcome.tokenDeleted
      ? html`Your token was deleted. Create a new one in step 4, paste it, and press Finish setup again.`
      : html`Press Finish setup again with the same token.`;
    return withStatus(setupForm(draft, [html`Setup stopped while it tried to ${outcome.step}.`, said, next]), 502);
  } finally {
    await env.DB.prepare("UPDATE settings SET setup_started_at = NULL WHERE setup_started_at = ?").bind(now).run();
  }
}

// The new Access app and Worker settings take time to reach every Cloudflare server: about a minute after a first
// setup, over two after a restore (2026-10-20). The finished page holds Open timecapsule this long after setup.
const LOGIN_WAIT_MS = 3 * 60_000;

function finished(ownerEmail: string, tokenDeleted: boolean): Response {
  const token = tokenDeleted
    ? html`<p>The setup token has been deleted, and this setup page is now switched off.</p>`
    : html`<div class="error" role="alert"><p>Setup could not delete its token. Delete it yourself: on <a href="${TOKENS_PAGE}" target="_blank" rel="noopener">Cloudflare's token page</a>, delete "${TOKEN_NAME}".</p></div>`;
  return page(
    html`<h1>Setup is finished</h1>
<p>Cloudflare asks for your email address, ${ownerEmail}, and emails you a code to log in.</p>
${openWhenReady(LOGIN_WAIT_MS)}
${token}`,
    { menu: false },
  );
}

// Until setup is done, the setup page is the only page there is.
export async function setup(request: Request, env: SetupEnv, fetcher: Fetcher, now: number): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/") {
    const times = await env.DB.prepare("SELECT setup_started_at, setup_finished_at FROM settings").first<{
      setup_started_at: number | null;
      setup_finished_at: number | null;
    }>();
    const startedAt = times?.setup_started_at ?? null;
    const finishedAt = times?.setup_finished_at ?? null;
    // While a run holds setup, a new key here would not be the one that locks the letters.
    if (startedAt !== null && now - startedAt < LOCK_MS && (finishedAt === null || finishedAt < startedAt)) {
      return page(
        html`<h1>Setup is running</h1>
<p>Setup is still running from when Finish setup was pressed. Wait a minute, then reload this page.</p>`,
        { menu: false },
      );
    }
    // Right after setup, a request can still reach the version from before it; a new key there could be saved over
    // the real one. Long after, the settings were lost, so the page asks for the saved key instead.
    if (finishedAt !== null && now - finishedAt >= SETTLED_MS) {
      return setupForm({ letterKey: "", saved: false, team: "", restore: true, ...NO_SETTINGS });
    }
    if (finishedAt !== null) {
      return page(
        html`<h1>Setup is finished</h1>
${openWhenReady(Math.max(0, finishedAt + LOGIN_WAIT_MS - now))}
<p>If this page is still here 10 minutes after setup, the app was deployed again and lost its settings. Reload it then to restore your letters with your saved encryption key.</p>`,
        { menu: false },
      );
    }
    return setupForm({ letterKey: newLetterKey(), saved: false, team: "", ...NO_SETTINGS });
  }
  if (fromOtherSite(request)) return otherSite();
  if (request.method === "POST" && pathname === "/setup") return finishSetup(request, env, fetcher, now);
  return page(
    html`<h1>Setup is not finished</h1>
<p>Next: <a href="/">open the setup page</a> and finish it.</p>`,
    { status: 403, menu: false },
  );
}
