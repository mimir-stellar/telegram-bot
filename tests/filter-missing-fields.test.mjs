import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFilterRule,
  evaluateFilterRuleDryRun,
  parseFilterExpression,
} from "../dist/notifications/filter-expr.js";
import {
  evaluateThresholdDryRun,
  meetsThreshold,
  parseUsdcThreshold,
} from "../dist/notifications/amount-threshold.js";

function mockEvent(source, payload) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    version: "v1",
    ledger: 2000,
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    at: 1700000000,
    eventId: "0000002000-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 1,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("dry-run reports missing_field distinctly from false_predicate while preserving live boolean behavior", () => {
  const rule = parseFilterExpression("where stake >= 100 USDC");

  const missingFieldEvent = mockEvent("market", {
    name: "claim_created",
    claimId: 7,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    category: "crypto",
    title: "ETH ETF volume",
  });

  const nullFieldEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 7,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    stake: null,
  });

  const falsePredicateEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 7,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    stake: 250_000_000n, // 25 USDC < 100 USDC
  });

  const matchedEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 7,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    stake: 1_500_000_000n, // 150 USDC >= 100 USDC
  });

  const dryMissing = evaluateFilterRuleDryRun(rule, missingFieldEvent);
  assert.equal(dryMissing.allowed, false);
  assert.equal(dryMissing.allowed, evaluateFilterRule(rule, missingFieldEvent));
  assert.equal(dryMissing.reason, "missing_field");
  assert.deepEqual(dryMissing.missingFields, ["stake"]);
  assert.deepEqual(dryMissing.failedPredicates, []);
  assert.match(dryMissing.detail, /stake/);

  const dryNull = evaluateFilterRuleDryRun(rule, nullFieldEvent);
  assert.equal(dryNull.allowed, false);
  assert.equal(dryNull.allowed, evaluateFilterRule(rule, nullFieldEvent));
  assert.equal(dryNull.reason, "missing_field");
  assert.deepEqual(dryNull.missingFields, ["stake"]);

  const dryFalse = evaluateFilterRuleDryRun(rule, falsePredicateEvent);
  assert.equal(dryFalse.allowed, false);
  assert.equal(dryFalse.allowed, evaluateFilterRule(rule, falsePredicateEvent));
  assert.equal(dryFalse.reason, "false_predicate");
  assert.deepEqual(dryFalse.missingFields, []);
  assert.equal(dryFalse.failedPredicates.length, 1);
  assert.match(dryFalse.failedPredicates[0], /stake >= 100 USDC/);

  const dryMatched = evaluateFilterRuleDryRun(rule, matchedEvent);
  assert.equal(dryMatched.allowed, true);
  assert.equal(dryMatched.allowed, evaluateFilterRule(rule, matchedEvent));
  assert.equal(dryMatched.reason, "matched");
});

