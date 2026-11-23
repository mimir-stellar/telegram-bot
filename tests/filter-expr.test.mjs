import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_PAYLOAD_SCHEMAS,
  FilterDepthLimitError,
  FilterParseError,
  FilterTokenLimitError,
  MAX_FILTER_DEPTH,
  MAX_FILTER_TOKENS,
  countFilterTokens,
  evaluateFilterRule,
  parseFilterExpression,
  parseUsdcStringToUnits,
} from "../dist/notifications/filter-expr.js";

// Helper to construct a minimal DecodedEvent
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
    operationIndex: 1,
    inSuccessfulContractCall: true,
    payload,
  };
}

// ----------------------------------------------------
// Parser Tests: Valid Rules
// ----------------------------------------------------

test("parseFilterExpression: parses simple event name only", () => {
  const rule = parseFilterExpression("claim_challenged");
  assert.equal(rule.eventName, "claim_challenged");
  assert.equal(rule.condition, undefined);
});

test("parseFilterExpression: parses rule with condition (stake >= 100)", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100");
  assert.equal(rule.eventName, "claim_challenged");
  assert.ok(rule.condition);
  assert.equal(rule.condition.type, "comparison");
  assert.equal(rule.condition.field, "stake");
  assert.equal(rule.condition.op, ">=");
  assert.equal(rule.condition.value.kind, "number");
  assert.equal(rule.condition.value.value, 100);
});

test("parseFilterExpression: parses rule with USDC literal suffix (100 USDC)", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC");
  assert.equal(rule.eventName, "claim_challenged");
  assert.equal(rule.condition.type, "comparison");
  assert.equal(rule.condition.value.kind, "usdc");
  assert.equal(rule.condition.value.atomic, 1_000_000_000n);
});

test("parseFilterExpression: parses rule with dollar prefix ($25.50)", () => {
  const rule = parseFilterExpression("deposited where amount > $25.50");
  assert.equal(rule.eventName, "deposited");
  assert.equal(rule.condition.type, "comparison");
  assert.equal(rule.condition.value.kind, "usdc");
  assert.equal(rule.condition.value.atomic, 255_000_000n);
});

test("parseFilterExpression: parses string comparisons with single and double quotes", () => {
  const rule1 = parseFilterExpression("claim_created where category == 'defi'");
  assert.equal(rule1.condition.type, "comparison");
  assert.equal(rule1.condition.value.kind, "string");
  assert.equal(rule1.condition.value.value, "defi");

  const rule2 = parseFilterExpression('claim_created where category = "governance"');
  assert.equal(rule2.condition.type, "comparison");
  assert.equal(rule2.condition.op, "==");
  assert.equal(rule2.condition.value.value, "governance");
});

test("parseFilterExpression: parses boolean comparison", () => {
  const rule = parseFilterExpression("where active == true");
  assert.equal(rule.eventName, undefined);
  assert.equal(rule.condition.type, "comparison");
  assert.equal(rule.condition.value.kind, "boolean");
  assert.equal(rule.condition.value.value, true);
});

test("parseFilterExpression: parses compound expressions with and/or and parentheses", () => {
  const expr = "claim_created where (category == 'crypto' or category == 'defi') and claimId > 10";
  const rule = parseFilterExpression(expr);
  assert.equal(rule.eventName, "claim_created");
  assert.equal(rule.condition.type, "logical");
  assert.equal(rule.condition.op, "and");
  assert.equal(rule.condition.left.type, "logical");
  assert.equal(rule.condition.left.op, "or");
  assert.equal(rule.condition.right.type, "comparison");
  assert.equal(rule.condition.right.field, "claimId");
  assert.equal(rule.condition.right.op, ">");
});

// ----------------------------------------------------
// Parser Tests: Error Positions and Validations
// ----------------------------------------------------

test("parseFilterExpression: rejects unknown event name with position", () => {
  try {
    parseFilterExpression("unknown_event where x > 1");
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.equal(err.position, 0);
    assert.match(err.message, /Unknown event name "unknown_event"/);
  }
});

