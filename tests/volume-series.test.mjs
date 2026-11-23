import assert from "node:assert/strict";
import test from "node:test";

import {
  volumeSeries,
  floorToBucketUtc,
  IncompleteCaptureError,
  assertCompleteCapture,
} from "../dist/stellar/volume-series.js";

function makeEvent({ at, payload, source = "market" }) {
  return {
    source,
    contractId: "C123",
    version: "v1",
    ledger: 100,
    txHash: "0xabc",
    at,
    eventId: "100-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("floorToBucketUtc calculates correct UTC boundaries for hour and day", () => {
  // 2026-10-20T14:45:30Z = 1792507530
  const t = 1792507530;
  const hourFloored = floorToBucketUtc(t, "hour");
  const dayFloored = floorToBucketUtc(t, "day");

  assert.equal(new Date(hourFloored * 1000).toISOString(), "2026-10-20T14:00:00.000Z");
  assert.equal(new Date(dayFloored * 1000).toISOString(), "2026-10-20T00:00:00.000Z");
});

test("volumeSeries: empty input returns empty buckets and zero totals", () => {
  const expectedEmptyCompleteness = {
    startLedger: null,
    endLedger: null,
    ledgerRange: {
      fromLedger: null,
      toLedger: null,
    },
    gaps: [],
    hasGaps: false,
    totalMissedLedgers: 0,
    isComplete: false,
    isPartial: true,
  };

  const res1 = volumeSeries([], { bucket: "hour" });
  assert.deepEqual(res1, {
    buckets: [],
    totalChallengeStake: "0",
    totalSquadDeposit: "0",
    skippedWithoutAt: 0,
    processedEvents: 0,
    completeness: expectedEmptyCompleteness,
    capture: expectedEmptyCompleteness,
    globalMarketTotals: null,
  });

  const res2 = volumeSeries(null, { bucket: "day" });
  assert.deepEqual(res2, {
    buckets: [],
    totalChallengeStake: "0",
    totalSquadDeposit: "0",
    skippedWithoutAt: 0,
    processedEvents: 0,
    completeness: expectedEmptyCompleteness,
    capture: expectedEmptyCompleteness,
    globalMarketTotals: null,
  });
});

