/**
 * Focused tests for `/events` command, canonical event summaries, bounded
 * in-memory retention, and safe pagination without filesystem reads.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMANDS,
  RecentEventStore,
  eventsMessage,
  handleCallbackQuery,
  helpDetailMessage,
  registerCommandHandlers,
  toCanonicalEventSummary,
  validateCallbackData,
} from "../dist/bot.js";
import {
  EVENTS_PAGE_SIZE,
  EVENTS_USAGE_MESSAGE,
  MAX_EVENT_SUMMARY_CHARS,
  commandModule,
  parseEventsPageArg,
} from "../dist/commands/index.js";

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    channelPreviewMode: false,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    stopping: false,
    startedAt: 1,
    cycles: 1,
    lastPollAt: 1000,
    lastSuccessAt: 1000,
    latestLedger: 5000,
    oldestLedger: 4000,
    notificationsSent: 0,
    notificationsFailed: 0,
    notificationsDropped: 0,
    eventsSkipped: 0,
    eventsDeduplicated: 0,
    pagesScanned: 1,
    emptyPages: 0,
    lastCyclePages: 1,
    lastCycleEmptyPages: 0,
    consecutiveFailures: 0,
    lastError: null,
    chainClockAt: null,
    cursorRewinds: 0,
    restartGaps: 0,
    lastRestartGap: null,
    targets: [],
    ...overrides,
  };
}

function makeMarketEvent(ledger, claimId, overrides = {}) {
  return {
    source: "market",
    contractId: "C" + "A".repeat(55),
    version: "v1",
    ledger,
    txHash: `tx_${ledger}_${claimId}`,
    at: 1_700_000_000 + ledger,
    eventId: `${String(ledger).padStart(7, "0")}-0000000001`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId,
      creator: "G" + "C".repeat(55),
      category: "crypto",
    },
    ...overrides,
  };
}

function makeSquadEvent(ledger, marketId) {
  return {
    source: "squad",
    contractId: "C" + "B".repeat(55),
    version: "v1",
    ledger,
    txHash: `tx_squad_${ledger}_${marketId}`,
    at: 1_700_000_000 + ledger,
    eventId: `${String(ledger).padStart(7, "0")}-0000000002`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "deposited",
      marketId,
      side: 1,
      participant: "G" + "D".repeat(55),
      amount: 25_000_000n,
      shares: 25_000_000n,
    },
  };
}

function recorder() {
  const handlers = new Map();
  return {
    handlers,
    bot: {
      command: (name, handler) => handlers.set(name, handler),
      callbackQuery: () => {},
    },
  };
}

function commandCtx({ text = "/events", chatId = -1001234567890, userId = 100 } = {}) {
  const replies = [];
  return {
    replies,
    ctx: {
      from: { id: userId },
      chat: { id: chatId },
      message: { text },
      update: { update_id: 1 },
      reply: async (...args) => replies.push(args),
    },
  };
}

test("events command is registered in the command catalogue and allowlist-gated", () => {
  const mod = commandModule("events");
  assert.ok(mod);
  assert.equal(mod.command, "events");
  assert.equal(mod.chatAllowlist, true);
  assert.notEqual(mod.operatorOnly, true);
  assert.ok(COMMANDS.some((c) => c.command === "events"));
  assert.match(helpDetailMessage("events"), /\/events \\\[page\\\]/);
});

test("toCanonicalEventSummary sanitizes control chars and bounds summary length", () => {
  const noisyCategory = "tech\x00\x1b\n\u202e" + "x".repeat(300);
  const ev = makeMarketEvent(1234, 9, {
    payload: {
      name: "claim_created",
      claimId: 9,
      creator: "G" + "C".repeat(55),
      category: noisyCategory,
    },
  });
  const summary = toCanonicalEventSummary(ev);
  assert.equal(summary.source, "market");
  assert.equal(summary.ledger, 1234);
  assert.equal(summary.eventName, "claim_created");
  assert.ok(summary.summary.length <= MAX_EVENT_SUMMARY_CHARS);
  assert.equal(/[\x00-\x1f\x7f\u202e]/.test(summary.summary), false);
});

test("RecentEventStore deduplicates by canonical id, caps capacity, and orders newest-first", () => {
  const store = new RecentEventStore(3);
  store.record([
    makeMarketEvent(100, 1),
    makeMarketEvent(102, 2),
    makeMarketEvent(100, 1), // duplicate canonical eventId
    makeSquadEvent(101, 5),
    makeMarketEvent(105, 3), // evicts oldest (102 or 100)
  ]);

  const list = store.list();
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((e) => e.ledger),
    [105, 101, 100],
  );
});

test("parseEventsPageArg accepts valid positive pages and rejects path-like or invalid args", () => {
  assert.deepEqual(parseEventsPageArg(undefined), { ok: true, page: 1 });
  assert.deepEqual(parseEventsPageArg("/events"), { ok: true, page: 1 });
  assert.deepEqual(parseEventsPageArg("/events@mimir_bot"), { ok: true, page: 1 });
  assert.deepEqual(parseEventsPageArg("/events 2"), { ok: true, page: 2 });
  assert.deepEqual(parseEventsPageArg("3"), { ok: true, page: 3 });

  for (const bad of [
    "/events 0",
    "/events -1",
    "/events ../../etc/passwd",
    "/events /etc/shadow",
    "/events ./data/events.jsonl",
    "/events abc",
    "/events 1.5",
    "/events 99999",
  ]) {
    assert.deepEqual(parseEventsPageArg(bad), { ok: false, reason: "invalid-page" }, bad);
  }
});

test("/events handles empty state, multi-page pagination, clamping, and invalid args", async () => {
  const store = new RecentEventStore(20);
  const rec = recorder();
  registerCommandHandlers(rec.bot, {
    config: baseConfig(),
    status: () => baseStatus(),
    recentEvents: () => store.list(),
    pause: () => "paused",
    resume: () => "resumed",
  });

  const handler = rec.handlers.get("events");
  assert.ok(handler);

  // 1. Empty state
  const emptyCall = commandCtx({ text: "/events" });
  await handler(emptyCall.ctx);
  assert.match(emptyCall.replies[0][0], /No recent events have been observed/);

  // 2. Populate 7 events -> 2 pages (5 + 2)
  for (let i = 1; i <= 7; i++) {
    store.record([makeMarketEvent(1000 + i, i)]);
  }

  const page1Call = commandCtx({ text: "/events" });
  await handler(page1Call.ctx);
  assert.match(page1Call.replies[0][0], /page 1\/2, 7 retained/);
  assert.ok(page1Call.replies[0][1].reply_markup);
  const p1Buttons = page1Call.replies[0][1].reply_markup.inline_keyboard.flat();
  assert.equal(p1Buttons.length, 1);
  assert.equal(p1Buttons[0].callback_data, "pg:v1:events:1");

  const page2Call = commandCtx({ text: "/events 2" });
  await handler(page2Call.ctx);
  assert.match(page2Call.replies[0][0], /page 2\/2, 7 retained/);
  const p2Buttons = page2Call.replies[0][1].reply_markup.inline_keyboard.flat();
  assert.equal(p2Buttons[0].callback_data, "pg:v1:events:0");

  // 3. Out-of-range page clamps safely to last page
  const clampCall = commandCtx({ text: "/events 999" });
  await handler(clampCall.ctx);
  assert.match(clampCall.replies[0][0], /page 2\/2, 7 retained/);

  // 4. Path-traversal / non-numeric argument returns usage without filesystem access
  const badCall = commandCtx({ text: "/events ../../etc/passwd" });
  await handler(badCall.ctx);
  assert.equal(badCall.replies[0][0], EVENTS_USAGE_MESSAGE);
  assert.equal(badCall.replies[0][1].reply_markup, undefined);
});

test("/events enforces ALLOWED_CHAT_IDS on command and pagination callback", async () => {
  const store = new RecentEventStore(20);
  for (let i = 1; i <= EVENTS_PAGE_SIZE + 1; i++) {
    store.record([makeMarketEvent(2000 + i, i)]);
  }

  const config = baseConfig({ allowedChatIds: ["-100999"] });
  const deps = {
    config,
    status: () => baseStatus(),
    recentEvents: () => store.list(),
    pause: () => "paused",
    resume: () => "resumed",
  };

  const rec = recorder();
  registerCommandHandlers(rec.bot, deps);
  const handler = rec.handlers.get("events");

  const denied = commandCtx({ text: "/events", chatId: -100111 });
  await handler(denied.ctx);
  assert.equal(denied.replies.length, 0);

  const allowed = commandCtx({ text: "/events", chatId: -100999 });
  await handler(allowed.ctx);
  assert.equal(allowed.replies.length, 1);
  assert.match(allowed.replies[0][0], /page 1\/2/);

  // Callback validation + allowlist enforcement
  assert.deepEqual(validateCallbackData("pg:v1:events:1").ok, true);
  assert.equal(validateCallbackData("pg:v1:unknown:0").ok, false);

  const edits = [];
  const answers = [];
  await handleCallbackQuery(
    {
      chat: { id: -100999 },
      from: { id: 100 },
      update: { update_id: 2 },
      callbackQuery: {
        id: "cb1",
        data: "pg:v1:events:1",
        message: { message_id: 10 },
      },
      editMessageText: async (...args) => edits.push(args),
      answerCallbackQuery: async (...args) => answers.push(args),
    },
    deps,
  );
  assert.equal(edits.length, 1);
  assert.match(edits[0][0], /page 2\/2/);
  assert.match(eventsMessage(config, store.list(), 1), /page 2\/2/);
});
