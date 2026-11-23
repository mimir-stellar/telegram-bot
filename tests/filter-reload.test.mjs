import assert from "node:assert/strict";
import test from "node:test";

import {
  AtomicFilterReloader,
  compileFilterConfig,
  evaluateFilterSet,
  FilterConfigValidationError,
} from "../dist/notifications/filter-reload.js";

function mockEvent(source, payload) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    version: "v1",
    ledger: 1000,
    txHash: "0000000000000000000000000000000000000000000000000000000000000000",
    at: 1700000000,
    eventId: "1000-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

const smallChallenge = mockEvent("market", {
  name: "claim_challenged",
  claimId: 1,
  challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  stake: 50_000_000n, // 5 USDC
});

const largeChallenge = mockEvent("market", {
  name: "claim_challenged",
  claimId: 2,
  challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  stake: 500_000_000n, // 50 USDC
});

const sportsClaim = mockEvent("market", {
  name: "claim_created",
  claimId: 3,
  creator: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  category: "sports",
  title: "Match outcome",
});

const cryptoClaim = mockEvent("market", {
  name: "claim_created",
  claimId: 4,
  creator: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  category: "crypto",
  title: "BTC price",
});

const smallDeposit = mockEvent("squad", {
  name: "deposited",
  marketId: 10,
  side: 1,
  participant: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  amount: 20_000_000n, // 2 USDC
  shares: 20_000_000n,
});

const largeDeposit = mockEvent("squad", {
  name: "deposited",
  marketId: 10,
  side: 1,
  participant: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  amount: 250_000_000n, // 25 USDC
  shares: 250_000_000n,
});

test("AtomicFilterReloader: starts with empty filter set when no initial config is provided", () => {
  const reloader = new AtomicFilterReloader();
  const current = reloader.getCurrent();

  assert.equal(current.version, 0);
  assert.equal(current.rules.length, 0);
  assert.deepEqual(current.thresholds, {});
  assert.equal(reloader.matches(smallChallenge), true);
  assert.equal(reloader.matches(sportsClaim), true);
});

