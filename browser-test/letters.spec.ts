import { expect, type Page, test } from "@playwright/test";

// The letters seeded from letters.sql, as the Access stand-in's owner.
test.beforeEach(async ({ page, request }) => {
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
});

// Other browser tests save letters into the same database, so only the seeded letters are compared.
const SEEDED = new Set(["To London", "To Auckland", "Refused", "Stuck", "Sent in February", "Sent in March"]);
const subjects = async (page: Page) => (await page.locator("a.letter").allTextContents()).filter((t) => SEEDED.has(t));

test("lists waiting letters soonest first, with the failed one and the stuck one marked", async ({ page }) => {
  await page.goto("/");
  expect(await subjects(page)).toEqual(["Refused", "Stuck", "To Auckland", "To London"]);
  await expect(page.getByText("Not sent: Resend refused it")).toBeVisible();
  await expect(
    page.getByText("Not sent yet. Resend's answer: API key is invalid. Trying again every hour."),
  ).toBeVisible();
});

test("the Sent tab lists sent letters, most recently sent first", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sent", exact: true }).click();
  expect(await subjects(page)).toEqual(["Sent in March", "Sent in February"]);
});

test("sorts by writing date, newest first", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "writing date" }).click();
  expect(await subjects(page)).toEqual(["To Auckland", "To London", "Stuck", "Refused"]);
});

test("letter text never appears in the page", async ({ page }) => {
  for (const path of ["/", "/?sort=written", "/?tab=sent", "/?tab=sent&sort=written"]) {
    await page.goto(path);
    expect(await page.content()).not.toContain("marker letter text");
  }
});

test("links to writing a new letter and to Settings, and loads its stylesheet", async ({ page }) => {
  const stylesheet = page.waitForResponse("**/style.css");
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Write a new letter" })).toHaveAttribute("href", "/write");
  await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  expect((await stylesheet).status()).toBe(200);
});
