import { describe, expect, it } from "vitest";
import { buildEmail } from "../src/email.ts";

const files = [
  { filename: "photo.jpg", url: "https://acc.r2.cloudflarestorage.com/b/photo.jpg?X-Amz-Signature=aaa" },
  { filename: "video.mp4", url: "https://acc.r2.cloudflarestorage.com/b/video.mp4?X-Amz-Signature=bbb" },
];

describe("buildEmail", () => {
  const email = buildEmail({
    from: "me@example.com",
    to: "you@example.com",
    subject: "A letter",
    html: "<p>Dear me</p>",
    files,
  });

  it("asks Resend to fetch each file from its signed link", () => {
    expect(email.attachments).toEqual([
      { filename: "photo.jpg", path: files[0].url },
      { filename: "video.mp4", path: files[1].url },
    ]);
  });

  it("never adds a link to what the reader sees", () => {
    expect(email.html).toBe("<p>Dear me</p>");
    expect(email.subject).toBe("A letter");
  });

  it("sends from and to the given addresses", () => {
    expect(email.from).toBe("me@example.com");
    expect(email.to).toEqual(["you@example.com"]);
  });
});
