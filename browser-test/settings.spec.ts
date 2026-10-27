import { expect, test } from "@playwright/test";

// Saving here changes the zone every screen reads, so this file runs after the others (see playwright.config.ts).
test.beforeEach(async ({ page, request }) => {
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
});

test("with no zone saved, offers the browser's zone and has both emails on", async ({ browser, request }) => {
  const context = await browser.newContext({ timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Tokyo");
  await expect(page.getByLabel("Failure alert")).toBeChecked();
  await expect(page.getByLabel("Monthly status email")).toBeChecked();
  await context.close();
});

test("with no zone saved, offers the browser's zone when the browser gives it a newer name than the list", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ timezoneId: "Asia/Kolkata" });
  // Chromium reports the older name, Asia/Calcutta, which the list has; Firefox and Safari report Asia/Kolkata.
  await context.addInitScript(() => {
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      const options = resolved.call(this);
      return options.timeZone === "Asia/Calcutta" ? { ...options, timeZone: "Asia/Kolkata" } : options;
    };
  });
  const page = await context.newPage();
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
  await page.goto("/settings");
  await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Kolkata");
  await context.close();
});

test("changes the time zone and the emails, and a new letter starts in the saved zone", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Time zone").selectOption("America/Chicago");
  await page.getByLabel("Failure alert").uncheck();
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("status")).toHaveText("Settings saved.");
  await expect(page.getByLabel("Time zone")).toHaveValue("America/Chicago");
  await expect(page.getByLabel("Failure alert")).not.toBeChecked();
  await expect(page.getByLabel("Monthly status email")).toBeChecked();

  await page.goto("/write");
  await expect(page.getByLabel("Time zone")).toHaveValue("America/Chicago");
});
