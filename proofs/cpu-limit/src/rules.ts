export const KEPT = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "ul", "ol", "li", "blockquote", "a", "code", "pre",
]);
export const DROPPED_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript",
  "textarea", "select", "svg", "math", "title", "head",
]);
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeHref(href: string | null): boolean {
  if (href === null || !URL.canParse(href)) return false;
  return LINK_PROTOCOLS.has(new URL(href).protocol);
}
