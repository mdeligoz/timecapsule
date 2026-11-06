import { type Html, html, page } from "./html";
import { cleanToken, client, deleteToken, listAll, StepFailed } from "./provision";
import type { Fetcher } from "./send";
import { ADDRESS_TOKEN, settingsForm } from "./settings";
import { TOKENS_PAGE } from "./setup";

// Settings puts the app on an address of the owner's own, such as time.example.com, with one pasted token: Cloudflare
// attaches it to the Worker and makes its DNS record and certificate, the login is extended to it, and the previous
// address is taken off both. The workers.dev address always stays, as setup and restore run there.

export type AddressEnv = { DB: D1Database; ACCESS_AUD: string };

type LoginApp = {
  id: string;
  aud: string;
  domain: string;
  policies?: Record<string, unknown>[];
  [field: string]: unknown;
};
type WorkerAddress = { id: string; hostname: string; service: string };
type Destination = { type: string; uri: string };

const MAX_ADDRESS = 253;
// Labels of 1 to 63 letters, digits and inner hyphens; the last one starts with a letter, so 1.2.3.4 is not an address.
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Cloudflare's code for an address on a domain the account does not have (captured 2026-11-06).
const NOT_ON_ACCOUNT = 10082;

// Typed, or copied from the browser: "https://Time.Example.com/" is time.example.com.
function cleanAddress(typed: string): string {
  return typed
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.$/, "");
}

const problem = (lines: Html[]) =>
  html`<div class="error" role="alert">${lines.map((line) => html`<p>${line}</p>`)}</div>`;

const tokenNotice = (deleted: boolean) =>
  deleted
    ? html`<p class="saved" role="status">The token has been deleted.</p>`
    : problem([
        html`The app could not delete its token. Delete it yourself: on <a href="${TOKENS_PAGE}" target="_blank" rel="noopener">Cloudflare's token page</a>, delete "${ADDRESS_TOKEN}".`,
      ]);

async function show(db: D1Database, notice: Html, status: number, typed?: string): Promise<Response> {
  return page(await settingsForm(db, notice, typed), { status, here: "/settings" });
}

