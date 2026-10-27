import { expect, test } from "@playwright/test";

test("the running Worker refuses a visitor who did not log in through Access", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(403);
  await expect(page.getByText("Only the owner can open this timecapsule.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Letters" })).toHaveCount(0);
});
