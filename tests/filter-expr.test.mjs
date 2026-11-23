import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_PAYLOAD_SCHEMAS,
  FILTER_SCHEMA_VERSION,
  FilterParseError,
  canonicalizeSchema,
  checkFilterStaleness,
  compileFilter,
  compileFilterExpression,
  compileFilterRule,
  computeSchemaDigest,
  evaluateFilterRule,
  getEventSchemaDigest,
  getSchemaDigest,
  isCompiledFilterStale,
  isFilterRuleStale,
  normalizeEventSchema,
  normalizeFieldDefinition,
  normalizeSchema,
  normalizeSchemaRegistry,
  normalizeSchemaVersion,
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

// ----------------------------------------------------
// Schema Normalization and Fingerprinting Tests
// ----------------------------------------------------

test("normalizeSchemaVersion: normalizes numbers and string representations", () => {
  assert.equal(normalizeSchemaVersion(1), 1);
  assert.equal(normalizeSchemaVersion(2.9), 2);
  assert.equal(normalizeSchemaVersion("1"), 1);
  assert.equal(normalizeSchemaVersion("v1"), 1);
  assert.equal(normalizeSchemaVersion("V3"), 3);
  assert.equal(normalizeSchemaVersion("  4  "), 4);

  assert.throws(() => normalizeSchemaVersion(0), /Invalid schema version/);
  assert.throws(() => normalizeSchemaVersion(-1), /Invalid schema version/);
  assert.throws(() => normalizeSchemaVersion("invalid"), /Invalid schema version string/);
  assert.throws(() => normalizeSchemaVersion(null), /Schema version must be a number or string/);
});

test("normalizeFieldDefinition: sets isUsdcAmount boolean and preserves type", () => {
  assert.deepEqual(normalizeFieldDefinition({ type: "string" }), {
    isUsdcAmount: false,
    type: "string",
  });
  assert.deepEqual(normalizeFieldDefinition({ type: "bigint", isUsdcAmount: true }), {
    isUsdcAmount: true,
    type: "bigint",
  });
});

test("normalizeEventSchema & computeSchemaDigest: order-independent and deterministic", () => {
  const schemaA = {
    title: { type: "string" },
    claimId: { type: "number" },
    creator: { type: "string" },
  };
  const schemaB = {
    creator: { type: "string" },
    title: { type: "string" },
    claimId: { type: "number" },
  };

  const normA = normalizeEventSchema(schemaA);
  const normB = normalizeEventSchema(schemaB);

  // Key ordering should be sorted alphabetically
  assert.deepEqual(Object.keys(normA), ["claimId", "creator", "title"]);
  assert.deepEqual(Object.keys(normB), ["claimId", "creator", "title"]);
  assert.deepEqual(normA, normB);

  const digestA = computeSchemaDigest(schemaA, 1);
  const digestB = computeSchemaDigest(schemaB, 1);
  assert.equal(digestA, digestB);
  assert.match(digestA, /^[a-f0-9]{64}$/);
});

test("computeSchemaDigest: changes on schema modification or version bump", () => {
  const baseSchema = {
    claimId: { type: "number" },
    creator: { type: "string" },
  };
  const baseDigest = computeSchemaDigest(baseSchema, 1);

  // 1. Adding a field changes digest
  const withAdded = {
    ...baseSchema,
    extra: { type: "string" },
  };
  assert.notEqual(computeSchemaDigest(withAdded, 1), baseDigest);

  // 2. Changing field type changes digest
  const withTypeChange = {
    claimId: { type: "string" },
    creator: { type: "string" },
  };
  assert.notEqual(computeSchemaDigest(withTypeChange, 1), baseDigest);

  // 3. Changing isUsdcAmount changes digest
  const withUsdcChange = {
    claimId: { type: "number", isUsdcAmount: true },
    creator: { type: "string" },
  };
  assert.notEqual(computeSchemaDigest(withUsdcChange, 1), baseDigest);

  // 4. Version bump changes digest
  assert.notEqual(computeSchemaDigest(baseSchema, 2), baseDigest);
});

test("getEventSchemaDigest: computes stable digest for known event schema", () => {
  const digest1 = getEventSchemaDigest("claim_created");
  const digest2 = getEventSchemaDigest("claim_created", EVENT_PAYLOAD_SCHEMAS, 1);
  assert.equal(digest1, digest2);
  assert.match(digest1, /^[a-f0-9]{64}$/);

  // Different events produce different digests
  const challengeDigest = getEventSchemaDigest("claim_challenged");
  assert.notEqual(digest1, challengeDigest);

  assert.throws(() => getEventSchemaDigest("non_existent_event"), /Unknown event schema/);
});

