import { describe, expect, it } from "vitest";
import { cleanLetter } from "../src/clean";

describe("cleanLetter", () => {
  it("keeps headings, bold, italic, lists, quotes and links", async () => {
    const html = await cleanLetter(
      "# Dear me\n\n**bold** and *italic* and ~~gone~~\n\n- one\n- two\n\n1. first\n\n> quoted\n\n[home](https://example.com/a?b=1)",
    );
    expect(html).toBe(
      '<h1>Dear me</h1>\n<p><strong>bold</strong> and <em>italic</em> and <del>gone</del></p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n</ol>\n<blockquote>\n<p>quoted</p>\n</blockquote>\n<p><a href="https://example.com/a?b=1">home</a></p>\n',
    );
  });

  it("keeps mailto links", async () => {
    expect(await cleanLetter("[mail](mailto:me@example.com)")).toBe('<p><a href="mailto:me@example.com">mail</a></p>\n');
  });

  it("removes script and style tags with their content", async () => {
    const html = await cleanLetter("before\n\n<script>alert(1)</script>\n\n<style>p{color:red}</style>\n\nafter");
    expect(html).not.toContain("alert");
    expect(html).not.toContain("color");
    expect(html).toContain("<p>before</p>");
    expect(html).toContain("<p>after</p>");
  });

  it("removes event attributes", async () => {
    const html = await cleanLetter('<p onclick="alert(1)" style="x">hi</p>');
    expect(html).toBe("<p>hi</p>");
  });

  it("removes javascript: links and keeps their text", async () => {
    expect(await cleanLetter("[click](javascript:alert(1))")).toBe("<p>click</p>\n");
    expect(await cleanLetter('<a href="  JavaScript:alert(1)">x</a>')).toBe("<p>x</p>\n");
    expect(await cleanLetter('<a href="java&#115;cript:alert(1)">y</a>')).toBe("<p>y</p>\n");
  });

  it("removes relative links and keeps their text", async () => {
    expect(await cleanLetter("[here](/settings)")).toBe("<p>here</p>\n");
  });

  it("cleans raw HTML pasted into the letter", async () => {
    const html = await cleanLetter('<div class="x">hi <img src="x" onerror="alert(1)"><iframe src="https://evil.example">no</iframe></div>');
    expect(html).toBe("hi ");
  });

  it("removes images and HTML comments", async () => {
    expect(await cleanLetter("![cat](https://example.com/cat.png) <!-- secret -->")).toBe("<p> </p>\n");
  });
});
