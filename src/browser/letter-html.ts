import { marked } from "marked";

const KEPT = new Set([
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
  "code",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);
const DROPPED_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "textarea",
  "select",
  "svg",
  "math",
  "title",
  "head",
]);
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

// URL.canParse is missing on iOS 16 and older, so a link that does not parse is caught instead.
function safeHref(href: string | null): boolean {
  if (href === null) return false;
  try {
    return LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

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

// Runs in the owner's browser for the preview and on Save. DOMParser builds an inert document: nothing in it runs or loads.
export function letterHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false, breaks: true });
  const body = new DOMParser().parseFromString(html, "text/html").body;
  clean(body);
  return body.innerHTML;
}
