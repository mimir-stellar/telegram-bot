import assert from "node:assert/strict";
import test from "node:test";

import { aggregateSquadFlows } from "../dist/stellar/squad-flows.js";
import { squadFlowsMessage } from "../dist/notifications/squad-flows.js";

const ADDR_ALICE = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA";
const ADDR_BOB = "GB7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVBBB";
const ADDR_CHARLIE = "GC7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJCCCC";

function makeDepositedEvent(marketId, side, participant, amount, extra = {}) {
  return {
    source: "squad",
    ledger: 100,
    txHash: "a".repeat(64),
    eventId: `100-${marketId}-${side}`,
    payload: {
      name: "deposited",
      marketId,
      side,
      participant,
      amount,
      shares: amount,
      ...extra,
    },
  };
}

function makeWithdrawnEvent(marketId, side, participant, amount, extra = {}) {
  return {
    source: "squad",
    ledger: 101,
    txHash: "b".repeat(64),
    eventId: `101-${marketId}-${side}`,
    payload: {
      name: "withdrawn",
      marketId,
      side,
      participant,
      amount,
      ...extra,
    },
  };
}

// ── Empty and Non-Event Inputs ──────────────────────────────────────────────

test("aggregateSquadFlows returns zeroed empty result on null/empty inputs", () => {
  for (const empty of [[], null, undefined]) {
    const result = aggregateSquadFlows(empty);
    assert.equal(result.length, 0);
    assert.equal(result.totalDeposits, 0n);
    assert.equal(result.totalWithdrawals, 0n);
    assert.equal(result.totalNet, 0n);
    assert.equal(result.uniqueParticipants, 0);
    assert.equal(result.byMarket.size, 0);
    assert.equal(result.get(1), undefined);
  }
});

test("aggregateSquadFlows safely ignores unrelated and malformed events", () => {
  const events = [
    null,
    undefined,
    123,
    "string",
    {},
    { payload: null },
    { payload: { name: "market_created", marketId: 1 } },
    { payload: { name: "claimed", marketId: 1, gross: 100n, fee: 10n, net: 90n } },
    { payload: { name: "resolved", marketId: 1, result: 1 } },
    { payload: { name: "claim_created", claimId: 1 } },
    { payload: { name: "deposited", marketId: -1, side: 1, participant: ADDR_ALICE, amount: 100n } },
    { payload: { name: "deposited", marketId: 1, side: 1, participant: "", amount: 100n } },
    { payload: { name: "deposited", marketId: 1, side: 1, participant: ADDR_ALICE, amount: -50n } },
  ];

  const result = aggregateSquadFlows(events);
  assert.equal(result.length, 0);
  assert.equal(result.totalDeposits, 0n);
  assert.equal(result.totalWithdrawals, 0n);
  assert.equal(result.totalNet, 0n);
});

// ── Deposits ────────────────────────────────────────────────────────────────

test("aggregates single deposit event with correct bigint amounts and participant", () => {
  const event = makeDepositedEvent(1, 1, ADDR_ALICE, 50_000_000n);
  const flows = aggregateSquadFlows([event]);

  assert.equal(flows.length, 1);
  const market = flows[0];
  assert.equal(market.marketId, 1);
  assert.equal(market.deposits, 50_000_000n);
  assert.equal(market.withdrawals, 0n);
  assert.equal(market.net, 50_000_000n);
  assert.equal(typeof market.net, "bigint");
  assert.equal(market.uniqueParticipants, 1);

  assert.equal(market.sides.length, 1);
  const side1 = market.sides[0];
  assert.equal(side1.side, 1);
  assert.equal(side1.deposits, 50_000_000n);
  assert.equal(side1.withdrawals, 0n);
  assert.equal(side1.net, 50_000_000n);
  assert.equal(typeof side1.net, "bigint");
  assert.equal(side1.uniqueParticipants, 1);
  assert.deepEqual(side1.participants, [ADDR_ALICE]);
});

