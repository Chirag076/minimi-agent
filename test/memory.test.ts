import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { MemoryStore } from "../src/memory.js";
import { recall, tokens } from "../src/recall.js";
import { NOW, TZ, remember, tempStore } from "./helpers.js";

test("memory survives a restart", async () => {
  const store = tempStore();
  await remember(store, "2026-11-03T11:00:00+05:30", "Node LTS?", "Node 24.");
  const file = (store as unknown as { file: string }).file;
  assert.ok(existsSync(file));
  assert.ok(!existsSync(`${file}.tmp`)); // the temp file was renamed into place
  const reopened = new MemoryStore(file);
  assert.equal(reopened.exchanges().length, 1);
  assert.equal(reopened.exchanges()[0]!.answer?.text, "Node 24.");
});

test("exchanges pair each question with the answer that followed", async () => {
  const store = tempStore();
  const c = await remember(store, "2026-11-03T11:00:00+05:30", "first", "answer one");
  await store.addMessage({ conversationId: c.id, role: "user", text: "unanswered", createdAt: "2026-11-03T06:00:00.000Z" });
  const ex = store.exchanges();
  assert.deepEqual(ex.map((e) => [e.question.text, e.answer?.text]), [["first", "answer one"], ["unanswered", undefined]]);
});

test("conversations are listed most recent first", async () => {
  const store = tempStore();
  const older = await remember(store, "2026-11-01T10:00:00+05:30", "older", "a");
  const newer = await remember(store, "2026-11-05T10:00:00+05:30", "newer", "b");
  assert.deepEqual(store.listConversations().map((c) => c.id), [newer.id, older.id]);
});

test("tokens drop filler words and fold plurals", () => {
  assert.deepEqual([...tokens("Has the pricing of those CRM tools changed since Monday?")], ["pricing", "crm", "tool"]);
});

test("recall by date finds that day's exchanges, in the user's time zone", async () => {
  const store = tempStore();
  await remember(store, "2026-11-03T23:30:00+05:30", "Postgres hosting?", "Neon is cheapest."); // 18:00 UTC
  await remember(store, "2026-11-04T09:00:00+05:30", "Something else", "...");
  const r = recall(store, "What did I ask you on 3 November?", NOW, TZ);
  assert.equal(r.byDate.length, 1);
  assert.deepEqual(r.byDate[0]!.exchanges.map((e) => e.question.text), ["Postgres hosting?"]);
});

test("recall by date reports an empty day instead of guessing", () => {
  const r = recall(tempStore(), "What did I ask you on 1 November?", NOW, TZ);
  assert.equal(r.byDate[0]!.exchanges.length, 0);
});

test("recall by topic finds related questions from any day", async () => {
  const store = tempStore();
  await remember(store, "2026-11-03T15:00:00+05:30", "Which managed Postgres hosting is cheapest: Neon or Supabase?", "Neon.");
  await remember(store, "2026-11-05T15:00:00+05:30", "Best pizza dough recipe?", "Flour, water.");
  const r = recall(store, "Has Postgres hosting pricing changed?", NOW, TZ);
  assert.deepEqual(r.related.map((e) => e.question.text), ["Which managed Postgres hosting is cheapest: Neon or Supabase?"]);
});

test("recall by topic skips the current conversation, which the model already sees", async () => {
  const store = tempStore();
  const c = await remember(store, "2026-11-10T09:00:00+05:30", "Postgres hosting options?", "Neon, Supabase.");
  const r = recall(store, "and Postgres hosting in Europe?", NOW, TZ, c.id);
  assert.equal(r.related.length, 0);
});

test("unrelated questions recall nothing", async () => {
  const store = tempStore();
  await remember(store, "2026-11-03T15:00:00+05:30", "Postgres hosting?", "Neon.");
  const r = recall(store, "Write me a haiku about rain", NOW, TZ);
  assert.equal(r.related.length, 0);
  assert.equal(r.byDate.length, 0);
});
