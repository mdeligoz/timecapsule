import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { tokenLink } from "../src/link";

const before: Env = {
  BUCKET: "timecapsule-token-proof",
  OTHER_BUCKET: "timecapsule-token-proof-other",
  OWNER_EMAIL: "owner@example.com",
  CF_VERSION_METADATA: { id: "ver-1", tag: "", timestamp: "" },
};
const after: Env = { ...before, SETUP_DONE: "1" };

function escaped(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

describe("setup page", () => {
  it("shows the pre-filled token link and a paste box before setup", async () => {
    const response = await worker.fetch(new Request("https://proof.example/"), before);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`href="${escaped(tokenLink("timecapsule setup"))}"`);
    expect(html).toContain('<form method="post" action="/setup">');
  });

  it("is switched off for good once setup is done", async () => {
    const page = await worker.fetch(new Request("https://proof.example/"), after);
    expect(await page.text()).not.toContain("<form");
    const post = await worker.fetch(
      new Request("https://proof.example/setup", { method: "POST", body: new URLSearchParams({ token: "x" }) }),
      after,
    );
    expect(post.status).toBe(404);
  });

  it("refuses the file check before setup", async () => {
    const response = await worker.fetch(new Request("https://proof.example/check"), before);
    expect(response.status).toBe(404);
  });
});
