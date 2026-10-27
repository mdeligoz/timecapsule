import { expect, type Page, test } from "@playwright/test";

// A 1×1 PNG.
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const nextYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

// Picks a send day the way the owner does: open the calendar, go to its month, press the day.
async function pickDate(page: Page, date: string): Promise<void> {
  await page.locator(".date-toggle").click();
  const calendar = page.getByRole("dialog", { name: "Choose a date" });
  await calendar.getByLabel("Year", { exact: true }).selectOption(date.slice(0, 4));
  await calendar.getByLabel("Month", { exact: true }).selectOption(String(Number(date.slice(5, 7)) - 1));
  await calendar.locator(`[data-date="${date}"]`).click();
  await expect(page.locator('input[name="date"]')).toHaveValue(date);
}

test.beforeEach(async ({ page, request }) => {
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
});

test("writes and saves a letter with a photo, then lands back on Letters", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Write a new letter" }).click();
  await expect(page.getByLabel("Subject")).toHaveValue(/^A letter from [A-Z][a-z]{2} \d{1,2}(st|nd|rd|th), \d{4}$/);
  await page.getByLabel("Subject").fill("A letter with a photo");

  await page.getByLabel("Letter").fill("hello");
  await page.getByLabel("Letter").selectText();
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(page.getByLabel("Letter")).toHaveValue("**hello**");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator(".preview strong")).toHaveText("hello");
  await page.getByRole("button", { name: "Write" }).click();

  await pickDate(page, nextYear());
  await page.getByLabel("Hour").selectOption("09:00");
  await page.getByLabel("Time zone").selectOption("Europe/London");
  await page.getByLabel("Recipients").fill("friend@example.com");

  await page.getByLabel("Files").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PHOTO });
  await expect(page.locator(".files li")).toContainText("photo.png");
  await expect(page.getByRole("button", { name: "Remove photo.png" })).toBeVisible();

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("link", { name: "A letter with a photo" })).toBeVisible();
});

test("with no zone saved, uses the browser's zone for the zone, the subject date and the date limits", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  // 20:00 UTC on Mar 4th is already Mar 5th in Tokyo.
  await page.clock.setFixedTime(new Date("2030-03-04T20:00:00Z"));
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
  await page.goto("/write");
  await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Tokyo");
  await expect(page.getByLabel("Subject")).toHaveValue("A letter from Mar 5th, 2030");
  await expect(page.locator('input[name="date"]')).toHaveAttribute("min", "2030-03-12");
  await expect(page.locator('input[name="date"]')).toHaveAttribute("max", "2050-03-05");
  await context.close();
});

test("with no zone saved, picks the browser's zone when the browser gives it a newer name than the list, and saves it", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ timezoneId: "Europe/Kyiv" });
  // Chromium reports the older name, Europe/Kiev, which the list has; Firefox and Safari report Europe/Kyiv.
  await context.addInitScript(() => {
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      const options = resolved.call(this);
      return options.timeZone === "Europe/Kiev" ? { ...options, timeZone: "Europe/Kyiv" } : options;
    };
  });
  const page = await context.newPage();
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
  await page.goto("/write");
  await expect(page.getByLabel("Time zone")).toHaveValue("Europe/Kyiv");
  await page.getByLabel("Subject").fill("A letter from Kyiv");
  await pickDate(page, nextYear());
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("link", { name: "A letter from Kyiv" })).toBeVisible();
  await context.close();
});

test("sends a letter once, however often Save is pressed while it is saving", async ({ page }) => {
  let posts = 0;
  let answer: () => void = () => {};
  await page.route("**/letters", async (route) => {
    posts++;
    await new Promise<void>((resolve) => {
      answer = resolve;
    });
    await route.fulfill({ status: 400, json: { error: "Held." } });
  });
  await page.goto("/write");
  await pickDate(page, nextYear());
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.locator("#letter").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect.poll(() => posts).toBe(1);
  await page.getByLabel("Files").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PHOTO });
  await page.locator("#letter").evaluate((form: HTMLFormElement) => form.requestSubmit());
  answer();
  await expect(page.getByRole("alert")).toHaveText("Held.");
  expect(posts).toBe(1);
});

test("asks for a reload when the app answers with something other than a refusal", async ({ page }) => {
  await page.route("**/letters", (route) => route.fulfill({ status: 403, body: "Forbidden.\n" }));
  await page.goto("/write");
  await pickDate(page, nextYear());
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Not saved. Check the connection, or reload the page and log in again if asked, then try once more.",
  );
});

test("leaves the page once saved, even when the answer cannot be read", async ({ page }) => {
  await page.route("**/letters", (route) => route.fulfill({ status: 201, body: "" }));
  await page.goto("/write");
  await pickDate(page, nextYear());
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL("/");
});

