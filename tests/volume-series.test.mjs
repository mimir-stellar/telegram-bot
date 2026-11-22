import assert from "node:assert/strict";
import test from "node:test";

import {
  volumeSeries,
  floorToBucketUtc,
  toIntegerAmount,
  exportVolumeBucket,
  exportVolumeBuckets,
  exportVolumeSeries,
  formatVolumeSeries,
  formatVolumeBuckets,
  renderVolumeSeries,
} from "../dist/stellar/volume-series.js";
import { scanJsonReplacer } from "../dist/stellar/decode.js";

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

// ── New focused coverage: integer USDC amounts & export boundary ───────────

test("toIntegerAmount: strictly parses non-negative integers and rejects floats, negatives, and invalid values", () => {
  // Valid integer bigints
  assert.equal(toIntegerAmount(100n), 100n);
  assert.equal(toIntegerAmount(0n), 0n);
  assert.equal(toIntegerAmount(10_000_000n), 10_000_000n);

  // Safe integer numbers
  assert.equal(toIntegerAmount(500), 500n);
  assert.equal(toIntegerAmount(0), 0n);

  // Valid integer strings
  assert.equal(toIntegerAmount("10000000"), 10_000_000n);
  assert.equal(toIntegerAmount("  42  "), 42n);
  assert.equal(toIntegerAmount("0"), 0n);

  // Boundary: floating-point numbers rejected (prevent accumulation drift)
  assert.equal(toIntegerAmount(10.5), 0n);
  assert.equal(toIntegerAmount(0.1), 0n);
  assert.equal(toIntegerAmount(0.0000001), 0n);

  // Boundary: decimal strings rejected
  assert.equal(toIntegerAmount("10.5"), 0n);
  assert.equal(toIntegerAmount("1.0000000"), 0n);

  // Boundary: negative values rejected (volume cannot decrease)
  assert.equal(toIntegerAmount(-100n), 0n);
  assert.equal(toIntegerAmount(-1), 0n);
  assert.equal(toIntegerAmount("-50"), 0n);

  // Boundary: non-numeric / unsafe numbers
  assert.equal(toIntegerAmount(NaN), 0n);
  assert.equal(toIntegerAmount(Infinity), 0n);
  assert.equal(toIntegerAmount(-Infinity), 0n);
  assert.equal(toIntegerAmount(1e25), 0n); // exceeds Number.MAX_SAFE_INTEGER
  assert.equal(toIntegerAmount("abc"), 0n);
  assert.equal(toIntegerAmount(null), 0n);
  assert.equal(toIntegerAmount(undefined), 0n);
  assert.equal(toIntegerAmount({}), 0n);
});

test("volumeSeries: avoids floating-point accumulation across repeated fractional atomic amounts", () => {
  // Simulating 10 micro-stakes of 0.1 USDC (1_000_000n atomic units each)
  // In IEEE-754 floats: 0.1 * 10 = 0.9999999999999999 or 0.1 + 0.2 = 0.30000000000000004
  // In integer USDC arithmetic: 10 * 1_000_000n = exactly 10_000_000n (1.0000000 USDC)
  const t = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push(makeEvent({ at: t + i * 60, payload: { name: "claim_challenged", stake: 1_000_000n } }));
  }

  const res = volumeSeries(events, { bucket: "hour" });
  assert.equal(res.buckets.length, 1);
  assert.equal(res.buckets[0].challengeStake, 10_000_000n);
  assert.equal(res.buckets[0].challengeStakeTotal, "10000000");
  assert.equal(res.totalChallengeStake, "10000000");
  assert.equal(res.totalChallengeStakeBigInt, 10_000_000n);

  // Export boundary converts integer units to exact 7 decimals without float rounding
  const exported = exportVolumeSeries(res);
  assert.equal(exported.totalChallengeStakeUsdc, "1.0000000");
  assert.equal(exported.buckets[0].challengeStakeUsdc, "1.0000000");
});

