/**
 * Tests for graceful handling of deleted Telegram confirmation messages (#854).
 *
 * Verifies:
 *   - Deleted or uneditable `/pause` confirmation messages (`pause-confirm`,
 *     `pause-cancel`, and expired prompts) acknowledge the callback, emit a
 *     bounded fallback reply, never throw, and never repeat `pause()` on
 *     duplicate taps.
 *   - Deleted or uneditable `/broadcast` confirmation messages (`confirm`,
 *     `cancel`, `expired`, and `already processed`) acknowledge the callback,
 *     emit a single bounded fallback reply (`<= MAX_CONFIRMATION_FALLBACK_CHARS`),
 *     and deliver the broadcast to target chats at most once.
 *   - `isDeletedOrUneditableMessageError` and `clampConfirmationFallbackText`
 *     handle boundary cases cleanly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastStore,
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  MAX_CONFIRMATION_FALLBACK_CHARS,
  PAUSE_CONFIRM_TTL_MS,
  clampConfirmationFallbackText,
  createBot,
  handleBroadcastCallback,
  handlePauseConfirmCallback,
  isDeletedOrUneditableMessageError,
} from "../dist/bot.js";

const FAKE_CRED = ["123456789:", "A".repeat(35)].join("");
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Mimir",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function makeConfig(overrides = {}) {
  return {
    botToken: FAKE_CRED,
    chatId: "-1001111111111",
    chatIds: ["-1001111111111", "-1002222222222"],
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

function deletedMessageError(detail = "Bad Request: message to edit not found") {
  return Object.assign(new Error(`Call to 'editMessageText' failed! (400: ${detail})`), {
    error_code: 400,
    description: detail,
  });
}

test("isDeletedOrUneditableMessageError and clampConfirmationFallbackText handle boundaries", () => {
  assert.equal(
    isDeletedOrUneditableMessageError(deletedMessageError("Bad Request: message to edit not found")),
    true,
  );
  assert.equal(
    isDeletedOrUneditableMessageError(deletedMessageError("Bad Request: message can't be edited")),
    true,
  );
  assert.equal(
    isDeletedOrUneditableMessageError({ error_code: 400, description: "400: MESSAGE_ID_INVALID" }),
    true,
  );
  assert.equal(
    isDeletedOrUneditableMessageError(
      new Error("Bad Request: message is not modified: specified new message content is identical"),
    ),
    false,
  );
  assert.equal(isDeletedOrUneditableMessageError(null), false);

  const exact = "a".repeat(MAX_CONFIRMATION_FALLBACK_CHARS);
  assert.equal(clampConfirmationFallbackText(exact), exact);

  const oversized = "b".repeat(MAX_CONFIRMATION_FALLBACK_CHARS + 500);
  const clamped = clampConfirmationFallbackText(oversized);
  assert.equal(clamped.length, MAX_CONFIRMATION_FALLBACK_CHARS);
  assert.ok(clamped.endsWith("…"));
});

test("deleted /pause confirmation message acknowledges callback, emits bounded fallback reply, and never repeats pause()", async () => {
  const config = makeConfig();
  let pauseCalls = 0;
  const pause = () => {
    pauseCalls += 1;
    return "paused";
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const answered = [];
  const fallbackReplies = [];

  const makeDeletedPauseCtx = (queryId) => ({
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 10 },
    callbackQuery: {
      id: queryId,
      data: CALLBACK_PAUSE_CONFIRM,
      message: {
        message_id: 777,
        date: nowSec,
        chat: { id: 42, type: "private" },
      },
    },
    answerCallbackQuery: async (opts = {}) => {
      answered.push(opts);
    },
    editMessageText: async () => {
      throw deletedMessageError();
    },
    reply: async (text, opts) => {
      fallbackReplies.push({ text, opts });
    },
  });

  // 1st tap when confirmation message was deleted in Telegram
  await assert.doesNotReject(
    handlePauseConfirmCallback(makeDeletedPauseCtx("cq_pause_1"), { config, pause }, nowSec * 1000 + 200),
  );

  assert.equal(pauseCalls, 1, "pause() runs exactly once");
  assert.equal(answered.length, 1, "callback query is acknowledged");
  assert.equal(fallbackReplies.length, 1, "bounded fallback reply is emitted");
  assert.ok(fallbackReplies[0].text.length <= MAX_CONFIRMATION_FALLBACK_CHARS);
  assert.match(fallbackReplies[0].text, /\*Polling paused\*/);

  // 2nd duplicate tap on the same deleted confirmation message must NOT repeat pause()
  await assert.doesNotReject(
    handlePauseConfirmCallback(makeDeletedPauseCtx("cq_pause_2"), { config, pause }, nowSec * 1000 + 400),
  );

  assert.equal(pauseCalls, 1, "duplicate tap must not repeat pause() state transition");
  assert.equal(answered.length, 2, "duplicate callback is still acknowledged");
  assert.equal(answered[1].show_alert, true);
  assert.match(answered[1].text, /already processed/i);
  assert.equal(fallbackReplies.length, 2);
  assert.ok(fallbackReplies[1].text.length <= MAX_CONFIRMATION_FALLBACK_CHARS);
  assert.match(fallbackReplies[1].text, /already processed/i);
});

