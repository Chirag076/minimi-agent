// Test doubles: a scripted model, a fake search engine and a throwaway memory file.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.js";
import type { ChatModel, ModelEvent, ModelRequest, Part, ToolCall } from "../src/llm.js";
import { MemoryStore } from "../src/memory.js";
import type { SearchArgs, SearchResult, WebSearch } from "../src/search.js";

export const TZ = "Asia/Kolkata";
/** Tuesday 10 November 2026, 10:00 in India. */
export const NOW = new Date("2026-11-10T10:00:00+05:30");

export type Step = { text?: string; calls?: ToolCall[] } | Error;

/** Plays back one step per model call and records every request it receives. */
export class ScriptedModel implements ChatModel {
  requests: ModelRequest[] = [];
  constructor(private readonly steps: Step[]) {}

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift() ?? { text: "out of script" };
    if (step instanceof Error) throw step;
    const parts: Part[] = [];
    if (step.text) {
      for (const word of step.text.split(/(?<= )/)) yield { type: "text", text: word }; // stream word by word
      parts.push({ text: step.text });
    }
    for (const c of step.calls ?? []) parts.push({ functionCall: { id: c.id, name: c.name, args: c.args } });
    yield { type: "done", parts, calls: step.calls ?? [] };
  }
}

/** Returns canned results per query, and tracks how many searches ran at the same time. */
export class FakeSearch implements WebSearch {
  calls: SearchArgs[] = [];
  active = 0;
  maxActive = 0;
  constructor(private readonly results: Record<string, SearchResult[] | Error> = {}, private readonly delayMs = 20) {}

  async search(args: SearchArgs): Promise<SearchResult[]> {
    this.calls.push(args);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.active--;
    const r = this.results[args.query];
    if (r instanceof Error) throw r;
    return r ?? [];
  }
}

export function result(n: number): SearchResult {
  return { title: `Page ${n}`, url: `https://example.com/${n}`, content: `Snippet ${n}`, published: "2026-11-09" };
}

export function tempStore(): MemoryStore {
  return new MemoryStore(join(mkdtempSync(join(tmpdir(), "minimi-")), "memory.json"));
}

export function makeAgent(model: ChatModel, search: WebSearch = new FakeSearch(), store = tempStore(), now = NOW) {
  const agent = new Agent({ model, search, store, clock: () => now, timeZone: TZ, maxToolRounds: 4 });
  return { agent, store };
}

export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

/** Adds a past question and answer to the store, as if it happened at `at`. */
export async function remember(store: MemoryStore, at: string, question: string, answer: string) {
  const c = store.createConversation(question, new Date(at));
  await store.addMessage({ conversationId: c.id, role: "user", text: question, createdAt: new Date(at).toISOString() });
  await store.addMessage({
    conversationId: c.id, role: "assistant", text: answer, createdAt: new Date(at).toISOString(),
    sources: [{ n: 1, title: "Old source", url: "https://example.com/old", published: null }],
  });
  return c;
}
