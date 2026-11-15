import assert from "node:assert/strict";
import test from "node:test";

import {
  explainFilterEvaluation,
  explainFilterRule,
  evaluateFilterRule,
  formatFilterExplanationTree,
  parseFilterExpression,
} from "../dist/notifications/filter-expr.js";
import {
  meetsThreshold,
  parseUsdcThreshold,
} from "../dist/notifications/amount-threshold.js";

const FAKE_BOT_TOKEN = ["123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghi"].join("_");

function mockEvent(source, payload) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    version: "v1",
    ledger: 5000,
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    at: 1700000000,
    eventId: "0000005000-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 1,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("explainFilterEvaluation produces deterministic AST and threshold trees for matched and failed predicates", () => {
  const rule = parseFilterExpression(
    "claim_challenged where (claimId == 42 or claimId == 99) and stake >= 20 USDC",
  );
  const thresholds = { marketChallenge: parseUsdcThreshold("50") };

  const event = mockEvent("market", {
    name: "claim_challenged",
    claimId: 42,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    stake: 300_000_000n, // 30 USDC: passes rule (>= 20 USDC), fails threshold (< 50 USDC)
  });

  const report1 = explainFilterEvaluation(event, {
    rule,
    thresholds,
    routeRole: "market",
  });
  const report2 = explainFilterEvaluation(event, {
    rule,
    thresholds,
    routeRole: "market",
  });

  // Deterministic structural & rendered equality
  assert.deepEqual(report1, report2);
  assert.equal(formatFilterExplanationTree(report1), formatFilterExplanationTree(report2));

  // Matches live allow/deny combination
  const expectedLive = evaluateFilterRule(rule, event) && meetsThreshold(event, thresholds);
  assert.equal(report1.allowed, false);
  assert.equal(report1.allowed, expectedLive);

  // Records both matched and failed leaf predicates deterministically
  assert.ok(report1.matchedPredicates.some((r) => r.includes("claimId == 42 -> matched")));
  assert.ok(report1.matchedPredicates.some((r) => r.includes("stake >= 20 USDC -> matched")));
  assert.ok(report1.failedPredicates.some((r) => r.includes("claimId == 99 -> failed")));
  assert.ok(report1.failedPredicates.some((r) => r.includes("stake (30 USDC) < 50 USDC")));

  const rendered = formatFilterExplanationTree(report1);
  assert.match(rendered, /^Filter Explanation: DENY source=market event=claim_challenged ledger=5000 id=0000005000-0000000001 route=market/m);
  assert.match(rendered, /\[PASS\] n1 rule:/);
  assert.match(rendered, /\[FAIL\] n8 threshold: stake \(30 USDC\) < 50 USDC/);
});

test("explanation output omits message contents and scrubs private route identities and secrets", () => {
  const sampleClaimTitle = "CONFIDENTIAL_CLAIM_BODY_TEXT_DO_NOT_ECHO";
  const sampleRenderedMsg = "Telegram rendered notification body for private subscribers";
  const privateChatId = "-1009876543210";
  const privateChannel = "@private_ops_alert_room";
  const privateUserId = "998877665";

  const rule = parseFilterExpression(
    `claim_created where title == '${sampleClaimTitle}' and category == '${privateChannel}'`,
  );
  const event = mockEvent("market", {
    name: "claim_created",
    claimId: 77,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    category: `${privateChannel} ${FAKE_BOT_TOKEN}`,
    title: sampleClaimTitle,
  });

  const report = explainFilterRule(rule, event, {
    routeRole: "default",
    chatId: privateChatId,
    userId: privateUserId,
    messageText: sampleRenderedMsg,
  });

  const serialized = JSON.stringify(report);
  const formatted = formatFilterExplanationTree(report);

  for (const sensitive of [
    sampleClaimTitle,
    sampleRenderedMsg,
    privateChatId,
    privateChannel,
    privateUserId,
    FAKE_BOT_TOKEN,
  ]) {
    assert.equal(
      serialized.includes(sensitive),
      false,
      `Structured explanation leaked sensitive value: ${sensitive}`,
    );
    assert.equal(
      formatted.includes(sensitive),
      false,
      `Formatted explanation leaked sensitive value: ${sensitive}`,
    );
  }

  assert.match(formatted, /title == <omitted-content> -> matched \(actual <omitted-content>\)/);
  assert.equal(report.routeRole, "default");
});

test("explanation enforces bounded reason lengths and bounded maxNodes without altering live decision", () => {
  const longCategory = "c".repeat(200);
  const expr = [
    `claim_created where category == '${longCategory}'`,
    "and claimId > 1",
    "and claimId > 2",
    "and claimId > 3",
    "and claimId > 4",
    "and claimId > 5",
  ].join(" ");
  const rule = parseFilterExpression(expr);

  const event = mockEvent("market", {
    name: "claim_created",
    claimId: 10,
    creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    category: longCategory,
    title: "Hidden claim title",
  });

  const report = explainFilterRule(rule, event, {
    maxReasonLength: 48,
    maxNodes: 5,
  });

  assert.equal(report.allowed, true);
  assert.equal(report.allowed, evaluateFilterRule(rule, event));
  assert.equal(report.truncated, true);
  assert.equal(report.nodeCount, 5);

  const checkLengths = (node) => {
    assert.ok(
      node.reason.length <= 48,
      `Node ${node.id} reason exceeded maxReasonLength=48: ${node.reason.length}`,
    );
    for (const child of node.children) checkLengths(child);
  };
  checkLengths(report.tree);
});
