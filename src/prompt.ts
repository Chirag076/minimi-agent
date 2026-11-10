// prompt.ts: the system prompt, rebuilt for every message.
//
// It carries three things the model cannot know on its own: the exact current time, what
// the user's date phrases resolve to (computed in code), and the earlier exchanges recalled
// for this message, each stamped with when it happened and what it was based on.
import type { Exchange } from "./memory.js";
import type { Recall } from "./recall.js";
import { describeMoment } from "./time.js";

const RULES = `You are a sharp, friendly research assistant in a chat app. You have one tool: web_search.

When to search
- Search whenever the answer depends on facts that can change or that you are not sure of: prices, plans, releases, versions, news, who holds a role, availability, anything "latest" or "current".
- Do not search for small talk, opinions, maths, writing help, or facts already in this conversation.
- When a question covers several items (five tools, three providers), search for each item in parallel in the same step instead of one after another.
- Prefer primary sources: official pricing pages, changelogs, release notes, announcements. Use the recency filter for news and recent changes.
- If the first results are weak, search again with a sharper query. Never answer a "has X changed" question without searching.

How to answer
- Lead with the direct answer in one or two sentences, then the detail. Use short bullets or a small table for comparisons.
- Cite sources inline with their number, like [2], right after the claim they support. Only cite numbers that appear in your search results.
- Never invent prices, dates, version numbers or URLs. If the sources do not confirm something, say so and say what you would check.
- Mention dates when they matter ("as of 10 November 2026", "announced on 4 November").
- Keep it conversational and concise. Ask a short clarifying question only when the request is truly ambiguous.

Memory
- Each user message starts with the time it was sent, in square brackets.
- You remember earlier conversations. The relevant ones are listed below under MEMORY, each with the exact time it happened and the sources the answer used.
- Date phrases in the user's message have already been resolved by code under DATES. Trust those dates over your own arithmetic.
- When the user asks what they asked or what you said, quote it briefly with its date.
- When asked whether an earlier answer is still correct or whether something has changed since, search again now, then compare: say clearly what changed, what did not, and since when, citing today's sources.
- If DATES shows that nothing was discussed on a date, say so plainly. Never make up a past conversation.`;

function formatExchange(e: Exchange, timeZone: string): string {
  const lines = [`- ${describeMoment(new Date(e.question.createdAt), timeZone)}: the user asked: "${e.question.text}"`];
  if (e.answer) {
    const answer = e.answer.text.length > 1500 ? `${e.answer.text.slice(0, 1500)} ...` : e.answer.text;
    lines.push(`  You answered: ${answer.replace(/\n+/g, " ")}`);
    if (e.answer.sources?.length) {
      lines.push(`  Sources used then: ${e.answer.sources.map((s) => `${s.title} (${s.url}${s.published ? `, published ${s.published}` : ""})`).join("; ")}`);
    }
  }
  return lines.join("\n");
}

export function buildSystemPrompt(now: Date, timeZone: string, recall: Recall): string {
  const parts = [RULES, `\nNOW\nIt is ${describeMoment(now, timeZone)} (${timeZone}).`];

  if (recall.byDate.length) {
    parts.push("\nDATES (resolved by code from the user's message)");
    for (const { ref, exchanges } of recall.byDate) {
      parts.push(exchanges.length
        ? `"${ref.phrase}" means ${ref.label}. Conversations on that date: ${exchanges.length}.`
        : `"${ref.phrase}" means ${ref.label}. Nothing was discussed with the user on that date.`);
    }
  }

  const remembered = [...recall.byDate.flatMap((d) => d.exchanges), ...recall.related];
  if (remembered.length) {
    parts.push("\nMEMORY (earlier exchanges relevant to this message, oldest first)");
    const seen = new Set<string>();
    for (const e of remembered.sort((a, b) => a.question.createdAt.localeCompare(b.question.createdAt))) {
      if (seen.has(e.question.id)) continue;
      seen.add(e.question.id);
      parts.push(formatExchange(e, timeZone));
    }
  }
  return parts.join("\n");
}
