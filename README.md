# Chat agent with web search and memory

A chat agent with one tool, web search, that streams answers with citations and remembers what you asked and when. You can ask "What did I ask you on 3 November? Is that still correct today?" and it finds that conversation, searches again and tells you what changed.

How it works and why: **[DESIGN.md](DESIGN.md)**.

## Run it

Needs Node.js 22 or newer.

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# add GEMINI_API_KEY and TAVILY_API_KEY to .env
npm run dev
```

Open http://localhost:3000.

| Key | Where to get it |
|---|---|
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `TAVILY_API_KEY` | https://app.tavily.com (free tier: 1,000 searches a month) |

## Try the memory

```bash
npm run seed
```

This asks the agent three questions with the clock set back to 3 November, last Tuesday and Monday, so there is a real past to ask about. Then try:

- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"

Delete `data/memory.json` to start fresh.

## Tests

```bash
npm test           # 45 tests, no API keys needed
npm run typecheck
```

## Layout

```
src/
  main.ts      starts the server
  server.ts    HTTP routes and Server-Sent Events
  agent.ts     recall, the model and search loop, saving the answer
  dates.ts     "last Tuesday" -> an exact day
  recall.ts    finds the past exchanges a message is about
  prompt.ts    the system prompt
  memory.ts    timestamped conversations in a JSON file
  search.ts    the web_search tool (Tavily) and its cache
  llm.ts       the Gemini adapter
  time.ts      days in the user's time zone
  seed.ts      creates a past to test memory with
public/
  index.html   the chat page
test/          unit tests with a fake model and fake search
```
