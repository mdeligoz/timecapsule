const DAY = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
  let found = formats.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formats.set(zone, found);
  }
  return found;
}

// The zone's wall clock at instant t, read as if it were UTC.
function wall(t: number, zone: string): number {
  const p = Object.fromEntries(format(zone).formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const offset = (t: number, zone: string) => wall(t, zone) - t;

// When local date-time `local` ("YYYY-MM-DDTHH:mm") in IANA `zone` happens. A skipped local time
// resolves to the end of the gap; a repeated one to its first occurrence.
export function sendInstant(local: string, zone: string): number {
  const target = Date.parse(`${local}:00Z`);
  const before = offset(target - DAY, zone);
  const after = offset(target + DAY, zone);
  const valid = [target - before, target - after].filter((t) => wall(t, zone) === target);
  if (valid.length > 0) return Math.min(...valid);
  let low = target - after;
  let high = target - before;
  while (high - low > 60_000) {
    const mid = low + Math.floor((high - low) / 120_000) * 60_000;
    if (offset(mid, zone) === after) high = mid;
    else low = mid;
  }
  return high;
}
