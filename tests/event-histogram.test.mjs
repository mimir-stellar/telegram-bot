import test from "node:test";
import assert from "node:assert";
import { eventHistogram } from "../dist/stellar/events.js";

// eventHistogram takes decoded events (`{ payload: { name } }`) and returns a
// plain object keyed by event name. Unknown payloads are keyed by the raw
// event name as `unknown:<eventName>` (or `unknown:?`). Keys are ordered by
// count, highest first, ties broken alphabetically, so the histogram is stable
// and safe to serialize into scan JSON output without additional sorting.

const known = (name) => ({ payload: { name } });
const unknown = (eventName) => ({ payload: { name: "unknown", eventName, reason: "test" } });

test("eventHistogram returns an empty object for empty input", () => {
  const result = eventHistogram([]);
  assert.deepStrictEqual(result, {});
});

test("eventHistogram counts a single event", () => {
  const result = eventHistogram([known("market_created")]);
  assert.deepStrictEqual(result, { market_created: 1 });
});

test("eventHistogram counts mixed market and squad names", () => {
  const result = eventHistogram([
    known("market_created"),
    known("deposited"),
    known("market_created"),
    known("deposited"),
    known("claim_resolved"),
    known("deposited"),
  ]);
  assert.deepStrictEqual(result, {
    deposited: 3,
    market_created: 2,
    claim_resolved: 1,
  });
  // Highest count first.
  assert.deepStrictEqual(Object.keys(result), ["deposited", "market_created", "claim_resolved"]);
});

test("eventHistogram breaks count ties alphabetically, independent of input order", () => {
  const a = eventHistogram([known("withdrawal"), known("claim_created"), known("fee_claimed")]);
  const b = eventHistogram([known("fee_claimed"), known("withdrawal"), known("claim_created")]);
  assert.deepStrictEqual(Object.keys(a), ["claim_created", "fee_claimed", "withdrawal"]);
  assert.deepStrictEqual(Object.keys(b), Object.keys(a));
});

test("eventHistogram includes unknown events under their raw name", () => {
  const result = eventHistogram([
    known("market_created"),
    unknown("mystery_event"),
    unknown("mystery_event"),
    unknown(""),
  ]);
  assert.deepStrictEqual(result, {
    "unknown:mystery_event": 2,
    market_created: 1,
    "unknown:?": 1,
  });
  assert.deepStrictEqual(Object.keys(result), ["unknown:mystery_event", "market_created", "unknown:?"]);
});
