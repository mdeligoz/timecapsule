// A stand-in Cloudflare account for exercising our own setup code: it keeps the tokens, Access apps and Worker secrets
// that setup makes, so a test can look at what was left behind. Nothing here claims how the real API behaves, except
// the running version's answer, captured from a real Worker; an install on a real account checks the rest.
import version from "./fixtures/cloudflare-worker-version.json";

export type Call = { method: string; path: string; body: unknown; auth: string | null };
type CloudflareError = { code: number; message: string; error_chain?: CloudflareError[] };
export type Answer = { status?: number; result?: unknown; errors?: CloudflareError[]; pages?: number };

type Token = { id: string; name: string; value: string; policies?: unknown };
type App = { id: string; aud: string; name: string; domain: string; policies?: unknown };

export const OURS = "acc-ours";
export const OTHER = "acc-other";
export const SCRIPT = "timecapsule";
export const VERSION = "ver-running";
export const PASTED = "pasted-token-value";
export const BUCKET_ITEM_WRITE = "pg-bucket-item-write";
// Lists come back in pages this long, so every list setup reads runs past its first page.
const PAGE = 2;

const notFound = (message: string): Answer => ({ status: 404, errors: [{ code: 10007, message }] });

// A bucket name stands for a copy whose wrangler.jsonc names a bucket other than timecapsule.
export function fakeAccount(bucket?: string) {
  const calls: Call[] = [];
  const tokens: Token[] = [
    { id: "tok-other-1", name: "someone else's", value: "v1" },
    { id: "tok-other-2", name: "someone else's too", value: "v2" },
    { id: "tok-pasted", name: "timecapsule setup", value: PASTED },
  ];
  const apps: App[] = [
    { id: "app-other-1", aud: "aud-x", name: "blog", domain: "blog.example.com" },
    { id: "app-other-2", aud: "aud-y", name: "wiki", domain: "wiki.example.com" },
  ];
  const secrets = new Map<string, string>();
  const accounts = [{ id: OTHER }, { id: OURS }];
  let made = 0;
  // A test sets this to make one call fail; returning undefined lets the call through.
  let fail: (call: Call) => Answer | undefined = () => undefined;

  function list<T>(items: T[], search: URLSearchParams): Answer {
    const page = Number(search.get("page") ?? "1");
    const pages = Math.max(1, Math.ceil(items.length / PAGE));
    return { result: items.slice((page - 1) * PAGE, page * PAGE), pages };
  }

  function answer(call: Call, search: URLSearchParams): Answer {
    const bearer = call.auth?.replace(/^Bearer /, "") ?? "";
    const caller = tokens.find((t) => t.value === bearer);
    if (!caller) return { status: 401, errors: [{ code: 9109, message: "Invalid access token" }] };
    const route = `${call.method} ${call.path}`;
    if (route === "GET /accounts") return { result: accounts };
    const account = /^\/accounts\/([^/]+)/.exec(call.path)?.[1];
    if (account !== OURS) {
      return account === OTHER ? notFound("This Worker does not exist on your account.") : notFound("no such account");
    }
    const rest = call.path.slice(`/accounts/${OURS}`.length);
    if (call.method === "GET" && rest === `/workers/scripts/${SCRIPT}/versions/${VERSION}`) {
      const bindings = version.body.result.resources.bindings.map((binding) =>
        binding.name === "FILES" && bucket ? { ...binding, bucket_name: bucket } : binding,
      );
      return { result: { ...version.body.result, id: VERSION, resources: { bindings } } };
    }
    if (call.method === "GET" && rest === "/tokens/verify") return { result: { id: caller.id, status: "active" } };
    if (call.method === "GET" && rest === "/tokens/permission_groups") {
      return {
        result: [
          { id: "pg-other", name: "Workers R2 Storage Write" },
          { id: BUCKET_ITEM_WRITE, name: "Workers R2 Storage Bucket Item Write" },
        ],
      };
    }
    if (call.method === "GET" && rest === "/tokens") {
      return list(
        tokens.map(({ id, name }) => ({ id, name })),
        search,
      );
    }
    if (call.method === "POST" && rest === "/tokens") {
      const body = call.body as { name: string; policies: unknown };
      const token = { id: `tok-made-${++made}`, name: body.name, value: `value-${made}`, policies: body.policies };
      tokens.push(token);
      return { result: { id: token.id, value: token.value } };
    }
    const token = /^\/tokens\/([^/]+)$/.exec(rest)?.[1];
    if (call.method === "DELETE" && token) {
      const at = tokens.findIndex((t) => t.id === token);
      if (at < 0) return notFound("no such token");
      tokens.splice(at, 1);
      return { result: { id: token } };
    }
    if (call.method === "GET" && rest === "/access/apps") return list(apps, search);
    if (call.method === "POST" && rest === "/access/apps") {
      const body = call.body as { name: string; domain: string; policies: unknown };
      const app = { id: `app-made-${++made}`, aud: `aud-made-${made}`, ...body };
      apps.push(app);
      return { result: { id: app.id, aud: app.aud } };
    }
    const app = /^\/access\/apps\/([^/]+)$/.exec(rest)?.[1];
    if (call.method === "DELETE" && app) {
      const at = apps.findIndex((a) => a.id === app);
      if (at < 0) return notFound("no such app");
      apps.splice(at, 1);
      return { result: { id: app } };
    }
    if (call.method === "PUT" && rest === `/workers/scripts/${SCRIPT}/secrets`) {
      const body = call.body as { name: string; text: string; type: string };
      secrets.set(body.name, body.text);
      return { result: { name: body.name, type: body.type } };
    }
    return notFound(`no route for ${route}`);
  }

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    const parsed = new URL(request.url);
    const text = await request.text();
    const call: Call = {
      method: request.method,
      path: parsed.pathname.replace(/^\/client\/v4/, ""),
      body: text ? JSON.parse(text) : null,
      auth: request.headers.get("authorization"),
    };
    calls.push(call);
    const result = fail(call) ?? answer(call, parsed.searchParams);
    const success = !result.errors;
    const resultInfo = result.pages
      ? { page: Number(parsed.searchParams.get("page") ?? "1"), total_pages: result.pages }
      : undefined;
    return Response.json(
      { success, result: result.result ?? null, result_info: resultInfo, errors: result.errors ?? [], messages: [] },
      { status: result.status ?? (success ? 200 : 400) },
    );
  };

  return {
    fetch,
    calls,
    tokens,
    apps,
    secrets,
    failWhen(rule: (call: Call) => Answer | undefined) {
      fail = rule;
    },
  };
}
