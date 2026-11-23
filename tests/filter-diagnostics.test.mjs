import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateThresholdDiagnostic,
  meetsThreshold,
} from "../dist/notifications/amount-threshold.js";
import {
  evaluateFilterDryRun,
  evaluateFilterRule,
  evaluateFilterRuleDiagnostic,
  parseFilterExpression,
} from "../dist/notifications/filter-expr.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mockEvent(source, payload) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    version: "v1",
    ledger: 1000,
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    at: 1700000000,
    eventId: "0000001000-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

function challengeEvent(stake) {
  const payload = {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  };
  if (stake !== undefined) payload.stake = stake;
  return mockEvent("market", payload);
}

function depositEvent(amount) {
  const payload = {
    name: "deposited",
    marketId: 42,
    side: 1,
    participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    shares: 0n,
  };
  if (amount !== undefined) payload.amount = amount;
  return mockEvent("squad", payload);
}

const THRESHOLDS = { marketChallenge: 1_000_000_000n, squadDeposit: 500_000_000n };
const RULE = parseFilterExpression("claim_challenged where stake >= 100 USDC");

// ---------------------------------------------------------------------------
// Expression diagnostics
// ---------------------------------------------------------------------------

test("missing field is reported distinctly from a false predicate", () => {
  assert.deepEqual(evaluateFilterRuleDiagnostic(RULE, challengeEvent(undefined)), {
    matched: false,
    reason: "missing-field",
    field: "stake",
  });

  assert.deepEqual(evaluateFilterRuleDiagnostic(RULE, challengeEvent(1n)), {
    matched: false,
    reason: "predicate-false",
  });
});

test("event-name mismatch is its own diagnostic reason", () => {
  const created = mockEvent("market", {
    name: "claim_created",
    claimId: 1,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    category: "crypto",
  });

  assert.deepEqual(evaluateFilterRuleDiagnostic(RULE, created), {
    matched: false,
    reason: "event-name-mismatch",
  });
});

test("a null field is missing; a present zero is a false predicate (boundary)", () => {
  const rule = parseFilterExpression("claim_challenged where stake > 0");

  assert.equal(evaluateFilterRuleDiagnostic(rule, challengeEvent(null)).reason, "missing-field");
  assert.equal(evaluateFilterRuleDiagnostic(rule, challengeEvent(0n)).reason, "predicate-false");
});

test("logical and/or keep reasons deterministic and prefer the missing field", () => {
  const rule = parseFilterExpression(
    "claim_created where (category == 'crypto' or claimId > 10)",
  );

  // OR: left missing, right satisfied -> matched.
  const rightOnly = mockEvent("market", { name: "claim_created", claimId: 20 });
  assert.deepEqual(evaluateFilterRuleDiagnostic(rule, rightOnly), { matched: true });

  // OR: left false, right missing -> missing-field on the right.
  const leftFalse = mockEvent("market", {
    name: "claim_created",
    category: "sports",
  });
  assert.deepEqual(evaluateFilterRuleDiagnostic(rule, leftFalse), {
    matched: false,
    reason: "missing-field",
    field: "claimId",
  });

  // OR: both false -> predicate-false.
  const bothFalse = mockEvent("market", {
    name: "claim_created",
    category: "sports",
    claimId: 5,
  });
  assert.deepEqual(evaluateFilterRuleDiagnostic(rule, bothFalse), {
    matched: false,
    reason: "predicate-false",
  });

  // AND: a missing field on the left short-circuits with that reason.
  const andRule = parseFilterExpression(
    "claim_created where category == 'crypto' and claimId > 10",
  );
  const categoryMissing = mockEvent("market", { name: "claim_created", claimId: 20 });
  assert.deepEqual(evaluateFilterRuleDiagnostic(andRule, categoryMissing), {
    matched: false,
    reason: "missing-field",
    field: "category",
  });
});

// ---------------------------------------------------------------------------
// Threshold diagnostics
// ---------------------------------------------------------------------------

