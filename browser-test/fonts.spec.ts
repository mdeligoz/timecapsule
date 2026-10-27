import { expect, test } from "@playwright/test";

// Each font request on a real install goes through Access; until it answers, the page draws its text in a fallback
// font, which is larger. Once loaded, the fonts must come from the browser's cache on the next screen, without asking
// the server again.
test("moving to another screen takes the fonts from the browser's cache", async ({ page, request }) => {
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Chromium's own record of where each response came from.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const fonts = new Map<string, string>();
  const cached = new Set<string>();
  cdp.on("Network.requestWillBeSent", (sent) => {
    if (sent.request.url.includes("/fonts/")) fonts.set(sent.requestId, sent.request.url.split("/").pop() ?? "");
  });
  cdp.on("Network.requestServedFromCache", ({ requestId }) => cached.add(requestId));
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    if (response.fromDiskCache || response.fromPrefetchCache) cached.add(requestId);
  });
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");

  expect(fonts.size).toBeGreaterThan(0);
  expect([...fonts].filter(([id]) => !cached.has(id)).map(([, name]) => name)).toEqual([]);
});