test("parseFilterExpression: rejects unknown field for event with position", () => {
  const input = "claim_challenged where unknown_prop >= 100";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.equal(err.position, 23); // index where 'unknown_prop' starts
    assert.match(err.message, /Unknown field "unknown_prop" for event "claim_challenged"/);
  }
});

test("parseFilterExpression: rejects type mismatch (string field compared with number)", () => {
  const input = "claim_created where category > 100";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /Field "category" is a string/);
  }
});

test("parseFilterExpression: rejects invalid comparison operator on string (e.g. category > 'abc')", () => {
  const input = "claim_created where category > 'abc'";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /Operator ">" cannot be used on string field/);
  }
});

test("parseFilterExpression: rejects type mismatch on number field (claimId == 'abc')", () => {
  const input = "claim_created where claimId == 'abc'";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /Field "claimId" is a number/);
  }
});

test("parseFilterExpression: rejects excessive decimal places on USDC amount", () => {
  const input = "claim_challenged where stake >= 1.12345678 USDC";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /exceeds maximum precision of 7 decimals/);
  }
});

test("parseFilterExpression: rejects syntax errors (missing closing parenthesis)", () => {
  const input = "claim_challenged where (stake >= 100";
  try {
    parseFilterExpression(input);
    assert.fail("Expected FilterParseError");
  } catch (err) {
    assert.ok(err instanceof FilterParseError);
    assert.match(err.message, /Expected closing '\)'/);
  }
});

// ----------------------------------------------------
// Evaluator Tests: BigInt & Comparison Evaluation Table
// ----------------------------------------------------

test("evaluateFilterRule: evaluation table for stake comparison (bigint)", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100");

  const cases = [
    { stake: 99_999_999n, expected: false },       // 9.9999999 USDC < 100 USDC
    { stake: 999_999_999n, expected: false },      // 99.9999999 USDC < 100 USDC
    { stake: 1_000_000_000n, expected: true },     // 100 USDC == 100 USDC
    { stake: 1_000_000_001n, expected: true },     // 100.0000001 USDC > 100 USDC
    { stake: 5_000_000_000n, expected: true },     // 500 USDC > 100 USDC
  ];

  for (const c of cases) {
    const event = mockEvent("market", {
      name: "claim_challenged",
      claimId: 1,
      challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      stake: c.stake,
    });
    assert.equal(
      evaluateFilterRule(rule, event),
      c.expected,
      `Failed for stake=${c.stake}: expected ${c.expected}`,
    );
  }
});

test("evaluateFilterRule: evaluation table for deposit comparison with explicit USDC literals", () => {
  const rule = parseFilterExpression("deposited where amount >= 50.5 USDC");

  const cases = [
    { amount: 504_999_999n, expected: false },
    { amount: 505_000_000n, expected: true },
    { amount: 505_000_001n, expected: true },
  ];

  for (const c of cases) {
    const event = mockEvent("squad", {
      name: "deposited",
      marketId: 42,
      side: 1,
      participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: c.amount,
      shares: c.amount,
    });
    assert.equal(
      evaluateFilterRule(rule, event),
      c.expected,
      `Failed for amount=${c.amount}`,
    );
  }
});

test("evaluateFilterRule: filters out mismatched event names", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100");

  const event = mockEvent("market", {
    name: "claim_created",
    claimId: 1,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    category: "tech",
  });

  assert.equal(evaluateFilterRule(rule, event), false);
});

