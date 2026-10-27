import { tokenLink } from "./link";
import { checkStorage, verdict } from "./check";
import { runSetup } from "./setup";

const SCRIPT_NAME = "timecapsule-token-proof";

export type Env = {
  BUCKET: string;
  OTHER_BUCKET: string;
  OWNER_EMAIL: string;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  SETUP_DONE?: string;
  ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
};

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>timecapsule setup proof</title><body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const notFound = () => page("<p>Not found.</p>", 404);

function setupPage(): Response {
  return page(`<h1>Set up</h1>
<p>1. <a href="${escape(tokenLink("timecapsule setup"))}" target="_blank" rel="noopener">Open Cloudflare's token page</a> and click <b>Continue to summary</b>, then <b>Create Token</b>.</p>
<p>2. Copy the token and paste it here.</p>
<form method="post" action="/setup">
<input name="token" type="password" autocomplete="off" required style="width:100%;padding:.5rem">
<p><button>Finish setup</button></p>
</form>`);
}

async function setup(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const outcome = await runSetup({
    token: String(form.get("token") ?? ""),
    scriptName: SCRIPT_NAME,
    versionId: env.CF_VERSION_METADATA.id,
    host: new URL(request.url).host,
    ownerEmail: env.OWNER_EMAIL,
    bucket: env.BUCKET,
    fetch,
  });
  if (!outcome.ok) {
    return page(
      `<h1>Setup stopped</h1><p>Step: ${escape(outcome.failedStep)}</p><p>Cloudflare said: ${escape(outcome.reason)}</p><p>Token deleted: ${outcome.tokenDeleted ? "yes" : "no"}</p><p>Pasted text: ${escape(outcome.pasted)}</p>${
        outcome.encryptionKey
          ? `<p>Your encryption key was already stored. Shown this once:</p><pre style="white-space:pre-wrap;word-break:break-all">${escape(outcome.encryptionKey)}</pre>`
          : ""
      }`,
      400,
    );
  }
  return page(`<h1>Setup finished</h1>
<p>Your encryption key, shown this once:</p><pre style="white-space:pre-wrap;word-break:break-all">${escape(outcome.encryptionKey)}</pre>
<p>The token you pasted has been deleted. This page now asks for your Cloudflare login. <a href="/check">Check file storage</a></p>`);
}

async function check(request: Request, env: Env): Promise<Response> {
  const results = await checkStorage({
    accountId: env.ACCOUNT_ID ?? "",
    bucket: env.BUCKET,
    otherBucket: env.OTHER_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    viewer: request.headers.get("cf-access-authenticated-user-email"),
    fetch,
  });
  const rows = results
    .map((r) => `<li>${r.passed ? "✅" : "❌"} ${escape(r.name)} <small>(${escape(r.detail)})</small></li>`)
    .join("");
  return page(`<h1>${escape(verdict(results))}</h1><ul>${rows}</ul>`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const done = env.SETUP_DONE === "1";
    if (pathname === "/" && request.method === "GET") return done ? page('<p>Setup is finished. <a href="/check">Check file storage</a></p>') : setupPage();
    if (pathname === "/setup" && request.method === "POST" && !done) return setup(request, env);
    if (pathname === "/check" && request.method === "GET" && done) return check(request, env);
    return notFound();
  },
};