test("volumeSeries: skips and counts events without valid 'at'", () => {
  const events = [
    makeEvent({ at: undefined, payload: { name: "claim_challenged", stake: 100n } }),
    makeEvent({ at: null, payload: { name: "deposited", amount: 200n } }),
    makeEvent({ at: "not-a-number", payload: { name: "deposited", amount: 300n } }),
    makeEvent({ at: -5, payload: { name: "claim_challenged", stake: 400n } }),
    makeEvent({ at: 1792507200, payload: { name: "claim_challenged", stake: 500n } }), // 2026-10-20T14:40:00Z
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  assert.equal(res.skippedWithoutAt, 4);
  assert.equal(res.processedEvents, 1);
  assert.equal(res.buckets.length, 1);
  assert.equal(res.buckets[0].challengeStakeTotal, "500");
  assert.equal(res.buckets[0].squadDepositTotal, "0");
  assert.equal(res.totalChallengeStake, "500");
  assert.equal(res.totalSquadDeposit, "0");
});

test("volumeSeries: contiguous buckets with gaps filled across an hour boundary", () => {
  // Event 1 at 2026-10-20T10:15:00Z (unix 1792491300)
  // Event 2 at 2026-10-20T13:45:00Z (unix 1792503900)
  // Between 10:00 and 13:00, there should be 4 buckets: 10:00, 11:00, 12:00, 13:00
  const t1 = Math.floor(new Date("2026-10-20T10:15:00.000Z").getTime() / 1000);
  const t2 = Math.floor(new Date("2026-10-20T13:45:00.000Z").getTime() / 1000);

  const events = [
    makeEvent({ at: t1, payload: { name: "claim_challenged", stake: 10000000n } }),
    makeEvent({ at: t2, payload: { name: "deposited", amount: 25000000n } }),
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  assert.equal(res.buckets.length, 4);
  assert.equal(res.skippedWithoutAt, 0);
  assert.equal(res.processedEvents, 2);

  // Bucket 0: 10:00
  assert.equal(res.buckets[0].timestamp, "2026-10-20T10:00:00.000Z");
  assert.equal(res.buckets[0].challengeStakeTotal, "10000000");
  assert.equal(res.buckets[0].squadDepositTotal, "0");
  assert.equal(res.buckets[0].challengeCount, 1);
  assert.equal(res.buckets[0].depositCount, 0);

  // Bucket 1: 11:00 (zero-filled)
  assert.equal(res.buckets[1].timestamp, "2026-10-20T11:00:00.000Z");
  assert.equal(res.buckets[1].challengeStakeTotal, "0");
  assert.equal(res.buckets[1].squadDepositTotal, "0");
  assert.equal(res.buckets[1].challengeCount, 0);
  assert.equal(res.buckets[1].depositCount, 0);

  // Bucket 2: 12:00 (zero-filled)
  assert.equal(res.buckets[2].timestamp, "2026-10-20T12:00:00.000Z");
  assert.equal(res.buckets[2].challengeStakeTotal, "0");
  assert.equal(res.buckets[2].squadDepositTotal, "0");

  // Bucket 3: 13:00
  assert.equal(res.buckets[3].timestamp, "2026-10-20T13:00:00.000Z");
  assert.equal(res.buckets[3].challengeStakeTotal, "0");
  assert.equal(res.buckets[3].squadDepositTotal, "25000000");
  assert.equal(res.buckets[3].challengeCount, 0);
  assert.equal(res.buckets[3].depositCount, 1);

  // Overall totals
  assert.equal(res.totalChallengeStake, "10000000");
  assert.equal(res.totalSquadDeposit, "25000000");
});

test("volumeSeries: contiguous buckets with gaps across day boundaries in UTC", () => {
  // Day 1: 2026-10-18T23:30:00Z -> bucket 2026-10-18T00:00:00Z
  // Day 2: 2026-10-21T02:15:00Z -> bucket 2026-10-21T00:00:00Z
  // Gaps: 2026-10-19 and 2026-10-20
  const t1 = Math.floor(new Date("2026-10-18T23:30:00.000Z").getTime() / 1000);
  const t2 = Math.floor(new Date("2026-10-21T02:15:00.000Z").getTime() / 1000);

  const events = [
    makeEvent({ at: t1, payload: { name: "claim_challenged", stake: 5000000000000000000n } }),
    makeEvent({ at: t2, payload: { name: "deposited", amount: 9999999999999999999n } }),
  ];

  const res = volumeSeries(events, { bucket: "day" });
  assert.equal(res.buckets.length, 4);

  assert.equal(res.buckets[0].timestamp, "2026-10-18T00:00:00.000Z");
  assert.equal(res.buckets[0].challengeStakeTotal, "5000000000000000000");
  assert.equal(res.buckets[0].squadDepositTotal, "0");

  assert.equal(res.buckets[1].timestamp, "2026-10-19T00:00:00.000Z");
  assert.equal(res.buckets[1].challengeStakeTotal, "0");
  assert.equal(res.buckets[1].squadDepositTotal, "0");

  assert.equal(res.buckets[2].timestamp, "2026-10-20T00:00:00.000Z");
  assert.equal(res.buckets[2].challengeStakeTotal, "0");
  assert.equal(res.buckets[2].squadDepositTotal, "0");

  assert.equal(res.buckets[3].timestamp, "2026-10-21T00:00:00.000Z");
  assert.equal(res.buckets[3].challengeStakeTotal, "0");
  assert.equal(res.buckets[3].squadDepositTotal, "9999999999999999999");

  assert.equal(res.totalChallengeStake, "5000000000000000000");
  assert.equal(res.totalSquadDeposit, "9999999999999999999");
});

test("volumeSeries: aggregates multiple events in the same bucket correctly", () => {
  const t1 = Math.floor(new Date("2026-10-20T10:05:00.000Z").getTime() / 1000);
  const t2 = Math.floor(new Date("2026-10-20T10:25:00.000Z").getTime() / 1000);
  const t3 = Math.floor(new Date("2026-10-20T10:45:00.000Z").getTime() / 1000);

  const events = [
    makeEvent({ at: t1, payload: { name: "claim_challenged", stake: 100n } }),
    makeEvent({ at: t2, payload: { name: "claim_challenged", stake: 250n } }),
    makeEvent({ at: t3, payload: { name: "deposited", amount: 800n } }),
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  assert.equal(res.buckets.length, 1);
  assert.equal(res.buckets[0].timestamp, "2026-10-20T10:00:00.000Z");
  assert.equal(res.buckets[0].challengeStakeTotal, "350");
  assert.equal(res.buckets[0].squadDepositTotal, "800");
  assert.equal(res.buckets[0].challengeCount, 2);
  assert.equal(res.buckets[0].depositCount, 1);
  assert.equal(res.buckets[0].eventCount, 3);
});

test("volumeSeries: non-stake/deposit events are processed without altering totals", () => {
  const t = Math.floor(new Date("2026-10-20T12:00:00.000Z").getTime() / 1000);
  const events = [
    makeEvent({ at: t, payload: { name: "claim_created", claimId: 1 } }),
    makeEvent({ at: t, payload: { name: "market_resolved", claimId: 1 } }),
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  assert.equal(res.buckets.length, 1);
  assert.equal(res.buckets[0].challengeStakeTotal, "0");
  assert.equal(res.buckets[0].squadDepositTotal, "0");
  assert.equal(res.buckets[0].challengeCount, 0);
  assert.equal(res.buckets[0].depositCount, 0);
  assert.equal(res.buckets[0].eventCount, 2);
});

test("volumeSeries: throws on invalid bucket option", () => {
  assert.throws(() => {
    // @ts-expect-error test invalid parameter
    volumeSeries([], { bucket: "week" });
  }, /Invalid bucket unit/);
});

// ── Capture Completeness & Global Market Totals Coverage ────────────────────

test("volumeSeries: carries observed ledger range and gap information in result", () => {
  const events = [
    { ...makeEvent({ at: 1792500000, payload: { name: "claim_challenged", stake: 100n } }), ledger: 105 },
    { ...makeEvent({ at: 1792503600, payload: { name: "deposited", amount: 200n } }), ledger: 180 },
    { ...makeEvent({ at: 1792507200, payload: { name: "claim_challenged", stake: 300n } }), ledger: 120 },
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  assert.equal(res.completeness.startLedger, 105);
  assert.equal(res.completeness.endLedger, 180);
  assert.deepEqual(res.completeness.ledgerRange, { fromLedger: 105, toLedger: 180 });
  assert.deepEqual(res.completeness.gaps, []);
  assert.equal(res.completeness.hasGaps, false);
  assert.equal(res.completeness.totalMissedLedgers, 0);
  // Default is partial capture
  assert.equal(res.completeness.isComplete, false);
  assert.equal(res.completeness.isPartial, true);
  // capture is an alias to completeness
  assert.strictEqual(res.capture, res.completeness);
});

test("volumeSeries: prevents partial captures from being presented as global market totals (globalMarketTotals is null)", () => {
  const events = [
    { ...makeEvent({ at: 1792500000, payload: { name: "claim_challenged", stake: 10000000n } }), ledger: 100 },
    { ...makeEvent({ at: 1792503600, payload: { name: "deposited", amount: 25000000n } }), ledger: 200 },
  ];

  // Without isComplete: true, series is a partial capture
  const partialRes = volumeSeries(events, { bucket: "hour" });
  assert.equal(partialRes.totalChallengeStake, "10000000");
  assert.equal(partialRes.totalSquadDeposit, "25000000");
  assert.equal(partialRes.globalMarketTotals, null);
  assert.equal(partialRes.completeness.isComplete, false);
  assert.equal(partialRes.completeness.isPartial, true);
});

test("volumeSeries: populates globalMarketTotals only when capture is verified complete without gaps", () => {
  const events = [
    { ...makeEvent({ at: 1792500000, payload: { name: "claim_challenged", stake: 10000000n } }), ledger: 100 },
    { ...makeEvent({ at: 1792503600, payload: { name: "deposited", amount: 25000000n } }), ledger: 200 },
  ];

  // With isComplete: true and no gaps, globalMarketTotals is populated
  const completeRes = volumeSeries(events, { bucket: "hour", isComplete: true });
  assert.equal(completeRes.completeness.isComplete, true);
  assert.equal(completeRes.completeness.isPartial, false);
  assert.deepEqual(completeRes.globalMarketTotals, {
    totalChallengeStake: "10000000",
    totalSquadDeposit: "25000000",
  });
});

test("volumeSeries: uncaptured gaps override isComplete to false and prevent global market totals", () => {
  const events = [
    { ...makeEvent({ at: 1792500000, payload: { name: "claim_challenged", stake: 10000000n } }), ledger: 100 },
    { ...makeEvent({ at: 1792503600, payload: { name: "deposited", amount: 25000000n } }), ledger: 200 },
  ];

  // Even if caller asserted isComplete: true, presence of gaps forces isComplete: false
  const gapRes = volumeSeries(events, {
    bucket: "hour",
    isComplete: true,
    gaps: [{ fromLedger: 130, toLedger: 150 }],
  });

  assert.equal(gapRes.completeness.isComplete, false);
  assert.equal(gapRes.completeness.isPartial, true);
  assert.equal(gapRes.completeness.hasGaps, true);
  assert.equal(gapRes.completeness.totalMissedLedgers, 21);
  assert.deepEqual(gapRes.completeness.gaps, [
    { fromLedger: 130, toLedger: 150, missedLedgers: 21 },
  ]);
  assert.equal(gapRes.globalMarketTotals, null);
});

test("volumeSeries: failure case - requireComplete throws IncompleteCaptureError on partial capture", () => {
  const events = [
    { ...makeEvent({ at: 1792500000, payload: { name: "claim_challenged", stake: 10000000n } }), ledger: 100 },
  ];

  assert.throws(
    () => {
      volumeSeries(events, { bucket: "hour", requireComplete: true });
    },
    (err) => {
      assert.ok(err instanceof IncompleteCaptureError);
      assert.match(err.message, /Cannot present partial capture as global market totals/);
      assert.equal(err.startLedger, 100);
      assert.equal(err.endLedger, 100);
      return true;
    },
  );
});

test("volumeSeries: failure case - requireComplete throws IncompleteCaptureError when gaps exist", () => {
  const events = [
    { ...makeEvent({ at: 1792500000, payload: { name: "claim_challenged", stake: 10000000n } }), ledger: 100 },
  ];

  assert.throws(
    () => {
      volumeSeries(events, {
        bucket: "hour",
        isComplete: true,
        requireComplete: true,
        gaps: [{ fromLedger: 110, toLedger: 120, missedLedgers: 11 }],
      });
    },
    (err) => {
      assert.ok(err instanceof IncompleteCaptureError);
      assert.match(err.message, /Cannot present partial capture as global market totals: series capture is incomplete \(1 gap\(s\), 11 missed ledger\(s\)\)/);
      assert.equal(err.totalMissedLedgers, 11);
      assert.equal(err.gaps.length, 1);
      return true;
    },
  );
});

test("volumeSeries: assertCompleteCapture throws on partial result and succeeds on complete result", () => {
  const events = [
    { ...makeEvent({ at: 1792500000, payload: { name: "claim_challenged", stake: 10000000n } }), ledger: 100 },
  ];

  const partialRes = volumeSeries(events, { bucket: "hour" });
  assert.throws(() => {
    assertCompleteCapture(partialRes);
  }, IncompleteCaptureError);

  const completeRes = volumeSeries(events, { bucket: "hour", isComplete: true });
  assert.doesNotThrow(() => {
    assertCompleteCapture(completeRes);
  });
});

test("volumeSeries: boundary cases - custom fromLedger/toLedger, multiple gaps, and single-ledger gap", () => {
  const events = [
    { ...makeEvent({ at: 1792500000, payload: { name: "claim_challenged", stake: 50n } }), ledger: 50 },
    { ...makeEvent({ at: 1792503600, payload: { name: "deposited", amount: 75n } }), ledger: 150 },
  ];

  // Custom bounds widening beyond observed events and multiple gaps with unsorted input
  const res = volumeSeries(events, {
    bucket: "hour",
    fromLedger: 10,
    toLedger: 200,
    gaps: [
      { from: 120, to: 130 },       // gap 2: 11 ledgers
      { fromLedger: 25, toLedger: 25 }, // gap 1 (single ledger): 1 ledger
    ],
  });

  assert.equal(res.completeness.startLedger, 10);
  assert.equal(res.completeness.endLedger, 200);
  assert.deepEqual(res.completeness.ledgerRange, { fromLedger: 10, toLedger: 200 });
  assert.equal(res.completeness.gaps.length, 2);
  // Gaps sorted ascending
  assert.deepEqual(res.completeness.gaps[0], { fromLedger: 25, toLedger: 25, missedLedgers: 1 });
  assert.deepEqual(res.completeness.gaps[1], { fromLedger: 120, toLedger: 130, missedLedgers: 11 });
  assert.equal(res.completeness.totalMissedLedgers, 12);
  assert.equal(res.completeness.hasGaps, true);
  assert.equal(res.completeness.isComplete, false);
  assert.equal(res.completeness.isPartial, true);
});

test("volumeSeries: boundary case - invalid range throws Error", () => {
  assert.throws(() => {
    volumeSeries([], { bucket: "hour", fromLedger: 200, toLedger: 100 });
  }, /startLedger \(200\) cannot exceed endLedger \(100\)/);

  assert.throws(() => {
    volumeSeries([], {
      bucket: "hour",
      gaps: [{ fromLedger: 50, toLedger: 20 }],
    });
  }, /fromLedger \(50\) cannot exceed toLedger \(20\)/);
});