test("shows why a save was refused and stays on the page", async ({ page }) => {
  await page.goto("/write");
  await page.getByLabel("Letter").fill("Too soon");
  await page.getByLabel("Time zone").selectOption("UTC");
  // The calendar offers no day this soon; the server's refusal is what is under test, so the date is put in directly.
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await page.locator('input[name="date"]').evaluate((input: HTMLInputElement, value) => {
    input.value = value;
  }, soon);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The send time must be at least 7 days after the letter was written.",
  );
  await expect(page).toHaveURL("/write");
});

test("shows why a file of another type was refused", async ({ page }) => {
  await page.goto("/write");
  await page.getByLabel("Files").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(page.locator(".files li")).toContainText("Only JPG, PNG, GIF, WebP, HEIC, MP4, MOV and PDF files");
});

test("marks the one file a save refused, even beside another of the same name", async ({ page }) => {
  await page.route("**/letters", async (route) => {
    const { uploads } = route.request().postDataJSON() as { uploads: number[] };
    await route.fulfill({
      status: 400,
      json: { error: "A file was added more than 7 days ago. Remove it and add it again.", uploads: [uploads[1]] },
    });
  });
  await page.goto("/write");
  await pickDate(page, nextYear());
  await page.getByLabel("Time zone").selectOption("UTC");
  for (let i = 0; i < 2; i++) {
    await page.getByLabel("Files").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PHOTO });
    await expect(page.locator(".files li").nth(i)).not.toContainText("adding");
  }
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "A file was added more than 7 days ago. Remove it and add it again.",
  );
  await expect(page.locator(".files li").nth(0)).not.toHaveClass("refused");
  await expect(page.locator(".files li").nth(1)).toHaveClass("refused");
  await expect(page.locator(".files li").nth(1)).toContainText("photo.png: remove it and add it again.");
});

test("Preview takes the writing sheet's place, and Write brings it back", async ({ page }) => {
  await page.goto("/write");
  await page.getByLabel("Letter").fill("**hello**");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByLabel("Letter")).toBeHidden();
  await expect(page.locator(".preview strong")).toHaveText("hello");
  await page.getByRole("button", { name: "Write" }).click();
  await expect(page.getByLabel("Letter")).toBeVisible();
  await expect(page.locator(".preview")).toBeHidden();
});

