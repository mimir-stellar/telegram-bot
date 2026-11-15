import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastStore,
  CONFIRMATIONS_USAGE_MESSAGE,
  MAX_PENDING_CONFIRMATIONS,
  MAX_PENDING_CONFIRMATION_LIST,
  MAX_PENDING_SNIPPET_CHARS,
  createBot,
  formatPendingConfirmationsList,
  handleBroadcastCallback,
  handleBroadcastCommand,
  handleCallbackQuery,
  handleConfirmationsCommand,
  handlePauseConfirmCallback,
  pendingConfirmationsKeyboard,
  validateCallbackData,
  CALLBACK_PAUSE_CONFIRM,
} from "../dist/bot.js";

const FAKE_CRED = ["123456789:", "A".repeat(35)].join("");

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeConfig(overrides = {}) {
  return {
    botToken: FAKE_CRED,
    chatId: "-100111999",
    chatIds: ["-100111999", "-100222888"],
    marketChatId: "@private_market_room",
    squadChatId: "-100333777",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    interSendDelayMs: 0,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    ...overrides,
  };
}

function makeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1_700_000_000_000,
    cycles: 1,
    lastPollAt: 1_700_000_000_000,
    lastSuccessAt: 1_700_000_000_000,
    chainClockAt: null,
    latestLedger: 1000,
    oldestLedger: 900,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

test("BroadcastStore.listForOperator shows only the current operator's unexpired actions without chat IDs", () => {
  const baseNow = 1_700_000_000_000;
  const store = new BroadcastStore(300_000);

  const opA1 = store.create(
    "42",
    "Scheduled RPC upgrade\nin 15 minutes",
    ["-100111999", "-100222888", "@private_market_room"],
    120_000,
    baseNow,
  );
  const opAPause = store.createPause("42", 45_000, baseNow + 1_000);
  const opAExpired = store.create("42", "Already expired notice", ["-100111999"], 5_000, baseNow);
  const opB = store.create(
    "99",
    "Other operator secret channel maintenance",
    ["-100999000", "@secret_ops_channel"],
    180_000,
    baseNow,
  );

  const viewAt10s = store.listForOperator("42", baseNow + 10_000);
  assert.equal(viewAt10s.total, 2, "must include only operator 42's two unexpired actions");
  assert.equal(viewAt10s.truncated, 0);
  assert.deepEqual(
    viewAt10s.items.map((item) => item.id),
    [opAPause.id, opA1.id],
    "items should be ordered by soonest expiry first",
  );

  for (const summary of viewAt10s.items) {
    assert.equal("chats" in summary, false, "summary object must never carry destination chat IDs");
    assert.equal(summary.operatorId, "42");
  }

  assert.equal(viewAt10s.items[0].kind, "pause");
  assert.equal(viewAt10s.items[0].remainingMs, 36_000);
  assert.equal(viewAt10s.items[1].kind, "broadcast");
  assert.equal(viewAt10s.items[1].targetChatCount, 3);
  assert.equal(viewAt10s.items[1].remainingMs, 110_000);
  assert.equal(viewAt10s.items[1].snippet, "Scheduled RPC upgrade in 15 minutes");

  // Expired item was pruned; operator 99's item remains intact for operator 99 only.
  assert.equal(store.get(opAExpired.id, baseNow + 10_000), undefined);
  const opBView = store.listForOperator("99", baseNow + 10_000);
  assert.equal(opBView.total, 1);
  assert.equal(opBView.items[0].id, opB.id);

  const rendered = formatPendingConfirmationsList(viewAt10s);
  assert.ok(rendered.includes("Pending confirmations (2/2)"));
  assert.ok(rendered.includes(opAPause.id));
  assert.ok(rendered.includes(opA1.id));
  assert.ok(rendered.includes("expires in 36s"));
  assert.ok(rendered.includes("expires in 1m 50s"));
  assert.ok(rendered.includes("3 target chat(s)"));
  assert.equal(rendered.includes("-100111999"), false, "rendered list must never expose chat IDs");
  assert.equal(rendered.includes("-100222888"), false, "rendered list must never expose chat IDs");
  assert.equal(rendered.includes("@private_market_room"), false, "rendered list must never expose channel handles");
  assert.equal(rendered.includes("-100999000"), false);
  assert.equal(rendered.includes(opB.id), false);
});

