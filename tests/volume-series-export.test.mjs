import assert from "node:assert/strict";
import test from "node:test";

import {
  exportVolumeBucket,
  exportVolumeSeries,
  formatAtomicUsdcBoundary,
  formatVolumeSeriesCsv,
  parseAtomicUsdc,
  serializeVolumeSeriesJson,
  volumeSeries,
} from "../dist/stellar/volume-series.js";

const T0 = Math.floor(new Date("2026-10-20T00:00:00.000Z").getTime() / 1000);

function makeEvent({ at, payload, source = "market", idx = 1 }) {
  return {
    source,
    contractId: "C123",
    version: "v1",
    ledger: 100 + idx,
    txHash: `0xabc${idx}`,
    at,
    eventId: `100-${idx}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("accumulates exact integer atomic USDC across hourly and daily buckets without float drift", () => {
  const events = [];
  // 100 pairs of 0.1 USDC (1_000_000n) + 0.2 USDC (2_000_000n) across 2 hours,
  // plus huge i128 values > Number.MAX_SAFE_INTEGER + single-stroop increments.
  for (let i = 0; i < 100; i++) {
    events.push(
      makeEvent({
        at: T0 + (i % 2) * 3600 + 60,
        idx: i * 2 + 1,
        payload: { name: "claim_challenged", stake: 1_000_000n },
      }),
      makeEvent({
        at: T0 + (i % 2) * 3600 + 120,
        idx: i * 2 + 2,
        source: "squad",
        payload: { name: "deposited", amount: 2_000_000n },
      }),
    );
  }
  events.push(
    makeEvent({
      at: T0 + 3600 + 300,
      idx: 999,
      payload: { name: "claim_challenged", stake: 9007199254740993n },
    }),
    makeEvent({
      at: T0 + 3600 + 305,
      idx: 1000,
      payload: { name: "claim_challenged", stake: 1n },
    }),
  );

  const hourly = volumeSeries(events, { bucket: "hour" });
  const daily = volumeSeries(events, { bucket: "day" });

  // Hour 0: 50 * 1_000_000 = 50_000_000; Hour 1: 50_000_000 + 9007199254740994 = 9007199304740994
  assert.equal(hourly.buckets[0].challengeStakeTotal, "50000000");
  assert.equal(hourly.buckets[1].challengeStakeTotal, "9007199304740994");
  assert.equal(hourly.totalChallengeStake, "9007199354740994");
  assert.equal(hourly.totalSquadDeposit, "200000000");

  // Daily series matches exact sum of hourly integer totals
  assert.equal(daily.buckets.length, 1);
  assert.equal(daily.buckets[0].challengeStakeTotal, "9007199354740994");
  assert.equal(daily.buckets[0].squadDepositTotal, "200000000");

  const exported = exportVolumeSeries(hourly, { bucketUnit: "hour" });
  assert.equal(exported.usdcDecimals, 7);
  assert.equal(exported.usdcAtomicUnit, "10000000");
  assert.equal(exported.buckets[0].challengeStakeAtomic, "50000000");
  assert.equal(exported.buckets[0].challengeStakeUsdc, "5.0000000");
  assert.equal(exported.buckets[1].challengeStakeAtomic, "9007199304740994");
  assert.equal(exported.buckets[1].challengeStakeUsdc, "900719930.4740994");
  assert.equal(exported.totals.challengeStakeAtomic, "9007199354740994");
  assert.equal(exported.totals.challengeStakeUsdc, "900719935.4740994");
  assert.equal(exported.totals.squadDepositAtomic, "200000000");
  assert.equal(exported.totals.squadDepositUsdc, "20.0000000");
  assert.equal(exported.totals.totalVolumeAtomic, "9007199554740994");
  assert.equal(exported.totals.totalVolumeUsdc, "900719955.4740994");
});

test("serializes JSON and CSV exports cleanly with integer atomic columns and boundary decimal display", () => {
  const series = volumeSeries(
    [
      makeEvent({ at: T0 + 10, idx: 1, payload: { name: "claim_challenged", stake: "123456789" } }),
      makeEvent({ at: T0 + 20, idx: 2, source: "squad", payload: { name: "deposited", amount: 11n } }),
    ],
    { bucket: "hour" },
  );

  const jsonText = serializeVolumeSeriesJson(series, { bucketUnit: "hour" });
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.bucketUnit, "hour");
  assert.equal(parsed.buckets[0].challengeStakeAtomic, "123456789");
  assert.equal(parsed.buckets[0].squadDepositAtomic, "11");
  assert.equal(parsed.buckets[0].totalVolumeAtomic, "123456800");
  assert.equal(parsed.buckets[0].challengeStakeUsdc, "12.3456789");
  assert.equal(parsed.buckets[0].squadDepositUsdc, "0.0000011");
  assert.equal(parsed.buckets[0].totalVolumeUsdc, "12.3456800");

  const atomicOnlyBucket = exportVolumeBucket(series.buckets[0], { includeDecimalDisplay: false });
  assert.equal(atomicOnlyBucket.challengeStakeAtomic, "123456789");
  assert.equal("challengeStakeUsdc" in atomicOnlyBucket, false);

  const csv = formatVolumeSeriesCsv(series);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^timestamp,start_at,challenge_stake_atomic,squad_deposit_atomic,total_volume_atomic,challenge_stake_usdc/);
  assert.match(lines[1], /,123456789,11,123456800,12\.3456789,0\.0000011,12\.3456800,1,1,2$/);
});

test("rejects floating-point, unsafe-integer, decimal-string, and negative amounts", () => {
  assert.equal(formatAtomicUsdcBoundary(0n), "0.0000000");
  assert.equal(formatAtomicUsdcBoundary("25000000"), "2.5000000");

  for (const invalid of [12.34, 1e20, -5n, -1, "12.3400000", "", "  ", "0x10", NaN, Infinity]) {
    assert.throws(() => parseAtomicUsdc(invalid), RangeError);
  }

  // Non-strict mode never accumulates unsafe IEEE-754 numbers or float values
  const nonStrict = volumeSeries(
    [
      makeEvent({ at: T0 + 10, idx: 1, payload: { name: "claim_challenged", stake: 1e21 } }),
      makeEvent({ at: T0 + 20, idx: 2, payload: { name: "claim_challenged", stake: 12.75 } }),
      makeEvent({ at: T0 + 30, idx: 3, payload: { name: "claim_challenged", stake: 500n } }),
    ],
    { bucket: "hour" },
  );
  assert.equal(nonStrict.totalChallengeStake, "500");

  // Strict mode throws immediately on float/decimal input
  assert.throws(
    () =>
      volumeSeries(
        [makeEvent({ at: T0 + 10, idx: 1, payload: { name: "claim_challenged", stake: "12.50" } })],
        { bucket: "hour", strictAmounts: true },
      ),
    RangeError,
  );
});
