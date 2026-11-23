import assert from "node:assert/strict";
import test from "node:test";

import { squadPayouts } from "../dist/stellar/squad-payouts.js";

const ADDR_A = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA";
const ADDR_B = "GB7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVBBB";
const ADDR_C = "GC7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJCCCC";
const ADDR_D = "GD7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJDDDD";

// ── Empty and Non-Event Inputs ──────────────────────────────────────────────

test("squadPayouts returns zeroed totals on empty event stream", () => {
  const result = squadPayouts([]);
  assert.equal(result.totalGross, 0n);
  assert.equal(result.totalFees, 0n);
  assert.equal(result.totalNet, 0n);
  assert.equal(result.totalClaims, 0);
  assert.equal(result.markets.length, 0);
  assert.equal(result.topRecipients.length, 0);
  assert.equal(result.participants.length, 0);
  assert.equal(result.violations.length, 0);
  assert.equal(result.byMarket.size, 0);
  assert.equal(result.byParticipant.size, 0);
});

test("squadPayouts ignores non-squad and non-payout events safely", () => {
  const events = [
    null,
    undefined,
    42,
    "string",
    {},
    { name: "deposited", marketId: 1, amount: 1000n },
    { payload: { name: "market_created", marketId: 1 } },
    { payload: { name: "claim_created", claimId: 2 } },
  ];

  const result = squadPayouts(events);
  assert.equal(result.totalGross, 0n);
  assert.equal(result.totalClaims, 0);
  assert.equal(result.markets.length, 0);
  assert.equal(result.violations.length, 0);
});

// ── Consistent Events ────────────────────────────────────────────────────────

test("squadPayouts aggregates a single consistent claim event", () => {
  const event = {
    source: "squad",
    ledger: 100,
    txHash: "a".repeat(64),
    eventId: "100-1",
    payload: {
      name: "claimed",
      marketId: 1,
      participant: ADDR_A,
      gross: 100_000_000n,
      fee: 2_000_000n,
      net: 98_000_000n,
    },
  };

  const result = squadPayouts([event]);

  // Acceptance criteria: no violations when gross = fee + net
  assert.equal(result.violations.length, 0);

  // Overall aggregates
  assert.equal(result.totalGross, 100_000_000n);
  assert.equal(result.totalFees, 2_000_000n);
  assert.equal(result.totalNet, 98_000_000n);
  assert.equal(result.totalClaims, 1);

  // Per-market aggregates
  assert.equal(result.markets.length, 1);
  const m1 = result.markets[0];
  assert.equal(m1.marketId, 1);
  assert.equal(m1.gross, 100_000_000n);
  assert.equal(m1.fee, 2_000_000n);
  assert.equal(m1.net, 98_000_000n);
  assert.equal(m1.claimsCount, 1);
  assert.equal(m1.resolved, false);
  assert.equal(m1.violations.length, 0);

  // Recipient totals
  assert.equal(result.topRecipients.length, 1);
  const r1 = result.topRecipients[0];
  assert.equal(r1.participant, ADDR_A);
  assert.equal(r1.gross, 100_000_000n);
  assert.equal(r1.fee, 2_000_000n);
  assert.equal(r1.net, 98_000_000n);
  assert.equal(r1.claimsCount, 1);
  assert.deepEqual(r1.marketIds, [1]);
});

