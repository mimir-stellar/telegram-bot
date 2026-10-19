import assert from "node:assert/strict";
import test from "node:test";

import {
  RecentEventsStore,
  getEventId,
  sanitizeQuery,
  inlineResults,
  buildArticleResult,
  handleInlineQuery,
} from "../dist/commands/inline.js";
import { registerInlineQueryHandler } from "../dist/bot.js";

function makeFakeClaimEvent(claimId, category = "sports", ledger = 12345) {
  return {
    source: "market",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ledger,
    txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    eventId: `ev-${claimId}`,
    payload: {
      name: "claim_created",
      claimId: BigInt(claimId),
      creator: "GA2C5RFPE6GCKMY3Z47UJD5A475T2Q26QUAU5AHLP76BODQWDLK4QWKP",
      category,
    },
  };
}

function makeFakeSquadEvent(marketId, question = "Will team win?", ledger = 12346) {
  return {
    source: "squad",
    contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ledger,
    txHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    eventId: `ev-squad-${marketId}`,
    payload: {
      name: "market_created",
      marketId: BigInt(marketId),
      captain: "GA2C5RFPE6GCKMY3Z47UJD5A475T2Q26QUAU5AHLP76BODQWDLK4QWKP",
      question,
      feeBps: 100,
      deadline: 1700000000,
    },
  };
}

const fakeConfig = {
  marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  squadContractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  marketContractVersion: "1.0.0",
  squadContractVersion: "1.0.0",
  rpcUrl: "https://example.invalid/rpc",
  horizonUrl: "https://example.invalid/horizon",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://example.invalid/explorer",
  botToken: "123456789:TEST-ONLY-TOKEN",
  chatIds: ["-1001234567890"],
  pollIntervalMs: 30000,
  startLookbackLedgers: 60,
  cursorFile: "/tmp/cursor.json",
  maxNotificationsPerCycle: 20,
};

test("RecentEventsStore bounds capacity and evicts older entries", () => {
  const store = new RecentEventsStore(3);
  assert.equal(store.size(), 0);

  store.add(makeFakeClaimEvent(1));
  store.add(makeFakeClaimEvent(2));
  store.add(makeFakeClaimEvent(3));
  assert.equal(store.size(), 3);

  // New event pushes out oldest (claim 1)
  store.add(makeFakeClaimEvent(4));
  assert.equal(store.size(), 3);

  const recent = store.getRecent();
  assert.equal(recent.length, 3);
  assert.equal(getEventId(recent[0]), "4");
  assert.equal(getEventId(recent[1]), "3");
  assert.equal(getEventId(recent[2]), "2");

  assert.equal(store.findById(1), null);
  assert.notEqual(store.findById(4), null);
  assert.equal(getEventId(store.findById(4)), "4");
});

test("RecentEventsStore lookup by text and by id", () => {
  const store = new RecentEventsStore(10);
  store.add(makeFakeClaimEvent(42, "defi governance"));
  store.add(makeFakeSquadEvent(99, "Will Bitcoin reach 100k?"));

  assert.equal(store.findById(42)?.payload?.category, "defi governance");
  assert.equal(store.findById(99)?.payload?.question, "Will Bitcoin reach 100k?");
  assert.equal(store.findById(999), null);

  const bitcoinMatches = store.findByText("bitcoin");
  assert.equal(bitcoinMatches.length, 1);
  assert.equal(getEventId(bitcoinMatches[0]), "99");

  const defiMatches = store.findByText("governance");
  assert.equal(defiMatches.length, 1);
  assert.equal(getEventId(defiMatches[0]), "42");
});

test("sanitizeQuery bounds and sanitizes input", () => {
  assert.equal(sanitizeQuery(null), "");
  assert.equal(sanitizeQuery(undefined), "");
  assert.equal(sanitizeQuery("   42   "), "42");
  const longQuery = "a".repeat(200);
  const bounded = sanitizeQuery(longQuery);
  assert.equal(bounded.length, 128);
  assert.equal(bounded, "a".repeat(128));
});