test("deduplicates participant count across multiple deposits on same side", () => {
  const events = [
    makeDepositedEvent(1, 1, ADDR_ALICE, 10_000_000n),
    makeDepositedEvent(1, 1, ADDR_ALICE, 20_000_000n),
    makeDepositedEvent(1, 1, ADDR_ALICE, 30_000_000n),
  ];

  const flows = aggregateSquadFlows(events);
  const side = flows[0].sides[0];

  assert.equal(side.deposits, 60_000_000n);
  assert.equal(side.withdrawals, 0n);
  assert.equal(side.net, 60_000_000n);
  assert.equal(typeof side.net, "bigint");
  // Alice deposited 3 times, but is 1 unique participant
  assert.equal(side.uniqueParticipants, 1);
  assert.deepEqual(side.participants, [ADDR_ALICE]);
});

test("aggregates multiple participants on the same side", () => {
  const events = [
    makeDepositedEvent(1, 1, ADDR_ALICE, 25_000_000n),
    makeDepositedEvent(1, 1, ADDR_BOB, 75_000_000n),
  ];

  const flows = aggregateSquadFlows(events);
  const side = flows[0].sides[0];

  assert.equal(side.deposits, 100_000_000n);
  assert.equal(side.net, 100_000_000n);
  assert.equal(side.uniqueParticipants, 2);
  assert.deepEqual(side.participants, [ADDR_ALICE, ADDR_BOB].sort());
});

// ── Partial and Full Withdrawals ────────────────────────────────────────────

test("handles partial withdrawals calculating accurate net bigint flow", () => {
  const events = [
    makeDepositedEvent(1, 1, ADDR_ALICE, 100_000_000n),
    makeWithdrawnEvent(1, 1, ADDR_ALICE, 30_000_000n),
  ];

  const flows = aggregateSquadFlows(events);
  const side = flows[0].sides[0];

  assert.equal(side.deposits, 100_000_000n);
  assert.equal(side.withdrawals, 30_000_000n);
  assert.equal(side.net, 70_000_000n);
  assert.equal(typeof side.net, "bigint");
  assert.equal(side.uniqueParticipants, 1);
});

test("handles sequential partial withdrawals and full withdrawals", () => {
  const events = [
    makeDepositedEvent(1, 1, ADDR_ALICE, 100_000_000n),
    makeWithdrawnEvent(1, 1, ADDR_ALICE, 20_000_000n),
    makeWithdrawnEvent(1, 1, ADDR_ALICE, 30_000_000n),
    makeWithdrawnEvent(1, 1, ADDR_ALICE, 50_000_000n),
  ];

  const flows = aggregateSquadFlows(events);
  const side = flows[0].sides[0];

  assert.equal(side.deposits, 100_000_000n);
  assert.equal(side.withdrawals, 100_000_000n);
  assert.equal(side.net, 0n);
  assert.equal(typeof side.net, "bigint");
  assert.equal(side.uniqueParticipants, 1);
});

// ── Per-Side Participant Uniqueness ─────────────────────────────────────────

