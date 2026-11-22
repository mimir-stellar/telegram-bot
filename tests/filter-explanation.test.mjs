import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EXPLANATION_DEPTH,
  MAX_EXPLANATION_NODES,
  MAX_EXPLANATION_REASON_LENGTH,
  MAX_FILTER_TOKENS,
  evaluateFilterDryRun,
  evaluateFilterRule,
  explainFilterRule,
  parseFilterExpression,
  renderFilterExplanation,
} from "../dist/notifications/filter-expr.js";

// ---------------------------------------------------------------------------
// Synthetic fixtures (credential-free; stable fake ids)
// ---------------------------------------------------------------------------

const CHALLENGER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CREATOR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const PRIVATE_TITLE = "Synthetic private claim title do-not-leak";

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

function challengeEvent(stake, extra = {}) {
  const payload = { name: "claim_challenged", claimId: 7, challenger: CHALLENGER, ...extra };
  if (stake !== undefined) payload.stake = stake;
  return mockEvent("market", payload);
}

function createdEvent() {
  return mockEvent("market", {
    name: "claim_created",
    claimId: 9,
    creator: CREATOR,
    category: "crypto",
    title: PRIVATE_TITLE,
  });
}

function depositEvent(amount) {
  const payload = {
    name: "deposited",
    marketId: 42,
    side: 1,
    participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    shares: 0n,
  };
  if (amount !== undefined) payload.amount = amount;
  return mockEvent("squad", payload);
}

const USDC = 10_000_000n;

function kinds(node, out = []) {
  out.push(node.kind);
  for (const child of node.children ?? []) kinds(child, out);
  return out;
}

function allNodes(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) allNodes(child, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tree shape and reasons
// ---------------------------------------------------------------------------

test("a matched rule explains every node in AST order", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC and claimId == 7");
  const explanation = explainFilterRule(rule, challengeEvent(150n * USDC));

  assert.deepEqual(explanation, {
    matched: true,
    reason: "matched",
    nodeCount: 5,
    truncated: false,
    root: {
      kind: "rule",
      matched: true,
      outcome: "matched",
      reason: "rule matched: event allowed",
      children: [
        { kind: "event-name", matched: true, outcome: "matched", reason: "event is claim_challenged" },
        {
          kind: "and",
          matched: true,
          outcome: "matched",
          reason: "and: both sides matched",
          children: [
            { kind: "comparison", matched: true, outcome: "matched", reason: "stake >= 100 USDC: true" },
            { kind: "comparison", matched: true, outcome: "matched", reason: "claimId == 7: true" },
          ],
        },
      ],
    },
  });
});

test("a failed predicate names the failing comparison and marks short-circuited branches", () => {
  const rule = parseFilterExpression(
    "claim_challenged where (stake >= 100 USDC and claimId == 7) or claimId == 42",
  );
  const explanation = explainFilterRule(rule, challengeEvent(25n * USDC));

  assert.equal(explanation.matched, false);
  assert.equal(explanation.reason, "predicate-false");
  assert.equal(
    renderFilterExplanation(explanation),
    [
      "✗ [rule] rule failed (predicate-false): event denied",
      "  ✓ [event-name] event is claim_challenged",
      "  ✗ [or] or: neither side matched",
      "    ✗ [and] and: left side failed; right side not evaluated",
      "      ✗ [comparison] stake >= 100 USDC: false",
      "      - [comparison] claimId == 7: not evaluated",
      "    ✗ [comparison] claimId == 42: false",
    ].join("\n"),
  );
});

test("an `or` whose left side matches does not evaluate the right side", () => {
  const rule = parseFilterExpression("claim_challenged where claimId == 7 or stake >= 100 USDC");
  const { root } = explainFilterRule(rule, challengeEvent(undefined));
  const or = root.children[1];
  assert.equal(or.reason, "or: left side matched; right side not evaluated");
  assert.equal(or.children[1].outcome, "not-evaluated");
  assert.equal(or.children[1].matched, false);
});