test("evaluateFilterRule: evaluates logical and/or operations accurately", () => {
  const rule = parseFilterExpression(
    "claim_created where (category == 'crypto' or category == 'defi') and claimId < 50",
  );

  const eventMatch1 = mockEvent("market", {
    name: "claim_created",
    claimId: 10,
    creator: "G...",
    category: "crypto",
  });
  const eventMatch2 = mockEvent("market", {
    name: "claim_created",
    claimId: 49,
    creator: "G...",
    category: "defi",
  });
  const eventFailCategory = mockEvent("market", {
    name: "claim_created",
    claimId: 10,
    creator: "G...",
    category: "sports",
  });
  const eventFailId = mockEvent("market", {
    name: "claim_created",
    claimId: 100,
    creator: "G...",
    category: "crypto",
  });

  assert.equal(evaluateFilterRule(rule, eventMatch1), true);
  assert.equal(evaluateFilterRule(rule, eventMatch2), true);
  assert.equal(evaluateFilterRule(rule, eventFailCategory), false);
  assert.equal(evaluateFilterRule(rule, eventFailId), false);
});

test("parseUsdcStringToUnits: atomic unit conversion utility", () => {
  assert.equal(parseUsdcStringToUnits("1"), 10_000_000n);
  assert.equal(parseUsdcStringToUnits("100"), 1_000_000_000n);
  assert.equal(parseUsdcStringToUnits("0.0000001"), 1n);
  assert.equal(parseUsdcStringToUnits("2.5"), 25_000_000n);

  // Canonical equivalent decimal strings normalize identically
  for (const equivalent of ["10.5", "010.5", "10.50", "10.5000000", " 010.50 "]) {
    assert.equal(parseUsdcStringToUnits(equivalent), 105_000_000n);
  }

  // Values exceeding 7 fractional digits (including trailing zeros) are rejected
  assert.throws(
    () => parseUsdcStringToUnits("1.00000000"),
    (err) => err instanceof FilterParseError && /exceeds maximum precision of 7 decimals/.test(err.message),
  );
});

test("evaluateFilterRule: normalizes equivalent decimal USDC thresholds before comparison", () => {
  const equivalentExpressions = [
    "claim_challenged where stake >= 10.5",
    "claim_challenged where stake >= 10.50",
    "claim_challenged where stake >= 010.5000000",
    "claim_challenged where stake >= 10.5 USDC",
    "claim_challenged where stake >= $10.50",
  ];

  const belowEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    stake: 104_999_999n, // 10.4999999 USDC
  });
  const exactEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    stake: 105_000_000n, // 10.5000000 USDC
  });
  const aboveEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    stake: 105_000_001n, // 10.5000001 USDC
  });

  for (const expr of equivalentExpressions) {
    const rule = parseFilterExpression(expr);
    assert.equal(evaluateFilterRule(rule, belowEvent), false, `belowEvent failed for: ${expr}`);
    assert.equal(evaluateFilterRule(rule, exactEvent), true, `exactEvent failed for: ${expr}`);
    assert.equal(evaluateFilterRule(rule, aboveEvent), true, `aboveEvent failed for: ${expr}`);
  }
});

test("parseFilterExpression: rejects bare and explicit decimal USDC thresholds exceeding 7 fractional digits", () => {
  const invalidExpressions = [
    "claim_challenged where stake >= 1.12345678",
    "deposited where amount >= 1.00000000",
    "claim_challenged where stake >= $1.00000000",
    "deposited where amount == 0.00000001 USDC",
  ];

  for (const expr of invalidExpressions) {
    assert.throws(
      () => parseFilterExpression(expr),
      (err) => err instanceof FilterParseError && /exceeds maximum precision of 7 decimals/.test(err.message),
      `Expected FilterParseError for: ${expr}`,
    );
  }
});

// ----------------------------------------------------
// Bounded Token Count & Nesting Depth Security Limits
// ----------------------------------------------------

test("countFilterTokens: accurately counts non-EOF tokens in valid expression", () => {
  const count = countFilterTokens("claim_challenged where stake >= 100");
  assert.equal(count, 5);
});

test("countFilterTokens: throws FilterTokenLimitError when token count exceeds limit", () => {
  assert.throws(
    () => countFilterTokens("claim_challenged where stake >= 100", 4),
    (err) => {
      assert.ok(err instanceof FilterTokenLimitError);
      assert.equal(err.count, 5);
      assert.equal(err.limit, 4);
      assert.match(err.message, /exceeds maximum token limit of 4 \(got 5\)/);
      return true;
    },
  );
});

