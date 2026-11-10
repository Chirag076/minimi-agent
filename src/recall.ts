// recall.ts: finds the earlier exchanges a new message is about.
//
// Two signals, both computed in code before the model runs:
//   1. Dates: "what did I ask on 3 November" -> every exchange from that day.
//   2. Topic: "has Postgres hosting pricing changed?" -> past exchanges sharing rare words.
// Doing this up front instead of giving the model a "memory" tool keeps the agent to one tool
// (as the brief asks), saves a model round trip, and makes recall deterministic and testable.
import { resolveDateRefs, type DateRef } from "./dates.js";
import type { Exchange, MemoryStore } from "./memory.js";
import { localDay } from "./time.js";

export interface Recall {
  dateRefs: DateRef[];
  /** For each date the user mentioned: what happened that day (possibly nothing). */
  byDate: { ref: DateRef; exchanges: Exchange[] }[];
  /** Topic matches from any time, excluding the current conversation (already in context). */
  related: Exchange[];
}

const STOPWORDS = new Set(
  ("a an the and or but if then so of to in on at for from by with about into over is are was were be been " +
    "do does did have has had i you we they he she it me my our your their this that these those what which who " +
    "when where why how can could would should will just any some all there here than also not no yes still now " +
    "today ask asked tell told said say answer question since last ago changed change new any monday tuesday " +
    "wednesday thursday friday saturday sunday january february march april may june july august september " +
    "october november december week month year day yesterday please hey hi thanks").split(" "),
);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9.+#]+/)) {
    let t = raw.replace(/^\.+|\.+$/g, "");
    if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1); // tools -> tool
    out.add(t);
  }
  return out;
}

/** Shared words, weighted so rare words ("postgres") count more than common ones ("pricing"). */
function score(query: Set<string>, ex: Exchange, docFreq: Map<string, number>, total: number): number {
  const text = `${ex.question.text} ${ex.answer?.text.slice(0, 600) ?? ""}`;
  let s = 0;
  // Each shared word counts at least 1, rarer words count more.
  for (const t of tokens(text)) if (query.has(t)) s += Math.max(1, Math.log(1 + total / (docFreq.get(t) ?? 1)));
  return s;
}

export function recall(store: MemoryStore, text: string, now: Date, timeZone: string, currentConversationId?: string): Recall {
  const all = store.exchanges().filter((e) => e.question.createdAt < now.toISOString());
  const dateRefs = resolveDateRefs(text, now, timeZone);

  const byDate = dateRefs.map((ref) => ({
    ref,
    exchanges: all
      .filter((e) => {
        const day = localDay(new Date(e.question.createdAt), timeZone);
        return day >= ref.from && day <= ref.to;
      })
      .slice(-8),
  }));

  const query = tokens(text);
  const docFreq = new Map<string, number>();
  for (const e of all) for (const t of tokens(e.question.text)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const alreadyShown = new Set(byDate.flatMap((d) => d.exchanges.map((e) => e.question.id)));

  const related = query.size === 0 ? [] : all
    .filter((e) => e.question.conversationId !== currentConversationId && !alreadyShown.has(e.question.id))
    .map((e) => ({ e, s: score(query, e, docFreq, all.length) }))
    .filter((x) => x.s >= 2) // two shared words, or one word rare across all past questions
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.e);

  return { dateRefs, byDate, related };
}