test("missing field is reported separately from a false predicate", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC");
  const missing = explainFilterRule(rule, challengeEvent(undefined));
  assert.equal(missing.reason, "missing-field");
  assert.deepEqual(missing.root.children[1], {
    kind: "comparison",
    matched: false,
    outcome: "missing-field",
    reason: "stake >= 100 USDC: field absent from payload",
  });

  const low = explainFilterRule(rule, challengeEvent(1n));
  assert.equal(low.reason, "predicate-false");
  assert.equal(low.root.children[1].outcome, "predicate-false");
});

test("an event-name mismatch skips the condition and does not echo the actual event name", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 1 USDC");
  const explanation = explainFilterRule(rule, createdEvent());
  assert.equal(explanation.matched, false);
  assert.equal(explanation.reason, "event-name-mismatch");
  assert.deepEqual(explanation.root.children[0], {
    kind: "event-name",
    matched: false,
    outcome: "event-name-mismatch",
    reason: "event is not claim_challenged",
  });
  assert.equal(explanation.root.children[1].outcome, "not-evaluated");
  assert.ok(!JSON.stringify(explanation).includes("claim_created"));
});

test("a rule with no event name and no condition is a bare matched root", () => {
  const rule = { rawExpression: "" };
  const explanation = explainFilterRule(rule, createdEvent());
  assert.equal(explanation.matched, true);
  assert.equal(explanation.nodeCount, 1);
  assert.deepEqual(explanation.root.children, undefined);
});

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

test("thresholds add a node evaluated after the expression, as in the live path", () => {
  const rule = parseFilterExpression("deposited");
  const thresholds = { squadDeposit: 50n * USDC };

  const below = explainFilterRule(rule, depositEvent(10n * USDC), { thresholds });
  assert.equal(below.reason, "below-threshold");
  assert.deepEqual(below.root.children.at(-1), {
    kind: "threshold",
    matched: false,
    outcome: "below-threshold",
    reason: "amount threshold: amount below minimum 50 USDC",
  });

  const missing = explainFilterRule(rule, depositEvent(undefined), { thresholds });
  assert.equal(missing.reason, "missing-field");
  assert.equal(missing.root.children.at(-1).outcome, "missing-field");

  const passed = explainFilterRule(rule, depositEvent(50n * USDC), { thresholds });
  assert.equal(passed.matched, true);
  assert.equal(passed.root.children.at(-1).reason, "amount threshold: amount >= 50 USDC");

  const other = explainFilterRule(parseFilterExpression("claim_created"), createdEvent(), { thresholds });
  assert.equal(other.matched, true);
  assert.equal(other.root.children.at(-1).outcome, "not-configured");

  const skipped = explainFilterRule(parseFilterExpression("withdrawn"), depositEvent(1n), { thresholds });
  assert.equal(skipped.root.children.at(-1).outcome, "not-evaluated");
});

// ---------------------------------------------------------------------------
// Compatibility with the existing evaluators
// ---------------------------------------------------------------------------

test("matched and reason always agree with evaluateFilterRule and evaluateFilterDryRun", () => {
  const expressions = [
    "claim_challenged",
    "claim_challenged where stake >= 100 USDC",
    "claim_challenged where stake > $0.5 or claimId == 7",
    "claim_challenged where (stake < 10 and claimId != 7) or (challenger == 'x' and stake >= 1)",
    "where claimId == 7 or stake >= 100 USDC",
    "where stake >= 1 USDC or claimId == 99",
    "where claimId == 99 or stake >= 1 USDC",
    "deposited where amount >= 1.5 USDC and side == 1",
    "claim_created where category == 'crypto' and title != 'x'",
  ];
  const events = [
    challengeEvent(undefined),
    challengeEvent(1n),
    challengeEvent(100n * USDC),
    challengeEvent(5n * USDC, { claimId: 8 }),
    createdEvent(),
    depositEvent(undefined),
    depositEvent(2n * USDC),
  ];
  const thresholdSets = [undefined, { marketChallenge: 10n * USDC, squadDeposit: 1n * USDC }];

  for (const expression of expressions) {
    const rule = parseFilterExpression(expression);
    for (const event of events) {
      const plain = explainFilterRule(rule, event);
      assert.equal(plain.matched, evaluateFilterRule(rule, event), expression);
      for (const thresholds of thresholdSets) {
        const explained = explainFilterRule(rule, event, { thresholds });
        const dryRun = evaluateFilterDryRun(rule, event, thresholds);
        assert.equal(explained.matched, dryRun.matched, expression);
        assert.equal(explained.reason, dryRun.reason, expression);
        assert.equal(explained.root.matched, dryRun.matched, expression);
      }
    }
  }
});

