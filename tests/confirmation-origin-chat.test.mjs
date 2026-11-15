import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastStore,
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  CALLBACK_WRONG_CHAT_FEEDBACK,
  PauseConfirmStore,
  createBot,
  handleBroadcastCallback,
  handleBroadcastCommand,
  handlePauseConfirmCallback,
  resolveCallbackOriginChatId,
} from "../dist/bot.js";

const BOT_CREDENTIAL = ["123456789:", "A".repeat(35)].join("");
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
    botToken: BOT_CREDENTIAL,
    chatId: "-100111",
    chatIds: ["-100111", "-100222"],
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    allowedChatIds: [],
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

function makeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    eventsDeduplicated: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

async function silenceWarnings(fn) {
  const prevWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = prevWarn;
  }
}

test("resolveCallbackOriginChatId validates matching, missing, and conflicting chat IDs", () => {
  assert.deepEqual(
    resolveCallbackOriginChatId({
      chat: { id: 42 },
      callbackQuery: { message: { chat: { id: 42 } } },
    }),
    { ok: true, chatId: "42" },
  );

  assert.deepEqual(
    resolveCallbackOriginChatId({
      chat: undefined,
      callbackQuery: { message: {} },
    }),
    { ok: false, reason: "missing-chat" },
  );

  assert.deepEqual(
    resolveCallbackOriginChatId({
      chat: { id: 42 },
      callbackQuery: { message: { chat: { id: -100999 } } },
    }),
    { ok: false, reason: "mismatched-chat" },
  );
});

test("broadcast confirm/cancel from a different chat is rejected and keeps pending broadcast unchanged", async () => {
  const config = makeConfig();
  const store = new BroadcastStore();
  const previewReplies = [];

  await handleBroadcastCommand(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 1 },
      message: { text: "/broadcast Planned ledger maintenance window" },
      reply: async (...args) => previewReplies.push(args),
    },
    { config, broadcastStore: store },
  );

  assert.equal(previewReplies.length, 1);
  assert.equal(store.size(), 1);
  const buttons = previewReplies[0][1].reply_markup.inline_keyboard[0];
  const confirmData = buttons[0].callback_data;
  const cancelData = buttons[1].callback_data;
  const pendingId = confirmData.split(":")[2];

  const sentMessages = [];
  const edits = [];
  const alerts = [];
  const api = {
    sendMessage: async (chatId, text, options) => {
      sentMessages.push({ chatId: String(chatId), text, options });
      return { message_id: sentMessages.length };
    },
  };

  // 1. Cross-chat confirm attempt from another private/business chat ID (e.g. 777 !== 42)
  await silenceWarnings(() =>
    handleBroadcastCallback(
      {
        from: { id: 42 },
        chat: { id: 777, type: "private" },
        update: { update_id: 2 },
        api,
        callbackQuery: {
          id: "cb_wrong_private",
          data: confirmData,
          message: { message_id: 10, chat: { id: 777, type: "private" } },
        },
        editMessageText: async (text) => edits.push(text),
        answerCallbackQuery: async (opts) => alerts.push(opts),
      },
      { config, broadcastStore: store, sleep: async () => {} },
      confirmData,
    ),
  );

  assert.equal(sentMessages.length, 0, "cross-chat confirm must not send broadcast");
  assert.equal(edits.length, 0, "cross-chat confirm must not edit preview");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].text, CALLBACK_WRONG_CHAT_FEEDBACK);
  assert.equal(alerts[0].show_alert, true);

  // Pending state remains intact and unconfirmed
  const afterWrongConfirm = store.get(pendingId);
  assert.ok(afterWrongConfirm, "pending broadcast must remain in store");
  assert.equal(afterWrongConfirm.confirmed, false);
  assert.equal(afterWrongConfirm.originChatId, "42");

  // 2. Cross-chat cancel attempt from a group chat (-100111 !== 42)
  await silenceWarnings(() =>
    handleBroadcastCallback(
      {
        from: { id: 42 },
        chat: { id: -100111, type: "supergroup" },
        update: { update_id: 3 },
        api,
        callbackQuery: {
          id: "cb_wrong_group",
          data: cancelData,
          message: { message_id: 11, chat: { id: -100111, type: "supergroup" } },
        },
        editMessageText: async (text) => edits.push(text),
        answerCallbackQuery: async (opts) => alerts.push(opts),
      },
      { config, broadcastStore: store, sleep: async () => {} },
      cancelData,
    ),
  );

  assert.equal(edits.length, 0, "cross-chat cancel must not cancel preview");
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].text, CALLBACK_WRONG_CHAT_FEEDBACK);
  assert.ok(store.get(pendingId), "pending broadcast must still be unchanged");

  // 3. Valid confirm from originating chat (42) succeeds normally
  await handleBroadcastCallback(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 4 },
      api,
      callbackQuery: {
        id: "cb_origin_ok",
        data: confirmData,
        message: { message_id: 10, chat: { id: 42, type: "private" } },
      },
      editMessageText: async (text) => edits.push(text),
      answerCallbackQuery: async (opts) => alerts.push(opts),
    },
    { config, broadcastStore: store, sleep: async () => {} },
    confirmData,
  );

  assert.equal(sentMessages.length, 2, "originating chat confirmation delivers broadcast");
  assert.equal(store.get(pendingId), undefined, "pending broadcast consumed after valid confirm");
});

