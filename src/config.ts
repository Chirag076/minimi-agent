// config.ts: every setting in one place, read once at startup.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env"); // built into Node, no dotenv needed

export const config = {
  port: Number(process.env.PORT || 3000),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  // The user's time zone. Every "today", "last Tuesday" and stored date is read in this zone.
  timeZone: process.env.TIMEZONE || "Asia/Kolkata",
  dataFile: process.env.DATA_FILE || "data/memory.json",
  maxToolRounds: 4, // model -> search -> model ... at most this many times per answer
  searchResultsPerQuery: 5,
  searchCacheMinutes: 15,
  searchTimeoutMs: 12_000,
};

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!config.geminiApiKey) missing.push("GEMINI_API_KEY");
  if (!config.tavilyApiKey) missing.push("TAVILY_API_KEY");
  return missing;
}
