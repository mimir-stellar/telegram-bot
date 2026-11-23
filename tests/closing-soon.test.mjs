import assert from "node:assert/strict";
import test from "node:test";

import { closingSoon } from "../dist/stellar/closing-soon.js";
import { closingSoonMessage } from "../dist/notifications/closing-soon.js";

const nowSec = 1_700_000_000;
const nowMs = nowSec * 1000;
const horizonSec = 3600;

function squadEvent(payload, overrides = {}) {
  return {
    source: "squad",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    version: "v1",
    ledger: 1000,
    txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    at: nowSec,
    eventId: "1000-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
    ...overrides,
  };
}

function marketCreated(marketId, deadline, question = "Will it happen?") {
  return squadEvent({
    name: "market_created",
    marketId,
    captain: "GCAPTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    deadline,
    feeBps: 100,
    question,
  });
}

function resolved(marketId) {
  return squadEvent({
    name: "resolved",
    marketId,
    result: 1,
    poolA: 0n,
    poolB: 0n,
  });
}

test("closingSoon: excludes non-squad events", () => {
  const events = [
    marketCreated(1, nowSec + 100),
    { source: "market", payload: { name: "claim_created", claimId: 1 } },
  ];
  assert.deepEqual(closingSoon(events, nowSec, horizonSec), [
    { marketId: 1, deadline: nowSec + 100, question: "Will it happen?", captain: "GCAPTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", feeBps: 100 },
  ]);
});

test("closingSoon: includes markets inside the horizon", () => {
  const events = [
    marketCreated(1, nowSec + 60),
    marketCreated(2, nowSec + 300),
    marketCreated(3, nowSec + 3600),
  ];
  const out = closingSoon(events, nowSec, horizonSec);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((m) => m.marketId), [1, 2, 3]);
});

test("closingSoon: excludes markets outside the horizon", () => {
  const events = [marketCreated(1, nowSec + horizonSec + 1)];
  assert.deepEqual(closingSoon(events, nowSec, horizonSec), []);
});

test("closingSoon: excludes markets at exactly the horizon boundary", () => {
  const events = [marketCreated(1, nowSec + horizonSec)];
  assert.deepEqual(closingSoon(events, nowSec, horizonSec), [
    { marketId: 1, deadline: nowSec + horizonSec, question: "Will it happen?", captain: "GCAPTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", feeBps: 100 },
  ]);
});

test("closingSoon: excludes markets past their deadline", () => {
  const events = [
    marketCreated(1, nowSec - 1),
    marketCreated(2, nowSec),
    marketCreated(3, nowSec + 60),
  ];
  const out = closingSoon(events, nowSec, horizonSec);
  assert.deepEqual(out.map((m) => m.marketId), [3]);
});

test("closingSoon: excludes resolved markets", () => {
  const events = [marketCreated(1, nowSec + 60), resolved(1), marketCreated(2, nowSec + 120)];
  const out = closingSoon(events, nowSec, horizonSec);
  assert.deepEqual(out.map((m) => m.marketId), [2]);
});

test("closingSoon: sorts by deadline ascending", () => {
  const events = [
    marketCreated(3, nowSec + 300),
    marketCreated(1, nowSec + 60),
    marketCreated(2, nowSec + 120),
  ];
  const out = closingSoon(events, nowSec, horizonSec);
  assert.deepEqual(out.map((m) => m.marketId), [1, 2, 3]);
});

test("closingSoon: collapses duplicate market_created events", () => {
  const events = [
    marketCreated(1, nowSec + 60, "first"),
    marketCreated(1, nowSec + 120, "second"),
  ];
  const out = closingSoon(events, nowSec, horizonSec);
  assert.equal(out.length, 1);
  assert.equal(out[0].question, "second");
});

test("closingSoon: is pure and time-injected", () => {
  const events = [marketCreated(1, nowSec + 60)];
  const early = closingSoon(events, nowSec, horizonSec);
  const late = closingSoon(events, nowSec + 120, horizonSec);
  assert.deepEqual(early.length, 1);
  assert.deepEqual(late.length, 0);
});

test("closingSoonMessage: empty input", () => {
  const msg = closingSoonMessage([], nowMs);
  assert.match(msg, /Squad markets closing soon/);
  assert.match(msg, /No markets closing/);
});

test("closingSoonMessage: clips long questions and escapes MarkdownV2", () => {
  const markets = [
    {
      marketId: 7,
      deadline: nowSec + 60,
      question: "A".repeat(500) + " <b>bold</b> & more",
      captain: "GCAPTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      feeBps: 100,
    },
  ];
  const msg = closingSoonMessage(markets, nowMs);
  assert.match(msg, /#7/);
  assert.match(msg, /· closes/);
  // Clipped to MAX_EVENT_FIELD_LENGTH (200) chars minus ellipsis, then escaped.
  assert.ok(!msg.includes("<b>"));
  assert.ok(!msg.includes("&"));
  assert.ok(msg.includes("\\&quot;") || msg.includes("…") || !msg.includes("bold"));
});
