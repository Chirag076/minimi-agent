import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent.js";
import { SearchError } from "../src/search.js";
import { FakeSearch, NOW, ScriptedModel, collect, makeAgent, remember, result, tempStore } from "./helpers.js";

const types = (events: AgentEvent[]) => [...new Set(events.map((e) => e.type))];
const text = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");

test("small talk is answered directly, without searching", async () => {
  const search = new FakeSearch();
  const { agent, store } = makeAgent(new ScriptedModel([{ text: "Hi! What can I look up for you?" }]), search);
  const events = await collect(agent.chat({ message: "hey" }));
  assert.deepEqual(types(events), ["conversation", "token", "done"]);
  assert.equal(text(events), "Hi! What can I look up for you?");
  assert.equal(search.calls.length, 0);
  assert.deepEqual(store.exchanges().map((e) => [e.question.text, e.answer?.text]), [["hey", "Hi! What can I look up for you?"]]);
});

test("searches requested in one step run in parallel, and only cited sources are kept", async () => {
  const search = new FakeSearch({ "neon pricing": [result(1), result(2)], "supabase pricing": [result(2), result(3)] }, 50);
  const model = new ScriptedModel([
    { calls: [
      { id: "a", name: "web_search", args: { query: "neon pricing", recency: "month" } },
      { id: "b", name: "web_search", args: { query: "supabase pricing" } },
    ] },
    { text: "Neon starts at $19 [1] and Supabase at $25 [3]." },
  ]);
  const { agent, store } = makeAgent(model, search);
  const events = await collect(agent.chat({ message: "Neon vs Supabase pricing?" }));

  assert.equal(search.maxActive, 2, "both searches were in flight at once");
  assert.deepEqual(events.filter((e) => e.type === "search").map((e) => (e as { query: string }).query), ["neon pricing", "supabase pricing"]);
  const sources = events.find((e) => e.type === "sources") as Extract<AgentEvent, { type: "sources" }>;
  // Page 2 came back from both searches but has one number; it was not cited, so it is dropped.
  assert.deepEqual(sources.sources.map((s) => [s.n, s.url]), [[1, "https://example.com/1"], [3, "https://example.com/3"]]);

  // The model's second call received its own tool calls and one result per search.
  const second = model.requests[1]!.contents;
  assert.ok(second.at(-2)!.parts!.every((p) => p.functionCall));
  assert.equal(second.at(-1)!.parts!.length, 2);
  assert.match(JSON.stringify(second.at(-1)), /\[1\] Page 1/);

  const saved = store.exchanges()[0]!.answer!;
  assert.deepEqual(saved.searches, ["neon pricing", "supabase pricing"]);
  assert.equal(saved.sources!.length, 2);
});

test("a failed search is reported to the model, which can still answer", async () => {
  const search = new FakeSearch({ "q": new SearchError("search failed (500): error") });
  const model = new ScriptedModel([
    { calls: [{ id: "a", name: "web_search", args: { query: "q" } }] },
    { text: "Search is down right now, so I can't confirm that." },
  ]);
  const { agent } = makeAgent(model, search);
  const events = await collect(agent.chat({ message: "latest news?" }));
  assert.match(JSON.stringify(model.requests[1]!.contents.at(-1)), /search failed \(500\)/);
  assert.equal(text(events), "Search is down right now, so I can't confirm that.");
});

test("the loop is capped: on the last round the model gets no tools and must answer", async () => {
  const loop = { calls: [{ id: "x", name: "web_search", args: { query: "again" } }] };
  const model = new ScriptedModel([loop, loop, loop, { text: "Here's what I found." }]);
  const { agent } = makeAgent(model);
  await collect(agent.chat({ message: "dig deep" }));
  assert.equal(model.requests.length, 4);
  assert.equal(model.requests[2]!.tools.length, 1);
  assert.equal(model.requests[3]!.tools.length, 0);
});

test("text before a search is kept apart from the answer after it", async () => {
  const model = new ScriptedModel([
    { text: "Let me check.", calls: [{ id: "a", name: "web_search", args: { query: "q" } }] },
    { text: "It's 42." },
  ]);
  const { agent } = makeAgent(model);
  assert.equal(text(await collect(agent.chat({ message: "?" }))), "Let me check.\n\nIt's 42.");
});

test("asking about a past date brings that day's exchange, with its timestamp and sources, into the prompt", async () => {
  const store = tempStore();
  await remember(store, "2026-11-03T15:40:00+05:30", "Which Postgres hosting is cheapest?", "Neon's Launch plan at $19 a month.");
  const model = new ScriptedModel([{ text: "On 3 November you asked which Postgres hosting is cheapest." }]);
  const { agent } = makeAgent(model, new FakeSearch(), store);
  const events = await collect(agent.chat({ message: "What did I ask you on 3 November?" }));

  const r = events.find((e) => e.type === "recall") as Extract<AgentEvent, { type: "recall" }>;
  assert.deepEqual(r.dates, [{ phrase: "on 3 November", label: "Tuesday 3 November 2026", found: 1 }]);
  const system = model.requests[0]!.system;
  assert.match(system, /"on 3 November" means Tuesday 3 November 2026/);
  assert.match(system, /Tue 3 Nov 2026, 15:40: the user asked: "Which Postgres hosting is cheapest\?"/);
  assert.match(system, /Neon's Launch plan at \$19/);
  assert.match(system, /Sources used then: Old source/);
});

test("an empty day is stated in the prompt so the model doesn't invent a conversation", async () => {
  const model = new ScriptedModel([{ text: "We didn't talk on that day." }]);
  const { agent } = makeAgent(model);
  await collect(agent.chat({ message: "What did I ask you on 1 November?" }));
  assert.match(model.requests[0]!.system, /Nothing was discussed with the user on that date/);
});

test("the prompt always carries the current time", async () => {
  const model = new ScriptedModel([{ text: "ok" }]);
  const { agent } = makeAgent(model);
  await collect(agent.chat({ message: "what time is it" }));
  assert.match(model.requests[0]!.system, /It is Tue 10 Nov 2026, 10:00 \(Asia\/Kolkata\)/);
});

test("follow-ups see the earlier messages of the conversation, each with when it was sent", async () => {
  const model = new ScriptedModel([{ text: "Neon is $19 [1]." }, { text: "Yes." }]);
  const { agent } = makeAgent(model);
  const first = await collect(agent.chat({ message: "Neon price?" }));
  const conversationId = (first[0] as { conversationId: string }).conversationId;
  await collect(agent.chat({ conversationId, message: "Is that per month?" }));
  const contents = model.requests[1]!.contents;
  assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
  assert.match(contents[0]!.parts![0]!.text!, /^\[Tue 10 Nov 2026, 10:00\] Neon price\?/);
});

test("a model failure ends with a friendly error, and the question is still remembered", async () => {
  const { agent, store } = makeAgent(new ScriptedModel([new Error("boom")]));
  const events = await collect(agent.chat({ message: "hello" }));
  assert.equal(events.at(-1)!.type, "error");
  assert.equal(store.exchanges()[0]!.question.text, "hello");
  assert.equal(store.exchanges()[0]!.answer, undefined);
});

test("a stored answer gets the time it finished, the question the time it was asked", async () => {
  const { agent, store } = makeAgent(new ScriptedModel([{ text: "ok" }]));
  await collect(agent.chat({ message: "hi" }));
  const ex = store.exchanges()[0]!;
  assert.equal(ex.question.createdAt, NOW.toISOString());
  assert.ok(ex.answer!.createdAt >= ex.question.createdAt);
});
