import { expect, test } from "@playwright/test";
import { openConverter } from "./page";

declare function letterHtml(markdown: string): string;

async function convert(page: import("@playwright/test").Page, markdown: string): Promise<string> {
  return page.evaluate((text) => letterHtml(text), markdown);
}

test.beforeEach(async ({ page }) => {
  await openConverter(page);
});

test("keeps headings, bold, italic, lists, quotes and links", async ({ page }) => {
  const html = await convert(
    page,
    "# Dear me\n\n**bold** and *italic* and ~~gone~~\n\n- one\n- two\n\n1. first\n\n> quoted\n\n[home](https://example.com/a?b=1)",
  );
  expect(html).toBe(
    '<h1>Dear me</h1>\n<p><strong>bold</strong> and <em>italic</em> and <del>gone</del></p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n</ol>\n<blockquote>\n<p>quoted</p>\n</blockquote>\n<p><a href="https://example.com/a?b=1">home</a></p>\n',
  );
});

test("keeps mailto links", async ({ page }) => {
  expect(await convert(page, "[mail](mailto:me@example.com)")).toBe('<p><a href="mailto:me@example.com">mail</a></p>\n');
});

test("removes script and style tags with their content", async ({ page }) => {
  const html = await convert(page, "before\n\n<script>alert(1)</script>\n\n<style>p{color:red}</style>\n\nafter");
  expect(html).not.toContain("alert");
  expect(html).not.toContain("color");
  expect(html).toContain("<p>before</p>");
  expect(html).toContain("<p>after</p>");
});

test("removes event attributes", async ({ page }) => {
  expect(await convert(page, '<p onclick="alert(1)" style="x">hi</p>')).toBe("<p>hi</p>");
});

test("removes javascript: links and keeps their text", async ({ page }) => {
  expect(await convert(page, "[click](javascript:alert(1))")).toBe("<p>click</p>\n");
  expect(await convert(page, '<a href="  JavaScript:alert(1)">x</a>')).toBe("<p>x</p>\n");
  expect(await convert(page, '<a href="java&#115;cript:alert(1)">y</a>')).toBe("<p>y</p>\n");
});

test("removes relative links and keeps their text", async ({ page }) => {
  expect(await convert(page, "[here](/settings)")).toBe("<p>here</p>\n");
});

test("cleans raw HTML pasted into the letter", async ({ page }) => {
  const html = await convert(
    page,
    '<div class="x">hi <img src="x" onerror="alert(1)"><iframe src="https://evil.example">no</iframe></div>',
  );
  expect(html).toBe("hi ");
});

test("removes images and HTML comments", async ({ page }) => {
  expect(await convert(page, "![cat](https://example.com/cat.png) <!-- secret -->")).toBe("<p> </p>\n");
});

test("never runs pasted script while cleaning", async ({ page }) => {
  await convert(page, '<img src="x" onerror="window.ran = 1"><script>window.ran = 2</script>');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as { ran?: number }).ran)).toBeUndefined();
});
