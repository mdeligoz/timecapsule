import STYLE from "../public/style.css";

import { Html, html } from "./markup";

export { Html, html };

// The logo: an envelope closed with a wax seal.
const LOGO = html`<svg class="logo" viewBox="0 0 40 40" width="52" height="52" aria-hidden="true"><rect class="paper" x="4" y="9" width="32" height="22" rx="2.5"/><path class="fold" d="M4.8 10.2 20 21.5 35.2 10.2M4.8 30 15.5 19.5M35.2 30 24.5 19.5"/><circle class="seal" cx="20" cy="22" r="6.5"/></svg>`;

const MENU = [
  ["/", "Letters"],
  ["/write", "Write"],
  ["/settings", "Settings"],
];

// Every screen shares this frame: the logo and app name linking home, and the menu, with the screen shown marked.
// A page without the menu is one shown before login, such as setup's; Access guards the stylesheet there too, so the
// page carries its styles itself.
export function page(
  main: Html,
  init: { status?: number; headers?: Record<string, string>; menu?: boolean; here?: string } = {},
): Response {
  const loggedIn = init.menu !== false;
  const menu = loggedIn
    ? html`<nav class="menu">${MENU.map(([href, label]) => html`<a href="${href}"${href === init.here ? html` aria-current="page"` : html``}>${label}</a>`)}</nav>`
    : html``;
  const style = loggedIn ? html`<link rel="stylesheet" href="/style.css">` : html`<style>${new Html(STYLE)}</style>`;
  const body = html`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>timecapsule</title>
<link rel="icon" href="/favicon.svg">
${style}
<header class="top"><a class="brand" href="/">${LOGO}<span class="word">timecapsule</span></a>${menu}</header>
<main>${main}</main>
</html>
`;
  return new Response(body.text, {
    status: init.status,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

export function notFound(): Response {
  return page(
    html`<h1>Page not found</h1>
<p>There is nothing at this address. Go back to <a href="/">Letters</a>.</p>`,
    { status: 404 },
  );
}

// Shown to anyone without the owner's login, so it shows nothing of the app but this.
export function forbidden(): Response {
  return page(
    html`<h1>Private</h1>
<p>Only the owner can open this timecapsule.</p>`,
    { status: 403, menu: false },
  );
}
