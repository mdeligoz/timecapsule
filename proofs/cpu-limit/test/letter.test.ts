import { describe, expect, it } from "vitest";
import { sampleLetter } from "../src/letter";

describe("sampleLetter", () => {
  it("is exactly 50,000 characters", () => {
    expect(sampleLetter()).toHaveLength(50_000);
  });

  it("uses every kind of formatting and some raw HTML to clean", () => {
    const letter = sampleLetter();
    for (const part of ["\n## ", "**", "*", "~~", "\n- ", "\n1. ", "\n> ", "](https://", "`", "<script>", "onclick="]) {
      expect(letter).toContain(part);
    }
  });
});