test("dry-run compound boolean expressions preserve live allow/deny and classify decisive reason", () => {
  const claimCreatedCrypto = mockEvent("market", {
    name: "claim_created",
    claimId: 12,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    category: "crypto",
    title: "Solana TPS",
  });

  // TRUE and MISSING -> denied due to missing_field
  const andMissingRule = parseFilterExpression("where category == 'crypto' and stake >= 50 USDC");
  const andMissingRes = evaluateFilterRuleDryRun(andMissingRule, claimCreatedCrypto);
  assert.equal(andMissingRes.allowed, false);
  assert.equal(andMissingRes.allowed, evaluateFilterRule(andMissingRule, claimCreatedCrypto));
  assert.equal(andMissingRes.reason, "missing_field");
  assert.deepEqual(andMissingRes.missingFields, ["stake"]);
  assert.deepEqual(andMissingRes.failedPredicates, []);

  // FALSE and MISSING -> definitively false_predicate even if stake were present
  const andFalseRule = parseFilterExpression("where category == 'sports' and stake >= 50 USDC");
  const andFalseRes = evaluateFilterRuleDryRun(andFalseRule, claimCreatedCrypto);
  assert.equal(andFalseRes.allowed, false);
  assert.equal(andFalseRes.allowed, evaluateFilterRule(andFalseRule, claimCreatedCrypto));
  assert.equal(andFalseRes.reason, "false_predicate");
  assert.deepEqual(andFalseRes.missingFields, ["stake"]);
  assert.equal(andFalseRes.failedPredicates.length, 1);

  // TRUE or MISSING -> allowed (matched), matching live OR short-circuit semantics
  const orMatchedRule = parseFilterExpression("where category == 'crypto' or stake >= 50 USDC");
  const orMatchedRes = evaluateFilterRuleDryRun(orMatchedRule, claimCreatedCrypto);
  assert.equal(orMatchedRes.allowed, true);
  assert.equal(orMatchedRes.allowed, evaluateFilterRule(orMatchedRule, claimCreatedCrypto));
  assert.equal(orMatchedRes.reason, "matched");
  assert.deepEqual(orMatchedRes.missingFields, ["stake"]);

  // FALSE or MISSING -> denied due to missing_field (second branch could not be evaluated)
  const orMissingRule = parseFilterExpression("where category == 'sports' or stake >= 50 USDC");
  const orMissingRes = evaluateFilterRuleDryRun(orMissingRule, claimCreatedCrypto);
  assert.equal(orMissingRes.allowed, false);
  assert.equal(orMissingRes.allowed, evaluateFilterRule(orMissingRule, claimCreatedCrypto));
  assert.equal(orMissingRes.reason, "missing_field");
  assert.deepEqual(orMissingRes.missingFields, ["stake"]);
  assert.equal(orMissingRes.failedPredicates.length, 1);
});

test("dry-run treats inherited Object.prototype keys and mismatched event names safely", () => {
  const event = mockEvent("market", {
    name: "claim_created",
    claimId: 1,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    category: "crypto",
    title: "Test",
  });

  const protoRule = parseFilterExpression("where toString == 'x'");
  const protoRes = evaluateFilterRuleDryRun(protoRule, event);
  assert.equal(protoRes.allowed, false);
  assert.equal(evaluateFilterRule(protoRule, event), false);
  assert.equal(protoRes.reason, "missing_field");
  assert.deepEqual(protoRes.missingFields, ["toString"]);

  const mismatchRule = parseFilterExpression("claim_challenged where stake >= 10 USDC");
  const mismatchRes = evaluateFilterRuleDryRun(mismatchRule, event);
  assert.equal(mismatchRes.allowed, false);
  assert.equal(evaluateFilterRule(mismatchRule, event), false);
  assert.equal(mismatchRes.reason, "event_name_mismatch");
});

test("evaluateThresholdDryRun distinguishes missing amount fields from below-threshold amounts", () => {
  const thresholds = {
    marketChallenge: parseUsdcThreshold("10"),
    squadDeposit: parseUsdcThreshold("25"),
  };

  const missingStakeChallenge = mockEvent("market", {
    name: "claim_challenged",
    claimId: 9,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  });
  const missingStakeRes = evaluateThresholdDryRun(missingStakeChallenge, thresholds);
  assert.equal(missingStakeRes.allowed, false);
  assert.equal(meetsThreshold(missingStakeChallenge, thresholds), false);
  assert.equal(missingStakeRes.reason, "missing_field");
  assert.equal(missingStakeRes.field, "stake");

  const lowStakeChallenge = mockEvent("market", {
    name: "claim_challenged",
    claimId: 9,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    stake: 50_000_000n, // 5 USDC < 10 USDC
  });
  const lowStakeRes = evaluateThresholdDryRun(lowStakeChallenge, thresholds);
  assert.equal(lowStakeRes.allowed, false);
  assert.equal(meetsThreshold(lowStakeChallenge, thresholds), false);
  assert.equal(lowStakeRes.reason, "false_predicate");
  assert.equal(lowStakeRes.field, "stake");

  const highDeposit = mockEvent("squad", {
    name: "deposited",
    marketId: 4,
    side: 1,
    participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount: 300_000_000n, // 30 USDC >= 25 USDC
    shares: 300_000_000n,
  });
  const highDepositRes = evaluateThresholdDryRun(highDeposit, thresholds);
  assert.equal(highDepositRes.allowed, true);
  assert.equal(meetsThreshold(highDeposit, thresholds), true);
  assert.equal(highDepositRes.reason, "matched");
});
