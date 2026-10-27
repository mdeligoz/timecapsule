import { defineConfig } from "@playwright/test";

// The Worker runs on a fresh local database seeded with test letters, and checks logins against the Access stand-in.
const STATE = ".wrangler/browser-test";
const ACCESS = "http://127.0.0.1:8788";
// A test-only letter key: 32 zero bytes.
const LETTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export default defineConfig({
  testDir: "browser-test",
  use: { browserName: "chromium", baseURL: "http://localhost:8787" },
  // Settings saves a time zone, which every other screen reads, and Export reads every letter, which the other screens
  // add and delete, so both run once the other screens are done.
  projects: [
    { name: "screens", testIgnore: ["settings.spec.ts", "export.spec.ts"] },
    { name: "settings", testMatch: ["settings.spec.ts", "export.spec.ts"], dependencies: ["screens"] },
  ],
  webServer: [
    {
      command: "node browser-test/access-stub.ts",
      url: `${ACCESS}/cdn-cgi/access/certs`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: [
        `rm -rf ${STATE}`,
        `npx wrangler d1 migrations apply DB --local --persist-to ${STATE}`,
        `npx wrangler d1 execute DB --local --persist-to ${STATE} --yes --file browser-test/letters.sql`,
        `npx wrangler dev --port 8787 --persist-to ${STATE} --var ACCESS_TEAM_DOMAIN:${ACCESS} --var ACCESS_AUD:browser-test --var OWNER_EMAIL:owner@example.com --var LETTER_KEY:${LETTER_KEY} --var SETUP_DONE:1`,
      ].join(" && "),
      url: "http://localhost:8787",
      // Never reuse a Worker already running: it would have neither the test letters nor the stand-in login.
      reuseExistingServer: false,
    },
  ],
});
