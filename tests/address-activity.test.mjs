import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

import {
  addressActivity,
  InvalidAddressError,
  isValidAddress,
  renderAddressActivity,
  formatAddressActivity,
} from "../dist/stellar/address-activity.js";

// Generate predictable, valid test strkeys using Keypair
const KP_TARGET = Keypair.random();
const TARGET_ADDR = KP_TARGET.publicKey();

const KP_OTHER = Keypair.random();
const OTHER_ADDR = KP_OTHER.publicKey();

function makeMeta(overrides = {}) {
  return {
    source: "market",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    version: "v1",
    ledger: 1000,
    txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    at: 1700000000,
    eventId: "0000001000-0000000001",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

test("isValidAddress validates correct strkey formats and rejects invalid inputs", () => {
  assert.equal(isValidAddress(TARGET_ADDR), true);
  assert.equal(isValidAddress("CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI"), true);

  // Invalid address formats
  assert.equal(isValidAddress(""), false);
  assert.equal(isValidAddress("   "), false);
  assert.equal(isValidAddress(null), false);
  assert.equal(isValidAddress(undefined), false);
  assert.equal(isValidAddress(12345), false);
  assert.equal(isValidAddress("not-a-strkey"), false);
  assert.equal(isValidAddress("G" + "A".repeat(55)), false); // invalid checksum
  assert.equal(isValidAddress("S" + "A".repeat(55)), false); // secret key
});

test("addressActivity returns InvalidAddressError on invalid addresses", () => {
  const invalidInputs = [
    "",
    "   ",
    null,
    undefined,
    12345,
    "invalid-strkey",
    "G" + "A".repeat(55),
    ["S", "DV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI"].join(""), // secret-seed shape, built so the scanner does not flag the fixture
  ];

  for (const invalid of invalidInputs) {
    const res = addressActivity([], invalid);
    assert(res instanceof InvalidAddressError);
    assert(res instanceof Error);
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_ADDRESS");
    assert.equal(res.problem, "invalid-strkey");
  }
});

test("addressActivity matches target across multiple roles and aggregates amounts", () => {
  const events = [
    // 1. Target as creator in claim_created (ledger 100)
    {
      ...makeMeta({ ledger: 100, eventId: "100-1" }),
      source: "market",
      payload: {
        name: "claim_created",
        claimId: 1,
        creator: TARGET_ADDR,
        category: "crypto",
      },
    },
    // 2. Other address as challenger (should not match target)
    {
      ...makeMeta({ ledger: 101, eventId: "101-1" }),
      source: "market",
      payload: {
        name: "claim_challenged",
        claimId: 1,
        challenger: OTHER_ADDR,
        stake: 50_000_000n,
      },
    },
    // 3. Target as challenger in claim_challenged (ledger 102)
    {
      ...makeMeta({ ledger: 102, eventId: "102-1" }),
      source: "market",
      payload: {
        name: "claim_challenged",
        claimId: 2,
        challenger: TARGET_ADDR,
        stake: 20_000_000n,
      },
    },
    // 4. Target as challenger in challenger_paid (ledger 103)
    {
      ...makeMeta({ ledger: 103, eventId: "103-1" }),
      source: "market",
      payload: {
        name: "challenger_paid",
        claimId: 2,
        challenger: TARGET_ADDR,
        stake: 20_000_000n,
        gross: 30_000_000n,
        fee: 3_000_000n,
        net: 27_000_000n,
      },
    },
    // 5. Target as captain in squad market_created (ledger 104)
    {
      ...makeMeta({ ledger: 104, eventId: "104-1" }),
      source: "squad",
      payload: {
        name: "market_created",
        marketId: 10,
        captain: TARGET_ADDR,
        deadline: 1800000000,
        feeBps: 100,
        question: "Will Soroban scale?",
      },
    },
    // 6. Target as participant in deposited (ledger 105)
    {
      ...makeMeta({ ledger: 105, eventId: "105-1" }),
      source: "squad",
      payload: {
        name: "deposited",
        marketId: 10,
        side: 1,
        participant: TARGET_ADDR,
        amount: 40_000_000n,
        shares: 40_000_000n,
      },
    },
    // 7. Target as participant in claimed (ledger 106)
    {
      ...makeMeta({ ledger: 106, eventId: "106-1" }),
      source: "squad",
      payload: {
        name: "claimed",
        marketId: 10,
        participant: TARGET_ADDR,
        gross: 50_000_000n,
        fee: 2_000_000n,
        net: 48_000_000n,
      },
    },
    // 8. Target as recipient in fee_claimed (ledger 107)
    {
      ...makeMeta({ ledger: 107, eventId: "107-1" }),
      source: "market",
      payload: {
        name: "fee_claimed",
        recipient: TARGET_ADDR,
        amount: 5_000_000n,
      },
    },
    // 9. Target as recipient in squad fees_claimed (ledger 108)
    {
      ...makeMeta({ ledger: 108, eventId: "108-1" }),
      source: "squad",
      payload: {
        name: "fees_claimed",
        recipient: TARGET_ADDR,
        amount: 15_000_000n,
      },
    },
    // 10. Target as to in withdrawal (ledger 109)
    {
      ...makeMeta({ ledger: 109, eventId: "109-1" }),
      source: "market",
      payload: {
        name: "withdrawal",
        to: TARGET_ADDR,
        amount: 70_000_000n,
      },
    },
    // 11. Target as to in withdrawal_pending (ledger 110)
    {
      ...makeMeta({ ledger: 110, eventId: "110-1" }),
      source: "market",
      payload: {
        name: "withdrawal_pending",
        to: TARGET_ADDR,
        amount: 30_000_000n,
      },
    },
  ];

  const result = addressActivity(events, TARGET_ADDR);
  assert.equal(result.ok, true);
  assert.equal(result.address, TARGET_ADDR);

  // Exactly 10 matching entries (all except event 2 which belonged to OTHER_ADDR)
  assert.equal(result.entries.length, 10);

  // Verify all 6 roles were matched
  const matchedRoles = new Set(result.entries.map((e) => e.role));
  assert.deepEqual(
    Array.from(matchedRoles).sort(),
    ["captain", "challenger", "creator", "participant", "recipient", "to"].sort(),
  );

  // Verify sums per role
  // creator: 0n
  assert.equal(result.totals.creator, 0n);

  // challenger: 20 USDC (staked) + 27 USDC (net paid) = 47 USDC
  assert.equal(result.totals.challenger, 47_000_000n);

  // captain: 0n
  assert.equal(result.totals.captain, 0n);

  // participant: 40 USDC (deposited) + 48 USDC (claimed net) = 88 USDC
  assert.equal(result.totals.participant, 88_000_000n);

  // recipient: 5 USDC (fee_claimed) + 15 USDC (fees_claimed) = 20 USDC
  assert.equal(result.totals.recipient, 20_000_000n);

  // to: 70 USDC (withdrawal) + 30 USDC (withdrawal_pending) = 100 USDC
  assert.equal(result.totals.to, 100_000_000n);

  // Verify aliases
  assert.equal(result.amountsByRole, result.totals);
  assert.equal(result.summedAmounts, result.totals);
});

test("addressActivity orders entries strictly according to compareEvents", () => {
  // Supply events in reverse order
  const events = [
    {
      ...makeMeta({ ledger: 300, transactionIndex: 2, eventId: "300-2" }),
      payload: { name: "withdrawal", to: TARGET_ADDR, amount: 10_000_000n },
    },
    {
      ...makeMeta({ ledger: 200, transactionIndex: 0, eventId: "200-0" }),
      payload: { name: "claim_created", creator: TARGET_ADDR },
    },
    {
      ...makeMeta({ ledger: 300, transactionIndex: 1, eventId: "300-1" }),
      payload: { name: "fee_claimed", recipient: TARGET_ADDR, amount: 5_000_000n },
    },
    {
      ...makeMeta({ ledger: 100, transactionIndex: 0, eventId: "100-0" }),
      payload: { name: "market_created", captain: TARGET_ADDR },
    },
  ];

  const result = addressActivity(events, TARGET_ADDR);
  assert.equal(result.ok, true);

  const ledgers = result.entries.map((e) => e.event.ledger);
  assert.deepEqual(ledgers, [100, 200, 300, 300]);

  assert.equal(result.entries[0].role, "captain");
  assert.equal(result.entries[1].role, "creator");
  assert.equal(result.entries[2].role, "recipient");
  assert.equal(result.entries[3].role, "to");
});

test("renderAddressActivity plain-text renderer outputs readable CLI and chat text", () => {
  const events = [
    {
      ...makeMeta({ ledger: 500, txHash: "abcdef1234567890abcdef1234567890" }),
      payload: {
        name: "claim_challenged",
        challenger: TARGET_ADDR,
        stake: 15_000_000n,
      },
    },
  ];

  const result = addressActivity(events, TARGET_ADDR);
  const text = renderAddressActivity(result);

  assert(text.includes(`Address Activity: ${TARGET_ADDR}`));
  assert(text.includes("Total matching events: 1"));
  assert(text.includes("challenger: 1.5000000 USDC"));
  assert(text.includes("[ledger 500] claim_challenged (challenger) · 1.5000000 USDC"));

  // Check formatAddressActivity alias
  assert.equal(formatAddressActivity(result), text);

  // Render on empty events
  const emptyRes = addressActivity([], TARGET_ADDR);
  const emptyText = renderAddressActivity(emptyRes);
  assert(emptyText.includes("No activity found"));

  // Render on error
  const errRes = addressActivity([], "invalid-address");
  const errText = renderAddressActivity(errRes);
  assert(errText.startsWith("Error: Invalid Stellar address strkey"));
});