export async function changeAddress(request: Request, env: AddressEnv, fetcher: Fetcher): Promise<Response> {
  const form = await request.formData().catch(() => new FormData());
  const typed = String(form.get("address") ?? "").trim();
  const address = cleanAddress(typed);
  const token = cleanToken(String(form.get("token") ?? ""));
  const refuse = (line: Html) => show(env.DB, problem([line]), 400, typed);
  if (address.length > MAX_ADDRESS) return refuse(html`An address can be at most 253 characters.`);
  if (address && !HOST_NAME.test(address)) {
    return refuse(html`Type only the address, for example time.example.com.`);
  }
  if (address.endsWith(".workers.dev")) {
    return refuse(html`This is the workers.dev address, which always works. Type an address on your own domain.`);
  }
  if (/^[0-9a-f]{32}$/i.test(token)) {
    return refuse(
      html`This is the token's ID, not the token. Copy the token itself: the longer value Cloudflare shows only once.`,
    );
  }

  const call = client(token, fetcher);
  let step = "check the token";
  let accountId: string | undefined;
  let tokenId: string | undefined;
  // An address this change attached; taken back off if the login cannot be changed, so a failed change leaves none.
  let attachedNow: string | undefined;
  try {
    // The login setup made names the app's account and, by its workers.dev address, the Worker.
    let login: LoginApp | undefined;
    for (const account of (await call<{ id: string }[]>("GET", "/accounts")).result) {
      const apps = await listAll<LoginApp>(call, `/accounts/${account.id}/access/apps`).catch((error) => {
        if (error instanceof StepFailed && (error.status === 403 || error.status === 404)) return [];
        throw error;
      });
      const found = apps.find((app) => app.aud === env.ACCESS_AUD);
      if (found) {
        accountId = account.id;
        login = found;
      }
    }
    if (!accountId || !login) {
      return show(
        env.DB,
        problem([
          html`This token is for a different Cloudflare account. Log in to the account this app runs on, create the token again, and paste it.`,
          html`Delete the token you made in the other account.`,
        ]),
        400,
        typed,
      );
    }
    const at = `/accounts/${accountId}`;
    tokenId = (await call<{ id: string }>("GET", `${at}/tokens/verify`)).result.id;
    const workersDev = login.domain;
    const script = workersDev.split(".")[0];
    step = "read the app's addresses";
    const attached = (await call<WorkerAddress[]>("GET", `${at}/workers/domains`)).result;

    if (address) {
      // Attaching an address another Worker has could take it from that Worker, so it is refused here.
      const taken = attached.find((a) => a.hostname === address && a.service !== script);
      if (taken) {
        return show(
          env.DB,
          html`${problem([html`${address} is already the address of another Worker, ${taken.service}. Pick another address.`])}${tokenNotice(await deleteToken(call, accountId, tokenId))}`,
          400,
          typed,
        );
      }
      step = "attach the address to the app";
      const made = await call<WorkerAddress>("PUT", `${at}/workers/domains`, {
        hostname: address,
        service: script,
        environment: "production",
      });
      if (!attached.some((a) => a.hostname === address)) attachedNow = made.result.id;
    }

    step = address ? "add the address to the login" : "take the address off the login";
    // The login is sent back whole, as read, with only its addresses changed: its audience and policy stay the same,
    // so the app's own login check is unchanged.
    const { id, uid, aud, created_at, updated_at, ...current } = (
      await call<LoginApp>("GET", `${at}/access/apps/${login.id}`)
    ).result;
    // The app's own addresses are the ones its login covers, the one Settings saved, and any an earlier change could
    // not take off yet. An address attached by hand that none of them knows is left.
    const saved = await env.DB.prepare("SELECT address, address_leaving FROM settings").first<{
      address: string | null;
      address_leaving: string | null;
    }>();
    const previous = [
      ...((current.destinations ?? []) as Destination[]).map((destination) => destination.uri),
      saved?.address ?? "",
      ...(saved?.address_leaving ?? "").split(" "),
    ].filter((uri, at, all) => uri && uri !== workersDev && uri !== address && all.indexOf(uri) === at);
    const hosts = address ? [workersDev, address] : [workersDev];
    await call("PUT", `${at}/access/apps/${login.id}`, {
      ...current,
      self_hosted_domains: hosts,
      destinations: hosts.map((uri) => ({ type: "public", uri })),
      policies: current.policies?.map(({ created_at, updated_at, ...policy }) => policy),
    });
    attachedNow = undefined;
    // The login now has only the new address, so Settings shows only that; the earlier ones wait apart until they are
    // off the Worker.
    await env.DB.prepare("UPDATE settings SET address = ?, address_leaving = ?")
      .bind(address || null, previous.join(" ") || null)
      .run();

    step = "take the previous address off the app";
    for (const old of attached) {
      if (old.service === script && previous.includes(old.hostname)) {
        await call("DELETE", `${at}/workers/domains/${old.id}`);
      }
    }
    await env.DB.prepare("UPDATE settings SET address_leaving = NULL").run();

    const done = address
      ? html`<p class="saved" role="status">Your address is now ${address}. Its login starts working in about a minute: <a href="https://${address}/">open ${address}</a>.</p>`
      : html`<p class="saved" role="status">Your own address is removed. timecapsule is at its workers.dev address only.</p>`;
    return show(env.DB, html`${done}${tokenNotice(await deleteToken(call, accountId, tokenId))}`, 200);
  } catch (error) {
    const reason = error instanceof StepFailed ? error.message : String(error);
    const status = error instanceof StepFailed ? error.status : undefined;
    if (step === "check the token" && status !== undefined && status >= 400 && status < 500) {
      return show(
        env.DB,
        problem([
          html`Cloudflare did not accept this token. Copy the token again, the long value Cloudflare shows only once, and paste it below.`,
          html`Cloudflare said: ${reason}`,
        ]),
        400,
        typed,
      );
    }
    if (accountId && attachedNow) {
      await call("DELETE", `/accounts/${accountId}/workers/domains/${attachedNow}`).catch(() => undefined);
    }
    const deleted = accountId && tokenId ? await deleteToken(call, accountId, tokenId) : false;
    // A refused address fails the same way again, so the owner is sent to pick another rather than to retry.
    if (step === "attach the address to the app" && status !== undefined && status >= 400 && status < 500) {
      const why = reason.startsWith(`${NOT_ON_ACCOUNT} `)
        ? html`${address} is not on a domain in this Cloudflare account. Add its domain to the account, or pick an address on one that is.`
        : html`Cloudflare refused ${address}. Pick another address.`;
      return show(env.DB, html`${problem([why, html`Cloudflare said: ${reason}`])}${tokenNotice(deleted)}`, 400, typed);
    }
    return show(
      env.DB,
      html`${problem([
        html`Changing the address stopped while it tried to ${step}.`,
        html`Cloudflare said: ${reason}`,
        html`Create a new token and press Change address again.`,
      ])}${tokenNotice(deleted)}`,
      502,
      typed,
    );
  }
}
