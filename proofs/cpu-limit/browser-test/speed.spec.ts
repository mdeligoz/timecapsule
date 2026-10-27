import { expect, test } from "@playwright/test";
import { openConverter, slowDown } from "./page";

declare function letterHtml(markdown: string): string;
declare function sampleLetter(): string;

// Chrome DevTools' "low-end mobile" preset slows the CPU 6 times.
const SLOW_PHONE = 6;
const LIMIT_MS = 200;

// Shared CI runners measured 156 and 244 ms for the same conversion, so the limit is only
// checked on a known machine. The measured speed is recorded in docs/tech-stack.md.
test.skip(!!process.env.CI, "timing varies too much on shared CI runners");

test("converts a 50,000-character letter in under 200 ms on a slow phone, first time", async ({ page }) => {
  await openConverter(page);
  await slowDown(page, SLOW_PHONE);
  const ms = await page.evaluate(() => {
    const letter = sampleLetter();
    const start = performance.now();
    letterHtml(letter);
    return performance.now() - start;
  });
  console.log(`first conversion at ${SLOW_PHONE}x slowdown: ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(LIMIT_MS);
});
