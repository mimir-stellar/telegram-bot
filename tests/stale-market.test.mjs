import assert from "node:assert/strict";
import test from "node:test";

import {
  staleMarketWatch,
  staleMarketReport,
  renderStaleMarketReport,
  validateAgeThreshold,
  DEFAULT_STALE_AGE_THRESHOLD_SEC,
  INFERRED_STATE_DISCLAIMER,
} from "../dist/stellar/stale-market.js";

function makeSquadEvent({ name, marketId, ledger = 100, at = 1_700_000_000, ...payloadFields }) {
  return {
    source: "squad",
    contractId: "CSQUAD11111111111111111111111111111111111111111111111111",
    version: "v1",
    ledger,
    txHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
    at,
    eventId: `${ledger}-1`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      marketId,
      ...payloadFields,
    },
  };
}

function makeClaimEvent({ name, claimId, ledger = 100, at = 1_700_000_000, ...payloadFields }) {
  return {
    source: "market",
    contractId: "CMARKET22222222222222222222222222222222222222222222222222",
    version: "v1",
    ledger,
    txHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
    at,
    eventId: `${ledger}-2`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      claimId,
      ...payloadFields,
    },
  };
}

test("validateAgeThreshold: accepts valid positive thresholds and applies defaults", () => {
  assert.equal(validateAgeThreshold(undefined), DEFAULT_STALE_AGE_THRESHOLD_SEC);
  assert.equal(validateAgeThreshold(null), DEFAULT_STALE_AGE_THRESHOLD_SEC);
  assert.equal(validateAgeThreshold(3600), 3600);
  assert.equal(validateAgeThreshold(86400.9), 86400);
  assert.equal(validateAgeThreshold(0), 0);

  // Failure cases: negative or non-finite numbers
  assert.throws(() => validateAgeThreshold(-1), RangeError);
  assert.throws(() => validateAgeThreshold(Number.NaN), TypeError);
  assert.throws(() => validateAgeThreshold(Infinity), RangeError);
  assert.throws(() => validateAgeThreshold("86400"), TypeError);
});

test("staleMarketWatch: empty and null inputs return zero counts and read-only declaration", () => {
  for (const empty of [[], null, undefined]) {
    const report = staleMarketWatch(empty, { nowSec: 1_700_100_000 });
    assert.equal(report.staleMarkets.length, 0);
    assert.equal(report.summary.totalOpenMarkets, 0);
    assert.equal(report.summary.staleCount, 0);
    assert.equal(report.summary.overdueCount, 0);
    assert.equal(report.summary.maxAgeSec, 0);
    assert.equal(report.summary.p50AgeSec, 0);
    assert.equal(report.summary.p90AgeSec, 0);
    assert.equal(report.thresholdSec, DEFAULT_STALE_AGE_THRESHOLD_SEC);
    assert.equal(report.readOnly, true);
    assert.equal(report.inferredStateNotice, INFERRED_STATE_DISCLAIMER);
  }
});