test("counts participants uniquely per side (acceptance criterion)", () => {
  // Alice participates on both Side 1 and Side 2
  // Bob participates only on Side 1
  // Charlie participates only on Side 2
  const events = [
    makeDepositedEvent(1, 1, ADDR_ALICE, 10_000_000n),
    makeDepositedEvent(1, 1, ADDR_BOB, 20_000_000n),
    makeDepositedEvent(1, 2, ADDR_ALICE, 30_000_000n),
    makeDepositedEvent(1, 2, ADDR_CHARLIE, 40_000_000n),
    // Alice partially withdraws from Side 1
    makeWithdrawnEvent(1, 1, ADDR_ALICE, 5_000_000n),
  ];

  const flows = aggregateSquadFlows(events);
  const market = flows[0];

  assert.equal(market.sides.length, 2);

  // Side 1: Alice and Bob
  const side1 = market.sides.get(1);
  assert.ok(side1);
  assert.equal(side1.side, 1);
  assert.equal(side1.deposits, 30_000_000n);
  assert.equal(side1.withdrawals, 5_000_000n);
  assert.equal(side1.net, 25_000_000n);
  assert.equal(typeof side1.net, "bigint");
  assert.equal(side1.uniqueParticipants, 2);
  assert.deepEqual(side1.participants, [ADDR_ALICE, ADDR_BOB].sort());

  // Side 2: Alice and Charlie
  const side2 = market.sides.get(2);
  assert.ok(side2);
  assert.equal(side2.side, 2);
  assert.equal(side2.deposits, 70_000_000n);
  assert.equal(side2.withdrawals, 0n);
  assert.equal(side2.net, 70_000_000n);
  assert.equal(typeof side2.net, "bigint");
  assert.equal(side2.uniqueParticipants, 2);
  assert.deepEqual(side2.participants, [ADDR_ALICE, ADDR_CHARLIE].sort());

  // Market overall totals
  assert.equal(market.totalDeposits, 100_000_000n);
  assert.equal(market.totalWithdrawals, 5_000_000n);
  assert.equal(market.totalNet, 95_000_000n);
  assert.equal(market.uniqueParticipants, 3); // Alice, Bob, Charlie across the market
});

// ── Multiple Markets ────────────────────────────────────────────────────────

test("aggregates multiple markets with independent per-side totals", () => {
  const events = [
    // Market 2 events
    makeDepositedEvent(2, 1, ADDR_BOB, 40_000_000n),
    makeWithdrawnEvent(2, 1, ADDR_BOB, 10_000_000n),
    // Market 1 events
    makeDepositedEvent(1, 1, ADDR_ALICE, 50_000_000n),
    makeDepositedEvent(1, 2, ADDR_CHARLIE, 60_000_000n),
    // Market 3 events
    makeDepositedEvent(3, 1, ADDR_ALICE, 90_000_000n),
  ];

  const flows = aggregateSquadFlows(events);

  // Markets sorted ascending by marketId
  assert.equal(flows.length, 3);
  assert.equal(flows[0].marketId, 1);
  assert.equal(flows[1].marketId, 2);
  assert.equal(flows[2].marketId, 3);

  // Lookup helpers
  assert.equal(flows.get(1)?.marketId, 1);
  assert.equal(flows.get(2)?.marketId, 2);
  assert.equal(flows.get(3)?.marketId, 3);
  assert.equal(flows.has(2), true);
  assert.equal(flows.has(99), false);

  // Market 1 checks
  const m1 = flows.get(1);
  assert.equal(m1.deposits, 110_000_000n);
  assert.equal(m1.withdrawals, 0n);
  assert.equal(m1.net, 110_000_000n);

  // Market 2 checks
  const m2 = flows.get(2);
  assert.equal(m2.deposits, 40_000_000n);
  assert.equal(m2.withdrawals, 10_000_000n);
  assert.equal(m2.net, 30_000_000n);

  // Market 3 checks
  const m3 = flows.get(3);
  assert.equal(m3.deposits, 90_000_000n);
  assert.equal(m3.withdrawals, 0n);
  assert.equal(m3.net, 90_000_000n);

  // Aggregate totals
  assert.equal(flows.totalDeposits, 240_000_000n);
  assert.equal(flows.totalWithdrawals, 10_000_000n);
  assert.equal(flows.totalNet, 230_000_000n);
});

// ── Precision and Large BigInt (Net never converts to number) ────────────────

test("handles large bigint values beyond MAX_SAFE_INTEGER without precision loss", () => {
  // 50 billion USDC in atomic units (7 decimals) > 2^53 - 1
  const hugeDeposit = 500_000_000_000_000_000_000n;
  const hugeWithdrawal = 100_000_000_000_000_000_000n;
  const expectedNet = 400_000_000_000_000_000_000n;

  const events = [
    makeDepositedEvent(10, 1, ADDR_ALICE, hugeDeposit),
    makeWithdrawnEvent(10, 1, ADDR_ALICE, hugeWithdrawal),
  ];

  const flows = aggregateSquadFlows(events);
  const side = flows.get(10)?.sides.get(1);

  assert.ok(side);
  assert.equal(side.deposits, hugeDeposit);
  assert.equal(side.withdrawals, hugeWithdrawal);
  assert.equal(side.net, expectedNet);
  assert.equal(typeof side.net, "bigint");

  // Format message to ensure net is not truncated/converted to float
  const message = squadFlowsMessage(flows);
  assert.match(message, /40000000000000\\\.0000000 USDC/);
});

