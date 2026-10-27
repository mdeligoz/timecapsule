// Canned Cloudflare API answers for exercising our own setup code.
// Nothing here claims how the real API behaves; the live run on the owner's account does that.

export type Call = { method: string; path: string; body: unknown; auth: string | null };
type CloudflareError = { code: number; message: string; error_chain?: CloudflareError[] };
export type Answer = { status?: number; result?: unknown; errors?: CloudflareError[] };

export function fakeCloudflare(routes: Record<string, Answer | ((call: Call) => Answer)>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const call: Call = {
      method: request.method,
      path: url.pathname.replace(/^\/client\/v4/, "") + url.search,
      body: text ? JSON.parse(text) : null,
      auth: request.headers.get("authorization"),
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) {
      return Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 });
    }
    const answer = typeof route === "function" ? route(call) : route;
    const success = !answer.errors;
    return Response.json(
      { success, result: answer.result ?? null, errors: answer.errors ?? [], messages: [] },
      { status: answer.status ?? (success ? 200 : 400) },
    );
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}