test("explaining does not mutate the rule or the event", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC or claimId == 7");
  const event = challengeEvent(3n);
  const ruleBefore = structuredClone(rule);
  const eventBefore = structuredClone(event);
  explainFilterRule(rule, event, { thresholds: { marketChallenge: 1n }, maxNodes: 2 });
  assert.deepEqual(rule, ruleBefore);
  assert.deepEqual(event, eventBefore);
});

test("the explanation is deterministic and JSON-serializable", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 0.0000001 USDC and claimId == 7");
  const event = challengeEvent(5n);
  const thresholds = { marketChallenge: 12_345_678n };
  const first = explainFilterRule(rule, event, { thresholds });
  const second = explainFilterRule(rule, event, { thresholds });
  assert.deepEqual(first, second);
  assert.equal(renderFilterExplanation(first), renderFilterExplanation(second));
  const json = JSON.stringify(first); // throws on bigint
  assert.ok(json.includes("stake >= 0.0000001 USDC: true"));
  assert.ok(json.includes("minimum 1.2345678 USDC"));
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test("payload values and string literals never appear in the explanation", () => {
  const rule = parseFilterExpression(
    `claim_created where creator == "${CREATOR}" and title != "${PRIVATE_TITLE}" or category == 'route-secret'`,
  );
  const explanation = explainFilterRule(rule, createdEvent());
  const json = JSON.stringify(explanation);
  const text = renderFilterExplanation(explanation);

  for (const secret of [CREATOR, PRIVATE_TITLE, "route-secret", "crypto", "do-not-leak"]) {
    assert.ok(!json.includes(secret), `json leaked ${secret}`);
    assert.ok(!text.includes(secret), `text leaked ${secret}`);
  }
  assert.ok(text.includes('creator == <redacted>: true'));
  assert.ok(text.includes('title != <redacted>: false'));
});

test("numeric payload values are not echoed, only the rule's own literal", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC");
  const json = JSON.stringify(explainFilterRule(rule, challengeEvent(123_456_789n)));
  assert.ok(!json.includes("123456789"));
  assert.ok(!json.includes("12.3456789"));
});

