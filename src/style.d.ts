// Wrangler bundles the stylesheet as text (see "rules" in wrangler.jsonc), so pages shown before login can carry it.
declare module "*.css" {
  const text: string;
  export default text;
}
