# DESIGN

A chat agent with one tool, web search, that answers fast, gets things right, and remembers what you asked and when.

The hard part of this brief is not search. It is questions like:

- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

Those need three things most chat agents don't have: exact memory of *when* something was said, a reliable way to turn "last Tuesday" into a date, and a habit of re-checking an old answer instead of repeating it. Most of the design follows from that.

## How one message flows

```
user message
   │
   ▼
1. RECALL (code, no model call, ~1 ms)
   dates.ts   "last Tuesday" ─▶ 2026-11-03        (chrono-node + past-pointing rules)
   recall.ts  exchanges from that day             (by timestamp, in the user's time zone)
              + related exchanges from any day    (rare shared words, e.g. "postgres")
   │
   ▼
2. PROMPT (prompt.ts)
   rules + exact current time
   + DATES:  "last Tuesday" means Tuesday 3 November 2026. Conversations on that date: 1.
   + MEMORY: each recalled question, the answer given, when, and the sources it used
   + this conversation's recent messages, each stamped with when it was sent
   │
   ▼
3. MODEL LOOP (agent.ts)
   model streams text ─────────────────────────────▶ browser (Server-Sent Events)
   model asks for web_search ×N ─▶ all N run in parallel ─▶ results, numbered [1] [2] ...
   repeat, at most 4 rounds; the last round has no tools, so it must answer
   │
   ▼
4. REMEMBER (memory.ts)
   save the answer with its timestamp, the queries it ran and the sources it cited
```

## Decisions, and why

### 1. Memory recall happens in code, before the model runs, not as a tool

The brief says the agent has one tool: web search. I kept it that way and did recall up front instead of adding a `search_memory` tool:

- **Faster.** A memory tool costs a whole model round trip before the real work starts. Recall in code takes about a millisecond.
- **Deterministic and testable.** Which past exchanges a message pulls in is a pure function of the message, the clock and the store, so it has unit tests.
- **The model doesn't have to remember to look.** A model with a memory tool sometimes forgets to use it and answers "I don't have access to previous conversations".

The trade-off is that recall can't take several steps ("find what I asked about X, then what I asked the day after"). For the questions in the brief, one pass is enough.

### 2. Dates are resolved in code, and the result is stated in the prompt

Language models are unreliable at date arithmetic ("last Tuesday", asked on a Tuesday). A wrong day means recalling the wrong conversation, or confidently describing one that never happened.

