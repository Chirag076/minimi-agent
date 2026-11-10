import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDateRefs } from "../src/dates.js";
import { NOW, TZ } from "./helpers.js";

const days = (text: string, now = NOW) => resolveDateRefs(text, now, TZ).map((r) => [r.from, r.to]);

test("an explicit date in the past", () => {
  assert.deepEqual(days("What did I ask you on 3 November? Is it still correct?"), [["2026-11-03", "2026-11-03"]]);
});

test("'last Tuesday' asked on a Tuesday means a week ago", () => {
  assert.deepEqual(days("Last Tuesday I asked you about Postgres hosting"), [["2026-11-03", "2026-11-03"]]);
});

test("a bare weekday means the most recent one", () => {
  assert.deepEqual(days("On Monday we shortlisted 5 CRM tools"), [["2026-11-09", "2026-11-09"]]);
});

test("a weekday that would land in the future points back a week", () => {
  // Wednesday asked on a Tuesday: the Wednesday just gone, not tomorrow.
  assert.deepEqual(days("What did we discuss on Wednesday?"), [["2026-11-04", "2026-11-04"]]);
});

test("a date later this year without a year means last year", () => {
  assert.deepEqual(days("What did I ask you on 3 December?"), [["2025-12-03", "2025-12-03"]]);
});

test("yesterday", () => {
  assert.deepEqual(days("what did I ask yesterday"), [["2026-11-09", "2026-11-09"]]);
});

test("a month means the whole month", () => {
  assert.deepEqual(days("anything I asked in October?"), [["2026-10-01", "2026-10-31"]]);
});

test("'last week' is a window, never reaching into the future", () => {
  const [[from, to]] = days("what did we talk about last week?") as [[string, string]];
  assert.equal(from, "2026-10-31");
  assert.equal(to, "2026-11-06");
});

test("'today' in 'is it still true today' is not a memory lookup", () => {
  assert.deepEqual(days("Is your answer still correct today?"), []);
});

test("'earlier today' is a memory lookup", () => {
  assert.deepEqual(days("What did I ask you earlier today?"), [["2026-11-10", "2026-11-10"]]);
});

test("messages without dates resolve to nothing", () => {
  assert.deepEqual(days("Compare 5 CRM tools for a 20-person team"), []);
});

test("the day is read in the user's time zone, not the server's", () => {
  // 00:30 on 11 November in India is still 10 November in UTC.
  const lateNight = new Date("2026-11-11T00:30:00+05:30");
  assert.deepEqual(days("what did I ask yesterday", lateNight), [["2026-11-10", "2026-11-10"]]);
});
