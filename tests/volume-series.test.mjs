import assert from "node:assert/strict";
import test from "node:test";

import { volumeSeries, floorToBucketUtc } from "../dist/stellar/volume-series.js";

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
  const res1 = volumeSeries([], { bucket: "hour" });
  assert.deepEqual(res1, {
    buckets: [],
    totalChallengeStake: "0",
    totalSquadDeposit: "0",
    skippedWithoutAt: 0,
    processedEvents: 0,
  });

  const res2 = volumeSeries(null, { bucket: "day" });
  assert.deepEqual(res2, {
    buckets: [],
    totalChallengeStake: "0",
    totalSquadDeposit: "0",
    skippedWithoutAt: 0,
    processedEvents: 0,
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