test("Pending confirmations store and rendered list stay strictly bounded under burst creation", () => {
  const baseNow = 1_700_000_000_000;
  const store = new BroadcastStore(300_000);

  const createdIds = [];
  for (let i = 0; i < 40; i += 1) {
    const item = store.create(
      "42",
      `Announcement #${i} ` + "x".repeat(120),
      ["-100111999", "-100333777"],
      300_000 + i * 1000,
      baseNow + i,
    );
    createdIds.push(item.id);
  }

  assert.equal(
    store.size(),
    MAX_PENDING_CONFIRMATIONS,
    "store size must be capped at MAX_PENDING_CONFIRMATIONS",
  );
  // Oldest 15 items evicted, newest 25 retained
  assert.equal(store.get(createdIds[0], baseNow + 50), undefined);
  assert.ok(store.get(createdIds[39], baseNow + 50));

  const listing = store.listForOperator("42", baseNow + 50);
  assert.equal(listing.total, MAX_PENDING_CONFIRMATIONS);
  assert.equal(listing.items.length, MAX_PENDING_CONFIRMATION_LIST);
  assert.equal(listing.truncated, MAX_PENDING_CONFIRMATIONS - MAX_PENDING_CONFIRMATION_LIST);

  for (const item of listing.items) {
    assert.ok(
      Array.from(item.snippet).length <= MAX_PENDING_SNIPPET_CHARS,
      "each snippet must be bounded to MAX_PENDING_SNIPPET_CHARS",
    );
  }

  const text = formatPendingConfirmationsList(listing);
  assert.ok(text.includes(`Pending confirmations (${MAX_PENDING_CONFIRMATION_LIST}/${MAX_PENDING_CONFIRMATIONS})`));
  assert.ok(text.includes(`…and ${MAX_PENDING_CONFIRMATIONS - MAX_PENDING_CONFIRMATION_LIST} more pending confirmation(s).`));
  assert.equal(text.includes("-100111999"), false);
  assert.equal(text.includes("-100333777"), false);

  const kb = pendingConfirmationsKeyboard(listing.items);
  assert.ok(kb);
  assert.equal(kb.inline_keyboard.length, MAX_PENDING_CONFIRMATION_LIST);
  for (const row of kb.inline_keyboard) {
    assert.equal(row.length, 1);
    assert.ok(Buffer.byteLength(row[0].callback_data, "utf8") <= 64);
    const valid = validateCallbackData(row[0].callback_data);
    assert.equal(valid.ok, true);
    assert.equal(valid.action.type, "broadcast");
  }
});

test("Explicit cancellation isolates operators, hides chat IDs, and prevents subsequent confirmation", async () => {
  let now = 1_700_000_000_000;
  const store = new BroadcastStore(300_000);
  const config42 = makeConfig({ operatorTelegramUserId: "42" });

  const ownPending = store.create(
    "42",
    "Cancel me safely",
    ["-100111999", "@private_market_room"],
    120_000,
    now,
  );
  const otherOperatorPending = store.create(
    "77",
    "Belongs to operator 77",
    ["-100777000"],
    120_000,
    now,
  );

  // Operator 42 tries to cancel operator 77's confirmation via /confirmations cancel <id>
  const replies = [];
  await handleConfirmationsCommand(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 1 },
      message: { text: `/confirmations cancel ${otherOperatorPending.id}` },
      reply: async (...args) => replies.push(args),
    },
    { config: config42, broadcastStore: store, now: () => now },
  );

  assert.equal(replies.length, 1);
  assert.match(replies[0][0], /not found or already processed/i);
  assert.equal(replies[0][0].includes("-100777000"), false);
  assert.ok(
    store.get(otherOperatorPending.id, now),
    "other operator's pending confirmation must remain untouched",
  );

  // Operator 42 cancels their own confirmation via /broadcast cancel <id>
  const cancelReplies = [];
  await handleBroadcastCommand(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 2 },
      message: { text: `/broadcast cancel ${ownPending.id}` },
      reply: async (...args) => cancelReplies.push(args),
    },
    { config: config42, broadcastStore: store, now: () => now },
  );

  assert.equal(cancelReplies.length, 1);
  assert.equal(cancelReplies[0][0], `❌ Cancelled pending confirmation ${ownPending.id}.`);
  assert.equal(cancelReplies[0][0].includes("-100111999"), false);
  assert.equal(cancelReplies[0][0].includes("@private_market_room"), false);
  assert.equal(store.get(ownPending.id, now), undefined);

  // Subsequent attempt to confirm the cancelled broadcast via inline button sends nothing
  const sentMessages = [];
  const edits = [];
  await handleBroadcastCallback(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 3 },
      api: {
        sendMessage: async (chatId, text) => sentMessages.push({ chatId, text }),
      },
      callbackQuery: {
        id: "cb_after_cancel",
        data: `broadcast:confirm:${ownPending.id}`,
        message: { message_id: 50 },
      },
      editMessageText: async (text) => edits.push(text),
      answerCallbackQuery: async () => true,
    },
    {
      config: config42,
      status: makeStatus,
      pause: () => "paused",
      resume: () => "resumed",
      broadcastStore: store,
      now: () => now,
    },
    `broadcast:confirm:${ownPending.id}`,
  );

  assert.equal(sentMessages.length, 0);
  assert.match(edits[0], /expired or already processed/i);
});

test("Broadcast announcement starting with 'Cancel ...' is still treated as a broadcast message", async () => {
  const store = new BroadcastStore();
  const config = makeConfig();
  const replies = [];

  await handleBroadcastCommand(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 10 },
      message: { text: "/broadcast Cancel open claims before 02:00 UTC maintenance" },
      reply: async (...args) => replies.push(args),
    },
    { config, broadcastStore: store },
  );

  assert.equal(replies.length, 1);
  assert.ok(replies[0][0].includes("Broadcast Preview"));
  assert.ok(replies[0][0].includes("Cancel open claims before 02:00 UTC maintenance"));
  assert.equal(store.size(), 1);
});

