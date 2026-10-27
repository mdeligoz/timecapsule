// Date helpers shared by the server and the Write letter screen's script.
import { sendMoment } from "./sendtime";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function yearsLater(moment: number, years: number): number {
  const date = new Date(moment);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.getTime();
}

// The local date (YYYY-MM-DD) at a moment in a zone.
export function localDate(moment: number, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" }).format(moment);
}

// The local hour (YYYY-MM-DDTHH:00) a moment falls in, in a zone.
export function localHour(moment: number, zone: string): string {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(moment);
  return `${localDate(moment, zone)}T${hour}:00`;
}

// The earliest send hour (YYYY-MM-DDTHH:00) for a letter written at a moment: the first whole hour in the zone at
// least 7 days later, as the server reads it. On the night the clocks go back an hour's name means its first pass, so
// the hour 7 days on rounds up to can still be too soon; the next one is then the earliest.
export function firstSendHour(moment: number, zone: string): string {
  const earliest = moment + 7 * DAY;
  let hour = localHour(earliest + HOUR - 1, zone);
  if (sendMoment(hour, zone) < earliest) hour = localHour(earliest + 2 * HOUR - 1, zone);
  return hour;
}

// A date as "Jan 15th, 2027" in a zone.
export function longDate(moment: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, dateStyle: "medium" }).formatToParts(moment);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = Number(part("day"));
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${part("month")} ${day}${suffix}, ${part("year")}`;
}

// A letter's default subject, "A letter from Jan 15th, 2027", dated in the owner's zone.
export function defaultSubject(moment: number, zone: string): string {
  return `A letter from ${longDate(moment, zone)}`;
}

// The send dates the date picker offers: from the earliest send hour's day to 20 years after now.
export function sendDateLimits(moment: number, zone: string): { min: string; max: string } {
  return { min: firstSendHour(moment, zone).slice(0, 10), max: localDate(yearsLater(moment, 20), zone) };
}