test("volumeSeries: ignores floating-point and negative values to prevent accumulation corruption", () => {
  const t = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);
  const events = [
    // Valid atomic stakes
    makeEvent({ at: t, payload: { name: "claim_challenged", stake: 5_000_000n } }),
    // Floating point number (rejected -> 0n)
    makeEvent({ at: t + 10, payload: { name: "claim_challenged", stake: 12.345678 } }),
    // Decimal string (rejected -> 0n)
    makeEvent({ at: t + 20, payload: { name: "claim_challenged", stake: "2.5000000" } }),
    // Negative bigint (rejected -> 0n)
    makeEvent({ at: t + 30, payload: { name: "claim_challenged", stake: -1_000_000n } }),
    // Valid squad deposit
    makeEvent({ at: t + 40, payload: { name: "deposited", amount: 15_000_000n } }),
    // Negative deposit string (rejected -> 0n)
    makeEvent({ at: t + 50, payload: { name: "deposited", amount: "-500" } }),
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  assert.equal(res.buckets.length, 1);
  assert.equal(res.buckets[0].challengeStake, 5_000_000n);
  assert.equal(res.buckets[0].challengeStakeTotal, "5000000");
  assert.equal(res.buckets[0].squadDeposit, 15_000_000n);
  assert.equal(res.buckets[0].squadDepositTotal, "15000000");
  assert.equal(res.totalChallengeStake, "5000000");
  assert.equal(res.totalSquadDeposit, "15000000");
});

test("volumeSeries: preserves atomic integer precision for amounts exceeding Number.MAX_SAFE_INTEGER", () => {
  const t = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);
  // 9_007_199_254_740_993n is 2^53 + 1 (cannot be represented accurately as IEEE-754 float)
  const hugeAmount = 9_007_199_254_740_993n;
  const events = [
    makeEvent({ at: t, payload: { name: "claim_challenged", stake: hugeAmount } }),
    makeEvent({ at: t + 10, payload: { name: "claim_challenged", stake: 2n } }),
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  const expectedTotal = 9_007_199_254_740_995n;
  assert.equal(res.buckets[0].challengeStake, expectedTotal);
  assert.equal(res.buckets[0].challengeStakeTotal, expectedTotal.toString());
  assert.equal(res.totalChallengeStake, expectedTotal.toString());
  assert.equal(res.totalChallengeStakeBigInt, expectedTotal);

  const exported = exportVolumeSeries(res);
  assert.equal(exported.totalChallengeStakeBigInt, expectedTotal);
  assert.equal(exported.totalChallengeStakeUsdc, "900719925.4740995");
});

test("exportVolumeBucket: formats integer atomic USDC to canonical 7-decimal string at export boundary", () => {
  const bucket = {
    timestamp: "2026-10-20T10:00:00.000Z",
    startAt: 1792490400,
    challengeStakeTotal: "20000000",
    squadDepositTotal: "15500000",
    challengeStake: 20_000_000n,
    squadDeposit: 15_500_000n,
    challengeCount: 1,
    depositCount: 1,
    eventCount: 2,
  };

  const exported = exportVolumeBucket(bucket);
  assert.equal(exported.challengeStakeUsdc, "2.0000000");
  assert.equal(exported.squadDepositUsdc, "1.5500000");
  // Integer USDC amounts preserved
  assert.equal(exported.challengeStake, 20_000_000n);
  assert.equal(exported.squadDeposit, 15_500_000n);
  assert.equal(exported.challengeStakeTotal, "20000000");
  assert.equal(exported.squadDepositTotal, "15500000");
});

test("exportVolumeBucket: boundary values format accurately (0, 1 stroop, large values)", () => {
  const zeroBucket = {
    timestamp: "2026-10-20T00:00:00.000Z",
    startAt: 1792454400,
    challengeStakeTotal: "0",
    squadDepositTotal: "0",
    challengeStake: 0n,
    squadDeposit: 0n,
    challengeCount: 0,
    depositCount: 0,
    eventCount: 0,
  };
  const expZero = exportVolumeBucket(zeroBucket);
  assert.equal(expZero.challengeStakeUsdc, "0.0000000");
  assert.equal(expZero.squadDepositUsdc, "0.0000000");

  const minBucket = {
    ...zeroBucket,
    challengeStake: 1n,
    challengeStakeTotal: "1",
    squadDeposit: 10_000_000n,
    squadDepositTotal: "10000000",
  };
  const expMin = exportVolumeBucket(minBucket);
  assert.equal(expMin.challengeStakeUsdc, "0.0000001");
  assert.equal(expMin.squadDepositUsdc, "1.0000000");
});

