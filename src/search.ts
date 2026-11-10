// search.ts: the agent's one tool, web search, backed by Tavily.
//
// Tavily is built for agents: one call returns titles, URLs, publish dates and cleaned page
// text, so the model can answer from the snippets without a second "open page" tool.
// Anything that implements `WebSearch` can replace it, which is how the tests run offline.

export interface SearchArgs {
  query: string;
  topic?: "general" | "news";
  recency?: "any" | "day" | "week" | "month" | "year";
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  published?: string | null;
}

export interface WebSearch {
  search(args: SearchArgs): Promise<SearchResult[]>;
}

export class SearchError extends Error {}

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string; published_date?: string | null }[];
  detail?: { error?: string };
}

export class TavilySearch implements WebSearch {
  constructor(
    private readonly apiKey: string,
    private readonly opts: { maxResults: number; timeoutMs: number; fetchImpl?: typeof fetch },
  ) {}

  async search(args: SearchArgs): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query: args.query,
      topic: args.topic ?? "general",
      search_depth: "basic",          // 1 credit and fast; snippets are enough for most answers
      max_results: this.opts.maxResults,
      include_published_date: true,   // lets the model judge how fresh each source is
      include_answer: false,          // the model writes the answer, not the search engine
    };
    if (args.recency && args.recency !== "any") body.time_range = args.recency;

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new SearchError(`search request failed: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as TavilyResponse;
    if (!res.ok) {
      const why = res.status === 429 || res.status === 432 ? "rate or plan limit reached" : data.detail?.error ?? "error";
      throw new SearchError(`search failed (${res.status}): ${why}`);
    }
    return (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title?.trim() || r.url!,
        url: r.url!,
        content: (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 900),
        published: r.published_date ?? null,
      }));
  }
}

/**
 * Remembers results for a few minutes. Follow-ups ("and the second one?") and the
 * re-checks behind "is that still true?" often repeat a query; a cache hit costs nothing.
 */
export class CachedSearch implements WebSearch {
  private cache = new Map<string, { at: number; results: SearchResult[] }>();

  constructor(private readonly inner: WebSearch, private readonly ttlMs: number, private readonly now = () => Date.now()) {}

  async search(args: SearchArgs): Promise<SearchResult[]> {
    const key = JSON.stringify([args.query.trim().toLowerCase(), args.topic ?? "general", args.recency ?? "any"]);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.results;
    const results = await this.inner.search(args);
    this.cache.set(key, { at: this.now(), results });
    return results;
  }
}
