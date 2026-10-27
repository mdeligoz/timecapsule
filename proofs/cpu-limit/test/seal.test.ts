import { describe, expect, it } from "vitest";
import { open, seal } from "../src/seal";

const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const otherKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe("seal and open", () => {
  it("round-trips letter text", async () => {
    expect(await open(await seal("Dear me, ünïcode ✓", key), key)).toBe("Dear me, ünïcode ✓");
  });

  it("never stores the text in readable form, and never the same way twice", async () => {
    const a = await seal("Dear me", key);
    const b = await seal("Dear me", key);
    expect(a).not.toContain("Dear");
    expect(a).not.toBe(b);
  });

  it("refuses to open with another key", async () => {
    await expect(open(await seal("Dear me", key), otherKey)).rejects.toThrow();
  });
});