test("AtomicFilterReloader: validates and swaps rules and thresholds atomically", () => {
  const reloader = new AtomicFilterReloader({
    expressions: ['claim_created where category == "sports"'],
    thresholds: { marketChallenge: "10" },
  });

  assert.equal(reloader.getCurrent().version, 1);
  assert.equal(reloader.matches(sportsClaim), true);
  assert.equal(reloader.matches(cryptoClaim), false);

  const res = reloader.reload({
    expressions: [
      'claim_created where category == "crypto"',
      "claim_challenged where stake >= 20 USDC",
      "deposited",
    ],
    thresholds: {
      marketChallenge: "25",
      squadDeposit: 100_000_000n, // 10 USDC
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  assert.equal(res.previousVersion, 1);
  assert.equal(res.version, 2);
  assert.equal(reloader.getCurrent().version, 2);

  // New rules and thresholds are active
  assert.equal(reloader.matches(sportsClaim), false);
  assert.equal(reloader.matches(cryptoClaim), true);
  assert.equal(reloader.matches(smallChallenge), false);
  assert.equal(reloader.matches(largeChallenge), true);
  assert.equal(reloader.matches(smallDeposit), false);
  assert.equal(reloader.matches(largeDeposit), true);
});

test("AtomicFilterReloader: retains previous working filter set when any expression is invalid", () => {
  const reloader = new AtomicFilterReloader({
    expressions: ['claim_created where category == "sports"'],
    thresholds: { marketChallenge: "10" },
  });
  const before = reloader.getCurrent();

  // First rule is valid, second rule has an unknown field, third rule is valid
  const res = reloader.reload({
    expressions: [
      'claim_created where category == "crypto"',
      "claim_created where nonexistentField == 1",
      "deposited",
    ],
    thresholds: { marketChallenge: "1" },
  });

  assert.equal(res.ok, false);
  assert.equal(res.applied, false);
  assert.equal(res.version, 1);
  assert.ok(res.error instanceof FilterConfigValidationError);
  assert.equal(res.error.issues.length, 1);
  assert.equal(res.error.issues[0].field, "expressions[1]");
  assert.match(res.error.issues[0].message, /Unknown field/);

  // Exact same snapshot reference and behavior retained
  assert.strictEqual(reloader.getCurrent(), before);
  assert.strictEqual(res.filterSet, before);
  assert.equal(reloader.matches(sportsClaim), true);
  assert.equal(reloader.matches(cryptoClaim), false);
});

test("AtomicFilterReloader: retains previous working filter set when threshold is invalid even if expressions are valid", () => {
  const reloader = new AtomicFilterReloader({
    expressions: ['claim_created where category == "sports"'],
    thresholds: { squadDeposit: "10" },
  });
  const before = reloader.getCurrent();

  const res = reloader.reload({
    expressions: ['claim_created where category == "crypto"'],
    thresholds: {
      marketChallenge: "-5",
      squadDeposit: "0.00000001", // 8 decimals (> max 7)
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.applied, false);
  assert.equal(res.version, 1);
  assert.ok(res.error instanceof FilterConfigValidationError);
  assert.equal(res.error.issues.length, 2);
  assert.equal(res.error.issues[0].field, "thresholds.marketChallenge");
  assert.equal(res.error.issues[1].field, "thresholds.squadDeposit");

  assert.strictEqual(reloader.getCurrent(), before);
  assert.equal(reloader.matches(sportsClaim), true);
  assert.equal(reloader.matches(cryptoClaim), false);
});

test("compileFilterConfig: collects all validation issues across both expressions and thresholds", () => {
  assert.throws(
    () =>
      compileFilterConfig({
        expressions: [
          "claim_created where category == 'sports'",
          "   ",
          "unknown_event where x == 1",
        ],
        thresholds: {
          marketChallenge: -1n,
          squadDeposit: "not-a-number",
        },
      }),
    (err) => {
      assert.ok(err instanceof FilterConfigValidationError);
      const fields = err.issues.map((i) => i.field);
      assert.deepEqual(fields, [
        "expressions[1]",
        "expressions[2]",
        "thresholds.marketChallenge",
        "thresholds.squadDeposit",
      ]);
      return true;
    },
  );
});

test("AtomicFilterReloader: reloadOrThrow throws on failure and retains previous working filter set", () => {
  const reloader = new AtomicFilterReloader({
    expressions: ['claim_created where category == "sports"'],
  });
  const before = reloader.getCurrent();

  assert.throws(
    () =>
      reloader.reloadOrThrow({
        expressions: ["claim_created where (category == 'a'"], // missing ')'
      }),
    (err) => err instanceof FilterConfigValidationError,
  );

  assert.strictEqual(reloader.getCurrent(), before);
  assert.equal(reloader.matches(sportsClaim), true);
  assert.equal(reloader.matches(cryptoClaim), false);
});

test("AtomicFilterReloader: respects parserOptions token and depth limits during reload", () => {
  const reloader = new AtomicFilterReloader({
    expressions: ["claim_created"],
  });
  const before = reloader.getCurrent();

  const res = reloader.reload({
    expressions: ['claim_created where ((category == "sports"))'],
    parserOptions: { maxDepth: 1 },
  });

  assert.equal(res.ok, false);
  assert.match(res.error.issues[0].message, /maximum nesting depth/);
  assert.strictEqual(reloader.getCurrent(), before);
});

test("AtomicFilterReloader: rejects malformed candidate shapes and preserves active config", () => {
  const reloader = new AtomicFilterReloader({
    expressions: ['claim_created where category == "sports"'],
  });
  const before = reloader.getCurrent();

  for (const bad of [null, undefined, [], { expressions: "not-an-array" }, { thresholds: [] }]) {
    const res = reloader.reload(bad);
    assert.equal(res.ok, false);
    assert.strictEqual(reloader.getCurrent(), before);
  }
});

test("AtomicFilterReloader: sequential valid -> invalid -> valid -> reset reloads track version accurately", () => {
  const reloader = new AtomicFilterReloader();
  assert.equal(reloader.getCurrent().version, 0);

  const r1 = reloader.reload({
    expressions: ['claim_created where category == "sports"'],
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.version, 1);

  const r2 = reloader.reload({
    thresholds: { marketChallenge: "invalid" },
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.version, 1);
  assert.equal(reloader.getCurrent().version, 1);

  const r3 = reloader.reload({
    expressions: ['claim_created where category == "crypto"'],
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.previousVersion, 1);
  assert.equal(r3.version, 2);

  // Reset to empty filter set
  const r4 = reloader.reload({});
  assert.equal(r4.ok, true);
  assert.equal(r4.version, 3);
  assert.equal(reloader.matches(sportsClaim), true);
  assert.equal(reloader.matches(cryptoClaim), true);
});

test("CompiledFilterSet: external mutation of candidate does not affect active filter set", () => {
  const expressions = ['claim_created where category == "sports"'];
  const thresholds = { marketChallenge: "10" };
  const reloader = new AtomicFilterReloader({ expressions, thresholds });

  expressions.push('claim_created where category == "crypto"');
  thresholds.marketChallenge = "0";

  const active = reloader.getCurrent();
  assert.equal(active.rules.length, 1);
  assert.equal(active.thresholds.marketChallenge, 100_000_000n);
  assert.equal(Object.isFrozen(active), true);
  assert.equal(Object.isFrozen(active.rules), true);
  assert.equal(Object.isFrozen(active.thresholds), true);
  assert.equal(evaluateFilterSet(active, cryptoClaim), false);
});