test("parseFilterExpression: accepts expression within MAX_FILTER_TOKENS limit", () => {
  // Build an expression with exactly MAX_FILTER_TOKENS tokens (100 tokens)
  // "where category == 'cat'" is 4 tokens ("where", "category", "==", "'cat'")
  // Each " or category == 'cat'" adds 4 tokens ("or", "category", "==", "'cat'")
  // 4 + 24 * 4 = 100 tokens
  const parts = ["where category == 'cat'"];
  for (let i = 0; i < 24; i++) {
    parts.push("or category == 'cat'");
  }
  const expr = parts.join(" ");
  assert.equal(countFilterTokens(expr), MAX_FILTER_TOKENS);
  const rule = parseFilterExpression(expr);
  assert.ok(rule.condition);
});

test("parseFilterExpression: rejects expressions exceeding MAX_FILTER_TOKENS before AST parsing", () => {
  // 101 tokens: 100 tokens + 1 extra
  const parts = ["where category == 'cat'"];
  for (let i = 0; i < 32; i++) {
    parts.push("or category == 'cat'");
  }
  parts.push("or true"); // 2 more tokens -> 102 tokens
  const expr = parts.join(" ");

  assert.throws(
    () => parseFilterExpression(expr),
    (err) => {
      assert.ok(err instanceof FilterTokenLimitError);
      assert.equal(err.limit, MAX_FILTER_TOKENS);
      assert.ok(err.count > MAX_FILTER_TOKENS);
      assert.match(err.message, /exceeds maximum token limit/);
      return true;
    },
  );
});

test("parseFilterExpression: respects custom maxTokens option", () => {
  const expr = "claim_challenged where stake >= 100";
  // 5 tokens, limit to 4
  assert.throws(
    () => parseFilterExpression(expr, { maxTokens: 4 }),
    (err) => {
      assert.ok(err instanceof FilterTokenLimitError);
      assert.equal(err.limit, 4);
      assert.equal(err.count, 5);
      return true;
    },
  );

  // limit to 5 succeeds
  const rule = parseFilterExpression(expr, { maxTokens: 5 });
  assert.equal(rule.eventName, "claim_challenged");
});

test("parseFilterExpression: accepts nesting depth up to MAX_FILTER_DEPTH", () => {
  // Nesting depth 10: ((((((((((active == true))))))))))
  const leftParens = "(".repeat(MAX_FILTER_DEPTH);
  const rightParens = ")".repeat(MAX_FILTER_DEPTH);
  const expr = `where ${leftParens}active == true${rightParens}`;
  const rule = parseFilterExpression(expr);
  assert.ok(rule.condition);
});

test("parseFilterExpression: rejects expressions exceeding MAX_FILTER_DEPTH to prevent call stack recursion", () => {
  // Nesting depth 11: (((((((((((active == true)))))))))))
  const leftParens = "(".repeat(MAX_FILTER_DEPTH + 1);
  const rightParens = ")".repeat(MAX_FILTER_DEPTH + 1);
  const expr = `where ${leftParens}active == true${rightParens}`;

  assert.throws(
    () => parseFilterExpression(expr),
    (err) => {
      assert.ok(err instanceof FilterDepthLimitError);
      assert.equal(err.limit, MAX_FILTER_DEPTH);
      assert.equal(err.depth, MAX_FILTER_DEPTH + 1);
      assert.match(err.message, /exceeds maximum nesting depth of 10/);
      return true;
    },
  );
});

test("parseFilterExpression: respects custom maxDepth option", () => {
  const expr = "where ((active == true))"; // depth 2
  assert.throws(
    () => parseFilterExpression(expr, { maxDepth: 1 }),
    (err) => {
      assert.ok(err instanceof FilterDepthLimitError);
      assert.equal(err.limit, 1);
      assert.equal(err.depth, 2);
      return true;
    },
  );

  const rule = parseFilterExpression(expr, { maxDepth: 2 });
  assert.ok(rule.condition);
});