test("staleMarketWatch: identifies open squad markets exceeding age threshold", () => {
  const baseTime = 1_700_000_000;
  const thresholdSec = 3600; // 1 hour threshold
  const nowSec = baseTime + 7200; // evaluated at 2 hours later

  const events = [
    makeSquadEvent({
      name: "market_created",
      marketId: 1,
      ledger: 10,
      at: baseTime,
      question: "Will Soroban protocol 22 release on schedule?",
      captain: "GCAPTAIN1",
      deadline: baseTime + 10000,
    }),
    makeSquadEvent({
      name: "market_created",
      marketId: 2,
      ledger: 20,
      at: baseTime + 5000, // age: 2200s (less than threshold 3600s)
      question: "Will Stellar reach target TPS?",
      captain: "GCAPTAIN2",
      deadline: baseTime + 15000,
    }),
  ];

  const report = staleMarketWatch(events, { nowSec, thresholdSec, includeAllOpen: true });

  assert.equal(report.summary.totalOpenMarkets, 2);
  assert.equal(report.summary.staleCount, 1);
  assert.equal(report.staleMarkets.length, 1);

  const stale = report.staleMarkets[0];
  assert.equal(stale.marketId, 1);
  assert.equal(stale.marketType, "squad");
  assert.equal(stale.ageSec, 7200);
  assert.equal(stale.isStale, true);
  assert.equal(stale.inferredState, "inferred_stale");
  assert.equal(stale.settlementSubmitted, false);
  assert.match(stale.inferredStateLabel, /inferred_stale/);

  // Check that all open markets are captured with their inferred state
  assert.equal(report.allOpenMarkets?.length, 2);
  const nonStale = report.allOpenMarkets?.find((m) => m.marketId === 2);
  assert.equal(nonStale?.isStale, false);
  assert.equal(nonStale?.inferredState, "inferred_open");
  assert.equal(nonStale?.settlementSubmitted, false);
});

test("staleMarketWatch: identifies open prediction claims exceeding age threshold", () => {
  const baseTime = 1_700_000_000;
  const thresholdSec = 1000;
  const nowSec = baseTime + 2500;

  const events = [
    makeClaimEvent({
      name: "claim_created",
      claimId: 42,
      ledger: 50,
      at: baseTime,
      creator: "GCREATOR42",
      category: "crypto",
      title: "BTC above 100k",
    }),
  ];

  const report = staleMarketWatch(events, { nowSec, thresholdSec });

  assert.equal(report.summary.staleCount, 1);
  assert.equal(report.staleMarkets.length, 1);
  const stale = report.staleMarkets[0];
  assert.equal(stale.marketId, 42);
  assert.equal(stale.marketType, "claim");
  assert.equal(stale.source, "market");
  assert.equal(stale.creator, "GCREATOR42");
  assert.equal(stale.category, "crypto");
  assert.equal(stale.title, "BTC above 100k");
  assert.equal(stale.ageSec, 2500);
  assert.equal(stale.isStale, true);
  assert.equal(stale.settlementSubmitted, false);
});

test("staleMarketWatch: excludes resolved squad markets", () => {
  const baseTime = 1_700_000_000;
  const nowSec = baseTime + 10000;

  const events = [
    makeSquadEvent({ name: "market_created", marketId: 10, at: baseTime, ledger: 100 }),
    makeSquadEvent({ name: "resolved", marketId: 10, at: baseTime + 500, ledger: 150, result: 1 }),
    makeSquadEvent({ name: "market_created", marketId: 11, at: baseTime, ledger: 100 }),
  ];

  const report = staleMarketWatch(events, { nowSec, thresholdSec: 3600 });
  assert.equal(report.summary.totalOpenMarkets, 1);
  assert.equal(report.summary.staleCount, 1);
  assert.equal(report.staleMarkets[0].marketId, 11);
});

test("staleMarketWatch: excludes resolved, cancelled, and settled prediction claims", () => {
  const baseTime = 1_700_000_000;
  const nowSec = baseTime + 10000;

  const events = [
    // Claim 1: resolved
    makeClaimEvent({ name: "claim_created", claimId: 1, at: baseTime, ledger: 10 }),
    makeClaimEvent({ name: "claim_resolved", claimId: 1, at: baseTime + 100, ledger: 20 }),

    // Claim 2: cancelled
    makeClaimEvent({ name: "claim_created", claimId: 2, at: baseTime, ledger: 10 }),
    makeClaimEvent({ name: "claim_cancelled", claimId: 2, at: baseTime + 100, ledger: 20 }),

    // Claim 3: settled
    makeClaimEvent({ name: "claim_created", claimId: 3, at: baseTime, ledger: 10 }),
    makeClaimEvent({ name: "market_settled", claimId: 3, at: baseTime + 100, ledger: 20 }),

    // Claim 4: remains open
    makeClaimEvent({ name: "claim_created", claimId: 4, at: baseTime, ledger: 10 }),
  ];

  const report = staleMarketWatch(events, { nowSec, thresholdSec: 1000 });
  assert.equal(report.summary.totalOpenMarkets, 1);
  assert.equal(report.summary.staleCount, 1);
  assert.equal(report.staleMarkets[0].marketId, 4);
});

