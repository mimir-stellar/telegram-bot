import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidThresholdError,
  formatCanonicalUsdc,
  meetsThreshold,
  normalizeUsdcThreshold,
  parseUsdcThreshold,
} from "../dist/notifications/amount-threshold.js";
import {
  FilterParseError,
  evaluateFilterRule,
  normalizeUsdcDecimal,
  parseFilterExpression,
  parseUsdcStringToUnits,
} from "../dist/notifications/filter-expr.js";

function mockEvent(source, payload) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    version: "v1",
    ledger: 4000,
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    at: 1700000000,
    eventId: "0000004000-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 1,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("normalizeUsdcThreshold treats canonical equivalent decimal strings identically", () => {
  const zeroVariants = ["0", "0.0", "00.0000000", "  000.00  "];
  for (const raw of zeroVariants) {
    assert.deepEqual(normalizeUsdcThreshold(raw), { canonical: "0", atomic: 0n });
    assert.equal(parseUsdcThreshold(raw), 0n);
  }

  const tenVariants = ["10", "10.0", "10.00", "010.0000000", "  0010.000  "];
  for (const raw of tenVariants) {
    assert.deepEqual(normalizeUsdcThreshold(raw), { canonical: "10", atomic: 100_000_000n });
    assert.equal(parseUsdcThreshold(raw), 100_000_000n);
  }

  const tenHalfVariants = ["10.5", "10.50", "010.5000000", " 10.5000 "];
  for (const raw of tenHalfVariants) {
    assert.deepEqual(normalizeUsdcThreshold(raw), { canonical: "10.5", atomic: 105_000_000n });
    assert.deepEqual(normalizeUsdcDecimal(raw), { canonical: "10.5", atomic: 105_000_000n });
  }

  assert.equal(formatCanonicalUsdc(1n), "0.0000001");
  assert.equal(formatCanonicalUsdc(105_000_000n), "10.5");
});

test("filter expressions and meetsThreshold evaluate equivalent decimal thresholds identically without float truncation", () => {
  const expressions = [
    "deposited where amount >= 10.5",
    "deposited where amount >= 10.50",
    "deposited where amount >= 010.5000000",
    "deposited where amount >= $10.5",
    "deposited where amount >= $010.5000000",
    "deposited where amount >= 10.5 USDC",
    "deposited where amount >= 010.5000000 USDC",
    "where amount >= 010.50",
  ];

  const belowEvent = mockEvent("squad", {
    name: "deposited",
    marketId: 1,
    side: 1,
    participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount: 104_999_999n, // 10.4999999 USDC (previously mis-evaluated when 10.5 floored to 10!)
    shares: 104_999_999n,
  });
  const exactEvent = mockEvent("squad", {
    name: "deposited",
    marketId: 1,
    side: 1,
    participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount: 105_000_000n, // 10.5 USDC
    shares: 105_000_000n,
  });

  for (const expr of expressions) {
    const rule = parseFilterExpression(expr);
    assert.equal(rule.condition.type, "comparison");
    assert.equal(rule.condition.value.canonicalDecimal, "10.5");
    assert.equal(evaluateFilterRule(rule, belowEvent), false, `Expected false for "${expr}"`);
    assert.equal(evaluateFilterRule(rule, exactEvent), true, `Expected true for "${expr}"`);
  }

  for (const raw of ["10.5", "10.50", "010.5000000", 105_000_000n]) {
    assert.equal(meetsThreshold(belowEvent, { squadDeposit: raw }), false);
    assert.equal(meetsThreshold(exactEvent, { squadDeposit: raw }), true);
  }
});

test("rejects USDC thresholds and literals exceeding 7 fractional digits including trailing zeros", () => {
  const overPrecisionValues = [
    "0.00000001",
    "1.12345678",
    "10.00000000",
    "0.00000000",
    "10.50000000",
  ];

  for (const val of overPrecisionValues) {
    assert.throws(
      () => normalizeUsdcThreshold(val),
      (err) => err instanceof InvalidThresholdError && /7 decimals/.test(err.message),
      `Expected InvalidThresholdError for "${val}"`,
    );
    assert.throws(
      () => parseUsdcStringToUnits(val),
      (err) => err instanceof FilterParseError && /7 decimals/.test(err.message),
      `Expected FilterParseError for "${val}"`,
    );
    assert.throws(
      () => parseFilterExpression(`claim_challenged where stake >= ${val}`),
      (err) => err instanceof FilterParseError && /7 decimals/.test(err.message),
    );
    assert.throws(
      () => parseFilterExpression(`claim_challenged where stake >= $${val}`),
      (err) => err instanceof FilterParseError && /7 decimals/.test(err.message),
    );
    assert.throws(
      () => parseFilterExpression(`claim_challenged where stake >= ${val} USDC`),
      (err) => err instanceof FilterParseError && /7 decimals/.test(err.message),
    );
    assert.throws(
      () => parseFilterExpression(`where stake >= ${val}`),
      (err) => err instanceof FilterParseError && /7 decimals/.test(err.message),
    );
  }
});