test("inlineResults handles id queries, text queries, and empty queries", () => {
  const store = new RecentEventsStore(10);
  store.add(makeFakeClaimEvent(1, "tech"));
  store.add(makeFakeClaimEvent(42, "crypto"));
  store.add(makeFakeSquadEvent(100, "Election outcome"));

  // 1. Query by ID (e.g. "42")
  const idResults = inlineResults("42", store, fakeConfig);
  assert.equal(idResults.length, 1);
  assert.match(idResults[0].title, /#42/);
  assert.equal(idResults[0].type, "article");
  assert.match(idResults[0].input_message_content.message_text, /#42/);

  // 2. Query by Text (e.g. "crypto")
  const textResults = inlineResults("crypto", store, fakeConfig);
  assert.equal(textResults.length, 1);
  assert.match(textResults[0].title, /#42/);

  // 3. Query with empty string returns latest events
  const emptyResults = inlineResults("", store, fakeConfig);
  assert.equal(emptyResults.length, 3);
  assert.match(emptyResults[0].title, /#100/);

  // 4. Query with no matches falls back to latest events
  const notFoundResults = inlineResults("nonexistent-topic-xyz", store, fakeConfig);
  assert.equal(notFoundResults.length, 3);
});

test("handleInlineQuery answers inline query with articles and short cache time", async () => {
  const store = new RecentEventsStore(10);
  store.add(makeFakeClaimEvent(42, "crypto"));

  let answeredResults = null;
  let answeredOptions = null;

  const fakeCtx = {
    inlineQuery: {
      id: "iq-12345",
      query: "42",
      from: { id: 111, is_bot: false, first_name: "Alice" },
      offset: "",
    },
    answerInlineQuery: async (results, options) => {
      answeredResults = results;
      answeredOptions = options;
    },
  };

  await handleInlineQuery(fakeCtx, store, fakeConfig);

  assert.ok(answeredResults);
  assert.equal(answeredResults.length, 1);
  assert.equal(answeredResults[0].type, "article");
  assert.match(answeredResults[0].title, /42/);
  assert.ok(answeredOptions);
  assert.equal(answeredOptions.cache_time, 10);
  assert.equal(answeredOptions.is_personal, false);
});

test("handleInlineQuery with empty query returns latest items", async () => {
  const store = new RecentEventsStore(10);
  store.add(makeFakeClaimEvent(1, "tech"));
  store.add(makeFakeClaimEvent(2, "sports"));

  let answeredResults = null;
  const fakeCtx = {
    inlineQuery: {
      id: "iq-99999",
      query: "",
      from: { id: 222, is_bot: false, first_name: "Bob" },
      offset: "",
    },
    answerInlineQuery: async (results) => {
      answeredResults = results;
    },
  };

  await handleInlineQuery(fakeCtx, store, fakeConfig);
  assert.ok(answeredResults);
  assert.equal(answeredResults.length, 2);
});

test("registerInlineQueryHandler attaches inline_query event listener", async () => {
  const eventsRegistered = {};
  const fakeBot = {
    on: (eventName, handler) => {
      eventsRegistered[eventName] = handler;
    },
  };

  const store = new RecentEventsStore(5);
  store.add(makeFakeClaimEvent(77));

  registerInlineQueryHandler(fakeBot, {
    config: fakeConfig,
    recentEvents: store,
  });

  assert.ok(typeof eventsRegistered.inline_query === "function");

  let answeredResults = null;
  const fakeCtx = {
    inlineQuery: { query: "77" },
    answerInlineQuery: async (results) => {
      answeredResults = results;
    },
  };

  await eventsRegistered.inline_query(fakeCtx);
  assert.ok(answeredResults);
  assert.equal(answeredResults.length, 1);
  assert.match(answeredResults[0].title, /77/);
});
