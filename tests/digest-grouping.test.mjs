/**
 * Tests for digest-grouping.ts and the grouped mode of formatDigest.
 *
 * Coverage:
 *   - groupDigestEvents: key derivation, First-Seen Order, intra-group sort,
 *     count invariant, empty input
 *   - formatDigest: flat (no options) regression guard, grouped headers,
 *     singleton rendering, { grouped: false } equality, empty → null
 */

import assert from "node:assert/strict";
import test from "node:test";

import { groupDigestEvents } from "../dist/notifications/digest-grouping.js";
import { formatDigest } from "../dist/notifications/format.js";

// ---------------------------------------------------------------------------
// Minimal DecodedEvent factory
// ---------------------------------------------------------------------------

let nextId = 1;

/**
 * Build the smallest DecodedEvent that satisfies the grouper and formatDigest.
 *
 * `source` must be "market" | "squad".
 * `payload` is merged on top of a default `{ name: "unknown", eventName: "test" }`.
 * `ledger` defaults to 1000 + an auto-incrementing offset so events are
 * distinguishable without explicit ledger values.
 */
function makeEvent(overrides = {}) {
  const id = nextId++;
  return {
    source: "market",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    version: "v1",
    ledger: 1000 + id,
    txHash: "",
    at: 0,
    eventId: `evt-${id}`,
    eventType: "contract",
    transactionIndex: id,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: { name: "unknown", eventName: "test_event" },
    ...overrides,
  };
}

/** Market event with a claimId. */
function marketEvent(claimId, ledger, extra = {}) {
  return makeEvent({
    source: "market",
    ledger,
    payload: { name: "claim_created", claimId, category: "test", creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI" },
    ...extra,
  });
}

/** Squad event with a marketId. */
function squadEvent(marketId, ledger, extra = {}) {
  return makeEvent({
    source: "squad",
    ledger,
    payload: { name: "market_created", marketId, question: "Q?", captain: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", feeBps: 100, deadline: 1000000 },
    ...extra,
  });
}

/** Admin / unknown event — ungroupable. */
function unknownEvent(ledger) {
  return makeEvent({ source: "market", ledger, payload: { name: "unknown", eventName: "oracle_changed" } });
}

// ---------------------------------------------------------------------------
// groupDigestEvents
// ---------------------------------------------------------------------------

test("groupDigestEvents: empty input returns empty array", () => {
  assert.deepEqual(groupDigestEvents([]), []);
});

test("groupDigestEvents: single market event produces key market:<claimId>", () => {
  const e = marketEvent(1, 1000);
  const groups = groupDigestEvents([e]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "market:1");
  assert.equal(groups[0].events.length, 1);
  assert.equal(groups[0].events[0].eventId, e.eventId);
});

test("groupDigestEvents: single squad event produces key squad:<marketId>", () => {
  const e = squadEvent(7, 1001);
  const groups = groupDigestEvents([e]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "squad:7");
  assert.equal(groups[0].events.length, 1);
});

test("groupDigestEvents: ungroupable event produces key starting with ungroupable:", () => {
  const e = unknownEvent(1002);
  const groups = groupDigestEvents([e]);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].key.startsWith("ungroupable:"), `key was "${groups[0].key}"`);
  assert.equal(groups[0].events.length, 1);
});