test("a hand-built rule with an unsafe field name is not echoed", () => {
  const rule = {
    rawExpression: "",
    condition: {
      type: "comparison",
      op: "==",
      field: "x\" onclick=alert(1)",
      fieldPos: 0,
      value: { kind: "number", value: 1, raw: "1e999 <b>" },
      valuePos: 0,
    },
  };
  const text = renderFilterExplanation(explainFilterRule(rule, createdEvent()));
  assert.ok(text.includes("<field> == <number>: field absent from payload"));
  assert.ok(!text.includes("onclick"));
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("exported default bounds are positive integers", () => {
  for (const bound of [MAX_EXPLANATION_NODES, MAX_EXPLANATION_DEPTH, MAX_EXPLANATION_REASON_LENGTH]) {
    assert.ok(Number.isInteger(bound) && bound > 0);
  }
});

test("maxNodes caps the tree in pre-order and counts what was omitted", () => {
  const rule = parseFilterExpression(
    "claim_challenged where (stake >= 100 USDC and claimId == 7) or claimId == 42",
  );
  const event = challengeEvent(25n * USDC);
  const full = explainFilterRule(rule, event);
  assert.equal(full.nodeCount, 7);

  for (let maxNodes = 1; maxNodes <= 7; maxNodes++) {
    const bounded = explainFilterRule(rule, event, { maxNodes });
    assert.equal(bounded.nodeCount, maxNodes);
    assert.equal(bounded.truncated, maxNodes < 7);
    const omitted = allNodes(bounded.root).reduce((sum, node) => sum + (node.omitted ?? 0), 0);
    assert.equal(bounded.nodeCount + omitted, full.nodeCount);
    // Truncation never changes the decision.
    assert.equal(bounded.matched, false);
    assert.equal(bounded.reason, "predicate-false");
    assert.deepEqual(kinds(bounded.root), kinds(full.root).slice(0, maxNodes));
  }

  const rootOnly = explainFilterRule(rule, event, { maxNodes: 1 });
  assert.match(renderFilterExplanation(rootOnly), /… 6 more node\(s\) omitted$/);
});

test("maxDepth caps nesting and counts dropped subtrees", () => {
  const rule = parseFilterExpression(
    "claim_challenged where (stake >= 100 USDC and claimId == 7) or claimId == 42",
  );
  const event = challengeEvent(25n * USDC);

  const depth0 = explainFilterRule(rule, event, { maxDepth: 0 });
  assert.equal(depth0.nodeCount, 1);
  assert.equal(depth0.root.omitted, 6);
  assert.equal(depth0.truncated, true);

  const depth2 = explainFilterRule(rule, event, { maxDepth: 2 });
  const and = depth2.root.children[1].children[0];
  assert.equal(and.kind, "and");
  assert.equal(and.children, undefined);
  assert.equal(and.omitted, 2);
  assert.equal(depth2.nodeCount, 5);
});

test("reasons are clipped to maxReasonLength", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC");
  const explanation = explainFilterRule(rule, challengeEvent(1n), { maxReasonLength: 12 });
  for (const node of allNodes(explanation.root)) {
    assert.ok(node.reason.length <= 12, node.reason);
  }
  assert.equal(explanation.root.children[1].reason, "stake >= 10…");
});

test("invalid bound options fall back to defaults or the minimum", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC");
  const event = challengeEvent(1n);
  const full = explainFilterRule(rule, event);
  assert.deepEqual(explainFilterRule(rule, event, { maxNodes: Number.NaN, maxDepth: Infinity }), full);
  assert.equal(explainFilterRule(rule, event, { maxNodes: 0 }).nodeCount, 1);
  assert.equal(explainFilterRule(rule, event, { maxNodes: -5 }).nodeCount, 1);
  assert.equal(explainFilterRule(rule, event, { maxDepth: -1 }).nodeCount, 1);
  const clipped = explainFilterRule(rule, event, { maxReasonLength: 1 });
  assert.ok(allNodes(clipped.root).every((node) => node.reason.length <= 8));
});

test("the largest parseable expression stays within the default bounds", () => {
  // Event name + `where` + 24 comparisons (3 tokens each) + 23 `or` = 97 tokens,
  // a left-deep chain 24 levels deep.
  const terms = Array.from({ length: 24 }, (_, i) => `claimId == ${i + 100}`);
  const expression = `claim_challenged where ${terms.join(" or ")}`;
  const rule = parseFilterExpression(expression);
  assert.ok(expression.split(" ").length <= MAX_FILTER_TOKENS);

  const explanation = explainFilterRule(rule, challengeEvent(1n));
  assert.equal(explanation.matched, false);
  assert.ok(explanation.nodeCount <= MAX_EXPLANATION_NODES);
  assert.equal(explanation.truncated, false);
  assert.equal(explanation.nodeCount, 49);
  const text = renderFilterExplanation(explanation);
  assert.ok(text.split("\n").length <= MAX_EXPLANATION_NODES + MAX_EXPLANATION_NODES);
  for (const node of allNodes(explanation.root)) {
    assert.ok(node.reason.length <= MAX_EXPLANATION_REASON_LENGTH);
  }

  const tight = explainFilterRule(rule, challengeEvent(1n), { maxNodes: 10 });
  assert.equal(tight.nodeCount, 10);
  assert.equal(tight.truncated, true);
  assert.ok(renderFilterExplanation(tight).split("\n").length <= 20);
});