test("squadPayouts aggregates multiple claims across markets and participants", () => {
  const events = [
    // Market 1, ADDR_A
    {
      payload: {
        name: "claimed",
        marketId: 1,
        participant: ADDR_A,
        gross: 50_000_000n,
        fee: 1_000_000n,
        net: 49_000_000n,
      },
    },
    // Market 1, ADDR_B
    {
      payload: {
        name: "claimed",
        marketId: 1,
        participant: ADDR_B,
        gross: 30_000_000n,
        fee: 600_000n,
        net: 29_400_000n,
      },
    },
    // Market 2, ADDR_A
    {
      payload: {
        name: "claimed",
        marketId: 2,
        participant: ADDR_A,
        gross: 70_000_000n,
        fee: 1_400_000n,
        net: 68_600_000n,
      },
    },
    // Market 2, ADDR_C
    {
      payload: {
        name: "claimed",
        marketId: 2,
        participant: ADDR_C,
        gross: 10_000_000n,
        fee: 200_000n,
        net: 9_800_000n,
      },
    },
    // Market 1 resolution
    {
      payload: {
        name: "resolved",
        marketId: 1,
        result: 1,
        poolA: 100_000_000n,
        poolB: 80_000_000n,
      },
    },
  ];

  const result = squadPayouts(events);

  assert.equal(result.violations.length, 0);
  assert.equal(result.totalGross, 160_000_000n);
  assert.equal(result.totalFees, 3_200_000n);
  assert.equal(result.totalNet, 156_800_000n);
  assert.equal(result.totalClaims, 4);

  // Check markets
  assert.equal(result.markets.length, 2);
  const m1 = result.byMarket.get(1);
  assert.ok(m1);
  assert.equal(m1.marketId, 1);
  assert.equal(m1.gross, 80_000_000n);
  assert.equal(m1.fee, 1_600_000n);
  assert.equal(m1.net, 78_400_000n);
  assert.equal(m1.claimsCount, 2);
  assert.equal(m1.resolved, true);
  assert.equal(m1.result, 1);
  assert.equal(m1.poolA, 100_000_000n);
  assert.equal(m1.poolB, 80_000_000n);

  const m2 = result.byMarket.get(2);
  assert.ok(m2);
  assert.equal(m2.marketId, 2);
  assert.equal(m2.gross, 80_000_000n);
  assert.equal(m2.fee, 1_600_000n);
  assert.equal(m2.net, 78_400_000n);
  assert.equal(m2.claimsCount, 2);
  assert.equal(m2.resolved, false);

  // Check participant ADDR_A across markets 1 and 2
  const partA = result.byParticipant.get(ADDR_A);
  assert.ok(partA);
  assert.equal(partA.gross, 120_000_000n);
  assert.equal(partA.fee, 2_400_000n);
  assert.equal(partA.net, 117_600_000n);
  assert.equal(partA.claimsCount, 2);
  assert.deepEqual(partA.marketIds, [1, 2]);

  // Top recipients ranking: ADDR_A (net 117.6) > ADDR_B (net 29.4) > ADDR_C (net 9.8)
  assert.equal(result.topRecipients.length, 3);
  assert.equal(result.topRecipients[0].participant, ADDR_A);
  assert.equal(result.topRecipients[1].participant, ADDR_B);
  assert.equal(result.topRecipients[2].participant, ADDR_C);
});

// ── Inconsistent Events & Violations ─────────────────────────────────────────

test("squadPayouts returns violations without throwing when gross != fee + net", () => {
  // Inconsistent event: gross is 100, but fee is 10 and net is 80 (sum = 90)
  const inconsistentEvent = {
    ledger: 200,
    txHash: "b".repeat(64),
    eventId: "200-1",
    payload: {
      name: "claimed",
      marketId: 5,
      participant: ADDR_A,
      gross: 100_000_000n,
      fee: 10_000_000n,
      net: 80_000_000n, // Mismatch: 100 != 10 + 80
    },
  };

  // Acceptance criteria: Violations are returned, not thrown.
  let result;
  assert.doesNotThrow(() => {
    result = squadPayouts([inconsistentEvent]);
  });

  assert.equal(result.violations.length, 1);
  const v = result.violations[0];
  assert.equal(v.marketId, 5);
  assert.equal(v.participant, ADDR_A);
  assert.equal(v.gross, 100_000_000n);
  assert.equal(v.fee, 10_000_000n);
  assert.equal(v.net, 80_000_000n);
  assert.equal(v.expectedGross, 90_000_000n);
  assert.equal(v.expected, 90_000_000n);
  assert.equal(v.difference, 10_000_000n);
  assert.equal(v.ledger, 200);
  assert.equal(v.txHash, "b".repeat(64));
  assert.equal(v.eventId, "200-1");
  assert.match(v.message, /Invariant violation/i);

  // Market-level violations
  const m = result.byMarket.get(5);
  assert.ok(m);
  assert.equal(m.violations.length, 1);
  assert.equal(m.violations[0], v);
});