test("threshold diagnostics distinguish missing amount fields from low amounts", () => {
  assert.deepEqual(evaluateThresholdDiagnostic(challengeEvent(undefined), THRESHOLDS), {
    passed: false,
    reason: "missing-field",
    field: "stake",
    threshold: 1_000_000_000n,
  });
  assert.deepEqual(evaluateThresholdDiagnostic(challengeEvent(999_999_999n), THRESHOLDS), {
    passed: false,
    reason: "below-threshold",
    field: "stake",
    threshold: 1_000_000_000n,
  });
  assert.deepEqual(evaluateThresholdDiagnostic(challengeEvent(1_000_000_000n), THRESHOLDS), {
    passed: true,
    reason: "passed",
    field: "stake",
    threshold: 1_000_000_000n,
  });

  assert.deepEqual(evaluateThresholdDiagnostic(depositEvent(undefined), THRESHOLDS), {
    passed: false,
    reason: "missing-field",
    field: "amount",
    threshold: 500_000_000n,
  });
  assert.equal(
    evaluateThresholdDiagnostic(depositEvent(499_999_999n), THRESHOLDS).reason,
    "below-threshold",
  );
});

test("an unset or zero threshold is not configured, so a missing field still passes", () => {
  assert.deepEqual(evaluateThresholdDiagnostic(challengeEvent(undefined), undefined), {
    passed: true,
    reason: "not-configured",
  });
  assert.deepEqual(
    evaluateThresholdDiagnostic(challengeEvent(undefined), { marketChallenge: 0n }),
    { passed: true, reason: "not-configured" },
  );
});

// ---------------------------------------------------------------------------
// Combined dry-run diagnostics
// ---------------------------------------------------------------------------

test("dry-run reports one reason per event across expression and thresholds", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC");

  // Expression matched, threshold denied: below-threshold.
  assert.deepEqual(
    evaluateFilterDryRun(rule, challengeEvent(1_500_000_000n), {
      marketChallenge: 2_000_000_000n,
    }),
    {
      matched: false,
      reason: "below-threshold",
      field: "stake",
      threshold: 2_000_000_000n,
    },
  );

  // Expression cannot run: missing-field wins over the threshold outcome.
  assert.deepEqual(evaluateFilterDryRun(rule, challengeEvent(undefined), THRESHOLDS), {
    matched: false,
    reason: "missing-field",
    field: "stake",
  });

  // Both pass.
  assert.deepEqual(evaluateFilterDryRun(rule, challengeEvent(5_000_000_000n), THRESHOLDS), {
    matched: true,
    reason: "matched",
  });
});

test("dry-run keeps event-name mismatch distinct from a threshold denial", () => {
  const created = mockEvent("market", {
    name: "claim_created",
    claimId: 1,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    category: "crypto",
  });
  assert.deepEqual(evaluateFilterDryRun(RULE, created, THRESHOLDS), {
    matched: false,
    reason: "event-name-mismatch",
  });
});

// ---------------------------------------------------------------------------
// Live allow-or-deny behavior is unchanged
// ---------------------------------------------------------------------------

test("live predicates still deny on both missing fields and false predicates", () => {
  assert.equal(evaluateFilterRule(RULE, challengeEvent(undefined)), false);
  assert.equal(evaluateFilterRule(RULE, challengeEvent(1n)), false);
  assert.equal(evaluateFilterRule(RULE, challengeEvent(5_000_000_000n)), true);

  // Missing amount fields deny exactly as before; diagnostics only explain why.
  assert.equal(meetsThreshold(challengeEvent(undefined), THRESHOLDS), false);
  assert.equal(meetsThreshold(challengeEvent(0n), THRESHOLDS), false);
  assert.equal(meetsThreshold(challengeEvent(1_000_000_000n), THRESHOLDS), true);
  assert.equal(meetsThreshold(depositEvent(undefined), THRESHOLDS), false);
  assert.equal(meetsThreshold(depositEvent(500_000_000n), THRESHOLDS), true);
});
