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

test("produces byte-identical flat and grouped digests across live multi-contract arrival and replay orders when timestamps tie", () => {
  const sharedTimestamp = 1_763_193_600;

  // All 6 events share the exact same close timestamp `at` across ledgers 5000 and 5001.
  const squadEarlyOp = makeEvent({
    source: "squad",
    ledger: 5000,
    at: sharedTimestamp,
    transactionIndex: 0,
    operationIndex: 0,
    eventId: "0005000-0001",
    name: "market_created",
    id: 9n,
  });
  const marketSameTxLaterOp = makeEvent({
    source: "market",
    ledger: 5000,
    at: sharedTimestamp,
    transactionIndex: 0,
    operationIndex: 1,
    eventId: "0005000-0002",
    name: "claim_created",
    id: 42n,
  });
  const marketNextTx = makeEvent({
    source: "market",
    ledger: 5000,
    at: sharedTimestamp,
    transactionIndex: 1,
    operationIndex: 0,
    eventId: "0005000-0003",
    name: "claim_challenged",
    id: 42n,
  });
  const squadSecondEvent = makeEvent({
    source: "squad",
    ledger: 5001,
    at: sharedTimestamp,
    transactionIndex: 0,
    operationIndex: 0,
    eventId: "0005001-0001",
    name: "deposited",
    id: 9n,
  });
  const marketLaterLedger = makeEvent({
    source: "market",
    ledger: 5001,
    at: sharedTimestamp,
    transactionIndex: 0,
    operationIndex: 2,
    eventId: "0005001-0002",
    name: "claim_resolved",
    id: 42n,
  });

  // Live poller scans all `market` events before `squad` events:
  const liveOrder = [
    marketSameTxLaterOp,
    marketNextTx,
    marketLaterLedger,
    squadEarlyOp,
    squadSecondEvent,
  ];

  // Historical ledger replay walks ledger 5000 -> 5001 in chain emission order:
  const replayOrder = [
    squadEarlyOp,
    marketSameTxLaterOp,
    marketNextTx,
    squadSecondEvent,
    marketLaterLedger,
  ];

  // Reverse arrival order:
  const reverseOrder = [...replayOrder].reverse();

  const groupedLive = formatDigest(liveOrder, { grouped: true });
  const groupedReplay = formatDigest(replayOrder, { grouped: true });
  const groupedReverse = formatDigest(reverseOrder, { grouped: true });
  assert.equal(groupedLive, groupedReplay);
  assert.equal(groupedLive, groupedReverse);

  const flatLive = formatDigest(liveOrder);
  const flatReplay = formatDigest(replayOrder);
  const flatReverse = formatDigest(reverseOrder);
  assert.equal(flatLive, flatReplay);
  assert.equal(flatLive, flatReverse);

  // Squad group (`squad:9`) has earliest chain coordinate (ledger 5000, op 0), so it leads `market:42`!
  const groups = groupDigestEvents(liveOrder);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["squad:9", "market:42"],
  );
  assert.deepEqual(
    groups[1].events.map((e) => e.payload.name),
    ["claim_created", "claim_challenged", "claim_resolved"],
  );
});

test("breaks ties deterministically via contractId, source, and payload identity when RPC paging tokens are absent", () => {
  const m = makeEvent({
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
  const s = makeEvent({
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

  assert.notEqual(canonicalDigestIdentity(m), canonicalDigestIdentity(s));
  assert.deepEqual(
    sortDigestEvents([s, m]).map((e) => e.source),
    ["market", "squad"],
  );
  assert.equal(
    formatDigest([s, m], { grouped: true }),
    formatDigest([m, s], { grouped: true }),
  );
});

test("maintains strict transitivity across positive, zero, negative, and NaN timestamps", () => {
  assert.equal(normalizeDigestEventTimestamp(1_700_000_000), 1_700_000_000);
  assert.equal(normalizeDigestEventTimestamp(0), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeDigestEventTimestamp(-5), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeDigestEventTimestamp(Number.NaN), Number.MAX_SAFE_INTEGER);

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
      assert.equal(Math.sign(compareDigestEvents(a, b)) + Math.sign(compareDigestEvents(b, a)), 0);
      for (const c of samples) {
        if (compareDigestEvents(a, b) < 0 && compareDigestEvents(b, c) < 0) {
          assert.ok(compareDigestEvents(a, c) < 0, "comparator must be strictly transitive");
        }
      }
    }
  }
});