test("squadPayouts separates consistent and inconsistent events cleanly", () => {
  const events = [
    // Consistent on market 1
    {
      payload: {
        name: "claimed",
        marketId: 1,
        participant: ADDR_A,
        gross: 50_000_000n,
        fee: 1_000_000n,
        net: 49_000_000n,
      },
    },
    // Inconsistent on market 1: fee + net > gross
    {
      payload: {
        name: "claimed",
        marketId: 1,
        participant: ADDR_B,
        gross: 30_000_000n,
        fee: 5_000_000n,
        net: 28_000_000n, // sum = 33m, gross = 30m
      },
    },
    // Consistent on market 2
    {
      payload: {
        name: "claimed",
        marketId: 2,
        participant: ADDR_C,
        gross: 20_000_000n,
        fee: 0n,
        net: 20_000_000n,
      },
    },
    // Inconsistent on market 2: fee + net < gross
    {
      payload: {
        name: "claimed",
        marketId: 2,
        participant: ADDR_D,
        gross: 40_000_000n,
        fee: 1_000_000n,
        net: 30_000_000n, // sum = 31m, gross = 40m
      },
    },
  ];

  const result = squadPayouts(events);

  // Total 2 violations recorded
  assert.equal(result.violations.length, 2);

  const v1 = result.violations.find((v) => v.marketId === 1 && v.participant === ADDR_B);
  assert.ok(v1);
  assert.equal(v1.difference, -3_000_000n);

  const v2 = result.violations.find((v) => v.marketId === 2 && v.participant === ADDR_D);
  assert.ok(v2);
  assert.equal(v2.difference, 9_000_000n);

  // Each market has exactly 1 violation
  assert.equal(result.byMarket.get(1).violations.length, 1);
  assert.equal(result.byMarket.get(2).violations.length, 1);
});

test("squadPayouts reports negative amounts as violations", () => {
  const event = {
    payload: {
      name: "claimed",
      marketId: 3,
      participant: ADDR_A,
      gross: -10n,
      fee: -2n,
      net: -8n, // sum balances but amounts are negative!
    },
  };

  const result = squadPayouts([event]);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].reason, /Negative amount/i);
});

test("squadPayouts handles malformed claimed payloads without throwing", () => {
  const events = [
    { payload: { name: "claimed", marketId: "not-a-number", participant: ADDR_A } },
    { payload: { name: "claimed", marketId: 1, participant: "", gross: 100n } },
    { payload: { name: "claimed", marketId: 1, participant: ADDR_A, gross: "invalid" } },
  ];

  let result;
  assert.doesNotThrow(() => {
    result = squadPayouts(events);
  });

  assert.equal(result.violations.length, 3);
  for (const v of result.violations) {
    assert.match(v.reason, /Malformed/i);
  }
});

// ── Deterministic Ordering ──────────────────────────────────────────────────

test("squadPayouts produces deterministic ordering regardless of input sequence", () => {
  const rawEvents = [
    {
      payload: {
        name: "claimed",
        marketId: 10,
        participant: ADDR_C,
        gross: 10_000_000n,
        fee: 100_000n,
        net: 9_900_000n,
      },
    },
    {
      payload: {
        name: "claimed",
        marketId: 2,
        participant: ADDR_A,
        gross: 100_000_000n,
        fee: 1_000_000n,
        net: 99_000_000n,
      },
    },
    {
      payload: {
        name: "claimed",
        marketId: 5,
        participant: ADDR_B,
        gross: 50_000_000n,
        fee: 500_000n,
        net: 49_500_000n,
      },
    },
    {
      payload: {
        name: "claimed",
        marketId: 2,
        participant: ADDR_D,
        gross: 20_000_000n,
        fee: 200_000n,
        net: 19_800_000n,
      },
    },
    // Inconsistent event
    {
      payload: {
        name: "claimed",
        marketId: 1,
        participant: ADDR_B,
        gross: 5_000_000n,
        fee: 100_000n,
        net: 4_000_000n,
      },
    },
  ];

  const reversedEvents = [...rawEvents].reverse();
  const shuffledEvents = [rawEvents[2], rawEvents[0], rawEvents[4], rawEvents[1], rawEvents[3]];

  const result1 = squadPayouts(rawEvents);
  const result2 = squadPayouts(reversedEvents);
  const result3 = squadPayouts(shuffledEvents);

  // Markets must be ordered deterministically by marketId ascending: [1, 2, 5, 10]
  const expectedMarketIds = [1, 2, 5, 10];
  assert.deepEqual(result1.markets.map((m) => m.marketId), expectedMarketIds);
  assert.deepEqual(result2.markets.map((m) => m.marketId), expectedMarketIds);
  assert.deepEqual(result3.markets.map((m) => m.marketId), expectedMarketIds);

  // Top recipients must be ordered deterministically by net desc:
  // ADDR_A (99m) > ADDR_B (49.5m + 4m = 53.5m) > ADDR_D (19.8m) > ADDR_C (9.9m)
  const expectedRecipients = [ADDR_A, ADDR_B, ADDR_D, ADDR_C];
  assert.deepEqual(result1.topRecipients.map((r) => r.participant), expectedRecipients);
  assert.deepEqual(result2.topRecipients.map((r) => r.participant), expectedRecipients);
  assert.deepEqual(result3.topRecipients.map((r) => r.participant), expectedRecipients);

  // Violations must be identically ordered
  assert.deepEqual(
    result1.violations.map((v) => ({ marketId: v.marketId, participant: v.participant })),
    result2.violations.map((v) => ({ marketId: v.marketId, participant: v.participant })),
  );
  assert.deepEqual(
    result1.violations.map((v) => ({ marketId: v.marketId, participant: v.participant })),
    result3.violations.map((v) => ({ marketId: v.marketId, participant: v.participant })),
  );
});

