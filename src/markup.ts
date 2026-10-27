// Page markup. Anything put into html`` is escaped unless it is itself markup made by html``.
export class Html {
  constructor(readonly text: string) {}
}

type Value = string | number | Html | Html[];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function render(value: Value): string {
  if (Array.isArray(value)) return value.map(render).join("");
  if (value instanceof Html) return value.text;
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let text = strings[0];
  values.forEach((value, i) => {
    text += render(value) + strings[i + 1];
  });
  return new Html(text);
}