// ----------------------------------------------------
// Compilation Tests
// ----------------------------------------------------

test("compileFilterExpression: attaches normalized schemaVersion and digests", () => {
  const compiled = compileFilterExpression("claim_challenged where stake >= 100 USDC");

  assert.equal(compiled.eventName, "claim_challenged");
  assert.equal(compiled.schemaVersion, FILTER_SCHEMA_VERSION);
  assert.match(compiled.digest, /^[a-f0-9]{64}$/);
  assert.equal(compiled.schemaDigest, compiled.digest);
  assert.equal(compiled.fingerprint, compiled.digest);
  assert.equal(compiled.eventDigest, compiled.digest);
  assert.match(compiled.registryDigest, /^[a-f0-9]{64}$/);

  // Has evaluate helper
  const matchingEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "G...",
    stake: 1_000_000_000n,
  });
  const nonMatchingEvent = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "G...",
    stake: 500_000_000n,
  });
  assert.equal(compiled.evaluate(matchingEvent), true);
  assert.equal(compiled.evaluate(nonMatchingEvent), false);

  // Has isStale helper
  assert.equal(compiled.isStale(), false);
});

test("compileFilterRule & compileFilter: works with raw FilterRule or string", () => {
  const rawRule = {
    eventName: "claim_created",
    rawExpression: "claim_created",
  };
  const compiledFromRule = compileFilterRule(rawRule);
  assert.equal(compiledFromRule.schemaVersion, FILTER_SCHEMA_VERSION);
  assert.ok(compiledFromRule.digest);

  const compiledFromString = compileFilter("claim_created");
  assert.equal(compiledFromString.digest, compiledFromRule.digest);

  const compiledFromCompiled = compileFilter(rawRule);
  assert.equal(compiledFromCompiled.digest, compiledFromRule.digest);
});

test("parseFilterExpression: maintains backwards compatibility while attaching compiled metadata", () => {
  const rule = parseFilterExpression("claim_created where category == 'defi'");

  // Legacy FilterRule properties
  assert.equal(rule.eventName, "claim_created");
  assert.equal(rule.rawExpression, "claim_created where category == 'defi'");
  assert.ok(rule.condition);

  // New compiled properties
  assert.equal(rule.schemaVersion, 1);
  assert.match(rule.digest, /^[a-f0-9]{64}$/);
  assert.equal(rule.schemaDigest, rule.digest);
  assert.equal(typeof rule.evaluate, "function");
  assert.equal(typeof rule.isStale, "function");
});

// ----------------------------------------------------
// Staleness Detection Tests
// ----------------------------------------------------

test("isFilterRuleStale: fresh compiled rule is not stale", () => {
  const rule = compileFilterExpression("claim_challenged where stake >= 100 USDC");
  assert.equal(isFilterRuleStale(rule), false);
  assert.equal(isCompiledFilterStale(rule), false);
  assert.equal(rule.isStale(), false);

  const check = checkFilterStaleness(rule);
  assert.equal(check.stale, false);
});

test("isFilterRuleStale: detects staleness when event schema adds a new field", () => {
  const rule = compileFilterExpression("claim_challenged where stake >= 100");

  const modifiedSchemas = {
    ...EVENT_PAYLOAD_SCHEMAS,
    claim_challenged: {
      ...EVENT_PAYLOAD_SCHEMAS.claim_challenged,
      reason: { type: "string" },
    },
  };

  assert.equal(isFilterRuleStale(rule, modifiedSchemas), true);
  assert.equal(rule.isStale(modifiedSchemas), true);

  const check = checkFilterStaleness(rule, modifiedSchemas);
  assert.equal(check.stale, true);
  assert.equal(check.reason, "SCHEMA_DIGEST_MISMATCH");
});

test("isFilterRuleStale: detects staleness when event schema changes a field type", () => {
  const rule = compileFilterExpression("claim_challenged where stake >= 100");

  const modifiedSchemas = {
    ...EVENT_PAYLOAD_SCHEMAS,
    claim_challenged: {
      ...EVENT_PAYLOAD_SCHEMAS.claim_challenged,
      stake: { type: "string" },
    },
  };

  assert.equal(isFilterRuleStale(rule, modifiedSchemas), true);
  const check = checkFilterStaleness(rule, modifiedSchemas);
  assert.equal(check.stale, true);
});

