import { expect, test } from "@playwright/test";
import { finishButton } from "../src/ready";

// The setup form's last part, as the server writes it. Each send is counted, then held back after the page's own
// script has seen it, so the page stays in its working state.
test("says setup is working from the click on, sends the form once, and is ready again when shown again", async ({
  page,
}) => {
  await page.setContent(`<!doctype html><title>setup</title>
<form method="post" action="/setup" class="setup">
<label>Token <input name="token" required></label>
${finishButton().text}
</form>`);
  await page.evaluate(() => {
    (window as unknown as { sends: number }).sends = 0;
    window.addEventListener("submit", (event) => {
      (window as unknown as { sends: number }).sends += 1;
      event.preventDefault();
    });
  });
  const sends = () => page.evaluate(() => (window as unknown as { sends: number }).sends);
  const button = page.getByRole("button");
  const status = page.getByRole("status");

  // A form the browser refuses to send is not working yet.
  await button.click();
  await expect(button).toBeEnabled();
  await expect(status).toHaveText("");
  expect(await sends()).toBe(0);

  await page.getByLabel("Token").fill("a-token");
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText("Setting up…");
  await expect(status).toHaveText("Setting up your login and storage. Keep this page open until it finishes.");
  await button.click({ force: true });
  expect(await sends()).toBe(1);

  // Back or a reload shows the page again.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(button).toBeEnabled();
  await expect(button).toHaveText("Finish setup");
  await expect(status).toHaveText("");
});
