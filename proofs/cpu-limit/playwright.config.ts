import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "browser-test",
  use: { browserName: "chromium" },
});