test("staleMarketWatch: exact boundary condition for age threshold", () => {
  const baseTime = 1_700_000_000;
  const thresholdSec = 500;

  const events = [
    // Exactly at threshold boundary: age = 500 -> isStale: true
    makeSquadEvent({ name: "market_created", marketId: 1, at: baseTime, ledger: 10 }),
    // One second under threshold: age = 499 -> isStale: false
    makeSquadEvent({ name: "market_created", marketId: 2, at: baseTime + 1, ledger: 10 }),
    // One second over threshold: age = 501 -> isStale: true
    makeSquadEvent({ name: "market_created", marketId: 3, at: baseTime - 1, ledger: 10 }),
  ];

  const report = staleMarketWatch(events, { nowSec: baseTime + 500, thresholdSec });
  assert.equal(report.summary.totalOpenMarkets, 3);
  assert.equal(report.summary.staleCount, 2);
  assert.deepEqual(report.staleMarkets.map((m) => m.marketId), [3, 1]);
});

test("staleMarketWatch: collapses duplicate creation events to earliest timestamp and ledger", () => {
  const events = [
    makeSquadEvent({ name: "market_created", marketId: 100, at: 2000, ledger: 20 }),
    makeSquadEvent({ name: "market_created", marketId: 100, at: 1000, ledger: 10 }), // earlier
    makeSquadEvent({ name: "market_created", marketId: 100, at: 3000, ledger: 30 }),
  ];

  const report = staleMarketWatch(events, { nowSec: 4000, thresholdSec: 1000 });
  assert.equal(report.summary.totalOpenMarkets, 1);
  assert.equal(report.staleMarkets[0].creationAt, 1000);
  assert.equal(report.staleMarkets[0].creationLedger, 10);
  assert.equal(report.staleMarkets[0].ageSec, 3000);
});

test("staleMarketWatch: identifies overdue markets past declared deadline", () => {
  const baseTime = 1_700_000_000;
  const deadline = baseTime + 500;
  const nowSec = baseTime + 2000;

  const events = [
    makeSquadEvent({
      name: "market_created",
      marketId: 5,
      at: baseTime,
      deadline,
      question: "Short deadline market",
    }),
  ];

  const report = staleMarketWatch(events, { nowSec, thresholdSec: 1000 });
  assert.equal(report.summary.staleCount, 1);
  assert.equal(report.summary.overdueCount, 1);

  const stale = report.staleMarkets[0];
  assert.equal(stale.overdueSec, 1500); // 2000 - 500
  assert.equal(stale.inferredState, "inferred_overdue");
  assert.match(stale.inferredStateLabel, /inferred_overdue/);
  assert.equal(stale.settlementSubmitted, false);
});

test("staleMarketWatch: filters by marketType option", () => {
  const baseTime = 1_700_000_000;
  const nowSec = baseTime + 5000;

  const events = [
    makeSquadEvent({ name: "market_created", marketId: 1, at: baseTime }),
    makeClaimEvent({ name: "claim_created", claimId: 2, at: baseTime }),
  ];

  const squadOnly = staleMarketWatch(events, { nowSec, thresholdSec: 1000, marketType: "squad" });
  assert.equal(squadOnly.summary.totalOpenMarkets, 1);
  assert.equal(squadOnly.staleMarkets[0].marketType, "squad");

  const claimOnly = staleMarketWatch(events, { nowSec, thresholdSec: 1000, marketType: "claim" });
  assert.equal(claimOnly.summary.totalOpenMarkets, 1);
  assert.equal(claimOnly.staleMarkets[0].marketType, "claim");
});

