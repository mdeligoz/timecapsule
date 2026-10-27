import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// A 1×1 PNG.
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let token: string;

test.beforeEach(async ({ page, request }) => {
  token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
});

// Saves a letter through the app, so it is stored sealed as Save stores it, and opens it from Letters.
async function openSaved(page: Page, request: APIRequestContext, subject: string, withPhoto = false): Promise<void> {
  const headers = { "cf-access-jwt-assertion": token };
  const uploads: number[] = [];
  if (withPhoto) {
    const added = await request.post("/uploads?name=photo.png", { headers, data: PHOTO });
    uploads.push(((await added.json()) as { id: number }).id);
  }
  const saved = await request.post("/letters", {
    headers,
    data: {
      subject,
      markdown: "The **first** words",
      html: "<p>The <strong>first</strong> words</p>",
      sendLocal: `${new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)}T09:00`,
      zone: "UTC",
      recipients: ["friend@example.com"],
      uploads,
    },
  });
  expect(saved.status()).toBe(201);
  await page.goto("/");
  await page.getByRole("link", { name: subject }).click();
}

test("a waiting letter's text shows only after Reveal", async ({ page, request }) => {
  await openSaved(page, request, "Reveal me", true);
  await expect(page.getByRole("heading", { name: "Reveal me" })).toBeVisible();
  expect(await page.content()).not.toContain("first");
  expect(await page.content()).not.toContain("photo.png");
  await page.getByRole("link", { name: "Reveal" }).click();
  await expect(page.locator(".body strong")).toHaveText("first");
  const href = (await page.getByRole("link", { name: "photo.png" }).getAttribute("href")) ?? "";
  const photo = await request.get(href, { headers: { "cf-access-jwt-assertion": token } });
  expect(Buffer.from(await photo.body())).toEqual(PHOTO);
});

test("Delete asks first, then removes the letter", async ({ page, request }) => {
  await openSaved(page, request, "Delete me");
  await page.getByRole("link", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Delete “Delete me”?" })).toBeVisible();
  await page.getByRole("link", { name: "Keep it" }).click();
  await expect(page.getByRole("heading", { name: "Delete me" })).toBeVisible();
  await page.getByRole("link", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("link", { name: "Delete me" })).toHaveCount(0);
});

test("Edit opens the letter as saved, and Save keeps the changes", async ({ page, request }) => {
  await openSaved(page, request, "Edit me", true);
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("Subject")).toHaveValue("Edit me");
  await expect(page.getByLabel("Letter")).toHaveValue("The **first** words");
  await expect(page.getByLabel("Time zone")).toHaveValue("UTC");
  await expect(page.getByLabel("Recipients")).toHaveValue("friend@example.com");
  await page.getByRole("button", { name: "Remove photo.png" }).click();
  await page.getByLabel("Letter").fill("The *second* words");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Edit me" })).toBeVisible();
  await page.getByRole("link", { name: "Reveal" }).click();
  await expect(page.locator(".body em")).toHaveText("second");
  await expect(page.getByRole("link", { name: "photo.png" })).toHaveCount(0);
});