test("pause confirmation via createBot rejects callbacks from a different chat and preserves pending action", async () => {
  const config = makeConfig();
  const pauseConfirmStore = new PauseConfirmStore();
  let pauseCalls = 0;

  const bot = createBot({
    config,
    botInfo: BOT_INFO,
    pauseConfirmStore,
    status: () => makeStatus(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => "resumed",
  });

  const apiCalls = [];
  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: 500, date: Math.floor(Date.now() / 1000) } };
    }
    return { ok: true, result: true };
  });

  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Operator invokes /pause in originating chat -100111
  await bot.handleUpdate({
    update_id: 10,
    message: {
      message_id: 1,
      date: nowSec,
      chat: { id: -100111, type: "supergroup" },
      from: { id: 42, is_bot: false, first_name: "Op" },
      text: "/pause",
      entities: [{ offset: 0, length: 6, type: "bot_command" }],
    },
  });

  assert.equal(pauseCalls, 0);
  const stored = pauseConfirmStore.get("42");
  assert.ok(stored, "originating chat stored in PauseConfirmStore");
  assert.equal(stored.originChatId, "-100111");

  // 2. Callback arrives from a DIFFERENT chat (-100999) for pause-confirm and pause-cancel
  for (const [idx, cbData] of [CALLBACK_PAUSE_CONFIRM, CALLBACK_PAUSE_CANCEL].entries()) {
    await silenceWarnings(() =>
      bot.handleUpdate({
        update_id: 20 + idx,
        callback_query: {
          id: `cq_wrong_${idx}`,
          from: { id: 42, is_bot: false, first_name: "Op" },
          message: {
            message_id: 500,
            date: nowSec,
            chat: { id: -100999, type: "supergroup" },
            text: "Pause polling?",
          },
          data: cbData,
        },
      }),
    );
  }

  assert.equal(pauseCalls, 0, "cross-chat pause-confirm must not pause polling");
  assert.equal(
    apiCalls.filter((c) => c.method === "editMessageText").length,
    0,
    "cross-chat callbacks must not edit prompt message",
  );
  const wrongAnswers = apiCalls.filter((c) => c.method === "answerCallbackQuery");
  assert.equal(wrongAnswers.length, 2);
  for (const ans of wrongAnswers) {
    assert.equal(ans.payload.text, CALLBACK_WRONG_CHAT_FEEDBACK);
    assert.equal(ans.payload.show_alert, true);
  }
  assert.deepEqual(
    pauseConfirmStore.get("42"),
    stored,
    "pending pause confirmation must remain unchanged after cross-chat rejection",
  );

  // 3. Callback from originating chat (-100111) succeeds and consumes pending confirmation
  await bot.handleUpdate({
    update_id: 30,
    callback_query: {
      id: "cq_origin_ok",
      from: { id: 42, is_bot: false, first_name: "Op" },
      message: {
        message_id: 500,
        date: nowSec,
        chat: { id: -100111, type: "supergroup" },
        text: "Pause polling?",
      },
      data: CALLBACK_PAUSE_CONFIRM,
    },
  });

  assert.equal(pauseCalls, 1, "originating-chat confirmation pauses polling");
  assert.equal(pauseConfirmStore.get("42"), undefined, "pending pause confirmation consumed");
});

test("boundary: conflicting ctx.chat and callbackQuery.message.chat is rejected without mutating state", async () => {
  const config = makeConfig();
  const pauseConfirmStore = new PauseConfirmStore();
  const nowMs = 1_700_000_000_000;
  const pending = pauseConfirmStore.record("42", "-100111", nowMs);

  let pauseCalls = 0;
  const answered = [];
  const edits = [];

  await silenceWarnings(() =>
    handlePauseConfirmCallback(
      {
        from: { id: 42 },
        chat: { id: -100111 },
        update: { update_id: 99 },
        callbackQuery: {
          id: "cq_spoof",
          data: CALLBACK_PAUSE_CONFIRM,
          message: {
            date: Math.floor(nowMs / 1000),
            chat: { id: -100222 },
          },
        },
        answerCallbackQuery: async (opts) => answered.push(opts),
        editMessageText: async (text) => edits.push(text),
      },
      {
        config,
        pauseConfirmStore,
        pause: () => {
          pauseCalls += 1;
          return "paused";
        },
      },
      nowMs + 500,
    ),
  );

  assert.equal(pauseCalls, 0);
  assert.equal(edits.length, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].text, CALLBACK_WRONG_CHAT_FEEDBACK);
  assert.deepEqual(pauseConfirmStore.get("42", nowMs + 500), pending);
});
