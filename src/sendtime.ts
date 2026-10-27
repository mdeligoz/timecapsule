const DAY = 86_400_000;

// One formatter per zone for the life of the Worker instance; making one costs far more than using it.
const formatters = new Map<string, Intl.DateTimeFormat>();

// The local wall-clock time at a moment, read as if it were UTC, so it can be compared with a local send time.
function wallClock(moment: number, zone: string): number {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(moment);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

// The exact moment (milliseconds since 1970, UTC) a letter sends, from its local date and whole hour
// (YYYY-MM-DDTHH:00) in an IANA time zone, using only the runtime's built-in time-zone data.
// A repeated hour sends at its first occurrence; a skipped hour sends at the first moment after the clock change.
export function sendMoment(local: string, zone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00$/.exec(local);
  if (!match) throw new Error("A send time must be a date and a whole hour.");
  const [, year, month, day, hour] = match.map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour);
  // Date.UTC rolls an impossible date or hour over into the next one, so a mismatch means it does not exist.
  if (new Date(wanted).toISOString().slice(0, 13) !== local.slice(0, 13)) {
    throw new Error("A send time must be a real date and hour.");
  }

  // The zone's offsets a day either side; every clock change in the tz data falls between them.
  const before = wallClock(wanted - DAY, zone) - (wanted - DAY);
  const after = wallClock(wanted + DAY, zone) - (wanted + DAY);
  const first = Math.min(wanted - before, wanted - after);
  const second = Math.max(wanted - before, wanted - after);
  if (wallClock(first, zone) === wanted) return first;
  if (wallClock(second, zone) === wanted) return second;

  // Skipped: the clock change lies between the two, so find the first moment whose wall clock is past the wanted hour.
  let low = first;
  let high = second;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (wallClock(middle, zone) > wanted) high = middle;
    else low = middle;
  }
  return high;
}