test("isFilterRuleStale: detects staleness when a field used in rule condition is removed", () => {
  const rule = compileFilterExpression("claim_created where category == 'defi'");

  const { category, ...remainingFields } = EVENT_PAYLOAD_SCHEMAS.claim_created;
  const modifiedSchemas = {
    ...EVENT_PAYLOAD_SCHEMAS,
    claim_created: remainingFields,
  };

  assert.equal(isFilterRuleStale(rule, modifiedSchemas), true);
  const check = checkFilterStaleness(rule, modifiedSchemas);
  assert.equal(check.stale, true);
});

test("isFilterRuleStale: detects staleness when event is removed from schema registry", () => {
  const rule = compileFilterExpression("claim_challenged where stake >= 100");

  const { claim_challenged, ...remainingSchemas } = EVENT_PAYLOAD_SCHEMAS;

  assert.equal(isFilterRuleStale(rule, remainingSchemas), true);
  const check = checkFilterStaleness(rule, remainingSchemas);
  assert.equal(check.stale, true);
  assert.equal(check.reason, "UNKNOWN_EVENT");
});

test("isFilterRuleStale: detects staleness on schema version mismatch", () => {
  const rule = compileFilterExpression("claim_challenged where stake >= 100");

  // Bump expected version to 2
  assert.equal(isFilterRuleStale(rule, EVENT_PAYLOAD_SCHEMAS, 2), true);
  const check = checkFilterStaleness(rule, EVENT_PAYLOAD_SCHEMAS, 2);
  assert.equal(check.stale, true);
  assert.equal(check.reason, "VERSION_MISMATCH");
});

test("isFilterRuleStale: detects staleness on uncompiled / unversioned rule", () => {
  const uncompiledRule = {
    rawExpression: "claim_challenged",
    eventName: "claim_challenged",
  };
  assert.equal(isFilterRuleStale(uncompiledRule), true);
  const check = checkFilterStaleness(uncompiledRule);
  assert.equal(check.stale, true);
  assert.equal(check.reason, "UNCOMPILED_RULE");
});

test("isFilterRuleStale: schema key reordering does not falsely report stale (order-independent)", () => {
  const rule = compileFilterExpression("claim_challenged where stake >= 100");

  // Reorder the fields of claim_challenged
  const reorderedClaimChallenged = {
    stake: EVENT_PAYLOAD_SCHEMAS.claim_challenged.stake,
    name: EVENT_PAYLOAD_SCHEMAS.claim_challenged.name,
    claimId: EVENT_PAYLOAD_SCHEMAS.claim_challenged.claimId,
    challenger: EVENT_PAYLOAD_SCHEMAS.claim_challenged.challenger,
  };

  const reorderedSchemas = {
    ...EVENT_PAYLOAD_SCHEMAS,
    claim_challenged: reorderedClaimChallenged,
  };

  assert.equal(isFilterRuleStale(rule, reorderedSchemas), false);
  assert.equal(rule.isStale(reorderedSchemas), false);
});

test("isFilterRuleStale: changes to unrelated events do not make event-specific rules stale", () => {
  const rule = compileFilterExpression("claim_challenged where stake >= 100");

  // Modify market_created (unrelated to claim_challenged)
  const modifiedSchemas = {
    ...EVENT_PAYLOAD_SCHEMAS,
    market_created: {
      ...EVENT_PAYLOAD_SCHEMAS.market_created,
      newUnrelatedField: { type: "string" },
    },
  };

  assert.equal(isFilterRuleStale(rule, modifiedSchemas), false);
});

test("isFilterRuleStale: global rules (no eventName) become stale when any registry schema changes", () => {
  const globalRule = compileFilterExpression("where active == true");
  assert.equal(isFilterRuleStale(globalRule), false);

  const modifiedSchemas = {
    ...EVENT_PAYLOAD_SCHEMAS,
    market_created: {
      ...EVENT_PAYLOAD_SCHEMAS.market_created,
      newField: { type: "string" },
    },
  };

  assert.equal(isFilterRuleStale(globalRule, modifiedSchemas), true);
  const check = checkFilterStaleness(globalRule, modifiedSchemas);
  assert.equal(check.stale, true);
  assert.equal(check.reason, "SCHEMA_DIGEST_MISMATCH");
});