test("staleMarketWatch: computes percentiles and summary distributions accurately", () => {
  const baseTime = 1_700_000_000;
  const nowSec = baseTime + 10_000;

  // Ages: 1000, 2000, 3000, 4000, 5000
  const events = [
    makeSquadEvent({ name: "market_created", marketId: 1, at: nowSec - 1000 }),
    makeSquadEvent({ name: "market_created", marketId: 2, at: nowSec - 2000 }),
    makeSquadEvent({ name: "market_created", marketId: 3, at: nowSec - 3000 }),
    makeSquadEvent({ name: "market_created", marketId: 4, at: nowSec - 4000 }),
    makeSquadEvent({ name: "market_created", marketId: 5, at: nowSec - 5000 }),
  ];

  const report = staleMarketWatch(events, { nowSec, thresholdSec: 2500 });
  assert.equal(report.summary.totalOpenMarkets, 5);
  assert.equal(report.summary.staleCount, 3); // 5000, 4000, 3000
  assert.equal(report.summary.maxAgeSec, 5000);
  assert.equal(report.summary.p50AgeSec, 3000); // 5 elements: rank 3 -> 3000
  assert.equal(report.summary.p90AgeSec, 5000); // rank 5 -> 5000
});

test("staleMarketWatch: supports output limiting and stable sorting", () => {
  const nowSec = 1_700_010_000;

  const events = [
    makeSquadEvent({ name: "market_created", marketId: 1, at: nowSec - 5000 }),
    makeSquadEvent({ name: "market_created", marketId: 2, at: nowSec - 7000 }),
    makeSquadEvent({ name: "market_created", marketId: 3, at: nowSec - 6000 }),
  ];

  const report = staleMarketWatch(events, { nowSec, thresholdSec: 1000, limit: 2 });
  assert.equal(report.summary.staleCount, 3);
  assert.equal(report.staleMarkets.length, 2);
  assert.equal(report.staleMarkets[0].marketId, 2); // 7000s
  assert.equal(report.staleMarkets[1].marketId, 3); // 6000s
});

test("staleMarketWatch: skips malformed events and records skipped count", () => {
  const events = [
    null,
    {},
    { payload: "not an object" },
    { payload: { name: "market_created", marketId: "not-a-number" } },
    { payload: { name: "claim_created", claimId: -10 } },
    makeSquadEvent({ name: "market_created", marketId: 1, at: 1000 }),
  ];

  const report = staleMarketWatch(events, { nowSec: 2000, thresholdSec: 500 });
  assert.equal(report.skippedEvents, 5);
  assert.equal(report.processedEvents, 1);
  assert.equal(report.summary.totalOpenMarkets, 1);
  assert.equal(report.summary.staleCount, 1);
});

test("renderStaleMarketReport: generates formatted tabular summary with notice", () => {
  const baseTime = 1_700_000_000;
  const events = [
    makeSquadEvent({
      name: "market_created",
      marketId: 101,
      at: baseTime,
      ledger: 500,
      question: "Will protocol v22 activate?",
    }),
  ];

  const report = staleMarketWatch(events, { nowSec: baseTime + 90000, thresholdSec: 86400 });
  const text = renderStaleMarketReport(report);

  assert.match(text, /=== Stale Market Watch Report ===/);
  assert.match(text, /Inferred state only/);
  assert.match(text, /101\s+squad\s+90000/);
  assert.match(text, /Will protocol v22 activate\?/);
});

test("staleMarketWatch: alias staleMarketReport works identically", () => {
  const events = [makeSquadEvent({ name: "market_created", marketId: 1, at: 1000 })];
  const r1 = staleMarketWatch(events, { nowSec: 2000, thresholdSec: 500 });
  const r2 = staleMarketReport(events, { nowSec: 2000, thresholdSec: 500 });
  assert.deepEqual(r1, r2);
});
