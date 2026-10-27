import { marked } from "marked";
import { DROPPED_WITH_CONTENT, KEPT, safeHref } from "./rules";

export async function cleanLetter(markdown: string): Promise<string> {
  const html = await marked.parse(markdown, { async: true });
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (DROPPED_WITH_CONTENT.has(tag)) {
          element.remove();
          return;
        }
        if (!KEPT.has(tag) || (tag === "a" && !safeHref(element.getAttribute("href")))) {
          element.removeAndKeepContent();
          return;
        }
        const names = [...element.attributes].map(([name]) => name);
        for (const name of names) {
          if (!(tag === "a" && name === "href")) element.removeAttribute(name);
        }
      },
    })
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    });
  return rewriter.transform(new Response(html)).text();
}
