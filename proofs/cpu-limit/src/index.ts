import { cleanLetter } from "./clean";
import { sampleLetter } from "./letter";
import { loginEmail } from "./login";
import { presign } from "./presign";
import { open, seal } from "./seal";
import { sendInstant } from "./sendtime";

export type Env = {
  DB: D1Database;
  FILES: R2Bucket;
  OWNER_EMAIL: string;
  ACCESS_AUD: string;
  ACCESS_JWKS: string;
  LETTER_KEY: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};

type Send = typeof fetch;
type LetterInput = {
  title: string;
  html: string;
  sendLocal: string;
  sendZone: string;
  recipients: string[];
  files: { key: string; name: string; type: string; size: number }[];
};

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><body>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const plain = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function saveLetter(request: Request, env: Env): Promise<Response> {
  const input = (await request.json()) as LetterInput;
  const row = await env.DB.prepare(
    "INSERT INTO letters (title, body, send_local, send_zone, written_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(await seal(input.title, env.LETTER_KEY), await seal(input.html, env.LETTER_KEY), input.sendLocal, input.sendZone, Date.now())
    .first<{ id: number }>();
  const id = row!.id;
  await env.DB.batch([
    ...input.recipients.map((email) => env.DB.prepare("INSERT INTO recipients (letter_id, email) VALUES (?, ?)").bind(id, email)),
    ...input.files.map((f) =>
      env.DB.prepare("INSERT INTO files (letter_id, key, name, type, size) VALUES (?, ?, ?, ?, ?)").bind(id, f.key, f.name, f.type, f.size),
    ),
  ]);
  return Response.json({ id }, { status: 201 });
}

async function letterPage(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT title, body FROM letters WHERE id = ?").bind(id).first<{ title: string; body: string }>();
  if (!row) return page("Not found", "<p>Not found.</p>", 404);
  const title = await open(row.title, env.LETTER_KEY);
  // The body is HTML already cleaned in the owner's browser before saving.
  return page(title, `<h1>${escape(title)}</h1><article>${await open(row.body, env.LETTER_KEY)}</article>`);
}

async function listPage(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT id, title, send_local, send_zone FROM letters ORDER BY id").all<{
    id: number;
    title: string;
    send_local: string;
    send_zone: string;
  }>();
  const items = await Promise.all(
    results.map(
      async (r) => `<li><a href="/letters/${r.id}">${escape(await open(r.title, env.LETTER_KEY))}</a> ${escape(r.send_local)} ${escape(r.send_zone)}</li>`,
    ),
  );
  return page("Letters", `<h1>Letters</h1><ul>${items.join("")}</ul>`);
}

async function sendLetter(env: Env, send: Send, id: number): Promise<boolean> {
  const letter = await env.DB.prepare("SELECT title, body FROM letters WHERE id = ?").bind(id).first<{ title: string; body: string }>();
  const [recipients, files] = await env.DB.batch<Record<string, string>>([
    env.DB.prepare("SELECT email FROM recipients WHERE letter_id = ?").bind(id),
    env.DB.prepare("SELECT key, name FROM files WHERE letter_id = ?").bind(id),
  ]);
  const emails = recipients.results.map((r) => r.email);
  const attachments = await Promise.all(
    files.results.map(async (f) => ({
      filename: f.name,
      path: await presign({
        method: "GET",
        url: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${f.key}`,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        region: "auto",
        expiresSeconds: 3600,
      }),
    })),
  );
  const title = await open(letter!.title, env.LETTER_KEY);
  const email = {
    from: env.RESEND_FROM,
    ...(emails.length === 1 ? { to: emails } : { to: [env.OWNER_EMAIL], bcc: emails }),
    subject: title,
    html: await open(letter!.body, env.LETTER_KEY),
    attachments,
  };
  const response = await send("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `letter-${id}`,
    },
    body: JSON.stringify(email),
  });
  if (!response.ok) return false;
  await env.DB.prepare("UPDATE letters SET sent_at = ? WHERE id = ?").bind(Date.now(), id).run();
  return true;
}

// The hourly check: every waiting letter's local send time is resolved now, then due letters are sent.
export async function sendDue(env: Env, send: Send): Promise<{ sent: number; failed: number }> {
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT id, send_local, send_zone FROM letters WHERE sent_at IS NULL").all<{
    id: number;
    send_local: string;
    send_zone: string;
  }>();
  const outcome = { sent: 0, failed: 0 };
  for (const r of results.filter((r) => sendInstant(r.send_local, r.send_zone) <= now)) {
    if (await sendLetter(env, send, r.id)) outcome.sent++;
    else outcome.failed++;
  }
  return outcome;
}

export async function handle(request: Request, env: Env, send: Send): Promise<Response> {
  const token = request.headers.get("cf-access-jwt-assertion");
  const email = await loginEmail(token, env.ACCESS_JWKS, env.ACCESS_AUD, Math.floor(Date.now() / 1000));
  if (email === null || email !== env.OWNER_EMAIL) return plain("Forbidden.\n", 403);
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (method === "GET" && pathname === "/convert") {
    const letter = sampleLetter();
    const html = await cleanLetter(letter);
    return plain(`Converted and cleaned a ${letter.length}-character letter into ${html.length} characters of HTML.\n`);
  }
  if (method === "GET" && pathname === "/letters") return listPage(env);
  if (method === "POST" && pathname === "/letters") return saveLetter(request, env);
  const letter = pathname.match(/^\/letters\/(\d+)$/);
  if (method === "GET" && letter) return letterPage(env, Number(letter[1]));
  const file = pathname.match(/^\/files\/([\w.-]+)$/);
  if (method === "PUT" && file) {
    await env.FILES.put(file[1], request.body);
    return plain("Stored.\n", 201);
  }
  if (method === "POST" && pathname === "/send-due") return Response.json(await sendDue(env, send));
  return plain("Not found.\n", 404);
}

export default {
  fetch: (request, env) => handle(request, env, fetch),
  async scheduled(_controller, env) {
    await sendDue(env, fetch);
  },
} satisfies ExportedHandler<Env>;