// ----------------------------------------------------
// Mixed-Unit Comparison Rejection & Non-USDC BigInt Fields
// ----------------------------------------------------

test("parseFilterExpression: rejects mixed-unit comparisons on identifiers and ledger numbers", () => {
  const mixedCases = [
    "claim_created where claimId >= 100 USDC",
    "market_created where marketId == $5",
    "market_created where deadline > 1000 USDC",
    "market_created where feeBps <= 50 USDC",
    "claim_resolved where confidence > 0.5 USDC",
    "where claimId >= 100 USDC",
    "where marketId == $10",
    "where ledger >= 100 USDC",
  ];

  for (const expr of mixedCases) {
    assert.throws(
      () => parseFilterExpression(expr),
      (err) => {
        assert.ok(err instanceof FilterParseError, `Expected FilterParseError for: ${expr}`);
        assert.match(err.message, /Mixed-unit comparison|is a number/);
        return true;
      },
      `Should reject mixed-unit expression: ${expr}`,
    );
  }
});

test("parseFilterExpression: rejects mixed-unit and fractional comparisons on non-USDC bigint fields (shares)", () => {
  for (const expr of [
    "deposited where shares >= 100 USDC",
    "deposited where shares >= $10",
    "where shares >= 100 USDC",
  ]) {
    assert.throws(
      () => parseFilterExpression(expr),
      (err) => {
        assert.ok(err instanceof FilterParseError);
        assert.match(err.message, /Mixed-unit comparison.*shares.*not a USDC amount/);
        return true;
      },
      `Should reject USDC literal on shares: ${expr}`,
    );
  }

  assert.throws(
    () => parseFilterExpression("deposited where shares >= 1.5"),
    (err) => {
      assert.ok(err instanceof FilterParseError);
      assert.match(err.message, /Field "shares" is an integer, cannot compare with fractional number/);
      return true;
    },
  );
});

test("evaluateFilterRule: evaluates non-USDC bigint field (shares) without USDC scaling", () => {
  const rule = parseFilterExpression("deposited where shares >= 100");

  const makeDeposit = (shares) =>
    mockEvent("squad", {
      name: "deposited",
      marketId: 42,
      side: 1,
      participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: 500_000_000n,
      shares,
    });

  assert.equal(evaluateFilterRule(rule, makeDeposit(99n)), false);
  assert.equal(evaluateFilterRule(rule, makeDeposit(100n)), true);
  assert.equal(evaluateFilterRule(rule, makeDeposit(150n)), true);
});

test("evaluateFilterRule: refuses mixed-unit coercion on manually constructed ASTs", () => {
  const mixedIdRule = {
    eventName: "claim_created",
    rawExpression: "claim_created where claimId >= 1 USDC",
    condition: {
      type: "comparison",
      op: ">=",
      field: "claimId",
      fieldPos: 20,
      value: { kind: "usdc", atomic: 10_000_000n, rawDecimal: "1 USDC" },
      valuePos: 31,
    },
  };
  const claimEvent = mockEvent("market", {
    name: "claim_created",
    claimId: 5,
    creator: "G...",
    category: "crypto",
  });
  assert.equal(evaluateFilterRule(mixedIdRule, claimEvent), false);

  const mixedSharesRule = {
    eventName: "deposited",
    rawExpression: "deposited where shares >= 1 USDC",
    condition: {
      type: "comparison",
      op: ">=",
      field: "shares",
      fieldPos: 16,
      value: { kind: "usdc", atomic: 10_000_000n, rawDecimal: "1 USDC" },
      valuePos: 26,
    },
  };
  const depositEvent = mockEvent("squad", {
    name: "deposited",
    marketId: 1,
    side: 1,
    participant: "G...",
    amount: 50_000_000n,
    shares: 50_000_000n,
  });
  assert.equal(evaluateFilterRule(mixedSharesRule, depositEvent), false);
});

