import { describe, expect, it } from "vitest";
import { checkStorage, type CheckInput, verdict } from "../src/check";

function input(answers: { put: number; get: number; body?: string; del: number; other: number }): CheckInput {
  let written = "";
  return {
    accountId: "acc",
    bucket: "ours",
    otherBucket: "not-ours",
    accessKeyId: "key",
    secretAccessKey: "secret",
    viewer: "owner@example.com",
    fetch: async (url, init) => {
      const target = new URL(url instanceof Request ? url.url : url);
      const method = init?.method ?? "GET";
      if (target.pathname.startsWith("/not-ours/")) return new Response(null, { status: answers.other });
      if (method === "PUT") {
        written = String(init?.body);
        return new Response(null, { status: answers.put });
      }
      if (method === "GET") return new Response(answers.body ?? written, { status: answers.get });
      return new Response(null, { status: answers.del });
    },
  };
}

describe("storage check", () => {
  it("passes when the key works on its bucket and is refused on another", async () => {
    const results = await checkStorage(input({ put: 200, get: 200, del: 204, other: 403 }));
    expect(results.every((r) => r.passed)).toBe(true);
    expect(verdict(results)).toBe("PASS: every check passed.");
  });

  it("fails when the key can also write to another bucket", async () => {
    const results = await checkStorage(input({ put: 200, get: 200, del: 204, other: 200 }));
    expect(results.find((r) => r.name === "The key is refused on any other bucket")?.passed).toBe(false);
    expect(verdict(results)).toBe("FAIL: 1 of 5 checks failed.");
  });

  it("fails when the downloaded text differs from the upload", async () => {
    const results = await checkStorage(input({ put: 200, get: 200, body: "something else", del: 204, other: 403 }));
    expect(verdict(results)).toBe("FAIL: 1 of 5 checks failed.");
  });

  it("fails when nobody is signed in through Access", async () => {
    const results = await checkStorage({ ...input({ put: 200, get: 200, del: 204, other: 403 }), viewer: null });
    expect(verdict(results)).toBe("FAIL: 1 of 5 checks failed.");
  });
});