// A fixed moment in UTC, so the calendar's days and hours are known.
async function at(
  browser: import("@playwright/test").Browser,
  request: import("@playwright/test").APIRequestContext,
  moment: string,
) {
  const context = await browser.newContext({ timezoneId: "UTC" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(moment));
  const token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
  await page.goto("/write");
  return { context, page };
}

test("the calendar greys out the days under 7 days and over 20 years ahead, and fills the date with the day picked", async ({
  browser,
  request,
}) => {
  const { context, page } = await at(browser, request, "2030-03-15T10:30:00Z");
  await expect(page.locator(".date-toggle")).toHaveText("Pick a date");
  await page.locator(".date-toggle").click();
  const calendar = page.getByRole("dialog", { name: "Choose a date" });
  await expect(calendar.locator('[data-date="2030-03-21"]')).toBeDisabled();
  await expect(calendar.locator('[data-date="2030-03-22"]')).toBeEnabled();
  await calendar.getByLabel("Year", { exact: true }).selectOption("2050");
  await calendar.getByLabel("Month", { exact: true }).selectOption("2");
  await expect(calendar.locator('[data-date="2050-03-15"]')).toBeEnabled();
  await expect(calendar.locator('[data-date="2050-03-16"]')).toBeDisabled();
  await calendar.getByLabel("Year", { exact: true }).selectOption("2041");
  await calendar.getByLabel("Month", { exact: true }).selectOption("5");
  await calendar.locator('[data-date="2041-06-20"]').click();
  await expect(calendar).toBeHidden();
  await expect(page.locator('input[name="date"]')).toHaveValue("2041-06-20");
  await expect(page.locator(".date-toggle")).toHaveText("Thursday, June 20, 2041");
  await context.close();
});

test("the quick picks fill the date 1, 5, 10 or 20 years ahead", async ({ browser, request }) => {
  const { context, page } = await at(browser, request, "2030-03-15T10:30:00Z");
  for (const [label, date] of [
    ["1 year", "2031-03-15"],
    ["5 years", "2035-03-15"],
    ["10 years", "2040-03-15"],
    ["20 years", "2050-03-15"],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator('input[name="date"]')).toHaveValue(date);
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await context.close();
});

test("on the earliest day, greys out the hours under 7 days ahead in the letter's zone, and moves one to the next", async ({
  browser,
  request,
}) => {
  const { context, page } = await at(browser, request, "2030-03-15T10:30:00Z");
  await page.getByLabel("Time zone").selectOption("UTC");
  await pickDate(page, "2030-03-22");
  const hour = page.getByLabel("Hour");
  await expect(hour.locator('option[value="10:00"]')).toHaveJSProperty("disabled", true);
  await expect(hour.locator('option[value="11:00"]')).toHaveJSProperty("disabled", false);
  await expect(hour).toHaveValue("11:00");
  // In Tokyo it is already 19:30, so 7 days on, more of the day is too soon.
  await page.getByLabel("Time zone").selectOption("Asia/Tokyo");
  await expect(hour.locator('option[value="19:00"]')).toHaveJSProperty("disabled", true);
  await expect(hour).toHaveValue("20:00");
  await pickDate(page, "2030-03-23");
  await expect(hour.locator('option[value="00:00"]')).toHaveJSProperty("disabled", false);
  await context.close();
});

test("on the latest day, greys out the hours after the hour of writing, so 20 years works before 9:00", async ({
  browser,
  request,
}) => {
  const { context, page } = await at(browser, request, "2030-03-15T06:30:00Z");
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByRole("button", { name: "20 years", exact: true }).click();
  const hour = page.getByLabel("Hour");
  await expect(hour.locator('option[value="06:00"]')).toHaveJSProperty("disabled", false);
  await expect(hour.locator('option[value="07:00"]')).toHaveJSProperty("disabled", true);
  await expect(hour).toHaveValue("06:00");
  await context.close();
});

test("a zone change moves the earliest and latest days to that zone, and clears a day it rules out", async ({
  browser,
  request,
}) => {
  // 20:00 UTC on Mar 15th is already 05:00 on Mar 16th in Tokyo.
  const { context, page } = await at(browser, request, "2030-03-15T20:00:00Z");
  await page.getByLabel("Time zone").selectOption("UTC");
  await pickDate(page, "2030-03-22");
  await page.getByLabel("Time zone").selectOption("Asia/Tokyo");
  await expect(page.locator('input[name="date"]')).toHaveAttribute("min", "2030-03-23");
  await expect(page.locator('input[name="date"]')).toHaveAttribute("max", "2050-03-16");
  await expect(page.locator('input[name="date"]')).toHaveValue("");
  await expect(page.locator(".date-toggle")).toHaveText("Pick a date");
  await context.close();
});

test("from the keyboard, Tab reaches a day of the month the menus moved to, and Tab out closes the calendar", async ({
  browser,
  request,
}) => {
  const { context, page } = await at(browser, request, "2030-03-15T10:30:00Z");
  await page.locator(".date-toggle").click();
  const calendar = page.getByRole("dialog", { name: "Choose a date" });
  await calendar.getByLabel("Year", { exact: true }).selectOption("2041");
  await calendar.getByLabel("Year", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAttribute("data-date", /^2041-03-/);
  await page.keyboard.press("Tab");
  await expect(calendar).toBeHidden();
  await context.close();
});

test("asks for a send date on Save without sending, when none is picked", async ({ page }) => {
  let posts = 0;
  await page.route("**/letters", (route) => {
    posts++;
    return route.fulfill({ status: 400, json: { error: "Held." } });
  });
  await page.goto("/write");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Pick a send date.");
  await expect(page.locator(".date-toggle")).toBeFocused();
  expect(posts).toBe(0);
});

test("names a recipient address the app would refuse on Save, without sending", async ({ page }) => {
  let posts = 0;
  await page.route("**/letters", (route) => {
    posts++;
    return route.fulfill({ status: 400, json: { error: "Held." } });
  });
  await page.goto("/write");
  await pickDate(page, nextYear());
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByLabel("Recipients").fill("friend@example.com\nbob@gmail.com.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText('"bob@gmail.com." is not an email address.');
  await expect(page.getByLabel("Recipients")).toBeFocused();
  expect(posts).toBe(0);
  // A domain in other scripts is taken as typed; the server stores its coded form.
  await page.getByLabel("Recipients").fill("friend@example.com\nivan@пример.рф");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Held.");
  expect(posts).toBe(1);
});

test("refuses a file that would take the files past 25 MB, before it is sent", async ({ page }) => {
  let posts = 0;
  await page.route("**/uploads?*", (route) => {
    posts++;
    return route.continue();
  });
  await page.goto("/write");
  // Added together, so the second is checked while the first is still on its way.
  await page.getByLabel("Files").setInputFiles([
    { name: "first.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(13 * 1024 * 1024) },
    { name: "second.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(13 * 1024 * 1024) },
  ]);
  await expect(page.locator(".files li").nth(0)).toHaveText("first.mp4 (13.0 MB) Remove");
  await expect(page.locator(".files li").nth(1)).toHaveText(
    "second.mp4: the files would come to more than 25 MB in total. Remove",
  );
  await expect(page.locator(".files li").nth(1)).toHaveClass("refused");
  // Exactly 25 MB in total is allowed.
  await page
    .getByLabel("Files")
    .setInputFiles({ name: "third.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(12 * 1024 * 1024) });
  await expect(page.locator(".files li").nth(2)).toHaveText("third.mp4 (12.0 MB) Remove");
  expect(posts).toBe(2);
});

test("stops a save with more than 20 people besides the owner, counting each address once", async ({ page }) => {
  let posts = 0;
  await page.route("**/letters", (route) => {
    posts++;
    return route.fulfill({ status: 400, json: { error: "Held." } });
  });
  const people = (n: number) => Array.from({ length: n }, (_, i) => `friend${i}@example.com`);
  await page.goto("/write");
  await pickDate(page, nextYear());
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByLabel("Recipients").fill(people(21).join("\n"));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("A letter can go to at most 20 people besides you.");
  await expect(page.getByLabel("Recipients")).toBeFocused();
  expect(posts).toBe(0);
  await page.getByLabel("Recipients").fill([...people(20), "FRIEND0@example.com", "Owner@Example.com"].join("\n"));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Held.");
  expect(posts).toBe(1);
});

test("the toolbar never takes the letter past 50,000 characters", async ({ page }) => {
  await page.goto("/write");
  const letter = page.getByLabel("Letter");
  await letter.fill("a".repeat(49_997));
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(page.getByRole("alert")).toHaveText("That would take the letter past 50,000 characters.");
  await expect(letter).toHaveJSProperty("value.length", 49_997);
  await letter.fill("a".repeat(49_996));
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(letter).toHaveJSProperty("value.length", 50_000);
  await expect(page.getByRole("alert")).toHaveText("");
});

// Drops a file on an element as the browser does, and says whether the page kept the browser from opening it.
async function drop(page: Page, selector: string, name: string): Promise<boolean> {
  return page.locator(selector).evaluate((target, name) => {
    const data = new DataTransfer();
    data.items.add(new File(["x"], name, { type: "image/png" }));
    const over = new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true });
    const dropped = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
    target.dispatchEvent(over);
    target.dispatchEvent(dropped);
    return over.defaultPrevented && dropped.defaultPrevented;
  }, name);
}

test("a file dropped anywhere on the page is added as in the Files box, and the page stays", async ({ page }) => {
  await page.goto("/write");
  expect(await drop(page, "h1", "heading.png")).toBe(true);
  expect(await drop(page, 'textarea[name="text"]', "letter.png")).toBe(true);
  expect(await drop(page, 'input[type="file"]', "box.png")).toBe(true);
  await expect(page.locator(".files li")).toHaveCount(3);
  for (const name of ["heading.png", "letter.png", "box.png"]) {
    await expect(page.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
  }
  await expect(page).toHaveURL("/write");
});

test("text dragged within the letter is left to the browser", async ({ page }) => {
  await page.goto("/write");
  const prevented = await page.getByLabel("Letter").evaluate((target) => {
    const data = new DataTransfer();
    data.setData("text/plain", "moved");
    const over = new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true });
    target.dispatchEvent(over);
    return over.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test("a file dropped while the letter is saving is not added", async ({ page }) => {
  let answer: () => void = () => {};
  await page.route("**/letters", async (route) => {
    await new Promise<void>((resolve) => {
      answer = resolve;
    });
    await route.fulfill({ status: 400, json: { error: "Held." } });
  });
  await page.goto("/write");
  await pickDate(page, nextYear());
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(await drop(page, "h1", "late.png")).toBe(true);
  answer();
  await expect(page.getByRole("alert")).toHaveText("Held.");
  await expect(page.locator(".files li")).toHaveCount(0);
});

test("saves the earliest hour offered even when the page opened two hours before Save", async ({
  browser,
  request,
}) => {
  // The page's clock stops two hours back: to the server, Save comes two hours after the page worked out its hours.
  const opened = new Date(Date.now() - 2 * 3_600_000);
  const { context, page } = await at(browser, request, opened.toISOString());
  await page.getByLabel("Subject").fill("Written over two hours");
  await page.getByLabel("Letter").fill("hello");
  await page.getByLabel("Time zone").selectOption("UTC");
  await pickDate(page, (await page.locator('input[name="date"]').getAttribute("min")) ?? "");
  const earliest = await page.getByLabel("Hour").locator("option:not([disabled])").first().getAttribute("value");
  await page.getByLabel("Hour").selectOption(earliest ?? "");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("link", { name: "Written over two hours" })).toBeVisible();
  await context.close();
});