test("exportVolumeBuckets and formatVolumeBuckets: format array of buckets at export boundary", () => {
  const buckets = [
    {
      timestamp: "2026-10-20T10:00:00.000Z",
      startAt: 1792490400,
      challengeStakeTotal: "10000000",
      squadDepositTotal: "0",
      challengeStake: 10_000_000n,
      squadDeposit: 0n,
      challengeCount: 1,
      depositCount: 0,
      eventCount: 1,
    },
    {
      timestamp: "2026-10-20T11:00:00.000Z",
      startAt: 1792494000,
      challengeStakeTotal: "0",
      squadDepositTotal: "30000000",
      challengeStake: 0n,
      squadDeposit: 30_000_000n,
      challengeCount: 0,
      depositCount: 1,
      eventCount: 1,
    },
  ];

  const exported1 = exportVolumeBuckets(buckets);
  const exported2 = formatVolumeBuckets(buckets);

  assert.equal(exported1.length, 2);
  assert.equal(exported1[0].challengeStakeUsdc, "1.0000000");
  assert.equal(exported1[0].squadDepositUsdc, "0.0000000");
  assert.equal(exported1[1].challengeStakeUsdc, "0.0000000");
  assert.equal(exported1[1].squadDepositUsdc, "3.0000000");
  assert.deepEqual(exported1, exported2);
});

test("exportVolumeSeries and formatVolumeSeries: export entire series with decimal totals", () => {
  const t = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);
  const events = [
    makeEvent({ at: t, payload: { name: "claim_challenged", stake: 10_000_000n } }),
    makeEvent({ at: t + 3600, payload: { name: "deposited", amount: 25_000_000n } }),
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  const exported = exportVolumeSeries(res);
  const formatted = formatVolumeSeries(res);

  assert.equal(exported.totalChallengeStakeUsdc, "1.0000000");
  assert.equal(exported.totalSquadDepositUsdc, "2.5000000");
  assert.equal(exported.totalChallengeStakeBigInt, 10_000_000n);
  assert.equal(exported.totalSquadDepositBigInt, 25_000_000n);
  assert.equal(exported.buckets[0].challengeStakeUsdc, "1.0000000");
  assert.equal(exported.buckets[1].squadDepositUsdc, "2.5000000");
  assert.deepEqual(exported, formatted);
});

test("renderVolumeSeries: renders plain-text table with decimal USDC at export boundary", () => {
  const t = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);
  const events = [
    makeEvent({ at: t, payload: { name: "claim_challenged", stake: 20_000_000n } }),
    makeEvent({ at: t + 3600, payload: { name: "deposited", amount: 15_000_000n } }),
  ];

  const res = volumeSeries(events, { bucket: "hour" });
  const text = renderVolumeSeries(res);

  assert.match(text, /Total Challenge Stake: 2\.0000000 USDC/);
  assert.match(text, /Total Squad Deposit: 1\.5000000 USDC/);
  assert.match(text, /Processed Events: 2/);
  assert.match(text, /Challenge Stake: 2\.0000000 USDC/);
  assert.match(text, /Squad Deposit: 1\.5000000 USDC/);
});

test("volumeSeries: non-enumerable helper properties allow direct access to integer bigints and formatted USDC", () => {
  const t = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);
  const events = [
    makeEvent({ at: t, payload: { name: "claim_challenged", stake: 10_000_000n } }),
  ];

  const res = volumeSeries(events, { bucket: "hour" });

  // Direct property access
  assert.equal(res.totalChallengeStakeBigInt, 10_000_000n);
  assert.equal(res.totalSquadDepositBigInt, 0n);
  assert.equal(res.totalChallengeStakeUsdc, "1.0000000");
  assert.equal(res.totalSquadDepositUsdc, "0.0000000");
  assert.equal(res.buckets[0].challengeStakeUsdc, "1.0000000");
  assert.equal(res.buckets[0].squadDepositUsdc, "0.0000000");

  // BigInt amounts serialize cleanly with canonical scanJsonReplacer
  const json = JSON.stringify(res, scanJsonReplacer);
  assert.ok(json.includes('"totalChallengeStake":"10000000"'));
  assert.ok(json.includes('"challengeStake":"10000000"'));
});