test("squadPayouts breaks recipient ties deterministically", () => {
  // Two participants with identical net and gross
  const events = [
    {
      payload: {
        name: "claimed",
        marketId: 1,
        participant: ADDR_B,
        gross: 50_000_000n,
        fee: 1_000_000n,
        net: 49_000_000n,
      },
    },
    {
      payload: {
        name: "claimed",
        marketId: 1,
        participant: ADDR_A,
        gross: 50_000_000n,
        fee: 1_000_000n,
        net: 49_000_000n,
      },
    },
  ];

  const result1 = squadPayouts(events);
  const result2 = squadPayouts([...events].reverse());

  // ADDR_A precedes ADDR_B alphabetically when payout amounts are tied
  assert.equal(result1.topRecipients[0].participant, ADDR_A);
  assert.equal(result1.topRecipients[1].participant, ADDR_B);

  assert.equal(result2.topRecipients[0].participant, ADDR_A);
  assert.equal(result2.topRecipients[1].participant, ADDR_B);
});

// ── Bigint Arithmetic & Limits ───────────────────────────────────────────────

test("squadPayouts uses bigint throughout without precision loss", () => {
  // Huge atomic amounts exceeding Number.MAX_SAFE_INTEGER
  const hugeGross = 10_000_000_000_000_000_000_000n;
  const hugeFee = 1_000_000_000_000_000_000n;
  const hugeNet = 9_999_000_000_000_000_000_000n;

  const event = {
    payload: {
      name: "claimed",
      marketId: 1,
      participant: ADDR_A,
      gross: hugeGross,
      fee: hugeFee,
      net: hugeNet,
    },
  };

  const result = squadPayouts([event]);

  assert.equal(typeof result.totalGross, "bigint");
  assert.equal(typeof result.totalFees, "bigint");
  assert.equal(typeof result.totalNet, "bigint");
  assert.equal(typeof result.markets[0].gross, "bigint");
  assert.equal(typeof result.topRecipients[0].net, "bigint");

  assert.equal(result.totalGross, hugeGross);
  assert.equal(result.totalFees, hugeFee);
  assert.equal(result.totalNet, hugeNet);
  assert.equal(result.violations.length, 0);
});

test("squadPayouts accepts decimal string amounts from JSON fixtures", () => {
  const event = {
    payload: {
      name: "claimed",
      marketId: 3,
      participant: ADDR_A,
      gross: "50000000",
      fee: "1000000",
      net: "49000000",
    },
  };

  const result = squadPayouts([event]);

  assert.equal(result.totalGross, 50_000_000n);
  assert.equal(result.totalFees, 1_000_000n);
  assert.equal(result.totalNet, 49_000_000n);
  assert.equal(result.violations.length, 0);
});

test("squadPayouts topLimit option caps topRecipients length", () => {
  const events = [
    { payload: { name: "claimed", marketId: 1, participant: ADDR_A, gross: 40n, fee: 0n, net: 40n } },
    { payload: { name: "claimed", marketId: 1, participant: ADDR_B, gross: 30n, fee: 0n, net: 30n } },
    { payload: { name: "claimed", marketId: 1, participant: ADDR_C, gross: 20n, fee: 0n, net: 20n } },
  ];

  const result = squadPayouts(events, { topLimit: 2 });

  assert.equal(result.topRecipients.length, 2);
  assert.equal(result.topRecipients[0].participant, ADDR_A);
  assert.equal(result.topRecipients[1].participant, ADDR_B);

  // All participants are still retained in .participants
  assert.equal(result.participants.length, 3);
});