test("End-to-end bot flow: /pause appears in /confirmations and explicit cancellation blocks stale pause-confirm tap", async () => {
  let now = 1_700_000_000_000;
  let pauseCalls = 0;
  const store = new BroadcastStore();
  const config = makeConfig({ operatorTelegramUserId: "42" });

  const bot = createBot({
    config,
    status: makeStatus,
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => "resumed",
    botInfo: FAKE_BOT_INFO,
    broadcastStore: store,
    now: () => now,
  });

  const apiCalls = [];
  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "sendMessage") {
      return {
        ok: true,
        result: {
          message_id: apiCalls.length,
          chat: { id: payload.chat_id, type: "private" },
          date: Math.floor(now / 1000),
          text: payload.text,
        },
      };
    }
    return { ok: true, result: true };
  });

  // 1. Non-operator and group chats cannot list confirmations
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(now / 1000),
      chat: { id: 999, type: "private" },
      from: { id: 999, is_bot: false, first_name: "Stranger" },
      text: "/confirmations",
      entities: [{ type: "bot_command", offset: 0, length: 14 }],
    },
  });
  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: Math.floor(now / 1000),
      chat: { id: -100111999, type: "supergroup", title: "Public" },
      from: { id: 42, is_bot: false, first_name: "Op" },
      text: "/confirmations",
      entities: [{ type: "bot_command", offset: 0, length: 14 }],
    },
  });
  assert.equal(apiCalls.length, 0, "non-operator and non-private /confirmations must stay silent");

  // 2. Operator invokes /pause (even from another chat, its chat ID is never stored/exposed)
  const pauseMsgDateSec = Math.floor(now / 1000);
  await bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      date: pauseMsgDateSec,
      chat: { id: -100555444, type: "supergroup", title: "Ops Group" },
      from: { id: 42, is_bot: false, first_name: "Op" },
      text: "/pause",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  });

  // 3. Operator lists pending confirmations in private chat via /confirmations
  now += 5_000;
  await bot.handleUpdate({
    update_id: 4,
    message: {
      message_id: 4,
      date: Math.floor(now / 1000),
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Op" },
      text: "/confirmations",
      entities: [{ type: "bot_command", offset: 0, length: 14 }],
    },
  });

  const listSend = apiCalls.filter((c) => c.method === "sendMessage").at(-1);
  assert.ok(listSend);
  assert.ok(listSend.payload.text.includes("pause — expires in 55s"));
  assert.equal(
    listSend.payload.text.includes("-100555444"),
    false,
    "group chat ID where /pause was triggered must never appear in /confirmations",
  );
  assert.equal(listSend.payload.text.includes("Unknown command"), false);

  const cancelCallbackData = listSend.payload.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(cancelCallbackData.startsWith("broadcast:cancel:"));

  // 4. Operator cancels the pending pause confirmation via the inline button
  now += 1_000;
  await handleCallbackQuery(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 5 },
      callbackQuery: {
        id: "cb_cancel_pause",
        data: cancelCallbackData,
        message: { message_id: 10, chat: { id: 42, type: "private" } },
      },
      editMessageText: async () => true,
      answerCallbackQuery: async () => true,
    },
    {
      config,
      status: makeStatus,
      pause: () => "paused",
      resume: () => "resumed",
      broadcastStore: store,
      now: () => now,
    },
  );

  assert.equal(store.listForOperator("42", now).total, 0);

  // 5. Clicking the old pause-confirm button from step 2 must now be rejected without pausing
  const stalePauseEdits = [];
  const stalePauseAnswers = [];
  await handlePauseConfirmCallback(
    {
      from: { id: 42 },
      callbackQuery: {
        id: "cb_old_pause_confirm",
        data: CALLBACK_PAUSE_CONFIRM,
        message: { date: pauseMsgDateSec },
      },
      answerCallbackQuery: async (opts) => stalePauseAnswers.push(opts),
      editMessageText: async (text) => stalePauseEdits.push(text),
    },
    {
      config,
      pause: () => {
        pauseCalls += 1;
        return "paused";
      },
      broadcastStore: store,
      now: () => now,
    },
  );

  assert.equal(pauseCalls, 0, "explicitly cancelled pause confirmation must not pause polling");
  assert.match(stalePauseAnswers[0]?.text ?? "", /cancelled/i);
  assert.match(stalePauseEdits[0] ?? "", /cancelled/i);

  // 6. Invalid /confirmations syntax returns bounded usage help
  const badArgReplies = [];
  await handleConfirmationsCommand(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 6 },
      message: { text: "/confirmations unknown-subcommand" },
      reply: async (...args) => badArgReplies.push(args),
    },
    { config, broadcastStore: store, now: () => now },
  );
  assert.equal(badArgReplies[0][0], CONFIRMATIONS_USAGE_MESSAGE);
});
