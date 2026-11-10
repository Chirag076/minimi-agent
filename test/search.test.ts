import assert from "node:assert/strict";
import { test } from "node:test";
import { CachedSearch, SearchError, TavilySearch, type WebSearch } from "../src/search.js";

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("sends a Tavily request with the key, query and recency filter", async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const s = new TavilySearch("tvly-test", { maxResults: 5, timeoutMs: 1000, fetchImpl: fakeFetch(200, { results: [] }, seen) });
  await s.search({ query: "neon pricing", topic: "news", recency: "week" });
  assert.equal(seen[0]!.url, "https://api.tavily.com/search");
  assert.equal((seen[0]!.init!.headers as Record<string, string>).Authorization, "Bearer tvly-test");
  const body = JSON.parse(seen[0]!.init!.body as string);
  assert.equal(body.query, "neon pricing");
  assert.equal(body.topic, "news");
  assert.equal(body.time_range, "week");
  assert.equal(body.max_results, 5);
  assert.equal(body.include_published_date, true);
});

test("'any' recency sends no time filter", async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const s = new TavilySearch("k", { maxResults: 5, timeoutMs: 1000, fetchImpl: fakeFetch(200, { results: [] }, seen) });
  await s.search({ query: "q", recency: "any" });
  assert.equal(JSON.parse(seen[0]!.init!.body as string).time_range, undefined);
});

test("normalises results and drops ones without a URL", async () => {
  const s = new TavilySearch("k", {
    maxResults: 5, timeoutMs: 1000,
    fetchImpl: fakeFetch(200, { results: [
      { title: " Neon pricing ", url: "https://neon.tech/pricing", content: "Launch  plan\n$19", published_date: "2026-11-01" },
      { title: "broken", content: "no url" },
    ] }),
  });
  assert.deepEqual(await s.search({ query: "q" }), [
    { title: "Neon pricing", url: "https://neon.tech/pricing", content: "Launch plan $19", published: "2026-11-01" },
  ]);
});

test("a rate limit becomes a readable SearchError", async () => {
  const s = new TavilySearch("k", { maxResults: 5, timeoutMs: 1000, fetchImpl: fakeFetch(429, { detail: { error: "slow down" } }) });
  await assert.rejects(s.search({ query: "q" }), (e: Error) => e instanceof SearchError && /rate or plan limit/.test(e.message));
});

test("the cache answers repeat queries without searching again, until it expires", async () => {
  let calls = 0;
  const inner: WebSearch = { search: async () => { calls++; return []; } };
  let now = 0;
  const cached = new CachedSearch(inner, 60_000, () => now);
  await cached.search({ query: "Neon pricing" });
  await cached.search({ query: "  neon PRICING " });
  assert.equal(calls, 1);
  await cached.search({ query: "neon pricing", recency: "week" }); // different filter, different key
  assert.equal(calls, 2);
  now = 61_000;
  await cached.search({ query: "neon pricing" });
  assert.equal(calls, 3);
});
