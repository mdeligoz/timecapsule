import { describe, expect, it } from "vitest";
import { TOKEN_PERMISSIONS, tokenLink } from "../src/link";

describe("tokenLink", () => {
  it("opens the account-owned token page with every needed permission ticked", () => {
    const url = new URL(tokenLink("timecapsule setup"));
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.searchParams.get("to")).toBe("/:account/api-tokens");
    expect(url.searchParams.get("name")).toBe("timecapsule setup");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "")).toEqual(TOKEN_PERMISSIONS);
  });

  it("asks for nothing beyond the four permissions the setup uses", () => {
    expect(TOKEN_PERMISSIONS).toEqual([
      { key: "account_settings", type: "read" },
      { key: "workers_scripts", type: "edit" },
      { key: "account_api_tokens", type: "edit" },
      // "access" is Access: Apps and Policies; "access_acct" is Organizations, Identity Providers, and Groups.
      // Checked on the dashboard's review screen, 2026-10-18.
      { key: "access", type: "edit" },
    ]);
  });
});
