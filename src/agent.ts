// agent.ts: one user message in, a stream of events out.
//
//   1. recall      code resolves dates and finds related past exchanges (no model call)
//   2. model loop  the model streams text and may call web_search; all searches requested in
//                  one step run in parallel; repeat until it answers (capped at maxToolRounds)
//   3. remember    the answer is saved with its timestamp, the queries and the sources it cited
//
// Every step emits an event, so the UI can show "searching ..." and stream the answer as it
// is written instead of making the user stare at a spinner.
import type { ChatModel, Content, FunctionDeclaration, Part, ToolCall } from "./llm.js";
import type { MemoryStore, Source, StoredMessage } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";
import { recall } from "./recall.js";
import type { SearchArgs, SearchResult, WebSearch } from "./search.js";
import { describeMoment, type Clock } from "./time.js";

export type AgentEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "recall"; dates: { phrase: string; label: string; found: number }[]; items: { when: string; question: string }[] }
  | { type: "search"; query: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

export interface AgentDeps {
  model: ChatModel;
  search: WebSearch;
  store: MemoryStore;
  clock: Clock;
  timeZone: string;
  maxToolRounds: number;
  historyLimit?: number; // how many recent messages of this conversation go to the model
}

export const SEARCH_TOOL: FunctionDeclaration = {
  name: "web_search",
  description:
    "Search the web for current information. Returns numbered results with title, URL, publish date and a text snippet. " +
    "Call it several times in one step to search different things in parallel.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A specific search query, like a person would type into a search engine." },
      topic: { type: "string", enum: ["general", "news"], description: "Use news for recent events and announcements." },
      recency: {
        type: "string",
        enum: ["any", "day", "week", "month", "year"],
        description: "Only return pages from this recent period. Use for 'latest', 'since', or 'has it changed' questions.",
      },
    },
    required: ["query"],
  },
};

/** Gives every distinct URL one citation number for the whole answer, across all searches. */
export class SourceRegistry {
  private byUrl = new Map<string, Source>();

  add(results: SearchResult[]): string {
    if (results.length === 0) return "No results.";
    return results
      .map((r) => {
        let s = this.byUrl.get(r.url);
        if (!s) {
          s = { n: this.byUrl.size + 1, title: r.title, url: r.url, published: r.published ?? null };
          this.byUrl.set(r.url, s);
        }
        return `[${s.n}] ${r.title}\nURL: ${r.url}\nPublished: ${r.published ?? "unknown"}\n${r.content}`;
      })
      .join("\n\n");
  }

  /** The sources the answer actually cites, in citation order. */
  cited(answer: string): Source[] {
    const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return [...this.byUrl.values()].filter((s) => used.has(s.n)).sort((a, b) => a.n - b.n);
  }
}

function parseSearchArgs(args: Record<string, unknown>): SearchArgs | null {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return null;
  const topic = args.topic === "news" ? "news" : "general";
  const recency = ["day", "week", "month", "year"].includes(args.recency as string) ? (args.recency as SearchArgs["recency"]) : "any";
  return { query, topic, recency };
}

export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  private toContent(m: StoredMessage): Content {
    if (m.role === "user") {
      return { role: "user", parts: [{ text: `[${describeMoment(new Date(m.createdAt), this.deps.timeZone)}] ${m.text}` }] };
    }
    const sources = m.sources?.length ? `\n\nSources: ${m.sources.map((s) => `[${s.n}] ${s.title}, ${s.url}`).join("; ")}` : "";
    return { role: "model", parts: [{ text: m.text + sources }] };
  }

  async *chat(input: { conversationId?: string; message: string }): AsyncGenerator<AgentEvent> {
    const { model, search, store, clock, timeZone, maxToolRounds } = this.deps;
    const message = input.message.trim();
    const now = clock();
    const conversation =
      (input.conversationId && store.getConversation(input.conversationId)) || store.createConversation(message, now);
    yield { type: "conversation", conversationId: conversation.id };

    try {
      // 1. Recall, before this message is stored, so it cannot match itself.
      const remembered = recall(store, message, now, timeZone, conversation.id);
      if (remembered.byDate.length || remembered.related.length) {
        yield {
          type: "recall",
          dates: remembered.byDate.map((d) => ({ phrase: d.ref.phrase, label: d.ref.label, found: d.exchanges.length })),
          items: [...remembered.byDate.flatMap((d) => d.exchanges), ...remembered.related].map((e) => ({
            when: describeMoment(new Date(e.question.createdAt), timeZone),
            question: e.question.text,
          })),
        };
      }

      const history = store.messagesOf(conversation.id).slice(-(this.deps.historyLimit ?? 20));
      const userMsg = await store.addMessage({ conversationId: conversation.id, role: "user", text: message, createdAt: now.toISOString() });
      const contents: Content[] = [...history, userMsg].map((m) => this.toContent(m));
      const system = buildSystemPrompt(now, timeZone, remembered);

      // 2. Model loop.
      const registry = new SourceRegistry();
      const searches: string[] = [];
      let answer = "";
      for (let round = 0; round < maxToolRounds; round++) {
        const lastRound = round === maxToolRounds - 1; // no tools on the last round: it must answer
        let calls: ToolCall[] = [];
        let parts: Part[] = [];
        let firstTextThisRound = true;
        for await (const ev of model.stream({ system, contents, tools: lastRound ? [] : [SEARCH_TOOL] })) {
          if (ev.type === "text") {
            // Keep "Let me check..." from an earlier step apart from the answer that follows.
            const text = firstTextThisRound && answer && !/\s$/.test(answer) ? `\n\n${ev.text}` : ev.text;
            firstTextThisRound = false;
            answer += text;
            yield { type: "token", text };
          } else {
            calls = ev.calls;
            parts = ev.parts;
          }
        }
        if (calls.length === 0) break;

        contents.push({ role: "model", parts });
        const requests = calls.map((call) => ({ call, args: call.name === "web_search" ? parseSearchArgs(call.args) : null }));
        for (const r of requests) {
          if (r.args) {
            searches.push(r.args.query);
            yield { type: "search", query: r.args.query };
          }
        }
        // All searches from one step run at the same time.
        const responses = await Promise.all(
          requests.map(async ({ call, args }) => {
            let response: Record<string, unknown>;
            if (!args) response = { error: `Unknown tool or missing query: ${call.name}` };
            else {
              try {
                response = { results: registry.add(await search.search(args)) };
              } catch (e) {
                response = { error: `${(e as Error).message}. Tell the user search is unavailable if you cannot answer without it.` };
              }
            }
            return { functionResponse: { id: call.id, name: call.name, response } };
          }),
        );
        contents.push({ role: "user", parts: responses });
      }

      // 3. Remember.
      if (!answer.trim()) {
        answer = "Sorry, I couldn't put an answer together for that. Could you rephrase it?";
        yield { type: "token", text: answer };
      }
      const sources = registry.cited(answer);
      if (sources.length) yield { type: "sources", sources };
      const saved = await store.addMessage({
        conversationId: conversation.id,
        role: "assistant",
        text: answer.trim(),
        createdAt: clock().toISOString(),
        sources,
        searches,
      });
      yield { type: "done", messageId: saved.id };
    } catch (e) {
      console.error("chat failed:", e);
      yield { type: "error", message: "Something went wrong while answering. Please try again in a moment." };
    }
  }
}