test("deleted /pause cancel and expired confirmation messages emit bounded fallback replies without mutating state", async () => {
  const config = makeConfig();
  let pauseCalls = 0;
  const pause = () => {
    pauseCalls += 1;
    return "paused";
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const answered = [];
  const apiSent = [];

  // Context without ctx.reply (falls back to ctx.api.sendMessage)
  const cancelCtx = {
    from: { id: 42 },
    update: { update_id: 20 },
    callbackQuery: {
      id: "cq_cancel_del",
      data: CALLBACK_PAUSE_CANCEL,
      message: {
        message_id: 778,
        date: nowSec,
        chat: { id: 42, type: "private" },
      },
    },
    api: {
      sendMessage: async (chatId, text, opts) => {
        apiSent.push({ chatId, text, opts });
        return { message_id: 1 };
      },
    },
    answerCallbackQuery: async (opts = {}) => answered.push(opts),
    editMessageText: async () => {
      throw deletedMessageError("Bad Request: message can't be edited");
    },
  };

  await assert.doesNotReject(
    handlePauseConfirmCallback(cancelCtx, { config, pause }, nowSec * 1000 + 100),
  );
  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].text, "Cancelled.");
  assert.equal(apiSent.length, 1);
  assert.equal(apiSent[0].chatId, 42);
  assert.match(apiSent[0].text, /Pause cancelled/);

  // Expired prompt whose message was deleted
  const expiredCtx = {
    ...cancelCtx,
    callbackQuery: {
      id: "cq_expired_del",
      data: CALLBACK_PAUSE_CONFIRM,
      message: {
        message_id: 779,
        date: nowSec - 300,
        chat: { id: 42, type: "private" },
      },
    },
  };

  await assert.doesNotReject(
    handlePauseConfirmCallback(
      expiredCtx,
      { config, pause },
      (nowSec - 300) * 1000 + PAUSE_CONFIRM_TTL_MS + 5_000,
    ),
  );
  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 2);
  assert.match(answered[1].text, /expired/i);
  assert.equal(apiSent.length, 2);
  assert.match(apiSent[1].text, /expired/i);
});

