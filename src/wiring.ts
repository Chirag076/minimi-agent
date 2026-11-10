// wiring.ts: builds the real agent from config. Used by the server and the seed script.
import { Agent } from "./agent.js";
import { config, missingKeys } from "./config.js";
import { GeminiModel } from "./llm.js";
import type { MemoryStore } from "./memory.js";
import { CachedSearch, TavilySearch } from "./search.js";
import { systemClock, type Clock } from "./time.js";

export function buildAgent(store: MemoryStore, clock: Clock = systemClock): Agent {
  return new Agent({
    model: new GeminiModel(config.geminiApiKey, config.model),
    search: new CachedSearch(
      new TavilySearch(config.tavilyApiKey, { maxResults: config.searchResultsPerQuery, timeoutMs: config.searchTimeoutMs }),
      config.searchCacheMinutes * 60_000,
    ),
    store,
    clock,
    timeZone: config.timeZone,
    maxToolRounds: config.maxToolRounds,
  });
}

export function requireKeys(): void {
  const missing = missingKeys();
  if (missing.length) {
    console.error(`Missing ${missing.join(" and ")}. Copy .env.example to .env and fill them in.`);
    process.exit(1);
  }
}