test("groupDigestEvents: market event without claimId is ungroupable", () => {
  const e = makeEvent({ source: "market", ledger: 1050, payload: { name: "fee_claimed", recipient: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", amount: 100n } });
  const groups = groupDigestEvents([e]);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].key.startsWith("ungroupable:"), `key was "${groups[0].key}"`);
});

test("groupDigestEvents: mixed burst — correct keys, First-Seen Order, count invariant", () => {
  // Burst: market#1, squad#7, market#1 again, ungroupable
  const e1 = marketEvent(1, 1000);
  const e2 = squadEvent(7, 1001);
  const e3 = marketEvent(1, 1002);   // same claim as e1
  const e4 = unknownEvent(1003);

  const groups = groupDigestEvents([e1, e2, e3, e4]);

  // 3 distinct keys: market:1, squad:7, ungroupable:<...>
  assert.equal(groups.length, 3, "expected 3 groups");

  // First-Seen Order: market:1 first, squad:7 second, ungroupable third
  assert.equal(groups[0].key, "market:1");
  assert.equal(groups[1].key, "squad:7");
  assert.ok(groups[2].key.startsWith("ungroupable:"));

  // market:1 has 2 events; others have 1 each
  assert.equal(groups[0].events.length, 2);
  assert.equal(groups[1].events.length, 1);
  assert.equal(groups[2].events.length, 1);

  // Count invariant: total = input length
  const total = groups.reduce((sum, g) => sum + g.events.length, 0);
  assert.equal(total, 4);
});

test("groupDigestEvents: interleaved keys A,B,A,B → 2 groups in First-Seen Order", () => {
  const a1 = marketEvent(1, 1000);
  const b1 = marketEvent(2, 1001);
  const a2 = marketEvent(1, 1002);
  const b2 = marketEvent(2, 1003);

  const groups = groupDigestEvents([a1, b1, a2, b2]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, "market:1");
  assert.equal(groups[0].events.length, 2);
  assert.equal(groups[1].key, "market:2");
  assert.equal(groups[1].events.length, 2);
});

test("groupDigestEvents: intra-group events are sorted by ledger (compareEvents)", () => {
  // Intentionally insert in reverse ledger order — grouper must sort within group.
  const high = makeEvent({ source: "market", ledger: 1010, transactionIndex: 1, payload: { name: "claim_challenged", claimId: 5, challenger: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", stake: 1000n } });
  const low  = makeEvent({ source: "market", ledger: 1005, transactionIndex: 0, payload: { name: "claim_created",   claimId: 5, category: "test", creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI" } });

  const groups = groupDigestEvents([high, low]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].events[0].ledger, 1005, "lower-ledger event should come first");
  assert.equal(groups[0].events[1].ledger, 1010);
});

test("groupDigestEvents: count invariant for N=1, N=2, N=3", () => {
  for (const n of [1, 2, 3]) {
    const events = Array.from({ length: n }, (_, i) => unknownEvent(2000 + i));
    const groups = groupDigestEvents(events);
    const total = groups.reduce((sum, g) => sum + g.events.length, 0);
    assert.equal(total, n, `N=${n}: sum of group lengths should equal ${n}`);
  }
});

// ---------------------------------------------------------------------------
// formatDigest — flat (no options) regression guard
// ---------------------------------------------------------------------------

test("formatDigest: null for empty array (no options)", () => {
  assert.equal(formatDigest([]), null);
});

test("formatDigest: flat output — contains header and one bullet per event", () => {
  const e1 = marketEvent(1, 1100);
  const e2 = squadEvent(3, 1101);
  const result = formatDigest([e1, e2]);

  assert.ok(result !== null);
  assert.ok(result.includes("*Mimir Digest*"), "should contain digest header");
  assert.ok(result.includes("2 events in this cycle"), "should contain event count");

  // Two bullet lines (· mimir\-...)
  const bullets = result.split("\n").filter((l) => l.startsWith("·"));
  assert.equal(bullets.length, 2, "flat mode should have one bullet per event");

  // No group headers (lines that look like "market:..." or "squad:...")
  const headers = result.split("\n").filter((l) => /^(market|squad):/.test(l));
  assert.equal(headers.length, 0, "flat mode should have no group headers");
});

// ---------------------------------------------------------------------------
// formatDigest — grouped mode
// ---------------------------------------------------------------------------

test("formatDigest: null for empty array ({ grouped: true })", () => {
  assert.equal(formatDigest([], { grouped: true }), null);
});

test("formatDigest grouped: multi-event group has header + indented lines", () => {
  const e1 = makeEvent({ source: "market", ledger: 1200, transactionIndex: 0, payload: { name: "claim_created", claimId: 10, category: "test", creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI" } });
  const e2 = makeEvent({ source: "market", ledger: 1201, transactionIndex: 1, payload: { name: "claim_challenged", claimId: 10, challenger: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI", stake: 500n } });

  const result = formatDigest([e1, e2], { grouped: true });

  assert.ok(result !== null);
  assert.ok(result.includes("*Mimir Digest*"), "should contain digest header");
  assert.ok(result.includes("2 events in this cycle"), "should count all events");

  const lines = result.split("\n");

  // There should be a header line for the group (escaped "market:10")
  const headerLine = lines.find((l) => l.includes("market") && l.includes("10"));
  assert.ok(headerLine !== undefined, "grouped output should contain a group header for market:10");

  // The two event lines should be indented with two spaces
  const indented = lines.filter((l) => l.startsWith("  ·"));
  assert.equal(indented.length, 2, "both events in the group should be indented");
});

test("formatDigest grouped: singleton events render without a group header", () => {
  const e = unknownEvent(1300);
  const result = formatDigest([e], { grouped: true });

  assert.ok(result !== null);
  const lines = result.split("\n").filter((l) => l.trim().length > 0);

  // Only the header line and one bullet — no group key line
  const bullets = lines.filter((l) => l.startsWith("·"));
  assert.equal(bullets.length, 1, "singleton should produce exactly one bullet");

  const indented = lines.filter((l) => l.startsWith("  ·"));
  assert.equal(indented.length, 0, "singleton should not be indented");
});

test("formatDigest: { grouped: false } produces same output as no-options", () => {
  const events = [marketEvent(1, 1400), squadEvent(2, 1401), unknownEvent(1402)];
  const flat    = formatDigest(events);
  const falsy   = formatDigest(events, { grouped: false });
  assert.equal(falsy, flat, "{ grouped: false } must be character-for-character equal to no-options");
});

test("formatDigest grouped: mixed burst — header only for multi-event groups", () => {
  const e1 = marketEvent(1, 1500);
  const e2 = marketEvent(1, 1501);   // same claim → group with header
  const e3 = squadEvent(9, 1502);    // singleton squad → no header

  const result = formatDigest([e1, e2, e3], { grouped: true });
  assert.ok(result !== null);

  const lines = result.split("\n");
  const indented = lines.filter((l) => l.startsWith("  ·"));
  assert.equal(indented.length, 2, "market:1 group should produce 2 indented lines");

  const nonIndentedBullets = lines.filter((l) => l.match(/^· /));
  assert.equal(nonIndentedBullets.length, 1, "squad singleton should produce 1 non-indented bullet");
});