test("handles net negative flows when withdrawals exceed deposits", () => {
  const events = [
    makeDepositedEvent(5, 1, ADDR_ALICE, 20_000_000n),
    makeWithdrawnEvent(5, 1, ADDR_ALICE, 50_000_000n),
  ];

  const flows = aggregateSquadFlows(events);
  const side = flows.get(5)?.sides.get(1);

  assert.ok(side);
  assert.equal(side.net, -30_000_000n);
  assert.equal(typeof side.net, "bigint");

  const message = squadFlowsMessage(flows);
  assert.match(message, /\\-3\\\.0000000 USDC/);
});

// ── Raw Payload vs Wrapped Event ────────────────────────────────────────────

test("handles both raw payload and wrapped event shapes", () => {
  const rawPayload = {
    name: "deposited",
    marketId: 7,
    side: 1,
    participant: ADDR_ALICE,
    amount: 15_000_000n,
  };
  const wrappedEvent = makeDepositedEvent(7, 1, ADDR_BOB, 25_000_000n);

  const flows = aggregateSquadFlows([rawPayload, wrappedEvent]);
  const market = flows.get(7);

  assert.ok(market);
  assert.equal(market.deposits, 40_000_000n);
  assert.equal(market.uniqueParticipants, 2);
});

// ── squadFlowsMessage Formatting ────────────────────────────────────────────

test("squadFlowsMessage formats empty flows fallback cleanly", () => {
  const msgEmpty = squadFlowsMessage([]);
  assert.match(msgEmpty, /📊 \*Squad Market Net Flows\*/);
  assert.match(msgEmpty, /No deposit or withdrawal flows recorded/);

  const msgNull = squadFlowsMessage(null);
  assert.match(msgNull, /No deposit or withdrawal flows recorded/);
});

test("squadFlowsMessage formats single market with Side A and Side B", () => {
  const events = [
    makeDepositedEvent(42, 1, ADDR_ALICE, 100_000_000n),
    makeWithdrawnEvent(42, 1, ADDR_ALICE, 20_000_000n),
    makeDepositedEvent(42, 2, ADDR_BOB, 50_000_000n),
  ];

  const flows = aggregateSquadFlows(events);
  const message = squadFlowsMessage(flows[0]);

  // Contains market header
  assert.match(message, /📊 \*Squad Market #42 Net Flows\*/);

  // Contains Side A and Side B labels
  assert.match(message, /\*Side A\*/);
  assert.match(message, /\*Side B\*/);

  // Side A: net +8.0000000 USDC, 1 participant
  assert.ok(message.includes("8\\.0000000 USDC"));
  assert.match(message, /1 participant/);

  // Side B: net +5.0000000 USDC, 1 participant
  assert.ok(message.includes("5\\.0000000 USDC"));
});

test("squadFlowsMessage formats multiple markets collection", () => {
  const events = [
    makeDepositedEvent(1, 1, ADDR_ALICE, 10_000_000n),
    makeDepositedEvent(2, 2, ADDR_BOB, 20_000_000n),
  ];

  const flows = aggregateSquadFlows(events);
  const message = squadFlowsMessage(flows);

  assert.match(message, /📊 \*Squad Market Net Flows\*/);
  assert.match(message, /\*Market #1\*/);
  assert.match(message, /\*Market #2\*/);
  assert.ok(message.includes("1\\.0000000 USDC"));
  assert.ok(message.includes("2\\.0000000 USDC"));
});
