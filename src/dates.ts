// dates.ts: turns "last Tuesday", "on 3 November" or "Monday" into exact calendar days.
//
// This runs in code, before the model sees the message. Language models are unreliable at
// date arithmetic ("last Tuesday" from a Tuesday), and a wrong day means recalling the wrong
// conversation. chrono-node parses the phrase; the rules below make it point to the past,
// because a user asking about memory is always talking about the past.
import * as chrono from "chrono-node";
import { addDays, describeDay, localDay, makeDay, offsetMinutes } from "./time.js";

export interface DateRef {
  phrase: string; // what the user wrote, e.g. "last Tuesday"
  from: string;   // first day, "YYYY-MM-DD"
  to: string;     // last day, inclusive
  label: string;  // "Tuesday 3 November 2026"
}

export function resolveDateRefs(text: string, now: Date, timeZone: string): DateRef[] {
  const today = localDay(now, timeZone);
  const results = chrono.en.parse(text, { instant: now, timezone: offsetMinutes(now, timeZone) }, { forwardDate: false });
  const refs: DateRef[] = [];

  for (const r of results) {
    const phrase = r.text.trim();
    const lower = phrase.toLowerCase();
    let from = makeDay(r.start.get("year")!, r.start.get("month")!, r.start.get("day")!);
    let to = from;

    // "today" / "now" in "is it still true today?" is about the present, not about memory.
    if (from === today && !/earlier today|this morning|today i asked|ago/i.test(text)) continue;

    if (r.end) {
      to = makeDay(r.end.get("year")!, r.end.get("month")!, r.end.get("day")!);
    } else if (lower.includes("week")) {
      to = addDays(from, 3);       // "last week": a window around the day chrono picked
      from = addDays(from, -3);
    } else if (r.start.isCertain("month") && !r.start.isCertain("day") && !r.start.isCertain("weekday")) {
      const y = r.start.get("year")!;  // "in October": the whole month
      const m = r.start.get("month")!;
      from = makeDay(y, m, 1);
      to = addDays(m === 12 ? makeDay(y + 1, 1, 1) : makeDay(y, m + 1, 1), -1);
    }

    // Point to the past. "3 December" asked in November means last December;
    // a bare "Monday" that lands in the future means the Monday just gone.
    if (from > today) {
      if (r.start.isCertain("weekday") && !r.start.isCertain("day")) {
        from = addDays(from, -7);
        to = addDays(to, -7);
      } else if (!r.start.isCertain("year")) {
        from = `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`;
        to = `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
      } else {
        continue; // an explicit future date is not a memory lookup
      }
    }
    if (to > today) to = today;

    refs.push({ phrase, from, to, label: from === to ? describeDay(from) : `${describeDay(from)} to ${describeDay(to)}` });
  }
  return refs;
}
