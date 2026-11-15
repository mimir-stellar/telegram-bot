import assert from "node:assert/strict";
import test from "node:test";

import {
  BROADCAST_ROUTE_CHANGED_ALERT,
  BROADCAST_ROUTE_CHANGED_MESSAGE,
  BroadcastStore,
  createBot,
  fingerprintBroadcastDestinations,
  handleBroadcastCallback,
  handleBroadcastCommand,
  normalizeBroadcastDestinations,
} from "../dist/bot.js";

const TEST_BOT_TOKEN = ["123456789:", "A".repeat(35)].join("");
const OPERATOR_ID = "42";

function makeConfig(overrides = {}) {
  return {
    botToken: TEST_BOT_TOKEN,
    chatId: "-100111",
    chatIds: ["-100111", "-100222"],
    marketChatId: "-100111",
    squadChatId: "-100333",
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    operatorTelegramUserId: OPERATOR_ID,
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

test("fingerprintBroadcastDestinations is deterministic across duplicates/whitespace and changes on set edits", () => {
  assert.deepEqual(
    normalizeBroadcastDestinations([" -100222 ", "-100111", "-100222", ""]),
    ["-100111", "-100222"],
  );

  const fpBase = fingerprintBroadcastDestinations(["-100111", "-100222"]);
  const fpReorderedDup = fingerprintBroadcastDestinations([" -100222 ", "-100111", "-100111"]);
  assert.equal(fpBase, fpReorderedDup);
  assert.match(fpBase, /^sha256:[0-9a-f]{64}$/);

  const fpAdded = fingerprintBroadcastDestinations(["-100111", "-100222", "-100333"]);
  const fpRemoved = fingerprintBroadcastDestinations(["-100111"]);
  const fpReplaced = fingerprintBroadcastDestinations(["-100111", "-100999"]);
  const fpEmpty = fingerprintBroadcastDestinations([]);

  assert.notEqual(fpBase, fpAdded);
  assert.notEqual(fpBase, fpRemoved);
  assert.notEqual(fpBase, fpReplaced);
  assert.notEqual(fpBase, fpEmpty);
});

test("confirming a pending broadcast is cancelled when a destination route is added, removed, or replaced", async () => {
  const routeMutations = [
    {
      label: "route added",
      mutate: (cfg) => {
        cfg.squadChatId = "-100444";
      },
    },
    {
      label: "route removed",
      mutate: (cfg) => {
        cfg.squadChatId = "";
      },
    },
    {
      label: "route replaced",
      mutate: (cfg) => {
        cfg.chatIds = ["-100111", "-100999"];
      },
    },
  ];

  for (const { label, mutate } of routeMutations) {
    const config = makeConfig();
    const store = new BroadcastStore();
    const previewReplies = [];

    await handleBroadcastCommand(
      {
        from: { id: Number(OPERATOR_ID) },
        chat: { id: Number(OPERATOR_ID), type: "private" },
        update: { update_id: 10 },
        message: { text: "/broadcast Scheduled maintenance at 03:00 UTC" },
        reply: async (text, opts) => previewReplies.push({ text, opts }),
      },
      { config, broadcastStore: store },
    );

    assert.equal(previewReplies.length, 1, `[${label}] expected preview reply`);
    assert.equal(store.size(), 1);
    const confirmData =
      previewReplies[0].opts.reply_markup.inline_keyboard[0][0].callback_data;

    // Route configuration changes before operator taps Confirm
    mutate(config);

    const sent = [];
    const answered = [];
    const edits = [];

    await handleBroadcastCallback(
      {
        from: { id: Number(OPERATOR_ID) },
        chat: { id: Number(OPERATOR_ID), type: "private" },
        update: { update_id: 11 },
        api: {
          sendMessage: async (chatId, text) => sent.push({ chatId, text }),
        },
        callbackQuery: {
          id: "cq_route_drift",
          data: confirmData,
          message: { message_id: 50, chat: { id: Number(OPERATOR_ID), type: "private" } },
        },
        answerCallbackQuery: async (opts) => answered.push(opts),
        editMessageText: async (text) => edits.push(text),
        reply: async (text) => edits.push(text),
      },
      { config, broadcastStore: store, sleep: async () => {} },
      confirmData,
    );

    assert.equal(sent.length, 0, `[${label}] must not send to any chat when route set changed`);
    assert.equal(store.size(), 0, `[${label}] pending broadcast must be cancelled and removed`);
    assert.equal(answered.length, 1);
    assert.equal(answered[0].text, BROADCAST_ROUTE_CHANGED_ALERT);
    assert.equal(answered[0].show_alert, true);
    assert.equal(edits.length, 1);
    assert.equal(edits[0], BROADCAST_ROUTE_CHANGED_MESSAGE);
    assert.match(edits[0], /\/broadcast/);
  }
});

test("re-creating /broadcast preview after route change delivers to the newly reviewed destination set", async () => {
  const config = makeConfig({
    chatIds: ["-100111"],
    marketChatId: "",
    squadChatId: "",
  });
  const store = new BroadcastStore();
  const sentMessages = [];
  const callbackAnswers = [];
  const messageEdits = [];

  const bot = createBot({
    config,
    status: () => ({}),
    pause: () => "paused",
    resume: () => "resumed",
    broadcastStore: store,
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "Mimir",
      username: "mimir_test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    },
  });

  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      sentMessages.push(payload);
      return { ok: true, result: { message_id: sentMessages.length } };
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(payload);
      return { ok: true, result: true };
    }
    if (method === "editMessageText") {
      messageEdits.push(payload);
      return { ok: true, result: true };
    }
    return { ok: true, result: true };
  });

  const commandUpdate = (updateId, text) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(OPERATOR_ID), type: "private", first_name: "Op" },
      from: { id: Number(OPERATOR_ID), is_bot: false, first_name: "Op" },
      text,
      entities: [{ offset: 0, length: 10, type: "bot_command" }],
    },
  });

  // 1. Create initial preview (targets: -100111)
  await bot.handleUpdate(commandUpdate(100, "/broadcast Upgrade window open"));
  assert.equal(sentMessages.length, 1);
  const firstConfirmData = sentMessages[0].reply_markup.inline_keyboard[0][0].callback_data;

  // 2. Route config changes to add squadChatId = -100777
  config.squadChatId = "-100777";

  // 3. Tapping Confirm on stale preview cancels it without sending
  await bot.handleUpdate({
    update_id: 101,
    callback_query: {
      id: "cq_101",
      from: { id: Number(OPERATOR_ID), is_bot: false, first_name: "Op" },
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(OPERATOR_ID), type: "private" },
        text: sentMessages[0].text,
      },
      data: firstConfirmData,
    },
  });

  assert.equal(sentMessages.length, 1, "no broadcast sent for stale preview");
  assert.equal(callbackAnswers[0].text, BROADCAST_ROUTE_CHANGED_ALERT);

  // 4. Operator runs /broadcast again and confirms the fresh preview (targets: -100111, -100777)
  await bot.handleUpdate(commandUpdate(102, "/broadcast Upgrade window open"));
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].text, /Target chats \(2\)/);
  const freshConfirmData = sentMessages[1].reply_markup.inline_keyboard[0][0].callback_data;

  await bot.handleUpdate({
    update_id: 103,
    callback_query: {
      id: "cq_103",
      from: { id: Number(OPERATOR_ID), is_bot: false, first_name: "Op" },
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(OPERATOR_ID), type: "private" },
        text: sentMessages[1].text,
      },
      data: freshConfirmData,
    },
  });

  const deliveredBroadcasts = sentMessages.slice(2);
  assert.deepEqual(
    deliveredBroadcasts.map((m) => String(m.chat_id)),
    ["-100111", "-100777"],
  );
  assert.ok(messageEdits[messageEdits.length - 1].text.includes("2/2 succeeded"));
});

test("boundary: BroadcastStore.cancelMismatchedRoutes removes only stale-route items", () => {
  const store = new BroadcastStore();
  const keep = store.create("42", "Keep me", ["-100111", "-100222"]);
  const stale = store.create("42", "Drop me", ["-100111", "-100999"]);

  const cancelled = store.cancelMismatchedRoutes({
    chatId: "-100111",
    chatIds: ["-100111", "-100222"],
  });

  assert.equal(cancelled, 1);
  assert.ok(store.get(keep.id));
  assert.equal(store.get(stale.id), undefined);
});
