/**
 * Deterministic digest ordering when chain close timestamps are equal.
 *
 * Synthetic DecodedEvents only: no RPC, no Telegram, no credentials. Covers
 * live-vs-replay parity, canonical-identity tie-breaks and malformed timestamp
 * boundaries.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalDigestIdentity,
  compareDigestEvents,
  groupDigestEvents,
  sortDigestEvents,
} from "../dist/notifications/digest-grouping.js";
import { formatDigest } from "../dist/notifications/format.js";
import { normalizeDigestEventTimestamp } from "../dist/notifications/schedule.js";

function makeEvent({
  source = "market",
  contractId = source === "market" ? "C" + "A".repeat(55) : "C" + "B".repeat(55),
  ledger = 5000,
  at = 1_763_193_600,
  transactionIndex = 0,
  operationIndex = 0,
  eventId = `${ledger}-${transactionIndex}-${operationIndex}`,
  txHash = "1".repeat(64),
  name = "claim_created",
  id = 1n,
} = {}) {
  return {
    source,
    contractId,
    version: "v1",
    ledger,
    txHash,
    at,
    eventId,
    eventType: "contract",
    transactionIndex,
    operationIndex,
    inSuccessfulContractCall: true,
    payload: source === "squad" ? { name, marketId: id } : { name, claimId: id },
  };
}

function sharedTimestampFixture() {
  const at = 1_763_193_600;

  const squadEarlyOp = makeEvent({
    source: "squad",
    ledger: 5000,
    at,
    transactionIndex: 0,
    operationIndex: 0,
    eventId: "0005000-0001",
    name: "market_created",
    id: 9n,
  });
  const marketSameTxLaterOp = makeEvent({
    source: "market",
    ledger: 5000,
    at,
    transactionIndex: 0,
    operationIndex: 1,
    eventId: "0005000-0002",
    name: "claim_created",
    id: 42n,
  });
  const marketNextTx = makeEvent({
    source: "market",
    ledger: 5000,
    at,
    transactionIndex: 1,
    operationIndex: 0,
    eventId: "0005000-0003",
    name: "claim_challenged",
    id: 42n,
  });
  const squadSecondEvent = makeEvent({
    source: "squad",
    ledger: 5001,
    at,
    transactionIndex: 0,
    operationIndex: 0,
    eventId: "0005001-0001",
    name: "deposited",
    id: 9n,
  });
  const marketLaterLedger = makeEvent({
    source: "market",
    ledger: 5001,
    at,
    transactionIndex: 0,
    operationIndex: 2,
    eventId: "0005001-0002",
    name: "claim_resolved",
    id: 42n,
  });

  return {
    // Live polls all market events before squad events.
    live: [
      marketSameTxLaterOp,
      marketNextTx,
      marketLaterLedger,
      squadEarlyOp,
      squadSecondEvent,
    ],
    // Replay walks ledgers 5000 -> 5001 in chain emission order.
    replay: [
      squadEarlyOp,
      marketSameTxLaterOp,
      marketNextTx,
      squadSecondEvent,
      marketLaterLedger,
    ],
  };
}

function naiveFlatDigest(events) {
  const lines = events.map((e) => `${e.source}:${e.payload.name}:${e.ledger}`);
  return [`${lines.length} events`, ...lines].join("\n");
}

function naiveGroupKeys(events) {
  const keys = events.map((e) =>
    e.source === "market" && e.payload.claimId !== undefined
      ? `market:${e.payload.claimId}`
      : e.source === "squad" && e.payload.marketId !== undefined
        ? `squad:${e.payload.marketId}`
        : `ungroupable:${e.eventId}`,
  );
  return [...new Set(keys)];
}

test("before: arrival-order digest grouping diverges for the same equal-timestamp events", () => {
  const { live, replay } = sharedTimestampFixture();

  assert.notEqual(naiveFlatDigest(live), naiveFlatDigest(replay));
  assert.notDeepEqual(naiveGroupKeys(live), naiveGroupKeys(replay));
});

test("after: flat and grouped digests are byte-identical across live, replay and reversed arrival", () => {
  const { live, replay } = sharedTimestampFixture();
  const reversed = [...replay].reverse();

  for (const [label, build] of [
    ["flat", (events) => formatDigest(events)],
    ["grouped", (events) => formatDigest(events, { grouped: true })],
  ]) {
    const liveDigest = build(live);
    assert.ok(liveDigest !== null, `${label} digest must render`);
    assert.equal(build(replay), liveDigest, `${label} replay digest must match live`);
    assert.equal(build(reversed), liveDigest, `${label} reversed digest must match live`);
  }

  const groups = groupDigestEvents(live);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["squad:9", "market:42"],
  );
  assert.deepEqual(
    groups[1].events.map((e) => e.payload.name),
    ["claim_created", "claim_challenged", "claim_resolved"],
  );
});

test("canonical identity breaks ties when paging tokens and positions are absent", () => {
  const market = makeEvent({
    source: "market",
    contractId: "C" + "A".repeat(55),
    ledger: 6000,
    at: 1_763_200_000,
    transactionIndex: null,
    operationIndex: null,
    eventId: "",
    txHash: "9".repeat(64),
    name: "claim_created",
    id: 1n,
  });
  const squad = makeEvent({
    source: "squad",
    contractId: "C" + "B".repeat(55),
    ledger: 6000,
    at: 1_763_200_000,
    transactionIndex: null,
    operationIndex: null,
    eventId: "",
    txHash: "9".repeat(64),
    name: "market_created",
    id: 1n,
  });

  assert.notEqual(canonicalDigestIdentity(market), canonicalDigestIdentity(squad));
  assert.deepEqual(
    sortDigestEvents([squad, market]).map((e) => e.source),
    ["market", "squad"],
  );
  assert.equal(
    formatDigest([squad, market], { grouped: true }),
    formatDigest([market, squad], { grouped: true }),
  );
});

test("malformed and missing timestamps sort after known ones without breaking transitivity", () => {
  assert.equal(normalizeDigestEventTimestamp(1_700_000_000), 1_700_000_000);
  assert.equal(normalizeDigestEventTimestamp(0), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeDigestEventTimestamp(-5), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeDigestEventTimestamp(Number.NaN), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeDigestEventTimestamp("1700000000"), Number.MAX_SAFE_INTEGER);

  const samples = [
    makeEvent({ ledger: 100, at: 1_700_000_010, eventId: "100-1" }),
    makeEvent({ ledger: 50, at: 0, eventId: "50-1" }),
    makeEvent({ ledger: 200, at: 1_700_000_005, eventId: "200-1" }),
    makeEvent({ ledger: 50, at: Number.NaN, eventId: "50-2" }),
    makeEvent({ ledger: 100, at: 1_700_000_010, eventId: "100-0" }),
  ];

  for (const a of samples) {
    assert.equal(compareDigestEvents(a, a), 0);
    for (const b of samples) {
      assert.equal(
        Math.sign(compareDigestEvents(a, b)) + Math.sign(compareDigestEvents(b, a)),
        0,
      );
      for (const c of samples) {
        if (compareDigestEvents(a, b) < 0 && compareDigestEvents(b, c) < 0) {
          assert.ok(compareDigestEvents(a, c) < 0, "comparator must be transitive");
        }
      }
    }
  }

  const missingA = makeEvent({ at: 0, ledger: 10, eventId: "10-a" });
  const missingB = makeEvent({ at: 0, ledger: 10, eventId: "10-b" });
  const known = makeEvent({ at: 1_700_000_000, ledger: 9999, eventId: "9999-1" });
  assert.deepEqual(
    sortDigestEvents([missingB, known, missingA]).map((e) => e.eventId),
    [known.eventId, missingA.eventId, missingB.eventId],
  );
  assert.deepEqual(
    sortDigestEvents([missingA, missingB, known]).map((e) => e.eventId),
    [known.eventId, missingA.eventId, missingB.eventId],
  );
});
