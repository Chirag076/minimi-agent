// time.ts: calendar days in the user's time zone.
//
// Dates are compared as "YYYY-MM-DD" strings in the user's zone. Two messages sent at
// 11:30 pm and 12:30 am are on different days for the user, even if the server runs in UTC.

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** "2026-11-03" for the calendar day `date` falls on in `timeZone`. */
export function localDay(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Add whole days to a "YYYY-MM-DD" string. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`); // noon UTC never crosses a date line by accident
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function makeDay(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "Tuesday 3 November 2026" */
export function describeDay(day: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .formatToParts(new Date(`${day}T12:00:00Z`));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}

/** "Tue 3 Nov 2026, 14:05" in the user's zone. */
export function describeMoment(date: Date, timeZone: string): string {
  // Built from parts so the format is identical on every platform and Node version.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

/** The zone's UTC offset in minutes at `date` (330 for India). chrono needs it to read "today" correctly. */
export function offsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}
