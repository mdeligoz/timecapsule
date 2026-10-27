import { expect, test } from "@playwright/test";
import { openWhenReady } from "../src/ready";

test("holds Open timecapsule for 3 minutes with a countdown, then lets the owner open it", async ({ page }) => {
  // The finished page's own button and countdown, as the server writes them.
  await page.clock.install();
  await page.setContent(`<!doctype html><title>finished</title>${openWhenReady(180_000).text}`);
  // Without its address the button is no longer a link, so it is found by its place.
  const button = page.locator(".ready a");

  await expect(page.getByRole("status")).toHaveText("Your login is getting ready: 3:00");
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).not.toHaveAttribute("href");

  await page.clock.runFor(61_000);
  await expect(page.getByRole("status")).toHaveText("Your login is getting ready: 1:59");
  await expect(button).not.toHaveAttribute("href");

  await page.clock.runFor(2 * 60_000);
  await expect(page.getByRole("status")).toHaveText("Your login is ready.");
  await expect(button).toHaveAttribute("href", "/");
  await expect(button).not.toHaveAttribute("aria-disabled");
});
