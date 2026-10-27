import { expect, test } from "@playwright/test";
import { keyStep } from "../src/key-step";

// The key step as the setup page writes it, with the real stylesheet; the page's script shows the Copy button.
for (const width of [1280, 375]) {
  test(`leaves clear space between the encryption key and its Copy button, ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const step = keyStep({ letterKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", saved: false });
    await page.setContent(`<!doctype html><title>setup</title><form class="setup">${step.text}</form>`);
    await page.addStyleTag({ path: "public/style.css" });
    await page.locator("#copy-key").evaluate((button) => button.removeAttribute("hidden"));
    const key = await page.locator("#letter-key").boundingBox();
    const copy = await page.locator("#copy-key").boundingBox();
    if (!key || !copy) throw new Error("The key box or the Copy button is not on the page");
    expect(copy.y - (key.y + key.height)).toBeGreaterThanOrEqual(10);
  });
}