`dates.ts` uses [chrono-node](https://github.com/wanasit/chrono) to parse the phrase, then applies rules that make it point to the past, because a user asking about memory is always talking about the past:

| Phrase (asked Tue 10 Nov 2026) | Resolves to | Rule |
|---|---|---|
| "on 3 November" | 3 Nov 2026 | explicit date |
| "last Tuesday" | 3 Nov 2026 | a week back, not today |
| "Monday", "on Wednesday" | 9 Nov, 4 Nov | a bare weekday means the most recent one |
| "3 December" | 3 Dec 2025 | a future date with no year means last year |
| "in October" | 1 to 31 Oct | a month means the whole month |
| "last week" | 31 Oct to 6 Nov | a window, capped at today |
| "is it still true today?" | nothing | "today" here is about the present, not memory |

Days are compared in the user's time zone (`TIMEZONE`, default `Asia/Kolkata`). A question at 11:30 pm and one at 12:30 am are on different days for the user even if the server runs in UTC.

The prompt then says it plainly: `"last Tuesday" means Tuesday 3 November 2026. Conversations on that date: 1.` If nothing happened that day it says `Nothing was discussed with the user on that date`, which stops the model from inventing a past conversation to be helpful.

### 3. Every message is timestamped, and every answer is stored with its evidence

Each stored answer keeps its timestamp, the search queries it ran and the sources it cited. That is what makes "is your answer still correct today?" answerable properly: the model sees what it said, when, and what that was based on, then searches again and compares. Without the old sources it could only compare against its own words.

Each user message is also sent to the model with its time (`[Tue 3 Nov 2026, 15:40] ...`), so within one conversation it can tell "earlier today" from "last week".

### 4. "Has it changed?" always means search again

The rules tell the model never to answer a "has X changed" or "is it still correct" question without searching, and to answer in a fixed shape: what changed, what didn't, and since when, citing today's sources. A memory-only answer would just repeat a possibly stale claim.

### 5. Search: fast and good enough, then refine

- **Tavily** returns titles, URLs, publish dates and cleaned page text in one call, so the model can answer from snippets without a second "open page" tool (the brief allows one tool).
- `search_depth: basic` and 5 results per query: 1 credit and fast. The model can search again with a sharper query when the results are weak.
- **Publish dates** are included so the model can judge freshness and quote dates.
- The tool takes optional `topic: news` and `recency: day | week | month | year`, which the model uses for "latest" and "since" questions.
- **Parallel calls.** "Has any of these 5 CRM tools changed pricing?" becomes 5 searches in one step, run at the same time with `Promise.all`, instead of 5 rounds. The prompt asks for this, and a test proves the searches overlap.
- **A 15-minute cache.** Follow-ups and re-checks often repeat a query, and a cache hit is free and instant.
- **Failures are information.** A failed or rate-limited search returns an error to the model, which then says it couldn't verify something instead of guessing.

### 6. Citations are numbered once per answer, and only cited sources are shown

Results from all searches in one answer share one numbering, so `[3]` always means the same page even when two searches return it. After the answer, only the sources it actually cites are shown and stored. That keeps the source list honest and short.

### 7. Streaming, with visible progress

The server sends Server-Sent Events: `recall`, `search`, `token`, `sources`, `done`. The page shows "Remembered Tuesday 3 November 2026" and "Searching: Neon pricing · Supabase pricing" as they happen, then streams the answer. The total time is the same, but the wait never feels dead, which is a large part of being "good to talk to".

### 8. Bounded loop

At most 4 model steps per answer. The last step is sent without tools, so the model has to answer with what it has rather than search forever. Only the last 20 messages of a conversation and the first 1,500 characters of each recalled answer go into the prompt, which keeps latency and cost flat as memory grows.

### 9. The model sits behind a small interface

`ChatModel` is just "stream text, then report tool calls". Gemini implements it in `llm.ts`; tests use a scripted fake. Details that matter:

- **Default `gemini-3.5-flash-lite`,** chosen for speed. Any Gemini model with function calling works through `GEMINI_MODEL`.
- **Thought signatures are kept.** Gemini returns hidden signatures with tool calls that must be sent back unchanged, or the next call fails. The adapter keeps every part it received and echoes it back.
- **Retries** on 429 and 5xx with short backoff, but only before any text has reached the user, so a retry never shows the user a repeated sentence.

### 10. Storage is a JSON file, on purpose

`npm install && npm run dev` must just work, so there's no database to install and no native module to compile. Writes are serialised and go to a temp file that is then renamed, so a crash can't leave half a file. For one user and thousands of messages this is plenty. For many users I'd move to Postgres: a `messages` table indexed by `(user_id, created_at)` for date recall, and `pgvector` for topic recall.

### 11. No web framework

Four routes (the page, list conversations, read one, chat) don't need Express. Plain `node:http` keeps the dependency list to the model SDK and the date parser.

## Testing

`npm test` runs 45 tests with no API keys:

- **dates:** every phrase in the table above, including the time-zone edge at midnight
- **memory and recall:** persistence across restarts, question and answer pairing, date recall in the user's zone, topic recall, the current conversation skipped
- **search:** the Tavily request shape, recency mapping, result clean-up, rate-limit errors, cache hits and expiry
- **agent:** small talk without searching, parallel searches, citation numbering, failed searches, the loop cap, recalled memory and "nothing on that date" in the prompt, timestamps on history, model failures
- **Gemini adapter:** run against a fake HTTP layer: the request it builds, streamed text, hidden thoughts filtered, tool calls with signatures kept, retry on 503, no retry on 400
- **server:** the page, the event stream end to end, reopening a conversation, input limits, 404s

`npm run typecheck` runs the TypeScript compiler in strict mode.

## Trying the memory questions today

Memory questions need a past. `npm run seed` asks the real agent three questions with the clock set back to 3 November, last Tuesday and Monday, so the stored answers, sources and timestamps are real, just dated earlier. Then ask:

- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"

Delete `data/memory.json` to start over.

## Limits, and what I'd do next

- **Topic recall is keyword based.** It finds "Postgres hosting" from "postgres", but not "my database question". Next: embeddings alongside the keywords (hybrid search), still computed before the model runs.
- **Snippets can miss details,** especially on pricing pages rendered with JavaScript. Next: fetch the top page's full text for pricing and changelog questions, inside the search tool so the agent still has one tool.
- **A scored eval set.** The unit tests check the plumbing. Next: dataset-style conversations scored on correct recall date, whether it re-searched, and citation coverage, run in CI like the tests.
- **One user, no auth.** Fine for the challenge; a real product needs a user id on every row.
- **Long conversations** are cut to the last 20 messages. Next: a running summary of older turns.
