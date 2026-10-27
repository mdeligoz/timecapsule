import { localDate } from "../dates";

// The send date's calendar, in the page's own look, in place of the browser's. Month and year menus jump years ahead
// in two clicks; quick picks under it give a date 1, 5, 10 or 20 years on. Days outside the field's min and max are
// greyed out. It fills the form's own date field and fires its change event.

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (date: string) => ({
  y: Number(date.slice(0, 4)),
  m: Number(date.slice(5, 7)) - 1,
  d: Number(date.slice(8, 10)),
});
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const utc = (date: string) => {
  const { y, m, d } = parse(date);
  return Date.UTC(y, m, d);
};
const shift = (date: string, days: number) => new Date(utc(date) + days * 86_400_000).toISOString().slice(0, 10);

const MONTHS = Array.from({ length: 12 }, (_, m) =>
  new Date(Date.UTC(2000, m, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
);
const longDate = (date: string) =>
  new Date(utc(date)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

// The week starts on the browser's first day of the week: Monday in most of the world, Sunday in some.
function firstDay(): number {
  const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  return (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 1;
}

export function calendar(field: HTMLInputElement, toggle: HTMLButtonElement, zoneSelect: HTMLSelectElement): void {
  const zone = () => zoneSelect.value || "UTC";
  const first = firstDay() % 7;
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 7 + first + i)).toLocaleString("en-US", { weekday: "short", timeZone: "UTC" }),
  );
  const valueText = toggle.querySelector("#date-value") as HTMLElement;

  const pop = document.createElement("div");
  pop.className = "calendar";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Choose a date");
  pop.hidden = true;
  pop.innerHTML = `<div class="cal-head">
<button type="button" class="cal-step" data-step="-1" aria-label="Previous month">‹</button>
<select class="cal-month" aria-label="Month">${MONTHS.map((name, i) => `<option value="${i}">${name}</option>`).join("")}</select>
<select class="cal-year" aria-label="Year"></select>
<button type="button" class="cal-step" data-step="1" aria-label="Next month">›</button>
</div>
<table class="cal-grid"><thead><tr>${weekdays.map((day) => `<th scope="col" abbr="${day}">${day.slice(0, 2)}</th>`).join("")}</tr></thead><tbody></tbody></table>`;
  toggle.after(pop);
  const monthSelect = pop.querySelector(".cal-month") as HTMLSelectElement;
  const yearSelect = pop.querySelector(".cal-year") as HTMLSelectElement;
  const [stepBack, stepOn] = pop.querySelectorAll<HTMLButtonElement>(".cal-step");
  const body = pop.querySelector("tbody") as HTMLTableSectionElement;

  let view = parse(field.value || field.min);
  let focused = field.value || field.min;

  function render(): void {
    yearSelect.length = 0;
    for (let y = Number(field.min.slice(0, 4)); y <= Number(field.max.slice(0, 4)); y++) {
      yearSelect.add(new Option(String(y), String(y)));
    }
    // The day Tab lands on stays in the month shown: the same day of the month, kept within the limits.
    if (focused.slice(0, 7) !== iso(view.y, view.m, 1).slice(0, 7)) {
      const day = iso(view.y, view.m, Math.min(parse(focused).d, daysIn(view.y, view.m)));
      focused = day < field.min ? field.min : day > field.max ? field.max : day;
    }
    monthSelect.value = String(view.m);
    yearSelect.value = String(view.y);
    const today = localDate(Date.now(), zone());
    const lead = (new Date(Date.UTC(view.y, view.m, 1)).getUTCDay() - first + 7) % 7;
    const cells: string[] = Array.from({ length: lead }, () => "<td></td>");
    for (let d = 1; d <= daysIn(view.y, view.m); d++) {
      const date = iso(view.y, view.m, d);
      const attributes = [
        `data-date="${date}"`,
        `aria-label="${longDate(date)}"`,
        `tabindex="${date === focused ? 0 : -1}"`,
        date === field.value ? 'aria-pressed="true"' : "",
        date === today ? 'class="today"' : "",
        date < field.min || date > field.max ? "disabled" : "",
      ];
      cells.push(`<td><button type="button" ${attributes.join(" ")}>${d}</button></td>`);
    }
    while (cells.length % 7) cells.push("<td></td>");
    body.innerHTML = Array.from(
      { length: cells.length / 7 },
      (_, row) => `<tr>${cells.slice(row * 7, row * 7 + 7).join("")}</tr>`,
    ).join("");
    const shown = iso(view.y, view.m, 1);
    stepBack.disabled = shown <= `${field.min.slice(0, 8)}01`;
    stepOn.disabled = shown >= `${field.max.slice(0, 8)}01`;
  }

  function show(): void {
    valueText.textContent = field.value ? longDate(field.value) : "Pick a date";
    toggle.classList.toggle("empty", !field.value);
    for (const button of quick.querySelectorAll<HTMLButtonElement>("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.date === field.value));
    }
  }

  function choose(date: string): void {
    field.value = date;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    show();
  }

  function open(): void {
    const today = localDate(Date.now(), zone());
    focused = field.value || (today < field.min ? field.min : today);
    view = parse(focused);
    render();
    pop.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    body.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
  }

  function close(refocus: boolean): void {
    pop.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (refocus) toggle.focus();
  }

  function moveTo(date: string): void {
    focused = date < field.min ? field.min : date > field.max ? field.max : date;
    view = parse(focused);
    render();
    body.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
  }

  toggle.addEventListener("click", () => (pop.hidden ? open() : close(false)));
  for (const step of [stepBack, stepOn]) {
    step.addEventListener("click", () => {
      const month = view.m + Number(step.dataset.step);
      view = { y: view.y + Math.floor(month / 12), m: (month + 12) % 12, d: 1 };
      render();
    });
  }
  monthSelect.addEventListener("change", () => {
    view.m = Number(monthSelect.value);
    render();
  });
  yearSelect.addEventListener("change", () => {
    view.y = Number(yearSelect.value);
    render();
  });
  body.addEventListener("click", (event) => {
    const day = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-date]");
    if (!day || day.disabled) return;
    choose(day.dataset.date ?? "");
    close(true);
  });
  // Arrows move a day or a week, Page Up and Page Down a month; Enter or Space picks the day.
  body.addEventListener("keydown", (event) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in steps) {
      event.preventDefault();
      moveTo(shift(focused, steps[event.key]));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const { y, m, d } = parse(focused);
      const month = m + (event.key === "PageUp" ? -1 : 1);
      const year = y + Math.floor(month / 12);
      const inYear = (month + 12) % 12;
      moveTo(iso(year, inYear, Math.min(d, daysIn(year, inYear))));
    }
  });
  pop.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close(true);
  });
  // Tabbing out of the calendar closes it; a click on its own background moves focus nowhere and leaves it open.
  pop.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (!pop.hidden && next && !pop.parentElement?.contains(next)) close(false);
  });
  // A day ruled out elsewhere, such as by a zone change, shows as no date picked.
  field.addEventListener("change", show);
  document.addEventListener("mousedown", (event) => {
    if (!pop.hidden && !pop.parentElement?.contains(event.target as Node)) close(false);
  });

  const quick = document.createElement("p");
  quick.className = "quick";
  quick.append("Or in ");
  for (const years of [1, 5, 10, 20]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = years === 1 ? "1 year" : `${years} years`;
    button.addEventListener("click", () => choose(button.dataset.date ?? ""));
    quick.append(button, " ");
  }
  field.closest("fieldset")?.append(quick);

  // The quick picks count from today in the letter's zone, and never go past the latest day.
  function quickDates(): void {
    const { y, m, d } = parse(localDate(Date.now(), zone()));
    quick.querySelectorAll<HTMLButtonElement>("button").forEach((button, i) => {
      const year = y + [1, 5, 10, 20][i];
      const date = iso(year, m, Math.min(d, daysIn(year, m)));
      button.dataset.date = date > field.max ? field.max : date;
    });
    show();
  }
  zoneSelect.addEventListener("change", quickDates);
  quickDates();
}