test("deleted /broadcast preview message acknowledges callback, emits one bounded fallback reply, and sends broadcast at most once", async () => {
  // Configure many target chats so the raw per-chat report exceeds MAX_CONFIRMATION_FALLBACK_CHARS
  const manyChats = Array.from({ length: 80 }, (_, idx) => `-1009000000${String(idx).padStart(3, "0")}`);
  const config = makeConfig({ chatIds: manyChats, interSendDelayMs: 0 });
  const store = new BroadcastStore();
  const pending = store.create("42", "Important maintenance notice", manyChats);

  const deliveredToTargets = [];
  const operatorFallbackReplies = [];
  const answered = [];

  const makeDeletedBroadcastCtx = (cbId) => ({
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 30 },
    api: {
      sendMessage: async (chatId, text, options) => {
        if (String(chatId) === "42") {
          operatorFallbackReplies.push({ text, options });
        } else {
          deliveredToTargets.push({ chatId: String(chatId), text, options });
        }
        return { message_id: 1 };
      },
    },
    callbackQuery: {
      id: cbId,
      data: `broadcast:confirm:${pending.id}`,
      message: {
        message_id: 880,
        chat: { id: 42, type: "private" },
      },
    },
    editMessageText: async () => {
      throw deletedMessageError();
    },
    answerCallbackQuery: async (opts) => {
      answered.push(opts);
      return true;
    },
  });

  // 1st tap: preview message was deleted before confirmation
  await handleBroadcastCallback(
    makeDeletedBroadcastCtx("cb_bcast_del_1"),
    {
      config,
      broadcastStore: store,
      sleep: async () => {},
      status: () => ({}),
      pause: () => "paused",
      resume: () => "resumed",
    },
    `broadcast:confirm:${pending.id}`,
  );

  // Delivered once to each target chat
  assert.equal(deliveredToTargets.length, manyChats.length);
  // Callback acknowledged + exactly ONE bounded fallback reply emitted to operator
  assert.equal(answered.length, 1);
  assert.equal(answered[0].text, "Broadcasting message...");
  assert.equal(operatorFallbackReplies.length, 1);
  assert.equal(
    operatorFallbackReplies[0].text.length,
    MAX_CONFIRMATION_FALLBACK_CHARS,
    "oversized broadcast report must be bounded to MAX_CONFIRMATION_FALLBACK_CHARS",
  );
  assert.ok(operatorFallbackReplies[0].text.startsWith("📢 Broadcast Results: 80/80 succeeded"));
  assert.ok(operatorFallbackReplies[0].text.endsWith("…"));

  // 2nd tap on the same deleted preview message: NO duplicate broadcast delivery!
  await handleBroadcastCallback(
    makeDeletedBroadcastCtx("cb_bcast_del_2"),
    {
      config,
      broadcastStore: store,
      sleep: async () => {},
      status: () => ({}),
      pause: () => "paused",
      resume: () => "resumed",
    },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(
    deliveredToTargets.length,
    manyChats.length,
    "duplicate tap after message deletion must NOT resend broadcast",
  );
  assert.equal(answered.length, 2);
  assert.match(answered[1].text, /expired or already processed/i);
  assert.equal(operatorFallbackReplies.length, 2);
  assert.match(operatorFallbackReplies[1].text, /expired or already processed/i);
});

test("deleted /broadcast cancel and expired preview messages emit bounded fallback replies via bot.handleUpdate", async () => {
  const config = makeConfig();
  const store = new BroadcastStore();
  const cancelItem = store.create("42", "Cancel me", ["-1001111111111"]);
  const expiredItem = store.create("42", "Expired me", ["-1001111111111"], -1_000);

  const apiCalls = [];
  const bot = createBot({
    config,
    botInfo: BOT_INFO,
    broadcastStore: store,
    status: () => ({
      running: true,
      paused: false,
      startedAt: 1,
      cycles: 1,
      lastPollAt: 1,
      lastSuccessAt: 1,
      latestLedger: 1,
      oldestLedger: 1,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
      consecutiveFailures: 0,
      lastError: null,
      targets: [],
    }),
    pause: () => "paused",
    resume: () => "resumed",
  });

  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "editMessageText") {
      throw deletedMessageError();
    }
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: apiCalls.length } };
    }
    return { ok: true, result: true };
  });

  // Cancel on deleted message
  await bot.handleUpdate({
    update_id: 401,
    callback_query: {
      id: "cb_401",
      from: { id: 42, is_bot: false, first_name: "Op" },
      message: {
        message_id: 901,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" },
        text: "preview",
      },
      data: `broadcast:cancel:${cancelItem.id}`,
    },
  });

  // Expired confirm on deleted message
  await bot.handleUpdate({
    update_id: 402,
    callback_query: {
      id: "cb_402",
      from: { id: 42, is_bot: false, first_name: "Op" },
      message: {
        message_id: 902,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" },
        text: "preview",
      },
      data: `broadcast:confirm:${expiredItem.id}`,
    },
  });

  const sentToOperator = apiCalls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === 42);
  const sentToChannels = apiCalls.filter((c) => c.method === "sendMessage" && c.payload.chat_id !== 42);
  const answers = apiCalls.filter((c) => c.method === "answerCallbackQuery");

  assert.equal(sentToChannels.length, 0, "neither cancel nor expired broadcast sends to channels");
  assert.equal(answers.length, 2, "both callbacks are acknowledged");
  assert.equal(sentToOperator.length, 2, "both deleted messages emit fallback replies to operator");
  assert.match(sentToOperator[0].payload.text, /Broadcast cancelled/);
  assert.match(sentToOperator[1].payload.text, /expired/i);
});
