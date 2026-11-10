// seed.ts: `npm run seed` gives the agent a past, so the memory questions can be tried today.
//
// It asks the real agent three questions with the clock set back to earlier days, so the
// stored answers, sources and timestamps are genuine, just dated in the past. Afterwards you
// can ask "What did I ask you on 3 November?" or "Last Tuesday I asked you about Postgres
// hosting. Has any pricing changed since then?". Delete data/memory.json to start over.
import { config } from "./config.js";
import { resolveDateRefs } from "./dates.js";
import { MemoryStore } from "./memory.js";
import { addDays, describeMoment, localDay, offsetMinutes } from "./time.js";
import { buildAgent, requireKeys } from "./wiring.js";

const SCENARIOS = [
  { when: "on 3 November", time: "11:05", question: "What's the latest LTS version of Node.js, and when does it reach end of life?" },
  { when: "last Tuesday", time: "15:40", question: "Which managed Postgres hosting is cheapest for a small side project: Neon, Supabase or Railway? Compare their entry paid plans." },
  { when: "Monday", time: "10:20", question: "We're a 20-person sales team. Shortlist 5 CRM tools for us with their per-seat pricing." },
];

/** A local time on the day a phrase like "last Tuesday" points to, as a real instant. */
function pastMoment(phrase: string, time: string, now: Date): Date {
  const tz = config.timeZone;
  const day = resolveDateRefs(phrase, now, tz)[0]?.from ?? addDays(localDay(now, tz), -7);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - offsetMinutes(new Date(guess), tz) * 60_000);
}

requireKeys();
const store = new MemoryStore(config.dataFile);
const now = new Date();

for (const s of SCENARIOS) {
  const at = pastMoment(s.when, s.time, now);
  if (at >= now) continue;
  console.log(`\n[${describeMoment(at, config.timeZone)}] ${s.question}`);
  const agent = buildAgent(store, () => at);
  for await (const ev of agent.chat({ message: s.question })) {
    if (ev.type === "search") console.log(`  searching: ${ev.query}`);
    if (ev.type === "token") process.stdout.write(ev.text);
    if (ev.type === "error") console.error(`  error: ${ev.message}`);
  }
  console.log();
}
console.log(`\nSeeded ${config.dataFile}. Start the app with npm run dev and ask about these days.`);
