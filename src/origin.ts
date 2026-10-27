import { html, page } from "./html";

// A browser says which site sent a request: Sec-Fetch-Site, or Origin in browsers from before it. A request naming
// neither did not come from a current browser, so no other site's page could have made the owner's browser send it.
// "none" is refused too: a change only arrives with it on a reload, which can resend another site's refused request.
export function fromOtherSite(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin";
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
}

export function otherSite(): Response {
  return page(
    html`<h1>Refused</h1>
<p>This request came from another website, so nothing was changed. Go back to <a href="/">Letters</a>.</p>`,
    { status: 403, menu: false },
  );
}
