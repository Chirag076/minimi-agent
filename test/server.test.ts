import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.js";
import { FakeSearch, ScriptedModel, makeAgent, result } from "./helpers.js";

const model = new ScriptedModel([
  { calls: [{ id: "a", name: "web_search", args: { query: "node lts" } }] },
  { text: "Node 24 is the current LTS [1]." },
]);
const { agent, store } = makeAgent(model, new FakeSearch({ "node lts": [result(1)] }));
const server = createApp(agent, store);
let base = "";

before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("serves the chat page", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Chat Agent<\/title>/);
});

test("POST /api/chat streams the agent's events as Server-Sent Events", async () => {
  const res = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ message: "Node LTS?" }) });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const events = (await res.text()).split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
  const order = events.map((e) => e.type).filter((t, i, all) => t !== all[i - 1]);
  assert.deepEqual(order, ["conversation", "search", "token", "sources", "done"]);
});

test("the conversation is listed and can be reopened with its sources", async () => {
  const list = await fetch(`${base}/api/conversations`).then((r) => r.json());
  assert.equal(list.length, 1);
  const convo = await fetch(`${base}/api/conversations/${list[0].id}`).then((r) => r.json());
  assert.deepEqual(convo.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
  assert.equal(convo.messages[1].sources[0].url, "https://example.com/1");
});

test("rejects empty and oversized messages", async () => {
  const empty = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ message: "  " }) });
  assert.equal(empty.status, 400);
  const huge = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ message: "x".repeat(5000) }) });
  assert.equal(huge.status, 400);
});

test("unknown routes and conversations are 404s", async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/conversations/does-not-exist`)).status, 404);
});
