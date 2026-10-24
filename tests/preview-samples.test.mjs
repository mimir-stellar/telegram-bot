import assert from "node:assert/strict";
import test from "node:test";

import { formatEvent, previewMessage } from "../dist/notifications/format.js";
import { SAMPLE_EVENTS, VALID_SAMPLE_NAMES } from "../dist/notifications/samples.js";
import { assertValidMarkdownV2, findUnescapedReserved } from "./markdown-lint.test.mjs";

const TEST_CONFIG = {
  chatIds: ["-1001234567890"],
  marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M",
  rpcUrl: "https://example.invalid/rpc",
  horizonUrl: "https://example.invalid/horizon",
  networkPassphrase: "Test SDF Network ; September 2015",
  linkPreviewMarket: true,
  linkPreviewSquad: false,
};

test("SAMPLE_EVENTS exports one sample DecodedEvent per market and squad event name", () => {
  const expectedMarketEvents = [
    "claim_created",
    "claim_challenged",
    "claim_resolved",
    "claim_cancelled",
    "market_settled",
    "challenger_paid",
    "fee_claimed",
    "withdrawal",
    "withdrawal_pending",
  ];
  const expectedSquadEvents = [
    "market_created",
    "deposited",
    "withdrawn",
    "resolved",
    "claimed",
    "fees_claimed",
  ];

  for (const name of expectedMarketEvents) {
    assert.ok(SAMPLE_EVENTS[name], `Missing sample for market event ${name}`);
    assert.equal(SAMPLE_EVENTS[name].source, "market");
    assert.equal(SAMPLE_EVENTS[name].payload.name, name);
  }

  for (const name of expectedSquadEvents) {
    assert.ok(SAMPLE_EVENTS[name], `Missing sample for squad event ${name}`);
    assert.equal(SAMPLE_EVENTS[name].source, "squad");
    assert.equal(SAMPLE_EVENTS[name].payload.name, name);
  }

  assert.equal(VALID_SAMPLE_NAMES.length, 15);
  for (const name of VALID_SAMPLE_NAMES) {
    assert.ok(SAMPLE_EVENTS[name]);
  }
});

test("Each sample renders through formatEvent without errors", () => {
  for (const [name, event] of Object.entries(SAMPLE_EVENTS)) {
    const rendered = formatEvent(TEST_CONFIG, event);
    assert.ok(rendered !== null, `Expected formatEvent to return non-null string for ${name}`);
    assert.ok(typeof rendered === "string" && rendered.length > 0);

    // Check MarkdownV2 validity heuristics
    assertValidMarkdownV2(rendered, `formatEvent(${name})`);
  }
});

test("previewMessage renders each event name successfully with valid MarkdownV2", () => {
  for (const name of VALID_SAMPLE_NAMES) {
    const preview = previewMessage(TEST_CONFIG, name);
    assert.ok(preview.length > 0, `Preview for ${name} should not be empty`);
    assertValidMarkdownV2(preview, `previewMessage(${name})`);
  }
});

test("previewMessage keeps market and squad arguments working as before", () => {
  const marketPreview = previewMessage(TEST_CONFIG, "market");
  assert.ok(marketPreview.includes("Channel Preview — mimir\\-market"));
  assert.ok(marketPreview.includes("Link previews: enabled"));
  assert.ok(marketPreview.includes("New claim"));
  assertValidMarkdownV2(marketPreview, "previewMessage(market)");

  const squadPreview = previewMessage(TEST_CONFIG, "squad");
  assert.ok(squadPreview.includes("Channel Preview — mimir\\-squad"));
  assert.ok(squadPreview.includes("Link previews: disabled"));
  assert.ok(squadPreview.includes("New squad market"));
  assertValidMarkdownV2(squadPreview, "previewMessage(squad)");
});

test("previewMessage replies with valid names escaped for MarkdownV2 on unknown arguments", () => {
  const unknownArgs = [
    "unknown_foo",
    "foo_bar",
    "invalid.event!name*",
    "-help",
  ];

  for (const arg of unknownArgs) {
    const response = previewMessage(TEST_CONFIG, arg);
    assert.ok(response.includes("Unknown preview event"));
    assert.ok(response.includes("Usage:"));
    assert.ok(response.includes("Valid names:"));

    for (const name of VALID_SAMPLE_NAMES) {
      assert.ok(
        response.includes(name.replace(/_/g, "\\_")),
        `Expected usage message to include escaped valid name ${name}`,
      );
    }

    assertValidMarkdownV2(response, `previewMessage(${arg})`);
  }
});

test("MarkdownV2 validity heuristics: no unescaped reserved characters outside entities in samples and fallback", () => {
  for (const [name, event] of Object.entries(SAMPLE_EVENTS)) {
    const formatted = formatEvent(TEST_CONFIG, event);
    assert.ok(formatted);
    const unescaped = findUnescapedReserved(formatted);
    assert.equal(
      unescaped.length,
      0,
      `Found unescaped reserved characters in formatEvent(${name}): ${JSON.stringify(unescaped)}`,
    );

    const preview = previewMessage(TEST_CONFIG, name);
    const unescapedPreview = findUnescapedReserved(preview);
    assert.equal(
      unescapedPreview.length,
      0,
      `Found unescaped reserved characters in previewMessage(${name}): ${JSON.stringify(unescapedPreview)}`,
    );
  }

  const unknownReply = previewMessage(TEST_CONFIG, "some_bad_event");
  const unescapedReply = findUnescapedReserved(unknownReply);
  assert.equal(
    unescapedReply.length,
    0,
    `Found unescaped reserved characters in unknown argument reply: ${JSON.stringify(unescapedReply)}`,
  );
});
