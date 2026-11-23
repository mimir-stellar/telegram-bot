import assert from "node:assert/strict";
import test from "node:test";

import {
  checkEventSemanticParity,
  checkRenderedParity,
  extractSemanticFacts,
  normalizeRenderedText,
} from "../dist/notifications/parity.js";
import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";
import { formatEventHtml } from "../dist/notifications/html.js";

const VALID_TX = "0123456789abcdef".repeat(4);
const ADDR_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ADDR_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBJ2P";

function testnetConfig(overrides = {}) {
  return {
    chatIds: ["-1001234567890"],
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

function makeEvent(source, payload, overrides = {}) {
  return {
    source,
    contractId:
      source === "market"
        ? "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI"
        : "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    version: "v1",
    ledger: 4226691,
    txHash: VALID_TX,
    at: 1_756_684_800,
    eventId: "0018276211125911551-0000000000",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
    ...overrides,
  };
}

const NOTIFIABLE_EVENTS = [
  // mimir-market
  makeEvent("market", {
    name: "claim_created",
    claimId: 7,
    creator: ADDR_A,
    category: "crypto & macro <2026>",
  }),
  makeEvent("market", {
    name: "claim_challenged",
    claimId: 7,
    challenger: ADDR_B,
    stake: 250_000_000n,
  }),
  makeEvent("market", {
    name: "claim_resolved",
    claimId: 7,
    winnerSide: 2,
    summary: "Evidence confirmed with >90% certainty & audit trail.",
    confidence: 92,
    evidenceHash: "abcd".repeat(16),
  }),
  makeEvent("market", {
    name: "claim_cancelled",
    claimId: 8,
  }),
  makeEvent("market", {
    name: "market_settled",
    claimId: 7,
    totalPaid: 490_000_000n,
    totalFees: 10_000_000n,
    owedToChallengers: 490_000_000n,
    dust: 0n,
  }),
  makeEvent("market", {
    name: "challenger_paid",
    claimId: 7,
    challenger: ADDR_B,
    stake: 250_000_000n,
    gross: 500_000_000n,
    fee: 10_000_000n,
    net: 490_000_000n,
  }),
  makeEvent("market", {
    name: "fee_claimed",
    recipient: ADDR_A,
    amount: 15_500_000n,
  }),
  makeEvent("market", {
    name: "withdrawal",
    to: ADDR_B,
    amount: 100_000_000n,
  }),
  makeEvent("market", {
    name: "withdrawal_pending",
    to: ADDR_B,
    amount: 42_000_000n,
  }),

  // mimir-squad
  makeEvent("squad", {
    name: "market_created",
    marketId: 12,
    captain: ADDR_A,
    deadline: 1_760_000_000,
    feeBps: 250,
    question: "Will XLM close above $1.00 <before Q4>?",
  }),
  makeEvent("squad", {
    name: "deposited",
    marketId: 12,
    participant: ADDR_B,
    side: 1,
    amount: 75_000_000n,
  }),
  makeEvent("squad", {
    name: "withdrawn",
    marketId: 12,
    participant: ADDR_B,
    side: 2,
    amount: 25_000_000n,
  }),
  makeEvent("squad", {
    name: "resolved",
    marketId: 12,
    result: 1,
    poolA: 300_000_000n,
    poolB: 150_000_000n,
  }),
  makeEvent("squad", {
    name: "claimed",
    marketId: 12,
    participant: ADDR_B,
    gross: 150_000_000n,
    fee: 3_750_000n,
    net: 146_250_000n,
  }),
  makeEvent("squad", {
    name: "fees_claimed",
    recipient: ADDR_A,
    amount: 3_750_000n,
  }),
];

test("all 15 notifiable events preserve semantic parity across markdown, plaintext, and html", () => {
  const config = testnetConfig();

  for (const event of NOTIFIABLE_EVENTS) {
    const result = checkEventSemanticParity(config, event);
    assert.equal(
      result.ok,
      true,
      `Expected parity for ${result.eventName}, got violations: ${JSON.stringify(result.violations)}`,
    );
    assert.ok(result.facts.length > 0, `Expected semantic facts for ${result.eventName}`);
    assert.equal(typeof result.rendered.markdown, "string");
    assert.equal(typeof result.rendered.plaintext, "string");
    assert.equal(typeof result.rendered.html, "string");
  }
});

test("non-notifiable events pass parity when all renderers return null", () => {
  const config = testnetConfig();
  const silentEvents = [
    makeEvent("market", { name: "oracle_changed", oldOracle: ADDR_A, newOracle: ADDR_B }),
    makeEvent("market", { name: "admin", action: "pause", raw: {} }),
    makeEvent("squad", { name: "unknown", eventName: "future_event", raw: {} }),
  ];

  for (const event of silentEvents) {
    const result = checkEventSemanticParity(config, event);
    assert.equal(result.ok, true);
    assert.deepEqual(result.facts, []);
    assert.equal(result.rendered.markdown, null);
    assert.equal(result.rendered.plaintext, null);
    assert.equal(result.rendered.html, null);
  }
});

test("presentation differences (tags, escaping, emoji, link style, whitespace) are allowed", () => {
  const config = testnetConfig();
  const event = NOTIFIABLE_EVENTS[2]; // claim_resolved

  const md = formatEvent(config, event);
  const plain = formatPlainTextEvent(config, event);
  const html = formatEventHtml(config, event);

  // Add cosmetic presentation differences: extra spacing, different tags/emojis.
  const result = checkRenderedParity(event, {
    markdown: `🔔 ${md}\n\n`,
    plaintext: `   ${plain}   `,
    html: `<b>[PREVIEW]</b>\n${html}`,
  });

  assert.equal(result.ok, true, `Unexpected violations: ${JSON.stringify(result.violations)}`);
});

test("rejects lost event identity fact in html renderer", () => {
  const config = testnetConfig();
  const event = NOTIFIABLE_EVENTS[0]; // claim_created (#7)

  const md = formatEvent(config, event);
  const plain = formatPlainTextEvent(config, event);
  const brokenHtml = formatEventHtml(config, event).replace("#7", "#999");

  const result = checkRenderedParity(event, {
    markdown: md,
    plaintext: plain,
    html: brokenHtml,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.format === "html" && v.kind === "identity" && v.field === "claimId"),
    `Expected identity violation for claimId, got: ${JSON.stringify(result.violations)}`,
  );
});

test("rejects lost amount fact in markdown renderer", () => {
  const config = testnetConfig();
  const event = NOTIFIABLE_EVENTS[1]; // claim_challenged (25 USDC)

  const brokenMd = formatEvent(config, event).replace("25", "0");
  const plain = formatPlainTextEvent(config, event);
  const html = formatEventHtml(config, event);

  const result = checkRenderedParity(event, {
    markdown: brokenMd,
    plaintext: plain,
    html,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.format === "markdown" && v.kind === "amount" && v.field === "stake"),
    `Expected amount violation for stake, got: ${JSON.stringify(result.violations)}`,
  );
});

test("rejects lost verdict fact in plaintext renderer", () => {
  const config = testnetConfig();
  const event = NOTIFIABLE_EVENTS[2]; // claim_resolved (challengers, confidence 92)

  const md = formatEvent(config, event);
  const brokenPlain = formatPlainTextEvent(config, event).replace(/challengers/i, "creator");
  const html = formatEventHtml(config, event);

  const result = checkRenderedParity(event, {
    markdown: md,
    plaintext: brokenPlain,
    html,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.format === "plaintext" && v.kind === "verdict" && v.field === "winnerSide"),
    `Expected verdict violation for winnerSide, got: ${JSON.stringify(result.violations)}`,
  );
});

test("rejects nullability mismatch when one renderer drops an event", () => {
  const config = testnetConfig();
  const event = NOTIFIABLE_EVENTS[12]; // squad resolved

  const result = checkRenderedParity(event, {
    markdown: formatEvent(config, event),
    plaintext: formatPlainTextEvent(config, event),
    html: null,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.format === "html" && v.kind === "nullability"),
    `Expected nullability violation, got: ${JSON.stringify(result.violations)}`,
  );
});

test("normalizeRenderedText unescapes MarkdownV2 and strips HTML tags/entities", () => {
  assert.equal(
    normalizeRenderedText("markdown", "*Claim \\#7* — `GAAA…AWHF` \\(25\\.00 USDC\\) [tx](https://example.invalid/tx)"),
    "Claim #7 — GAAA…AWHF (25.00 USDC) tx https://example.invalid/tx",
  );
  assert.equal(
    normalizeRenderedText("html", '<b>Claim #7</b> &amp; <code>GAAA…AWHF</code> <a href="https://example.invalid/tx">tx</a>'),
    "Claim #7 & GAAA…AWHF tx https://example.invalid/tx",
  );
  assert.equal(
    normalizeRenderedText("plaintext", "  Claim #7\n\n  25.00 USDC  "),
    "Claim #7 25.00 USDC",
  );
});

test("extractSemanticFacts covers identity, amount, and verdict fields for squad resolved", () => {
  const event = NOTIFIABLE_EVENTS[12]; // squad resolved
  const facts = extractSemanticFacts(event);
  assert.deepEqual(
    facts.map((f) => `${f.kind}:${f.field}`),
    ["identity:marketId", "verdict:result", "amount:poolA", "amount:poolB", "identity:ledger"],
  );
});
