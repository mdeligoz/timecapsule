import { build } from "esbuild";
import type { CDPSession, Page } from "@playwright/test";

let bundle: string | undefined;

async function script(): Promise<string> {
  if (bundle === undefined) {
    const result = await build({
      stdin: {
        contents: 'import { letterHtml } from "./src/browser"; import { sampleLetter } from "./src/letter"; Object.assign(globalThis, { letterHtml, sampleLetter });',
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      format: "iife",
      write: false,
    });
    bundle = result.outputFiles[0].text;
  }
  return bundle;
}

export async function openConverter(page: Page): Promise<void> {
  await page.setContent("<!doctype html><title>converter</title>");
  await page.addScriptTag({ content: await script() });
}

export async function slowDown(page: Page, rate: number): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
  return session;
}
