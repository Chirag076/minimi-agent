// Runs the real Gemini adapter against a fake HTTP layer, so the request it builds and the
// way it reads Gemini's streamed reply are tested without an API key.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { SEARCH_TOOL } from "../src/agent.js";
import { GeminiModel, type ModelEvent } from "../src/llm.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const chunk = (parts: unknown[]) => ({ candidates: [{ content: { role: "model", parts } }] });

async function run(model: GeminiModel): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of model.stream({ system: "be brief", contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [SEARCH_TOOL] })) out.push(ev);
  return out;
}

test("sends the system prompt and the search tool, streams text, and returns tool calls with their signatures", async () => {
  const requests: { url: string; body: Record<string, any> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(init.body as string) });
    return sse([
      chunk([{ text: "Let me " }]),
      chunk([{ text: "check." }, { thought: true, text: "hidden reasoning" }]),
      chunk([{ functionCall: { name: "web_search", args: { query: "node lts" } }, thoughtSignature: "c2ln" }]),
    ]);
  }) as typeof fetch;

  const events = await run(new GeminiModel("test-key", "gemini-test"));
  assert.match(requests[0]!.url, /models\/gemini-test:streamGenerateContent/);
  assert.equal(requests[0]!.body.systemInstruction.parts[0].text, "be brief");
  assert.equal(requests[0]!.body.tools[0].functionDeclarations[0].name, "web_search");

  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text), ["Let me ", "check."]);
  const done = events.at(-1) as Extract<ModelEvent, { type: "done" }>;
  assert.deepEqual(done.calls, [{ id: undefined, name: "web_search", args: { query: "node lts" } }]);
  assert.ok(done.parts.some((p) => p.thoughtSignature === "c2ln"), "signature kept so it can be sent back");
});

test("retries a busy model (503) before anything was shown", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }), { status: 503 });
    return sse([chunk([{ text: "ok" }])]);
  }) as typeof fetch;
  const events = await run(new GeminiModel("k", "m", [0, 0], async () => {}));
  assert.equal(calls, 2);
  assert.equal((events[0] as { text: string }).text, "ok");
});

test("does not retry a real error such as a bad request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" } }), { status: 400 });
  }) as typeof fetch;
  await assert.rejects(run(new GeminiModel("k", "m", [0, 0], async () => {})));
  assert.equal(calls, 1);
});
