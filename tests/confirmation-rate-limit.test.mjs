/**
 * Tests for independent confirmation action rate limiting (#855).
 *
 * Verifies:
 *   - Bounded per-actor ConfirmationRateLimiter (capacity, refill, retryAfterMs,
 *     idle eviction, and hard maxActors LRU bound)
 *   - Read-only navigation callbacks (`status`, `contracts`, `help`) never
 *     consume confirmation budget and remain unblocked while confirmation
 *     actions (`pause`, `resume`, `pause-confirm`, `pause-cancel`, `broadcast`)
 *     are throttled
 *   - Throttled confirmation callbacks preserve underlying state and pending
 *     broadcast confirmations so they can be completed once budget refills
 *   - Unauthorized non-operator callback attempts never drain the operator's
 *     confirmation action budget
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastStore,
  CALLBACK_CONFIRMATION_RATE_LIMITED_FEEDBACK,
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  CALLBACK_UNAUTHORIZED_FEEDBACK,
  ConfirmationRateLimiter,
  DEFAULT_CONFIRMATION_CAPACITY,
  DEFAULT_CONFIRMATION_IDLE_TTL_MS,
  DEFAULT_CONFIRMATION_MAX_ACTORS,
  DEFAULT_CONFIRMATION_REFILL_MS,
  createBot,
  isReadOnlyCallbackAction,
} from "../dist/bot.js";

const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);
const FAKE_CRED = ["123456789:", "A".repeat(35)].join("");

function createFakeClock(initialMs = 1_000_000) {
  let current = initialMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

function makeConfig(overrides = {}) {
  return {
    botToken: FAKE_CRED,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890", "-1002222222222"],
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    interSendDelayMs: 0,
    ...overrides,
  };
}

function makeStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 5,
    lastPollAt: 1_500,
    lastSuccessAt: 1_500,
    latestLedger: 200_000,
    oldestLedger: 190_000,
    notificationsSent: 4,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: MARKET_ID,
        cursor: "100-1",
        lastEventLedger: 199_999,
        lastError: null,
      },
      {
        source: "squad",
        contractId: SQUAD_ID,
        cursor: "100-2",
        lastEventLedger: 199_998,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Mimir",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function buildHarness({ capacity = 2, refillMs = 10_000 } = {}) {
  const clock = createFakeClock(1_700_000_000_000);
  const confirmationRateLimiter = new ConfirmationRateLimiter({
    capacity,
    refillMs,
    now: clock.now,
  });
  const broadcastStore = new BroadcastStore();
  const config = makeConfig();

  let pauseCalls = 0;
  let resumeCalls = 0;
  const apiCalls = [];

  const bot = createBot({
    config,
    botInfo: BOT_INFO,
    status: () => makeStatus(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => {
      resumeCalls += 1;
      return "resumed";
    },
    broadcastStore,
    confirmationRateLimiter,
    now: clock.now,
  });

  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: apiCalls.length } };
    }
    return { ok: true, result: true };
  });

  let nextUpdateId = 1;
  function makeCallbackUpdate(data, { userId = 42, chatType = "private" } = {}) {
    const id = nextUpdateId++;
    return {
      update_id: id,
      callback_query: {
        id: `cb_${id}`,
        from: { id: userId, is_bot: false, first_name: "Tester" },
        message: {
          message_id: 500 + id,
          date: Math.floor(clock.now() / 1000),
          chat: { id: chatType === "private" ? userId : -1001234567890, type: chatType },
          text: "prompt",
        },
        data,
      },
    };
  }

  return {
    bot,
    clock,
    config,
    broadcastStore,
    confirmationRateLimiter,
    apiCalls,
    getPauseCalls: () => pauseCalls,
    getResumeCalls: () => resumeCalls,
    makeCallbackUpdate,
  };
}

async function silenceConsoleWarnings(fn) {
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
  }
}

test("ConfirmationRateLimiter enforces per-actor token budgets, refills, and strictly bounds actor state", () => {
  const clock = createFakeClock(50_000);
  const limiter = new ConfirmationRateLimiter({
    capacity: 2,
    refillMs: 5_000,
    idleTtlMs: 30_000,
    maxActors: 3,
    now: clock.now,
  });

  assert.equal(DEFAULT_CONFIRMATION_CAPACITY, 5);
  assert.equal(DEFAULT_CONFIRMATION_REFILL_MS, 10_000);
  assert.equal(DEFAULT_CONFIRMATION_IDLE_TTL_MS, 300_000);
  assert.equal(DEFAULT_CONFIRMATION_MAX_ACTORS, 1_000);

  // Per-actor budget & retryAfterMs
  assert.equal(limiter.consume("actor-1"), true);
  assert.equal(limiter.consume("actor-1"), true);
  assert.equal(limiter.consume("actor-1"), false);
  assert.equal(limiter.retryAfterMs("actor-1"), 5_000);

  // actor-2 is independent of actor-1
  assert.equal(limiter.consume("actor-2"), true);

  // Partial advance does not yet grant a full token
  clock.advance(2_500);
  assert.equal(limiter.consume("actor-1"), false);
  assert.equal(limiter.retryAfterMs("actor-1"), 2_500);

  // Full refill interval grants 1 token
  clock.advance(2_500);
  assert.equal(limiter.retryAfterMs("actor-1"), 0);
  assert.equal(limiter.consume("actor-1"), true);
  assert.equal(limiter.consume("actor-1"), false);

  // Hard maxActors LRU bound prevents unbounded growth across distinct actors
  for (let i = 0; i < 50; i += 1) {
    limiter.consume(`synthetic-actor-${i}`);
  }
  assert.equal(limiter.size(), 3, "actor table must never exceed maxActors");

  // Idle eviction clears inactive actors after idleTtlMs
  clock.advance(30_000);
  assert.equal(limiter.evictIdle(), 3);
  assert.equal(limiter.size(), 0);
});

test("isReadOnlyCallbackAction separates navigation from state-changing actions", () => {
  assert.equal(isReadOnlyCallbackAction("status"), true);
  assert.equal(isReadOnlyCallbackAction("contracts"), true);
  assert.equal(isReadOnlyCallbackAction("help"), true);

  assert.equal(isReadOnlyCallbackAction("pause"), false);
  assert.equal(isReadOnlyCallbackAction("resume"), false);
  assert.equal(isReadOnlyCallbackAction("broadcast"), false);
});

test("throttled confirmation actions never block status, contracts, or help navigation", async () => {
  const {
    bot,
    clock,
    broadcastStore,
    apiCalls,
    getPauseCalls,
    getResumeCalls,
    makeCallbackUpdate,
  } = buildHarness({ capacity: 2, refillMs: 10_000 });

  // 1. Heavy read-only navigation BEFORE confirmations consumes zero confirmation budget
  for (const nav of [
    "status",
    "contracts",
    "help",
    "status:refresh",
    "mimir:status",
    JSON.stringify({ action: "status" }),
  ]) {
    await bot.handleUpdate(makeCallbackUpdate(nav));
  }
  assert.equal(getPauseCalls(), 0);

  // 2. Consume both confirmation tokens with operator pause + resume
  await bot.handleUpdate(makeCallbackUpdate("pause"));
  await bot.handleUpdate(makeCallbackUpdate("resume"));
  assert.equal(getPauseCalls(), 1);
  assert.equal(getResumeCalls(), 1);

  // 3. Exhausted budget throttles inline `pause`, `/pause` confirm/cancel, and `/broadcast` confirm/cancel
  const pendingBroadcast = broadcastStore.create("42", "Scheduled upgrade", [
    "-1001234567890",
    "-1002222222222",
  ]);
  apiCalls.length = 0;

  await silenceConsoleWarnings(async () => {
    await bot.handleUpdate(makeCallbackUpdate("pause"));
    await bot.handleUpdate(makeCallbackUpdate(CALLBACK_PAUSE_CONFIRM));
    await bot.handleUpdate(makeCallbackUpdate(CALLBACK_PAUSE_CANCEL));
    await bot.handleUpdate(makeCallbackUpdate(`broadcast:confirm:${pendingBroadcast.id}`));
    await bot.handleUpdate(makeCallbackUpdate(`broadcast:cancel:${pendingBroadcast.id}`));
  });

  // Underlying state transitions must NOT run while throttled
  assert.equal(getPauseCalls(), 1, "pause() must not be called while throttled");
  assert.ok(
    broadcastStore.get(pendingBroadcast.id),
    "pending broadcast must stay intact when confirmation tap is throttled",
  );
  assert.equal(
    apiCalls.filter((c) => c.method === "sendMessage").length,
    0,
    "no broadcast messages may be sent while throttled",
  );

  const throttledAnswers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
  assert.equal(throttledAnswers.length, 5);
  for (const ans of throttledAnswers) {
    assert.equal(ans.payload.text, CALLBACK_CONFIRMATION_RATE_LIMITED_FEEDBACK);
    assert.equal(ans.payload.show_alert, true);
  }

  // 4. Read-only navigation (`status`, `contracts`, `help`) continues working while throttled!
  apiCalls.length = 0;
  await bot.handleUpdate(makeCallbackUpdate("status"));
  await bot.handleUpdate(makeCallbackUpdate("contracts"));
  await bot.handleUpdate(makeCallbackUpdate("help"));

  const navEdits = apiCalls.filter((c) => c.method === "editMessageText");
  const navAnswers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
  assert.equal(navEdits.length, 3, "all 3 navigation views must render while throttled");
  assert.deepEqual(
    navAnswers.map((c) => c.payload.text),
    ["Status refreshed", "Contracts", "Help"],
  );

  // 5. After refill interval, pending broadcast confirmation succeeds cleanly
  apiCalls.length = 0;
  clock.advance(10_000);
  await bot.handleUpdate(makeCallbackUpdate(`broadcast:confirm:${pendingBroadcast.id}`));

  const broadcastSends = apiCalls.filter((c) => c.method === "sendMessage");
  assert.equal(broadcastSends.length, 2, "broadcast delivers to both target chats after refill");
  assert.equal(broadcastStore.get(pendingBroadcast.id), undefined);
});

test("unauthorized callback spam does not drain the operator's confirmation action budget", async () => {
  const {
    bot,
    confirmationRateLimiter,
    apiCalls,
    getPauseCalls,
    makeCallbackUpdate,
  } = buildHarness({ capacity: 1, refillMs: 60_000 });

  // Non-operator spams pause, pause-confirm, and broadcast callbacks
  await silenceConsoleWarnings(async () => {
    for (let i = 0; i < 10; i += 1) {
      await bot.handleUpdate(makeCallbackUpdate("pause", { userId: 999 }));
      await bot.handleUpdate(makeCallbackUpdate(CALLBACK_PAUSE_CONFIRM, { userId: 999 }));
      await bot.handleUpdate(makeCallbackUpdate("broadcast:confirm:fake_id", { userId: 999 }));
    }
  });

  assert.equal(getPauseCalls(), 0);
  assert.equal(
    confirmationRateLimiter.getTokens("42"),
    1,
    "operator budget must remain untouched after non-operator spam",
  );
  assert.ok(
    apiCalls.some(
      (c) =>
        c.method === "answerCallbackQuery" &&
        c.payload.text === CALLBACK_UNAUTHORIZED_FEEDBACK,
    ),
  );

  // Operator's single allowed action still succeeds immediately
  await bot.handleUpdate(makeCallbackUpdate(CALLBACK_PAUSE_CONFIRM, { userId: 42 }));
  assert.equal(getPauseCalls(), 1);
});
