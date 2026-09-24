import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPRESSIBLE_EVENTS,
  formatSuppressedEvents,
  isEventSuppressed,
  parseSuppressedEvents,
} from "../dist/notifications/suppression.js";

test("parseSuppressedEvents: unset and blank yield an empty set (positive default)", () => {
  for (const raw of [undefined, "", "   ", "\t"]) {
    const parsed = parseSuppressedEvents(raw);
    assert.equal(parsed.problems.length, 0, String(raw));
    assert.equal(parsed.suppressed.size, 0, String(raw));
  }
});

test("parseSuppressedEvents: accepts a single known event (positive)", () => {
  const parsed = parseSuppressedEvents("withdrawal");
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual([...parsed.suppressed], ["withdrawal"]);
  assert.equal(isEventSuppressed(parsed.suppressed, "withdrawal"), true);
  assert.equal(isEventSuppressed(parsed.suppressed, "claim_created"), false);
});

test("parseSuppressedEvents: comma list is case-insensitive and dedupes", () => {
  const parsed = parseSuppressedEvents("Withdrawal, FEE_CLAIMED ,withdrawal, fees_claimed");
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual([...parsed.suppressed].sort(), [
    "fee_claimed",
    "fees_claimed",
    "withdrawal",
  ]);
});

test("parseSuppressedEvents: empty slots between commas are ignored (boundary)", () => {
  const parsed = parseSuppressedEvents(",,withdrawal,,");
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual([...parsed.suppressed], ["withdrawal"]);
});

test("parseSuppressedEvents: unknown names are problems, not silent no-ops (negative)", () => {
  const parsed = parseSuppressedEvents("withdrawal,not_a_real_event,oracle_changed");
  assert.equal(parsed.suppressed.has("withdrawal"), true);
  assert.equal(parsed.problems.length, 2);
  assert.match(parsed.problems[0], /not_a_real_event/);
  assert.match(parsed.problems[1], /oracle_changed/);
});

test("parseSuppressedEvents: every suppressible name is accepted in isolation (regression)", () => {
  for (const name of SUPPRESSIBLE_EVENTS) {
    const parsed = parseSuppressedEvents(name);
    assert.deepEqual(parsed.problems, [], name);
    assert.equal(isEventSuppressed(parsed.suppressed, name), true, name);
  }
});

test("parseSuppressedEvents: identical input is stable across restarts (restart)", () => {
  const raw = "claimed, withdrawn ,CLAIMED";
  const first = parseSuppressedEvents(raw);
  const second = parseSuppressedEvents(raw);
  assert.deepEqual([...first.suppressed].sort(), [...second.suppressed].sort());
  assert.deepEqual(first.problems, second.problems);
  assert.equal(formatSuppressedEvents(first.suppressed), "claimed, withdrawn");
});

test("formatSuppressedEvents: empty set renders as (none) for status/logs", () => {
  assert.equal(formatSuppressedEvents(new Set()), "(none)");
});

test("isEventSuppressed: never matches unrelated names when set is empty (boundary)", () => {
  const empty = new Set();
  for (const name of ["claim_created", "unknown", ""]) {
    assert.equal(isEventSuppressed(empty, name), false);
  }
});
