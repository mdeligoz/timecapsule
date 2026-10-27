import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// Exporting reads every letter, so this file runs once the screens that add and delete letters are done
// (see playwright.config.ts).

// A 1×1 PNG, and a video's worth of random bytes so every byte value goes through the zip.
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CLIP = randomBytes(300_000);

let token: string;

test.beforeEach(async ({ page, request }) => {
  token = await (await request.get("http://127.0.0.1:8788/token")).text();
  await page.setExtraHTTPHeaders({ "cf-access-jwt-assertion": token });
});

// Saves a letter through the app, so it is stored sealed as Save stores it.
async function save(request: APIRequestContext, subject: string, files: Record<string, Buffer>): Promise<void> {
  const headers = { "cf-access-jwt-assertion": token };
  const uploads: number[] = [];
  for (const [name, data] of Object.entries(files)) {
    const added = await request.post(`/uploads?name=${name}`, { headers, data });
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
}

// Every letter the Letters screen lists, on both tabs.
async function letterCount(page: Page): Promise<number> {
  await page.goto("/?tab=waiting");
  const waiting = await page.locator("a.letter").count();
  await page.goto("/?tab=sent");
  return waiting + (await page.locator("a.letter").count());
}

test("Export downloads one zip that the system's unzip opens, with every letter and file byte for byte", async ({
  page,
  request,
}) => {
  await save(request, "Export with files", { "photo.png": PHOTO, "clip.mp4": CLIP });
  await save(request, "Export without files", {});
  const letters = await letterCount(page);

  await page.goto("/settings");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^timecapsule-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(zip);

  execFileSync("unzip", ["-tq", zip]);
  const out = test.info().outputPath("unzipped");
  execFileSync("unzip", ["-q", zip, "-d", out]);
  const [root, ...rest] = readdirSync(out);
  expect(rest).toEqual([]);
  expect(root).toBe(download.suggestedFilename().replace(/\.zip$/, ""));
  const folders = readdirSync(join(out, root));
  expect(folders).toHaveLength(letters);

  const folder = (subject: string) => {
    const found = folders.filter((name) => name.endsWith(` ${subject}`));
    expect(found, subject).toHaveLength(1);
    return join(out, root, found[0]);
  };
  for (const subject of ["To London", "To Auckland", "Refused", "Sent in February", "Sent in March"]) {
    expect(readdirSync(folder(subject))).toEqual(["letter.html"]);
  }

  const withFiles = folder("Export with files");
  expect(readdirSync(withFiles).sort()).toEqual(["clip.mp4", "letter.html", "photo.png"]);
  expect(readFileSync(join(withFiles, "letter.html"), "utf8")).toContain("<p>The <strong>first</strong> words</p>");
  expect(readFileSync(join(withFiles, "photo.png")).equals(PHOTO)).toBe(true);
  expect(readFileSync(join(withFiles, "clip.mp4")).equals(CLIP)).toBe(true);
  expect(readdirSync(folder("Export without files"))).toEqual(["letter.html"]);
  await expect(page.getByText(`Export ready: ${download.suggestedFilename()}`)).toBeVisible();
});

test("a part that is no longer in the app is left out and named, and the rest still exports", async ({
  page,
  request,
}) => {
  await save(request, "Export with a lost file", { "lost.png": PHOTO, "kept.png": PHOTO });
  await page.route(/\/letters\/\d+\/files\/\d+$/, async (route) => {
    const response = await route.fetch();
    const name = /filename\*=UTF-8''(.*)$/.exec(response.headers()["content-disposition"] ?? "")?.[1];
    if (name === "lost.png") await route.fulfill({ status: 404, body: "Not found.\n" });
    else await route.fulfill({ response });
  });

  await page.goto("/settings");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const download = await downloading;
  const zip = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(zip);
  const out = test.info().outputPath("unzipped");
  execFileSync("unzip", ["-q", zip, "-d", out]);
  const root = readdirSync(out)[0];
  const folder = readdirSync(join(out, root)).find((name) => name.endsWith(" Export with a lost file")) ?? "";
  expect(readdirSync(join(out, root, folder)).sort()).toEqual(["kept.png", "letter.html"]);
  await expect(page.getByText(`Left out, no longer in the app: ${folder}/lost.png`)).toBeVisible();
});
