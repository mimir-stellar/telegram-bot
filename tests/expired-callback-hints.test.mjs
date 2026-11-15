import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastStore,
  CALLBACK_PAUSE_CONFIRM,
  CALLBACK_UNAUTHORIZED_FEEDBACK,
  PAUSE_CONFIRM_TTL_MS,
  createBot,
  handleBroadcastCallback,
  handleCallbackQuery,
  handlePauseConfirmCallback,
} from "../dist/bot.js";
import {
  ES_MESSAGES,
  EXPIRED_CALLBACK_MESSAGES,
  SUPPORTED_LOCALES,
  messagesFor,
} from "../dist/i18n.js";

const TEST_BOT_TOKEN = ["123456789:", "A".repeat(35)].join("");
const OPERATOR_ID = "42";

function fakeConfig(overrides = {}) {
  return {
    botToken: TEST_BOT_TOKEN,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
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
    locale: "en",
    interSendDelayMs: 0,
    ...overrides,
  };
}

test("expired callback hints are localized across all supported locales within Telegram limits", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const expired = messagesFor(locale).expiredCallbackMessages;
    assert.ok(expired.pauseAlert.length > 0 && expired.pauseAlert.length <= 200);
    assert.ok(expired.broadcastAlert.length > 0 && expired.broadcastAlert.length <= 200);
    assert.match(expired.pauseAlert, /\/pause/);
    assert.match(expired.pauseMessageMd, /\/pause/);
    assert.match(expired.broadcastAlert, /\/broadcast/);
    assert.match(expired.broadcastMessagePlain, /\/broadcast/);
    // Plain-text alerts and broadcast message must not contain MarkdownV2 escape sequences
    assert.equal(/[\\*_\[\]`]/.test(expired.pauseAlert), false);
    assert.equal(/[\\*_\[\]`]/.test(expired.broadcastAlert), false);
    assert.equal(/[\\*_\[\]`]/.test(expired.broadcastMessagePlain), false);
  }
});

test("expired pause confirmation acknowledges exactly once with localized recovery hint in en and es", async () => {
  for (const [locale, expected] of [
    ["en", EXPIRED_CALLBACK_MESSAGES],
    ["es", ES_MESSAGES.expiredCallbackMessages],
  ]) {
    let pauseCalls = 0;
    const answered = [];
    const edits = [];
    const baseSec = 1_700_000_000;
    const ctx = {
      from: { id: Number(OPERATOR_ID) },
      update: { update_id: 10 },
      callbackQuery: {
        id: `cq_${locale}`,
        data: CALLBACK_PAUSE_CONFIRM,
        message: { date: baseSec, chat: { id: -1001234567890 } },
      },
      answerCallbackQuery: async (opts) => answered.push(opts),
      editMessageText: async (text, opts) => edits.push({ text, opts }),
    };

    await handlePauseConfirmCallback(
      ctx,
      {
        config: fakeConfig({ locale }),
        pause: () => {
          pauseCalls += 1;
          return "paused";
        },
      },
      baseSec * 1000 + PAUSE_CONFIRM_TTL_MS + 500,
    );

    assert.equal(pauseCalls, 0);
    assert.equal(answered.length, 1, `expected exactly 1 callback ack for locale=${locale}`);
    assert.equal(answered[0].text, expected.pauseAlert);
    assert.equal(answered[0].show_alert, true);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].text, expected.pauseMessageMd);
    assert.equal(edits[0].opts.parse_mode, "MarkdownV2");
  }
});

test("expired broadcast confirmation acknowledges exactly once with localized recovery hint in en and es", async () => {
  for (const [locale, expected] of [
    ["en", EXPIRED_CALLBACK_MESSAGES],
    ["es", ES_MESSAGES.expiredCallbackMessages],
  ]) {
    const store = new BroadcastStore();
    const pending = store.create(OPERATOR_ID, "Maintenance notice", ["-1001234567890"], 1_000);
    const answered = [];
    const edits = [];
    const sent = [];

    const ctx = {
      from: { id: Number(OPERATOR_ID) },
      chat: { id: Number(OPERATOR_ID), type: "private" },
      update: { update_id: 20 },
      api: {
        sendMessage: async (chatId, text) => sent.push({ chatId, text }),
      },
      callbackQuery: {
        id: `cq_bcast_${locale}`,
        data: `broadcast:confirm:${pending.id}`,
        message: { message_id: 55, chat: { id: Number(OPERATOR_ID), type: "private" } },
      },
      answerCallbackQuery: async (opts) => answered.push(opts),
      editMessageText: async (text) => edits.push(text),
    };

    await handleBroadcastCallback(
      ctx,
      { config: fakeConfig({ locale }), broadcastStore: store, sleep: async () => {} },
      `broadcast:confirm:${pending.id}`,
      pending.expiresAt + 1,
    );

    assert.equal(sent.length, 0);
    assert.equal(answered.length, 1, `expected exactly 1 callback ack for locale=${locale}`);
    assert.equal(answered[0].text, expected.broadcastAlert);
    assert.equal(answered[0].show_alert, true);
    assert.equal(edits.length, 1);
    assert.equal(edits[0], expected.broadcastMessagePlain);
  }
});

test("boundary: callback is acknowledged at most once even if downstream error triggers handleCallbackQuery catch or repeated invocation", async () => {
  const config = fakeConfig({ locale: "es" });
  const store = new BroadcastStore();
  const pending = store.create(OPERATOR_ID, "Test notice", ["-1001234567890"], 60_000);
  const answered = [];

  // 1. Broadcast confirm acknowledges, then reply fallback throws -> catch block must NOT re-acknowledge
  const ctxThrowing = {
    from: { id: Number(OPERATOR_ID) },
    chat: { id: Number(OPERATOR_ID), type: "private" },
    update: { update_id: 30 },
    api: {
      sendMessage: async () => ({ message_id: 1 }),
    },
    callbackQuery: {
      id: "cq_once_1",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 66, chat: { id: Number(OPERATOR_ID), type: "private" } },
    },
    answerCallbackQuery: async (opts) => answered.push(opts),
    editMessageText: async () => {
      throw new Error("edit failed");
    },
    reply: async () => {
      throw new Error("reply failed after ack");
    },
  };

  const origError = console.error;
  console.error = () => undefined;
  try {
    await handleCallbackQuery(ctxThrowing, {
      config,
      status: () => ({}),
      pause: () => "stopped",
      resume: () => "stopped",
      broadcastStore: store,
      sleep: async () => {},
    });
  } finally {
    console.error = origError;
  }

  assert.equal(answered.length, 1, "must acknowledge callback exactly once even on downstream throw");

  // 2. End-to-end createBot update on an expired broadcast callback acknowledges once
  const apiAnswers = [];
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
    if (method === "answerCallbackQuery") {
      apiAnswers.push(payload);
      return { ok: true, result: true };
    }
    if (method === "editMessageText") {
      return { ok: true, result: true };
    }
    return { ok: true, result: { message_id: 1 } };
  });

  await bot.handleUpdate({
    update_id: 31,
    callback_query: {
      id: "cq_expired_stale",
      from: { id: Number(OPERATOR_ID), is_bot: false, first_name: "Op" },
      message: {
        message_id: 77,
        date: 100,
        chat: { id: Number(OPERATOR_ID), type: "private" },
        text: "Old broadcast preview",
      },
      data: "broadcast:confirm:stale_pre_restart_id",
    },
  });

  assert.equal(apiAnswers.length, 1);
  assert.equal(apiAnswers[0].text, ES_MESSAGES.expiredCallbackMessages.broadcastAlert);
  assert.equal(apiAnswers[0].show_alert, true);
});

test("boundary: non-operator tapping expired pause or broadcast button receives unauthorized alert without recovery guidance", async () => {
  const config = fakeConfig({ locale: "es" });
  const store = new BroadcastStore();
  const expiredBroadcast = store.create(OPERATOR_ID, "Notice", ["-1001234567890"], -1_000);

  const pauseAnswered = [];
  await handlePauseConfirmCallback(
    {
      from: { id: 999 },
      update: { update_id: 40 },
      callbackQuery: {
        id: "cq_unauth_pause",
        data: CALLBACK_PAUSE_CONFIRM,
        message: { date: 0, chat: { id: -1001234567890 } },
      },
      answerCallbackQuery: async (opts) => pauseAnswered.push(opts),
      editMessageText: async () => {
        assert.fail("non-operator must not edit message");
      },
    },
    { config, pause: () => "paused" },
    Date.now(),
  );

  assert.equal(pauseAnswered.length, 1);
  assert.equal(pauseAnswered[0].text.includes("/pause"), false);

  const bcastAnswered = [];
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    await handleCallbackQuery(
      {
        from: { id: 999 },
        chat: { id: 999, type: "private" },
        update: { update_id: 41 },
        callbackQuery: {
          id: "cq_unauth_bcast",
          data: `broadcast:confirm:${expiredBroadcast.id}`,
          message: { message_id: 90, chat: { id: 999, type: "private" } },
        },
        answerCallbackQuery: async (opts) => bcastAnswered.push(opts),
        editMessageText: async () => {
          assert.fail("non-operator must not edit message");
        },
      },
      {
        config,
        status: () => ({}),
        pause: () => "stopped",
        resume: () => "stopped",
        broadcastStore: store,
      },
    );
  } finally {
    console.warn = origWarn;
  }

  assert.equal(bcastAnswered.length, 1);
  assert.equal(bcastAnswered[0].text, CALLBACK_UNAUTHORIZED_FEEDBACK);
  assert.equal(bcastAnswered[0].text.includes("/broadcast"), false);
});
