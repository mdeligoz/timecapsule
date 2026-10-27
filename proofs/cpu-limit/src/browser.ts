import { marked } from "marked";
import { DROPPED_WITH_CONTENT, KEPT, safeHref } from "./rules";

function clean(parent: Node): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      continue;
    }
    if (!(node instanceof Element)) continue;
    const tag = node.localName;
    if (DROPPED_WITH_CONTENT.has(tag)) {
      node.remove();
      continue;
    }
    clean(node);
    if (!KEPT.has(tag) || (tag === "a" && !safeHref(node.getAttribute("href")))) {
      node.replaceWith(...node.childNodes);
      continue;
    }
    for (const name of node.getAttributeNames()) {
      if (!(tag === "a" && name === "href")) node.removeAttribute(name);
    }
  }
}

// Runs in the owner's browser. DOMParser builds an inert document: nothing in it runs or loads.
export function letterHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  const body = new DOMParser().parseFromString(html, "text/html").body;
  clean(body);
  return body.innerHTML;
}
